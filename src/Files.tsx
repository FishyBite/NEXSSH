import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { StreamLanguage } from "@codemirror/language";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import {
  Folder,
  File,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  FolderPlus,
  Pencil,
  Trash2,
  LockKeyhole,
  Upload,
  Download,
  Search,
  X,
  Save,
  FileCode,
  HardDrive,
  Server,
  ChevronDown,
  Check,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  History,
  GitCompare,
  Home,
  LoaderCircle,
  MoreHorizontal,
  TerminalSquare,
  FileText,
  FolderHeart,
  Link2,
} from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import type { FileEntry, Host, Session, Transfer } from "./types";
import { formatBytes, message } from "./types";
import { request } from "./api";
import { parentPath } from "./paths";
import { fileSessionBinding } from "./fileSessions";
import { HostMark, sessionHostLabel } from "./HostIdentity";
import { serverAddress } from "./ConnectionCard";
import { useTerminalDirectory } from "./terminalDirectory";
import { consumeLayoutFolders, listedLayoutFolders, recordLayoutFolder, useLayoutFolders } from "./layoutFolders";
import { sessionTabId } from "./terminalLayout";
import {
  incomingTransfers,
  pairStorage,
  readPairs,
  type FolderPair,
} from "./fileLocations";
import {
  LogPanel,
  PairDialog,
  useConflictReview,
  type LogSource,
} from "./FileToolPanels";
import {
  acceptFileDrop,
  captureFileDrag,
  fileContextReady,
  fileDropHeading,
  joinFilePath as joinPath,
  type FileDragContext,
  type FileSide as Side,
  type FileTransferPlan,
} from "./fileTransferDrag";
import { useFileDrag, useNativeFileDrop, type NativeDropPreview } from "./useFileDrag";
import { queueFileTransfers } from "./queueFileTransfers";
import { checksumFiles } from "./fileChecksums";
import { FileChecksum } from "./FileChecksum";
import { EnvironmentBadge } from "./EnvironmentBadge";
import {
  compareFolderEntries,
  folderScope,
  navigationStorageKey,
  putFolderScope,
  readFolderStore,
  rememberFolder,
  toggleFolderBookmark,
  visitFolder,
  type Comparison,
  type FolderHistory,
  type FolderScope,
} from "./fileNavigation";
import "./files-polish.css";
import {
  Button,
  IconButton,
  Field,
  Modal,
  Confirm,
  Empty,
  ErrorBox,
  PageHeader,
  clockDate,
} from "./ui";
type PaneData = { path: string; entries: FileEntry[] };
type PanePosition = {
  listing?: PaneData;
  history?: FolderHistory;
  selected: string[];
  scrollTop: number;
  filter: string;
  sort: string;
};
type FileTabPosition = {
  binding: string;
  connection?: string;
  local: PanePosition;
  remote: PanePosition;
  focus?: {
    side: Side;
    row?: string;
    checkbox?: boolean;
    field?: "path" | "filter";
  };
};
function emptyPosition(): PanePosition {
  return { selected: [], scrollTop: 0, filter: "", sort: "name" };
}
const noTransfers: Transfer[] = [];
type FollowListings = { running: number; pending?: () => Promise<void>; epoch?: number };
function startPendingFollow(queue: FollowListings) {
  if (queue.running >= 2 || !queue.pending) return;
  const read = queue.pending;
  queue.pending = undefined;
  queue.running++;
  void read().finally(() => {
    queue.running--;
    startPendingFollow(queue);
  });
}
type EditorFile = {
  side: Side;
  path: string;
  content: string;
  revision: string;
  saved: string;
  sessionId?: string;
  serverName?: string;
};
export function FilesView({
  session,
  sessions,
  hosts,
  onSelectSession,
  onConnectHost,
  notify,
  onTransfer,
  theme,
  defaultDirectory,
  onDirtyChange,
  visible,
  focused = visible,
  transfers = noTransfers,
  onOpenTerminalHere,
  onUseFolder,
  onInsertPath,
  onSqlFile,
  remoteFolder,
  reportedDirectory: providedDirectory,
  followTerminalFolder = false,
  onFollowTerminalFolderChange,
  onRemoteFolderListed,
}: {
  session?: Session;
  sessions: Session[];
  hosts: Host[];
  onSelectSession: (sessionId: string) => void;
  onConnectHost: (
    host: Host,
    reconnect?: boolean,
    onConnected?: (id: string) => void,
  ) => void;
  transfers?: Transfer[];
  remoteFolder?: string;
  reportedDirectory?: string;
  followTerminalFolder?: boolean;
  onFollowTerminalFolderChange?: (enabled: boolean) => void;
  onRemoteFolderListed?: (sessionId: string, path: string) => void;
  onOpenTerminalHere?: (sourceSessionId: string, path: string) => void;
  onUseFolder?: (sourceSessionId: string, path: string) => void;
  onSqlFile?: (sourceSessionId: string, name: string, text: string) => void;
  onInsertPath?: (
    sourceSessionId: string,
    targetSessionId: string,
    path: string,
  ) => void;
  notify: (s: string, error?: boolean) => void;
  onTransfer: (openQueue?: boolean) => void;
  theme: string;
  defaultDirectory: string;
  onDirtyChange: (dirty: boolean) => void;
  visible: boolean;
  focused?: boolean;
}) {
  const shellDirectory = useTerminalDirectory(session?.status === "connected" ? session.id : undefined);
  const reportedDirectory = providedDirectory ?? shellDirectory ?? undefined;
  const [local, setLocal] = useState<PaneData>({ path: "", entries: [] });
  const [remote, setRemote] = useState<PaneData>({ path: ".", entries: [] });
  const [remoteOwner, setRemoteOwner] = useState<string>();
  const [selected, setSelected] = useState<Record<Side, string[]>>({
    local: [],
    remote: [],
  });
  const [busy, setBusy] = useState<Record<Side, boolean>>({
    local: false,
    remote: false,
  });
  const [errors, setErrors] = useState<Record<Side, string>>({
    local: "",
    remote: "",
  });
  const [protocol, setProtocol] = useState("sftp");
  const [comparisonEnabled, setComparisonEnabled] = useState(false);
  const [folderStore, setFolderStore] = useState(() => {
    try {
      return readFolderStore(localStorage.getItem(navigationStorageKey));
    } catch {
      return readFolderStore(null);
    }
  });
  const folderStoreRef = useRef(folderStore);
  folderStoreRef.current = folderStore;
  const attempts = useRef<
    Record<Side, { path: string; historyIndex?: number }>
  >({ local: { path: "" }, remote: { path: "." } });
  const [chooserOpen, setChooserOpen] = useState(false);
  const [pairsOpen, setPairsOpen] = useState(false);
  const [pairs, setPairs] = useState<FolderPair[]>(() => {
    try {
      return readPairs(localStorage.getItem(pairStorage));
    } catch {
      return [];
    }
  });
  const [pendingPair, setPendingPair] = useState<{
    id: string;
    pair: FolderPair;
  } | null>(null);
  const [log, setLog] = useState<LogSource | null>(null);
  const [insert, setInsert] = useState<{
    id: string;
    binding: string;
    path: string;
  } | null>(null);
  const [serverQuery, setServerQuery] = useState("");
  const chooserList = useRef<HTMLDivElement>(null);
  const selectedHost = hosts.find((host) => host.id === session?.hostId);
  const boundServers = useRef(
    new Map<string, { signature: string; host?: Host }>(),
  );
  if (session && !boundServers.current.has(session.id)) {
    boundServers.current.set(session.id, {
      signature: fileSessionBinding(session.hostId, hosts),
      host: selectedHost ? { ...selectedHost } : undefined,
    });
  }
  const boundServer = session
    ? boundServers.current.get(session.id)
    : undefined;
  const profileChanged =
    !!session &&
    boundServer?.signature !== fileSessionBinding(session.hostId, hosts);
  const displayHost = profileChanged ? boundServer?.host : selectedHost;
  const remoteAvailable = session?.status === "connected" && !profileChanged;
  const restoredFolders = useLayoutFolders(remoteAvailable ? session?.id : undefined);
  const remoteBinding = boundServer?.signature || "";
  const tabId = session ? sessionTabId(session) : "";
  const positions = useRef(new Map<string, FileTabPosition>());
  let tabPosition = positions.current.get(tabId);
  if (!tabPosition || tabPosition.binding !== remoteBinding) {
    tabPosition = {
      binding: remoteBinding,
      local: emptyPosition(),
      remote: emptyPosition(),
    };
    positions.current.set(tabId, tabPosition);
  }
  const position = tabPosition;
  const currentPosition = useRef(position);
  currentPosition.current = position;
  const pageRef = useRef<HTMLElement>(null);
  const dragHelpId = useId();
  const scopeFor = (side: Side) =>
    folderScope(
      folderStore,
      side === "local" ? "local" : `host:${session?.hostId || "none"}`,
      side === "local" ? "" : remoteBinding,
    );
  const saveFolderScope = (scope: FolderScope) => {
    const next = putFolderScope(folderStoreRef.current, scope);
    folderStoreRef.current = next;
    setFolderStore(next);
    try {
      localStorage.setItem(navigationStorageKey, JSON.stringify(next));
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
  };
  const connectedSessions = sessions.filter((item) => {
    const binding = boundServers.current.get(item.id);
    return (
      item.status === "connected" &&
      (!binding || binding.signature === fileSessionBinding(item.hostId, hosts))
    );
  });
  const sameServerTabs = connectedSessions.filter(
    (item) => item.hostId === session?.hostId,
  );
  const activeLogSession = sessions.find((item) => item.id === log?.sessionId);
  const matchingServer = (host: Host | undefined, name = "") =>
    `${name} ${host?.name || ""} ${host?.username || ""} ${host?.hostname || ""}`
      .toLowerCase()
      .includes(serverQuery.trim().toLowerCase());
  const matchingSessions = connectedSessions.filter((item) =>
    matchingServer(
      hosts.find((host) => host.id === item.hostId),
      item.name,
    ),
  );
  const matchingHosts = hosts.filter(
    (host) =>
      !connectedSessions.some((item) => item.hostId === host.id) &&
      matchingServer(host),
  );
  const [paneWidth, setPaneWidth] = useState(50);
  const epochs = useRef({ local: 0, remote: 0 });
  const followListings = useRef<FollowListings>({ running: 0 });
  const currentSession = useRef(session?.id);
  currentSession.current = remoteAvailable ? session?.id : undefined;
  const editorReadEpoch = useRef(0);
  const editorReadSession = useRef<string | undefined>(undefined);
  const [editor, setEditor] = useState<EditorFile | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [editorDiscard, setEditorDiscard] = useState(false);
  const [form, setForm] = useState<{
    side: Side;
    action: string;
    entry?: FileEntry;
    value: string;
    path: string;
    sessionId?: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    side: Side;
    entries: FileEntry[];
    sessionId?: string;
    location: string;
    folder: string;
  } | null>(null);
  const remoteDirectory =
    remoteOwner === session?.id && remoteAvailable
      ? remote
      : { path: ".", entries: [] };
  const data = (side: Side) => (side === "local" ? local : remoteDirectory);
  const payload = (side: Side, sessionId?: string) => ({
    side,
    sessionId: side === "remote" ? sessionId : undefined,
  });
  const dragContext = useRef<FileDragContext>(null!);
  dragContext.current = {
    visible,
    blocked:
      chooserOpen ||
      pairsOpen ||
      !!insert ||
      !!form ||
      !!deleting ||
      !!editor ||
      editorBusy,
    sessionId: session?.id,
    sessionName: displayHost?.name || session?.name || "server",
    binding: remoteBinding,
    remoteReady: remoteAvailable && remoteOwner === session?.id,
    panes: {
      local: {
        ...local,
        epoch: epochs.current.local,
        busy: busy.local,
        error: errors.local,
      },
      remote: {
        ...remoteDirectory,
        epoch: epochs.current.remote,
        busy: busy.remote,
        error: errors.remote,
      },
    },
  };
  const readDragContext = (): FileDragContext => ({
    ...dragContext.current,
    panes: {
      local: {
        ...dragContext.current.panes.local,
        epoch: epochs.current.local,
      },
      remote: {
        ...dragContext.current.panes.remote,
        epoch: epochs.current.remote,
      },
    },
  });
  const commitListing = (side: Side, result: PaneData) => {
    if (session && remoteAvailable && dragContext.current.visible)
      recordLayoutFolder(session.id, side, result.path);
    const pane = position[side];
    if (pane.listing?.path !== result.path) {
      pane.scrollTop = 0;
      pane.selected = [];
    } else if (pane.selected.length) {
      const present = new Set(result.entries.map((e) => e.path));
      pane.selected = pane.selected.filter((p) => present.has(p));
    }
    pane.listing = result;
    if (side === "local") setLocal(result);
    else {
      position.connection = session?.id;
      setRemote(result);
      setRemoteOwner(session?.id);
      if (session && dragContext.current.visible)
        onRemoteFolderListed?.(session.id, result.path);
    }
    const valid = pane.selected;
    setSelected((current) => ({ ...current, [side]: valid }));
  };
  const load = (
    side: Side,
    path = data(side).path,
    historyIndex?: number,
    background = false,
    origin: "navigation" | "follow" = "navigation",
  ) => {
    if (
      position !== currentPosition.current ||
      (side === "remote" &&
        (!remoteAvailable || session?.id !== currentSession.current))
    )
      return;
    const epoch = ++epochs.current[side];
    const sessionId = session?.id;
    const scopeKey =
      side === "local" ? "local" : `host:${session?.hostId || "none"}`;
    const binding = side === "local" ? "" : remoteBinding;
    attempts.current[side] = { path, historyIndex };
    if (!background) setBusy((p) => ({ ...p, [side]: true }));
    setErrors((p) => ({ ...p, [side]: "" }));
    const read = async () => {
      try {
        const result = await request<PaneData>("file_list", {
          ...payload(side, sessionId),
          path,
        });
        if (
          epoch !== epochs.current[side] ||
          (side === "remote" && sessionId !== currentSession.current)
        )
          return;
        commitListing(side, result);
        position[side].history = visitFolder(
          position[side].history,
          result.path,
          historyIndex,
        );
        saveFolderScope(
          rememberFolder(
            folderScope(folderStoreRef.current, scopeKey, binding),
            result.path,
          ),
        );
      } catch (e) {
        if (
          epoch === epochs.current[side] &&
          (side === "local" || sessionId === currentSession.current)
        )
          setErrors((p) => ({ ...p, [side]: message(e) }));
      } finally {
        if (
          epoch === epochs.current[side] &&
          (side === "local" || sessionId === currentSession.current)
        )
          setBusy((p) => ({ ...p, [side]: false }));
      }
    };
    if (side === "remote") {
      const queue = followListings.current;
      queue.pending = origin === "follow" ? read : undefined;
      queue.epoch = origin === "follow" ? epoch : undefined;
      if (origin === "follow") {
        startPendingFollow(queue);
        return;
      }
    }
    void read();
  };
  const needsListing = useRef(true);
  const lastRemoteView = useRef<{ id?: string; followed?: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const queue = followListings.current;
    return () => {
      queue.pending = undefined;
      if (queue.epoch === epochs.current.remote) {
        epochs.current.remote++;
        setBusy((old) => old.remote ? { ...old, remote: false } : old);
      }
      followListings.current = { running: 0 };
    };
  }, [position, session?.id, remoteAvailable, visible, followTerminalFolder]);
  useLayoutEffect(() => {
    needsListing.current = true;
    epochs.current.local++;
    epochs.current.remote++;
    if (editorReadSession.current !== undefined) {
      editorReadEpoch.current++;
      editorReadSession.current = undefined;
      setEditorBusy(false);
    }
    const cachedRemote =
      remoteAvailable && position.connection === session?.id
        ? position.remote.listing
        : undefined;
    setLocal(position.local.listing || { path: "", entries: [] });
    setRemote(cachedRemote || { path: ".", entries: [] });
    setRemoteOwner(cachedRemote ? session?.id : undefined);
    setSelected({
      local: position.local.selected,
      remote: cachedRemote ? position.remote.selected : [],
    });
    setErrors({
      local: "",
      remote: profileChanged
        ? "This host's connection settings changed. Reconnect to browse its files."
        : "",
    });
    setBusy({ local: false, remote: false });
    setForm(null);
    setDeleting(null);
  }, [position, session?.id, remoteAvailable, profileChanged]);
  useLayoutEffect(() => {
    if (!visible) {
      lastRemoteView.current = undefined;
      return;
    }
    const initialize = needsListing.current;
    needsListing.current = false;
    const recent = session && listedLayoutFolders(session.id);
    if (session && restoredFolders) consumeLayoutFolders(session.id, restoredFolders);
    if (initialize || restoredFolders?.local) {
      void load("local", restoredFolders?.local || position.local.listing?.path || recent?.local || scopeFor("local").lastPath || defaultDirectory,
        undefined, !!position.local.listing);
    }
    if (!remoteAvailable) return;
    const previous = lastRemoteView.current;
    const followed = followTerminalFolder ? reportedDirectory : undefined;
    lastRemoteView.current = { id: session?.id, followed };
    const entering = !previous || previous.id !== session?.id;
    // Reconcile the drawer on entry. While Files is open, manual navigation stays in
    // place until the shell reports a different directory or follow is enabled.
    let requested: string | undefined;
    if (restoredFolders?.remote) {
      requested = restoredFolders.remote;
    } else if (initialize || entering) {
      requested = followed || remoteFolder || position.remote.listing?.path || recent?.remote || scopeFor("remote").lastPath || ".";
    } else if (previous.followed !== followed) {
      requested = followed;
    }
    if (!requested) return;
    const alreadyListed = position.remote.listing?.path === requested && position.connection === session?.id;
    const pendingElsewhere = busy.remote && attempts.current.remote.path !== requested;
    if (initialize || !alreadyListed || pendingElsewhere)
      load("remote", requested, undefined, alreadyListed, followed && !restoredFolders?.remote ? "follow" : "navigation");
  }, [position, session?.id, remoteAvailable, profileChanged, visible, reportedDirectory, followTerminalFolder, restoredFolders]);
  const returnFocus = useRef<{ from: Element | null } | null>(null);
  useLayoutEffect(() => {
    if (!visible && editorReadSession.current !== undefined) {
      editorReadEpoch.current++;
      editorReadSession.current = undefined;
      setEditorBusy(false);
    }
    returnFocus.current = visible && focused && !pageRef.current?.contains(document.activeElement)
      ? { from: document.activeElement } : null;
    return () => {
      returnFocus.current = null;
    };
  }, [visible, focused, position, session?.id]);
  useEffect(() => {
    const intent = returnFocus.current;
    if (!intent || !visible) return;
    const target = position.focus || {
      side: remoteAvailable ? "remote" : "local",
    };
    if (
      busy[target.side] ||
      (target.side === "remote" &&
        remoteAvailable &&
        remoteOwner !== session?.id)
    )
      return;
    const frame = requestAnimationFrame(() => {
      if (returnFocus.current !== intent) return;
      returnFocus.current = null;
      if (
        document.querySelector('[role="dialog"],[role="menu"]') ||
        document.activeElement?.closest(".file-log-panel") ||
        (document.activeElement !== document.body &&
          document.activeElement !== intent.from)
      )
        return;
      const pane = pageRef.current?.querySelector<HTMLElement>(
        `[data-file-side="${target.side}"]`,
      );
      if (!pane) return;
      const row =
        target.row &&
        pane.querySelector(`[data-file-path="${CSS.escape(target.row)}"]`);
      const control = row
        ? row.querySelector<HTMLElement>(
            target.checkbox ? 'input[type="checkbox"]' : ".file-name",
          )
        : target.field
          ? pane.querySelector<HTMLElement>(
              target.field === "path"
                ? ".path-bar input"
                : ".file-filter input",
            )
          : null;
      (control || pane.querySelector<HTMLElement>(".file-list"))?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, focused, position, session?.id, remoteAvailable, busy, remoteOwner]);
  useEffect(() => {
    const openTabs = new Set(sessions.map(sessionTabId));
    for (const key of positions.current.keys())
      if (key && !openTabs.has(key)) positions.current.delete(key);
  }, [sessions]);
  useEffect(() => {
    setInsert(null);
  }, [session?.id, remoteAvailable, visible]);
  useEffect(() => {
    if (!pendingPair) return;
    const { id, pair } = pendingPair;
    if (!visible || fileSessionBinding(pair.hostId, hosts) !== pair.binding) {
      setPendingPair(null);
      return;
    }
    if (session?.id !== id || !remoteAvailable) return;
    setPendingPair(null);
    if (session.hostId !== pair.hostId || remoteBinding !== pair.binding)
      return;
    void load("local", pair.local);
    void load("remote", pair.remote);
  }, [
    pendingPair,
    visible,
    remoteAvailable,
    session?.id,
    hosts,
    remoteBinding,
  ]);
  const persistPairs = (next: FolderPair[]) => {
    try {
      localStorage.setItem(pairStorage, JSON.stringify(next));
      setPairs(next);
    } catch {
      notify("Could not save folder pairs on this device.", true);
    }
  };
  const visitPair = (pair: FolderPair) => {
    const host = hosts.find((item) => item.id === pair.hostId);
    if (!host || fileSessionBinding(host.id, hosts) !== pair.binding) return;
    const target =
      sameServerTabs.find(
        (item) => item.id === session?.id && item.hostId === host.id,
      ) || connectedSessions.find((item) => item.hostId === host.id);
    setPairsOpen(false);
    const visit = (id: string) => {
      setPendingPair({ id, pair });
      onSelectSession(id);
    };
    if (target) visit(target.id);
    else
      onConnectHost(
        host,
        sessions.some(
          (item) => item.hostId === host.id && item.status === "connected",
        ),
        visit,
      );
  };
  const incoming = {
    local: incomingTransfers(transfers, "local", local.path, session?.id),
    remote: incomingTransfers(
      transfers,
      "remote",
      remoteDirectory.path,
      remoteAvailable ? session?.id : undefined,
    ),
  };
  const completionKey = (items: Transfer[]) =>
    JSON.stringify(
      items
        .filter((t) => t.status === "completed")
        .map((t) => [t.id, t.finishedAt])
        .sort(),
    );
  const refreshCompleted = (side: Side) => {
    const context = readDragContext();
    const pane = context.panes[side];
    if (
      pane.busy ||
      pane.error ||
      !context.visible ||
      (side === "remote" && !context.remoteReady)
    )
      return;
    const { epoch, path } = pane;
    let stale = false;
    void request<PaneData>("file_list", {
      ...payload(side, context.sessionId),
      path,
    })
      .then((result) => {
        const latest = readDragContext();
        if (
          stale ||
          latest.panes[side].epoch !== epoch ||
          latest.panes[side].path !== path ||
          latest.sessionId !== context.sessionId ||
          latest.binding !== context.binding
        )
          return;
        commitListing(side, result);
      })
      .catch((e) => {
        if (!stale)
          notify(`Could not refresh ${side} folder: ${message(e)}`, true);
      });
    return () => {
      stale = true;
    };
  };
  const localCompleted = completionKey(incoming.local);
  const remoteCompleted = completionKey(incoming.remote);
  useEffect(() => {
    if (localCompleted !== "[]") return refreshCompleted("local");
  }, [localCompleted, local.path, visible, busy.local, session?.id]);
  useEffect(() => {
    if (remoteCompleted !== "[]") return refreshCompleted("remote");
  }, [
    remoteCompleted,
    remoteDirectory.path,
    remoteOwner,
    remoteAvailable,
    visible,
    busy.remote,
    session?.id,
  ]);
  const conflicts = useConflictReview(
    transfers.filter((t) => t.sessionId === session?.id),
    visible && focused &&
      !!remoteAvailable &&
      !chooserOpen &&
      !pairsOpen &&
      !insert &&
      !form &&
      !deleting &&
      !editor,
    () => onTransfer(false),
  );
  const queueTransfers = async (
    plan: FileTransferPlan,
    openQueue?: boolean,
  ) => {
    const origin = sessions.find((s) => s.id === plan.requests[0]?.sessionId);
    if (origin && await queueFileTransfers(plan, sessionTabId(origin), notify)) onTransfer(openQueue);
  };
  const transfer = async (side: Side, entries: FileEntry[]) => {
    if (!entries.length) return;
    const context = readDragContext();
    const snapshot = captureFileDrag(
      context,
      side,
      entries[0].path,
      entries.map((entry) => entry.path),
      protocol,
    );
    const plan =
      snapshot &&
      acceptFileDrop(snapshot, context, {
        side: side === "local" ? "remote" : "local",
      });
    if (!plan) {
      notify(
        "Connect a server and wait for both folders to load before transferring files.",
        true,
      );
      return;
    }
    await queueTransfers(plan);
  };
  const fileDrag = useFileDrag(readDragContext, (plan) => {
    void queueTransfers(plan, false);
  });
  const nativeDrop = useNativeFileDrop(pageRef, visible && remoteAvailable ? session?.id : undefined,
    protocol, readDragContext, plan => queueTransfers(plan, false), notify);
  const drag = fileDrag.drag;
  const dragHeading = drag && fileDropHeading(drag.snapshot.side, drag.snapshot.entries.length, drag.snapshot.sessionName);
  const dragPath = drag?.destination || "Choose a folder in the opposite panel. Press Escape to cancel.";
  const open = async (side: Side, entry: FileEntry, target: "file" | "sql" = "file") => {
    if (entry.isDir) {
      void load(side, entry.path);
      return;
    }
    setEditorBusy(true);
    setEditorError("");
    const epoch = ++editorReadEpoch.current;
    const sessionId = side === "remote" ? session?.id : undefined;
    editorReadSession.current = sessionId || "";
    const serverName =
      side === "remote" ? displayHost?.name || session?.name : undefined;
    try {
      const file = await request<{ content: string; revision: string }>(
        "file_read",
        { ...payload(side, sessionId), path: entry.path },
      );
      if (
        epoch !== editorReadEpoch.current ||
        position !== currentPosition.current ||
        !readDragContext().visible ||
        (side === "remote" && sessionId !== currentSession.current)
      )
        return;
      if (target === "sql" && side === "remote" && sessionId) {
        onSqlFile?.(sessionId, entry.name, file.content);
        return;
      }
      setEditor({
        side,
        sessionId,
        serverName,
        path: entry.path,
        content: file.content,
        saved: file.content,
        revision: file.revision,
      });
    } catch (e) {
      if (epoch === editorReadEpoch.current) notify(message(e), true);
    } finally {
      if (epoch === editorReadEpoch.current) {
        editorReadSession.current = undefined;
        setEditorBusy(false);
      }
    }
  };
  const saveEditor = async () => {
    if (!editor) return;
    setEditorBusy(true);
    setEditorError("");
    try {
      const result = await request<{ revision: string; backupPath: string }>(
        "file_save",
        {
          side: editor.side,
          sessionId: editor.sessionId,
          path: editor.path,
          content: editor.content,
          revision: editor.revision,
          backup: true,
        },
      );
      setEditor((current) =>
        current &&
        current.path === editor.path &&
        current.sessionId === editor.sessionId
          ? { ...current, revision: result.revision, saved: editor.content }
          : current,
      );
      notify(
        result.backupPath
          ? `Saved. Recoverable copy at ${result.backupPath}`
          : "File saved",
      );
      if (
        editor.side === "local" ||
        editor.sessionId === currentSession.current
      )
        void load(editor.side);
    } catch (e) {
      setEditorError(message(e));
    } finally {
      setEditorBusy(false);
    }
  };
  useEffect(() => {
    onDirtyChange(!!editor && editor.content !== editor.saved);
    const before = (e: BeforeUnloadEvent) => {
      if (editor && editor.content !== editor.saved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [editor]);
  const mutation = async () => {
    if (!form) return;
    const base = form.path;
    try {
      if (form.action === "mkdir")
        await request("file_mkdir", {
          ...payload(form.side, form.sessionId),
          path: joinPath(base, form.value, form.side),
        });
      if (form.action === "rename")
        await request("file_rename", {
          ...payload(form.side, form.sessionId),
          path: form.entry!.path,
          destination: joinPath(base, form.value, form.side),
        });
      if (form.action === "chmod")
        await request("file_chmod", {
          ...payload(form.side, form.sessionId),
          path: form.entry!.path,
          permissions: form.value,
        });
      setForm((current) => (current === form ? null : current));
      if (form.side === "local" || form.sessionId === currentSession.current)
        void load(form.side);
    } catch (e) {
      notify(message(e), true);
    }
  };
  const readyToCompare =
    remoteAvailable &&
    remoteOwner === session?.id &&
    !!local.path &&
    !busy.local &&
    !busy.remote &&
    !errors.local &&
    !errors.remote;
  const comparing = comparisonEnabled && readyToCompare;
  const checksumPair = readyToCompare ? checksumFiles(local.entries, remoteDirectory.entries, selected) : undefined;
  const comparisons = {
    local: comparing
      ? compareFolderEntries(local.entries, remoteDirectory.entries)
      : undefined,
    remote: comparing
      ? compareFolderEntries(remoteDirectory.entries, local.entries)
      : undefined,
  };
  return (
    <section ref={pageRef} className="page files-page">
      <PageHeader
        title="File manager"
        description={
          session
            ? `Local files ↔ ${session.name}`
            : "Browse local files and connect a host to access remote files."
        }
      >
        <label className="pane-size-control">
          <span>Panel width</span>
          <input
            aria-label="Local panel width"
            type="range"
            min={30}
            max={70}
            value={paneWidth}
            onChange={(event) => setPaneWidth(Number(event.target.value))}
          />
        </label>
        <label className="inline-field">
          <span>Transfer with</span>
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
          >
            <option value="sftp">SFTP</option>
            <option value="scp">SCP</option>
          </select>
        </label>
        <Button onClick={() => onTransfer()}>Transfer queue</Button>
        <Button onClick={() => setPairsOpen(true)}>
          <FolderHeart size={16} />
          Folder pairs
        </Button>
        <Button
          aria-pressed={comparisonEnabled}
          onClick={() => setComparisonEnabled((value) => !value)}
          disabled={!remoteAvailable}
        >
          <GitCompare size={16} /> Compare folders
        </Button>
      </PageHeader>
      <div className="file-panes">
        {(["local", "remote"] as Side[]).map((side) => (
          <FilePane
            key={JSON.stringify([
              side,
              tabId,
              remoteBinding,
              side === "remote" && remoteAvailable,
            ])}
            side={side}
            position={position[side]}
            visible={visible}
            followTerminalFolder={followTerminalFolder}
            waitingForDirectory={followTerminalFolder && !reportedDirectory}
            onToggleFollow={side === "remote" && onFollowTerminalFolderChange
              ? () => onFollowTerminalFolderChange(!followTerminalFolder)
              : undefined}
            rememberFocus={(target) => {
              position.focus = { side, ...target };
            }}
            remoteHost={displayHost}
            dragHelpId={dragHelpId}
            nativeDrop={side === "remote" ? nativeDrop : null}
            remoteName={session && sessionHostLabel(session.name, displayHost)}
            remoteAddress={
              displayHost
                ? serverAddress(displayHost.username, displayHost.hostname, displayHost.port !== 22 ? displayHost.port : undefined)
                : undefined
            }
            environmentLabel={displayHost?.environmentLabel}
            chooseServer={() => {
              setServerQuery("");
              setChooserOpen(true);
            }}
            width={side === "local" ? paneWidth : 100 - paneWidth}
            listChildren={(path) =>
              request<PaneData>("file_list", {
                ...payload(side, session?.id),
                path,
              })
            }
            data={data(side)}
            incoming={incoming[side].filter(
              (t) =>
                ["queued", "active", "running", "conflict"].includes(
                  t.status,
                ) ||
                (t.status === "failed" &&
                  !!t.finishedAt &&
                  Date.now() / 1000 - t.finishedAt < 3600),
            )}
            reviewConflict={conflicts.review}
            showQueue={() => onTransfer()}
            openTerminalHere={
              side === "remote" && session && onOpenTerminalHere
                ? (path) => onOpenTerminalHere(session.id, path)
                : undefined
            }
            openSql={side === "remote" && remoteAvailable && remoteOwner === session?.id && onSqlFile
              ? (entry) => void open("remote", entry, "sql") : undefined}
            useFolder={
              side === "remote" && session && onUseFolder
                ? (path) => onUseFolder(session.id, path)
                : undefined
            }
            insertPath={
              side === "remote" && session && onInsertPath
                ? (path) => {
                    if (sameServerTabs.length === 1)
                      onInsertPath(session.id, sameServerTabs[0].id, path);
                    else
                      setInsert({
                        id: session.id,
                        binding: remoteBinding,
                        path,
                      });
                  }
                : undefined
            }
            watchLog={
              side === "remote" && session
                ? (path) =>
                    setLog({
                      sessionId: session.id,
                      binding: remoteBinding,
                      name: session.name,
                      path,
                    })
                : undefined
            }
            selected={selected[side]}
            setSelected={(ids) => {
              position[side].selected = ids;
              setSelected((p) => ({ ...p, [side]: ids }));
            }}
            busy={busy[side]}
            error={errors[side]}
            attemptedPath={attempts.current[side].path}
            retry={() =>
              void load(
                side,
                attempts.current[side].path,
                attempts.current[side].historyIndex,
              )
            }
            scope={scopeFor(side)}
            history={position[side].history}
            navigateHistory={(index) => {
              const path = position[side].history?.paths[index];
              if (path) void load(side, path, index);
            }}
            toggleBookmark={(path) =>
              saveFolderScope(toggleFolderBookmark(scopeFor(side), path))
            }
            home={() =>
              void load(side, side === "local" ? defaultDirectory : ".")
            }
            comparison={comparisons[side]}
            enabled={side === "local" || remoteAvailable}
            canTransfer={fileContextReady(readDragContext())}
            load={(path) => void load(side, path)}
            open={(entry) => void open(side, entry)}
            transfer={(entries) => void transfer(side, entries)}
            rename={(entry) =>
              setForm({
                side,
                sessionId: session?.id,
                path: data(side).path,
                action: "rename",
                entry,
                value: entry.name,
              })
            }
            mkdir={() =>
              setForm({
                side,
                sessionId: session?.id,
                path: data(side).path,
                action: "mkdir",
                value: "",
              })
            }
            chmod={(entry) =>
              setForm({
                side,
                sessionId: session?.id,
                path: data(side).path,
                action: "chmod",
                entry,
                value: entry.permissions,
              })
            }
            remove={(entries) =>
              setDeleting({ side, sessionId: session?.id, entries, folder: data(side).path,
                location: side === "local" ? "This computer" : session?.name || "Remote server" })
            }
            startDrag={(event, path) =>
              fileDrag.startDrag(event, side, path, selected[side], protocol)
            }
            ignoreDragClick={fileDrag.ignoreClick}
            draggedPaths={
              fileDrag.drag?.snapshot.side === side
                ? fileDrag.drag.snapshot.entries.map((entry) => entry.path)
                : []
            }
          />
        ))}
      </div>
      {(comparisonEnabled || checksumPair) && (
        <div className="file-compare-note checksum-actions">
          <span>{comparisonEnabled && (!comparing ? "Waiting for both folders to load. " : "Comparing names, types and sizes. ")}
            {checksumPair ? `Compare contents of ${checksumPair.local.name}${checksumPair.remote.name !== checksumPair.local.name ? ` and ${checksumPair.remote.name}` : ""}.` : "Select one file per pane or one file with the same name on both sides."}</span>
          {visible && session && <FileChecksum key={JSON.stringify([session.id, checksumPair?.local.path, checksumPair?.remote.path])} sessionId={session.id} pair={checksumPair} />}
        </div>
      )}
      {fileDrag.drag &&
        createPortal(
          <div
            ref={fileDrag.ghostRef}
            className={`file-drag-ghost ${fileDrag.drag.destination ? "valid-drop" : ""}`}
            aria-hidden="true"
            style={{
              transform: `translate3d(${fileDrag.drag.x}px,${fileDrag.drag.y}px,0)`,
            }}
          >
            {fileDrag.drag.snapshot.side === "local" ? (
              <Upload size={18} />
            ) : (
              <Download size={18} />
            )}
            <div>
              <strong>{dragHeading}</strong>
              <span>{dragPath}</span>
            </div>
          </div>,
          document.body,
        )}
      <span className="sr-only" role="status" aria-live="polite">
        {drag && `${dragHeading}. ${dragPath}`}
      </span>
      <p className="file-footer" id={dragHelpId}>
        Double-click folders to open or text files to edit. Drag files between
        panels to copy them.
      </p>
      {conflicts.modal}
      {pairsOpen && (
        <PairDialog
          pairs={pairs}
          hosts={hosts}
          canSave={
            !!selectedHost &&
            !!remoteAvailable &&
            remoteOwner === session?.id &&
            !!local.path &&
            !busy.local &&
            !busy.remote &&
            !errors.local &&
            !errors.remote
          }
          onSave={(name) => {
            if (
              !session ||
              !remoteAvailable ||
              !selectedHost ||
              !local.path ||
              remoteOwner !== session.id
            )
              return;
            if (pairs.length >= 100) {
              notify("Remove a saved pair before adding another.", true);
              return;
            }
            const pair = {
              id: crypto.randomUUID(),
              name,
              hostId: session.hostId,
              binding: remoteBinding,
              local: local.path,
              remote: remote.path,
            };
            persistPairs([pair, ...pairs]);
          }}
          onRemove={(id) => persistPairs(pairs.filter((p) => p.id !== id))}
          onVisit={visitPair}
          onClose={() => setPairsOpen(false)}
        />
      )}
      {insert &&
        session &&
        insert.id === session.id &&
        insert.binding === remoteBinding &&
        remoteAvailable &&
        visible && (
          <Modal
            open
            onOpenChange={(open) => {
              if (!open) setInsert(null);
            }}
            title="Insert path into terminal"
            description={insert.path}
          >
            <div className="palette-results">
              {sameServerTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="palette-result"
                  onClick={() => {
                    setInsert(null);
                    onInsertPath?.(insert.id, tab.id, insert.path);
                  }}
                >
                  <TerminalSquare size={16} />
                  <span>{tab.name}</span>
                </button>
              ))}
            </div>
          </Modal>
        )}
      {log && (
        <LogPanel
          key={JSON.stringify([log.sessionId, log.path])}
          source={log}
          available={
            activeLogSession?.status === "connected" &&
            fileSessionBinding(activeLogSession.hostId, hosts) === log.binding
          }
          close={() => setLog(null)}
        />
      )}
      {profileChanged && selectedHost && (
        <Button onClick={() => onConnectHost(selectedHost, true)}>
          Reconnect server
        </Button>
      )}
      <Modal
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        title="Choose remote server"
        description="Select a connected session or connect to a saved host."
      >
        <div className="palette-search">
          <Search size={18} />
          <input
            autoFocus
            aria-label="Search remote servers"
            placeholder="Search host, address, or username…"
            value={serverQuery}
            onChange={(event) => setServerQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                chooserList.current
                  ?.querySelector<HTMLButtonElement>("button")
                  ?.focus();
              }
            }}
          />
        </div>
        <div
          className="palette-results connection-picker"
          ref={chooserList}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const buttons = Array.from(
              chooserList.current?.querySelectorAll<HTMLButtonElement>(
                "button",
              ) || [],
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (!buttons.length || index < 0) return;
            event.preventDefault();
            buttons[
              (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length
            ].focus();
          }}
        >
          {matchingSessions.length > 0 && (
            <div className="palette-group">Connected sessions</div>
          )}
          {matchingSessions.map((item) => {
            const host = hosts.find((host) => host.id === item.hostId);
            return (
              <button
                type="button"
                className={`picker-card palette-result ${session?.id === item.id ? "selected" : ""}`}
                key={item.id}
                aria-current={session?.id === item.id ? "true" : undefined}
                onClick={() => {
                  setChooserOpen(false);
                  onSelectSession(item.id);
                }}
              >
                <Server size={18} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{item.name}</strong>
                  <small>
                    {host
                      ? `${host.username}@${host.hostname}:${host.port}`
                      : "Connected SSH session"}
                  </small>
                </span>
                {session?.id === item.id && (
                  <Check size={16} aria-label="Selected" />
                )}
              </button>
            );
          })}
          {matchingHosts.length > 0 && (
            <div className="palette-group">Saved hosts</div>
          )}
          {matchingHosts.map((host) => (
            <button
              type="button"
              className="picker-card palette-result"
              key={host.id}
              onClick={() => {
                const connected = connectedSessions.find(
                  (item) => item.hostId === host.id,
                );
                setChooserOpen(false);
                if (connected) onSelectSession(connected.id);
                else
                  onConnectHost(
                    host,
                    sessions.some(
                      (item) =>
                        item.hostId === host.id && item.status === "connected",
                    ),
                  );
              }}
            >
              <Server size={18} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{host.name}</strong>
                <small>
                  {host.username}@{host.hostname}:{host.port}
                </small>
              </span>
              <small className="picker-method">{host.authMethod === "key" ? "SSH key" : host.authMethod === "agent" ? "SSH agent" : "Password"}</small>
            </button>
          ))}
          {!matchingSessions.length && !matchingHosts.length && (
            <div className="compact-empty">
              {serverQuery
                ? "No matching servers"
                : "Save a host to browse its remote files."}
            </div>
          )}
        </div>
      </Modal>
      <Modal
        open={!!form}
        onOpenChange={(v) => {
          if (!v) setForm(null);
        }}
        title={
          form?.action === "mkdir"
            ? "New folder"
            : form?.action === "chmod"
              ? "Change permissions"
              : "Rename file"
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void mutation();
          }}
        >
          <div className="modal-body">
            <Field
              label={form?.action === "chmod" ? "Permissions (octal)" : "Name"}
            >
              <input
                required
                autoFocus
                pattern={form?.action === "chmod" ? "[0-7]{3,4}" : undefined}
                value={form?.value || ""}
                onChange={(e) =>
                  setForm((f) => (f ? { ...f, value: e.target.value } : f))
                }
              />
            </Field>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" type="submit">
              Save
            </Button>
          </footer>
        </form>
      </Modal>
      <Confirm
        open={!!deleting}
        title="Delete selected items?"
        description={deleting ? `Permanently delete ${deleting.entries.length === 1
          ? `“${deleting.entries[0].name}”` : `${deleting.entries.length} selected items`} from ${deleting.location} (${deleting.folder})? Folders must be empty.` : ""}
        danger
        confirmLabel="Delete"
        onClose={() =>
          setDeleting((current) => (current === deleting ? null : current))
        }
        onConfirm={async () => {
          if (!deleting) return;
          let removed = 0;
          try {
            for (const entry of deleting.entries) {
              await request("file_delete", {
                ...payload(deleting.side, deleting.sessionId),
                path: entry.path,
              });
              removed++;
            }
          } catch (error) {
            const remaining = deleting.entries.slice(removed);
            if (removed) setDeleting(current => current === deleting ? { ...deleting, entries: remaining } : current);
            throw new Error(`Could not delete “${remaining[0].name}”. ${message(error)}`);
          } finally {
            if (deleting.folder === position[deleting.side].listing?.path)
              void load(deleting.side);
          }
        }}
      />
      <Modal
        open={!!editor}
        onOpenChange={(v) => {
          if (!v) {
            if (editor?.content !== editor?.saved) setEditorDiscard(true);
            else setEditor(null);
          }
        }}
        title={editor?.path.split(/[\\/]/).pop() || "File editor"}
        description={
          editor
            ? `${editor.serverName ? `${editor.serverName} · ` : ""}${editor.path}`
            : undefined
        }
        wide
      >
        <div className="editor-toolbar">
          <span>
            {editor?.content !== editor?.saved ? "Unsaved changes" : "Saved"} ·{" "}
            {editor?.side === "remote"
              ? `Remote file on ${editor.serverName || "original session"}`
              : "Local file"}
          </span>
          <Button
            variant="primary"
            busy={editorBusy}
            onClick={() => void saveEditor()}
            disabled={editor?.content === editor?.saved}
          >
            <Save size={15} />
            Save with backup
          </Button>
        </div>
        <ErrorBox error={editorError} />
        <CodeMirror
          value={editor?.content || ""}
          height="52vh"
          theme={theme === "light" ? "light" : "dark"}
          extensions={editor ? language(editor.path) : []}
          onChange={(value) =>
            setEditor((e) => (e ? { ...e, content: value } : e))
          }
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            searchKeymap: true,
            foldGutter: true,
          }}
        />
        <div className="editor-footer">
          Ctrl+F to find · Ctrl+H to replace. A recoverable copy is created on
          save.
        </div>
      </Modal>
      <Confirm
        open={editorDiscard}
        title="Discard unsaved edits?"
        description="Your changes have not been saved to the file."
        danger
        confirmLabel="Discard edits"
        onClose={() => setEditorDiscard(false)}
        onConfirm={() => {
          setEditor(null);
        }}
      />
    </section>
  );
}
function language(path: string) {
  if (/\.ya?ml$/i.test(path)) return [StreamLanguage.define(yaml)];
  if (/\.toml$/i.test(path)) return [StreamLanguage.define(toml)];
  if (/\.(sh|env)$/i.test(path) || path.split(/[\\/]/).pop() === ".env")
    return [StreamLanguage.define(shell)];
  if (/\.(conf|ini)$/i.test(path)) return [StreamLanguage.define(properties)];
  if (/\.json$/i.test(path)) return [json()];
  if (/\.[jt]sx?$/i.test(path))
    return [
      javascript({ typescript: /\.tsx?$/i.test(path), jsx: /x$/i.test(path) }),
    ];
  if (/\.py$/i.test(path)) return [python()];
  if (/\.html?$/i.test(path)) return [html()];
  if (/\.css$/i.test(path)) return [css()];
  return [];
}
function FilePane({
  side,
  position,
  visible,
  rememberFocus,
  followTerminalFolder,
  waitingForDirectory,
  onToggleFollow,
  remoteName,
  remoteHost,
  dragHelpId,
  nativeDrop,
  remoteAddress,
  environmentLabel,
  chooseServer,
  width,
  listChildren,
  data,
  selected,
  setSelected,
  busy,
  error,
  attemptedPath,
  retry,
  scope,
  history,
  navigateHistory,
  toggleBookmark,
  home,
  comparison,
  enabled,
  canTransfer,
  load,
  open,
  transfer,
  rename,
  mkdir,
  chmod,
  remove,
  startDrag,
  ignoreDragClick,
  draggedPaths,
  incoming,
  reviewConflict,
  showQueue,
  openTerminalHere,
  openSql,
  useFolder,
  insertPath,
  watchLog,
}: {
  side: Side;
  position: PanePosition;
  visible: boolean;
  followTerminalFolder: boolean;
  waitingForDirectory: boolean;
  onToggleFollow?: () => void;
  rememberFocus: (
    target: Omit<NonNullable<FileTabPosition["focus"]>, "side">,
  ) => void;
  remoteName?: string;
  remoteHost?: Host;
  dragHelpId: string;
  nativeDrop: NativeDropPreview | null;
  remoteAddress?: string;
  environmentLabel?: Host["environmentLabel"];
  chooseServer: () => void;
  width: number;
  listChildren: (path: string) => Promise<PaneData>;
  data: PaneData;
  selected: string[];
  setSelected: (ids: string[]) => void;
  busy: boolean;
  error: string;
  attemptedPath: string;
  retry: () => void;
  scope: FolderScope;
  history?: FolderHistory;
  navigateHistory: (index: number) => void;
  toggleBookmark: (path: string) => void;
  home: () => void;
  comparison?: Map<string, Comparison>;
  enabled?: boolean;
  canTransfer?: boolean;
  load: (path: string) => void;
  open: (e: FileEntry) => void;
  transfer: (e: FileEntry[]) => void;
  rename: (e: FileEntry) => void;
  mkdir: () => void;
  chmod: (e: FileEntry) => void;
  remove: (e: FileEntry[]) => void;
  startDrag: (event: PointerEvent<HTMLButtonElement>, path: string) => void;
  ignoreDragClick: () => boolean;
  draggedPaths: string[];
  incoming: Transfer[];
  reviewConflict: (id: string) => void;
  showQueue: () => void;
  openTerminalHere?: (path: string) => void;
  openSql?: (entry: FileEntry) => void;
  useFolder?: (path: string) => void;
  insertPath?: (path: string) => void;
  watchLog?: (path: string) => void;
}) {
  const [path, setPath] = useState(data.path);
  const [filter, setFilter] = useState(position.filter);
  const [sort, setSort] = useState(position.sort);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (visible && listRef.current && position.listing === data)
      listRef.current.scrollTop = position.scrollTop;
  }, [visible, data, position, busy]);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<{ base: string; path?: string }>(
    { base: "" },
  );
  useEffect(() => setPath(data.path), [data.path]);
  const chosen = data.entries.filter((e) => selected.includes(e.path));
  function changeFilter(value: string) {
    position.filter = value;
    setFilter(value);
    const needle = value.toLowerCase();
    const remaining = chosen.filter(entry => entry.name.toLowerCase().includes(needle));
    if (remaining.length !== selected.length) setSelected(remaining.map(entry => entry.path));
  }
  const contextEntry = data.entries.find((e) => e.path === menuTarget.path);
  const menuItems = (
    Menu: typeof ContextMenu | typeof DropdownMenu,
    entry?: FileEntry,
  ) => (
    <>
      {openSql && entry && !entry.isDir && !entry.isSymlink && /\.sql$/i.test(entry.name) && (
        <Menu.Item onSelect={() => openSql(entry)}>
          <FileCode size={15} /> Open in SQL Editor
        </Menu.Item>
      )}
      {useFolder && (
        <Menu.Item onSelect={() => useFolder(entry?.isDir ? entry.path : data.path)}>
          <Folder size={15} />
          Use folder in terminal
        </Menu.Item>
      )}
      <Menu.Item
        disabled={!openTerminalHere}
        onSelect={() =>
          openTerminalHere?.(entry?.isDir ? entry.path : data.path)
        }
      >
        <TerminalSquare size={15} />
        Open terminal here
      </Menu.Item>
      <Menu.Item
        disabled={!insertPath}
        onSelect={() => insertPath?.(entry?.path || data.path)}
      >
        <FileCode size={15} />
        Insert path into terminal
      </Menu.Item>
      {entry && !entry.isDir && !entry.isSymlink && (
        <Menu.Item onSelect={() => watchLog?.(entry.path)}>
          <FileText size={15} />
          Watch log
        </Menu.Item>
      )}
    </>
  );
  let entries = data.entries.filter((e) =>
    e.name.toLowerCase().includes(filter.toLowerCase()),
  );
  entries = [...entries].sort(
    (a, b) =>
      Number(b.isDir) - Number(a.isDir) ||
      (sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "type"
          ? (a.name.split(".").pop() || "").localeCompare(
              b.name.split(".").pop() || "",
            )
          : sort === "size"
            ? b.size - a.size
            : b.modified - a.modified),
  );
  return (
    <div
      className="file-pane"
      data-file-side={side}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const row =
          target.closest<HTMLElement>("[data-file-path]")?.dataset.filePath;
        const field = target.matches(".path-bar input")
          ? "path"
          : target.matches(".file-filter input")
            ? "filter"
            : undefined;
        rememberFocus({
          row,
          checkbox: target.matches('input[type="checkbox"]'),
          field,
        });
      }}
      style={{ width: `${width}%` }}
    >
      <header className="file-pane-header">
        {side === "local" ? (
          <h2>
            <HardDrive size={17} /> This computer
          </h2>
        ) : (
          <Button
            variant="ghost"
            onClick={chooseServer}
            aria-haspopup="dialog"
            aria-label={`Remote server${remoteName ? `, ${remoteName}` : ""}. Choose server`}
            title={remoteName ? [remoteName, remoteAddress, "Choose remote server"].filter(Boolean).join("\n") : "Choose remote server"}
            style={{
              minWidth: 0,
              justifyContent: "flex-start",
              textAlign: "left",
            }}
          >
            {remoteHost ? <HostMark host={remoteHost}/> : <Server size={17} style={{ flexShrink: 0 }} />}
            <span style={{ display: "grid", minWidth: 0 }}>
              <strong
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {remoteName || "Remote server"}
              </strong>
              {remoteAddress && (
                <small
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--muted)",
                  }}
                >
                  {remoteAddress}
                </small>
              )}
              {environmentLabel && (
                <span className="file-environment">
                  <EnvironmentBadge value={environmentLabel} />
                </span>
              )}
            </span>
            <ChevronDown size={15} style={{ flexShrink: 0 }} />
          </Button>
        )}
        <div className="toolbar">
          {onToggleFollow && (
            <IconButton
              label={waitingForDirectory ? "Follow terminal folder · waiting for the shell to report a folder" : "Follow terminal folder"}
              aria-pressed={followTerminalFolder}
              disabled={!enabled}
              onClick={onToggleFollow}
              className="follow-folder-toggle"
            >
              <Link2 size={16} />
            </IconButton>
          )}
          {side === "remote" && (
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <IconButton
                  label="Remote folder actions"
                  disabled={!enabled || busy || !!error}
                >
                  <MoreHorizontal size={16} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="terminal-menu"
                  align="end"
                  sideOffset={4}
                  onCloseAutoFocus={(e) => e.preventDefault()}
                >
                  {menuItems(
                    DropdownMenu,
                    chosen.length === 1 ? chosen[0] : undefined,
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          <IconButton
            label={`Refresh ${side} directory`}
            onClick={() => load(data.path)}
            disabled={!enabled || busy}
          >
            <RefreshCw size={15} className={busy ? "spin" : ""} />
          </IconButton>
          <IconButton
            label={`New ${side} folder`}
            onClick={mkdir}
            disabled={!enabled}
          >
            <FolderPlus size={16} />
          </IconButton>
        </div>
      </header>
      <div className="file-navigation" aria-label={`${side} folder navigation`}>
        <IconButton
          label={`Back in ${side} folders`}
          disabled={!enabled || busy || !history || history.index <= 0}
          onClick={() => navigateHistory((history?.index || 0) - 1)}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label={`Forward in ${side} folders`}
          disabled={
            !enabled ||
            busy ||
            !history ||
            history.index >= history.paths.length - 1
          }
          onClick={() => navigateHistory((history?.index || 0) + 1)}
        >
          <ArrowRight size={16} />
        </IconButton>
        <IconButton
          label={`${side} home folder`}
          disabled={!enabled || busy}
          onClick={home}
        >
          <Home size={16} />
        </IconButton>
        <Button
          className="folder-locations-button"
          aria-haspopup="dialog"
          onClick={() => setLocationsOpen(true)}
          disabled={!enabled}
        >
          <History size={15} /> Locations <ChevronDown size={13} />
        </Button>
        <IconButton
          label={`${scope.bookmarks.includes(data.path) ? "Remove" : "Add"} ${side} folder bookmark`}
          aria-pressed={scope.bookmarks.includes(data.path)}
          disabled={!enabled || busy || !data.path}
          onClick={() => toggleBookmark(data.path)}
        >
          <Bookmark
            size={16}
            fill={scope.bookmarks.includes(data.path) ? "currentColor" : "none"}
          />
        </IconButton>
      </div>
      <form
        className="path-bar"
        onSubmit={(e) => {
          e.preventDefault();
          load(path);
        }}
      >
        <IconButton
          label="Parent directory"
          onClick={() => load(parentPath(data.path))}
          disabled={!enabled}
        >
          <ArrowUp size={16} />
        </IconButton>
        <input
          aria-label={`${side} directory path`}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          disabled={!enabled}
          placeholder={
            side === "local" ? "Local home directory" : "Connect to browse"
          }
        />
      </form>
      <div className="file-filter">
        <label>
          <Search size={14} />
          <input
            aria-label={`Search ${side} files`}
            value={filter}
            onChange={e => changeFilter(e.target.value)}
            placeholder="Filter files…"
            disabled={!enabled}
          />
        </label>
        <select
          aria-label={`Sort ${side} files`}
          value={sort}
          onChange={(e) => {
            position.sort = e.target.value;
            setSort(position.sort);
          }}
        >
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="type">Type</option>
          <option value="modified">Modified</option>
        </select>
      </div>
      {error && (
        <div className="file-inline-error" role="alert">
          <div>
            <strong>Could not open folder</strong>
            <span>{error}</span>
            {attemptedPath && <code>{attemptedPath}</code>}
            {data.entries.length > 0 && <span>Still showing {data.path}</span>}
          </div>
          <Button onClick={retry} disabled={!enabled || busy}>
            Retry
          </Button>
        </div>
      )}
      {enabled && (
        <details className="folder-tree">
          <summary>Folder tree</summary>
          <nav aria-label={`${side} folder tree`}>
            <button onClick={() => load(parentPath(data.path))}>
              <ArrowUp size={13} />
              Parent folder
            </button>
            <ul>
              {data.entries
                .filter((entry) => entry.isDir)
                .map((entry) => (
                  <TreeFolder
                    key={entry.path}
                    entry={entry}
                    load={listChildren}
                    navigate={load}
                  />
                ))}
            </ul>
            {!data.entries.some((entry) => entry.isDir) && (
              <small>No subfolders</small>
            )}
          </nav>
        </details>
      )}
      {!enabled ? (
        <Empty
          icon={<Server size={25} />}
          title="Choose a remote server"
          description="Choose a server from the remote panel heading to browse its files."
          action={<Button onClick={chooseServer}>Choose server</Button>}
        />
      ) : (
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger
            asChild
            disabled={side !== "remote" || busy || !!error}
          >
            <div
              ref={listRef}
              className={`file-list${nativeDrop?.destination === data.path ? " file-drop-target" : ""}`}
              data-file-drop-list={side}
              tabIndex={-1}
              aria-label={`${side} file list`}
              onScroll={(event) => {
                if (
                  visible &&
                  event.currentTarget.clientHeight &&
                  position.listing === data
                )
                  position.scrollTop = event.currentTarget.scrollTop;
              }}
              aria-busy={busy}
              onContextMenuCapture={(event) =>
                setMenuTarget({
                  base: data.path,
                  path: (event.target as Element).closest<HTMLElement>(
                    "[data-file-path]",
                  )?.dataset.filePath,
                })
              }
            >
              {busy && (
                <div
                  className="file-loading"
                  role="status"
                  title={attemptedPath}
                >
                  <LoaderCircle size={16} className="spin" />
                  <span>
                    {data.entries.length
                      ? `Loading… Current listing: ${data.path}`
                      : "Opening folder…"}
                  </span>
                </div>
              )}
              <div className="file-table-heading">
                <input
                  type="checkbox"
                  aria-label={`Select all ${side} files`}
                  disabled={busy}
                  checked={
                    !!entries.length &&
                    entries.every((e) => selected.includes(e.path))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? entries.map((x) => x.path) : [],
                    )
                  }
                />
                <span>Name</span>
                <span>Size</span>
                <span>Modified</span>
              </div>
              {incoming.map((item) => {
                const name = (
                  item.renamedPaths?.[item.destination] || item.destination
                )
                  .split(side === "local" ? /[\\/]/ : "/")
                  .pop();
                const percent = item.totalBytes
                  ? Math.min(
                      100,
                      Math.floor(
                        (item.transferredBytes / item.totalBytes) * 100,
                      ),
                    )
                  : 0;
                return (
                  <div className="file-inline-transfer" key={item.id}>
                    {item.direction === "upload" ? (
                      <Upload size={15} />
                    ) : (
                      <Download size={15} />
                    )}
                    <div>
                      <strong>{name}</strong>
                      <small>
                        {item.status === "failed"
                          ? item.error || "Transfer failed"
                          : item.status === "conflict"
                            ? "Waiting for a decision"
                            : item.status === "queued"
                              ? "Queued"
                              : `${percent}% · ${formatBytes(item.speedBytesPerSecond)}/s${item.etaSeconds == null ? "" : ` · ${Math.ceil(item.etaSeconds)}s left`}`}
                      </small>
                      <progress
                        aria-label={`Transfer progress for ${name}`}
                        value={item.transferredBytes}
                        max={item.totalBytes || 1}
                      />
                    </div>
                    {item.status === "conflict" && (
                      <Button onClick={() => reviewConflict(item.id)}>
                        Review
                      </Button>
                    )}
                    {item.status === "failed" && (
                      <Button onClick={showQueue}>View transfer</Button>
                    )}
                  </div>
                );
              })}
              {!entries.length && !incoming.length && !busy && !error && (
                <div className="compact-empty">
                  {filter ? (
                    <>
                      <strong>No files match “{filter}”</strong>
                      <Button onClick={() => changeFilter("")}>
                        Clear filter
                      </Button>
                    </>
                  ) : (
                    <>
                      <strong>This folder is empty</strong>
                      <span>
                        {side === "local"
                          ? "Create a folder here or download files from the remote panel."
                          : "Create a folder here or upload files from the local panel."}
                      </span>
                      <Button onClick={mkdir}>New folder</Button>
                    </>
                  )}
                </div>
              )}
              {entries.map((e) => (
                <div
                  key={e.path}
                  className={`file-row ${selected.includes(e.path) ? "selected" : ""} ${draggedPaths.includes(e.path) ? "file-drag-source" : ""} ${nativeDrop?.destination === e.path ? "drop-target" : ""} ${comparison?.get(e.path) ? `file-compare-${comparison.get(e.path)}` : ""}`}
                  data-file-path={e.path}
                  data-file-directory={String(e.isDir)}
                  draggable={false}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${e.name}`}
                    disabled={busy}
                    checked={selected.includes(e.path)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, e.path]
                          : selected.filter((p) => p !== e.path),
                      )
                    }
                  />
                  <button
                    className={`file-name ${canTransfer ? "file-draggable" : ""}`}
                    disabled={busy}
                    draggable={false}
                    title={e.name}
                    aria-describedby={dragHelpId}
                    onPointerDown={(event) => startDrag(event, e.path)}
                    onDragStart={(event) => event.preventDefault()}
                    onClick={(event) => {
                      if (event.detail > 0 && ignoreDragClick()) {
                        event.preventDefault();
                        return;
                      }
                      setSelected([e.path]);
                    }}
                    onDoubleClick={(event) => {
                      if (ignoreDragClick()) {
                        event.preventDefault();
                        return;
                      }
                      open(e);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") open(e);
                    }}
                  >
                    {e.isDir ? <Folder size={16} /> : <File size={16} />}
                    <span>{e.name}</span>
                    {e.isSymlink && <small>link</small>}
                    {comparison &&
                      comparison.get(e.path) !== "same-metadata" && (
                        <small className="file-comparison-label">
                          {comparison.get(e.path) === "only-here"
                            ? `Only ${side}`
                            : comparison.get(e.path) === "different-type"
                              ? "Type differs"
                              : "Size differs"}
                        </small>
                      )}
                  </button>
                  <span>{e.isDir ? "" : formatBytes(e.size)}</span>
                  <span
                    title={
                      side === "remote"
                        ? `Permissions ${e.permissions}`
                        : undefined
                    }
                  >
                    {clockDate(e.modified)}
                  </span>
                </div>
              ))}
            </div>
          </ContextMenu.Trigger>
          {side === "remote" &&
            !busy &&
            !error &&
            menuTarget.base === data.path &&
            (!menuTarget.path || contextEntry) && (
              <ContextMenu.Portal>
                <ContextMenu.Content
                  className="terminal-menu"
                  collisionPadding={8}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  {menuItems(ContextMenu, contextEntry)}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            )}
        </ContextMenu.Root>
      )}
      <div className="file-actionbar">
        {nativeDrop && <div className="file-native-drop-hint" role="status">
          <strong>{fileDropHeading("local", nativeDrop.snapshot.entries.length, nativeDrop.snapshot.sessionName)}</strong>
          <span>{nativeDrop.destination}</span>
        </div>}
        <span>
          {selected.length
            ? `${selected.length} selected`
            : `${data.entries.length} items`}
        </span>
        <div className="toolbar">
          <IconButton
            label="Open or preview selection"
            disabled={busy || chosen.length !== 1}
            onClick={() => open(chosen[0])}
          >
            <FileCode size={15} />
          </IconButton>
          <IconButton
            label="Rename selection"
            disabled={busy || chosen.length !== 1}
            onClick={() => rename(chosen[0])}
          >
            <Pencil size={15} />
          </IconButton>
          {side === "remote" && (
            <IconButton
              label="Change permissions"
              disabled={busy || chosen.length !== 1}
              onClick={() => chmod(chosen[0])}
            >
              <LockKeyhole size={15} />
            </IconButton>
          )}
          <IconButton
            label="Delete selection"
            disabled={busy || !chosen.length}
            onClick={() => remove(chosen)}
          >
            <Trash2 size={15} />
          </IconButton>
          <Button
            variant="primary"
            disabled={busy || !chosen.length || !canTransfer}
            onClick={() => transfer(chosen)}
          >
            {side === "local" ? <Upload size={15} /> : <Download size={15} />}{" "}
            {side === "local" ? "Upload" : "Download"}
          </Button>
        </div>
      </div>
      <Modal
        open={locationsOpen}
        onOpenChange={setLocationsOpen}
        title={`${side === "local" ? "Local" : "Remote"} folder locations`}
        description={
          side === "local"
            ? "Bookmarks and recent folders on this computer."
            : `Bookmarks and recent folders for ${remoteName || "this server"}.`
        }
      >
        <div className="folder-locations">
          <h3>
            Bookmarks <span>{scope.bookmarks.length}/30</span>
          </h3>
          {!scope.bookmarks.length && (
            <p>
              No bookmarks yet. Use the bookmark button beside Locations to save
              the current folder.
            </p>
          )}
          {scope.bookmarks.map((location) => (
            <div className="folder-location" key={location}>
              <button
                title={location}
                onClick={() => {
                  setLocationsOpen(false);
                  load(location);
                }}
              >
                <Bookmark size={15} />
                <span>{location}</span>
              </button>
              <IconButton
                label={`Remove bookmark ${location}`}
                onClick={() => toggleBookmark(location)}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))}
          <h3>Recent folders</h3>
          {!scope.recent.length && (
            <p>Folders appear here after they load successfully.</p>
          )}
          {scope.recent.map((location) => (
            <div className="folder-location" key={location}>
              <button
                title={location}
                onClick={() => {
                  setLocationsOpen(false);
                  load(location);
                }}
              >
                <Folder size={15} />
                <span>{location}</span>
              </button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
function TreeFolder({
  entry,
  load,
  navigate,
}: {
  entry: FileEntry;
  load: (path: string) => Promise<PaneData>;
  navigate: (path: string) => void;
}) {
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <li>
      <details
        onToggle={(event) => {
          if (!event.currentTarget.open || children || busy) return;
          setBusy(true);
          void load(entry.path)
            .then((result) =>
              setChildren(result.entries.filter((item) => item.isDir)),
            )
            .catch((error) => setError(message(error)))
            .finally(() => setBusy(false));
        }}
      >
        <summary>
          <Folder size={13} />
          {entry.name}
          <button
            aria-label={`Open folder ${entry.name}`}
            onClick={(event) => {
              event.preventDefault();
              navigate(entry.path);
            }}
          >
            Open
          </button>
        </summary>
        {busy && <small>Loading…</small>}
        {error && <small className="danger-text">{error}</small>}
        {children && (
          <ul>
            {children.map((child) => (
              <TreeFolder
                key={child.path}
                entry={child}
                load={load}
                navigate={navigate}
              />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}
export function Transfers({
  transfers,
  sessionId,
  refresh,
  notify,
}: {
  transfers: Transfer[];
  sessionId?: string;
  refresh: () => void;
  notify: (s: string, error?: boolean) => void;
}) {
  const [filter, setFilter] = useState("all");
  const conflicts = useConflictReview(transfers, true, refresh);
  const shown = transfers.filter(
    (t) => filter === "all" || t.status === filter,
  );
  const action = async (name: string, id: string) => {
    try {
      const preferred =
        name === "transfer_retry" || name === "transfer_resume"
          ? sessionId
          : undefined;
      await request(
        name,
        preferred ? { id, preferredSessionId: preferred } : { id },
      );
      refresh();
    } catch (e) {
      notify(message(e), true);
    }
  };
  return (
    <section className="page">
      <PageHeader
        title="Transfers"
        description="Track file transfers and review completed activity."
      >
        <Button onClick={refresh}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </PageHeader>
      <div className="list-controls">
        <label className="inline-field">
          <span>Status</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {[
              "all",
              "queued",
              "running",
              "completed",
              "failed",
              "cancelled",
              "conflict",
              "skipped",
            ].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <span className="result-count">{shown.length} transfers</span>
      </div>
      {!shown.length ? (
        <Empty
          icon={<ArrowDown size={28} />}
          title="No transfers here"
          description="Upload or download files from the file manager. Progress and transfer history appear here."
        />
      ) : (
        <div className="transfer-list">
          {shown.map((t) => (
            <div className="transfer-row" key={t.id}>
              <div className="transfer-icon">
                {t.direction === "upload" ? (
                  <Upload size={20} />
                ) : (
                  <Download size={20} />
                )}
              </div>
              <div className="transfer-details">
                <div className="transfer-title">
                  <strong>{t.source.split(/[\\/]/).pop()}</strong>
                  <span className={`transfer-status ${t.status}`}>
                    {t.status}
                  </span>
                </div>
                <p title={t.destination}>
                  {t.renamedPaths?.[t.destination] || t.destination}
                </p>
                <progress
                  value={
                    t.status === "completed" && !t.totalBytes
                      ? 1
                      : t.transferredBytes
                  }
                  max={t.totalBytes || 1}
                  aria-label={`Progress of ${t.source}`}
                />
                <div className="transfer-meta">
                  <span>
                    {formatBytes(t.transferredBytes)} /{" "}
                    {formatBytes(t.totalBytes)} · {t.protocol.toUpperCase()}
                  </span>
                  {["running", "queued", "active"].includes(t.status) ? (
                    <span>
                      {formatBytes(t.speedBytesPerSecond)}/s ·{" "}
                      {t.etaSeconds == null
                        ? "Calculating…"
                        : `${Math.ceil(t.etaSeconds)}s left`}
                    </span>
                  ) : (
                    <span>
                      {t.totalBytes
                        ? Math.round((t.transferredBytes / t.totalBytes) * 100)
                        : t.status === "completed"
                          ? 100
                          : 0}
                      % · {clockDate(t.finishedAt || t.startedAt)}
                      {t.durationSeconds != null &&
                        ` · ${t.durationSeconds.toFixed(1)}s`}
                    </span>
                  )}
                </div>
                {t.error && <p className="danger-text">{t.error}</p>}
                {!!t.resumedBytes && (
                  <small>Continued from {formatBytes(t.resumedBytes)}</small>
                )}
                {!!t.skippedFiles && <small>{t.skippedFiles} skipped</small>}
              </div>
              <div className="toolbar">
                {["failed", "cancelled"].includes(t.status) && t.resumable && (
                  <Button
                    variant="primary"
                    onClick={() => void action("transfer_resume", t.id)}
                  >
                    Resume
                  </Button>
                )}
                {t.status === "conflict" && (
                  <Button onClick={() => conflicts.review(t.id)}>
                    Review conflict
                  </Button>
                )}
                {["failed", "cancelled"].includes(t.status) && (
                  <Button onClick={() => void action("transfer_retry", t.id)}>
                    <RefreshCw size={14} />
                    {t.resumable ? "Restart" : "Retry"}
                  </Button>
                )}
                {["running", "queued", "active", "conflict"].includes(
                  t.status,
                ) && (
                  <IconButton
                    label="Cancel transfer"
                    onClick={() => void action("transfer_cancel", t.id)}
                  >
                    <X size={17} />
                  </IconButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {conflicts.modal}
    </section>
  );
}
