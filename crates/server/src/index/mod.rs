pub mod model;
pub mod parser;

use std::{collections::BTreeMap, fs, path::Path, time::Instant};

use serde::Serialize;
use walkdir::WalkDir;

use crate::{
    error::{AppError, AppResult},
    security::sandbox::VaultSandbox,
};
use model::{IndexedDocument, WikiLink};

#[derive(Default)]
pub struct VaultIndex {
    documents: BTreeMap<String, IndexedDocument>,
}

#[derive(Debug, Serialize)]
pub struct IndexStats {
    pub files: usize,
    pub markdown: usize,
    pub attachments: usize,
    #[serde(rename = "buildMs")]
    pub build_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub score: f32,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub line: usize,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ResolveResponse {
    Resolved { path: String },
    Ambiguous { candidates: Vec<String> },
    Unresolved,
}

#[derive(Debug, Serialize)]
pub struct BacklinksResponse {
    pub items: Vec<BacklinkItem>,
}

#[derive(Debug, Serialize)]
pub struct BacklinkItem {
    pub path: String,
    pub references: Vec<BacklinkReference>,
}

#[derive(Debug, Serialize)]
pub struct BacklinkReference {
    pub line: usize,
    pub context: String,
}

impl VaultIndex {
    pub fn build(sandbox: &VaultSandbox) -> AppResult<(Self, IndexStats)> {
        let started = Instant::now();
        let mut index = Self::default();
        let mut files = 0;
        let mut attachments = 0;
        let walker = WalkDir::new(sandbox.root())
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.path() == sandbox.root()
                    || entry
                        .path()
                        .strip_prefix(sandbox.root())
                        .is_ok_and(|relative| sandbox.is_visible_relative(relative))
            });
        for result in walker {
            let entry = result.map_err(|error| AppError::Internal(error.to_string()))?;
            if entry.path() == sandbox.root() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(sandbox.root())
                .map_err(|_| AppError::ForbiddenPath)?;
            if !sandbox.is_visible_relative(relative) {
                if entry.file_type().is_dir() { /* WalkDir filtering is handled by visibility below. */
                }
                continue;
            }
            if entry.file_type().is_symlink() || !entry.file_type().is_file() {
                continue;
            }
            files += 1;
            if is_markdown(entry.path()) {
                let bytes = fs::read(entry.path())?;
                if let Ok(content) = String::from_utf8(bytes) {
                    let path = display_relative(relative);
                    let metadata = entry
                        .metadata()
                        .map_err(|error| AppError::Internal(error.to_string()))?;
                    index.documents.insert(
                        path.clone(),
                        parser::parse_document(path, content, &metadata),
                    );
                }
            } else {
                attachments += 1;
            }
        }
        let markdown = index.documents.len();
        Ok((
            index,
            IndexStats {
                files,
                markdown,
                attachments,
                build_ms: started.elapsed().as_millis(),
            },
        ))
    }

    pub fn search(&self, query: &str) -> AppResult<SearchResponse> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(SearchResponse {
                results: Vec::new(),
            });
        }
        if query.chars().count() > 200 {
            return Err(AppError::InvalidRequest("search query is too long".into()));
        }
        let needle = query.to_lowercase();
        let mut results = Vec::new();
        for document in self.documents.values() {
            let mut score = 0.0_f32;
            if document.stem.to_lowercase() == needle {
                score += 1.0;
            } else if document.filename.to_lowercase().contains(&needle) {
                score += 0.65;
            }
            if document.path.to_lowercase().contains(&needle) {
                score += 0.35;
            }
            let mut matches = Vec::new();
            for (index, line) in document.content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    score += 0.2;
                    if matches.len() < 3 {
                        matches.push(SearchMatch {
                            line: index + 1,
                            snippet: bounded_context(line, 180),
                        });
                    }
                }
            }
            if score > 0.0 {
                results.push(SearchResult {
                    path: document.path.clone(),
                    score: score.min(1.0),
                    matches,
                });
            }
        }
        results.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.path.cmp(&b.path))
        });
        results.truncate(50);
        Ok(SearchResponse { results })
    }

    pub fn resolve(&self, link: &str, source: Option<&str>) -> ResolveResponse {
        let target = link
            .split('#')
            .next()
            .unwrap_or(link)
            .trim()
            .trim_end_matches(".md");
        let normalized_target = target.replace('\\', "/");
        let source_directory = source
            .and_then(|value| Path::new(value).parent())
            .unwrap_or_else(|| Path::new(""));
        let relative_candidate =
            display_relative(&source_directory.join(format!("{normalized_target}.md")));

        let mut exact_path = Vec::new();
        let mut stem_or_alias = Vec::new();
        for document in self.documents.values() {
            let without_extension = document.path.strip_suffix(".md").unwrap_or(&document.path);
            if without_extension.eq_ignore_ascii_case(&normalized_target)
                || document
                    .path
                    .eq_ignore_ascii_case(&format!("{normalized_target}.md"))
                || document.path.eq_ignore_ascii_case(&relative_candidate)
            {
                exact_path.push(document.path.clone());
            } else if document.stem.eq_ignore_ascii_case(&normalized_target)
                || document
                    .aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(&normalized_target))
            {
                stem_or_alias.push(document.path.clone());
            }
        }
        let mut candidates = if exact_path.is_empty() {
            stem_or_alias
        } else {
            exact_path
        };
        candidates.sort();
        candidates.dedup();
        match candidates.len() {
            0 => ResolveResponse::Unresolved,
            1 => ResolveResponse::Resolved {
                path: candidates.remove(0),
            },
            _ => ResolveResponse::Ambiguous { candidates },
        }
    }

    pub fn backlinks(&self, target: &str) -> BacklinksResponse {
        let mut items = Vec::new();
        for document in self.documents.values() {
            let references = document
                .links
                .iter()
                .filter_map(
                    |link| match self.resolve(&link.target, Some(&document.path)) {
                        ResolveResponse::Resolved { path } if path.eq_ignore_ascii_case(target) => {
                            Some(BacklinkReference {
                                line: link.line,
                                context: document
                                    .content
                                    .lines()
                                    .nth(link.line.saturating_sub(1))
                                    .map(|line| bounded_context(line, 180))
                                    .unwrap_or_default(),
                            })
                        }
                        _ => None,
                    },
                )
                .collect::<Vec<_>>();
            if !references.is_empty() {
                items.push(BacklinkItem {
                    path: document.path.clone(),
                    references,
                });
            }
        }
        BacklinksResponse { items }
    }

    pub fn document(&self, path: &str) -> Option<&IndexedDocument> {
        self.documents.get(path)
    }
    pub fn len(&self) -> usize {
        self.documents.len()
    }
    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn display_relative(path: &Path) -> String {
    path.components()
        .map(|value| value.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn bounded_context(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let result = chars.by_ref().take(max).collect::<String>();
    if chars.next().is_some() {
        format!("{result}…")
    } else {
        result
    }
}

pub fn link_without_display(link: &WikiLink) -> &str {
    &link.target
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::security::sandbox::VaultSandbox;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn resolves_aliases_and_reports_ambiguity() {
        let dir = tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("A")).expect("A");
        fs::create_dir_all(dir.path().join("B")).expect("B");
        fs::write(
            dir.path().join("A/Rust.md"),
            "---\naliases: [Rust Language]\n---\n# Rust",
        )
        .expect("note");
        fs::write(dir.path().join("B/Rust.md"), "# Other").expect("note");
        let sandbox = VaultSandbox::new(dir.path(), false).expect("sandbox");
        let (index, _) = VaultIndex::build(&sandbox).expect("index");
        assert!(matches!(
            index.resolve("Rust", None),
            ResolveResponse::Ambiguous { .. }
        ));
        assert!(matches!(
            index.resolve("Rust Language", None),
            ResolveResponse::Resolved { .. }
        ));
        assert!(matches!(
            index.resolve("A/Rust", None),
            ResolveResponse::Resolved { .. }
        ));
    }
}
