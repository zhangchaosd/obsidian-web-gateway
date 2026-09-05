import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";

export default function MarkdownEditor({ value, lineNumbers, readOnly, jump, onChange }: {
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
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping], []);
  useEffect(() => {
    const view = editor.current?.view;
    if (!view || !jump) return;
    const position = view.state.doc.line(Math.min(jump.line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start" }) });
    view.focus();
  }, [jump]);
  return <CodeMirror theme={dark ? "dark" : "light"} ref={editor} className="editor-surface" value={value} height="100%" extensions={extensions}
    basicSetup={{ lineNumbers, foldGutter: false, highlightActiveLineGutter: false }}
    editable={!readOnly} onChange={onChange} aria-label="Markdown editor" />;
}
