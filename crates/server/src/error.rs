use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use uuid::Uuid;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    InvalidRequest(String),
    #[error("path is outside the vault or not allowed")]
    ForbiddenPath,
    #[error("resource not found")]
    NotFound,
    #[error("authentication required")]
    Unauthenticated,
    #[error("request is forbidden")]
    Forbidden,
    #[error("too many authentication attempts; retry after {retry_after_seconds} seconds")]
    RateLimited { retry_after_seconds: u64 },
    #[error("file has been modified externally")]
    RevisionConflict { current_hash: String },
    #[error("file is too large for browser editing")]
    TooLarge,
    #[error("markdown file is not valid UTF-8")]
    UnsupportedEncoding,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("internal server error")]
    Internal(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: &'static str,
    message: String,
    request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_revision: Option<RevisionBody>,
}

#[derive(Serialize)]
struct RevisionBody {
    hash: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, current_revision, retry_after) = match &self {
            Self::InvalidRequest(_) => (StatusCode::BAD_REQUEST, "invalid_request", None, None),
            Self::ForbiddenPath => (StatusCode::FORBIDDEN, "forbidden_path", None, None),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", None, None),
            Self::Unauthenticated => (StatusCode::UNAUTHORIZED, "unauthenticated", None, None),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden", None, None),
            Self::RateLimited {
                retry_after_seconds,
            } => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                None,
                Some(*retry_after_seconds),
            ),
            Self::RevisionConflict { current_hash } => (
                StatusCode::CONFLICT,
                "revision_conflict",
                Some(RevisionBody {
                    hash: current_hash.clone(),
                }),
                None,
            ),
            Self::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large", None, None),
            Self::UnsupportedEncoding => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_encoding",
                None,
                None,
            ),
            Self::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (StatusCode::NOT_FOUND, "not_found", None, None)
            }
            Self::Io(_) | Self::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                None,
                None,
            ),
        };
        if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
        }
        let body = ErrorBody {
            error: code,
            message: self.to_string(),
            request_id: Uuid::new_v4(),
            current_revision,
        };
        let mut response = (status, Json(body)).into_response();
        if let Some(seconds) = retry_after {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&seconds.to_string())
                    .unwrap_or_else(|_| HeaderValue::from_static("1")),
            );
        }
        response
    }
}
