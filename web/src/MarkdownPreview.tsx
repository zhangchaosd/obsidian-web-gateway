import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { renderMarkdown } from "./markdown";

export default function MarkdownPreview({ content, path, articleRef, onWiki }: {
  content: string; path: string; articleRef: RefObject<HTMLElement | null>; onWiki: (target: string) => void;
}) {
  const [renderedContent, setRenderedContent] = useState(content);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timer = setTimeout(() => setRenderedContent(content), content.length > 100_000 ? 500 : 200);
    return () => clearTimeout(timer);
  }, [content]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);
  const html = useMemo(() => renderMarkdown(renderedContent, path), [renderedContent, path]);
  const previousHtml = useRef<string | null>(null);
  const scrollTop = articleRef.current?.scrollTop ?? 0;
  const scrollLeft = articleRef.current?.scrollLeft ?? 0;
  useLayoutEffect(() => {
    articleRef.current?.scrollTo({ top: previousHtml.current === null ? 0 : scrollTop, left: previousHtml.current === null ? 0 : scrollLeft, behavior: "instant" });
    previousHtml.current = html;
  }, [html]);

  const copy = async (button: HTMLButtonElement) => {
    const code = button.closest(".code-block")?.querySelector("pre code")?.textContent;
    if (code === undefined) return;
    try {
      await copyText(code);
      if (!button.isConnected) return;
      button.dataset.state = "copied";
      button.setAttribute("aria-label", "Code copied");
      button.title = "Copied!";
      const label = button.querySelector(".copy-label");
      if (label) label.textContent = "Copied!";
    } catch {
      if (!button.isConnected) return;
      button.dataset.state = "error";
      button.setAttribute("aria-label", "Copy failed. Select the code and copy manually.");
      button.title = "Copy failed. Select the code and copy manually.";
      const label = button.querySelector(".copy-label");
      if (label) label.textContent = "Copy failed";
    }
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (!button.isConnected) return;
      delete button.dataset.state;
      button.setAttribute("aria-label", "Copy code"); button.title = "Copy code";
      const label = button.querySelector(".copy-label"); if (label) label.textContent = "Copy";
    }, 2000);
    timers.current.add(timer);
  };
  return <article ref={articleRef} className="preview" aria-label="Markdown preview" onClick={event => {
    const element = event.target as HTMLElement;
    const button = element.closest<HTMLButtonElement>(".code-copy");
    if (button) { void copy(button); return; }
    const target = element.closest<HTMLElement>("[data-wiki]")?.dataset.wiki;
    if (target) onWiki(target);
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the selection-based fallback. */ }
  }
  const previous = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = text; field.className = "clipboard-buffer"; field.setAttribute("aria-label", "Code to copy");
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    field.remove(); previous?.focus({ preventScroll: true });
    selection?.removeAllRanges(); for (const range of ranges) selection?.addRange(range);
  }
}
