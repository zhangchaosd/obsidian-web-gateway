use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    body::Body,
    http::{HeaderMap, Request},
    middleware::Next,
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;

use crate::{
    error::{AppError, AppResult},
    security::proxy::{self, TrustedProxy},
};

const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const LOGIN_COOLDOWN: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct AuthStore {
    enabled: bool,
    password_hash: Option<String>,
    secure_cookie: bool,
    trusted_proxies: Vec<TrustedProxy>,
    inner: Arc<Mutex<AuthInner>>,
}

#[derive(Default)]
struct AuthInner {
    sessions: HashMap<String, Session>,
    failures: HashMap<String, Vec<Instant>>,
    next_attempt: HashMap<String, Instant>,
    active_attempts: HashSet<String>,
}

struct Session {
    csrf: String,
    expires: Instant,
}

pub struct LoginResult {
    pub cookie: String,
    pub csrf: String,
}

impl AuthStore {
    pub fn new(enabled: bool, password: Option<&str>, secure_cookie: bool) -> AppResult<Self> {
        let password_hash = if enabled {
            let password =
                password.ok_or_else(|| AppError::InvalidRequest("password required".into()))?;
            let mut salt_bytes = [0_u8; 16];
            rand::rng().fill_bytes(&mut salt_bytes);
            let salt = SaltString::encode_b64(&salt_bytes)
                .map_err(|error| AppError::Internal(format!("salt encoding failed: {error}")))?;
            Some(
                Argon2::default()
                    .hash_password(password.as_bytes(), &salt)
                    .map_err(|error| {
                        AppError::Internal(format!("password hashing failed: {error}"))
                    })?
                    .to_string(),
            )
        } else {
            None
        };
        Ok(Self {
            enabled,
            password_hash,
            secure_cookie,
            trusted_proxies: Vec::new(),
            inner: Arc::new(Mutex::new(AuthInner::default())),
        })
    }

    pub fn with_trusted_proxies(mut self, trusted_proxies: Vec<TrustedProxy>) -> Self {
        self.trusted_proxies = trusted_proxies;
        self
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn client_key(&self, peer: std::net::IpAddr, headers: &HeaderMap) -> String {
        proxy::client_ip(peer, headers, &self.trusted_proxies).to_string()
    }

    pub fn login(&self, password: &str, client: &str) -> AppResult<LoginResult> {
        if !self.enabled {
            return Ok(LoginResult {
                cookie: String::new(),
                csrf: String::new(),
            });
        }
        let hash = self
            .password_hash
            .as_deref()
            .ok_or(AppError::Unauthenticated)?;
        let parsed = PasswordHash::new(hash)
            .map_err(|_| AppError::Internal("invalid password hash".into()))?;
        let now = Instant::now();
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| AppError::Internal("auth lock poisoned".into()))?;
            let failures = inner.failures.entry(client.to_owned()).or_default();
            failures.retain(|attempt| now.duration_since(*attempt) < FAILURE_WINDOW);
            if failures.len() >= 5 {
                return Err(AppError::Forbidden);
            }
            if let Some(retry_at) = inner.next_attempt.get(client).copied() {
                if retry_at > now {
                    return Err(rate_limited(retry_at.duration_since(now)));
                }
                inner.next_attempt.remove(client);
            }
            if !inner.active_attempts.insert(client.to_owned()) {
                return Err(rate_limited(LOGIN_COOLDOWN));
            }
        }

