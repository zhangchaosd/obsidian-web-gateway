//! Passkey login backed by bookmarkd's authentication store.
//!
//! The SQLite database written by bookmarkd holds the WebAuthn identity (RP ID
//! and user handle) and the registered credentials. Copying it here, or pointing
//! at the same file on one host, lets the same passkeys sign in to this gateway
//! as long as both sites live under that RP ID. Credentials are managed in
//! bookmarkd; this gateway only verifies them.

use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

use bookmarkd_auth::{
    AuthStore as _, SqliteAuthStore, StoredCredential,
    engine::{CeremonyState, Engine},
};
use serde_json::Value;

use crate::{
    error::{AppError, AppResult},
    security::auth::random_token,
};

/// Scope for this gateway's rows in the shared store; never bookmarkd's own.
pub const APP_ID: &str = "obsidian-web";
const CEREMONY_TTL: Duration = Duration::from_secs(300);
const MAX_CEREMONIES: usize = 1000;
const MAX_CEREMONIES_PER_BROWSER: usize = 5;
/// How long a revocation in the shared database may take to end sessions.
const ACTIVE_CACHE_TTL: Duration = Duration::from_secs(30);

pub struct PasskeyAuth {
    store: SqliteAuthStore,
    engine: Engine,
    origin: String,
    rp_id: String,
    ceremonies: Mutex<HashMap<String, Ceremony>>,
    active: Mutex<Option<(Instant, std::collections::HashSet<String>)>>,
}

struct Ceremony {
    state: CeremonyState,
    binding: String,
    expires: Instant,
    credentials: Vec<StoredCredential>,
}

impl PasskeyAuth {
    pub fn open(path: &Path, origin: &str, user_name: &str) -> AppResult<Self> {
        let invalid = |message: String| AppError::InvalidRequest(message);
        if !path.is_file() {
            return Err(invalid(format!(
                "passkey database not found: {}",
                path.display()
            )));
        }
        let store = SqliteAuthStore {
            path: path.to_path_buf(),
        };
        let identity = store.identity().map_err(|error| {
            invalid(format!(
                "cannot read passkey database {}: {error:#}",
                path.display()
            ))
        })?;
        let host = url::Url::parse(origin)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .ok_or_else(|| invalid("invalid --public-url".into()))?;
        let rp_id = identity.rp_id.clone();
        if host != rp_id && !host.ends_with(&format!(".{rp_id}")) {
            return Err(invalid(format!(
                "--public-url host {host} is not within the passkey RP ID {rp_id}; serve the gateway from {rp_id} or one of its subdomains"
            )));
        }
        let engine = Engine::new(&identity, "Obsidian Web Gateway", user_name, origin)
            .map_err(|error| invalid(format!("invalid passkey identity: {error:#}")))?;
        Ok(Self {
            store,
            engine,
            origin: origin.to_owned(),
            rp_id,
            ceremonies: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
        })
    }

    pub fn rp_id(&self) -> &str {
        &self.rp_id
    }

    pub fn credential_count(&self) -> AppResult<usize> {
        Ok(self.credentials()?.len())
    }

    /// Starts a login ceremony bound to the browser's `binding` cookie value.
    /// Returns WebAuthn request options with a `ceremonyId` for the finish call.
    pub fn begin(&self, binding: &str) -> AppResult<Value> {
        let credentials = self.credentials()?;
        if credentials.is_empty() {
            return Err(AppError::InvalidRequest(
                "no passkeys are registered; register one in bookmarkd and copy its database again"
                    .into(),
            ));
        }
        let (mut options, state) = self
            .engine
            .login_begin(&credentials)
            .map_err(|error| AppError::Internal(format!("passkey challenge failed: {error:#}")))?;
        let id = random_token();
        let now = Instant::now();
        let mut ceremonies = self.lock()?;
        ceremonies.retain(|_, ceremony| ceremony.expires > now);
        if ceremonies.len() >= MAX_CEREMONIES
            || ceremonies
                .values()
                .filter(|ceremony| ceremony.binding == binding)
                .count()
                >= MAX_CEREMONIES_PER_BROWSER
        {
            return Err(AppError::RateLimited {
                retry_after_seconds: 5,
            });
        }
        ceremonies.insert(
            id.clone(),
            Ceremony {
                state,
                binding: binding.to_owned(),
                expires: now + CEREMONY_TTL,
                credentials,
            },
        );
        options["ceremonyId"] = Value::String(id);
        Ok(options)
    }

