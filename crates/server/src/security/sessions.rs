//! Browser sessions, optionally persisted so restarts and updates keep users
//! signed in. Only SHA-256 digests of session tokens are stored. The file also
//! records an Argon2 fingerprint of the login configuration; when the
//! username, password, or passkey RP ID changes, every stored session is
//! discarded on startup.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub csrf: String,
    /// Unix seconds; sessions never slide.
    pub expires: i64,
    /// Passkey sessions end when that credential is revoked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    fingerprint: String,
    sessions: HashMap<String, Session>,
}

#[derive(Default)]
pub struct SessionStore {
    path: Option<PathBuf>,
    fingerprint: String,
    sessions: HashMap<String, Session>,
}

impl SessionStore {
    /// In-memory sessions that end with the process.
    pub fn ephemeral() -> Self {
        Self::default()
    }

    /// Loads sessions from `path`, keeping them only if they were created under
    /// the same login configuration (`material`).
    pub fn persistent(path: &Path, material: &str) -> AppResult<Self> {
        let stored = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<SessionFile>(&text).ok())
            .filter(|file| file.version == FORMAT_VERSION);
        let reusable = stored.filter(|file| {
            PasswordHash::new(&file.fingerprint).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(material.as_bytes(), &hash)
                    .is_ok()
            })
        });
        let mut store = match reusable {
            Some(file) => Self {
                path: Some(path.to_path_buf()),
                fingerprint: file.fingerprint,
                sessions: file.sessions,
            },
            None => {
                if path.exists() {
                    tracing::info!("login settings changed; stored sessions were signed out");
                }
                Self {
                    path: Some(path.to_path_buf()),
                    fingerprint: fingerprint(material)?,
                    sessions: HashMap::new(),
                }
            }
        };
        store.prune();
        store.persist()?;
        Ok(store)
    }

    pub fn get(&self, token: &str) -> Option<&Session> {
        self.sessions
            .get(&digest(token))
            .filter(|session| session.expires > now())
    }

    pub fn insert(&mut self, token: &str, session: Session) -> AppResult<()> {
        self.prune();
        self.sessions.insert(digest(token), session);
        self.persist()
    }

    pub fn remove(&mut self, token: &str) -> AppResult<()> {
        if self.sessions.remove(&digest(token)).is_some() {
            self.persist()?;
        }
        Ok(())
    }

    fn prune(&mut self) {
        let now = now();
        self.sessions.retain(|_, session| session.expires > now);
    }

    fn persist(&self) -> AppResult<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = SessionFile {
            version: FORMAT_VERSION,
            fingerprint: self.fingerprint.clone(),
            sessions: self.sessions.clone(),
        };
        let bytes =
            serde_json::to_vec(&file).map_err(|error| AppError::Internal(error.to_string()))?;
        let temporary = path.with_extension("json.tmp");
        write_private(&temporary, &bytes)?;
        fs::rename(temporary, path)?;
        Ok(())
    }
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64)
}

fn digest(token: &str) -> String {
    bookmarkd_auth::digest("owg-session", token)
}

fn fingerprint(material: &str) -> AppResult<String> {
    let mut salt = [0_u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let salt = SaltString::encode_b64(&salt)
        .map_err(|error| AppError::Internal(format!("salt encoding failed: {error}")))?;
    Ok(Argon2::default()
        .hash_password(material.as_bytes(), &salt)
        .map_err(|error| AppError::Internal(format!("fingerprint failed: {error}")))?
        .to_string())
}

fn write_private(path: &Path, bytes: &[u8]) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn session(expires: i64) -> Session {
        Session {
            csrf: "csrf".into(),
            expires,
            credential: None,
        }
    }

    #[test]
    fn sessions_survive_reload_but_not_configuration_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let mut store = SessionStore::persistent(&path, "config-a").unwrap();
        store.insert("token", session(now() + 60)).unwrap();
        store.insert("expired", session(now() - 1)).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("\"token\""),
            "tokens are stored only as digests"
        );

        let reloaded = SessionStore::persistent(&path, "config-a").unwrap();
        assert!(reloaded.get("token").is_some());
        assert!(reloaded.get("expired").is_none());

        let changed = SessionStore::persistent(&path, "config-b").unwrap();
        assert!(changed.get("token").is_none());
        // The new configuration's fingerprint is now the one on disk.
        assert!(
            SessionStore::persistent(&path, "config-a")
                .unwrap()
                .get("token")
                .is_none()
        );
    }

    #[test]
    fn removed_sessions_are_forgotten_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let mut store = SessionStore::persistent(&path, "config").unwrap();
        store.insert("token", session(now() + 60)).unwrap();
        store.remove("token").unwrap();
        assert!(
            SessionStore::persistent(&path, "config")
                .unwrap()
                .get("token")
                .is_none()
        );
    }
}
