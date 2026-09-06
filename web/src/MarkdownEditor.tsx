import { markdown } from "@codemirror/lang-markdown";
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
    view.dispatch({ effects: EditorView.scrollIntoView(position.end ? view.state.doc.length : line.from, { y: position.end ? "end" : "start", yMargin: 0 }) });
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
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping], []);
  useEffect(() => {
    const view = editor.current?.view;
    if (!view || !jump) return;
    const position = view.state.doc.line(Math.min(jump.line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start" }) });
    view.focus();
  }, [jump]);
  return <CodeMirror onCreateEditor={restore} theme={dark ? "dark" : "light"} ref={editor} className="editor-surface" value={value} height="100%" extensions={extensions}
    basicSetup={{ lineNumbers, foldGutter: false, highlightActiveLineGutter: false }}
    editable={!readOnly} onChange={onChange} aria-label="Markdown editor" />;
}
