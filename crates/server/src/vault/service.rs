use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{SeekFrom, Write},
    path::Path,
    sync::Arc,
    time::UNIX_EPOCH,
};

use atomic_write_file::AtomicWriteFile;
use sha2::{Digest, Sha256};
use tokio::io::AsyncSeekExt;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    error::{AppError, AppResult},
    security::sandbox::VaultSandbox,
    vault::models::*,
};

#[derive(Clone)]
pub struct VaultService {
    sandbox: Arc<VaultSandbox>,
    read_only: bool,
    markdown_limit: u64,
    write_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

pub struct Asset {
    pub file: tokio::fs::File,
    pub size: u64,
    pub start: u64,
    pub length: u64,
    pub mime: String,
    pub partial: bool,
}

impl VaultService {
    pub fn new(sandbox: VaultSandbox, read_only: bool, markdown_limit: u64) -> Self {
        Self {
            sandbox: Arc::new(sandbox),
            read_only,
            markdown_limit,
            write_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn sandbox(&self) -> &VaultSandbox {
        &self.sandbox
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }

    pub async fn tree(&self) -> AppResult<TreeResponse> {
        let sandbox = self.sandbox.clone();
        tokio::task::spawn_blocking(move || {
            let entries = read_tree(sandbox.root(), sandbox.root(), &sandbox)?;
            Ok(TreeResponse { entries })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn read_markdown(&self, relative: String) -> AppResult<FileResponse> {
        let sandbox = self.sandbox.clone();
        let limit = self.markdown_limit;
        tokio::task::spawn_blocking(move || {
            ensure_markdown(&relative)?;
            let path = sandbox.resolve_existing(&relative)?;
            let metadata = fs::metadata(&path)?;
            if metadata.len() > limit {
                return Err(AppError::TooLarge);
            }
            let bytes = fs::read(&path)?;
            let content =
                String::from_utf8(bytes.clone()).map_err(|_| AppError::UnsupportedEncoding)?;
            Ok(FileResponse {
                path: relative,
                content,
                revision: revision(&metadata, &bytes),
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn save_markdown(&self, request: SaveFileRequest) -> AppResult<SaveFileResponse> {
        self.ensure_writable()?;
        if request.content.len() as u64 > self.markdown_limit {
            return Err(AppError::TooLarge);
        }
        let _guard = self.lock_paths([request.path.as_str()]).await;
        let sandbox = self.sandbox.clone();
        tokio::task::spawn_blocking(move || {
            ensure_markdown(&request.path)?;
            let path = sandbox.resolve_existing(&request.path)?;
            let current = fs::read(&path)?;
            let current_hash = content_hash(&current);
            if !request.force && current_hash != request.base_revision.hash {
                return Err(AppError::RevisionConflict { current_hash });
            }
            atomic_replace(&path, request.content.as_bytes())?;
            let metadata = fs::metadata(&path)?;
            let bytes = request.content.into_bytes();
            Ok(SaveFileResponse {
                path: request.path,
                revision: revision(&metadata, &bytes),
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn create_file(&self, request: CreateFileRequest) -> AppResult<SaveFileResponse> {
        self.ensure_writable()?;
        ensure_markdown(&request.path)?;
        if request.content.len() as u64 > self.markdown_limit {
            return Err(AppError::TooLarge);
        }
        let _guard = self.lock_paths([request.path.as_str()]).await;
        let sandbox = self.sandbox.clone();
        tokio::task::spawn_blocking(move || {
            let path = sandbox.resolve_new(&request.path)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(map_already_exists)?;
            file.write_all(request.content.as_bytes())?;
            file.sync_all()?;
            let metadata = file.metadata()?;
            Ok(SaveFileResponse {
                path: request.path,
                revision: revision(&metadata, request.content.as_bytes()),
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn create_directory(&self, relative: String) -> AppResult<PathResponse> {
        self.ensure_writable()?;
        let _guard = self.lock_paths([relative.as_str()]).await;
        let sandbox = self.sandbox.clone();
        let response_path = relative.clone();
        tokio::task::spawn_blocking(move || {
            let path = sandbox.resolve_new(&relative)?;
            fs::create_dir(&path).map_err(map_already_exists)?;
            Ok(PathResponse {
                path: response_path,
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn change_path(&self, old: String, new: String) -> AppResult<PathResponse> {
        self.ensure_writable()?;
        let _guards = self.lock_paths([old.as_str(), new.as_str()]).await;
        let sandbox = self.sandbox.clone();
        let response_path = new.clone();
        tokio::task::spawn_blocking(move || {
            let source = sandbox.resolve_existing(&old)?;
            let destination = sandbox.resolve_new(&new)?;
            if destination.exists() {
                return Err(AppError::InvalidRequest(
                    "destination already exists".into(),
                ));
            }
            fs::rename(source, destination)?;
            Ok(PathResponse {
                path: response_path,
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn delete(&self, relative: String) -> AppResult<DeleteResponse> {
        self.ensure_writable()?;
        let _guard = self.lock_paths([relative.as_str()]).await;
        let sandbox = self.sandbox.clone();
        let response_path = relative.clone();
        tokio::task::spawn_blocking(move || {
            let source = sandbox.resolve_existing(&relative)?;
            if source == sandbox.root() {
                return Err(AppError::ForbiddenPath);
            }
            let trash = sandbox.root().join(".trash");
            fs::create_dir_all(&trash)?;
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or(AppError::ForbiddenPath)?;
            let destination = trash.join(format!("{}-{name}", uuid::Uuid::new_v4()));
            fs::rename(source, destination)?;
            Ok(DeleteResponse {
                path: response_path,
                recoverable: true,
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    }

    pub async fn open_asset(
        &self,
        relative: String,
        range: Option<(u64, Option<u64>)>,
    ) -> AppResult<Asset> {
        let sandbox = self.sandbox.clone();
        let path = tokio::task::spawn_blocking(move || sandbox.resolve_existing(&relative))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))??;
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            return Err(AppError::Forbidden);
        }
        let mut file = tokio::fs::File::open(&path).await?;
        let size = file.metadata().await?.len();
        let (start, end, partial) = match range {
            Some((start, end)) if start < size => {
                (start, end.unwrap_or(size - 1).min(size - 1), true)
            }
            Some(_) => return Err(AppError::InvalidRequest("invalid range".into())),
            None => (0, size.saturating_sub(1), false),
        };
        if start > 0 {
            file.seek(SeekFrom::Start(start)).await?;
        }
        let length = if size == 0 { 0 } else { end - start + 1 };
        let mime = mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string();
        Ok(Asset {
            file,
            size,
            start,
            length,
            mime,
            partial,
        })
    }

    fn ensure_writable(&self) -> AppResult<()> {
        if self.read_only {
            Err(AppError::Forbidden)
        } else {
            Ok(())
        }
    }

    async fn lock_paths<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Vec<OwnedMutexGuard<()>> {
        let mut paths = paths.into_iter().map(str::to_owned).collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        let locks = {
            let mut registry = self.write_locks.lock().await;
            paths
                .into_iter()
                .map(|path| registry.entry(path).or_default().clone())
                .collect::<Vec<_>>()
        };
        let mut guards = Vec::with_capacity(locks.len());
        for lock in locks {
            guards.push(lock.lock_owned().await);
        }
        guards
    }
}

fn read_tree(directory: &Path, root: &Path, sandbox: &VaultSandbox) -> AppResult<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    for result in fs::read_dir(directory)? {
        let entry = result?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| AppError::ForbiddenPath)?;
        if !sandbox.is_visible_relative(relative) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let display = sandbox.relative_display(&path)?;
        if metadata.is_dir() {
            entries.push(TreeEntry {
                name,
                path: display,
                kind: EntryKind::Directory,
                children: Some(read_tree(&path, root, sandbox)?),
            });
        } else if metadata.is_file() {
            let kind = if path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                EntryKind::Markdown
            } else {
                EntryKind::Asset
            };
            entries.push(TreeEntry {
                name,
                path: display,
                kind,
                children: None,
            });
        }
    }
    entries.sort_by(|a, b| {
        matches!(b.kind, EntryKind::Directory)
            .cmp(&matches!(a.kind, EntryKind::Directory))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

pub fn content_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn revision(metadata: &fs::Metadata, bytes: &[u8]) -> Revision {
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64);
    Revision {
        mtime_ms,
        hash: content_hash(bytes),
    }
}

fn ensure_markdown(path: &str) -> AppResult<()> {
    if Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        Ok(())
    } else {
        Err(AppError::InvalidRequest(
            "only Markdown files are editable".into(),
        ))
    }
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> AppResult<()> {
    atomic_replace_with(path, |file| {
        file.write_all(bytes)?;
        Ok(())
    })
}

fn atomic_replace_with(
    path: &Path,
    write: impl FnOnce(&mut AtomicWriteFile) -> AppResult<()>,
) -> AppResult<()> {
    let parent = path.parent().ok_or(AppError::ForbiddenPath)?;
    let permissions = fs::metadata(path)?.permissions();
    let mut temp = AtomicWriteFile::open(path)?;
    temp.set_permissions(permissions)?;
    write(&mut temp)?;
    temp.flush()?;
    temp.sync_all()?;
    temp.commit()?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn map_already_exists(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        AppError::InvalidRequest("resource already exists".into())
    } else {
        AppError::Io(error)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn detects_conflicts_and_preserves_external_content() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("A.md"), "one").expect("fixture");
        let service = VaultService::new(
            VaultSandbox::new(dir.path(), false).expect("sandbox"),
            false,
            1024,
        );
        let opened = service.read_markdown("A.md".into()).await.expect("read");
        fs::write(dir.path().join("A.md"), "external").expect("external change");
        let result = service
            .save_markdown(SaveFileRequest {
                path: "A.md".into(),
                content: "web".into(),
                base_revision: BaseRevision {
                    hash: opened.revision.hash,
                },
                force: false,
            })
            .await;
        assert!(matches!(result, Err(AppError::RevisionConflict { .. })));
        assert_eq!(
            fs::read_to_string(dir.path().join("A.md")).expect("content"),
            "external"
        );
    }

    #[tokio::test]
    async fn concurrent_saves_from_same_revision_cannot_both_win() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("A.md"), "one").expect("fixture");
        let service = VaultService::new(
            VaultSandbox::new(dir.path(), false).expect("sandbox"),
            false,
            1024,
        );
        let opened = service.read_markdown("A.md".into()).await.expect("read");
        let request = |content: &str| SaveFileRequest {
            path: "A.md".into(),
            content: content.into(),
            base_revision: BaseRevision {
                hash: opened.revision.hash.clone(),
            },
            force: false,
        };
        let (first, second) = tokio::join!(
            service.save_markdown(request("first")),
            service.save_markdown(request("second"))
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(
            usize::from(matches!(first, Err(AppError::RevisionConflict { .. })))
                + usize::from(matches!(second, Err(AppError::RevisionConflict { .. }))),
            1
        );
    }

    #[tokio::test]
    async fn read_only_is_enforced_by_service() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("A.md"), "one").expect("fixture");
        let service = VaultService::new(
            VaultSandbox::new(dir.path(), false).expect("sandbox"),
            true,
            1024,
        );
        let result = service
            .create_file(CreateFileRequest {
                path: "B.md".into(),
                content: String::new(),
            })
            .await;
        assert!(matches!(result, Err(AppError::Forbidden)));
    }

    #[test]
    fn atomic_replace_updates_complete_file() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("A.md");
        fs::write(&path, "old").expect("fixture");
        atomic_replace(&path, b"complete new content").expect("replace");
        assert_eq!(fs::read(&path).expect("read"), b"complete new content");
    }

    #[test]
    fn failed_atomic_write_preserves_original() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("A.md");
        fs::write(&path, "original").expect("fixture");
        let result = atomic_replace_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(AppError::Internal("simulated failure".into()))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).expect("read"), b"original");
    }
}
