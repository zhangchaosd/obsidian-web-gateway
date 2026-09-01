use axum::{
    Json,
    http::StatusCode,
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
        let (status, code, current_revision) = match &self {
            Self::InvalidRequest(_) => (StatusCode::BAD_REQUEST, "invalid_request", None),
            Self::ForbiddenPath => (StatusCode::FORBIDDEN, "forbidden_path", None),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", None),
            Self::Unauthenticated => (StatusCode::UNAUTHORIZED, "unauthenticated", None),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden", None),
            Self::RevisionConflict { current_hash } => (
                StatusCode::CONFLICT,
                "revision_conflict",
                Some(RevisionBody {
                    hash: current_hash.clone(),
                }),
            ),
            Self::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large", None),
            Self::UnsupportedEncoding => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_encoding",
                None,
            ),
            Self::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (StatusCode::NOT_FOUND, "not_found", None)
            }
            Self::Io(_) | Self::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", None)
            }
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
        (status, Json(body)).into_response()
    }
}
