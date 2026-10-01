use std::net::IpAddr;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Request, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{error::AppError, security::auth::AuthStore};

/// Without a password, DNS rebinding could let a malicious site reach the
/// gateway through its own hostname. Only loopback names and IP literals are
/// accepted as `Host`, and a browser `Origin` must match it.
pub async fn local_origin_guard(
    State(auth): State<AuthStore>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if auth.enabled() || allowed_without_auth(request.headers()) {
        next.run(request).await
    } else {
        AppError::Forbidden.into_response()
    }
}

fn allowed_without_auth(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST) else {
        // Non-browser clients may omit Host; rebinding requires a browser.
        return true;
    };
    let Ok(host) = host.to_str() else {
        return false;
    };
    if !is_local_host(host) {
        return false;
    }
    match headers.get(header::ORIGIN).map(|value| value.to_str()) {
        None => true,
        Some(Ok(origin)) => origin
            .split_once("://")
            .is_some_and(|(_, authority)| authority.eq_ignore_ascii_case(host)),
        Some(Err(_)) => false,
    }
}

fn is_local_host(authority: &str) -> bool {
    let name = if let Some(rest) = authority.strip_prefix('[') {
        // Bracketed IPv6 literal, optionally followed by :port.
        return rest
            .split_once(']')
            .is_some_and(|(address, _)| address.parse::<IpAddr>().is_ok());
    } else {
        match authority.rsplit_once(':') {
            Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
            _ => authority,
        }
    };
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    name == "localhost" || name.ends_with(".localhost") || name.parse::<IpAddr>().is_ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).expect("host"));
        if let Some(origin) = origin {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_str(origin).expect("origin"),
            );
        }
        headers
    }

    #[test]
    fn accepts_loopback_names_and_ip_literals() {
        for host in [
            "127.0.0.1:8765",
            "localhost:8765",
            "LOCALHOST",
            "notes.localhost:8765",
            "[::1]:8765",
            "192.168.1.20:8765",
        ] {
            assert!(allowed_without_auth(&headers(host, None)), "{host}");
        }
        assert!(allowed_without_auth(&headers(
            "127.0.0.1:8765",
            Some("http://127.0.0.1:8765")
        )));
    }

    #[test]
    fn rejects_rebound_hostnames_and_foreign_origins() {
        assert!(!allowed_without_auth(&headers(
            "attacker.example:8765",
            None
        )));
        assert!(!allowed_without_auth(&headers(
            "localhost.attacker.example",
            None
        )));
        assert!(!allowed_without_auth(&headers(
            "127.0.0.1:8765",
            Some("https://attacker.example")
        )));
        assert!(!allowed_without_auth(&headers(
            "127.0.0.1:8765",
            Some("null")
        )));
    }
}
