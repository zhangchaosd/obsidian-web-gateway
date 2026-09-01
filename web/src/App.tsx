import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  clearSession,
  login,
  q,
  restoreSession,
  type Backlink,
  type SearchResult,
  type SystemInfo,
  type TreeEntry,
  type VaultFile
} from "./api";
import { renderMarkdown } from "./markdown";

type DocumentState = VaultFile & {
  savedContent: string;
  dirty: boolean;
  externalChangeDetected: boolean;
  externalContent?: string;
};

export default function App() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [document, setDocument] = useState<DocumentState | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [status, setStatus] = useState("Loading");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [autosave, setAutosave] = useState(() => localStorage.getItem("owg-autosave") === "true");
  const [lineNumbers, setLineNumbers] = useState(() => localStorage.getItem("owg-line-numbers") !== "false");
  const searchRef = useRef<HTMLInputElement>(null);
  const documentRef = useRef<DocumentState | null>(null);

  useEffect(() => { documentRef.current = document; }, [document]);

  const refreshTree = useCallback(async () => {
    const response = await api<{ entries: TreeEntry[] }>("/api/v1/tree");
    setTree(response.entries);
  }, []);

  const boot = useCallback(async () => {
    setError("");
    try {
      const info = await api<SystemInfo>("/api/v1/system");
      setSystem(info);
      if (info.authRequired) await restoreSession();
      await refreshTree();
      setAuthenticated(true);
      setStatus(info.features.readOnly ? "Read-only" : "Ready");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setAuthenticated(false);
        setStatus("Login required");
      } else setError(messageOf(cause));
    }
  }, [refreshTree]);

  useEffect(() => { void boot(); }, [boot]);

  const fetchBacklinks = useCallback(async (path: string) => {
    try {
      const response = await api<{ items: Backlink[] }>(`/api/v1/backlinks?path=${q(path)}`);
      setBacklinks(response.items);
    } catch { setBacklinks([]); }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setStatus("Loading");
    setError("");
    try {
      const file = await api<VaultFile>(`/api/v1/file?path=${q(path)}`);
      setDocument({ ...file, savedContent: file.content, dirty: false, externalChangeDetected: false });
      setShowDiff(false);
      setStatus(system?.features.readOnly ? "Read-only" : "Saved");
      setDrawer(false);
      await fetchBacklinks(path);
    } catch (cause) { setError(messageOf(cause)); setStatus("Error"); }
  }, [fetchBacklinks, system?.features.readOnly]);

  const requestOpen = useCallback((path: string) => {
    const current = documentRef.current;
    if (current?.dirty && current.path !== path) setPendingPath(path);
    else void loadFile(path);
  }, [loadFile]);

  const save = useCallback(async (force = false): Promise<boolean> => {
    const current = documentRef.current;
    if (!current || system?.features.readOnly) return false;
    setStatus("Saving");
    try {
      const response = await api<{ path: string; revision: VaultFile["revision"] }>("/api/v1/file", {
        method: "PUT",
        body: JSON.stringify({
          path: current.path,
          content: current.content,
          baseRevision: { hash: current.revision.hash },
          force
        })
      });
      setDocument(value => value ? {
        ...value,
        revision: response.revision,
        savedContent: value.content,
        dirty: false,
        externalChangeDetected: false,
        externalContent: undefined
      } : value);
      setStatus("Saved");
      await refreshTree();
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setDocument(value => value ? { ...value, externalChangeDetected: true } : value);
        setStatus("Conflict");
      } else { setError(messageOf(cause)); setStatus("Save failed"); }
      return false;
    }
  }, [refreshTree, system?.features.readOnly]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "p" || (event.shiftKey && event.key.toLowerCase() === "f"))) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (documentRef.current?.dirty) {
        event.preventDefault();
        event.returnValue = true;
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, []);

  useEffect(() => {
    if (!autosave || !document?.dirty || document.externalChangeDetected || system?.features.readOnly) return;
    const timer = window.setTimeout(() => void save(), 1500);
    return () => window.clearTimeout(timer);
  }, [autosave, document?.content, document?.dirty, document?.externalChangeDetected, save, system?.features.readOnly]);

  useEffect(() => {
    if (!authenticated) return;
    let socket: WebSocket | null = null;
    let reconnect = 0;
    let stopped = false;
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws`);
      socket.onopen = () => {
        setConnected(true);
        const current = documentRef.current;
        if (current && !current.dirty) void loadFile(current.path);
      };
      socket.onmessage = event => {
        const message = JSON.parse(event.data) as { type: string; payload?: { path?: string; oldPath?: string; newPath?: string } };
        const current = documentRef.current;
        const affected = message.payload?.path === current?.path || message.payload?.newPath === current?.path || message.payload?.oldPath === current?.path;
        if (affected && current) {
          if (current.dirty) setDocument(value => value ? { ...value, externalChangeDetected: true } : value);
          else if (message.type === "file.deleted") setDocument(null);
          else void loadFile(message.payload?.newPath ?? current.path);
        }
        if (message.type.startsWith("file.") || message.type === "index.updated") void refreshTree();
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) reconnect = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(reconnect); socket?.close(); };
  }, [authenticated, loadFile, refreshTree]);

  const runSearch = async () => {
    if (!search.trim()) { setResults([]); return; }
    try {
      const response = await api<{ results: SearchResult[] }>(`/api/v1/search?q=${q(search)}`);
      setResults(response.results);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const reviewConflict = async () => {
    const current = documentRef.current;
    if (!current) return;
    try {
      const disk = await api<VaultFile>(`/api/v1/file?path=${q(current.path)}`);
      setDocument(value => value ? { ...value, externalContent: disk.content } : value);
      setShowDiff(true);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const signOut = async () => {
    try { await api<void>("/api/v1/auth/logout", { method: "POST" }); } catch { /* Clear local state even if the session expired. */ }
    clearSession();
    setAuthenticated(false);
    setDocument(null);
  };

  const mutatePath = async (kind: "file" | "directory" | "rename" | "delete") => {
    try {
      if (kind === "file") {
        let path = window.prompt("New Markdown file path");
        if (!path) return;
        if (!path.toLowerCase().endsWith(".md")) path += ".md";
        await api("/api/v1/files", { method: "POST", body: JSON.stringify({ path, content: "" }) });
        await refreshTree();
        await loadFile(path);
      } else if (kind === "directory") {
        const path = window.prompt("New directory path");
        if (!path) return;
        await api("/api/v1/directories", { method: "POST", body: JSON.stringify({ path }) });
        await refreshTree();
      } else if (kind === "rename" && document) {
        const next = window.prompt("Rename or move file (links are not updated)", document.path);
        if (!next || next === document.path) return;
        await api("/api/v1/path", { method: "PATCH", body: JSON.stringify({ oldPath: document.path, newPath: next }) });
        await refreshTree();
        await loadFile(next);
      } else if (kind === "delete" && document) {
        if (!window.confirm(`Move ${document.path} to Vault/.trash?`)) return;
        await api(`/api/v1/path?path=${q(document.path)}`, { method: "DELETE" });
        setDocument(null);
        await refreshTree();
      }
    } catch (cause) { setError(messageOf(cause)); }
  };

  const navigateWiki = async (target: string) => {
    try {
      const response = await api<{ status: string; path?: string; candidates?: string[] }>(
        `/api/v1/resolve?link=${q(target)}&source=${q(document?.path ?? "")}`
      );
      if (response.status === "resolved" && response.path) requestOpen(response.path);
      else if (response.status === "ambiguous") setError(`Ambiguous link: ${response.candidates?.join(", ")}`);
      else setError(`Unresolved link: ${target}`);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const preview = useMemo(() => document ? renderMarkdown(document.content, document.path) : "", [document?.content, document?.path]);
  const outline = useMemo(() => document ? document.content.split("\n").flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, text: match[2], line: index + 1 }] : [];
  }) : [], [document?.content]);

  if (!system) return <main className="centered"><p>{error || "Loading…"}</p></main>;
  if (!authenticated) return <Login vault={system.vault.name} onSuccess={boot} error={error} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="mobile-only icon" onClick={() => setDrawer(true)} aria-label="Open files">☰</button>
        <strong title={system.vault.name}>{document?.path ?? system.vault.name}</strong>
        <div className="top-actions">
          <span className={`connection ${connected ? "online" : "offline"}`}>{connected ? status : "Disconnected"}</span>
          {system.features.readOnly && <span className="badge">Read-only</span>}
          <button onClick={() => setMode(mode === "edit" ? "preview" : "edit")}>{mode === "edit" ? "Preview" : "Edit"}</button>
          <button onClick={() => setRightOpen(value => !value)} aria-label="Toggle context panel">⌘</button>
          {system.authRequired && <button onClick={() => void signOut()}>Sign out</button>}
        </div>
      </header>

      <aside className={`sidebar ${drawer ? "open" : ""}`}>
        <div className="sidebar-title"><strong>{system.vault.name}</strong><button className="mobile-only" onClick={() => setDrawer(false)}>×</button></div>
        <form className="search" onSubmit={event => { event.preventDefault(); void runSearch(); }}>
          <input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search vault…" aria-label="Search vault" />
        </form>
        {results.length > 0 ? (
          <div className="search-results">
            <button className="text-button" onClick={() => setResults([])}>← Files</button>
            {results.map(result => <button key={result.path} onClick={() => requestOpen(result.path)}><strong>{result.path}</strong><small>{result.matches[0]?.snippet}</small></button>)}
          </div>
        ) : <Tree entries={tree} onOpen={requestOpen} />}
        {!system.features.readOnly && <div className="file-actions"><button onClick={() => void mutatePath("file")}>+ Note</button><button onClick={() => void mutatePath("directory")}>+ Folder</button></div>}
      </aside>
      {drawer && <button className="scrim mobile-only" onClick={() => setDrawer(false)} aria-label="Close files" />}

      <main className="workspace">
        {error && <div className="error" role="alert"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {document?.externalChangeDetected && (
          <div className="conflict" role="alert">
            <span>The file changed on disk. Your unsaved content was preserved.</span>
            <button onClick={() => void loadFile(document.path)}>Reload</button>
            <button onClick={() => void reviewConflict()}>View diff</button>
            {!system.features.readOnly && <button className="danger" onClick={() => void save(true)}>Force overwrite</button>}
          </div>
        )}
        {document ? (
          <>
            <div className="document-toolbar">
              <span>{document.dirty ? "● Unsaved" : "✓ Saved"}</span>
              <label><input type="checkbox" checked={autosave} onChange={event => { setAutosave(event.target.checked); localStorage.setItem("owg-autosave", String(event.target.checked)); }} /> Autosave</label>
              <label><input type="checkbox" checked={lineNumbers} onChange={event => { setLineNumbers(event.target.checked); localStorage.setItem("owg-line-numbers", String(event.target.checked)); }} /> Lines</label>
              {!system.features.readOnly && <><button onClick={() => void save()}>Save</button><button onClick={() => void mutatePath("rename")}>Rename / Move</button><button className="danger" onClick={() => void mutatePath("delete")}>Delete</button></>}
            </div>
            {showDiff && document.externalContent !== undefined ? (
              <div className="diff-view">
                <section><h2>Your unsaved version</h2><pre>{document.content}</pre></section>
                <section><h2>Current disk version</h2><pre>{document.externalContent}</pre></section>
                <button onClick={() => setShowDiff(false)}>Close comparison</button>
              </div>
            ) : mode === "edit" ? (
              <div className="editor-pane">
                <CodeMirror
                  className="editor-surface"
                  value={document.content}
                  height="100%"
                  extensions={[markdown()]}
                  basicSetup={{ lineNumbers }}
                  editable={!system.features.readOnly}
                  onChange={content => setDocument(value => value ? { ...value, content, dirty: content !== value.savedContent } : value)}
                  aria-label="Markdown editor"
                />
              </div>
            ) : (
              <article className="preview" onClick={event => {
                const target = (event.target as HTMLElement).closest<HTMLElement>("[data-wiki]")?.dataset.wiki;
                if (target) void navigateWiki(target);
              }} dangerouslySetInnerHTML={{ __html: preview }} />
            )}
          </>
        ) : <div className="empty"><h1>{system.vault.name}</h1><p>Select a Markdown file from the sidebar.</p></div>}
      </main>

      {rightOpen && <aside className="context-panel">
        <section><h2>Outline</h2>{outline.length ? outline.map(item => <div key={`${item.line}-${item.text}`} style={{ paddingLeft: `${(item.level - 1) * 10}px` }}>{item.text}</div>) : <p className="muted">No headings</p>}</section>
        <section><h2>Backlinks</h2>{backlinks.length ? backlinks.map(item => <button className="backlink" key={item.path} onClick={() => requestOpen(item.path)}><strong>{item.path}</strong><small>{item.references[0]?.context}</small></button>) : <p className="muted">No backlinks</p>}</section>
      </aside>}

      {pendingPath && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true"><h2>Unsaved changes</h2><p>Save changes before opening another file?</p><div><button onClick={async () => { if (await save()) { const path = pendingPath; setPendingPath(null); void loadFile(path); } }}>Save</button><button onClick={() => { const path = pendingPath; setPendingPath(null); void loadFile(path); }}>Discard</button><button onClick={() => setPendingPath(null)}>Cancel</button></div></div></div>}
    </div>
  );
}

function Tree({ entries, onOpen }: { entries: TreeEntry[]; onOpen: (path: string) => void }) {
  return <nav className="tree" aria-label="Vault files">{entries.map(entry => entry.type === "directory" ? (
    <details key={entry.path} open><summary>▾ {entry.name}</summary><Tree entries={entry.children ?? []} onOpen={onOpen} /></details>
  ) : entry.type === "markdown" ? (
    <button key={entry.path} onClick={() => onOpen(entry.path)} title={entry.path}>◇ {entry.name}</button>
  ) : (
    <a key={entry.path} href={`/api/v1/asset?path=${q(entry.path)}`} target="_blank" rel="noreferrer">▧ {entry.name}</a>
  ))}</nav>;
}

function Login({ vault, onSuccess, error }: { vault: string; onSuccess: () => Promise<void>; error: string }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(error);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(false);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(false), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || cooldown) return;
    setMessage("");
    setSubmitting(true);
    try { await login(password); await onSuccess(); }
    catch (cause) {
      clearSession();
      setMessage(cause instanceof ApiError && cause.status === 401 ? "Incorrect password." : messageOf(cause));
      setCooldown(true);
    } finally { setSubmitting(false); }
  };
  return <main className="centered"><form className="login-card" onSubmit={submit}><div className="logo">OWG</div><h1>{vault}</h1><p>Sign in to access this Vault.</p><label>Password<input type="password" autoFocus autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>{message && <p className="login-error">{message}</p>}<button type="submit" disabled={submitting || cooldown}>{submitting ? "Signing in…" : cooldown ? "Try again in 1 second…" : "Sign in"}</button></form></main>;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Unexpected error"; }
