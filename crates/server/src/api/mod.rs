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
    security::auth,
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
    })
}

pub async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
pub struct LoginRequest {
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    csrf_token: String,
}

pub async fn login(
    State(state): State<AppState>,
    connect: axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<LoginRequest>,
) -> AppResult<Response> {
    let store = state.auth.clone();
    let password = request.password;
    let client = auth::client_key(connect);
    let result = tokio::task::spawn_blocking(move || store.login(&password, &client)).await??;
    let mut response = Json(LoginResponse {
        csrf_token: result.csrf,
    })
    .into_response();
    if !result.cookie.is_empty() {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&result.cookie)
                .map_err(|_| AppError::Internal("invalid session cookie".into()))?,
        );
    }
    Ok(response)
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
    rebuild_index(&state).await;
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
    rebuild_index(state).await;
    let _ = state.events.send(GatewayEvent::path(kind, path));
}

async fn rebuild_index(state: &AppState) {
    let sandbox = state.vault.sandbox().clone();
    let result = tokio::task::spawn_blocking(move || VaultIndex::build(&sandbox)).await;
    match result {
        Ok(Ok((rebuilt, _))) => *state.index.write().await = rebuilt,
        Ok(Err(error)) => tracing::warn!(error = %error, "index refresh failed"),
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

pub type SharedIndex = Arc<RwLock<VaultIndex>>;