        if Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_err()
        {
            let failed_at = Instant::now();
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| AppError::Internal("auth lock poisoned".into()))?;
            inner.active_attempts.remove(client);
            inner
                .failures
                .entry(client.to_owned())
                .or_default()
                .push(failed_at);
            inner
                .next_attempt
                .insert(client.to_owned(), failed_at + LOGIN_COOLDOWN);
            return Err(AppError::Unauthenticated);
        }

        let authenticated_at = Instant::now();
        let session = random_token();
        let csrf = random_token();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("auth lock poisoned".into()))?;
        inner.active_attempts.remove(client);
        inner.failures.remove(client);
        inner.next_attempt.remove(client);
        inner
            .sessions
            .retain(|_, value| value.expires > authenticated_at);
        inner.sessions.insert(
            session.clone(),
            Session {
                csrf: csrf.clone(),
                expires: authenticated_at + SESSION_TTL,
            },
        );
        let secure = if self.secure_cookie { "; Secure" } else { "" };
        let cookie = format!(
            "owg_session={session}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
            SESSION_TTL.as_secs(),
            secure
        );
        Ok(LoginResult { cookie, csrf })
    }

    pub fn logout(&self, headers: &HeaderMap) -> AppResult<()> {
        if let Some(token) = cookie_value(headers, "owg_session") {
            self.inner
                .lock()
                .map_err(|_| AppError::Internal("auth lock poisoned".into()))?
                .sessions
                .remove(token);
        }
        Ok(())
    }

    pub fn csrf_token(&self, headers: &HeaderMap) -> AppResult<String> {
        if !self.enabled {
            return Ok(String::new());
        }
        let token = cookie_value(headers, "owg_session").ok_or(AppError::Unauthenticated)?;
        let now = Instant::now();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("auth lock poisoned".into()))?;
        inner.sessions.retain(|_, session| session.expires > now);
        inner
            .sessions
            .get(token)
            .map(|session| session.csrf.clone())
            .ok_or(AppError::Unauthenticated)
    }

    fn authorize(&self, headers: &HeaderMap, mutation: bool) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        let token = cookie_value(headers, "owg_session").ok_or(AppError::Unauthenticated)?;
        let now = Instant::now();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("auth lock poisoned".into()))?;
        inner.sessions.retain(|_, session| session.expires > now);
        let session = inner.sessions.get(token).ok_or(AppError::Unauthenticated)?;
        if mutation {
            let csrf = headers
                .get("x-csrf-token")
                .and_then(|value| value.to_str().ok());
            if csrf != Some(session.csrf.as_str()) {
                return Err(AppError::Forbidden);
            }
        }
        Ok(())
    }
}

fn rate_limited(retry_after: Duration) -> AppError {
    AppError::RateLimited {
        retry_after_seconds: retry_after.as_secs().max(1),
    }
}

pub async fn require_auth(
    axum::extract::State(auth): axum::extract::State<AuthStore>,
    request: Request<Body>,
    next: Next,
) -> AppResult<Response> {
    let mutation = !matches!(
        *request.method(),
        http::Method::GET | http::Method::HEAD | http::Method::OPTIONS
    );
    auth.authorize(request.headers(), mutation)?;
    Ok(next.run(request).await)
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(http::header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then_some(value)
        })
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use http::HeaderValue;
    use std::sync::Barrier;

    #[test]
    fn session_requires_csrf_for_mutations() {
        let auth = AuthStore::new(true, Some("correct horse battery staple"), false).expect("auth");
        assert!(auth.login("wrong", "client").is_err());
        assert!(matches!(
            auth.login("correct horse battery staple", "client"),
            Err(AppError::RateLimited { .. })
        ));
        std::thread::sleep(LOGIN_COOLDOWN);
        let login = auth
            .login("correct horse battery staple", "client")
            .expect("login");
        let pair = login.cookie.split(';').next().expect("cookie pair");
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::COOKIE,
            HeaderValue::from_str(pair).expect("header"),
        );
        assert!(auth.authorize(&headers, false).is_ok());
        assert!(auth.authorize(&headers, true).is_err());
        headers.insert(
            "x-csrf-token",
            HeaderValue::from_str(&login.csrf).expect("csrf"),
        );
        assert!(auth.authorize(&headers, true).is_ok());
    }

    #[test]
    fn concurrent_attempts_from_one_client_are_serialized() {
        let auth = AuthStore::new(true, Some("correct horse battery staple"), false).expect("auth");
        let barrier = Arc::new(Barrier::new(4));
        let threads = (0..4)
            .map(|_| {
                let auth = auth.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    auth.login("wrong", "same-client")
                })
            })
            .collect::<Vec<_>>();
        let attempts = threads
            .into_iter()
            .map(|thread| thread.join().expect("login thread"))
            .collect::<Vec<_>>();

        assert_eq!(
            attempts
                .iter()
                .filter(|result| matches!(result, Err(AppError::Unauthenticated)))
                .count(),
            1
        );
        assert_eq!(
            attempts
                .iter()
                .filter(|result| matches!(result, Err(AppError::RateLimited { .. })))
                .count(),
            3
        );
    }
}
