import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, PasskeyCancelled, api, clearSession, login, passkeyLogin, q, restoreSession,
  type Backlink, type SearchResult, type SystemInfo, type TreeEntry, type UpdateSettings, type UpdateStatus, type VaultFile
} from "./api";
import { getOutline } from "./markdown";

import { capturePreview, startPosition, type ScrollHandle, type ScrollPosition } from "./scrollPosition";
import MarkdownPreview from "./MarkdownPreview";
import VaultHome from "./VaultHome";
import SplitDivider, { splitStyle } from "./SplitDivider";

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
  mode: "edit" | "preview" | "split";
  backlinks: Backlink[];
  showDiff: boolean;
};
type MutationTarget = { path: string; type: "markdown" | "directory" };
type MutationDialog = { kind: "file" | "directory" | "rename" | "delete"; value: string; target?: MutationTarget };
type SavedWorkspace = { tabs: { path: string | null; mode: WorkspaceTab["mode"] }[]; active: number };
const modKey = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
type IconName = "focus" | "home" | "archive" | "arrow-left" | "book" | "check" | "chevron" | "close" | "document" | "download" | "edit" | "external" | "file-plus" | "folder" | "folder-plus" | "info" | "key" | "link" | "menu" | "more" | "panel" | "preview" | "save" | "search" | "settings" | "sparkle" | "trash";

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
  const [focusMode, setFocusMode] = useState(false);
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
  const pendingHeadingFocus = useRef<{ path: string; line: number } | null>(null);
  const [headingFocusSequence, setHeadingFocusSequence] = useState(0);
  const editorScrollRef = useRef<ScrollHandle | null>(null);
  const [scrollPosition, setScrollPosition] = useState<ScrollPosition>(startPosition);
  const previewRef = useRef<HTMLElement>(null);
  const loadSequence = useRef(new Map<number, number>());
  const syncSequence = useRef(new Map<number, number>());
  const saving = useRef(new Set<number>());
  const [mutating, setMutating] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [autosave, setAutosave] = useState(() => readStorage("owg-autosave") === "true");
  const [lineNumbers, setLineNumbers] = useState(() => readStorage("owg-line-numbers") !== "false");
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const workspaceRestored = useRef(false);
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
  useEffect(() => { if (!document) setFocusMode(false); }, [document?.path]);
  const [compact, setCompact] = useState(() => window.innerWidth <= 760);
  const [overlayContext, setOverlayContext] = useState(() => window.innerWidth <= 1050);
  const [splitRatio, setSplitRatioState] = useState(() => {
    const saved = Number(readStorage("owg-split-ratio"));
    return saved >= 30 && saved <= 70 ? saved : 50;
  });
  const setSplitRatio = useCallback((ratio: number) => { setSplitRatioState(ratio); writeStorage("owg-split-ratio", String(ratio)); }, []);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const contextMedia = matchMedia("(max-width: 1050px)");
    const update = () => { setCompact(media.matches); setOverlayContext(contextMedia.matches); };
    media.addEventListener("change", update);
    contextMedia.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); contextMedia.removeEventListener("change", update); };
  }, []);
  const mode = compact && activeTab.mode === "split" ? "edit" : activeTab.mode;
  useEffect(() => { setScrollPosition({ ...startPosition }); }, [document?.path, activeTabId]);
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

  const setMode = useCallback((nextMode: "edit" | "preview" | "split") => {
    if (nextMode === mode) return;
    const anchor = mode === "preview" || (mode === "split" && nextMode === "preview")
      ? previewRef.current ? capturePreview(previewRef.current) : startPosition
      : editorScrollRef.current?.capture() ?? startPosition;
    setScrollPosition({ ...anchor });
    setJump(null);
    if (nextMode === "split") setRightOpen(false);
    updateTab(activeTabIdRef.current, tab => ({ ...tab, mode: nextMode }));
  }, [mode, updateTab]);

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

  // Reopen the previous session's tabs. Drafts are not persisted, only which notes were open.
  const restoreWorkspace = useCallback(async (key: string) => {
    let saved: SavedWorkspace | null = null;
    try { saved = JSON.parse(readStorage(key) ?? "null") as SavedWorkspace | null; } catch { /* Ignore malformed state. */ }
    if (!saved?.tabs?.length || !saved.tabs.some(tab => tab.path)) return;
    const files = await Promise.all(saved.tabs.map(tab => tab.path ? api<VaultFile>(`/api/v1/file?path=${q(tab.path)}`).catch(() => null) : null));
    // Respect anything the user opened while the files were loading.
    if (tabsRef.current.some(tab => tab.document)) return;
    const restored: WorkspaceTab[] = [];
    let active = 0;
    saved.tabs.forEach((entry, index) => {
      const file = files[index];
      if (entry.path && !file) return;
      if (index <= saved.active) active = restored.length;
      restored.push({
        ...newWorkspaceTab(++tabSequenceRef.current),
        mode: entry.mode === "preview" || entry.mode === "split" ? entry.mode : "edit",
        document: file ? { ...file, savedContent: file.content, dirty: false, externalChangeDetected: false } : null
      });
    });
    if (!restored.some(tab => tab.document)) return;
    const activeTab = restored[Math.min(active, restored.length - 1)];
    setTabs(restored);
    activeTabIdRef.current = activeTab.id;
    documentRef.current = activeTab.document;
    setActiveTabId(activeTab.id);
    setStatus(activeTab.document ? "Saved" : "Ready");
    for (const tab of restored) if (tab.document) void fetchBacklinks(tab.document.path, tab.id);
  }, [fetchBacklinks, setTabs]);

  useEffect(() => {
    if (!authenticated) { setUpdateStatus(null); return; }
    api<UpdateStatus>("/api/v1/update").then(setUpdateStatus).catch(() => { /* Updates are optional. */ });
  }, [authenticated]);

  const workspaceKey = system ? `owg-workspace:${system.vault.name}` : "";
  useEffect(() => {
    if (!authenticated || !workspaceKey || workspaceRestored.current) return;
    workspaceRestored.current = true;
    void restoreWorkspace(workspaceKey).finally(() => setWorkspaceReady(true));
  }, [authenticated, workspaceKey, restoreWorkspace]);

  const savedWorkspace = JSON.stringify({ tabs: tabs.map(tab => ({ path: tab.document?.path ?? null, mode: tab.mode })), active: tabs.findIndex(tab => tab.id === activeTabId) } satisfies SavedWorkspace);
  useEffect(() => {
    if (authenticated && workspaceReady && workspaceKey) writeStorage(workspaceKey, savedWorkspace);
  }, [authenticated, workspaceReady, workspaceKey, savedWorkspace]);

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
      return tabsRef.current.find(tab => tab.id === tabId)?.document?.dirty === false;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        updateTab(tabId, tab => ({ ...tab, document: tab.document ? { ...tab.document, externalChangeDetected: true } : null }));
        setStatus("Conflict");
      } else { setError(messageOf(cause)); setStatus("Save failed"); }
      return false;
    } finally { saving.current.delete(tabId); }
  }, [system?.features.readOnly, updateTab]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "p" || (event.shiftKey && event.key.toLowerCase() === "f"))) { event.preventDefault(); setFocusMode(false); if (window.innerWidth <= 1050) setRightOpen(false); setDrawer(true); window.setTimeout(() => searchRef.current?.focus(), 0); }
      // The editor consumes Escape for its own panels (search, autocomplete).
      if (event.key === "Escape" && !event.defaultPrevented) { setUpdatesOpen(false); setFolderMenu(null); setMutationDialog(null); setPendingPath(null); setPendingCloseTab(null); setConfirmation(null); setMenuOpen(false); setDrawer(false); setFocusMode(false); if (window.innerWidth <= 1050) setRightOpen(false); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  useEffect(() => {
    if (!folderMenu) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.(".folder-menu, .folder-more")) setFolderMenu(null); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [folderMenu]);

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
    // A single save or rename produces bursts of events; coalesce the follow-up requests.
    let reconnected = false;
    let treeTimer = 0;
    let backlinksTimer = 0;
    const scheduleTree = () => {
      window.clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => void refreshTree().catch(cause => setError(messageOf(cause))), 200);
    };
    const scheduleBacklinks = () => {
      window.clearTimeout(backlinksTimer);
      backlinksTimer = window.setTimeout(() => {
        for (const tab of tabsRef.current) if (tab.document) void fetchBacklinks(tab.document.path, tab.id);
      }, 300);
    };
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/ws`);
      socket.onopen = () => {
        setConnected(true);
        if (reconnected) scheduleTree();
        reconnected = true;
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
        }
        // Content edits do not change the tree; only structural events (or missed events) do.
        if (["file.created", "file.deleted", "file.renamed"].includes(message.type) || (message.type === "index.updated" && (message.payload as { reason?: string } | undefined)?.reason === "lagged")) scheduleTree();
        if (message.type === "index.updated") scheduleBacklinks();
      };
      socket.onclose = () => { setConnected(false); if (!stopped) reconnect = window.setTimeout(connect, 2000); };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(reconnect); window.clearTimeout(treeTimer); window.clearTimeout(backlinksTimer); socket?.close(); };
  }, [authenticated, syncTab, refreshTree, fetchBacklinks]);

  const resetSearch = () => { searchSequence.current++; setSearch(""); setResults([]); setSearchState("idle"); };
  const runSearch = useCallback(async (query: string) => {
    const sequence = ++searchSequence.current;
    if (!query.trim()) { setResults([]); setSearchState("idle"); return; }
    setSearchState("loading");
    try {
      const response = await api<{ results: SearchResult[] }>(`/api/v1/search?q=${q(query)}`);
      if (sequence !== searchSequence.current) return;
      setResults(response.results); setSearchState("done");
    } catch (cause) { if (sequence === searchSequence.current) { setSearchState("error"); setError(messageOf(cause)); } }
  }, []);
  // Search as the user types, after a short pause; Enter searches immediately.
  useEffect(() => {
    if (!search.trim()) return;
    const timer = window.setTimeout(() => void runSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search, runSearch]);
  const changeSearch = (value: string) => {
    searchSequence.current++;
    setSearch(value);
    if (!value.trim()) { setResults([]); setSearchState("idle"); } else setSearchState("loading");
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
    // Forget which notes were open so the next person at this browser starts fresh.
    if (workspaceKey) removeStorage(workspaceKey);
    workspaceRestored.current = false; setWorkspaceReady(false);
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
    const target = mutationDialog.target;
    const affected = (path: string) => !!target && (path === target.path || path.startsWith(`${target.path}/`));
    const hasDraft = () => tabsRef.current.some(tab => tab.document?.dirty && affected(tab.document.path));
    const draftMessage = target?.type === "directory" ? "Save the notes in this folder first." : "Save this note first.";
    try {
      if (mutationDialog.kind === "file") {
        if (!value) return;
        const path = withMarkdownExtension(value);
        await api("/api/v1/files", { method: "POST", body: JSON.stringify({ path, content: `# ${fileTitle(path)}\n\n` }) });
        setMutationDialog(null); await refreshTree(); requestOpen(path);
      } else if (mutationDialog.kind === "directory") {
        if (!value) return;
        await api("/api/v1/directories", { method: "POST", body: JSON.stringify({ path: value }) });
        setMutationDialog(null); await refreshTree();
      } else if (mutationDialog.kind === "rename" && target) {
        const trimmed = value.replace(/\/+$/, "");
        // Notes keep their extension even when the user types only a name.
        const newPath = target.type === "markdown" ? withMarkdownExtension(trimmed) : trimmed;
        if (!trimmed || newPath === target.path) { setMutationDialog(null); return; }
        if (hasDraft()) { setMutationDialog(null); setError(`${draftMessage} Unsaved drafts cannot be renamed or moved.`); return; }
        await api("/api/v1/path", { method: "PATCH", body: JSON.stringify({ oldPath: target.path, newPath }) });
        const activeWasAffected = !!documentRef.current && affected(documentRef.current.path);
        setTabs(openTabs => openTabs.map(tab => tab.document && affected(tab.document.path) ? { ...tab, document: { ...tab.document, path: newPath + tab.document.path.slice(target.path.length) } } : tab));
        setMutationDialog(null); await refreshTree();
        if (activeWasAffected && documentRef.current) void fetchBacklinks(documentRef.current.path);
      } else if (mutationDialog.kind === "delete" && target) {
        if (hasDraft()) { setMutationDialog(null); setError(`${draftMessage} Unsaved drafts are not moved to trash.`); return; }
        await api(`/api/v1/path?path=${q(target.path)}`, { method: "DELETE" });
        setTabs(openTabs => openTabs.map(tab => tab.document && affected(tab.document.path) ? { ...tab, document: null, backlinks: [], showDiff: false } : tab));
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

  const outline = useMemo(() => document ? getOutline(document.content) : [], [document?.content]);
  const jumpToHeading = (line: number) => {
    setActiveHeading(line);
    if (mode !== "preview") setJump(value => ({ line, sequence: (value?.sequence ?? 0) + 1 }));
    if (mode !== "edit") {
      const target = previewRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
      target?.scrollIntoView({ block: "start", behavior: "instant" });
      pendingHeadingFocus.current = { path: document?.path ?? "", line };
      setHeadingFocusSequence(value => value + 1);
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

  const modalKey = pendingPath ? "open" : closingTab ? "close" : mutationDialog ? `mutation-${mutationDialog.kind}` : confirmation ? "confirmation" : updatesOpen ? "updates" : "";
  useEffect(() => {
    if (!modalKey) return;
    const previous = window.document.activeElement as HTMLElement | null;
    const dialog = window.document.querySelector<HTMLElement>('[aria-modal="true"]');
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'));
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

  const contextVisible = rightOpen && !!document && !focusMode;
  const mobilePanel = compact && drawer ? "files" : overlayContext && contextVisible ? "context" : null;
  useEffect(() => {
    if (!mobilePanel) return;
    const previous = window.document.activeElement as HTMLElement | null;
    const panel = window.document.querySelector<HTMLElement>(mobilePanel === "files" ? ".sidebar" : ".context-panel");
    if (!panel) return;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href], summary')).filter(item => item.getClientRects().length);
    const frame = requestAnimationFrame(() => {
      // Quick search may already have focused its input before this frame.
      if (!panel.contains(window.document.activeElement)) focusable()[0]?.focus();
    });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && (window.document.activeElement === first || !panel.contains(window.document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (window.document.activeElement === last || !panel.contains(window.document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    panel.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(frame);
      panel.removeEventListener("keydown", trap);
      const active = window.document.activeElement;
      // Keep deliberate focus handoffs (an outline heading or quick search).
      // Only return to the opener when focus is still in the closing panel.
      if (previous?.isConnected && (!active || active === window.document.body || panel.contains(active))) previous.focus({ preventScroll: true });
    };
  }, [mobilePanel]);

  useEffect(() => {
    const pending = pendingHeadingFocus.current;
    if (!pending || mobilePanel) return;
    pendingHeadingFocus.current = null;
    // Resolve the current heading after rendering and drawer cleanup. An old
    // DOM reference may have been replaced by the Markdown preview's update.
    if (pending.path === document?.path) previewRef.current?.querySelector<HTMLElement>(`[data-line="${pending.line}"]`)?.focus({ preventScroll: true });
  }, [headingFocusSequence, mobilePanel, document?.path]);

  if (!system) return <LoadingState error={error} />;
  if (!authenticated) return <Login vault={system.vault.name} methods={system.auth ?? { password: true, username: false, passkey: false }} onSuccess={boot} error={error} />;

  const openMutation = (kind: MutationDialog["kind"], target?: MutationTarget) => { setError(""); setMenuOpen(false); setFolderMenu(null); setMutationDialog({ kind, target, value: kind === "rename" ? target?.path ?? "" : "" }); };
  const noteTarget: MutationTarget | undefined = document ? { path: document.path, type: "markdown" } : undefined;
  const requestSignOut = () => {
    if (tabsRef.current.some(tab => tab.document?.dirty)) setConfirmation({ title: "Sign out with unsaved changes?", body: "Your unsaved drafts will be discarded. Cancel to return and save them first.", action: () => void signOut() });
    else void signOut();
  };

  const openSearch = () => { setFocusMode(false); if (window.innerWidth <= 1050) setRightOpen(false); setDrawer(true); window.setTimeout(() => searchRef.current?.focus(), 0); };
  const goHome = () => { const home = tabs.find(tab => !tab.document); if (home) activateTab(home.id); else createNewTab(); setDrawer(false); setFocusMode(false); };

  return <div className={`app-shell ${contextVisible ? "context-open" : ""} ${!document ? "is-home" : ""} ${focusMode ? "focus-mode" : ""} ${mode === "preview" ? "reading-mode" : "editing-mode"}`}>
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="topbar" inert={!!mobilePanel}>
      <div className="topbar-leading">
        <button className="icon-button mobile-only" onClick={() => { setFocusMode(false); setRightOpen(false); setDrawer(true); }} aria-label="Open files"><Icon name="menu" /></button>
        <div className="document-location"><span>{document ? parentPath : "A space of your own"}</span><strong title={document?.path ?? system.vault.name}>{document?.path ?? system.vault.name}</strong></div>
      </div>
      <div className="top-actions">
        <div className={`sync-state ${connected ? "online" : "offline"}`} title={connected ? "Live updates connected" : "Connection lost; reconnecting"}><span className="sync-dot" /><span>{connected ? "Connected" : "Reconnecting"}</span></div>
        {system.features.readOnly && <span className="badge">Read-only</span>}
        {document && <div className="mode-switch" role="group" aria-label="Document mode">
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} aria-pressed={mode === "edit"}><Icon name="edit" /> Edit</button>
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} aria-pressed={mode === "preview"}><Icon name="preview" /> Preview</button>
          {!compact && <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")} aria-pressed={mode === "split"}><Icon name="panel" /> Split</button>}
        </div>}
        {document && <button className={`icon-button focus-button ${focusMode ? "active" : ""}`} onClick={() => setFocusMode(value => !value)} aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"} title={focusMode ? "Exit focus mode (Esc)" : "Focus mode"} aria-pressed={focusMode}><Icon name="focus" /></button>}
        {document && <button className={`icon-button ${contextVisible ? "active" : ""}`} onClick={() => { setFocusMode(false); setRightOpen(!contextVisible); setDrawer(false); }} aria-label="Toggle context panel" aria-pressed={contextVisible}><Icon name="panel" /></button>}
        {system.authRequired && <button className="icon-button" onClick={requestSignOut} aria-label="Sign out"><Icon name="external" /></button>}
      </div>
    </header>

    <aside className={`sidebar ${drawer ? "open" : ""}`} aria-label="Library navigation" inert={(compact && !drawer) || mobilePanel === "context" || focusMode}>
      <div className="brand"><BrandMark /><span>Obsidian<span>WEB GATEWAY</span></span><span className="brand-edition">/ 01</span></div>
      <div className="vault-header"><div className="vault-mark"><Icon name="book" /></div><div><strong>{system.vault.name}</strong><span>{noteCount} {noteCount === 1 ? "note" : "notes"} · local vault</span></div><button className={`icon-button settings-button ${updateStatus?.available ? "has-update" : ""}`} onClick={() => { setUpdatesOpen(true); setDrawer(false); }} aria-label={updateStatus?.available ? `About and updates, version ${updateStatus.latest?.version} available` : "About and updates"} title={updateStatus?.available ? `Update available: v${updateStatus.latest?.version}` : "About and updates"}><Icon name="settings" /></button><button className="icon-button mobile-only" onClick={() => setDrawer(false)} aria-label="Close files"><Icon name="close" /></button></div>
      <button className={`sidebar-home ${!document ? "active" : ""}`} onClick={goHome} aria-label="Library home" aria-current={!document ? "page" : undefined}><Icon name="home" /><span>Library</span><span className="home-count">{String(noteCount).padStart(2, "0")}</span></button>
      <form className="search-box" onSubmit={event => { event.preventDefault(); void runSearch(search); }}>
        <Icon name="search" /><input ref={searchRef} value={search} onChange={event => changeSearch(event.target.value)} placeholder="Search notes" aria-label="Search vault" />
        {search ? <button type="button" onClick={resetSearch} aria-label="Clear search"><Icon name="close" /></button> : <kbd>{modKey} P</kbd>}
      </form>
      <div className={`sidebar-section-label root-drop-target ${draggedPath && dropTarget === "" ? "drop-active" : ""}`} onDragOver={event => { if (!draggedPath) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(""); }} onDrop={event => { event.preventDefault(); const path = draggedPath ?? event.dataTransfer.getData("text/plain"); if (path) void moveFile(path, ""); }}><span>{searchState !== "idle" ? "Search results" : draggedPath ? "Move to Vault root" : "Your files"}</span>{searchState !== "idle" && !draggedPath && <button onClick={resetSearch}><Icon name="arrow-left" /> All files</button>}</div>
      {draggedPath && <div className="drag-help" role="status">Drop on a folder, or above to move to the root</div>}
      <div className="sidebar-scroll">{searchState === "loading" && !results.length ? <div className="search-feedback" role="status"><Icon name="search" /><strong>Searching your vault…</strong></div> : searchState === "error" ? <div className="search-feedback" role="status"><Icon name="info" /><strong>Search failed</strong><button onClick={() => void runSearch(search)}>Try again</button></div> : searchState === "done" && !results.length ? <div className="search-feedback" role="status"><Icon name="search" /><strong>No notes found</strong><p>Try another word or a shorter phrase.</p><button onClick={resetSearch}>Clear search</button></div> : results.length > 0 ? <div className="search-results">{results.map(result => <button key={result.path} draggable={!system.features.readOnly} onDragStart={event => beginDrag(result.path, event)} onDragEnd={() => { setDraggedPath(null); setDropTarget(null); }} onClick={() => requestOpen(result.path)}><span className="result-icon"><Icon name="document" /></span><span><strong>{fileTitle(result.path)}</strong><small>{result.path}</small><em>{result.matches[0]?.snippet}</em></span></button>)}</div> : <Tree entries={tree} activePath={document?.path} draggedPath={draggedPath} dropTarget={dropTarget} readOnly={system.features.readOnly} folderMenu={folderMenu} onFolderMenu={setFolderMenu} onFolderAction={(kind, path) => openMutation(kind, { path, type: "directory" })} onDragStart={beginDrag} onDragEnd={() => { setDraggedPath(null); setDropTarget(null); }} onDropTarget={setDropTarget} onMove={moveFile} onOpen={requestOpen} />}</div>
      <div className="sidebar-colophon"><span className="colophon-symbol">✳</span><p>A quiet place for<br /><em>your next idea.</em></p><span>YOUR NOTES. YOUR SPACE.</span></div>
      {!system.features.readOnly && <div className="file-actions"><button onClick={() => openMutation("file")}><Icon name="file-plus" /> New note</button><button className="icon-button" onClick={() => openMutation("directory")} aria-label="New folder"><Icon name="folder-plus" /></button></div>}
    </aside>
    {contextVisible && <button className="context-scrim" onClick={() => setRightOpen(false)} aria-label="Close context panel" />}
    {drawer && <button className="scrim mobile-only" onClick={() => setDrawer(false)} aria-label="Close files" />}

    <main className="workspace" id="workspace" tabIndex={-1} inert={!!mobilePanel} onClick={() => { if (menuOpen) setMenuOpen(false); }}>
      <div className="tab-strip" role="tablist" aria-label="Open notes" onKeyDown={event => {
        if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = tabs.findIndex(tab => tab.id === activeTabId);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        activateTab(tabs[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        <div className="tab-scroll">{tabs.map(tab => {
          const tabTitle = tab.document ? fileTitle(tab.document.path) : "Library";
          return <div className={`workspace-tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
            <button className="tab-button" role="tab" tabIndex={tab.id === activeTabId ? 0 : -1} aria-label={tabTitle} aria-selected={tab.id === activeTabId} title={tab.document?.path ?? "Library home"} onClick={() => activateTab(tab.id)}><Icon name={tab.document ? "document" : "book"} /><span>{tabTitle}</span>{tab.document?.dirty && <span className="tab-dirty" title="Unsaved changes" />}</button>
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
          <div className="toolbar-actions"><label className={`toggle-label ${system.features.readOnly ? "hidden" : ""}`}><input disabled={system.features.readOnly} type="checkbox" checked={autosave} onChange={event => { setAutosave(event.target.checked); writeStorage("owg-autosave", String(event.target.checked)); }} /><span className="toggle" /> Autosave</label>{mode !== "preview" && <label className="compact-check"><input type="checkbox" checked={lineNumbers} onChange={event => { setLineNumbers(event.target.checked); writeStorage("owg-line-numbers", String(event.target.checked)); }} /> Lines</label>}{!system.features.readOnly && <button className="primary-button" onClick={() => void save()} disabled={!document.dirty || status === "Saving"}><Icon name="save" /> Save</button>}<div className="note-menu"><button className="icon-button" aria-label="Note actions" aria-expanded={menuOpen} onClick={event => { event.stopPropagation(); setMenuOpen(value => !value); }}><Icon name="more" /></button>{menuOpen && <div className="note-menu-popover"><span>Note actions</span>{!system.features.readOnly && <><button onClick={() => openMutation("rename", noteTarget)}><Icon name="edit" /> Rename or move note</button><button className="danger" onClick={() => openMutation("delete", noteTarget)}><Icon name="trash" /> Move note to trash</button></>}<button onClick={() => { setFocusMode(false); setRightOpen(true); setMenuOpen(false); }}><Icon name="panel" /> Outline & backlinks</button></div>}</div></div>
        </div>
        {showDiff && document.externalContent !== undefined ? <div className="diff-view"><section><h2>Your draft</h2><pre>{document.content}</pre></section><section><h2>Version on disk</h2><pre>{document.externalContent}</pre></section><button onClick={() => setShowDiff(false)}>Close comparison</button></div> : <div className={`document-panes ${mode === "split" ? "is-split" : ""}`} style={splitStyle(splitRatio)}>
          {mode !== "preview" && <div key="editor" className="editor-pane">{mode === "split" && <div className="pane-caption"><Icon name="edit" /> Editor <span>Markdown</span></div>}<Suspense fallback={<div className="editor-loading" role="status">Opening editor…</div>}><MarkdownEditor position={scrollPosition} scrollHandle={editorScrollRef} key={document.path} value={document.content} lineNumbers={lineNumbers} readOnly={system.features.readOnly} jump={jump} onChange={content => setDocument(value => value ? { ...value, content, dirty: content !== value.savedContent } : value)} /></Suspense></div>}
          {mode === "split" && <SplitDivider ratio={splitRatio} onChange={setSplitRatio} />}
          {mode !== "edit" && <div key="preview" className="preview-pane">{mode === "split" && <div className="pane-caption"><Icon name="preview" /> Preview <span><i /> Live draft</span></div>}<MarkdownPreview position={scrollPosition} key={document.path} content={document.content} path={document.path} articleRef={previewRef} onWiki={target => void navigateWiki(target)} /></div>}
        </div>}

      </> : <VaultHome vault={system.vault.name} entries={tree} readOnly={system.features.readOnly} onOpen={requestOpen} onSearch={openSearch} onCreate={() => openMutation("file")} />}
      {document && <footer className="workspace-footer"><span><span className="footer-dot" /> {mode === "preview" ? "READING ROOM" : mode === "split" ? "WORDS & THEIR FORM" : "A LITTLE SPACE TO THINK"}</span><span>{Math.max(1, Math.ceil(wordCount / 220))} MIN READ <span className="footer-divider">/</span> MARKDOWN <span className="footer-divider">/</span> {focusMode ? "ESC TO LEAVE FOCUS" : system.features.readOnly ? "READ ONLY" : `${modKey} S TO SAVE`}</span></footer>}
    </main>

    {contextVisible && <aside className="context-panel">
      <div className="context-tabs" role="tablist" aria-label="Note context"><button className="icon-button context-close" aria-label="Hide context panel" onClick={() => setRightOpen(false)}><Icon name="close" /></button><button className={contextTab === "outline" ? "active" : ""} onClick={() => setContextTab("outline")} role="tab" aria-selected={contextTab === "outline"}>Outline</button><button className={contextTab === "backlinks" ? "active" : ""} onClick={() => setContextTab("backlinks")} role="tab" aria-selected={contextTab === "backlinks"}>Backlinks <span>{backlinks.length}</span></button></div>
      <div className="context-section-label">{contextTab === "outline" ? "ON THIS PAGE" : "CONNECTED THOUGHTS"}<span>{String(contextTab === "outline" ? outline.length : backlinks.length).padStart(2, "0")}</span></div>
      {document ? contextTab === "outline" ? <section className="outline-list">{outline.length ? outline.map(item => <button aria-current={activeHeading === item.line ? "location" : undefined} onClick={() => jumpToHeading(item.line)} key={`${item.line}-${item.text}`} style={{ paddingLeft: `${14 + (item.level - 1) * 12}px` }}><span>{item.text}</span><small>{item.line}</small></button>) : <ContextEmpty icon="book" title="No headings yet" body="Add a heading to create an outline." />}</section> : <section className="backlinks-list">{backlinks.length ? backlinks.map(item => <button className="backlink" key={item.path} onClick={() => requestOpen(item.path)}><span className="backlink-icon"><Icon name="link" /></span><span><strong>{fileTitle(item.path)}</strong><small>{item.references[0]?.context}</small></span></button>) : <ContextEmpty icon="link" title="No backlinks" body="Links to this note will appear here." />}</section> : <ContextEmpty icon="book" title="Nothing selected" body="Open a note to see its outline and backlinks." />}
      {document && <div className="note-metadata"><span>Note details</span><dl><div><dt>Location</dt><dd>{parentPath}</dd></div><div><dt>Words</dt><dd>{wordCount}</dd></div><div><dt>Format</dt><dd>Markdown</dd></div></dl></div>}
    </aside>}

    {confirmation && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirmation-title"><div className="modal-icon warning"><Icon name="info" /></div><h2 id="confirmation-title">{confirmation.title}</h2><p>{confirmation.body}</p><div className="modal-actions"><button onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-button" onClick={() => { confirmation.action(); setConfirmation(null); }}>Continue</button></div></div></div>}
    {pendingPath && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title"><div className="modal-icon warning"><Icon name="info" /></div><h2 id="unsaved-title">Save your changes?</h2><p>You have an unsaved draft. Choose what to do before opening another note.</p><div className="modal-actions"><button onClick={() => setPendingPath(null)}>Keep editing</button><button onClick={() => { const path = pendingPath; setPendingPath(null); void loadFile(path); }}>Discard</button><button className="primary-button" onClick={async () => { if (await save()) { const path = pendingPath; setPendingPath(null); void loadFile(path); } }}>Save & open</button></div></div></div>}
    {closingTab && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="close-tab-title"><div className="modal-icon warning"><Icon name="info" /></div><h2 id="close-tab-title">Close with unsaved changes?</h2><p>Save your changes to {closingTab.document ? fileTitle(closingTab.document.path) : "this note"} before closing its tab.</p><div className="modal-actions"><button onClick={() => setPendingCloseTab(null)}>Keep tab</button><button onClick={() => closeTabImmediately(closingTab.id)}>Discard & close</button><button className="primary-button" onClick={async () => { if (await save()) closeTabImmediately(closingTab.id); }}>Save & close</button></div></div></div>}
    {updatesOpen && <UpdatesDialog status={updateStatus} version={system.version} hasDrafts={tabs.some(tab => tab.document?.dirty)} onStatus={setUpdateStatus} onClose={() => setUpdatesOpen(false)} />}
    {mutationDialog && <MutationModal busy={mutating} error={error} dialog={mutationDialog} onChange={value => setMutationDialog(current => current ? { ...current, value } : null)} onClose={() => setMutationDialog(null)} onSubmit={submitMutation} />}
  </div>;
}

type TreeProps = {
  entries: TreeEntry[]; activePath?: string; draggedPath: string | null; dropTarget: string | null; readOnly: boolean;
  folderMenu: string | null; onFolderMenu: (path: string | null) => void; onFolderAction: (kind: "rename" | "delete", path: string) => void;
  onOpen: (path: string) => void; onDragStart: (path: string, event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void; onDropTarget: (path: string | null) => void; onMove: (path: string, directory: string) => Promise<void>; depth?: number;
};

function Tree(props: TreeProps) {
  const { entries, activePath, draggedPath, dropTarget, readOnly, folderMenu, onFolderMenu, onFolderAction, onOpen, onDragStart, onDragEnd, onDropTarget, onMove, depth = 0 } = props;
  return <nav className="tree" aria-label={depth === 0 ? "Vault files" : undefined}>{entries.map(entry => {
    if (entry.type === "directory") {
      const notes = countNotes(entry.children ?? []);
      // Clicks inside <summary> toggle the folder unless the default action is prevented.
      const action = (event: React.MouseEvent, run: () => void) => { event.preventDefault(); event.stopPropagation(); run(); };
      return <details key={entry.path} open>
        <summary className={`${dropTarget === entry.path ? "drop-active" : ""} ${folderMenu === entry.path ? "menu-open" : ""}`} style={{ paddingLeft: `${12 + depth * 14}px` }} onDragOver={event => { if (!draggedPath) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; onDropTarget(entry.path); }} onDragLeave={() => { if (dropTarget === entry.path) onDropTarget(null); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); const path = draggedPath ?? event.dataTransfer.getData("text/plain"); if (path) void onMove(path, entry.path); }}>
          <Icon name="chevron" /><Icon name="folder" /><span>{entry.name}</span>{notes > 0 && <small>{notes}</small>}
          {!readOnly && <button type="button" className="folder-more" aria-label={`Folder actions for ${entry.name}`} aria-expanded={folderMenu === entry.path} onClick={event => action(event, () => onFolderMenu(folderMenu === entry.path ? null : entry.path))}><Icon name="more" /></button>}
          {folderMenu === entry.path && <div className="folder-menu" role="menu" onClick={event => event.preventDefault()}>
            <button type="button" role="menuitem" onClick={event => action(event, () => onFolderAction("rename", entry.path))}><Icon name="edit" /> Rename or move folder</button>
            <button type="button" role="menuitem" className="danger" onClick={event => action(event, () => onFolderAction("delete", entry.path))}><Icon name="trash" /> Move folder to trash</button>
          </div>}
        </summary>
        <Tree {...props} entries={entry.children ?? []} depth={depth + 1} />
      </details>;
    }
    if (entry.type === "markdown") return <button className={`${entry.path === activePath ? "active" : ""} ${entry.path === draggedPath ? "dragging" : ""}`} draggable={!readOnly} onDragStart={event => onDragStart(entry.path, event)} onDragEnd={onDragEnd} key={entry.path} onClick={() => onOpen(entry.path)} title={entry.path} style={{ paddingLeft: `${30 + depth * 14}px` }} aria-label={`Open ${entry.name}`}><Icon name="document" /><span>{entry.name.replace(/\.md$/i, "")}</span>{entry.path === activePath && <span className="active-pip" />}</button>;
    return <a className={entry.path === draggedPath ? "dragging" : ""} draggable={!readOnly} onDragStart={event => onDragStart(entry.path, event)} onDragEnd={onDragEnd} key={entry.path} href={`/api/v1/asset?path=${q(entry.path)}`} target="_blank" rel="noreferrer" style={{ paddingLeft: `${30 + depth * 14}px` }}><Icon name="archive" /><span>{entry.name}</span></a>;
  })}</nav>;
}

function MutationModal({ busy, error, dialog, onChange, onClose, onSubmit }: { busy: boolean; error: string; dialog: MutationDialog; onChange: (value: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent) => void }) {
  const folder = dialog.target?.type === "directory";
  const subject = dialog.target?.path ?? (folder ? "This folder" : "This note");
  const copy = {
    file: { icon: "file-plus" as IconName, title: "Create a new note", body: "Choose a path inside your vault. The .md extension is added for you.", label: "Note path", placeholder: "Projects/New idea", action: "Create note" },
    directory: { icon: "folder-plus" as IconName, title: "Create a new folder", body: "Folders help keep related notes together.", label: "Folder path", placeholder: "Projects/Research", action: "Create folder" },
    rename: folder
      ? { icon: "edit" as IconName, title: "Rename or move folder", body: "Links to notes inside this folder are not updated automatically.", label: "New folder path", placeholder: "Areas/Research", action: "Apply changes" }
      : { icon: "edit" as IconName, title: "Rename or move note", body: "Existing links to this note are not updated automatically. The .md extension is kept.", label: "New path", placeholder: "Folder/Note", action: "Apply changes" },
    delete: { icon: "trash" as IconName, title: folder ? "Move folder to trash?" : "Move note to trash?", body: `${subject}${folder ? " and everything inside it" : ""} will move to .trash and can be recovered from the vault.`, label: "", placeholder: "", action: "Move to trash" }
  }[dialog.kind];
  const destructive = dialog.kind === "delete";
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="mutation-title" onSubmit={onSubmit}><div className={`modal-icon ${destructive ? "danger" : ""}`}><Icon name={copy.icon} /></div><h2 id="mutation-title">{copy.title}</h2><p>{copy.body}</p>{error && <p className="login-error" role="alert">{error}</p>}{!destructive && <label className="field-label">{copy.label}<input autoFocus value={dialog.value} onChange={event => onChange(event.target.value)} placeholder={copy.placeholder} /></label>}<div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className={destructive ? "danger-button" : "primary-button"} type="submit" disabled={busy || (!destructive && !dialog.value.trim())}>{copy.action}</button></div></form></div>;
}

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 40 44" fill="none" aria-hidden="true"><path d="M20 2 36 11v22L20 42 4 33V11Z" stroke="currentColor" strokeWidth="1.1"/><path d="m20 2 8 13-8 27-8-13Zm-8 27 24-18M4 33l24-18M4 11l16 7 16 15" stroke="currentColor" strokeWidth="1.1"/><path d="m20 18 8-3-8 27Z" fill="currentColor" opacity=".15"/></svg>;
}

function ConnectionNote() {
  // Describe the transport honestly: plain HTTP is only acceptable on loopback.
  const secure = location.protocol === "https:";
  const local = isLoopbackHost(location.hostname);
  const label = secure ? "HTTPS connection" : local ? "Local connection · not encrypted" : "Unencrypted connection · use HTTPS";
  return <small><span className={`sync-dot ${secure || local ? "online" : "offline"}`} /> {label}</small>;
}

function ContextEmpty({ icon, title, body }: { icon: IconName; title: string; body: string }) { return <div className="context-empty"><Icon name={icon} /><strong>{title}</strong><p>{body}</p></div>; }
function LoadingState({ error }: { error: string }) { return <main className="loading-screen"><div className="vault-mark large"><Icon name="sparkle" /></div><div className="loading-line" /><p>{error || "Opening your vault…"}</p></main>; }

function Login({ vault, methods, onSuccess, error }: { vault: string; methods: NonNullable<SystemInfo["auth"]>; onSuccess: () => Promise<void>; error: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => readStorage("owg-remember") === "true");
  const [message, setMessage] = useState(error);
  const [submitting, setSubmitting] = useState<"" | "password" | "passkey">("");
  const changeRemember = (value: boolean) => { setRemember(value); writeStorage("owg-remember", String(value)); };
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => { if (!cooldown) return; const timer = window.setTimeout(() => setCooldown(false), 1000); return () => window.clearTimeout(timer); }, [cooldown]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (submitting || cooldown) return; setMessage(""); setSubmitting("password");
    try { await login(methods.username ? username : null, password, remember); await onSuccess(); }
    catch (cause) { clearSession(); setMessage(cause instanceof ApiError && cause.status === 401 ? methods.username ? "Incorrect username or password." : "Incorrect password." : messageOf(cause)); setCooldown(true); }
    finally { setSubmitting(""); }
  };
  const signInWithPasskey = async () => {
    if (submitting || cooldown) return; setMessage(""); setSubmitting("passkey");
    try { await passkeyLogin(remember); await onSuccess(); }
    catch (cause) {
      clearSession();
      if (cause instanceof PasskeyCancelled) setMessage(cause.message);
      else { setMessage(cause instanceof ApiError && cause.status === 401 ? "This passkey was not accepted. Use a passkey registered in bookmarkd for this domain." : messageOf(cause)); setCooldown(true); }
    }
    finally { setSubmitting(""); }
  };
  const busyLabel = cooldown ? "Try again in a moment" : null;
  return <main className="login-screen"><section className="login-story" aria-label="Obsidian Web Gateway"><div className="brand"><BrandMark /><span>Obsidian<span>WEB GATEWAY</span></span></div><div className="login-story-copy"><span className="eyebrow">A SPACE OF YOUR OWN</span><h2>Good things<br />begin with<br /><em>a thought.</em></h2><p>Keep it. Connect it. Make it yours.</p></div><div className="login-orbits" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <span key={i} style={{ transform: `rotate(${i * 15}deg)` }} />)}</div><div className="login-story-footer"><span>YOUR NOTES. YOUR SPACE.</span><span>PLAIN TEXT. OPEN POSSIBILITIES.</span></div></section><div className="login-form-side"><form className="login-card" onSubmit={submit}>
    <div className="login-form-heading"><span className="eyebrow">YOUR PRIVATE LIBRARY</span><span className="login-section-number">01 — ACCESS</span></div><h1>Welcome<br /><em>back.</em></h1>
    <p>Sign in to open <strong>{vault}</strong>. Notes stay on the machine running this gateway.</p>
    <label className="remember-option"><input type="checkbox" checked={remember} onChange={event => changeRemember(event.target.checked)} /><span><strong>Keep me signed in for 30 days</strong><small>{remember ? "Stay signed in on this browser, even after restarts. Don’t use on shared computers." : "You’ll be signed out when you close the browser."}</small></span></label>
    {methods.passkey && <button className="primary-button login-button passkey-button" type="button" onClick={() => void signInWithPasskey()} disabled={!!submitting || cooldown}><Icon name="key" /> {submitting === "passkey" ? "Waiting for your passkey…" : busyLabel ?? "Sign in with a passkey"}</button>}
    {methods.passkey && methods.password && <div className="login-divider"><span>or use your password</span></div>}
    {methods.password && <>
      {methods.username && <label className="field-label">Username<input autoFocus={!methods.passkey} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} placeholder="Enter username" /></label>}
      <label className="field-label">Password<input type="password" autoFocus={!methods.passkey && !methods.username} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter vault password" /></label>
    </>}
    {message && <p className="login-error" role="alert"><Icon name="info" />{message}</p>}
    {methods.password && <button className={`${methods.passkey ? "secondary-button" : "primary-button"} login-button`} type="submit" disabled={!!submitting || cooldown || !password || (methods.username && !username.trim())}>{submitting === "password" ? "Opening vault…" : busyLabel ?? "Open vault"}</button>}
    <ConnectionNote />
  </form><div className="login-form-footer">A small gateway to a world of ideas.</div></div></main>;
}

function UpdatesDialog({ status, version, hasDrafts, onStatus, onClose }: { status: UpdateStatus | null; version: string; hasDrafts: boolean; onStatus: (status: UpdateStatus) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<UpdateSettings | null>(status?.settings ?? null);
  const [busy, setBusy] = useState<"" | "check" | "save" | "install">("");
  const [message, setMessage] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  useEffect(() => { if (!draft && status) setDraft(status.settings); }, [status, draft]);
  const dirty = !!draft && !!status && JSON.stringify(draft) !== JSON.stringify(status.settings);
  const run = async (kind: "check" | "save", request: () => Promise<UpdateStatus>) => {
    setBusy(kind); setMessage("");
    try {
      const next = await request();
      onStatus(next);
      if (kind === "save") { setDraft(next.settings); setMessage("Update settings saved."); }
      else setMessage(next.error ? "" : next.available ? `Version ${next.latest?.version} is available.` : "You are running the latest version.");
    } catch (cause) { setMessage(messageOf(cause)); } finally { setBusy(""); }
  };
  const install = async () => {
    const target = status?.latest?.version;
    if (!target) return;
    setBusy("install"); setMessage("");
    try {
      const result = await api<{ restarting: boolean }>("/api/v1/update/install", { method: "POST", body: JSON.stringify({ version: target }) });
      if (!result.restarting) { setMessage(`Version ${target} is installed. Restart the gateway to use it.`); setBusy(""); return; }
      setRestarting(target);
      // Wait for the restarted gateway to report the new version, then reload into it.
      const deadline = Date.now() + 90_000;
      const poll = async () => {
        try { if ((await api<SystemInfo>("/api/v1/system")).version === target) { window.location.reload(); return; } } catch { /* Restarting. */ }
        if (Date.now() < deadline) window.setTimeout(() => void poll(), 1500);
        else { setRestarting(null); setBusy(""); setMessage("The gateway did not come back with the new version. Check the server logs."); }
      };
      window.setTimeout(() => void poll(), 1500);
    } catch (cause) { setMessage(messageOf(cause)); setBusy(""); setConfirmInstall(false); }
  };
  const latest = status?.available ? status.latest : null;
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !restarting) onClose(); }}>
    <div className="modal updates-modal" role="dialog" aria-modal="true" aria-labelledby="updates-title">
      <div className="modal-icon"><Icon name="settings" /></div>
      <h2 id="updates-title">About and updates</h2>
      <div className="update-summary">
        <span>Version <strong>v{status?.current ?? version}</strong></span>
        {latest ? <span className="update-badge">v{latest.version} available{latest.prerelease ? " · prerelease" : ""}</span> : status?.checkedAt && !status.error ? <span className="update-current"><Icon name="check" /> Up to date</span> : null}
      </div>
      <p className="update-meta">{status?.checkedAt ? `Last checked ${new Date(status.checkedAt * 1000).toLocaleString()}` : "Not checked yet"}</p>
      {status?.error && <p className="login-error" role="alert"><Icon name="info" />Check failed: {status.error}</p>}
      {latest && <div className="release-notes"><div><strong>What’s new in v{latest.version}</strong><a href={latest.url} target="_blank" rel="noreferrer">Release page <Icon name="external" /></a></div><pre>{latest.notes || "No release notes."}</pre></div>}
      {restarting ? <p className="update-restarting" role="status"><span className="loading-line" />Installing v{restarting} and restarting. This page reloads automatically when the new version is ready.</p> : <>
        {latest && !status?.installable && <p className="update-meta">Automatic installation is not available on this platform{status?.platform ? ` (${status.platform})` : ""}. Download the release manually.</p>}
        {latest && status?.installable && hasDrafts && <p className="update-meta">Save your open drafts before installing; the gateway restarts during the update.</p>}
        {latest && status?.installable && confirmInstall && <p className="update-confirm">The gateway downloads v{latest.version}, verifies its checksum, replaces the current program, and restarts. The previous version is kept for rollback.</p>}
        <div className="modal-actions update-actions">
          <button type="button" onClick={() => void run("check", () => api<UpdateStatus>("/api/v1/update/check", { method: "POST" }))} disabled={!!busy}>{busy === "check" ? "Checking…" : "Check for updates"}</button>
          {latest && (status?.installable
            ? confirmInstall
              ? <button type="button" className="primary-button" onClick={() => void install()} disabled={!!busy || hasDrafts}><Icon name="download" /> {busy === "install" ? "Installing…" : `Install v${latest.version} and restart`}</button>
              : <button type="button" className="primary-button" onClick={() => setConfirmInstall(true)} disabled={!!busy || hasDrafts}><Icon name="download" /> Update to v{latest.version}</button>
            : <a className="primary-button" href={latest.url} target="_blank" rel="noreferrer"><Icon name="download" /> Download v{latest.version}</a>)}
        </div>
        {draft && <fieldset className="update-settings" disabled={!!busy}>
          <legend>Automatic checks</legend>
          <div className="update-fields">
            <label className="field-label">Frequency<select value={draft.schedule} onChange={event => setDraft({ ...draft, schedule: event.target.value as UpdateSettings["schedule"] })}><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
            {draft.schedule === "weekly" && <label className="field-label">Day<select value={draft.weekday} onChange={event => setDraft({ ...draft, weekday: Number(event.target.value) })}>{weekdays.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}</select></label>}
            {draft.schedule !== "off" && <label className="field-label">Time<input type="time" value={draft.time} onChange={event => setDraft({ ...draft, time: event.target.value })} /></label>}
            <label className="field-label">Channel<select value={draft.channel} onChange={event => setDraft({ ...draft, channel: event.target.value as UpdateSettings["channel"] })}><option value="stable">Stable releases</option><option value="prerelease">Include prereleases</option></select></label>
          </div>
          <p className="update-meta">Checks only report new versions; installing always needs your confirmation. Times use the server’s clock.</p>
        </fieldset>}
        {message && <p className="update-message" role="status">{message}</p>}
        <div className="modal-actions"><button type="button" onClick={onClose}>Close</button>{dirty && <button type="button" className="primary-button" onClick={() => void run("save", () => api<UpdateStatus>("/api/v1/update/settings", { method: "PATCH", body: JSON.stringify(draft) }))} disabled={!!busy}>{busy === "save" ? "Saving…" : "Save settings"}</button>}</div>
      </>}
    </div>
  </div>;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    focus: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>, home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/></>,
    archive: <><rect x="4" y="5" width="16" height="4" rx="1"/><path d="M6 9v10h12V9M10 13h4"/></>, "arrow-left": <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>, book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></>, check: <path d="m5 12 4 4L19 6"/>, chevron: <path d="m9 18 6-6-6-6"/>, close: <><path d="m6 6 12 12"/><path d="M18 6 6 18"/></>, document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>, download: <><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></>, key: <><circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 9-9M16 7l3 3M14 9l2 2"/></>, settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/></>, edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>, external: <><path d="M10 17l5-5-5-5"/><path d="M15 12H3M21 19V5a2 2 0 0 0-2-2h-6"/></>, "file-plus": <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></>, folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>, "folder-plus": <><path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>, link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></>, menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>, panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>, preview: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>, save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, sparkle: <path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7ZM5 16l.8 2.2L8 19l-2.2.8L5 22l-.8-2.2L2 19l2.2-.8Z"/>, trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></>
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
function withMarkdownExtension(path: string): string { return /\.md$/i.test(path) ? path : `${path}.md`; }
function isLoopbackHost(hostname: string): boolean { return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127\./.test(hostname); }
function readStorage(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function writeStorage(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ } }
function removeStorage(key: string): void { try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ } }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Unexpected error"; }
