use std::sync::Arc;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{Request, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use rust_embed::Embed;
use tokio::sync::{RwLock, broadcast};
use tower_http::{catch_panic::CatchPanicLayer, trace::TraceLayer};

use crate::{
    api,
    config::Config,
    error::{AppError, AppResult},
    index::VaultIndex,
    security::{
        auth::{AuthStore, require_auth},
        sandbox::VaultSandbox,
    },
    vault::{
        VaultService,
        watcher::{self, WatchHandle},
    },
    websocket::{self, GatewayEvent},
};

#[derive(Clone)]
pub struct AppState {
    pub vault: VaultService,
    pub index: Arc<RwLock<VaultIndex>>,
    pub events: broadcast::Sender<GatewayEvent>,
    pub auth: AuthStore,
}

#[derive(Embed)]
#[folder = "../../web/dist/"]
struct WebAssets;

pub async fn run(config: Config) -> AppResult<()> {
    let sandbox = VaultSandbox::new(&config.vault, config.show_hidden_files)?;
    let vault_name = sandbox.vault_name();
    let (index, stats) = VaultIndex::build(&sandbox)?;
    let auth = AuthStore::new(
        config.auth_enabled,
        config.password.as_deref(),
        config.secure_cookie,
    )?
    .with_trusted_proxies(config.trusted_proxies.clone());
    let vault = VaultService::new(sandbox, config.read_only, config.markdown_limit);
    let index = Arc::new(RwLock::new(index));
    let (events, _) = broadcast::channel(512);
    let state = AppState {
        vault: vault.clone(),
        index: index.clone(),
        events: events.clone(),
        auth,
    };
    let _watcher: WatchHandle = watcher::start(vault.sandbox().clone(), index, events)?;
    let router = router(state);
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(vault = %vault_name, files = stats.files, markdown = stats.markdown, attachments = stats.attachments, index_ms = stats.build_ms, "vault indexed");
    tracing::info!(listen = %config.listen, read_only = config.read_only, auth = config.auth_enabled, trusted_proxies = config.trusted_proxies.len(), "listening");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/api/v1/auth/session", get(api::auth_session))
        .route("/api/v1/auth/logout", post(api::logout))
        .route("/api/v1/tree", get(api::tree))
        .route("/api/v1/file", get(api::read_file).put(api::save_file))
        .route("/api/v1/files", post(api::create_file))
        .route("/api/v1/directories", post(api::create_directory))
        .route(
            "/api/v1/path",
            patch(api::change_path).delete(api::delete_path),
        )
        .route("/api/v1/asset", get(api::asset))
        .route("/api/v1/search", get(api::search))
        .route("/api/v1/resolve", get(api::resolve))
        .route("/api/v1/backlinks", get(api::backlinks))
        .route("/api/v1/ws", get(websocket::ws_handler))
        .route_layer(middleware::from_fn_with_state(
            state.auth.clone(),
            require_auth,
        ));

    Router::new()
        .route("/health", get(api::health))
        .route("/api/v1/system", get(api::system))
        .route("/api/v1/auth/login", post(api::login))
        .merge(protected)
        .fallback(static_handler)
        .layer(DefaultBodyLimit::max(11 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn static_handler(request: Request<axum::body::Body>) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (axum::http::StatusCode::NOT_FOUND, "API route not found").into_response();
    }
    let requested = if path.is_empty() { "index.html" } else { path };
    let asset = WebAssets::get(requested).or_else(|| WebAssets::get("index.html"));
    match asset {
        Some(asset) => {
            let mime = mime_guess::from_path(requested).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], asset.data).into_response()
        }
        None => (
            axum::http::StatusCode::NOT_FOUND,
            "frontend build not found",
        )
            .into_response(),
    }
}

