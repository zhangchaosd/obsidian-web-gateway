import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

const imageExtensions = /\.(png|jpe?g|gif|webp|svg)$/i;

function wikiPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("link", "wiki_link", (state: StateInline, silent: boolean) => {
    const source = state.src;
    const embed = source.startsWith("![[", state.pos);
    const offset = embed ? 3 : 2;
    if (!embed && !source.startsWith("[[", state.pos)) return false;
    const end = source.indexOf("]]", state.pos + offset);
    if (end < 0) return false;
    const value = source.slice(state.pos + offset, end).trim();
    if (!value) return false;
    if (!silent) {
      const token = state.push(embed ? "wiki_embed" : "wiki_link", "", 0);
      token.content = value;
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, index) => {
    const [destination, label] = splitAlias(tokens[index].content);
    return `<button type="button" class="wiki-link" data-wiki="${md.utils.escapeHtml(destination)}">${md.utils.escapeHtml(label ?? destination)}</button>`;
  };
  md.renderer.rules.wiki_embed = (tokens, index) => {
    const [destination, label] = splitAlias(tokens[index].content);
    const asset = destination.split("#", 1)[0];
    if (!imageExtensions.test(asset)) {
      return `<button type="button" class="wiki-link" data-wiki="${md.utils.escapeHtml(destination)}">${md.utils.escapeHtml(label ?? destination)}</button>`;
    }
    return `<img src="/api/v1/asset?path=${encodeURIComponent(asset)}" alt="${md.utils.escapeHtml(label ?? asset)}" loading="lazy">`;
  };
}

function splitAlias(value: string): [string, string | undefined] {
  const index = value.indexOf("|");
  return index < 0 ? [value, undefined] : [value.slice(0, index).trim(), value.slice(index + 1).trim()];
}

export function renderMarkdown(markdown: string, sourcePath: string): string {
  const body = withoutFrontmatter(markdown);
  const offset = markdown.slice(0, markdown.length - body.length).split("\n").length - 1;
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });
  md.use(taskLists, { enabled: false, label: true });
  wikiPlugin(md);
  for (const rule of ["fence", "code_block"] as const) {
    const render = md.renderer.rules[rule]!;
    md.renderer.rules[rule] = (tokens, index, options, env, self) =>
      `<div class="code-block" data-source-start="${(tokens[index].map?.[0] ?? 0) + offset + 1}" data-source-end="${(tokens[index].map?.[1] ?? 1) + offset + 1}">${render(tokens, index, options, env, self)}<button type="button" class="code-copy" aria-label="Copy code" title="Copy code"><span class="copy-icon" aria-hidden="true"></span><span class="copy-label" aria-live="polite">Copy</span></button></div>`;
  }
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const srcIndex = token.attrIndex("src");
    if (srcIndex >= 0) {
      const src = token.attrs?.[srcIndex]?.[1] ?? "";
      if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("/")) {
        const directory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : "";
        token.attrSet("src", `/api/v1/asset?path=${encodeURIComponent(normalizePath(directory + src))}`);
      }
    }
    return defaultImage ? defaultImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };
  md.core.ruler.push("source_positions", state => {
    for (const token of state.tokens) {
      if (token.map && ["heading_open", "paragraph_open", "list_item_open", "table_open", "hr"].includes(token.type) && !token.hidden) {
        token.attrSet("data-source-start", String(token.map[0] + offset + 1));
        token.attrSet("data-source-end", String(token.map[1] + offset + 1));
      }
    }
  });
  md.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
    tokens[index].attrSet("data-line", String((tokens[index].map?.[0] ?? 0) + offset + 1));
    tokens[index].attrSet("tabindex", "-1");
    return self.renderToken(tokens, index, options);
  };
  return DOMPurify.sanitize(md.render(body), {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "style"],
    FORBID_ATTR: ["style", "onerror", "onload"],
    ALLOW_DATA_ATTR: true
  });
}

function withoutFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return markdown;
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

export function getOutline(markdown: string): { level: number; text: string; line: number }[] {
  const body = withoutFrontmatter(markdown);
  const offset = markdown.slice(0, markdown.length - body.length).split("\n").length - 1;
  const tokens = new MarkdownIt({ html: false }).parse(body, {});
  return tokens.flatMap((token, index) => {
    if (token.type !== "heading_open") return [];
    const inline = tokens[index + 1];
    const text = inline.children?.filter(child => child.type === "text" || child.type === "code_inline").map(child => child.content).join("") || inline.content;
    return [{ level: Number(token.tag.slice(1)), text, line: (token.map?.[0] ?? 0) + offset + 1 }];
  });
}
