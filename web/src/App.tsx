import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, api, clearSession, login, q, restoreSession,
  type Backlink, type SearchResult, type SystemInfo, type TreeEntry, type VaultFile
} from "./api";
import { getOutline, renderMarkdown } from "./markdown";

const MarkdownEditor = lazy(() => import("./MarkdownEditor"));

type DocumentState = VaultFile & {
  savedContent: string;
  dirty: boolean;
  externalChangeDetected: boolean;
  externalContent?: string;
};
type WorkspaceTab = {
  id: number;
  document: DocumentState | null;
  mode: "edit" | "preview";
  backlinks: Backlink[];
  showDiff: boolean;
};
type MutationDialog = { kind: "file" | "directory" | "rename" | "delete"; value: string };
type IconName = "archive" | "arrow-left" | "book" | "check" | "chevron" | "close" | "document" | "edit" | "external" | "file-plus" | "folder" | "folder-plus" | "info" | "link" | "menu" | "more" | "panel" | "preview" | "save" | "search" | "sparkle" | "trash";

export default function App() {
  const [tabs, setTabsState] = useState<WorkspaceTab[]>(() => [newWorkspaceTab(1)]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [status, setStatus] = useState("Loading");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 1050);
  const [contextTab, setContextTab] = useState<"outline" | "backlinks">("outline");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [mutationDialog, setMutationDialog] = useState<MutationDialog | null>(null);
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchState, setSearchState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const searchSequence = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; body: string; action: () => void } | null>(null);
  const [jump, setJump] = useState<{ line: number; sequence: number } | null>(null);
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const loadSequence = useRef(new Map<number, number>());
  const syncSequence = useRef(new Map<number, number>());
  const saving = useRef(new Set<number>());
  const [mutating, setMutating] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [autosave, setAutosave] = useState(() => localStorage.getItem("owg-autosave") === "true");
  const [lineNumbers, setLineNumbers] = useState(() => localStorage.getItem("owg-line-numbers") !== "false");
  const searchRef = useRef<HTMLInputElement>(null);
  const documentRef = useRef<DocumentState | null>(null);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const tabSequenceRef = useRef(1);

  const setTabs = useCallback((update: React.SetStateAction<WorkspaceTab[]>) => {
    const next = typeof update === "function" ? update(tabsRef.current) : update;
    tabsRef.current = next;
    documentRef.current = next.find(tab => tab.id === activeTabIdRef.current)?.document ?? null;
    setTabsState(next);
  }, []);

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
  const document = activeTab.document;
  const mode = activeTab.mode;
  const backlinks = activeTab.backlinks;
  const showDiff = activeTab.showDiff;

  activeTabIdRef.current = activeTabId;

  const updateTab = useCallback((tabId: number, update: (tab: WorkspaceTab) => WorkspaceTab) => {
    setTabs(current => current.map(tab => tab.id === tabId ? update(tab) : tab));
  }, [setTabs]);

  const setDocument = useCallback((update: React.SetStateAction<DocumentState | null>) => {
    const tabId = activeTabIdRef.current;
    updateTab(tabId, tab => ({ ...tab, document: typeof update === "function" ? update(tab.document) : update }));
  }, [updateTab]);

  const setMode = useCallback((mode: "edit" | "preview") => {
    updateTab(activeTabIdRef.current, tab => ({ ...tab, mode }));
  }, [updateTab]);

  const setShowDiff = useCallback((showDiff: boolean) => {
    updateTab(activeTabIdRef.current, tab => ({ ...tab, showDiff }));
  }, [updateTab]);

  documentRef.current = document;

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

  const fetchBacklinks = useCallback(async (path: string, tabId = activeTabIdRef.current) => {
    try {
      const response = await api<{ items: Backlink[] }>(`/api/v1/backlinks?path=${q(path)}`);
      updateTab(tabId, tab => tab.document?.path === path ? { ...tab, backlinks: response.items } : tab);
    } catch { updateTab(tabId, tab => tab.document?.path === path ? { ...tab, backlinks: [] } : tab); }
  }, [updateTab]);

  const loadFile = useCallback(async (path: string, tabId = activeTabIdRef.current) => {
    const before = tabsRef.current.find(tab => tab.id === tabId)?.document;
    const sequence = (loadSequence.current.get(tabId) ?? 0) + 1;
    loadSequence.current.set(tabId, sequence);
    setStatus("Loading");
    setError("");
    try {
      const file = await api<VaultFile>(`/api/v1/file?path=${q(path)}`);
      if (loadSequence.current.get(tabId) !== sequence) return;
      const latest = tabsRef.current.find(tab => tab.id === tabId)?.document;
      if (latest?.dirty && latest.content !== before?.content) { setError("Your draft changed while the note was loading. Open the note again when ready."); setStatus("Unsaved"); return; }
      updateTab(tabId, tab => ({
        ...tab,
        document: { ...file, savedContent: file.content, dirty: false, externalChangeDetected: false },
        backlinks: [],
        showDiff: false
      }));
      setStatus(system?.features.readOnly ? "Read-only" : "Saved");
      setActiveHeading(null); setJump(null);
      setDrawer(false); if (window.innerWidth <= 1050) setRightOpen(false);
      await fetchBacklinks(path, tabId);
    } catch (cause) { setError(messageOf(cause)); setStatus("Error"); }
  }, [fetchBacklinks, system?.features.readOnly, updateTab]);

  const requestOpen = useCallback((path: string) => {
    const openTabs = tabsRef.current;
    const existing = openTabs.find(tab => tab.document?.path === path);
    if (existing) {
      loadSequence.current.set(existing.id, (loadSequence.current.get(existing.id) ?? 0) + 1);
      const currentTabId = activeTabIdRef.current;
      const currentTab = openTabs.find(tab => tab.id === currentTabId);
      if (currentTab && currentTab.id !== existing.id && currentTab.document === null) {
        setTabs(current => current.filter(tab => tab.id !== currentTab.id));
      }
      activeTabIdRef.current = existing.id;
      documentRef.current = existing.document;
      setActiveTabId(existing.id);
      setJump(null); setActiveHeading(null);
      setPendingPath(null);
      setError("");
      setDrawer(false); if (window.innerWidth <= 1050) setRightOpen(false);
      setStatus(system?.features.readOnly ? "Read-only" : existing.document?.dirty ? "Unsaved" : "Saved");
      return;
    }
    const current = documentRef.current;
    if (current?.dirty && current.path !== path) setPendingPath(path);
    else void loadFile(path);
  }, [loadFile, system?.features.readOnly]);

  const save = useCallback(async (force = false): Promise<boolean> => {
    const current = documentRef.current;
    const tabId = activeTabIdRef.current;
    if (!current || system?.features.readOnly || saving.current.has(tabId)) return false;
    syncSequence.current.set(tabId, (syncSequence.current.get(tabId) ?? 0) + 1);
    saving.current.add(tabId);
    setStatus("Saving");
    try {
      const response = await api<{ path: string; revision: VaultFile["revision"] }>("/api/v1/file", {
        method: "PUT",
        body: JSON.stringify({ path: current.path, content: current.content, baseRevision: { hash: current.revision.hash }, force })
      });
      updateTab(tabId, tab => ({ ...tab, document: tab.document?.path === current.path ? { ...tab.document, revision: response.revision, savedContent: current.content, dirty: tab.document.content !== current.content, externalChangeDetected: false, externalContent: undefined } : tab.document }));
      setStatus("Saved");
      await refreshTree();
      return tabsRef.current.find(tab => tab.id === tabId)?.document?.dirty === false;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        updateTab(tabId, tab => ({ ...tab, document: tab.document ? { ...tab.document, externalChangeDetected: true } : null }));
        setStatus("Conflict");
      } else { setError(messageOf(cause)); setStatus("Save failed"); }
      return false;
    } finally { saving.current.delete(tabId); }
  }, [refreshTree, system?.features.readOnly, updateTab]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "p" || (event.shiftKey && event.key.toLowerCase() === "f"))) { event.preventDefault(); setDrawer(true); window.setTimeout(() => searchRef.current?.focus(), 0); }
      if (event.key === "Escape") { setMutationDialog(null); setPendingPath(null); setPendingCloseTab(null); setConfirmation(null); setMenuOpen(false); setDrawer(false); if (window.innerWidth <= 1050) setRightOpen(false); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (tabsRef.current.some(tab => tab.document?.dirty)) { event.preventDefault(); event.returnValue = true; }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, []);

  useEffect(() => {
    if (!autosave || !document?.dirty || document.externalChangeDetected || system?.features.readOnly) return;
    const timer = window.setTimeout(() => void save(), 1500);
    return () => window.clearTimeout(timer);
  }, [autosave, document?.content, document?.dirty, document?.externalChangeDetected, save, system?.features.readOnly]);

  // Reconcile every open document. Recheck its identity and draft at response time.
  const syncTab = useCallback(async (tabId: number, path: string, nextPath = path) => {
    if (saving.current.has(tabId)) return;
    const sequence = loadSequence.current.get(tabId);
    const syncId = (syncSequence.current.get(tabId) ?? 0) + 1;
    syncSequence.current.set(tabId, syncId);
    try {
      const file = await api<VaultFile>(`/api/v1/file?path=${q(nextPath)}`);
      if (syncSequence.current.get(tabId) !== syncId || saving.current.has(tabId)) return;
      updateTab(tabId, tab => {
        const current = tab.document;
        if (!current || current.path !== path || loadSequence.current.get(tabId) !== sequence) return tab;
        if (current.revision.hash === file.revision.hash) return { ...tab, document: { ...current, path: nextPath } };
        if (current.dirty) return { ...tab, document: { ...current, path: nextPath, externalChangeDetected: true, externalContent: file.content } };
        return { ...tab, document: { ...file, savedContent: file.content, dirty: false, externalChangeDetected: false } };
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404 && syncSequence.current.get(tabId) === syncId && loadSequence.current.get(tabId) === sequence) {
        updateTab(tabId, tab => tab.document?.path !== path ? tab : tab.document.dirty
          ? { ...tab, document: { ...tab.document, externalChangeDetected: true } }
          : { ...tab, document: null, backlinks: [] });
      }
    }
  }, [updateTab]);

  useEffect(() => {
    if (!authenticated) return;
    let socket: WebSocket | null = null;
    let reconnect = 0;
    let stopped = false;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/ws`);
      socket.onopen = () => {
        setConnected(true);
        for (const tab of tabsRef.current) if (tab.document) void syncTab(tab.id, tab.document.path);
      };
      socket.onmessage = event => {
        let message: { type: string; payload?: { path?: string; oldPath?: string; newPath?: string } };
        try { message = JSON.parse(event.data); } catch { return; }
        for (const tab of tabsRef.current) {
          const path = tab.document?.path;
          if (!path) continue;
          const payload = message.payload;
          if (payload?.path === path || payload?.oldPath === path || payload?.newPath === path) {
            void syncTab(tab.id, path, payload?.oldPath === path ? payload.newPath ?? path : path);
          }
          if (message.type === "index.updated") void fetchBacklinks(path, tab.id);
        }
        if (message.type.startsWith("file.") || message.type === "index.updated") void refreshTree().catch(cause => setError(messageOf(cause)));
      };
      socket.onclose = () => { setConnected(false); if (!stopped) reconnect = window.setTimeout(connect, 2000); };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(reconnect); socket?.close(); };
  }, [authenticated, syncTab, refreshTree, fetchBacklinks]);

  const resetSearch = () => { searchSequence.current++; setSearch(""); setResults([]); setSearchState("idle"); };
  const runSearch = async () => {
    const sequence = ++searchSequence.current;
    if (!search.trim()) { setResults([]); setSearchState("idle"); return; }
    setSearchState("loading");
    try {
      const response = await api<{ results: SearchResult[] }>(`/api/v1/search?q=${q(search)}`);
      if (sequence !== searchSequence.current) return;
      setResults(response.results); setSearchState("done");
    } catch (cause) { if (sequence === searchSequence.current) { setSearchState("error"); setError(messageOf(cause)); } }
  };

  const reviewConflict = async () => {
    const current = documentRef.current;
    const tabId = activeTabIdRef.current;
    if (!current) return;
    try {
      const disk = await api<VaultFile>(`/api/v1/file?path=${q(current.path)}`);
      updateTab(tabId, tab => tab.document?.path === current.path ? { ...tab, document: { ...tab.document, externalContent: disk.content }, showDiff: true } : tab);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const signOut = async () => {
    try { await api<void>("/api/v1/auth/logout", { method: "POST" }); } catch { /* Clear local state if the session expired. */ }
    const tab = newWorkspaceTab(++tabSequenceRef.current);
    clearSession(); setAuthenticated(false); setTabs([tab]); setActiveTabId(tab.id);
  };

  const moveFile = async (oldPath: string, directory: string) => {
    const name = oldPath.slice(oldPath.lastIndexOf("/") + 1);
    const newPath = directory ? `${directory}/${name}` : name;
    setDraggedPath(null);
    setDropTarget(null);
    if (newPath === oldPath || system?.features.readOnly) return;
    const current = documentRef.current;
    if (tabsRef.current.some(tab => tab.document?.path === oldPath && tab.document.dirty)) {
      setError("Save this note before moving it to another folder.");
      return;
    }
    setError("");
    setStatus("Moving");
    try {
      await api("/api/v1/path", { method: "PATCH", body: JSON.stringify({ oldPath, newPath }) });
      setTabs(openTabs => openTabs.map(tab => tab.document?.path === oldPath ? { ...tab, document: { ...tab.document, path: newPath } } : tab));
      await refreshTree();
      if (current?.path === oldPath) await loadFile(newPath);
      else setStatus("Saved");
    } catch (cause) {
      setError(messageOf(cause));
      setStatus("Move failed");
    }
  };

  const beginDrag = (path: string, event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", path);
    setDraggedPath(path);
  };

  const submitMutation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mutationDialog || mutating) return;
    setMutating(true);
    const value = mutationDialog.value.trim();
    try {
      if (mutationDialog.kind === "file") {
        if (!value) return;
        const path = value.toLowerCase().endsWith(".md") ? value : `${value}.md`;
        await api("/api/v1/files", { method: "POST", body: JSON.stringify({ path, content: `# ${fileTitle(path)}\n\n` }) });
        setMutationDialog(null); await refreshTree(); requestOpen(path);
      } else if (mutationDialog.kind === "directory") {
        if (!value) return;
        await api("/api/v1/directories", { method: "POST", body: JSON.stringify({ path: value }) });
        setMutationDialog(null); await refreshTree();
      } else if (mutationDialog.kind === "rename" && document) {
        if (!value || value === document.path) return;
        if (document.dirty) {
          setMutationDialog(null);
          setError("Save this note before renaming or moving it.");
          return;
        }
        const oldPath = document.path;
        await api("/api/v1/path", { method: "PATCH", body: JSON.stringify({ oldPath: document.path, newPath: value }) });
        setTabs(openTabs => openTabs.map(tab => tab.document?.path === oldPath ? { ...tab, document: { ...tab.document, path: value } } : tab));
        setMutationDialog(null); await refreshTree(); await loadFile(value);
      } else if (mutationDialog.kind === "delete" && document) {
        const deletedPath = document.path;
        await api(`/api/v1/path?path=${q(deletedPath)}`, { method: "DELETE" });
        setTabs(openTabs => openTabs.map(tab => tab.document?.path === deletedPath ? { ...tab, document: null, backlinks: [], showDiff: false } : tab));
        setMutationDialog(null); await refreshTree();
      }
    } catch (cause) { setError(messageOf(cause)); } finally { setMutating(false); }
  };

  const navigateWiki = async (target: string) => {
    try {
      const response = await api<{ status: string; path?: string; candidates?: string[] }>(`/api/v1/resolve?link=${q(target)}&source=${q(document?.path ?? "")}`);
      if (response.status === "resolved" && response.path) requestOpen(response.path);
      else if (response.status === "ambiguous") setError(`Ambiguous link: ${response.candidates?.join(", ")}`);
      else setError(`Unresolved link: ${target}`);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const preview = useMemo(() => document ? renderMarkdown(document.content, document.path) : "", [document?.content, document?.path]);
  const outline = useMemo(() => document ? getOutline(document.content) : [], [document?.content]);
  const jumpToHeading = (line: number) => {
    setActiveHeading(line);
    if (mode === "edit") setJump(value => ({ line, sequence: (value?.sequence ?? 0) + 1 }));
    else {
      const target = previewRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
      target?.scrollIntoView({ block: "start", behavior: "instant" });
      target?.focus({ preventScroll: true });
    }
    if (window.innerWidth <= 1050) setRightOpen(false);
  };
  const noteCount = useMemo(() => countNotes(tree), [tree]);
  const wordCount = useMemo(() => document ? countWords(document.content) : 0, [document?.content]);
  const parentPath = document?.path.includes("/") ? document.path.slice(0, document.path.lastIndexOf("/")) : "Vault";

  const createNewTab = () => {
    const tab = newWorkspaceTab(++tabSequenceRef.current);
    setTabs(current => [...current, tab]);
    activeTabIdRef.current = tab.id;
    documentRef.current = null;
    setActiveTabId(tab.id);
    setJump(null); setActiveHeading(null); setMenuOpen(false);
    setPendingPath(null);
    setError("");
    setStatus(system?.features.readOnly ? "Read-only" : "Ready");
  };

  const activateTab = (tabId: number) => {
    const tab = tabs.find(candidate => candidate.id === tabId);
    if (!tab) return;
    activeTabIdRef.current = tabId;
    documentRef.current = tab.document;
    setActiveTabId(tabId);
    setJump(null); setActiveHeading(null); setMenuOpen(false);
    setPendingPath(null);
    setError("");
    setStatus(system?.features.readOnly ? "Read-only" : tab.document?.dirty ? "Unsaved" : tab.document ? "Saved" : "Ready");
  };

  const closeTabImmediately = (tabId: number) => {
    const index = tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    if (tabs.length === 1) {
      const replacement = newWorkspaceTab(++tabSequenceRef.current);
      setTabs([replacement]);
      setActiveTabId(replacement.id);
    } else {
      const remaining = tabs.filter(tab => tab.id !== tabId);
      setTabs(remaining);
      if (activeTabId === tabId) {
        const next = tabs[index - 1] ?? tabs[index + 1];
        setActiveTabId(next.id);
      }
    }
    setPendingCloseTab(null);
  };

  const requestCloseTab = (tabId: number) => {
    const tab = tabs.find(candidate => candidate.id === tabId);
    if (!tab) return;
    if (tab.document?.dirty) {
      activateTab(tabId);
      setPendingCloseTab(tabId);
    } else closeTabImmediately(tabId);
  };

  const closingTab = pendingCloseTab === null ? null : tabs.find(tab => tab.id === pendingCloseTab) ?? null;

  const modalKey = pendingPath ? "open" : closingTab ? "close" : mutationDialog ? `mutation-${mutationDialog.kind}` : confirmation ? "confirmation" : "";
  useEffect(() => {
    if (!modalKey) return;
    const previous = window.document.activeElement as HTMLElement | null;
    const dialog = window.document.querySelector<HTMLElement>('[aria-modal="true"]');
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && (window.document.activeElement === first || !dialog.contains(window.document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (window.document.activeElement === last || !dialog.contains(window.document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    window.document.addEventListener("keydown", trap);
    return () => { cancelAnimationFrame(frame); window.document.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, [modalKey]);

  if (!system) return <LoadingState error={error} />;
  if (!authenticated) return <Login vault={system.vault.name} onSuccess={boot} error={error} />;

  const openMutation = (kind: MutationDialog["kind"]) => { setError(""); setMenuOpen(false); setMutationDialog({ kind, value: kind === "rename" ? document?.path ?? "" : "" }); };
  const requestSignOut = () => {
    if (tabsRef.current.some(tab => tab.document?.dirty)) setConfirmation({ title: "Sign out with unsaved changes?", body: "Your unsaved drafts will be discarded. Cancel to return and save them first.", action: () => void signOut() });
    else void signOut();
  };

  return <div className={`app-shell ${rightOpen ? "context-open" : ""} ${mode === "preview" ? "reading-mode" : "editing-mode"}`}>
    <header className="topbar">
      <div className="topbar-leading">
        <button className="icon-button mobile-only" onClick={() => setDrawer(true)} aria-label="Open files"><Icon name="menu" /></button>
        <div className="document-location"><span>{parentPath}</span><strong title={document?.path ?? system.vault.name}>{document?.path ?? system.vault.name}</strong></div>
      </div>
      <div className="top-actions">
        <div className={`sync-state ${connected ? "online" : "offline"}`} title={connected ? "Live updates connected" : "Connection lost; reconnecting"}><span className="sync-dot" /><span>{connected ? "Connected" : "Reconnecting"}</span></div>
        {system.features.readOnly && <span className="badge">Read-only</span>}
        {document && <div className="mode-switch" role="group" aria-label="Document mode">
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} aria-pressed={mode === "edit"}><Icon name="edit" /> Edit</button>
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} aria-pressed={mode === "preview"}><Icon name="preview" /> Preview</button>
        </div>}
        <button className={`icon-button ${rightOpen ? "active" : ""}`} onClick={() => { setRightOpen(value => !value); setDrawer(false); }} aria-label="Toggle context panel" aria-pressed={rightOpen}><Icon name="panel" /></button>
        {system.authRequired && <button className="icon-button" onClick={requestSignOut} aria-label="Sign out"><Icon name="external" /></button>}
      </div>
    </header>

    <aside className={`sidebar ${drawer ? "open" : ""}`}>
      <div className="vault-header"><div className="vault-mark"><Icon name="sparkle" /></div><div><strong>{system.vault.name}</strong><span>{noteCount} notes · local vault</span></div><button className="icon-button mobile-only" onClick={() => setDrawer(false)} aria-label="Close files"><Icon name="close" /></button></div>
      <form className="search-box" onSubmit={event => { event.preventDefault(); void runSearch(); }}>
        <Icon name="search" /><input ref={searchRef} value={search} onChange={event => { searchSequence.current++; setSearch(event.target.value); setResults([]); setSearchState("idle"); }} placeholder="Search notes" aria-label="Search vault" />
        {search ? <button type="button" onClick={resetSearch} aria-label="Clear search"><Icon name="close" /></button> : <kbd>⌘ P</kbd>}
      </form>
      <div className={`sidebar-section-label root-drop-target ${draggedPath && dropTarget === "" ? "drop-active" : ""}`} onDragOver={event => { if (!draggedPath) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(""); }} onDrop={event => { event.preventDefault(); const path = draggedPath ?? event.dataTransfer.getData("text/plain"); if (path) void moveFile(path, ""); }}><span>{searchState !== "idle" ? "Search results" : draggedPath ? "Move to Vault root" : "Your files"}</span>{searchState !== "idle" && !draggedPath && <button onClick={resetSearch}><Icon name="arrow-left" /> All files</button>}</div>
      {draggedPath && <div className="drag-help" role="status">Drop on a folder, or above to move to the root</div>}
      <div className="sidebar-scroll">{searchState === "loading" ? <div className="search-feedback" role="status"><Icon name="search" /><strong>Searching your vault…</strong></div> : searchState === "error" ? <div className="search-feedback" role="status"><Icon name="info" /><strong>Search failed</strong><button onClick={() => void runSearch()}>Try again</button></div> : searchState === "done" && !results.length ? <div className="search-feedback" role="status"><Icon name="search" /><strong>No notes found</strong><p>Try another word or a shorter phrase.</p><button onClick={resetSearch}>Clear search</button></div> : results.length > 0 ? <div className="search-results">{results.map(result => <button key={result.path} draggable={!system.features.readOnly} onDragStart={event => beginDrag(result.path, event)} onDragEnd={() => { setDraggedPath(null); setDropTarget(null); }} onClick={() => requestOpen(result.path)}><span className="result-icon"><Icon name="document" /></span><span><strong>{fileTitle(result.path)}</strong><small>{result.path}</small><em>{result.matches[0]?.snippet}</em></span></button>)}</div> : <Tree entries={tree} activePath={document?.path} draggedPath={draggedPath} dropTarget={dropTarget} readOnly={system.features.readOnly} onDragStart={beginDrag} onDragEnd={() => { setDraggedPath(null); setDropTarget(null); }} onDropTarget={setDropTarget} onMove={moveFile} onOpen={requestOpen} />}</div>
      {!system.features.readOnly && <div className="file-actions"><button onClick={() => openMutation("file")}><Icon name="file-plus" /> New note</button><button className="icon-button" onClick={() => openMutation("directory")} aria-label="New folder"><Icon name="folder-plus" /></button></div>}
    </aside>
    {rightOpen && <button className="context-scrim" onClick={() => setRightOpen(false)} aria-label="Close context panel" />}
    {drawer && <button className="scrim mobile-only" onClick={() => setDrawer(false)} aria-label="Close files" />}

    <main className="workspace" onClick={() => { if (menuOpen) setMenuOpen(false); }}>
      <div className="tab-strip" role="tablist" aria-label="Open notes">
        <div className="tab-scroll">{tabs.map(tab => {
          const tabTitle = tab.document ? fileTitle(tab.document.path) : "New tab";
          return <div className={`workspace-tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
            <button className="tab-button" role="tab" aria-label={tabTitle} aria-selected={tab.id === activeTabId} title={tab.document?.path ?? "Empty tab"} onClick={() => activateTab(tab.id)}><Icon name={tab.document ? "document" : "book"} /><span>{tabTitle}</span>{tab.document?.dirty && <span className="tab-dirty" title="Unsaved changes" />}</button>
            <button className="tab-close" onClick={() => requestCloseTab(tab.id)} aria-label={`Close ${tabTitle}`}><Icon name="close" /></button>
          </div>;
        })}</div>
        <button className="new-tab-button" onClick={createNewTab} aria-label="New tab" title="New tab"><span>+</span></button>
      </div>
      {error && <div className="notice error" role="alert"><Icon name="info" /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><Icon name="close" /></button></div>}
      {document?.externalChangeDetected && <div className="notice conflict" role="alert"><Icon name="info" /><span>This note changed on disk. Your draft is safe.</span><button onClick={() => setConfirmation({ title: "Discard your draft?", body: "The version on disk will replace your unsaved changes.", action: () => void loadFile(document.path) })}>Reload</button><button onClick={() => void reviewConflict()}>Compare</button>{!system.features.readOnly && <button className="danger" onClick={() => setConfirmation({ title: "Overwrite the version on disk?", body: "Your draft will replace the external changes to this note.", action: () => void save(true) })}>Overwrite</button>}</div>}
      {document ? <>
        <div className="document-toolbar">
          <div className={`save-state ${document.dirty ? "dirty" : ""}`}><span role="status">{document.externalChangeDetected ? "Conflict" : status === "Saving" ? "Saving…" : document.dirty ? "● Unsaved" : "✓ Saved"}</span></div>
          <div className="document-stats"><span>{wordCount} words</span><span>{outline.length} headings</span></div>
          <div className="toolbar-actions"><label className={`toggle-label ${system.features.readOnly ? "hidden" : ""}`}><input disabled={system.features.readOnly} type="checkbox" checked={autosave} onChange={event => { setAutosave(event.target.checked); localStorage.setItem("owg-autosave", String(event.target.checked)); }} /><span className="toggle" /> Autosave</label>{mode === "edit" && <label className="compact-check"><input type="checkbox" checked={lineNumbers} onChange={event => { setLineNumbers(event.target.checked); localStorage.setItem("owg-line-numbers", String(event.target.checked)); }} /> Lines</label>}{!system.features.readOnly && <button className="primary-button" onClick={() => void save()} disabled={!document.dirty || status === "Saving"}><Icon name="save" /> Save</button>}<div className="note-menu"><button className="icon-button" aria-label="Note actions" aria-expanded={menuOpen} onClick={event => { event.stopPropagation(); setMenuOpen(value => !value); }}><Icon name="more" /></button>{menuOpen && <div className="note-menu-popover"><span>Note actions</span>{!system.features.readOnly && <><button onClick={() => openMutation("rename")}><Icon name="edit" /> Rename or move note</button><button className="danger" onClick={() => openMutation("delete")}><Icon name="trash" /> Move note to trash</button></>}<button onClick={() => { setRightOpen(true); setMenuOpen(false); }}><Icon name="panel" /> Outline & backlinks</button></div>}</div></div>
        </div>
        {showDiff && document.externalContent !== undefined ? <div className="diff-view"><section><h2>Your draft</h2><pre>{document.content}</pre></section><section><h2>Version on disk</h2><pre>{document.externalContent}</pre></section><button onClick={() => setShowDiff(false)}>Close comparison</button></div> : mode === "edit" ? <div className="editor-pane"><Suspense fallback={<div className="editor-loading" role="status">Opening editor…</div>}><MarkdownEditor key={document.path} value={document.content} lineNumbers={lineNumbers} readOnly={system.features.readOnly} jump={jump} onChange={content => setDocument(value => value ? { ...value, content, dirty: content !== value.savedContent } : value)} /></Suspense></div> : <article ref={previewRef} className="preview" onClick={event => { const target = (event.target as HTMLElement).closest<HTMLElement>("[data-wiki]")?.dataset.wiki; if (target) void navigateWiki(target); }} dangerouslySetInnerHTML={{ __html: preview }} />}
      </> : <EmptyVault vault={system.vault.name} readOnly={system.features.readOnly} onCreate={() => openMutation("file")} />}
    </main>

    {rightOpen && <aside className="context-panel">
      <div className="context-tabs" role="tablist" aria-label="Note context"><button className="icon-button context-close" aria-label="Hide context panel" onClick={() => setRightOpen(false)}><Icon name="close" /></button><button className={contextTab === "outline" ? "active" : ""} onClick={() => setContextTab("outline")} role="tab" aria-selected={contextTab === "outline"}>Outline</button><button className={contextTab === "backlinks" ? "active" : ""} onClick={() => setContextTab("backlinks")} role="tab" aria-selected={contextTab === "backlinks"}>Backlinks <span>{backlinks.length}</span></button></div>
      {document ? contextTab === "outline" ? <section className="outline-list">{outline.length ? outline.map(item => <button aria-current={activeHeading === item.line ? "location" : undefined} onClick={() => jumpToHeading(item.line)} key={`${item.line}-${item.text}`} style={{ paddingLeft: `${14 + (item.level - 1) * 12}px` }}><span>{item.text}</span><small>{item.line}</small></button>) : <ContextEmpty icon="book" title="No headings yet" body="Add a heading to create an outline." />}</section> : <section className="backlinks-list">{backlinks.length ? backlinks.map(item => <button className="backlink" key={item.path} onClick={() => requestOpen(item.path)}><span className="backlink-icon"><Icon name="link" /></span><span><strong>{fileTitle(item.path)}</strong><small>{item.references[0]?.context}</small></span></button>) : <ContextEmpty icon="link" title="No backlinks" body="Links to this note will appear here." />}</section> : <ContextEmpty icon="book" title="Nothing selected" body="Open a note to see its outline and backlinks." />}
      {document && <div className="note-metadata"><span>Note details</span><dl><div><dt>Location</dt><dd>{parentPath}</dd></div><div><dt>Words</dt><dd>{wordCount}</dd></div><div><dt>Format</dt><dd>Markdown</dd></div></dl></div>}
    </aside>}

    {confirmation && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirmation-title"><div className="modal-icon warning"><Icon name="info" /></div><h2 id="confirmation-title">{confirmation.title}</h2><p>{confirmation.body}</p><div className="modal-actions"><button onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-button" onClick={() => { confirmation.action(); setConfirmation(null); }}>Continue</button></div></div></div>}
    {pendingPath && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title"><div className="modal-icon warning"><Icon name="info" /></div><h2 id="unsaved-title">Save your changes?</h2><p>You have an unsaved draft. Choose what to do before opening another note.</p><div className="modal-actions"><button onClick={() => setPendingPath(null)}>Keep editing</button><button onClick={() => { const path = pendingPath; setPendingPath(null); void loadFile(path); }}>Discard</button><button className="primary-button" onClick={async () => { if (await save()) { const path = pendingPath; setPendingPath(null); void loadFile(path); } }}>Save & open</button></div></div></div>}
    {closingTab && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="close-tab-title"><div className="modal-icon warning"><Icon name="info" /></div><h2 id="close-tab-title">Close with unsaved changes?</h2><p>Save your changes to {closingTab.document ? fileTitle(closingTab.document.path) : "this note"} before closing its tab.</p><div className="modal-actions"><button onClick={() => setPendingCloseTab(null)}>Keep tab</button><button onClick={() => closeTabImmediately(closingTab.id)}>Discard & close</button><button className="primary-button" onClick={async () => { if (await save()) closeTabImmediately(closingTab.id); }}>Save & close</button></div></div></div>}
    {mutationDialog && <MutationModal busy={mutating} error={error} dialog={mutationDialog} documentPath={document?.path} onChange={value => setMutationDialog(current => current ? { ...current, value } : null)} onClose={() => setMutationDialog(null)} onSubmit={submitMutation} />}
  </div>;
}

type TreeProps = {
  entries: TreeEntry[]; activePath?: string; draggedPath: string | null; dropTarget: string | null; readOnly: boolean;
  onOpen: (path: string) => void; onDragStart: (path: string, event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void; onDropTarget: (path: string | null) => void; onMove: (path: string, directory: string) => Promise<void>; depth?: number;
};

function Tree({ entries, activePath, draggedPath, dropTarget, readOnly, onOpen, onDragStart, onDragEnd, onDropTarget, onMove, depth = 0 }: TreeProps) {
  return <nav className="tree" aria-label={depth === 0 ? "Vault files" : undefined}>{entries.map(entry => entry.type === "directory" ? <details key={entry.path} open>
    <summary className={dropTarget === entry.path ? "drop-active" : ""} style={{ paddingLeft: `${12 + depth * 14}px` }} onDragOver={event => { if (!draggedPath) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; onDropTarget(entry.path); }} onDragLeave={() => { if (dropTarget === entry.path) onDropTarget(null); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); const path = draggedPath ?? event.dataTransfer.getData("text/plain"); if (path) void onMove(path, entry.path); }}><Icon name="chevron" /><Icon name="folder" /><span>{entry.name}</span><small>{countNotes(entry.children ?? [])}</small></summary>
    <Tree entries={entry.children ?? []} activePath={activePath} draggedPath={draggedPath} dropTarget={dropTarget} readOnly={readOnly} onOpen={onOpen} onDragStart={onDragStart} onDragEnd={onDragEnd} onDropTarget={onDropTarget} onMove={onMove} depth={depth + 1} />
  </details> : entry.type === "markdown" ? <button className={`${entry.path === activePath ? "active" : ""} ${entry.path === draggedPath ? "dragging" : ""}`} draggable={!readOnly} onDragStart={event => onDragStart(entry.path, event)} onDragEnd={onDragEnd} key={entry.path} onClick={() => onOpen(entry.path)} title={entry.path} style={{ paddingLeft: `${30 + depth * 14}px` }} aria-label={`Open ${entry.name}`}><Icon name="document" /><span>{entry.name.replace(/\.md$/i, "")}</span>{entry.path === activePath && <span className="active-pip" />}</button> : <a className={entry.path === draggedPath ? "dragging" : ""} draggable={!readOnly} onDragStart={event => onDragStart(entry.path, event)} onDragEnd={onDragEnd} key={entry.path} href={`/api/v1/asset?path=${q(entry.path)}`} target="_blank" rel="noreferrer" style={{ paddingLeft: `${30 + depth * 14}px` }}><Icon name="archive" /><span>{entry.name}</span></a>)}</nav>;
}

function MutationModal({ busy, error, dialog, documentPath, onChange, onClose, onSubmit }: { busy: boolean; error: string; dialog: MutationDialog; documentPath?: string; onChange: (value: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent) => void }) {
  const copy = {
    file: { icon: "file-plus" as IconName, title: "Create a new note", body: "Choose a path inside your vault.", label: "Note path", placeholder: "Projects/New idea", action: "Create note" },
    directory: { icon: "folder-plus" as IconName, title: "Create a new folder", body: "Folders help keep related notes together.", label: "Folder path", placeholder: "Projects/Research", action: "Create folder" },
    rename: { icon: "edit" as IconName, title: "Rename or move note", body: "Existing links to this note are not updated automatically.", label: "New path", placeholder: "Folder/Note.md", action: "Apply changes" },
    delete: { icon: "trash" as IconName, title: "Move note to trash?", body: `${documentPath ?? "This note"} will move to .trash and can be recovered from the vault.`, label: "", placeholder: "", action: "Move to trash" }
  }[dialog.kind];
  const destructive = dialog.kind === "delete";
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="mutation-title" onSubmit={onSubmit}><div className={`modal-icon ${destructive ? "danger" : ""}`}><Icon name={copy.icon} /></div><h2 id="mutation-title">{copy.title}</h2><p>{copy.body}</p>{error && <p className="login-error" role="alert">{error}</p>}{!destructive && <label className="field-label">{copy.label}<input autoFocus value={dialog.value} onChange={event => onChange(event.target.value)} placeholder={copy.placeholder} /></label>}<div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className={destructive ? "danger-button" : "primary-button"} type="submit" disabled={busy || (!destructive && !dialog.value.trim())}>{copy.action}</button></div></form></div>;
}

function EmptyVault({ vault, readOnly, onCreate }: { vault: string; readOnly: boolean; onCreate: () => void }) {
  return <div className="empty-state"><div className="empty-illustration"><span /><Icon name="book" /></div><span className="eyebrow">Welcome to your workspace</span><h1>{vault}</h1><p>Select a note from the sidebar to start reading, or capture a new idea.</p>{!readOnly && <button className="primary-button" onClick={onCreate}><Icon name="file-plus" /> Create a note</button>}<div className="shortcut-hint"><kbd>⌘ P</kbd><span>Quick search</span><kbd>⌘ S</kbd><span>Save note</span></div></div>;
}

function ContextEmpty({ icon, title, body }: { icon: IconName; title: string; body: string }) { return <div className="context-empty"><Icon name={icon} /><strong>{title}</strong><p>{body}</p></div>; }
function LoadingState({ error }: { error: string }) { return <main className="loading-screen"><div className="vault-mark large"><Icon name="sparkle" /></div><div className="loading-line" /><p>{error || "Opening your vault…"}</p></main>; }

function Login({ vault, onSuccess, error }: { vault: string; onSuccess: () => Promise<void>; error: string }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(error);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => { if (!cooldown) return; const timer = window.setTimeout(() => setCooldown(false), 1000); return () => window.clearTimeout(timer); }, [cooldown]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (submitting || cooldown) return; setMessage(""); setSubmitting(true);
    try { await login(password); await onSuccess(); }
    catch (cause) { clearSession(); setMessage(cause instanceof ApiError && cause.status === 401 ? "Incorrect password." : messageOf(cause)); setCooldown(true); }
    finally { setSubmitting(false); }
  };
  return <main className="login-screen"><div className="login-ambient" /><form className="login-card" onSubmit={submit}><div className="vault-mark large"><Icon name="sparkle" /></div><span className="eyebrow">Obsidian Web Gateway</span><h1>Welcome back</h1><p>Sign in to open <strong>{vault}</strong>. Your notes stay on this device.</p><label className="field-label">Password<input type="password" autoFocus autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter vault password" /></label>{message && <p className="login-error"><Icon name="info" />{message}</p>}<button className="primary-button login-button" type="submit" disabled={submitting || cooldown}>{submitting ? "Opening vault…" : cooldown ? "Try again in a moment" : "Open vault"}</button><small><span className="sync-dot online" /> Encrypted session · Local connection</small></form></main>;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    archive: <><rect x="4" y="5" width="16" height="4" rx="1"/><path d="M6 9v10h12V9M10 13h4"/></>, "arrow-left": <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>, book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></>, check: <path d="m5 12 4 4L19 6"/>, chevron: <path d="m9 18 6-6-6-6"/>, close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>, document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>, edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>, external: <><path d="M10 17l5-5-5-5"/><path d="M15 12H3M21 19V5a2 2 0 0 0-2-2h-6"/></>, "file-plus": <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></>, folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>, "folder-plus": <><path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>, link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></>, menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>, panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>, preview: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>, save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, sparkle: <path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7ZM5 16l.8 2.2L8 19l-2.2.8L5 22l-.8-2.2L2 19l2.2-.8Z"/>, trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></>
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function countNotes(entries: TreeEntry[]): number { return entries.reduce((total, entry) => total + (entry.type === "markdown" ? 1 : entry.children ? countNotes(entry.children) : 0), 0); }
function newWorkspaceTab(id: number): WorkspaceTab { return { id, document: null, mode: "edit", backlinks: [], showDiff: false }; }
function fileTitle(path: string): string { return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""); }
function countWords(content: string): number {
  const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const cjk = content.match(cjkPattern)?.length ?? 0;
  const otherWords = content.replace(cjkPattern, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return otherWords + cjk;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Unexpected error"; }