async fn security_headers(request: Request<axum::body::Body>, next: middleware::Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry("x-content-type-options")
        .or_insert(axum::http::HeaderValue::from_static("nosniff"));
    headers
        .entry("referrer-policy")
        .or_insert(axum::http::HeaderValue::from_static("no-referrer"));
    headers.entry("content-security-policy").or_insert(axum::http::HeaderValue::from_static(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ));
    response
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to install Ctrl+C handler");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "failed to install SIGTERM handler"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

pub fn state_for_tests(vault: VaultService, auth: AuthStore) -> AppResult<AppState> {
    let (index, _) = VaultIndex::build(vault.sandbox())?;
    let (events, _) = broadcast::channel(16);
    Ok(AppState {
        vault,
        index: Arc::new(RwLock::new(index)),
        events,
        auth,
    })
}

impl From<tokio::task::JoinError> for AppError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::Internal(error.to_string())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::{fs, net::SocketAddr};

    use axum::{
        body::Body,
        extract::ConnectInfo,
        http::{Request, StatusCode, header},
    };
    use http_body_util::BodyExt;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use super::*;
    use crate::security::proxy::TrustedProxy;

    fn service(path: &std::path::Path, read_only: bool) -> AppResult<VaultService> {
        Ok(VaultService::new(
            VaultSandbox::new(path, false)?,
            read_only,
            1024 * 1024,
        ))
    }

    #[tokio::test]
    async fn unauthenticated_write_and_missing_csrf_are_rejected()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        fs::write(directory.path().join("A.md"), "one")?;
        let auth = AuthStore::new(true, Some("a long test password"), false)?;
        let application = router(state_for_tests(service(directory.path(), false)?, auth)?);

        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/files")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"path":"B.md","content":""}"#))?;
        assert_eq!(
            application.clone().oneshot(request).await?.status(),
            StatusCode::UNAUTHORIZED
        );

        let mut login_request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"password":"a long test password"}"#))?;
        login_request
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:12345".parse::<SocketAddr>()?));
        let login_response = application.clone().oneshot(login_request).await?;
        assert_eq!(login_response.status(), StatusCode::OK);
        let cookie = login_response
            .headers()
            .get(header::SET_COOKIE)
            .ok_or("missing cookie")?
            .to_str()?
            .split(';')
            .next()
            .ok_or("missing cookie pair")?
            .to_owned();
        let login_body = login_response.into_body().collect().await?.to_bytes();
        let login_json: serde_json::Value = serde_json::from_slice(&login_body)?;
        let csrf = login_json["csrfToken"].as_str().ok_or("missing csrf")?;

        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/files")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie)
            .body(Body::from(r#"{"path":"B.md","content":""}"#))?;
        assert_eq!(
            application.clone().oneshot(request).await?.status(),
            StatusCode::FORBIDDEN
        );

        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/files")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie)
            .header("x-csrf-token", csrf)
            .body(Body::from(r#"{"path":"B.md","content":""}"#))?;
        assert_eq!(
            application.oneshot(request).await?.status(),
            StatusCode::CREATED
        );
        assert!(directory.path().join("B.md").is_file());
        Ok(())
    }

    #[tokio::test]
    async fn login_cooldown_returns_retry_after_header() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        fs::write(directory.path().join("A.md"), "one")?;
        let auth = AuthStore::new(true, Some("a long test password"), false)?;
        let application = router(state_for_tests(service(directory.path(), false)?, auth)?);
        let client = ConnectInfo("127.0.0.1:12345".parse::<SocketAddr>()?);

        let mut wrong = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"password":"wrong"}"#))?;
        wrong.extensions_mut().insert(client);
        assert_eq!(
            application.clone().oneshot(wrong).await?.status(),
            StatusCode::UNAUTHORIZED
        );

        let mut retry = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"password":"a long test password"}"#))?;
        retry.extensions_mut().insert(client);
        let response = application.oneshot(retry).await?;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.headers().get(header::RETRY_AFTER),
            Some(&header::HeaderValue::from_static("1"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn trusted_proxy_separates_login_limits_by_forwarded_client_ip()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        fs::write(directory.path().join("A.md"), "one")?;
        let auth = AuthStore::new(true, Some("a long test password"), false)?
            .with_trusted_proxies(vec![TrustedProxy::parse("127.0.0.1/32")?]);
        let application = router(state_for_tests(service(directory.path(), false)?, auth)?);
        let proxy = ConnectInfo("127.0.0.1:12345".parse::<SocketAddr>()?);

        let mut wrong = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "203.0.113.10")
            .body(Body::from(r#"{"password":"wrong"}"#))?;
        wrong.extensions_mut().insert(proxy);
        assert_eq!(
            application.clone().oneshot(wrong).await?.status(),
            StatusCode::UNAUTHORIZED
        );

        let mut other_client = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "203.0.113.11")
            .body(Body::from(r#"{"password":"a long test password"}"#))?;
        other_client.extensions_mut().insert(proxy);
        assert_eq!(
            application.oneshot(other_client).await?.status(),
            StatusCode::OK
        );
        Ok(())
    }

    #[tokio::test]
    async fn untrusted_peer_cannot_change_login_bucket_with_forwarded_header()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        fs::write(directory.path().join("A.md"), "one")?;
        let auth = AuthStore::new(true, Some("a long test password"), false)?;
        let application = router(state_for_tests(service(directory.path(), false)?, auth)?);
        let peer = ConnectInfo("198.51.100.20:12345".parse::<SocketAddr>()?);

        let mut wrong = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "203.0.113.10")
            .body(Body::from(r#"{"password":"wrong"}"#))?;
        wrong.extensions_mut().insert(peer);
        assert_eq!(
            application.clone().oneshot(wrong).await?.status(),
            StatusCode::UNAUTHORIZED
        );

        let mut spoofed = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", "203.0.113.11")
            .body(Body::from(r#"{"password":"a long test password"}"#))?;
        spoofed.extensions_mut().insert(peer);
        assert_eq!(
            application.oneshot(spoofed).await?.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        Ok(())
    }

    #[tokio::test]
    async fn traversal_and_reserved_directories_are_rejected_by_http_api()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        fs::write(directory.path().join("A.md"), "one")?;
        fs::create_dir(directory.path().join(".git"))?;
        fs::write(directory.path().join(".git/config"), "secret")?;
        fs::write(
            directory.path().join("evil.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
        )?;
        let auth = AuthStore::new(false, None, false)?;
        let application = router(state_for_tests(service(directory.path(), false)?, auth)?);

        for uri in [
            "/api/v1/file?path=..%252Fsecret.md",
            "/api/v1/asset?path=..%2Fsecret.png",
            "/api/v1/asset?path=.git%2Fconfig",
        ] {
            let response = application
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty())?)
                .await?;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "accepted {uri}");
        }
        let svg = application
            .oneshot(
                Request::builder()
                    .uri("/api/v1/asset?path=evil.svg")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(svg.status(), StatusCode::OK);
        assert_eq!(
            svg.headers().get(header::CONTENT_TYPE),
            Some(&axum::http::HeaderValue::from_static("image/svg+xml"))
        );
        assert_eq!(
            svg.headers().get("content-security-policy"),
            Some(&axum::http::HeaderValue::from_static(
                "sandbox; default-src 'none'"
            ))
        );
        Ok(())
    }

    #[tokio::test]
    async fn read_only_mode_rejects_http_writes() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        fs::write(directory.path().join("A.md"), "one")?;
        let auth = AuthStore::new(false, None, false)?;
        let application = router(state_for_tests(service(directory.path(), true)?, auth)?);
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/files")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"path":"B.md","content":""}"#))?;
        assert_eq!(
            application.oneshot(request).await?.status(),
            StatusCode::FORBIDDEN
        );
        assert!(!directory.path().join("B.md").exists());
        Ok(())
    }
}
