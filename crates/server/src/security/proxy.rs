use std::{net::IpAddr, str::FromStr};

use axum::http::HeaderMap;

use crate::error::{AppError, AppResult};

const MAX_FORWARDED_HOPS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedProxy {
    network: IpAddr,
    prefix: u8,
}

impl TrustedProxy {
    pub fn parse(value: &str) -> AppResult<Self> {
        value.parse().map_err(AppError::InvalidRequest)
    }

    fn contains(&self, address: IpAddr) -> bool {
        let address = canonical_ip(address);
        match (self.network, address) {
            (IpAddr::V4(network), IpAddr::V4(address)) => {
                let mask = prefix_mask_v4(self.prefix);
                (u32::from(network) & mask) == (u32::from(address) & mask)
            }
            (IpAddr::V6(network), IpAddr::V6(address)) => {
                let mask = prefix_mask_v6(self.prefix);
                (u128::from(network) & mask) == (u128::from(address) & mask)
            }
            _ => false,
        }
    }
}

impl FromStr for TrustedProxy {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let value = value.trim();
        if value.is_empty() {
            return Err("trusted proxy must not be empty".into());
        }
        let (address, prefix) = match value.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (value, None),
        };
        let parsed = address
            .parse::<IpAddr>()
            .map_err(|_| format!("invalid trusted proxy address: {value}"))?;
        let original_is_mapped =
            matches!(parsed, IpAddr::V6(address) if address.to_ipv4_mapped().is_some());
        let network = canonical_ip(parsed);
        let max_prefix = if network.is_ipv4() { 32 } else { 128 };
        let mut prefix = prefix
            .map(str::parse::<u8>)
            .transpose()
            .map_err(|_| format!("invalid trusted proxy prefix: {value}"))?
            .unwrap_or(max_prefix);
        if original_is_mapped && prefix >= 96 {
            prefix -= 96;
        }
        if prefix > max_prefix {
            return Err(format!("trusted proxy prefix is out of range: {value}"));
        }
        Ok(Self { network, prefix })
    }
}

pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[TrustedProxy]) -> IpAddr {
    let peer = canonical_ip(peer);
    if !trusted.iter().any(|range| range.contains(peer)) {
        return peer;
    }

    let mut chain = Vec::new();
    for value in headers.get_all("x-forwarded-for") {
        let Ok(value) = value.to_str() else {
            return peer;
        };
        for part in value.split(',') {
            if chain.len() >= MAX_FORWARDED_HOPS {
                return peer;
            }
            let Ok(address) = part.trim().parse::<IpAddr>() else {
                return peer;
            };
            chain.push(canonical_ip(address));
        }
    }

    if chain.is_empty() {
        return peer;
    }
    chain
        .iter()
        .rev()
        .find(|address| !trusted.iter().any(|range| range.contains(**address)))
        .copied()
        .unwrap_or(chain[0])
}

fn canonical_ip(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        address => address,
    }
}

fn prefix_mask_v4(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

fn prefix_mask_v6(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(forwarded: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_str(forwarded).expect("forwarded header"),
        );
        headers
    }

    #[test]
    fn untrusted_peer_cannot_spoof_forwarded_address() {
        let trusted = vec![TrustedProxy::parse("127.0.0.1/32").expect("proxy")];
        let resolved = client_ip(
            "198.51.100.8".parse().expect("peer"),
            &headers("203.0.113.9"),
            &trusted,
        );
        assert_eq!(resolved, "198.51.100.8".parse::<IpAddr>().expect("address"));
    }

    #[test]
    fn trusted_local_caddy_exposes_real_client() {
        let trusted = vec![TrustedProxy::parse("127.0.0.1/32").expect("proxy")];
        let resolved = client_ip(
            "127.0.0.1".parse().expect("peer"),
            &headers("203.0.113.9"),
            &trusted,
        );
        assert_eq!(resolved, "203.0.113.9".parse::<IpAddr>().expect("address"));
    }

    #[test]
    fn strict_parsing_ignores_spoofed_leftmost_value() {
        let trusted = vec![
            TrustedProxy::parse("127.0.0.1/32").expect("local proxy"),
            TrustedProxy::parse("10.0.0.0/8").expect("upstream proxy"),
        ];
        let resolved = client_ip(
            "127.0.0.1".parse().expect("peer"),
            &headers("192.0.2.123, 203.0.113.9, 10.2.3.4"),
            &trusted,
        );
        assert_eq!(resolved, "203.0.113.9".parse::<IpAddr>().expect("address"));
    }

    #[test]
    fn malformed_or_excessive_forwarding_falls_back_to_peer() {
        let trusted = vec![TrustedProxy::parse("::1/128").expect("proxy")];
        let peer = "::1".parse::<IpAddr>().expect("peer");
        assert_eq!(client_ip(peer, &headers("unknown"), &trusted), peer);
        let excessive = std::iter::repeat_n("203.0.113.9", MAX_FORWARDED_HOPS + 1)
            .collect::<Vec<_>>()
            .join(", ");
        assert_eq!(client_ip(peer, &headers(&excessive), &trusted), peer);
    }

    #[test]
    fn ipv4_mapped_peer_matches_ipv4_proxy_range() {
        let trusted = vec![TrustedProxy::parse("127.0.0.0/8").expect("proxy")];
        let resolved = client_ip(
            "::ffff:127.0.0.1".parse().expect("peer"),
            &headers("2001:db8::123"),
            &trusted,
        );
        assert_eq!(
            resolved,
            "2001:db8::123".parse::<IpAddr>().expect("address")
        );
    }
}
