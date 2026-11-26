import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DropdownMenu } from "radix-ui";
import { serverAddress } from "./ConnectionCard";
import { useSessionSidebar } from "./useSessionSidebar";
import { useWindowFullscreen } from "./useWindowFullscreen";
import "./window-fullscreen.css";
import { resolveAppTheme, validAppTheme, type AppTheme } from "./appThemes";
import "./immersive-session.css";
import { readProfiles, presetFor, usesMongoSrv } from "./databaseProfiles";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as appVersion } from "../package.json";
import { TerminalViewBoundary } from "./TerminalViewBoundary";
import { WorkspaceBoundary } from "./WorkspaceBoundary";
import { fuzzyMatch } from "./search";
import { snippetAvailable } from "./snippetScope";
import { connectSsh, type CredentialChallenge, type HostVerification, type SshResponse } from "./sshConnection";
import {
  Server,
  FolderTree,
  Star,
  History,
  KeyRound,
  Code2,
  Settings,
  TerminalSquare,
  Files,
  ArrowDownUp,
  Network,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  ChevronDown,
  Plus,
  Keyboard,
  ShieldCheck,
  X,
  CheckCircle2,
  AlertCircle,
  Activity,
  Database,
  Moon,
  Sun,
  ArrowRight,
  LoaderCircle,
  Layers,
  Zap,
  Cable,
  Fullscreen,
  Shrink,
} from "lucide-react";
import { request, subscribe, desktop } from "./api";
import {
  emptyConfig,
  normalizeConfig,
  message,
  uid,
  type Config,
  type Host,
  type Session,
  type Transfer,
  type KeyInfo,
  type Snippet,
} from "./types";
import { Button, IconButton, Modal, Field, ErrorBox, Confirm } from "./ui";
import { Hosts } from "./Hosts";
import { TerminalWorkspace, readLayout, type TerminalAction } from "./TerminalWorkspace";
import { PaneDock, useToolSlots } from "./PaneDock";
import { reorderSessions } from "./sessionOrder";
import { sessionTabId, isPaneView, resolveSplitPair, type PaneView } from "./terminalLayout";
import { closedTab, previousSession, reopenedFolder, visitSession, type ClosedTab, type RemoteFolder } from "./sessionHistory";
import { fileSessionBinding } from "./fileSessions";
import { captureLayout, restoreNamedLayout, type LayoutSnapshot, type NamedLayout } from "./namedLayouts";
import { NamedLayoutsDialog } from "./NamedLayoutsDialog";
import { forgetLayoutFolders, listedLayoutFolders, requestLayoutFolders } from "./layoutFolders";
import { useTerminalDirectory } from "./terminalDirectory";
import { numberSessionTabs } from "./terminalCommands";
import { protectsKeyboardInput, viewShortcut } from "./sessionShortcuts";
import { restoreWorkspace, serializeWorkspace, WORKSPACE_KEY } from "./workspaceState";
const FilesView = lazy(() =>
  import("./Files").then((module) => ({ default: module.FilesView })),
);
const Databases = lazy(() => import("./DatabaseWorkspace"));
const SerialWorkspace = lazy(() => import("./SerialWorkspace"));
const Transfers = lazy(() =>
  import("./Files").then((module) => ({ default: module.Transfers })),
);
const Keys = lazy(() =>
  import("./Management").then((module) => ({ default: module.Keys })),
);
const Snippets = lazy(() =>
  import("./Management").then((module) => ({ default: module.Snippets })),
);
const SettingsView = lazy(() =>
  import("./Management").then((module) => ({ default: module.SettingsView })),
);
const Monitoring = lazy(() =>
  import("./ServerTools").then((module) => ({ default: module.Monitoring })),
);
const Tunnels = lazy(() =>
  import("./ServerTools").then((module) => ({ default: module.Tunnels })),
);
type Toast = { id: string; text: string; error: boolean };
type ConnectionFlow = {
  host: Host;
  destination: "Terminal" | "Files" | "Database" | "Databases";
  replacementId: string | null;
  controller: AbortController;
  inFlight: boolean;
  onConnected?: (session: Session) => void;
  onCancelled?: () => void;
  stageForLayout?: boolean;
  recoverInPlace?: boolean;
};
const navigation = [
  { label: "Hosts", icon: Server },
  { label: "Favorites", icon: Star },
  { label: "Recent", icon: History },
  { label: "Groups", icon: FolderTree },
  { label: "SSH keys", icon: KeyRound },
  { label: "Snippets", icon: Code2 },
];
export default function App() {
  const [config, setConfig] = useState<Config>(emptyConfig);
  const configRef = useRef(config);
  configRef.current = config;
  const windowThemeSync = useRef<Promise<unknown>>(Promise.resolve());
  const [appearance, setAppearance] = useState<Exclude<AppTheme, "system">>(() => {
    const { appTheme, theme } = document.documentElement.dataset;
    return validAppTheme(appTheme) && appTheme !== "system" ? appTheme : theme === "light" ? "light" : "dark";
  });
  const appearanceMode = resolveAppTheme(appearance, "dark");
  const [loading, setLoading] = useState(desktop);
  const [loadError, setLoadError] = useState("");
  const [workspace, setWorkspace] = useState("default");
  const [pendingWorkspace, setPendingWorkspace] = useState<{id: string; view?: string} | null>(null);
  const [view, setView] = useState("Hosts");
  const [serialVisited, setSerialVisited] = useState(false);
  useEffect(() => { if (view === "Serial") setSerialVisited(true); }, [view]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [sessions, setSessions] = useState<Session[]>([]);
  const workspaceRestored = useRef(false);
  const [bulkClose, setBulkClose] = useState<string[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const intentionalDisconnects = useRef(new Set<string>());
  const reconnecting = useRef(new Map<string, AbortController>());
  const [active, setActive] = useState("");
  const [terminalLayout, setTerminalLayout] = useState(() => readLayout(true));
  const activeConnection = useRef(active);
  activeConnection.current = active;
  const pendingShellFocus = useRef<string | null>(null);
  const [dialogFocusRequest, requestDialogFocus] = useState(0);
  const restoreShellFocus = (event: Event) => {
    const intended = pendingShellFocus.current;
    pendingShellFocus.current = null;
    if (!intended || activeConnection.current !== intended || viewRef.current !== "Terminal") return;
    event.preventDefault();
    requestDialogFocus((revision) => revision + 1);
  };
  const remoteFolders = useRef(new Map<string, RemoteFolder>());
  const [, setFolderRevision] = useState(0);
  const [recentlyClosed, setRecentlyClosed] = useState<ClosedTab[]>([]);
  const pendingReopen = useRef<{ tab: ClosedTab; sameIdentity: boolean } | null>(null);
  const closingTabs = useRef(new Set<string>());
  const tabHistory = useRef<string[]>([]);
  const previousTab = useMemo(() => previousSession(tabHistory.current, sessions, active), [sessions, active]);
  useLayoutEffect(() => {
    tabHistory.current = visitSession(tabHistory.current, sessions, active);
  }, [active, sessions]);
  const lastClosed = recentlyClosed.find((tab) => config.hosts.some((host) => host.id === tab.hostId));
  const fileSessionId = active || null;
  const sessionDatabase = view === "Database";
  const databaseVisible = sessionDatabase || view === "Databases";
  const sessionWorkspace = view === "Terminal" || view === "Files" || sessionDatabase;
  const [transferScope, setTransferScope] = useState<{tabId:string; name:string; returnView:string} | null>(null);
  const tabForConnection = useRef(new Map<string,string>());
  useLayoutEffect(() => {
    for (const session of sessions) tabForConnection.current.set(session.id, session.tabId || session.id);
  }, [sessions]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const sessionTransfers = useMemo(() => {
    const current = new Map(sessions.map((session) => [session.tabId || session.id, session.id]));
    return transfers.map((transfer) => {
      const id = current.get(transfer.tabId || tabForConnection.current.get(transfer.sessionId) || transfer.sessionId);
      return id && id !== transfer.sessionId ? {...transfer, sessionId:id} : transfer;
    });
  }, [sessions, transfers]);
  const openAllTransfers = () => { setTransferScope(null); setView("Transfers"); };
  const transferEvents = useRef(0);
  const transferListRequest = useRef(0);
  const transferRevisions = useRef(new Map<string,number>());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [statusMessage, setStatusMessage] = useState<{ id: string; text: string } | null>(null);
  const [palette, setPalette] = useState<false | "quick" | "commands">(false);
  const [dbOpenRequest, setDbOpenRequest] = useState<{id:string; workspace:string; profile:string} | null>(null);
  const consumeDbOpen = useCallback((id: string) => setDbOpenRequest(item => item?.id === id ? null : item), []);
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const layoutAttempt = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => layoutAttempt.current?.abort(), [workspace]);
  const [connectHost, setConnectHost] = useState<Host | null>(null);
  const currentFlow = useRef<ConnectionFlow | null>(null);
  const duplicateSessionRef = useRef<Session | null>(null);
  const afterFileConnect = useRef<((sessionId: string) => void) | undefined>(undefined);
  const fileActionId = useRef(0);
  useLayoutEffect(() => { fileActionId.current++; }, [view, fileSessionId]);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [verification, setVerification] = useState<HostVerification | null>(null);
  const [challenge, setChallenge] = useState<CredentialChallenge | null>(null);
  const [newHost, setNewHost] = useState(0);
  const [filesOpened, setFilesOpened] = useState(false);
  const [databasesOpened, setDatabasesOpened] = useState(false);
  const [sqlFile, setSqlFile] = useState<{id:string;sessionId:string;hostId:string;name:string;text:string} | null>(null);
  const [firstFileDirty, setEditorDirty] = useState(false);
  const [secondFileDirty, setSecondFileDirty] = useState(false);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [firstQueryDirty, setQueriesDirty] = useState(false);
  const [secondQueryDirty, setSecondQueryDirty] = useState(false);
  const queriesDirty = firstQueryDirty || secondQueryDirty;
  const editorDirty = firstFileDirty || secondFileDirty || previewDirty;
  const activeWork = sessions.some(s => s.status === "connected") ||
    transfers.some(t => ["running", "queued", "conflict"].includes(t.status));
  const needsCloseConfirmation = useRef(false);
  needsCloseConfirmation.current = activeWork || editorDirty || queriesDirty;
  useEffect(() => {
    if (view === "Files") setFilesOpened(true);
    if (view === "Databases" || view === "Database") setDatabasesOpened(true);
  }, [view]);
  const [terminalAction, setTerminalAction] = useState<TerminalAction>();
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [closeApp, setCloseApp] = useState(false);
  const allowClose = useRef(false);
  const [paletteKeys, setPaletteKeys] = useState<KeyInfo[]>([]);
  const [reviewSnippet, setReviewSnippet] = useState<Snippet | null>(null);
  const activeSession = sessions.find((s) => s.id === active);
  const splitPair = terminalLayout.split !== "none"
    ? resolveSplitPair(sessions, active, terminalLayout.primaryTabId, terminalLayout.secondaryTabId)
    : undefined;
  const displayedPanes = !sessionWorkspace ? [] : splitPair || (activeSession ? [activeSession] : []);
  const modeForSession = (s: Session) => s.id === active && isPaneView(view)
    ? view : terminalLayout.paneViews[sessionTabId(s)] || "Terminal";
  const fileSlots = useToolSlots(displayedPanes.filter(s => modeForSession(s) === "Files"),
    sessions, filesOpened, view === "Files" && !activeSession);
  const databaseSlots = useToolSlots(displayedPanes.filter(s => modeForSession(s) === "Database"),
    sessions, databasesOpened, view === "Databases" || (sessionDatabase && !activeSession));
  const openPaneView = (id: string, mode: PaneView) => {
    setActive(id);
    setView(mode);
  };
  const focusSession = (id: string) => {
    if (id === active) return;
    const session = sessions.find(s => s.id === id);
    if (session && splitPair && sessionWorkspace)
      openPaneView(id, terminalLayout.paneViews[sessionTabId(session)] || "Terminal");
    else setActive(id);
  };
  useLayoutEffect(() => {
    if (!activeSession || !isPaneView(view)) return;
    const tab = sessionTabId(activeSession);
    const openTabs = new Set(sessions.map(sessionTabId));
    setTerminalLayout(current => {
      const entries = Object.entries(current.paneViews);
      if (current.paneViews[tab] === view && entries.every(([id]) => openTabs.has(id))) return current;
      return { ...current, paneViews: { ...Object.fromEntries(entries.filter(([id]) => openTabs.has(id))), [tab]: view } };
    });
  }, [sessions, activeSession?.id, view]);
  const reportedDirectory = useTerminalDirectory(activeSession?.status === "connected" ? active : undefined);
  function folderProps(session?: Session) {
    const activeBinding = session && fileSessionBinding(session.hostId, config.hosts);
    const rememberedFolder = session && remoteFolders.current.get(sessionTabId(session));
    return {
      followTerminalFolder: session?.followTerminalFolder ?? false,
      remoteFolder: rememberedFolder && rememberedFolder.binding === activeBinding ? rememberedFolder.path : undefined,
      onFollowTerminalFolderChange(enabled: boolean) {
        setSessions((items) => items.map((item) => item.id === session?.id ? { ...item, followTerminalFolder: enabled } : item));
      },
      onRemoteFolderListed(sessionId: string, path: string) {
        if (!session || !activeBinding || sessionId !== session.id ||
          !sessionsRef.current.some((item) => item.id === sessionId && item.status === "connected") ||
          fileSessionBinding(session.hostId, configRef.current.hosts) !== activeBinding) return;
        const tabId = sessionTabId(session);
        const previous = remoteFolders.current.get(tabId);
        if (previous?.binding === activeBinding && previous.path === path) return;
        remoteFolders.current.set(tabId, { binding: activeBinding, path });
        setFolderRevision((revision) => revision + 1);
      },
    };
  }
  const sharedFolderProps = { ...folderProps(activeSession), reportedDirectory: reportedDirectory ?? undefined };
  const fileSession = sessions.find((session) => session.id === fileSessionId);
  const displayedSession = view === "Files" ? fileSession : activeSession;
  const notify = useCallback((text: string, error = false) => {
    const id = uid();
    if (!error) {
      setStatusMessage({ id, text });
      window.setTimeout(() => setStatusMessage((current) => current?.id === id ? null : current), 5000);
      return;
    }
    setToasts((p) => [...p.filter((item) => item.text !== text).slice(-1), { id, text, error }]);
    window.setTimeout(
      () => setToasts((p) => p.filter((x) => x.id !== id)),
      error ? 10000 : 5000,
    );
  }, []);
  const reload = useCallback(async () => {
    const value = normalizeConfig(await request<Config>("state_load"));
    setConfig(value);
    if (!workspaceRestored.current) {
      workspaceRestored.current = true;
      try {
        const restored = restoreWorkspace(localStorage.getItem(WORKSPACE_KEY), value);
        setSessions(numberSessionTabs(restored.sessions, value.hosts));
        setActive(restored.view === "Files" && restored.fileSessionId ? restored.fileSessionId : restored.active);
        setWorkspace(restored.workspaceId);
        setView(restored.view);
      } catch {}
      return;
    }
    setWorkspace((current) =>
      value.workspaces.some((w) => w.id === current)
        ? current
        : value.workspaces[0].id,
    );
  }, []);
  useEffect(() => {
    if (!workspaceRestored.current || loading) return;
    try {
      if (config.settings.restoreWorkspace)
        localStorage.setItem(WORKSPACE_KEY, serializeWorkspace(sessions, active, fileSessionId, workspace, view));
      else localStorage.removeItem(WORKSPACE_KEY);
    } catch {}
  }, [sessions, active, fileSessionId, workspace, view, loading, config.settings.restoreWorkspace]);
  const save = useCallback(async (next: Config) => {
    if (loading || loadError) throw new Error("Reload your saved workspace before making changes.");
    await request("state_save", { config: next });
    setConfig(next);
  }, [loading, loadError]);
  const refreshTransfers = useCallback(() => {
    const since = transferEvents.current;
    const seq = ++transferListRequest.current;
    void request<Transfer[]>("transfer_list")
      .then((snapshot) => {
        if (seq !== transferListRequest.current) return;
        setTransfers((current) => {
          const recent = current.filter((item) => (transferRevisions.current.get(item.id) || 0) > since);
          const ids = new Set(recent.map((item) => item.id));
          return [...recent, ...snapshot.filter((item) => !ids.has(item.id))];
        });
      })
      .catch((e) => notify(message(e), true));
  }, [notify]);
  const recoverConnection = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const attempts = Math.max(
        0,
        Math.min(10, configRef.current.settings.reconnectAttempts),
      );
      if (
        !session ||
        !attempts ||
        intentionalDisconnects.current.has(sessionId) ||
        reconnecting.current.has(sessionId)
      )
        return;
      const controller = new AbortController();
      reconnecting.current.set(sessionId, controller);
      try {
        for (let attempt = 1; attempt <= attempts; attempt++) {
          notify(
            `Reconnecting to ${session.name} · attempt ${attempt} of ${attempts}`,
          );
          await new Promise((resolve) =>
            window.setTimeout(
              resolve,
              Math.max(1, configRef.current.settings.reconnectDelay) * 1000,
            ),
          );
          if (
            controller.signal.aborted || intentionalDisconnects.current.has(sessionId) ||
            !sessionsRef.current.some((item) => item.id === sessionId)
          )
            return;
          try {
            const result = await connectSsh(session.hostId, controller.signal);
            if (!("sessionId" in result)) {
              if (currentFlow.current || controller.signal.aborted) {
                if (!controller.signal.aborted) notify(`Reconnect ${session.name} to finish authentication.`, true);
                return;
              }
              const host = configRef.current.hosts.find(
                (item) => item.id === session.hostId,
              );
              if (host) {
                const destination = viewRef.current === "Database" ? "Database" : viewRef.current === "Files" ? "Files" : "Terminal";
                const flow = createFlow(host, destination, sessionId);
                flow.recoverInPlace = true;
                presentChallenge(flow, result);
              }
              return;
            }
            if (
              controller.signal.aborted || intentionalDisconnects.current.has(sessionId) ||
              !sessionsRef.current.some((item) => item.id === sessionId)
            ) {
              await request("ssh_disconnect", { sessionId: result.sessionId });
              return;
            }
            if (session.routeToken && session.routeToken !== result.routeToken) {
              remoteFolders.current.set(sessionTabId(session), { binding: fileSessionBinding(session.hostId, configRef.current.hosts), path: "." });
            }
            setSessions((items) =>
              items.map((item) =>
                item.id === sessionId
                  ? {
                      ...item,
                      id: result.sessionId,
                      tabId: sessionTabId(item),
                      routeToken: result.routeToken,
                      status: "connected",
                      disconnectReason: undefined,
                      latencyMs: result.latencyMs,
                    }
                  : item,
              ),
            );
            setActive((current) =>
              current === sessionId ? result.sessionId : current,
            );
            notify(`Reconnected to ${session.name}`);
            return;
          } catch (error) {
            if (controller.signal.aborted) return;
            if (attempt === attempts)
              notify(`Reconnection failed: ${message(error)}`, true);
          }
        }
      } finally {
        reconnecting.current.delete(sessionId);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!desktop) return;
    void reload()
      .catch((e) => setLoadError(message(e)))
      .finally(() => setLoading(false));
    refreshTransfers();
  }, []);
  useLayoutEffect(() => {
    if (loading) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const forcedColors = matchMedia("(forced-colors: active)");
    const apply = () => {
      const theme =
        config.settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : config.settings.theme;
      document.documentElement.dataset.theme = resolveAppTheme(theme, media.matches ? "dark" : "light");
      document.documentElement.dataset.appTheme = theme;
      setAppearance(theme);
      if (desktop) {
        windowThemeSync.current = windowThemeSync.current
          .then(() => request("window_theme", { theme }))
          .catch(() => {});
      }
    };
    apply();
    if (config.settings.theme === "system") media.addEventListener("change", apply);
    forcedColors.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      forcedColors.removeEventListener("change", apply);
    };
  }, [config.settings.theme, loading]);
  useEffect(() => {
    if (!desktop || loading) return;
    let disposed = false;
    let frame = 0;
    let timeout = 0;
    const reveal = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      void request("window_ready").catch(() => {});
    };
    void windowThemeSync.current.then(() => {
      if (disposed) return;
      // The second frame follows a paint opportunity. Hidden WebViews can suspend frames.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(reveal); });
      timeout = window.setTimeout(reveal, 180);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [loading]);
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void subscribe<{ sessionId: string; status: string; error?: string }>(
      "terminal-status",
      (p) => {
        if (intentionalDisconnects.current.delete(p.sessionId)) return;
        setSessions((items) =>
          items.map((s) =>
            s.id === p.sessionId ? { ...s, status: p.status, disconnectReason: p.error } : s,
          ),
        );
        const session = sessionsRef.current.find(item => item.id === p.sessionId);
        if (!session) return;
        if (p.sessionId !== activeConnection.current || viewRef.current !== "Terminal") {
          if (p.status === "error") notify(`${session.name}: ${p.error || "SSH connection lost"}`, true);
          if (p.status === "disconnected") notify(`${session.name} disconnected`);
        }
        if (p.status === "disconnected" || p.status === "error")
          void recoverConnection(p.sessionId);
      },
    ).then((fn) => (disposed ? fn() : cleanups.push(fn)));
    void subscribe<Transfer>("transfer-progress", (p) => {
      transferRevisions.current.set(p.id, ++transferEvents.current);
      setTransfers((list) => {
        const index = list.findIndex((t) => t.id === p.id);
        if (index < 0) return [p, ...list];
        return list.map((t) => (t.id === p.id ? p : t));
      });
      if (p.status === "completed")
        notify(`Transfer completed · ${p.source.split(/[\\/]/).pop()}`);
      if (p.status === "failed") notify(p.error || "Transfer failed", true);
    }).then((fn) => (disposed ? fn() : cleanups.push(fn)));
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [notify]);
  useEffect(() => {
    if (!desktop) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!allowClose.current && needsCloseConfirmation.current) {
          event.preventDefault();
          setCloseApp(true);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else cleanup = fn;
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  function createFlow(host: Host, destination: ConnectionFlow["destination"], replacementId: string | null) {
    dismissConnect();
    if (replacementId) reconnecting.current.get(replacementId)?.abort();
    const flow: ConnectionFlow = {host, destination, replacementId, controller: new AbortController(), inFlight: false};
    currentFlow.current = flow;
    setConnectHost(host);
    return flow;
  }
  function presentChallenge(flow: ConnectionFlow, result: Exclude<SshResponse, { sessionId: string }>) {
    if (currentFlow.current !== flow) return;
    setPassword("");
    setRemember(false);
    if ("verificationRequired" in result) {
      if (pendingReopen.current) pendingReopen.current.sameIdentity = false;
      setChallenge(null);
      setVerification(result);
    } else {
      setVerification(null);
      setChallenge(result);
    }
  }
  function showConnect(host: Host, destination: ConnectionFlow["destination"] = "Terminal", replacementId: string | null = null) {
    const flow = createFlow(host, destination, replacementId);
    void connect(flow);
    return flow;
  }
  function connectSavedRoute(hostId: string, signal: AbortSignal, destination: ConnectionFlow["destination"],
    replacementId?: string, stageForLayout = false): Promise<Session> {
    const host = configRef.current.hosts.find(item => item.id === hostId && item.workspaceId === workspace);
    const replaced = sessionsRef.current.find(s => s.id === replacementId && s.hostId === hostId);
    if (!host || (replacementId && !replaced)) return Promise.reject(new Error("Saved SSH route is unavailable."));
    if (signal.aborted) return Promise.reject(new Error("Connection cancelled"));
    const flow = createFlow(host, destination, replaced?.id || null);
    flow.stageForLayout = stageForLayout;
    return new Promise((resolve, reject) => {
      const cancel = () => { if (currentFlow.current === flow) dismissConnect(); };
      signal.addEventListener("abort", cancel, {once: true});
      flow.onCancelled = () => { signal.removeEventListener("abort", cancel); reject(new Error("SSH connection cancelled")); };
      flow.onConnected = session => { signal.removeEventListener("abort", cancel); resolve(session); };
      void connect(flow);
    });
  }
  function connectDatabaseRoute(hostId: string, signal: AbortSignal, replacementId?: string) {
    return connectSavedRoute(hostId, signal, viewRef.current === "Database" ? "Database" : "Databases", replacementId);
  }
  const reopenTab = (tab: ClosedTab) => {
    const host = config.hosts.find((item) => item.id === tab.hostId);
    if (!host) return;
    showConnect(host, tab.view);
    pendingReopen.current = { tab, sameIdentity: true };
  };
  function dismissConnect() {
    const previous = currentFlow.current;
    currentFlow.current = null;
    previous?.controller.abort();
    previous?.onCancelled?.();
    pendingReopen.current = null;
    duplicateSessionRef.current = null;
    afterFileConnect.current = undefined;
    setConnectHost(null);
    setConnecting(false);
    setPassword("");
    setChallenge(null);
    setVerification(null);
    setConnectError("");
    setRemember(false);
  }
  async function connect(flow: ConnectionFlow, options: Record<string, unknown> = {}) {
    if (flow !== currentFlow.current || flow.inFlight) return;
    flow.inFlight = true;
    const {host: connectHost, destination: connectDestination, replacementId: connectionReplacementId} = flow;
    setConnecting(true);
    setConnectError("");
    try {
      const result = await connectSsh(connectHost.id, flow.controller.signal, options);
      if (currentFlow.current !== flow) {
        if ("sessionId" in result) await request("ssh_disconnect", {sessionId: result.sessionId}).catch(() => {});
        return;
      }
      if (!("sessionId" in result)) {
        presentChallenge(flow, result);
        return;
      }
      const reopening = pendingReopen.current;
      const tabOptions = reopening?.tab || duplicateSessionRef.current;
      const newTabId = uid();
      const connectedSession: Session = {
        id: result.sessionId,
        tabId: newTabId,
        routeToken: result.routeToken,
        hostId: connectHost.id,
        name: tabOptions?.name || connectHost.name,
        status: "connected",
        latencyMs: result.latencyMs,
        groupId: tabOptions?.groupId,
        terminalProfileId: tabOptions?.terminalProfileId,
        fontSize: tabOptions?.fontSize,
      };
      if (flow.stageForLayout) {
        currentFlow.current = null;
        dismissConnect();
        flow.onConnected?.(connectedSession);
        return;
      }
      if (reopening) {
        const binding = fileSessionBinding(connectHost.id, configRef.current.hosts.map((host) =>
          host.id === connectHost.id ? connectHost : host));
        remoteFolders.current.set(newTabId, reopenedFolder(reopening.tab, binding, reopening.sameIdentity ? result.routeToken : undefined));
        setRecentlyClosed((items) => items.filter((item) => item !== reopening.tab));
        pendingReopen.current = null;
      }
      const replaced = sessionsRef.current.find((item) => item.id === connectionReplacementId);
      if (connectionReplacementId && !replaced) {
        dismissConnect();
        await request("ssh_disconnect", {sessionId: result.sessionId});
        return;
      }
      if (replaced?.routeToken && replaced.routeToken !== result.routeToken) {
        remoteFolders.current.set(sessionTabId(replaced), { binding: fileSessionBinding(connectHost.id, configRef.current.hosts), path: "." });
      }
      setSessions((items) =>
        connectionReplacementId &&
        items.some((item) => item.id === connectionReplacementId)
          ? items.map((item) =>
              item.id === connectionReplacementId
                ? { ...item, ...connectedSession, disconnectReason: undefined, tabId: item.tabId || item.id, name: item.name,
                    groupId: item.groupId, terminalProfileId: item.terminalProfileId, fontSize: item.fontSize }
                : item,
            )
          : numberSessionTabs([...items, connectedSession], configRef.current.hosts),
      );
      const keepCurrentView = flow.recoverInPlace &&
        (activeConnection.current !== connectionReplacementId || viewRef.current !== connectDestination);
      setActive(current => !flow.recoverInPlace || current === connectionReplacementId ? result.sessionId : current);
      if (connectDestination === "Files") {
        afterFileConnect.current?.(result.sessionId);
        afterFileConnect.current = undefined;
      }
      if (!keepCurrentView) setView(connectDestination);
      if (!keepCurrentView && connectDestination === "Terminal") {
        if (!replaced) setTerminalLayout(current => current.fullscreen ? current : {...current, fullscreen: true});
        pendingShellFocus.current = result.sessionId;
      }
      currentFlow.current = null;
      setConnecting(false);
      setConnectHost(null);
      setPassword("");
      setChallenge(null);
      setVerification(null);
      flow.onConnected?.(replaced ? {...connectedSession, tabId: sessionTabId(replaced), name: replaced.name} : connectedSession);
      notify(`Connected to ${connectHost.name}`);
      const updated = {
        ...configRef.current,
        hosts: configRef.current.hosts.map((host) =>
          host.id === result.hostId
            ? {
                ...host,
                lastConnected: new Date(
                  result.connectedAt || Date.now(),
                ).toISOString(),
              }
            : host,
        ),
      };
      void save(updated).catch(e => notify(message(e), true));
    } catch (e) {
      if (currentFlow.current === flow) setConnectError(message(e));
    } finally {
      flow.inFlight = false;
      if (currentFlow.current === flow) setConnecting(false);
    }
  }
  const disconnect = async (id: string) => {
    const session = sessionsRef.current.find((item) => item.id === id);
    if (!session || closingTabs.current.has(id)) return;
    if (currentFlow.current?.replacementId === id) dismissConnect();
    reconnecting.current.get(id)?.abort();
    closingTabs.current.add(id);
    if (session.status === "connected") intentionalDisconnects.current.add(id);
    try {
      if (session.status === "connected") {
        try {
          await request("ssh_disconnect", { sessionId: id });
        } catch (error) {
          if (message(error) !== "SSH session is disconnected") throw error;
        }
      }
      const tabId = sessionTabId(session);
      const entry = closedTab(session, view, remoteFolders.current.get(tabId));
      remoteFolders.current.delete(tabId);
      forgetLayoutFolders(session.id);
      setRecentlyClosed((items) => [entry, ...items].slice(0, 12));
      const remaining = sessionsRef.current.filter((item) => item.id !== id);
      sessionsRef.current = remaining;
      if (!remaining.length) setTerminalLayout(current => ({...current, fullscreen:false}));
      setSessions((list) => list.filter((s) => s.id !== id));
      const fallback = previousSession(tabHistory.current, remaining, id) || remaining[0];
      setActive((current) => current === id ? fallback?.id || "" : current);
    } catch (e) {
      intentionalDisconnects.current.delete(id);
      notify(message(e), true);
    } finally {
      closingTabs.current.delete(id);
    }
  };
  const closeOtherTabs = (id: string, side: "all" | "right") => {
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;
    const targets = sessions.filter((session, position) => session.id !== id && (side === "all" || position > index));
    if (!targets.length) return;
    setBulkClose(targets.map((session) => session.id));
  };
  const reconnect = async (id: string) => {
    if (closingTabs.current.has(id) || currentFlow.current?.replacementId === id) return;
    const session = sessionsRef.current.find((s) => s.id === id);
    const host = config.hosts.find((h) => h.id === session?.hostId);
    if (!host) {
      notify("The saved host for this session is unavailable.", true);
      return;
    }
    if (session?.status === "connected") intentionalDisconnects.current.add(id);
    reconnecting.current.get(id)?.abort();
    try {
      if (session?.status === "connected") {
        try {
          await request("ssh_disconnect", { sessionId: id });
        } catch (error) {
          if (message(error) !== "SSH session is disconnected") throw error;
        }
      }
      if (!sessionsRef.current.some(item => item.id === id) || closingTabs.current.has(id)) return;
      setSessions((p) =>
        p.map((s) => (s.id === id && s.status === "connected" ? { ...s, status: "disconnected" } : s)),
      );
      const flow = showConnect(host, sessionDatabase ? "Database" : view === "Files" ? "Files" : "Terminal", id);
      flow.recoverInPlace = true;
    } catch (e) {
      intentionalDisconnects.current.delete(id);
      notify(message(e), true);
    }
  };
  const addHost = () => {
    setView("Hosts");
    setNewHost((n) => n + 1);
  };
  const verifyLayoutSession = (session: Session) => request<void>("ssh_check_path_target", {
    sourceId: session.id, targetId: session.id,
  });
  async function verifyLayoutSnapshot(snapshot: LayoutSnapshot) {
    await Promise.all(snapshot.panes.map(pane => {
      const session = sessionsRef.current.find(item => sessionTabId(item) === pane.tabId && item.status === "connected" &&
        item.hostId === pane.hostId && item.routeToken === pane.routeToken);
      if (!session) throw new Error("A session disconnected. Reconnect before saving this layout.");
      return verifyLayoutSession(session);
    }));
  }
  async function openNamedLayout(layout: NamedLayout) {
    setLayoutsOpen(false);
    layoutAttempt.current?.abort();
    const controller = new AbortController();
    layoutAttempt.current = controller;
    try {
      await restoreNamedLayout(layout, {
        hosts: () => configRef.current.hosts.filter(host => host.workspaceId === workspace),
        sessions: () => sessionsRef.current,
        connect: hostId => connectSavedRoute(hostId, controller.signal, "Terminal", undefined, true),
        close: session => request<void>("ssh_disconnect", {sessionId:session.id}),
        signal: controller.signal, verify: verifyLayoutSession,
        commit: (pair, opened) => {
          const next = [...sessionsRef.current];
          for (const [index, session] of pair.entries()) {
            if (!opened.includes(session)) continue;
            const tabId = layout.panes[index].tabId;
            const saved = next.findIndex(item => sessionTabId(item) === tabId && item.hostId === session.hostId &&
              (item.status === "saved" || item.status === "disconnected") && !reconnecting.current.has(item.id));
            if (saved >= 0) {
              const old = next[saved];
              pair[index] = next[saved] = {...old, ...session, tabId, name:old.name, terminalProfileId:old.terminalProfileId,
                groupId:old.groupId, fontSize:old.fontSize};
            } else next.push(session);
          }
          const [first, second] = pair.map(sessionTabId);
          pair.forEach((session, index) => {
            const pane = layout.panes[index];
            if (pane.folders.remote) remoteFolders.current.set(sessionTabId(session), {binding:pane.binding, path:pane.folders.remote});
            requestLayoutFolders(session.id, pane.folders);
          });
          if (opened.length) setSessions(numberSessionTabs(next, configRef.current.hosts));
          setTerminalLayout(current => ({...current, fullscreen: opened.length > 0 || current.fullscreen, split:layout.split, ratio:layout.ratio, primaryTabId:first, secondaryTabId:second,
            paneViews:{...current.paneViews, [first]:layout.panes[0].view, [second]:layout.panes[1].view}}));
          setActive(pair[layout.activePane].id);
          setView(layout.panes[layout.activePane].view);
          if (layout.panes[layout.activePane].view === "Terminal") requestDialogFocus(n => n + 1);
        },
      });
    } catch (error) {
      if (!controller.signal.aborted && message(error) !== "SSH connection cancelled") notify(message(error), true);
    } finally {
      if (layoutAttempt.current === controller) layoutAttempt.current = null;
    }
  }
  const useRemotePath = async (
    sourceId: string, path: string,
    intentAction: { kind: "openHere" } | { kind: "insertPath" | "useFolder"; targetId: string },
  ) => {
    const source = sessions.find((s) => s.id === sourceId && s.status === "connected");
    if (view !== "Files" || fileSessionId !== sourceId || !source) return;
    const intent = ++fileActionId.current;
    const host = config.hosts.find((item) => item.id === source.hostId);
    if (!host) return;
    const binding = fileSessionBinding(host.id, config.hosts);
    const stillCurrent = () => fileActionId.current === intent &&
      fileSessionBinding(host.id, configRef.current.hosts) === binding &&
      sessionsRef.current.some((s) => s.id === sourceId && s.status === "connected");
    try {
      if (intentAction.kind !== "openHere") {
        const { targetId } = intentAction;
        await request("ssh_check_path_target", { sourceId, targetId });
        if (!stillCurrent() || !sessionsRef.current.some((s) =>
          s.id === targetId && s.hostId === host.id && s.status === "connected")) return;
        setActive(targetId);
        setTerminalAction({ kind: intentAction.kind, sessionId: targetId, data: path, id: intent });
      } else {
        const result = await request<{sessionId:string;latencyMs:number;routeToken:string}>("ssh_open_here", {sessionId:sourceId,path});
        if (!stillCurrent()) {
          await request("ssh_disconnect", {sessionId:result.sessionId});
          return;
        }
        const next:Session = {id:result.sessionId,tabId:uid(),hostId:host.id,name:host.name,routeToken:result.routeToken,
          status:"connected",latencyMs:result.latencyMs,terminalProfileId:source.terminalProfileId,fontSize:source.fontSize};
        setSessions((items)=>numberSessionTabs([...items,next],configRef.current.hosts));
        setActive(result.sessionId);
        setTerminalLayout(current => current.fullscreen ? current : {...current, fullscreen:true});
      }
      setView("Terminal");
    } catch (error) { notify(message(error),true); }
  };
  const nextTerminal = (delta: number) => {
    if (!sessions.length) return;
    const index = sessions.findIndex((s) => s.id === active);
    focusSession(sessions[(index + delta + sessions.length) % sessions.length].id);
    if (!sessionWorkspace) setView("Terminal");
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "F6" && view === "Files" && !e.ctrlKey && !e.shiftKey &&
          e.target instanceof Element && e.target.closest(".file-list") && !protectsKeyboardInput(e) &&
          sessions.some((item) => item.id === active && item.status === "connected")) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setView("Terminal");
        return;
      }
      if (palette && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && !e.isComposing && e.key.toUpperCase() === "P") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setPalette(false);
        return;
      }
      if (!e.ctrlKey || protectsKeyboardInput(e)) return;
      if (e.key === "Tab" && sessions.length) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) nextTerminal(e.shiftKey ? -1 : 1);
        return;
      }
      if (!e.shiftKey) return;
      if (sessionWorkspace && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat && previousTab) focusSession(previousTab.id);
        return;
      }
      const k = e.key.toUpperCase();
      if (sessionWorkspace && active && viewShortcut(config.settings.sessionViewShortcut) === "Ctrl+Shift+" + k) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setView(view === "Terminal" ? "Files" : "Terminal");
        return;
      }
      if (!["P", "T", "W", "F"].includes(k) || (k === "W" && (!active || !sessionWorkspace))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (k === "P") setPalette(p => p ? false : "commands");
      if (k === "T") setPalette("quick");
      if (k === "W" && active) void disconnect(active);
      if (k === "F") {
        setView("Terminal");
        setTerminalAction({ kind: "search", id: Date.now() });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [sessions, active, view, palette, previousTab, config.settings.sessionViewShortcut, terminalLayout]);
  useEffect(() => {
    if (palette && desktop)
      void request<KeyInfo[]>("keys_list")
        .then(setPaletteKeys)
        .catch(() => {});
  }, [palette]);
  const runSnippet = (reviewed: Snippet, sessionId: string) => {
    const current = configRef.current;
    const session = sessionsRef.current.find(item => item.id === sessionId);
    const host = current.hosts.find(item => item.id === session?.hostId);
    const saved = current.snippets.find(item => item.id === reviewed.id);
    if (!host || session?.status !== "connected" || activeConnection.current !== sessionId ||
        !saved || !snippetAvailable(saved, host.workspaceId, host.id)) {
      notify("The snippet or its destination changed. Choose the terminal and review the command again.", true);
      return;
    }
    setView("Terminal");
    setTerminalAction({ kind: "write", data: reviewed.command, sessionId, id: Date.now() });
  };
  const connectedCount = sessions.filter(s => s.status === "connected").length;
  const runningTransfers = transfers.filter(t => t.status === "running" || t.status === "queued").length;
  const windowFullscreen = useWindowFullscreen(notify);
  const immersive = windowFullscreen.active || (sessionWorkspace && terminalLayout.fullscreen && (!!activeSession || view === "Terminal"));
  const fullscreenLabel = windowFullscreen.active ? "Exit full screen" : "Enter full screen";
  const fullscreenButton = <IconButton label={fullscreenLabel} title={fullscreenLabel + " (F11)"} aria-keyshortcuts="F11"
    aria-pressed={windowFullscreen.active} onMouseDown={event => event.preventDefault()}
    onClick={() => {
      void windowFullscreen.toggle();
      if (view === "Terminal" || view === "Serial") {
        const selector = view === "Serial" ? ".serial-console:not([hidden])" : ".terminal-pane.focused";
        const input = document.querySelector<HTMLElement>(selector + " .xterm-helper-textarea");
        if (input?.getClientRects().length) input.focus({ preventScroll: true });
      }
    }}>{windowFullscreen.active ? <Shrink size={16}/> : <Fullscreen size={16}/>}</IconButton>;
  const focusTerminalAfterSidebar = useCallback(() => requestDialogFocus(value => value + 1), []);
  const drawer = useSessionSidebar(immersive, active, view, workspace, focusTerminalAfterSidebar);
  const collapsed = !immersive && config.settings.sidebarCollapsed;
  const currentNav = sessionDatabase ? "Databases" : view;
  const openTerminal = () => {
    setView("Terminal");
    if (view === "Terminal" && activeSession?.status === "connected")
      requestDialogFocus(revision => revision + 1);
  };
  const switchWorkspace = (id: string, destination?: string) => {
    if (id !== workspace && queriesDirty) {
      setPendingWorkspace({ id, view: destination });
      return;
    }
    if (id !== workspace) { dismissConnect(); setSqlFile(null); }
    setWorkspace(id);
    if (destination) setView(destination);
  };
  const toggleSidebar = () => {
    const next = { ...config, settings: { ...config.settings, sidebarCollapsed: !collapsed } };
    if (!desktop) { setConfig(next); return; }
    void save(next).catch(error => notify(message(error), true));
  };
  const nextTheme = appearanceMode === "light" ? "dark" : "light";
  const themeLabel = `Switch to ${nextTheme} mode`;
  const toggleTheme = async () => {
    try {
      await save({ ...config, settings: { ...config.settings, theme: nextTheme } });
      if (viewRef.current === "Terminal" && activeConnection.current === active)
        requestDialogFocus(revision => revision + 1);
    } catch (error) { notify(message(error), true); }
  };
  const actions: PaletteAction[] = [
    ...config.hosts.filter(h => h.workspaceId === workspace).map(h => ({
      id: h.id, name: h.name, group: "Hosts", kind: "ssh" as const,
      detail: serverAddress(h.username, h.hostname, h.port),
      method: h.authMethod === "key" ? "SSH key" : h.authMethod === "agent" ? "SSH agent" : "Password",
      run: () => showConnect(h),
    })),
    ...(palette ? readProfiles(workspace) : []).map(profile => {
      const preset = presetFor(profile);
      return { id: profile.id, name: profile.name, group: "Databases", kind: "database" as const, method: preset.title,
        detail: preset.engine === "sqlite" ? profile.path : serverAddress(profile.username, profile.host, usesMongoSrv(profile) ? undefined : profile.port),
        run: () => { setDbOpenRequest({ id: uid(), workspace, profile: profile.id }); setView("Databases"); } };
    }),

    {id:"saved-layouts", name:"Saved layouts", group:"Sessions", detail:"Save or open a split workspace", run:() => setLayoutsOpen(true)},
    ...(lastClosed ? [{
      id: "reopen-tab", name: "Reopen last closed tab", group: "Sessions",
      detail: lastClosed.name + " · New SSH connection", run: () => reopenTab(lastClosed),
    }] : []),
    ...(previousTab ? [{
      id: "previous-tab", name: "Switch to previous tab", group: "Sessions",
      detail: previousTab.name + " · Ctrl+Shift+Space",
      run: () => {
        if ((!sessionWorkspace || view === "Terminal") && previousTab.status === "connected") pendingShellFocus.current = previousTab.id;
        focusSession(previousTab.id);
        if (!sessionWorkspace) setView("Terminal");
      },
    }] : []),
    {
      id: "new",
      name: "Add a new host",
      group: "Actions",
      detail: "Save connection details",
      run: addHost,
    },
    {
      id: "terminal",
      name: "Open new terminal",
      group: "Actions",
      detail: "Choose a host below",
      run: () => setView("Hosts"),
    },
    {
      id: "databases",
      name: "Open databases",
      group: "Actions",
      detail: "Connect to a database and run queries",
      run: () => setView("Databases"),
    },
    { id: "serial", name: "Open serial console", group: "Actions", detail: "Connect to a COM port", run: () => setView("Serial") },
    {
      id: "files",
      name: "Open SFTP file manager",
      group: "Actions",
      detail: "Browse local and remote files",
      run: () => setView("Files"),
    },
    {
      id: "upload",
      name: "Upload files",
      group: "Actions",
      detail: "Select local files in file manager",
      run: () => setView("Files"),
    },
    {
      id: "download",
      name: "Download files",
      group: "Actions",
      detail: "Select remote files in file manager",
      run: () => setView("Files"),
    },
    {
      id: "settings",
      name: "Open settings",
      group: "Actions",
      detail: "Appearance, connections, backups",
      run: () => setView("Settings"),
    },
    {
      id: "keys",
      name: "Manage SSH keys",
      group: "Actions",
      detail: "Generate or import an identity",
      run: () => setView("SSH keys"),
    },
    {
      id: "theme",
      name: themeLabel,
      group: "Actions",
      detail: "Change appearance",
      run: () => void toggleTheme(),
    },
    ...config.groups.map((g) => ({
      id: g.id,
      name: g.name,
      group: "Groups",
      detail: config.workspaces.find((w) => w.id === g.workspaceId)?.name || "",
      run: () => switchWorkspace(g.workspaceId, "Groups"),
    })),
    ...sessions.map((s) => ({
      id: s.id,
      name: s.name,
      group: "Terminal sessions",
      detail: s.status,
      run: () => {
        if (s.status === "connected") pendingShellFocus.current = s.id;
        setActive(s.id);
        setView("Terminal");
      },
    })),
    ...config.snippets.filter(s => snippetAvailable(s, workspace, activeSession?.hostId)).map((s) => ({
      id: s.id,
      name: s.name,
      group: "Snippets",
      detail: s.command,
      run: () => {
        setReviewSnippet(s);
        setView("Snippets");
      },
    })),
    ...paletteKeys.map((k) => ({
      id: k.id,
      name: k.name,
      group: "SSH keys",
      detail: k.fingerprint,
      run: () => setView("SSH keys"),
    })),
    ...transfers.map((t) => ({
      id: t.id,
      name: t.source.split(/[\\/]/).pop() || t.source,
      group: "Transfer history",
      detail: `${t.direction} · ${t.status}`,
      run: openAllTransfers,
    })),
  ];
  return (
    <WorkspaceBoundary
      onRestore={() => {
        setPalette(false);
        dismissConnect();
        setVerification(null);
        setNewWorkspace(false);
        setCloseApp(false);
        setReviewSnippet(null);
        setTerminalAction(undefined);
        setNewHost(0);
        setFilesOpened(false);
        setEditorDirty(false);
        setPreviewDirty(false);
        setView("Hosts");
      }}
    >
      <div
        className={`app-shell ${windowFullscreen.active ? "window-fullscreen" : ""} ${immersive ? "immersive-session" : ""} ${collapsed ? "sidebar-collapsed" : ""} ${sessionWorkspace ? "terminal-layout" : ""} ${view === "Files" || sessionDatabase ? "session-files" : ""}`}
      >
        <a className="skip-link" href="#workspace">
          Skip to workspace
        </a>
        {drawer.overlay && <div className="session-sidebar-backdrop" aria-hidden="true"
          onPointerDown={e => e.preventDefault()} onClick={() => drawer.dismiss()} />}
        <aside id="workspace-sidebar" ref={drawer.sidebar} tabIndex={-1} className="sidebar" aria-label="Workspace sidebar"
          data-session-drawer={immersive ? (drawer.pinned ? "pinned" : drawer.overlay ? "open" : "closed") : undefined}
          inert={immersive && !drawer.visible}
          onClick={event => {
            if (!drawer.overlay || !(event.target instanceof Element)) return;
            const launchesPalette = event.target.closest('.quick-connect, [aria-label="Command palette"]');
            if (launchesPalette && view === "Terminal" && activeSession?.status === "connected") pendingShellFocus.current = active;
            if (launchesPalette || event.target.closest('nav button, [aria-label="Settings"]')) drawer.dismiss(false);
          }}>
          <div className="brand">
            <img
              className="brand-icon"
              src="/vexssh.svg"
              width={32}
              height={32}
              alt={collapsed ? "VEXSSH" : ""}
            />
            {!collapsed && (
              <span>
                VEXSSH
              </span>
            )}
          </div>
          <div className="workspace-switcher">
            {!collapsed && (
              <>
                <label className="sr-only" htmlFor="workspace-select">
                  Workspace
                </label>
                <select
                  id="workspace-select"
                  value={workspace}
                  onChange={(e) => switchWorkspace(e.target.value)}
                >
                  {config.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            {collapsed ? <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild><IconButton label="Switch workspace"><Layers size={17} /></IconButton></DropdownMenu.Trigger>
              <DropdownMenu.Portal><DropdownMenu.Content className="ui-menu" side="right" align="start" sideOffset={10} collisionPadding={8}>
                <DropdownMenu.RadioGroup value={workspace} onValueChange={id => switchWorkspace(id)}>
                  {config.workspaces.map(w => <DropdownMenu.RadioItem key={w.id} value={w.id}>
                    {w.name}<DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>)}
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Separator className="ui-menu-separator" />
                <DropdownMenu.Item onSelect={() => setNewWorkspace(true)}><Plus size={15} />Create workspace</DropdownMenu.Item>
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu.Root> : <IconButton label="Create workspace" onClick={() => setNewWorkspace(true)}><Plus size={16}/></IconButton>}
          </div>
          <button
            className="quick-connect"
            onClick={() => setPalette("quick")}
            title="Quick connect (Ctrl+Shift+T)"
            aria-label="Quick connect"
            aria-keyshortcuts="Control+Shift+T"
          >
            <Zap size={17} />
            {!collapsed && "Quick connect"}
          </button>
          <nav aria-label="Main navigation">
            <div className="nav-section-label">{!collapsed && "Workspace"}</div>
            {navigation.map(({ label, icon: Icon }) => (
              <button
                key={label}
                className={`nav-item ${view === label ? "active" : ""}`}
                aria-current={view === label ? "page" : undefined}
                onClick={() => setView(label)}
                title={collapsed ? label : undefined}
                aria-label={label}
              >
                <Icon size={18} />
                {!collapsed && (
                  <>
                    <span>{label}</span>
                    {label === "Hosts" && (
                      <small>
                        {
                          config.hosts.filter(
                            (h) => h.workspaceId === workspace,
                          ).length
                        }
                      </small>
                    )}
                  </>
                )}
              </button>
            ))}
            <div className="nav-section-label">{!collapsed && "Tools"}</div>
            {[
              { label: "Terminal", icon: TerminalSquare },
              { label: "Files", icon: Files },
              { label: "Serial", icon: Cable },
              { label: "Databases", icon: Database },
              { label: "Transfers", icon: ArrowDownUp },
              { label: "Monitoring", icon: Activity },
              { label: "Tunnels", icon: Network },
            ].map(({ label, icon: Icon }) => (
              <button
                key={label}
                className={`nav-item ${currentNav === label ? "active" : ""}`}
                aria-current={currentNav === label ? "page" : undefined}
                onClick={() => {
                  if (label === "Terminal") openTerminal();
                  else if (label === "Transfers") openAllTransfers();
                  else setView(label);
                }}
                title={collapsed ? label : undefined}
                aria-label={label}
              >
                <Icon size={18} />
                {!collapsed && (
                  <>
                    <span>{label}</span>
                    {label === "Terminal" && sessions.length > 0 && (
                      <small>{sessions.length}</small>
                    )}
                  </>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {view !== "Settings" && <button className="nav-item" type="button" disabled={loading || !!loadError}
              aria-label={themeLabel} title={themeLabel} onClick={() => void toggleTheme()}>
              {nextTheme === "light" ? <Sun size={17} /> : <Moon size={17} />}
              {!collapsed && <span>{nextTheme === "light" ? "Light mode" : "Dark mode"}</span>}
            </button>}
            <button
              className="nav-item"
              onClick={() => setPalette("commands")}
              title="Command palette (Ctrl+Shift+P)"
              aria-label="Command palette"
              aria-keyshortcuts="Control+Shift+P"
            >
              <Search size={17} />
              {!collapsed && (
                <>
                  <span>Search</span>
                  <kbd>Ctrl+Shift+P</kbd>
                </>
              )}
            </button>
            <button
              className={`nav-item ${view === "Settings" ? "active" : ""}`}
              aria-current={view === "Settings" ? "page" : undefined}
              onClick={() => setView("Settings")}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={17} />
              {!collapsed && <span>Settings</span>}
            </button>
            {immersive && <button type="button" className="nav-item" onClick={drawer.togglePin}
              aria-label={drawer.pinned ? "Unpin sidebar" : "Pin sidebar"} aria-pressed={drawer.pinned}>
              {drawer.pinned ? <PinOff size={17}/> : <Pin size={17}/>}
              <span>{drawer.pinned ? "Unpin sidebar" : "Pin sidebar"}</span>
            </button>}
            {(!immersive || !drawer.pinned) && <button
              className="nav-item collapse-button"
              disabled={loading || !!loadError}
              onClick={immersive ? () => drawer.dismiss() : toggleSidebar}
              aria-expanded={immersive ? drawer.visible : !collapsed}
              aria-label={immersive ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={immersive ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <PanelLeftOpen size={17} />
              ) : (
                <PanelLeftClose size={17} />
              )}{" "}
              {!collapsed && <span>{immersive ? "Close sidebar" : "Collapse sidebar"}</span>}
            </button>}
          </div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <div className="breadcrumb">
              {windowFullscreen.active && !sessionWorkspace && <Button variant="ghost" ref={drawer.trigger}
                aria-label="Sidebar" aria-controls="workspace-sidebar" aria-expanded={drawer.visible} onClick={drawer.toggle}>
                <PanelLeftOpen size={16}/>
              </Button>}
              <span>
                {config.workspaces.find((w) => w.id === workspace)?.name}
              </span>
              <span>/</span>
              <strong>{view === "Recent" ? "Recent connections" : view}</strong>
            </div>
            <div className="toolbar">
              {!sessionWorkspace && fullscreenButton}
              {displayedSession && (
                <button
                  className="active-connection"
                  title={`Open terminal for ${displayedSession.name}`}
                  onClick={() => {
                    setActive(displayedSession.id);
                    setView("Terminal");
                  }}
                >
                  <span
                    className={`status-dot ${displayedSession.status === "connected" ? "online" : "offline"}`}
                  />
                  {displayedSession.name}
                </button>
              )}
              <IconButton
                label="Command palette (Ctrl+Shift+P)"
                onClick={() => setPalette("commands")}
              >
                <Keyboard size={17} />
              </IconButton>
            </div>
          </header>
          {!desktop && (
            <div className="preview-banner">
              <AlertCircle size={15} />
              <span>
                Browser preview · Launch the desktop application to connect
                hosts and access local storage.
              </span>
            </div>
          )}
          <main id="workspace" className="workspace">
            <Suspense
              fallback={
                <div className="loading-block" role="status">
                  Opening workspace tool…
                </div>
              }
            >
              <ErrorBox error={loadError} />
              {loading ? (
                <div className="app-loading">
                  <LoaderCircle className="spin" />
                  <span>Opening your workspace…</span>
                </div>
                ) : loadError ? (
                  <Button onClick={() => window.location.reload()}>Reload workspace</Button>
              ) : (
                <>
                  {(serialVisited || view === "Serial") && <SerialWorkspace visible={view === "Serial"} workspace={workspace} config={config}
                    save={save} appearance={appearance} />}
                  {["Hosts", "Groups", "Favorites", "Recent"].includes(
                    view,
                  ) && (
                    <Hosts
                      config={config}
                      workspace={workspace}
                      sessions={sessions}
                      view={view}
                      save={save}
                      connect={showConnect}
                      notify={notify}
                      editRequest={newHost}
                      onEditRequestConsumed={() => setNewHost(0)}
                      transfers={transfers}
                      onOpenTransfers={openAllTransfers}
                    />
                  )}
                  <TerminalViewBoundary visible={view === "Terminal" || (!!splitPair && sessionWorkspace)} onRetry={() => setTerminalAction(undefined)}>
                    <TerminalWorkspace
                      onSavedLayouts={() => setLayoutsOpen(true)}
                      immersive={immersive && sessionWorkspace} sidebarOpen={drawer.visible} sidebarTrigger={drawer.trigger} onSidebar={drawer.toggle}
                      windowFullscreen={windowFullscreen.active} fullscreenButton={fullscreenButton}
                      layout={terminalLayout} setLayout={setTerminalLayout} openPaneView={openPaneView}
                      appearance={appearance}
                      {...sharedFolderProps}
                      onTransfersQueued={refreshTransfers}
                      onPreviewDirtyChange={setPreviewDirty}
                      sessions={sessions}
                      active={active}
                      setActive={focusSession}
                      onReorder={(sourceId, targetId, placement) =>
                        setSessions((items) =>
                          reorderSessions(items, sourceId, targetId, placement),
                        )
                      }
                      config={config}
                      onDisconnect={(id) => void disconnect(id)}
                      onReconnect={(id) => void reconnect(id)}
                      onDuplicate={(id) => {
                        const session = sessions.find((item) => item.id === id);
                        const host = config.hosts.find((item) => item.id === session?.hostId);
                        if (host) {
                          showConnect(host);
                          duplicateSessionRef.current = session || null;
                        }
                      }}
                      onCloseOthers={closeOtherTabs}
                      onUpdateSession={(id, patch) => setSessions((items) => items.map((session) => session.id === id ? { ...session, ...patch } : session))}
                      onNew={() => setPalette("quick")}
                      filesVisible={view === "Files"}
                      databaseVisible={sessionDatabase}
                      onDatabase={() => setView(activeSession ? "Database" : "Databases")}
                      onFiles={() => setView("Files")}
                      onTerminal={openTerminal}
                      transfers={sessionTransfers}
                      modeShortcutLabel={viewShortcut(config.settings.sessionViewShortcut)}
                      dialogFocusRequest={dialogFocusRequest}
                      onOpenSessionTransfers={(id) => {
                        const origin = sessions.find((item) => item.id === id);
                        if (!origin) return;
                        setTransferScope({ tabId: origin.tabId || id, name: origin.name, returnView: view });
                        setView("Transfers");
                      }}
                      onMonitor={() => setView("Monitoring")}
                      notify={notify}
                      visible={view === "Terminal"}
                      action={terminalAction}
                      onTerminalActionConsumed={(delivered) => setTerminalAction((current) => current === delivered ? undefined : current)}
                      rename={(id, name) =>
                        setSessions((p) =>
                          p.map((s) => (s.id === id ? { ...s, name } : s)),
                        )
                      }
                    />
                  </TerminalViewBoundary>
                  {fileSlots.map(({session, shown}, slot) => (
                    <PaneDock key={slot} sessionId={splitPair ? session?.id : undefined} visible={shown}
                      activate={() => { if (shown && session && session.id !== active) openPaneView(session.id, "Files"); }}>
                      <Suspense fallback={<div className="loading-block" role="status">Opening SFTP…</div>}>
                      <FilesView
                        {...folderProps(session)}
                        session={session}
                        sessions={sessions}
                        hosts={config.hosts}
                        transfers={transfers}
                        onOpenTerminalHere={(sourceId,path) => void useRemotePath(sourceId,path,{kind:"openHere"})}
                        onUseFolder={(sourceId,path) => void useRemotePath(sourceId,path,{kind:"useFolder",targetId:sourceId})}
                        onSqlFile={(sessionId, name, text) => {
                          const source = sessionsRef.current.find(s => s.id === sessionId && s.status === "connected");
                          if (!source || viewRef.current !== "Files" || sessionId !== activeConnection.current) return;
                          setSqlFile({ id: uid(), sessionId, hostId: source.hostId, name, text });
                          setView("Database");
                        }}
                        onInsertPath={(sourceId,targetId,path) => void useRemotePath(sourceId,path,{kind:"insertPath",targetId})}
                        onSelectSession={id => openPaneView(id, "Files")}
                        onConnectHost={(host, forceReconnect, onConnected) => {
                          const connected = session?.hostId === host.id && session.status === "connected" ? session : sessions.find(
                            (session) =>
                              session.hostId === host.id &&
                              session.status === "connected",
                          );
                          if (connected && !forceReconnect) {
                            openPaneView(connected.id, "Files");
                            onConnected?.(connected.id);
                          } else {
                            const saved = session?.hostId === host.id && session.status !== "connected" ? session.id : null;
                            showConnect(host, "Files", saved);
                            afterFileConnect.current = onConnected;
                          }
                        }}
                        notify={notify}
                        onTransfer={(openQueue = true) => {
                          refreshTransfers();
                          if (openQueue) openAllTransfers();
                        }}
                        theme={appearanceMode}
                        defaultDirectory={config.settings.downloadDirectory}
                        onDirtyChange={slot === 0 ? setEditorDirty : setSecondFileDirty}
                        visible={shown}
                        focused={shown && (!session || session.id === active)}
                      />
                      </Suspense>
                    </PaneDock>
                  ))}
                  {view === "Transfers" && (
                    <>
                    {transferScope && (
                      <div className="session-transfer-filter">
                        <strong>{transferScope.name}</strong>
                        <Button onClick={openAllTransfers}>Show all transfers</Button>
                        <Button onClick={() => setView(transferScope.returnView)}>Back to {transferScope.returnView === "Files" ? "SFTP" : transferScope.returnView === "Database" ? "database" : "terminal"}</Button>
                      </div>
                    )}
                    <Transfers
                      key={transferScope?.tabId || "all"}
                      sessionId={transferScope ? sessions.find((s) => (s.tabId || s.id) === transferScope.tabId)?.id : fileSession?.id}
                      transfers={transferScope ? transfers.filter(t => (t.tabId || tabForConnection.current.get(t.sessionId) || t.sessionId) === transferScope.tabId) : transfers}
                      refresh={refreshTransfers}
                      notify={notify}
                    />
                    </>
                  )}{" "}
                  {view === "SSH keys" && <Keys notify={notify} />}{" "}
                  {view === "Snippets" && (
                    <Snippets
                      config={config}
                      workspace={workspace}
                      session={activeSession}
                      save={save}
                      run={runSnippet}
                      reviewRequest={reviewSnippet}
                      onReviewConsumed={() => setReviewSnippet(null)}
                      notify={notify}
                    />
                  )}{" "}
                  {view === "Settings" && (
                    <SettingsView
                      appearance={appearance}
                      config={config}
                      save={save}
                      notify={notify}
                      reload={reload}
                    />
                  )}{" "}
                  {databaseSlots.map(({session, shown}, slot) => (
                    <PaneDock key={slot} sessionId={splitPair && view !== "Databases" ? session?.id : undefined}
                      visible={shown}
                      activate={() => { if (shown && session && view !== "Databases" && session.id !== active) openPaneView(session.id, "Database"); }}>
                      <Suspense fallback={<div className="loading-block" role="status">Opening databases…</div>}>
                        <Databases key={workspace} workspace={workspace} sessions={sessions} hosts={config.hosts} active={view === "Databases" ? active : session?.id || active} notify={notify}
                          openRequest={slot === 0 && view === "Databases" && dbOpenRequest?.workspace === workspace ? dbOpenRequest : null} onOpenConsumed={consumeDbOpen}
                          context={session && !(slot === 0 && view === "Databases") ? { sessionId: session.id, hostId: session.hostId, name: session.name } : undefined}
                          onConnectSsh={connectDatabaseRoute}
                          onDirtyChange={slot === 0 ? setQueriesDirty : setSecondQueryDirty}
                          fileRequest={sqlFile} onFileConsumed={(id) => setSqlFile(file => file?.id === id ? null : file)} />
                      </Suspense>
                    </PaneDock>
                  ))}
                  {view === "Monitoring" && (
                    <Monitoring session={activeSession?.status === "connected" ? activeSession : undefined} />
                  )}{" "}
                  {view === "Tunnels" && (
                    <Tunnels sessions={sessions} session={activeSession?.status === "connected" ? activeSession : undefined} notify={notify} />
                  )}
                </>
              )}
            </Suspense>
          </main>
          <footer className="statusbar">
            <span>
              <ShieldCheck size={13} />
              Local workspace
            </span>
            <span>
              {connectedCount} active {connectedCount === 1 ? "session" : "sessions"}
            </span>
            <div className="statusbar-spacer" />
            <span className="status-message" role="status" title={statusMessage?.text}>{statusMessage?.text}</span>
            {displayedSession && (
              <>
                <span>{displayedSession.name}</span>
                <span>{Math.round(displayedSession.latencyMs)} ms</span>
              </>
            )}
            <button onClick={openAllTransfers}>
              <ArrowDownUp size={13} />
              {runningTransfers} {runningTransfers === 1 ? "transfer" : "transfers"}
            </button>
            <span>VEXSSH {appVersion}</span>
          </footer>
        </div>
        <CommandPalette
          open={!!palette}
          quick={palette === "quick"}
          onClose={() => setPalette(false)}
          onCloseAutoFocus={restoreShellFocus}
          actions={actions}
        />
        {layoutsOpen && <NamedLayoutsDialog key={workspace} workspace={workspace} hosts={config.hosts}
          snapshot={sessionWorkspace ? captureLayout(terminalLayout, active, sessions, config.hosts.filter(host => host.workspaceId === workspace), session => {
            const listed = listedLayoutFolders(session.id);
            const drawer = remoteFolders.current.get(sessionTabId(session));
            if (drawer?.binding === fileSessionBinding(session.hostId, config.hosts)) listed.remote = drawer.path;
            return listed;
          }) : undefined}
          verifySnapshot={verifyLayoutSnapshot} onOpen={layout => void openNamedLayout(layout)} onClose={() => setLayoutsOpen(false)}/>}
        <Modal
          open={!!connectHost && !connecting && !!(verification || challenge || connectError)}
          onCloseAutoFocus={restoreShellFocus}
          onOpenChange={(v) => {
            if (!v) dismissConnect();
          }}
          title={
            verification
              ? verification.changed
                ? "Server identity has changed"
                : "Verify server identity"
              : `Connect to ${connectHost?.name || "host"}`
          }
          description={
            verification
              ? "Compare the SHA-256 fingerprint with a trusted source before approving."
              : `${connectHost?.username}@${connectHost?.hostname}:${connectHost?.port}`
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const flow = currentFlow.current;
              if (!flow) return;
              const options = verification ? {
                trustFingerprint: verification.fingerprint, trustHostId: verification.hostId,
                trustHostname: verification.hostname, trustPort: verification.port,
              } : challenge ? {
                credentialHostId: challenge.hostId, credentialRouteToken: challenge.routeToken,
                [challenge.credentialRequired]: password, saveCredential: challenge.credentialRequired === "password" && remember,
              } : {};
              void connect(flow, options);
            }}
          >
            <div className="modal-body">
              {verification ? (
                <>
                  <div
                    className={
                      verification.changed ? "warning-box" : "security-note"
                    }
                  >
                    <ShieldCheck size={20} />
                    <span>
                      {verification.changed
                        ? "The presented host key differs from the saved fingerprint. Confirm the change with the server administrator."
                        : `The identity of ${verification.hostname || connectHost?.hostname} has not been verified on this device.`}
                    </span>
                  </div>
                  <Field label="Presented fingerprint">
                    <code className="fingerprint">
                      {verification.fingerprint}
                    </code>
                  </Field>
                  {verification.previousFingerprint && (
                    <Field label="Previously saved fingerprint">
                      <code className="fingerprint">
                        {verification.previousFingerprint}
                      </code>
                    </Field>
                  )}
                </>
              ) : (
                <>
                  {challenge && (
                    <>
                      <div className="security-note"><ShieldCheck size={18} /><span>
                        Server identity verified · {config.hosts.find(host => host.id === challenge.hostId)?.name || connectHost?.name}
                      </span></div>
                      <Field label={challenge.credentialRequired === "password" ? "Password" : "Private key passphrase"} hint={challenge.message}>
                        <input type="password" required autoFocus autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} />
                      </Field>
                    </>
                  )}
                  {challenge?.credentialRequired === "password" && (
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={remember}
                          onChange={(e) => setRemember(e.target.checked)}
                        />
                        Remember credential in secure storage
                      </label>
                    )}
                </>
              )}
              <ErrorBox error={connectError} />
            </div>
            <footer className="modal-footer">
              <Button
                onClick={dismissConnect}
              >
                Cancel
              </Button>
              <Button
                variant={verification?.changed ? "danger" : "primary"}
                type="submit"
                busy={connecting}
              >
                {verification ? "Trust fingerprint & continue" : "Connect"}
              </Button>
            </footer>
          </form>
        </Modal>
        <Modal
          open={newWorkspace}
          onOpenChange={setNewWorkspace}
          title="Create workspace"
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const id = uid();
                await save({
                  ...config,
                  workspaces: [
                    ...config.workspaces,
                    { id, name: workspaceName.trim() },
                  ],
                });
                switchWorkspace(id);
                setWorkspaceName("");
                setNewWorkspace(false);
              } catch (e) {
                notify(message(e), true);
              }
            }}
          >
            <div className="modal-body">
              <Field label="Workspace name">
                <input
                  autoFocus
                  required
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="Infrastructure"
                />
              </Field>
            </div>
            <footer className="modal-footer">
              <Button variant="primary" type="submit">
                Create workspace
              </Button>
            </footer>
          </form>
        </Modal>
        <Confirm
          open={bulkClose.length > 0}
          title={`Close ${bulkClose.length} tabs?`}
          description="The selected terminals will disconnect. File operations that use these sessions may be interrupted."
          confirmLabel="Close tabs"
          danger
          onClose={() => setBulkClose([])}
          onConfirm={async () => {
            for (const id of bulkClose) await disconnect(id);
          }}
        />
        <Confirm open={!!pendingWorkspace} title="Switch workspace?"
          description="Unsaved query edits in this workspace will be discarded."
          confirmLabel="Discard and switch" danger onClose={() => setPendingWorkspace(null)}
          onConfirm={() => {
            if (!pendingWorkspace) return;
            setSqlFile(null);
            setWorkspace(pendingWorkspace.id);
            if (pendingWorkspace.view) setView(pendingWorkspace.view);
          }}
        />
        <Confirm
          open={closeApp}
          title="Close VEXSSH?"
          description={[
            editorDirty && "Unsaved file edits will be discarded.",
            queriesDirty && "Unsaved query edits will be discarded.",
            activeWork && "Active SSH sessions or transfers will be interrupted.",
          ].filter(Boolean).join(" ")}
          confirmLabel="Close application"
          onClose={() => setCloseApp(false)}
          onConfirm={async () => {
            allowClose.current = true;
            await getCurrentWindow().close();
          }}
        />
        <div className="toast-stack" aria-live="polite">
          {connecting && connectHost && <div className="toast ssh-connect-progress" role="status">
            <LoaderCircle className="spin" size={16} /><span>Connecting to {connectHost.name}…</span>
            <Button onClick={dismissConnect}>Cancel</Button>
            <IconButton label="Cancel SSH connection" onClick={dismissConnect}><X size={16}/></IconButton>
          </div>}
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast ${t.error ? "error" : ""}`}
              role={t.error ? "alert" : "status"}
            >
              {t.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
              <span>{t.text}</span>
              <IconButton
                label="Dismiss notification"
                onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      </div>
    </WorkspaceBoundary>
  );
}
interface PaletteAction {
  id: string;
  name: string;
  group: string;
  detail: string;
  kind?: "ssh" | "database";
  method?: string;
  run: () => void;
}
function CommandPalette({
  open,
  quick,
  onClose,
  onCloseAutoFocus,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  actions: PaletteAction[];
  quick: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const ordered = quick || query ? actions : [...actions.filter(a => !a.kind), ...actions.filter(a => a.kind)];
  const filtered = ordered
    .filter((a) => fuzzyMatch(query, `${a.name} ${a.detail} ${a.group}`))
    .slice(0, 60);
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    refs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const run = (action?: PaletteAction) => {
    if (action) {
      onClose();
      action.run();
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={quick ? "Quick connect" : "Command palette"}
      onCloseAutoFocus={onCloseAutoFocus}
      description="Search connections, sessions, snippets, keys, and actions."
      wide
    >
      <div className="palette-search">
        <Search size={21} />
        <input
          autoFocus
          aria-label="Search commands"
          placeholder={quick ? "Search host, database, or address…" : "Search commands and connections…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((i) => Math.min(i + 1, filtered.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((i) => Math.max(i - 1, 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[selected]);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="palette-results connection-picker">
        {!filtered.length && (
          <div className="compact-empty">No matching hosts or commands.</div>
        )}
        {filtered.map((a, index) => (
          <Fragment key={`${a.group}-${a.id}`}>
            {(index === 0 || filtered[index - 1].group !== a.group) && (
              <div className="palette-group">{a.group}</div>
            )}
            <button
              ref={(el) => {
                refs.current[index] = el;
              }}
              className={"palette-result " + (a.kind ? "picker-card " : "") + (selected === index ? "selected" : "")}
              onClick={() => run(a)}
              onMouseMove={() => setSelected(index)}
            >
              {a.kind && (a.kind === "ssh" ? <Server size={18}/> : <Database size={18}/>)}
              <span>
                <strong>{a.name}</strong>
                <small>{a.detail}</small>
              </span>
              {a.method ? <small className="picker-method">{a.method}</small> : <ArrowRight size={16} />}
            </button>
          </Fragment>
        ))}
      </div>
      <footer className="palette-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to navigate
        </span>
        <span>
          <kbd>Enter</kbd> to open
        </span>
      </footer>
    </Modal>
  );
}