    /// Whether a credential is still registered and not revoked. Cached briefly;
    /// if the database is unavailable the last known list is kept.
    pub fn is_active(&self, credential_id: &str) -> bool {
        let Ok(mut active) = self.active.lock() else {
            return false;
        };
        let stale = active
            .as_ref()
            .is_none_or(|(checked, _)| checked.elapsed() > ACTIVE_CACHE_TTL);
        if stale {
            let previous = active.take().map(|(_, ids)| ids).unwrap_or_default();
            let ids = self.credentials().map_or(previous, |credentials| {
                credentials
                    .into_iter()
                    .map(|credential| credential.id)
                    .collect()
            });
            *active = Some((Instant::now(), ids));
        }
        active
            .as_ref()
            .is_some_and(|(_, ids)| ids.contains(credential_id))
    }

    /// Verifies the authenticator response and returns the credential ID.
    /// Ceremony state is consumed before verification so a response can never
    /// be replayed.
    pub fn finish(&self, ceremony_id: &str, binding: &str, credential: Value) -> AppResult<String> {
        let ceremony = self
            .lock()?
            .remove(ceremony_id)
            .ok_or(AppError::Unauthenticated)?;
        if ceremony.expires <= Instant::now()
            || !bookmarkd_auth::secure_eq(&ceremony.binding, binding)
        {
            return Err(AppError::Unauthenticated);
        }
        let updated = self
            .engine
            .login_finish(credential, ceremony.state, &ceremony.credentials)
            .map_err(|error| {
                tracing::warn!(error = %error, "passkey verification failed");
                AppError::Unauthenticated
            })?;
        // Persists the signature counter and backup flags. It also records a
        // session row scoped to this app, which expires on its own.
        self.store
            .finish_login(&updated, APP_ID, &self.origin, false)
            .map_err(|error| {
                tracing::warn!(error = %error, "passkey credential update failed");
                AppError::Unauthenticated
            })?;
        Ok(updated.id)
    }

