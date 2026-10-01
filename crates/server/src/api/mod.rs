use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::RwLock;
use tokio_util::io::ReaderStream;

use crate::{
    app::AppState,
    error::{AppError, AppResult},
    index::{BacklinksResponse, ResolveResponse, SearchResponse, VaultIndex},
    security::auth::{LoginResult, cookie_value, random_token},
    update,
    vault::models::*,
    websocket::GatewayEvent,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemResponse {
    version: &'static str,
    vault: VaultInfo,
    features: FeatureInfo,
    auth_required: bool,
    auth: AuthMethods,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthMethods {
    password: bool,
    username: bool,
    passkey: bool,
}

#[derive(Serialize)]
struct VaultInfo {
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeatureInfo {
    read_only: bool,
    search: bool,
    backlinks: bool,
}

pub async fn system(State(state): State<AppState>) -> Json<SystemResponse> {
    Json(SystemResponse {
        version: env!("CARGO_PKG_VERSION"),
        vault: VaultInfo {
            name: state.vault.sandbox().vault_name(),
        },
        features: FeatureInfo {
            read_only: state.vault.read_only(),
            search: true,
            backlinks: true,
        },
        auth_required: state.auth.enabled(),
        auth: AuthMethods {
            password: state.auth.password_enabled(),
            username: state.auth.username_required(),
            passkey: state.auth.passkey().is_some(),
        },
    })
}

pub async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
pub struct LoginRequest {
    #[serde(default)]
    username: Option<String>,
    password: String,
    #[serde(default)]
    remember: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    csrf_token: String,
}

pub async fn login(
    State(state): State<AppState>,
    connect: axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> AppResult<Response> {
    let store = state.auth.clone();
    let client = store.client_key(connect.0.ip(), &headers);
    let result = tokio::task::spawn_blocking(move || {
        store.login(
            request.username.as_deref(),
            &request.password,
            request.remember,
            &client,
        )
    })
    .await??;
    session_response(result)
}

fn session_response(result: LoginResult) -> AppResult<Response> {
    let mut response = Json(LoginResponse {
        csrf_token: result.csrf,
    })
    .into_response();
    if !result.cookie.is_empty() {
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_str(&result.cookie)
                .map_err(|_| AppError::Internal("invalid session cookie".into()))?,
        );
    }
    Ok(response)
}

/// Random per-browser value tying a passkey ceremony to the browser that started it.
const PASSKEY_BINDING_COOKIE: &str = "owg_passkey";

pub async fn passkey_begin(
    State(state): State<AppState>,
    connect: axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let passkey = state.auth.passkey().ok_or(AppError::NotFound)?;
    let client = state.auth.client_key(connect.0.ip(), &headers);
    let binding = cookie_value(&headers, PASSKEY_BINDING_COOKIE)
        .filter(|value| value.len() == 43)
        .map_or_else(random_token, str::to_owned);
    let auth = state.auth.clone();
    let options = tokio::task::spawn_blocking(move || {
        auth.begin_attempt(&client)?;
        // Starting a ceremony is not a failure; release the slot immediately.
        auth.end_attempt(&client, true)?;
        passkey.begin(&binding).map(|options| (options, binding))
    })
    .await??;
    let (options, binding) = options;
    let mut response = Json(options).into_response();
    let secure = if state.auth.secure_cookie() {
        "; Secure"
    } else {
        ""
    };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{PASSKEY_BINDING_COOKIE}={binding}; Path=/api/v1/auth/passkey; HttpOnly; SameSite=Strict; Max-Age=600{secure}"
        ))
        .map_err(|_| AppError::Internal("invalid passkey cookie".into()))?,
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyFinishRequest {
    ceremony_id: String,
    credential: serde_json::Value,
    #[serde(default)]
    remember: bool,
}

pub async fn passkey_finish(
    State(state): State<AppState>,
    connect: axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<PasskeyFinishRequest>,
) -> AppResult<Response> {
    let passkey = state.auth.passkey().ok_or(AppError::NotFound)?;
    let client = state.auth.client_key(connect.0.ip(), &headers);
    let binding = cookie_value(&headers, PASSKEY_BINDING_COOKIE)
        .unwrap_or_default()
        .to_owned();
    let auth = state.auth.clone();
    let result = tokio::task::spawn_blocking(move || {
        auth.begin_attempt(&client)?;
        let verified = passkey.finish(&request.ceremony_id, &binding, request.credential);
        auth.end_attempt(&client, verified.is_ok())?;
        auth.issue_session(request.remember, Some(verified?))
    })
    .await??;
    session_response(result)
}

pub async fn auth_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<LoginResponse>> {
    Ok(Json(LoginResponse {
        csrf_token: state.auth.csrf_token(&headers)?,
    }))
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    state.auth.logout(&headers)?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("owg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    Ok(response)
}

pub async fn tree(State(state): State<AppState>) -> AppResult<Json<TreeResponse>> {
    Ok(Json(state.vault.tree().await?))
}

#[derive(Deserialize)]
pub struct PathQuery {
    path: String,
}

pub async fn read_file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> AppResult<Json<FileResponse>> {
    Ok(Json(state.vault.read_markdown(query.path).await?))
}

pub async fn save_file(
    State(state): State<AppState>,
    Json(request): Json<SaveFileRequest>,
) -> AppResult<Json<SaveFileResponse>> {
    let path = request.path.clone();
    let response = state.vault.save_markdown(request).await?;
    refresh_after_write(&state, "file.changed", path).await;
    Ok(Json(response))
}

pub async fn create_file(
    State(state): State<AppState>,
    Json(request): Json<CreateFileRequest>,
) -> AppResult<(StatusCode, Json<SaveFileResponse>)> {
    let path = request.path.clone();
    let response = state.vault.create_file(request).await?;
    refresh_after_write(&state, "file.created", path).await;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn create_directory(
    State(state): State<AppState>,
    Json(request): Json<CreateDirectoryRequest>,
) -> AppResult<(StatusCode, Json<PathResponse>)> {
    let path = request.path.clone();
    let response = state.vault.create_directory(request.path).await?;
    refresh_after_write(&state, "file.created", path).await;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn change_path(
    State(state): State<AppState>,
    Json(request): Json<ChangePathRequest>,
) -> AppResult<Json<PathResponse>> {
    let old_path = request.old_path.clone();
    let new_path = request.new_path.clone();
    let response = state
        .vault
        .change_path(request.old_path, request.new_path)
        .await?;
    refresh_index(&state, vec![old_path.clone(), new_path.clone()]).await;
    let _ = state.events.send(GatewayEvent {
        kind: "file.renamed".into(),
        payload: serde_json::json!({ "oldPath": old_path, "newPath": new_path }),
    });
    Ok(Json(response))
}

pub async fn delete_path(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> AppResult<Json<DeleteResponse>> {
    let path = query.path.clone();
    let response = state.vault.delete(query.path).await?;
    refresh_after_write(&state, "file.deleted", path).await;
    Ok(Json(response))
}

pub async fn asset(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_range);
    let asset = state.vault.open_asset(query.path, range).await?;
    let length = asset.length;
    let stream = ReaderStream::new(asset.file.take(length));
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if asset.partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string())
            .map_err(|_| AppError::Internal("invalid asset length".into()))?,
    );
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    if asset.partial {
        let end = asset.start + length.saturating_sub(1);
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{end}/{}", asset.start, asset.size))
                .map_err(|_| AppError::Internal("invalid content range".into()))?,
        );
    }
    if asset.mime == "image/svg+xml" {
        response.headers_mut().insert(
            "content-security-policy",
            HeaderValue::from_static("sandbox; default-src 'none'"),
        );
    }
    Ok(response)
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

pub async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<SearchResponse>> {
    Ok(Json(state.index.read().await.search(&query.q)?))
}

#[derive(Deserialize)]
pub struct ResolveQuery {
    link: String,
    source: Option<String>,
}

pub async fn resolve(
    State(state): State<AppState>,
    Query(query): Query<ResolveQuery>,
) -> Json<ResolveResponse> {
    Json(
        state
            .index
            .read()
            .await
            .resolve(&query.link, query.source.as_deref()),
    )
}

pub async fn backlinks(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Json<BacklinksResponse> {
    Json(state.index.read().await.backlinks(&query.path))
}

async fn refresh_after_write(state: &AppState, kind: &str, path: String) {
    refresh_index(state, vec![path.clone()]).await;
    let _ = state.events.send(GatewayEvent::path(kind, path));
}

/// Re-indexes only the written paths so search and backlinks are current when
/// the response returns, without waiting for the filesystem watcher.
async fn refresh_index(state: &AppState, paths: Vec<String>) {
    let sandbox = state.vault.sandbox().clone();
    match tokio::task::spawn_blocking(move || VaultIndex::scan_paths(&sandbox, &paths)).await {
        Ok(update) => state.index.write().await.apply(update),
        Err(error) => tracing::warn!(error = %error, "index refresh task failed"),
    }
}

fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        return None;
    }
    Some((
        start.parse().ok()?,
        if end.is_empty() {
            None
        } else {
            Some(end.parse().ok()?)
        },
    ))
}

pub async fn update_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.updater.status())
}

