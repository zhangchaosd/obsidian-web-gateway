#![forbid(unsafe_code)]

use std::process::ExitCode;

use obsidian_web::{app, config::Config};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::load() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("configuration error: {error}");
            return ExitCode::FAILURE;
        }
    };

    let filter = EnvFilter::try_new(&config.log_level).unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    match app::run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error = %error, "server stopped");
            ExitCode::FAILURE
        }
    }
}
