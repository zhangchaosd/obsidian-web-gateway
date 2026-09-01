use std::{
    ffi::OsStr,
    path::{Component, Path, PathBuf},
};

use percent_encoding::percent_decode_str;

use crate::error::{AppError, AppResult};

const ALWAYS_HIDDEN: &[&str] = &[".git", ".obsidian", ".trash"];

#[derive(Clone, Debug)]
pub struct VaultSandbox {
    root: PathBuf,
    show_hidden_files: bool,
}

impl VaultSandbox {
    pub fn new(root: impl AsRef<Path>, show_hidden_files: bool) -> AppResult<Self> {
        let root = std::fs::canonicalize(root.as_ref()).map_err(AppError::Io)?;
        if !root.is_dir() {
            return Err(AppError::InvalidRequest("vault must be a directory".into()));
        }
        Ok(Self {
            root,
            show_hidden_files,
        })
    }

    pub fn vault_name(&self) -> String {
        self.root
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("Vault")
            .to_owned()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve_existing(&self, input: &str) -> AppResult<PathBuf> {
        let relative = self.parse(input, false)?;
        let candidate = self.root.join(relative);
        self.reject_symlink_components(&candidate)?;
        let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound
            } else {
                AppError::Io(error)
            }
        })?;
        self.ensure_inside(&canonical)?;
        Ok(canonical)
    }

    pub fn resolve_new(&self, input: &str) -> AppResult<PathBuf> {
        let relative = self.parse(input, false)?;
        let candidate = self.root.join(relative);
        let parent = candidate.parent().ok_or(AppError::ForbiddenPath)?;
        self.reject_symlink_components(parent)?;
        let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound
            } else {
                AppError::Io(error)
            }
        })?;
        self.ensure_inside(&canonical_parent)?;
        let name = candidate.file_name().ok_or(AppError::ForbiddenPath)?;
        Ok(canonical_parent.join(name))
    }

    pub fn relative_display(&self, path: &Path) -> AppResult<String> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| AppError::ForbiddenPath)?;
        relative
            .components()
            .map(|part| part.as_os_str().to_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.join("/"))
            .ok_or(AppError::ForbiddenPath)
    }

    pub fn is_visible_relative(&self, relative: &Path) -> bool {
        relative.components().all(|component| {
            component.as_os_str().to_str().is_some_and(|name| {
                !ALWAYS_HIDDEN.contains(&name) && (self.show_hidden_files || !name.starts_with('.'))
            })
        })
    }

    fn parse(&self, input: &str, allow_empty: bool) -> AppResult<PathBuf> {
        if input.is_empty() {
            return if allow_empty {
                Ok(PathBuf::new())
            } else {
                Err(AppError::ForbiddenPath)
            };
        }
        if input.len() > 4096 || input.contains('\0') {
            return Err(AppError::ForbiddenPath);
        }

        let mut decoded = input.to_owned();
        for _ in 0..3 {
            let next = percent_decode_str(&decoded)
                .decode_utf8()
                .map_err(|_| AppError::ForbiddenPath)?
                .into_owned();
            if next == decoded {
                break;
            }
            decoded = next;
        }
        if decoded.contains('%')
            || decoded.contains('\\')
            || decoded.starts_with('/')
            || decoded.starts_with("//")
            || has_windows_prefix(&decoded)
        {
            return Err(AppError::ForbiddenPath);
        }

        let path = Path::new(&decoded);
        let mut clean = PathBuf::new();
        for component in path.components() {
            match component {
                Component::Normal(value) => {
                    let name = value.to_string_lossy();
                    if name.is_empty()
                        || name == "."
                        || name == ".."
                        || name.contains(':')
                        || name.ends_with('.')
                        || name.ends_with(' ')
                        || is_windows_device_name(&name)
                        || is_hidden_forbidden(&name, self.show_hidden_files)
                    {
                        return Err(AppError::ForbiddenPath);
                    }
                    clean.push(value);
                }
                _ => return Err(AppError::ForbiddenPath),
            }
        }
        if clean.as_os_str().is_empty() && !allow_empty {
            return Err(AppError::ForbiddenPath);
        }
        Ok(clean)
    }

    fn reject_symlink_components(&self, candidate: &Path) -> AppResult<()> {
        let relative = candidate
            .strip_prefix(&self.root)
            .map_err(|_| AppError::ForbiddenPath)?;
        let mut current = self.root.clone();
        for component in relative.components() {
            current.push(component);
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(AppError::ForbiddenPath);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => return Err(AppError::Io(error)),
            }
        }
        Ok(())
    }

    fn ensure_inside(&self, path: &Path) -> AppResult<()> {
        if path == self.root || path.starts_with(&self.root) {
            Ok(())
        } else {
            Err(AppError::ForbiddenPath)
        }
    }
}

fn has_windows_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_hidden_forbidden(name: &str, show_hidden_files: bool) -> bool {
    ALWAYS_HIDDEN.contains(&name) || (!show_hidden_files && name.starts_with('.'))
}

fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::fs;
    use tempfile::tempdir;

    use super::*;

    fn sandbox() -> (tempfile::TempDir, VaultSandbox) {
        let directory = tempdir().expect("temp dir");
        fs::create_dir(directory.path().join("Notes")).expect("notes dir");
        fs::write(directory.path().join("Notes/a.md"), "ok").expect("fixture");
        let sandbox = VaultSandbox::new(directory.path(), false).expect("sandbox");
        (directory, sandbox)
    }

    #[test]
    fn resolves_safe_relative_path() {
        let (_directory, sandbox) = sandbox();
        let resolved = sandbox.resolve_existing("Notes/a.md").expect("safe path");
        assert!(resolved.ends_with("Notes/a.md"));
    }

    #[test]
    fn rejects_traversal_and_platform_absolute_paths() {
        let (_directory, sandbox) = sandbox();
        for attack in [
            "../secret",
            "../../etc/passwd",
            "%2e%2e/secret",
            "%252e%252e%252fsecret",
            "..\\..\\Windows\\System32",
            "C:\\Windows\\System32",
            "/etc/passwd",
            "//server/share",
            "Notes/../a.md",
            "NUL.md",
            "COM1.txt",
            "Notes/file.md::$DATA",
            "Notes/trailing. ",
            ".git/config",
            ".obsidian/app.json",
        ] {
            assert!(
                sandbox.resolve_existing(attack).is_err(),
                "accepted {attack}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let (directory, sandbox) = sandbox();
        let outside = tempdir().expect("outside");
        fs::write(outside.path().join("secret"), "nope").expect("secret");
        symlink(outside.path(), directory.path().join("escape")).expect("symlink");
        assert!(matches!(
            sandbox.resolve_existing("escape/secret"),
            Err(AppError::ForbiddenPath)
        ));
    }

    #[test]
    fn validates_existing_parent_for_new_targets() {
        let (_directory, sandbox) = sandbox();
        assert!(sandbox.resolve_new("Notes/new.md").is_ok());
        assert!(sandbox.resolve_new("missing/new.md").is_err());
        assert!(sandbox.resolve_new("../new.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_paths_are_not_exposed() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        let (_directory, sandbox) = sandbox();
        let invalid = PathBuf::from(OsString::from_vec(b"bad\xff.md".to_vec()));
        assert!(!sandbox.is_visible_relative(&invalid));
    }
}
