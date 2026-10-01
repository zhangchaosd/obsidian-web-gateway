use std::{env, fs, net::SocketAddr, path::PathBuf};

use clap::{Parser, Subcommand};
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
    #[command(subcommand)]
    command: Option<Command>,
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
    username: Option<String>,
    #[arg(long)]
    password: Option<String>,
    /// SQLite passkey database copied from (or shared with) bookmarkd.
    #[arg(long, value_name = "PATH")]
    passkey_db: Option<PathBuf>,
    /// Exact browser-facing origin, e.g. https://obsidian.example.com; required for passkeys.
    #[arg(long, value_name = "URL")]
    public_url: Option<String>,
    /// Directory for gateway state such as update settings.
    #[arg(long, value_name = "PATH")]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    secure_cookie: bool,
    #[arg(
        long = "trusted-proxy",
        value_name = "IP_OR_CIDR",
        value_delimiter = ','
    )]
    trusted_proxy: Vec<String>,
}

#[derive(Clone, Debug, Subcommand)]
enum Command {
    /// Check GitHub Releases for a newer version, install it, or roll back.
    Update {
        #[command(subcommand)]
        command: UpdateCommand,
    },
}

#[derive(Clone, Copy, Debug, Subcommand)]
pub enum UpdateCommand {
    /// Print whether a newer release is available on the configured channel.
    Check,
    /// Download, verify against SHA256SUMS.txt, and replace this executable.
    Install {
        #[arg(long)]
        yes: bool,
    },
    /// Restore the executable kept as `*.old` by the last install.
    Rollback {
        #[arg(long)]
        yes: bool,
    },
}

/// What the process was asked to do.
pub enum Launch {
    Serve(Box<Config>),
    Update {
        command: UpdateCommand,
        data_dir: PathBuf,
    },
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
    public_url: Option<String>,
    data_dir: Option<PathBuf>,
}
#[derive(Debug, Deserialize)]
struct AuthSection {
    enabled: Option<bool>,
    secure_cookie: Option<bool>,
    username: Option<String>,
    passkey_db: Option<PathBuf>,
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
    pub username: Option<String>,
    pub password: Option<String>,
    pub passkey_db: Option<PathBuf>,
    pub public_url: Option<String>,
    pub data_dir: PathBuf,
    pub secure_cookie: bool,
    pub trusted_proxies: Vec<TrustedProxy>,
    pub markdown_limit: u64,
}

impl Config {
    pub fn load() -> AppResult<Launch> {
        let cli = Cli::parse();
        let file = match &cli.config {
            Some(path) => toml::from_str::<FileConfig>(&fs::read_to_string(path)?)
                .map_err(|error| AppError::InvalidRequest(format!("invalid config: {error}")))?,
            None => FileConfig::default(),
        };
        let data_dir = cli
            .data_dir
            .clone()
            .or_else(|| env::var_os("OBSIDIAN_WEB_DATA_DIR").map(PathBuf::from))
            .or_else(|| {
                file.server
                    .as_ref()
                    .and_then(|section| section.data_dir.clone())
            })
            .or_else(|| dirs::data_local_dir().map(|dir| dir.join("obsidian-web")))
            .ok_or_else(|| {
                AppError::InvalidRequest("--data-dir <PATH> is required on this platform".into())
            })?;
        if let Some(Command::Update { command }) = cli.command {
            return Ok(Launch::Update { command, data_dir });
        }

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
            .or_else(|| env::var("OBSIDIAN_WEB_PASSWORD").ok())
            .filter(|value| !value.is_empty());
        let username = cli
            .username
            .or_else(|| env::var("OBSIDIAN_WEB_USERNAME").ok())
            .or_else(|| file_auth.and_then(|section| section.username.clone()))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let passkey_db = cli
            .passkey_db
            .or_else(|| env::var_os("OBSIDIAN_WEB_PASSKEY_DB").map(PathBuf::from))
            .or_else(|| file_auth.and_then(|section| section.passkey_db.clone()));
        let public_url = cli
            .public_url
            .or_else(|| env::var("OBSIDIAN_WEB_PUBLIC_URL").ok())
            .or_else(|| file_server.and_then(|section| section.public_url.clone()))
            .map(|value| value.trim_end_matches('/').to_owned());
        if let Some(origin) = &public_url {
            validate_public_url(origin)?;
        }
        if auth_enabled && password.is_none() && passkey_db.is_none() {
            return Err(AppError::InvalidRequest(
                "authentication is enabled; set OBSIDIAN_WEB_PASSWORD / --password or --passkey-db (use --no-auth only for trusted localhost access)".into(),
            ));
        }
        if auth_enabled && passkey_db.is_some() && public_url.is_none() {
            return Err(AppError::InvalidRequest(
                "--passkey-db requires --public-url, the exact origin browsers use (for example https://obsidian.example.com)".into(),
            ));
        }
        // An HTTPS origin means the browser-facing connection is secure, even behind a proxy.
        let secure_origin = public_url
            .as_deref()
            .is_some_and(|origin| origin.starts_with("https://"));

        Ok(Launch::Serve(Box::new(Self {
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
            username,
            password,
            passkey_db,
            public_url,
            data_dir,
            secure_cookie: cli.secure_cookie
                || secure_origin
                || file_auth
                    .and_then(|section| section.secure_cookie)
                    .unwrap_or(false),
            trusted_proxies,
            markdown_limit: 10 * 1024 * 1024,
        })))
    }
}

/// Passkeys are bound to an exact origin, so it must be written exactly as browsers send it.
fn validate_public_url(origin: &str) -> AppResult<()> {
    let invalid =
        |reason: &str| AppError::InvalidRequest(format!("invalid --public-url: {reason}"));
    let url = url::Url::parse(origin).map_err(|error| invalid(&error.to_string()))?;
    if url.origin().ascii_serialization() != origin {
        return Err(invalid(
            "use only scheme, host, and optional port, without a path or trailing slash",
        ));
    }
    let local = url.host_str() == Some("localhost");
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err(invalid("HTTPS is required except for http://localhost"));
    }
    Ok(())
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
