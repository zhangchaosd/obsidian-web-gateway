import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";

import { startPosition, type ScrollPosition, type ScrollHandle } from "./scrollPosition";

export default function MarkdownEditor({ value, lineNumbers, readOnly, jump, position, scrollHandle, onChange }: {
  position: ScrollPosition; scrollHandle: RefObject<ScrollHandle | null>;
  value: string; lineNumbers: boolean; readOnly: boolean;
  jump: { line: number; sequence: number } | null; onChange: (value: string) => void;
}) {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const editor = useRef<ReactCodeMirrorRef>(null);
  useImperativeHandle(scrollHandle, () => ({ capture: () => {
    const view = editor.current?.view;
    if (!view || view.scrollDOM.scrollTop < 1) return startPosition;
    const height = Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop);
    const block = view.lineBlockAtHeight(height);
    return { line: view.state.doc.lineAt(block.from).number, fraction: Math.max(0, Math.min(.999, (height - block.top) / Math.max(1, block.height))),
      end: view.scrollDOM.scrollHeight > view.scrollDOM.clientHeight && view.scrollDOM.scrollTop >= view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight - 2 };
  } }), []);
  const restore = useCallback((view: EditorView) => {
    const line = view.state.doc.line(Math.min(position.line, view.state.doc.lines));
    // At the document start, a pending scrollIntoView would run after measurement
    // and consume the editor's top padding. Let the measurement restore zero.
    if (position.end || position.line > 1 || position.fraction) {
      view.dispatch({ effects: EditorView.scrollIntoView(position.end ? view.state.doc.length : line.from, { y: position.end ? "end" : "start", yMargin: 0 }) });
    }
    let passes = 3;
    const measure = { read: () => {
      const block = view.lineBlockAt(view.state.doc.line(Math.min(position.line, view.state.doc.lines)).from);
      return position.end ? view.scrollDOM.scrollHeight : position.line <= 1 && !position.fraction ? 0 : block.top + view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop + block.height * position.fraction;
    }, write: (top: number) => {
      view.scrollDOM.scrollTop = top;
      // Wrapped lines can change the virtual document height after the first scroll.
      if (--passes > 0 && view.dom.isConnected) view.requestMeasure(measure);
      else if (position.end) requestAnimationFrame(() => { if (view.dom.isConnected) view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight; });
    } };
    view.requestMeasure(measure);
  }, [position]);
  useLayoutEffect(() => { if (editor.current?.view) restore(editor.current.view); }, [restore]);
  const extensions = useMemo(() => [yamlFrontmatter({ content: markdown() }), EditorView.lineWrapping, syntaxHighlighting(highlightStyle)], []);
  const theme = useMemo(() => editorTheme(dark), [dark]);
  useEffect(() => {
    const view = editor.current?.view;
    if (!view || !jump) return;
    const position = view.state.doc.line(Math.min(jump.line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start" }) });
    view.focus();
  }, [jump]);
  return <CodeMirror onCreateEditor={restore} theme={theme} ref={editor} className="editor-surface" value={value} height="100%" extensions={extensions}
    basicSetup={{ lineNumbers, foldGutter: false, highlightActiveLineGutter: false }}
    editable={!readOnly} onChange={onChange} aria-label="Markdown editor" />;
}

// Colors come from the app's CSS variables, so light and dark schemes share one palette.
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: "var(--text)", fontWeight: "700", fontSize: "1.12em" },
  { tag: [tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: "var(--text)", fontWeight: "650" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.punctuation], color: "var(--muted)" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.labelName], color: "var(--accent-ink)" },
  { tag: tags.url, color: "var(--muted-strong)", textDecoration: "underline", textDecorationColor: "var(--line)" },
  { tag: tags.monospace, color: "var(--accent-ink)" },
  { tag: tags.quote, color: "var(--muted-strong)", fontStyle: "italic" },
  { tag: [tags.meta, tags.comment], color: "var(--muted)" },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "var(--accent-ink)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.atom, tags.keyword], color: "var(--warning)" },
  { tag: tags.invalid, color: "var(--danger)" }
]);

function editorTheme(dark: boolean) {
  return EditorView.theme({
    "&": { backgroundColor: "var(--surface)", color: "var(--text)" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none" },
    ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
    ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
    ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
    ".cm-textfield": { backgroundColor: "var(--surface)", border: "1px solid var(--line)", borderRadius: "5px", color: "var(--text)" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--raised)", border: "1px solid var(--line)", borderRadius: "5px", color: "var(--text)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 22%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
    ".cm-tooltip": { backgroundColor: "var(--raised)", border: "1px solid var(--line)", color: "var(--text)" }
  }, { dark });
}
