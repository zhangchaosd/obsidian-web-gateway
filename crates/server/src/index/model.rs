use serde::Serialize;

#[derive(Debug, Clone)]
pub struct IndexedDocument {
    pub path: String,
    pub filename: String,
    pub stem: String,
    pub title: Option<String>,
    pub aliases: Vec<String>,
    pub headings: Vec<Heading>,
    pub tags: Vec<String>,
    pub links: Vec<WikiLink>,
    pub embeds: Vec<WikiLink>,
    pub modified_at_ms: u64,
    pub size: u64,
    pub content_hash: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub slug: String,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct WikiLink {
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub line: usize,
    pub embed: bool,
}
