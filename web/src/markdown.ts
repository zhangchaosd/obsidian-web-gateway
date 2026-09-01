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
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.use(taskLists, { enabled: false, label: true });
  wikiPlugin(md);
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
  return DOMPurify.sanitize(md.render(withoutFrontmatter(markdown)), {
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
