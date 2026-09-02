use std::{env, fs, net::SocketAddr, path::PathBuf};

use clap::Parser;
use serde::Deserialize;

use crate::{
    error::{AppError, AppResult},
    security::proxy::TrustedProxy,
};

#[derive(Debug, Parser)]
#[command(
    name = "obsidian-web",
    version,
    about = "Secure web access to an Obsidian Vault"
)]
struct Cli {
    #[arg(long)]
    vault: Option<PathBuf>,
    #[arg(long)]
    listen: Option<SocketAddr>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    log_level: Option<String>,
    #[arg(long)]
    read_only: bool,
    #[arg(long)]
    show_hidden_files: bool,
    #[arg(long)]
    no_auth: bool,
    #[arg(long)]
    password: Option<String>,
    #[arg(long)]
    secure_cookie: bool,
    #[arg(
        long = "trusted-proxy",
        value_name = "IP_OR_CIDR",
        value_delimiter = ','
    )]
    trusted_proxy: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    vault: Option<VaultSection>,
    server: Option<ServerSection>,
    auth: Option<AuthSection>,
    features: Option<FeaturesSection>,
    logging: Option<LoggingSection>,
}

#[derive(Debug, Deserialize)]
struct VaultSection {
    path: PathBuf,
}
#[derive(Debug, Deserialize)]
struct ServerSection {
    listen: Option<SocketAddr>,
    trusted_proxies: Option<Vec<String>>,
}
#[derive(Debug, Deserialize)]
struct AuthSection {
    enabled: Option<bool>,
    secure_cookie: Option<bool>,
}
#[derive(Debug, Deserialize)]
struct FeaturesSection {
    read_only: Option<bool>,
    show_hidden_files: Option<bool>,
}
#[derive(Debug, Deserialize)]
struct LoggingSection {
    level: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub vault: PathBuf,
    pub listen: SocketAddr,
    pub log_level: String,
    pub read_only: bool,
    pub show_hidden_files: bool,
    pub auth_enabled: bool,
    pub password: Option<String>,
    pub secure_cookie: bool,
    pub trusted_proxies: Vec<TrustedProxy>,
    pub markdown_limit: u64,
}

impl Config {
    pub fn load() -> AppResult<Self> {
        let cli = Cli::parse();
        let file = match &cli.config {
            Some(path) => toml::from_str::<FileConfig>(&fs::read_to_string(path)?)
                .map_err(|error| AppError::InvalidRequest(format!("invalid config: {error}")))?,
            None => FileConfig::default(),
        };

        let env_vault = env::var_os("OBSIDIAN_WEB_VAULT").map(PathBuf::from);
        let vault = cli
            .vault
            .or(env_vault)
            .or_else(|| file.vault.map(|section| section.path))
            .ok_or_else(|| AppError::InvalidRequest("--vault <PATH> is required".into()))?;

        let file_server = file.server.as_ref();
        let listen = cli
            .listen
            .or_else(|| {
                env::var("OBSIDIAN_WEB_LISTEN")
                    .ok()
                    .and_then(|v| v.parse().ok())
            })
            .or_else(|| file_server.and_then(|section| section.listen))
            .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8765)));
        let trusted_proxy_values = if !cli.trusted_proxy.is_empty() {
            cli.trusted_proxy
        } else if let Ok(value) = env::var("OBSIDIAN_WEB_TRUSTED_PROXIES") {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        } else {
            file_server
                .and_then(|section| section.trusted_proxies.clone())
                .unwrap_or_default()
        };
        let trusted_proxies = trusted_proxy_values
            .iter()
            .map(|value| TrustedProxy::parse(value))
            .collect::<AppResult<Vec<_>>>()?;
        let file_auth = file.auth.as_ref();
        let auth_enabled = if cli.no_auth {
            false
        } else {
            env_bool("OBSIDIAN_WEB_AUTH_ENABLED")
                .or_else(|| file_auth.and_then(|section| section.enabled))
                .unwrap_or(true)
        };
        let password = cli
            .password
            .or_else(|| env::var("OBSIDIAN_WEB_PASSWORD").ok());
        if auth_enabled && password.as_deref().is_none_or(str::is_empty) {
            return Err(AppError::InvalidRequest(
                "authentication is enabled; set OBSIDIAN_WEB_PASSWORD or pass --password (use --no-auth only for trusted localhost access)".into(),
            ));
        }

        Ok(Self {
            vault,
            listen,
            log_level: cli
                .log_level
                .or_else(|| env::var("OBSIDIAN_WEB_LOG_LEVEL").ok())
                .or_else(|| file.logging.and_then(|section| section.level))
                .unwrap_or_else(|| "info".into()),
            read_only: if cli.read_only {
                true
            } else {
                env_bool("OBSIDIAN_WEB_READ_ONLY")
                    .or_else(|| file.features.as_ref().and_then(|section| section.read_only))
                    .unwrap_or(false)
            },
            show_hidden_files: cli.show_hidden_files
                || file
                    .features
                    .as_ref()
                    .and_then(|section| section.show_hidden_files)
                    .unwrap_or(false),
            auth_enabled,
            password,
            secure_cookie: cli.secure_cookie
                || file_auth
                    .and_then(|section| section.secure_cookie)
                    .unwrap_or(false),
            trusted_proxies,
            markdown_limit: 10 * 1024 * 1024,
        })
    }
}

fn env_bool(name: &str) -> Option<bool> {
    env::var(name)
        .ok()
        .and_then(|value| match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}