    fn credentials(&self) -> AppResult<Vec<StoredCredential>> {
        self.store
            .credentials()
            .map_err(|error| AppError::Internal(format!("passkey database unavailable: {error:#}")))
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, Ceremony>>> {
        self.ceremonies
            .lock()
            .map_err(|_| AppError::Internal("passkey lock poisoned".into()))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use bookmarkd_auth::Identity;

    fn database(rp_id: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("auth.db");
        SqliteAuthStore::initialize(
            &path,
            &Identity {
                rp_id: rp_id.into(),
                user_id: bookmarkd_auth::random(),
            },
        )
        .expect("initialize");
        (dir, path)
    }

    #[test]
    fn accepts_subdomains_of_the_shared_rp_id() {
        let (_dir, path) = database("example.com");
        let passkey = PasskeyAuth::open(&path, "https://notes.example.com", "owner").expect("open");
        assert_eq!(passkey.rp_id(), "example.com");
        assert_eq!(passkey.credential_count().expect("count"), 0);
        // Without registered credentials there is nothing to sign in with.
        assert!(matches!(
            passkey.begin("browser"),
            Err(AppError::InvalidRequest(_))
        ));
    }

    #[test]
    fn rejects_origins_outside_the_rp_id_and_missing_databases() {
        let (dir, path) = database("example.com");
        assert!(PasskeyAuth::open(&path, "https://example.org", "owner").is_err());
        assert!(PasskeyAuth::open(&path, "https://badexample.com", "owner").is_err());
        assert!(
            PasskeyAuth::open(
                &dir.path().join("missing.db"),
                "https://example.com",
                "owner"
            )
            .is_err()
        );
    }

    #[test]
    fn unknown_or_foreign_ceremonies_are_rejected() {
        let (_dir, path) = database("example.com");
        let passkey = PasskeyAuth::open(&path, "https://example.com", "owner").expect("open");
        assert!(matches!(
            passkey.finish("missing", "browser", serde_json::json!({})),
            Err(AppError::Unauthenticated)
        ));
    }

    /// A software P-256 authenticator whose credential is stored exactly the way
    /// bookmarkd stores it, proving a copied database signs in here.
    struct SoftAuthenticator {
        key: openssl::ec::EcKey<openssl::pkey::Private>,
        credential_id: Vec<u8>,
        user_handle: Vec<u8>,
        rp_id: String,
    }

    impl SoftAuthenticator {
        fn register(path: &Path, rp_id: &str) -> Self {
            use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
            use openssl::{bn::BigNumContext, ec::EcGroup, nid::Nid};
            use webauthn_rs_core::proto::*;
            let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
            let key = openssl::ec::EcKey::generate(&group).unwrap();
            let (mut x, mut y) = (
                openssl::bn::BigNum::new().unwrap(),
                openssl::bn::BigNum::new().unwrap(),
            );
            key.public_key()
                .affine_coordinates(&group, &mut x, &mut y, &mut BigNumContext::new().unwrap())
                .unwrap();
            let credential_id = b"soft-authenticator-credential".to_vec();
            let credential: Credential = CredentialV3 {
                cred_id: credential_id.clone(),
                cred: COSEKey {
                    type_: COSEAlgorithm::ES256,
                    key: COSEKeyType::EC_EC2(COSEEC2Key {
                        curve: ECDSACurve::SECP256R1,
                        x: x.to_vec_padded(32).unwrap().into(),
                        y: y.to_vec_padded(32).unwrap().into(),
                    }),
                },
                counter: 0,
                verified: true,
                registration_policy: UserVerificationPolicy::Required,
            }
            .into();
            let db = rusqlite::Connection::open(path).unwrap();
            db.execute(
                "INSERT INTO credentials(id,name,data) VALUES(?1,'Soft key',?2)",
                rusqlite::params![
                    B64.encode(&credential_id),
                    serde_json::to_string(&credential).unwrap()
                ],
            )
            .unwrap();
            let user_id: String = db
                .query_row("SELECT user_id FROM identity", [], |row| row.get(0))
                .unwrap();
            Self {
                key,
                credential_id,
                user_handle: B64.decode(user_id).unwrap(),
                rp_id: rp_id.into(),
            }
        }

        fn assert(&self, options: &Value, origin: &str, counter: u32) -> Value {
            use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
            use sha2::{Digest, Sha256};
            let challenge = options["publicKey"]["challenge"].as_str().unwrap();
            let client_data = serde_json::to_vec(&serde_json::json!({
                "type": "webauthn.get", "challenge": challenge, "origin": origin, "crossOrigin": false
            }))
            .unwrap();
            let mut authenticator_data = Sha256::digest(self.rp_id.as_bytes()).to_vec();
            authenticator_data.push(0x01 | 0x04); // user present + user verified
            authenticator_data.extend_from_slice(&counter.to_be_bytes());
            let mut signed = authenticator_data.clone();
            signed.extend_from_slice(&Sha256::digest(&client_data));
            let signature = openssl::ecdsa::EcdsaSig::sign(&Sha256::digest(&signed), &self.key)
                .unwrap()
                .to_der()
                .unwrap();
            serde_json::json!({
                "id": B64.encode(&self.credential_id),
                "rawId": B64.encode(&self.credential_id),
                "type": "public-key",
                "extensions": {},
                "response": {
                    "authenticatorData": B64.encode(&authenticator_data),
                    "clientDataJSON": B64.encode(&client_data),
                    "signature": B64.encode(&signature),
                    "userHandle": B64.encode(&self.user_handle),
                }
            })
        }
    }

    #[test]
    fn credential_from_a_shared_database_signs_in_once_per_ceremony() {
        let (_dir, path) = database("example.com");
        let authenticator = SoftAuthenticator::register(&path, "example.com");
        let origin = "https://notes.example.com";
        let passkey = PasskeyAuth::open(&path, origin, "owner").expect("open");

        let options = passkey.begin("browser").expect("begin");
        let id = options["ceremonyId"].as_str().unwrap().to_owned();
        let response = authenticator.assert(&options, origin, 7);
        // Another browser cannot complete this browser's ceremony.
        assert!(passkey.finish(&id, "other", response.clone()).is_err());

        let options = passkey.begin("browser").expect("begin");
        let id = options["ceremonyId"].as_str().unwrap().to_owned();
        let response = authenticator.assert(&options, origin, 7);
        passkey
            .finish(&id, "browser", response.clone())
            .expect("valid assertion");
        assert!(matches!(
            passkey.finish(&id, "browser", response),
            Err(AppError::Unauthenticated)
        ));
        let stored = passkey.credentials().unwrap();
        assert_eq!(stored[0].data["counter"], 7);
        assert_eq!(stored[0].version, 2);
        assert!(passkey.is_active(&stored[0].id));
        assert!(!passkey.is_active("unknown"));

        // An assertion made for another site under the same RP ID is rejected.
        let options = passkey.begin("browser").expect("begin");
        let id = options["ceremonyId"].as_str().unwrap().to_owned();
        let foreign = authenticator.assert(&options, "https://bookmarks.example.com", 8);
        assert!(passkey.finish(&id, "browser", foreign).is_err());
    }
}
