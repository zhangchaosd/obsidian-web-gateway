use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub mtime_ms: u64,
    pub hash: String,
}

#[derive(Debug, Serialize)]
pub struct FileResponse {
    pub path: String,
    pub content: String,
    pub revision: Revision,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileRequest {
    pub path: String,
    pub content: String,
    pub base_revision: BaseRevision,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
pub struct BaseRevision {
    pub hash: String,
}

#[derive(Debug, Serialize)]
pub struct SaveFileResponse {
    pub path: String,
    pub revision: Revision,
}

#[derive(Debug, Serialize)]
pub struct TreeResponse {
    pub entries: Vec<TreeEntry>,
}

#[derive(Debug, Serialize)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Directory,
    Markdown,
    Asset,
}

#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    pub path: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateDirectoryRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePathRequest {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Serialize)]
pub struct PathResponse {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub path: String,
    pub recoverable: bool,
}
