use std::{fs::Metadata, path::Path, time::UNIX_EPOCH};

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde_yaml::Value;

use crate::{
    index::model::{Heading, IndexedDocument, WikiLink},
    vault::service::content_hash,
};

pub fn parse_document(path: String, content: String, metadata: &Metadata) -> IndexedDocument {
    let file_path = Path::new(&path);
    let filename = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&path)
        .to_owned();
    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(&filename)
        .to_owned();
    let (title, aliases, tags) = parse_frontmatter(&content);
    let (headings, links, embeds) = parse_markdown(&content);
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64);
    IndexedDocument {
        path,
        filename,
        stem,
        title,
        aliases,
        headings,
        tags,
        links,
        embeds,
        modified_at_ms,
        size: metadata.len(),
        content_hash: content_hash(content.as_bytes()),
        content,
    }
}

fn parse_frontmatter(content: &str) -> (Option<String>, Vec<String>, Vec<String>) {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (None, Vec::new(), Vec::new());
    }
    let normalized = content.replace("\r\n", "\n");
    let Some(end) = normalized[4..].find("\n---\n") else {
        return (None, Vec::new(), Vec::new());
    };
    let yaml = &normalized[4..4 + end];
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(yaml) else {
        return (None, Vec::new(), Vec::new());
    };
    let title = map
        .get(Value::String("title".into()))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let aliases = yaml_strings(map.get(Value::String("aliases".into())));
    let tags = yaml_strings(map.get(Value::String("tags".into())));
    (title, aliases, tags)
}

fn yaml_strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Sequence(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_markdown(content: &str) -> (Vec<Heading>, Vec<WikiLink>, Vec<WikiLink>) {
    let parser = Parser::new_ext(content, Options::all()).into_offset_iter();
    let mut headings = Vec::new();
    let mut heading_level = None;
    let mut heading_text = String::new();
    let mut heading_line = 0;
    let mut code_depth = 0_u32;

    for (event, range) in parser {
        match event {
            Event::Start(Tag::CodeBlock(_)) => code_depth += 1,
            Event::End(TagEnd::CodeBlock) => code_depth = code_depth.saturating_sub(1),
            Event::Start(Tag::Heading { level, .. }) => {
                heading_level = Some(level);
                heading_text.clear();
                heading_line = line_at(content, range.start);
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = heading_level.take() {
                    headings.push(Heading {
                        level: heading_number(level),
                        text: heading_text.clone(),
                        slug: slugify(&heading_text),
                        line: heading_line,
                    });
                }
            }
            Event::Text(text) if code_depth == 0 => {
                if heading_level.is_some() {
                    heading_text.push_str(&text);
                }
            }
            Event::Code(text) if heading_level.is_some() => heading_text.push_str(&text),
            _ => {}
        }
    }
    let links = extract_links_from_source(content);
    let embeds = links.iter().filter(|link| link.embed).cloned().collect();
    (headings, links, embeds)
}

fn extract_links_from_source(content: &str) -> Vec<WikiLink> {
    let mut result = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut frontmatter = content.starts_with("---\n") || content.starts_with("---\r\n");
    for (line_index, line) in content.lines().enumerate() {
        let line_number = line_index + 1;
        let trimmed = line.trim_start();
        if frontmatter {
            if line_number > 1 && trimmed == "---" {
                frontmatter = false;
            }
            continue;
        }
        if let Some((marker, count)) = fence {
            if marker_run(trimmed.as_bytes(), marker) >= count {
                fence = None;
            }
            continue;
        }
        let bytes = trimmed.as_bytes();
        for marker in *b"`~" {
            let count = marker_run(bytes, marker);
            if count >= 3 {
                fence = Some((marker, count));
                break;
            }
        }
        if fence.is_some() {
            continue;
        }
        let visible = mask_inline_code(line);
        result.extend(extract_wiki_links(&visible, line_number));
    }
    result
}

fn marker_run(bytes: &[u8], marker: u8) -> usize {
    bytes.iter().take_while(|byte| **byte == marker).count()
}

fn mask_inline_code(line: &str) -> String {
    let mut bytes = line.as_bytes().to_vec();
    let mut index = 0;
    let mut delimiter = 0;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let count = marker_run(&bytes[index..], b'`');
            if delimiter == 0 {
                delimiter = count;
            } else if delimiter == count {
                delimiter = 0;
            }
            bytes[index..index + count].fill(b' ');
            index += count;
        } else {
            if delimiter > 0 {
                bytes[index] = b' ';
            }
            index += 1;
        }
    }
    String::from_utf8(bytes).unwrap_or_default()
}

fn extract_wiki_links(text: &str, base_line: usize) -> Vec<WikiLink> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index + 3 < bytes.len() {
        let embed = bytes[index] == b'!'
            && bytes.get(index + 1) == Some(&b'[')
            && bytes.get(index + 2) == Some(&b'[');
        let open = if embed { index + 1 } else { index };
        if bytes.get(open) != Some(&b'[') || bytes.get(open + 1) != Some(&b'[') {
            index += 1;
            continue;
        }
        if open > 0 && bytes[open - 1] == b'\\' {
            index = open + 2;
            continue;
        }
        let Some(relative_end) = text[open + 2..].find("]]") else {
            break;
        };
        let end = open + 2 + relative_end;
        let inner = &text[open + 2..end];
        if !inner.trim().is_empty() {
            let (destination, alias) = inner
                .split_once('|')
                .map_or((inner, None), |(left, right)| {
                    (left, Some(right.trim().to_owned()))
                });
            let (target, heading) = destination
                .split_once('#')
                .map_or((destination, None), |(left, right)| {
                    (left, Some(right.trim().to_owned()))
                });
            if !target.trim().is_empty() {
                let line = base_line + text[..open].bytes().filter(|value| *value == b'\n').count();
                result.push(WikiLink {
                    target: target.trim().to_owned(),
                    heading,
                    alias,
                    line,
                    embed,
                });
            }
        }
        index = end + 2;
    }
    result
}

fn line_at(content: &str, offset: usize) -> usize {
    content[..offset.min(content.len())]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}

fn heading_number(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn slugify(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn parses_frontmatter_headings_and_real_wiki_links() {
        let dir = tempdir().expect("temp");
        let path = dir.path().join("A.md");
        fs::write(&path, "fixture").expect("fixture");
        let content = "---\ntitle: Note\naliases: [Alias]\ntags:\n  - rust\n---\n# Hello World\n[[Real#Part|Label]]\n`[[Inline Code]]`\n```md\n[[Fenced]]\n```\n![[image.png]]".to_owned();
        let document = parse_document(
            "A.md".into(),
            content,
            &fs::metadata(path).expect("metadata"),
        );
        assert_eq!(document.title.as_deref(), Some("Note"));
        assert_eq!(document.headings[0].slug, "hello-world");
        assert_eq!(document.links.len(), 2);
        assert_eq!(document.links[0].target, "Real");
        assert_eq!(document.embeds[0].target, "image.png");
    }
}
