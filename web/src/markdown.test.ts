// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("Markdown preview", () => {
  it("sanitizes active HTML", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n<img src=x onerror=alert(1)>", "A.md");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("renders wiki links and Obsidian image embeds", () => {
    const html = renderMarkdown("[[Projects/Rust|Rust Notes]] ![[attachments/a.png]]", "Home.md");
    expect(html).toContain('data-wiki="Projects/Rust"');
    expect(html).toContain("/api/v1/asset?path=attachments%2Fa.png");
  });

  it("does not parse wiki links in code", () => {
    const html = renderMarkdown("`[[Example]]`", "A.md");
    expect(html).not.toContain("data-wiki");
  });

  it("renders GFM task list checkboxes", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo", "A.md");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("does not render YAML frontmatter as document headings", () => {
    const html = renderMarkdown("---\ntitle: Hidden metadata\n---\n# Visible", "A.md");
    expect(html).not.toContain("Hidden metadata");
    expect(html).toContain("<h1>Visible</h1>");
  });
});