pub async fn update_settings(
    State(state): State<AppState>,
    Json(settings): Json<update::Settings>,
) -> AppResult<Json<serde_json::Value>> {
    let updater = state.updater.clone();
    tokio::task::spawn_blocking(move || updater.save_settings(settings)).await??;
    Ok(Json(state.updater.status()))
}

pub async fn update_check(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let updater = state.updater.clone();
    let recently = updater.last_checked().is_some_and(|checked| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .is_ok_and(|now| now.as_secs() as i64 - checked < 10)
    });
    if recently {
        return Err(AppError::InvalidRequest(
            "updates were checked moments ago; try again in a few seconds".into(),
        ));
    }
    // A failed check is recorded in the status, which the UI shows.
    let _ = tokio::task::spawn_blocking(move || updater.check()).await?;
    Ok(Json(state.updater.status()))
}

#[derive(Deserialize)]
pub struct InstallRequest {
    version: String,
}

pub async fn update_install(
    State(state): State<AppState>,
    Json(request): Json<InstallRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let updater = state.updater.clone();
    let installed =
        tokio::task::spawn_blocking(move || updater.install(&request.version)).await??;
    tracing::info!(version = %installed.version, "update installed; restarting");
    #[cfg(unix)]
    {
        // Let this response reach the browser before the process image is replaced.
        let executable = installed.executable.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(800));
            update::reexec(&executable)
        });
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "version": installed.version,
        "restarting": cfg!(unix),
    })))
}

pub type SharedIndex = Arc<RwLock<VaultIndex>>;
