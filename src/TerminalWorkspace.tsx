import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  PanelLeft, SlidersHorizontal,
  Search,
  X,
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
  Eraser,
  RefreshCw,
  Unplug,
  Activity,
  Plus,
  Copy,
  ClipboardPaste,
  ArrowUp,
  ArrowDown,
  TerminalSquare,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
  Check,
  Pencil,
  Folder,
  Type,
  Minus,
  RotateCcw,
  LoaderCircle,
  Plug,
  PanelRightOpen,
} from "lucide-react";
import type { Session, Config, Transfer } from "./types";
import { message } from "./types";
import { getTerminalTheme } from "./terminalThemes";
import { applyTerminalFont } from "./applyTerminalFont";
import { protectsKeyboardInput } from "./sessionShortcuts";
import { request, subscribe } from "./api";
import { readClipboardText, writeClipboardText } from "./clipboard";
import { quoteRemotePath } from "./terminalCommands";
import { observeShellPrompt } from "./shellPrompt";
import { startTerminalPathDrag } from "./terminalPathDrag";
import { trackTerminalDirectory } from "./terminalDirectory";
import { enableTerminalDragSelection } from "./terminalMouseSelection";
import { registerTerminalPathLinks, type TerminalPath } from "./terminalPathLinks";
import { useTerminalPathOpen } from "./useTerminalPathOpen";
import { TerminalCommandBar } from "./TerminalCommandBar";
import { TerminalFileDrawer, type DrawerDownloadHistory } from "./TerminalFileDrawer";
import { DrawerResizeHandle, type DrawerSizes } from "./DrawerResizeHandle";
import { useRelativePathOpen } from "./RelativePathPicker";
import { fileSessionBinding } from "./fileSessions";
import {
  progressBySession,
  SessionTransferButton,
  SessionViewSwitch,
} from "./SessionViewControls";
import { Button, IconButton, Empty, Field, Modal } from "./ui";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { HostMark, sessionHostLabel } from "./HostIdentity";
import { ResumeTransferButton } from "./ResumeTransferButton";
import { resumableOnTab } from "./transferRecovery";
import { stableSessionOrder, type TabPlacement } from "./sessionOrder";
import { useTabReorder } from "./useTabReorder";
import { SplitDivider } from "./SplitDivider";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";
import type { PaneView, TerminalLayout } from "./terminalLayout";
import {
  defaultTerminalLayout,
  effectiveSessionGroup,
  normalizeTerminalLayout,
  resolveSplitPair,
  sessionTabId,
  terminalLayoutKey,
  terminalSettings,
} from "./terminalLayout";
import "./terminal-workspace.css";

const TerminalPathPreview = lazy(() => import("./TerminalPathPreview"));

export type TerminalAction =
  | {
      kind: "write" | "search" | "clear";
      data?: string;
      id: number;
      sessionId?: string;
    }
  | { kind: "insertPath" | "useFolder"; data: string; id: number; sessionId: string; drawerSignal?: AbortSignal };
// A suspended workspace can re-run effects for an already-delivered action.
const consumedActions = new WeakSet<TerminalAction>();

function checkedDrawerInput(sessionId: string, text: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      resolve("");
      return;
    }
    const cancel = () => resolve("");
    signal.addEventListener("abort", cancel, { once: true });
    void request("ssh_check_path_target", { sourceId: sessionId, targetId: sessionId })
      .then(() => resolve(text), reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}

function canFocusShell() {
  return !document.querySelector(
    '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"]), dialog[open], [data-session-drawer="open"], [role="menu"]:not([data-state="closed"]), .context-menu',
  );
}
type SessionPatch = Pick<
  Partial<Session>,
  "groupId" | "terminalProfileId" | "fontSize"
>;
interface Props {
  immersive: boolean;
  windowFullscreen: boolean;
  fullscreenButton: React.ReactNode;
  sidebarOpen: boolean;
  sidebarTrigger: RefObject<HTMLButtonElement | null>;
  onSidebar: () => void;
  layout: TerminalLayout;
  setLayout: Dispatch<SetStateAction<TerminalLayout>>;
  openPaneView: (id: string, mode: PaneView) => void;
  sessions: Session[];
  active: string;
  setActive: (s: string) => void;
  config: Config;
  appearance: Config["settings"]["terminalTheme"];
  onDisconnect: (id: string) => void;
  onReconnect: (id: string) => void;
  onNew: () => void;
  onSavedLayouts: () => void;
  onFiles: () => void;
  onTerminal?: () => void;
  filesVisible?: boolean;
  databaseVisible?: boolean;
  onDatabase?: () => void;
  modeShortcutLabel?: string;
  dialogFocusRequest?: number;
  transfers?: Transfer[];
  onTransfersQueued?: () => void;
  onPreviewDirtyChange: (dirty: boolean) => void;
  onOpenSessionTransfers?: (id: string) => void;
  onMonitor: () => void;
  notify: (s: string, error?: boolean) => void;
  visible: boolean;
  action?: TerminalAction;
  onTerminalActionConsumed?: (action: TerminalAction) => void;
  remoteFolder?: string;
  followTerminalFolder?: boolean;
  reportedDirectory?: string;
  onFollowTerminalFolderChange?: (enabled: boolean) => void;
  onRemoteFolderListed?: (sessionId: string, path: string) => void;
  rename: (id: string, name: string) => void;
  onReorder: (
    sourceId: string,
    targetId: string,
    placement: TabPlacement,
  ) => void;
  onDuplicate: (id: string) => void;
  onCloseOthers: (id: string, side: "all" | "right") => void;
  onUpdateSession: (id: string, patch: SessionPatch) => void;
}

export function readLayout(restoreWorkspace: boolean) {
  try {
    const stored = restoreWorkspace
      ? localStorage.getItem(terminalLayoutKey)
      : null;
    return stored
      ? normalizeTerminalLayout(JSON.parse(stored))
      : {
          ...defaultTerminalLayout,
          fullscreen:
            localStorage.getItem("nexssh.terminal.expanded") === "true",
        };
  } catch {
    return { ...defaultTerminalLayout };
  }
}

export function TerminalWorkspace({
  immersive, sidebarOpen, sidebarTrigger, onSidebar, windowFullscreen, fullscreenButton,
  layout, setLayout, openPaneView,
  sessions,
  active,
  setActive,
  config,
  appearance,
  onDisconnect,
  onReconnect,
  onNew,
  onSavedLayouts,
  onFiles,
  onTerminal,
  filesVisible = false,
  databaseVisible = false,
  onDatabase,
  modeShortcutLabel,
  dialogFocusRequest = 0,
  transfers,
  onTransfersQueued,
  onPreviewDirtyChange,
  onOpenSessionTransfers,
  onMonitor,
  notify,
  visible,
  action,
  onTerminalActionConsumed,
  remoteFolder,
  followTerminalFolder = false,
  reportedDirectory,
  onFollowTerminalFolderChange,
  onRemoteFolderListed,
  rename,
  onReorder,
  onDuplicate,
  onCloseOthers,
  onUpdateSession,
}: Props) {
  const { split, primaryTabId, secondaryTabId, fullscreen, composerVisible } = layout;
  const [toolsOpen, setToolsOpen] = useState(false);
  const topline = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [name, setName] = useState("");
  const [localAction, setLocalAction] = useState<TerminalAction>();
  const [group, setGroup] = useState("");
  const [reorderNotice, setReorderNotice] = useState("");
  const [terminalFocusRequest, requestTerminalFocus] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerSizes = useRef<DrawerSizes>({});
  const drawerDownloads = useRef(new Map<string, DrawerDownloadHistory>());
  const focusOnOpen = useRef("");
  const drawerBindings = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    const openIds = new Set(sessions.map((session) => session.id));
    const openTabs = new Set(sessions.map(sessionTabId));
    for (const tab of drawerDownloads.current.keys()) {
      if (!openTabs.has(tab)) drawerDownloads.current.delete(tab);
    }
    for (const id of drawerBindings.current.keys()) {
      if (!openIds.has(id)) drawerBindings.current.delete(id);
    }
    for (const session of sessions) {
      if (session.status === "connected" && !drawerBindings.current.has(session.id))
        drawerBindings.current.set(session.id, fileSessionBinding(session.hostId, config.hosts));
    }
  }, [sessions, config.hosts]);
  const transferProgress = useMemo(
    () => progressBySession(transfers || []),
    [transfers],
  );
  const paneSessions = useRef<Session[]>([]);
  paneSessions.current = stableSessionOrder(paneSessions.current, sessions);
  const panesRef = useRef<HTMLDivElement>(null);
  const previousSession = useRef("");
  const pair = resolveSplitPair(paneSessions.current, active, primaryTabId, secondaryTabId);
  const workspaceShown = visible || filesVisible || databaseVisible;
  useLayoutEffect(() => {
    if (!immersive || !topline.current) return;
    const bar = topline.current;
    const shell = bar.closest<HTMLElement>(".app-shell");
    if (!shell) return;
    const measure = () => shell.style.setProperty("--session-strip-height", bar.getBoundingClientRect().height + "px");
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => { observer.disconnect(); shell.style.removeProperty("--session-strip-height"); };
  }, [immersive]);
  useEffect(() => { if (!immersive) setToolsOpen(false); }, [immersive]);
  const mixed = split !== "none" && !!pair;
  const activeMode: PaneView = filesVisible ? "Files" : databaseVisible ? "Database" : "Terminal";
  const sessionMode = (session: Session) => session.id === active ? activeMode : layout.paneViews[sessionTabId(session)] || "Terminal";
  const firstTab = pair ? sessionTabId(pair[0]) : "";
  const secondTab = pair ? sessionTabId(pair[1]) : "";
  useLayoutEffect(() => {
    if (split === "none" || !firstTab || (primaryTabId === firstTab && secondaryTabId === secondTab)) return;
    setLayout((current) => ({ ...current, primaryTabId: firstTab, secondaryTabId: secondTab }));
  }, [split, firstTab, secondTab, primaryTabId, secondaryTabId]);
  const groupedSessions = sessions.filter(
    (session) => !group || effectiveSessionGroup(session, config) === group,
  );
  const tabReorder = useTabReorder(
    groupedSessions.map((session) => session.id),
    (sourceId, targetId, placement) => {
      onReorder(sourceId, targetId, placement);
      const source = sessions.find((session) => session.id === sourceId);
      const target = sessions.find((session) => session.id === targetId);
      if (source && target)
        setReorderNotice(`${source.name} moved ${placement} ${target.name}.`);
    },
    (sourceId, x, y) => {
      const container = panesRef.current;
      const pane = document.elementFromPoint(x, y)?.closest<HTMLElement>(".terminal-pane");
      if (!workspaceShown || !container || !pane || !container.contains(pane)) return null;
      const live = sessions.filter((session) => session.status === "connected");
      if (!live.some((session) => session.id === sourceId) ||
          !live.some((session) => session.id === pane.dataset.sessionId)) return null;
      const bounds = container.getBoundingClientRect();
      const side = x < bounds.left + bounds.width / 2 ? "left" : "right";
      const opposite = split === "vertical" && pair ? pair[side === "left" ? 1 : 0].id : undefined;
      const candidates = [opposite, pane.dataset.sessionId, previousSession.current];
      const peers = live.filter((session) => session.id !== sourceId);
      const peer = candidates.map((id) => peers.find((session) => session.id === id)).find(Boolean) || peers[0];
      return peer ? { side, peerId: peer.id } : null;
    },
    (sourceId, { peerId, side }) => {
      const source = sessions.find((session) => session.id === sourceId && session.status === "connected");
      const peer = sessions.find((session) => session.id === peerId && session.status === "connected");
      if (!workspaceShown || !source || !peer) return;
      const [first, second] = side === "left" ? [source, peer] : [peer, source];
      setLayout((current) => ({ ...current, split: "vertical", primaryTabId: sessionTabId(first), secondaryTabId: sessionTabId(second) }));
      setActive(source.id);
      requestTerminalFocus((value) => value + 1);
      setReorderNotice(`${first.name} on the left, ${second.name} on the right.`);
    },
  );
  const focused = sessions.find((session) => session.id === active);
  const priorActive = useRef(active);
  useLayoutEffect(() => {
    if (
      priorActive.current !== active &&
      focused &&
      group &&
      effectiveSessionGroup(focused, config) !== group
    )
      setGroup("");
    if (priorActive.current !== active) previousSession.current = priorActive.current;
    priorActive.current = active;
    if (!visible && !filesVisible && !databaseVisible) return;
    const strip = tabReorder.stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(".session-tab.active");
    if (!strip || !tab) return;
    const bounds = strip.getBoundingClientRect();
    const selected = tab.getBoundingClientRect();
    if (selected.left < bounds.left)
      strip.scrollLeft -= bounds.left - selected.left;
    else if (selected.right > bounds.right)
      strip.scrollLeft += selected.right - bounds.right;
  }, [active, group, visible, filesVisible, databaseVisible]);
  const focusedHost = config.hosts.find((host) => host.id === focused?.hostId);
  const originalDrawerBinding = drawerBindings.current.get(active);
  const drawerProfileChanged = !!focused && originalDrawerBinding !== undefined &&
    originalDrawerBinding !== fileSessionBinding(focused.hostId, config.hosts);
  const drawerAvailable = focused?.status === "connected" && !!focusedHost && !drawerProfileChanged;
  const pathOpen = useTerminalPathOpen(visible && drawerAvailable ? active : undefined, drawerOpen,
    () => setDrawerOpen(true), notify);
  const relativePath = useRelativePathOpen(visible && drawerAvailable ? active : undefined, pathOpen.openPath,
    () => requestTerminalFocus((n) => n + 1));
  const previewOrigin = sessions.find((session) => session.id === pathOpen.preview?.sessionId);
  const previewConnected = previewOrigin?.status === "connected" &&
    drawerBindings.current.get(previewOrigin.id) === fileSessionBinding(previewOrigin.hostId, config.hosts);
  const focusDrawerList = () => {
    const list = document.querySelector<HTMLElement>("#terminal-file-drawer .drawer-entries");
    (list?.querySelector<HTMLElement>('.drawer-entry[tabindex="0"], .drawer-entry[aria-pressed="true"]')
      || list?.querySelector<HTMLElement>(".drawer-entry") || list)?.focus({preventScroll:true});
  };
  useLayoutEffect(() => {
    if (!focusOnOpen.current) return;
    if (visible && drawerOpen && drawerAvailable && focusOnOpen.current === active && canFocusShell())
      focusDrawerList();
    focusOnOpen.current = "";
  }, [active, visible, drawerOpen, drawerAvailable]);
  useEffect(() => {
    if (!visible || !drawerAvailable) return;
    const onF6 = (e: KeyboardEvent) => {
      if (e.key !== "F6" || e.defaultPrevented || e.isComposing || e.keyCode === 229 ||
          e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !canFocusShell() ||
          !(e.target instanceof Element)) return;
      const fromDrawer = e.target.closest("#terminal-file-drawer");
      const fromShell = e.target.closest<HTMLElement>(".xterm-container")?.closest<HTMLElement>(".terminal-pane")?.dataset.sessionId === active;
      if (!fromDrawer && !fromShell) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (fromDrawer) requestTerminalFocus((n) => n + 1);
      else if (drawerOpen) focusDrawerList();
      else {
        focusOnOpen.current = active;
        setDrawerOpen(true);
      }
    };
    window.addEventListener("keydown", onF6, true);
    return () => window.removeEventListener("keydown", onF6, true);
  }, [visible, drawerAvailable, drawerOpen, active]);
  const focusedSettings = focused
    ? terminalSettings(focused, config, appearance)
    : config.settings;
  const dragged = sessions.find(
    (session) => session.id === tabReorder.drag?.sourceId,
  );
  const draggedHost = dragged && config.hosts.find(host => host.id === dragged.hostId);
  const dock = tabReorder.drag?.splitTarget;
  const dockPeer = dock && sessions.find((session) => session.id === dock.peerId);
  const act = (kind: "clear" | "search") =>
    setLocalAction({ kind, id: Date.now(), sessionId: active });
  const toggleFullscreen = useCallback(() => {
    setLayout((value) => ({ ...value, fullscreen: !value.fullscreen }));
    requestTerminalFocus(value => value + 1);
  }, []);
  const changeSplit = (value: "none" | "horizontal" | "vertical") => {
    setLayout((current) => ({
      ...current,
      split: value,
      primaryTabId: value === "none" ? "" : firstTab,
      secondaryTabId: value === "none" ? "" : secondTab,
    }));
  };
  const beginRename = (session: Session) => {
    setRenaming(session);
    setName(session.name);
  };
  const updateGroup = (id: string, groupId: string) => {
    if (group && id === active && groupId !== group) setGroup("");
    onUpdateSession(id, { groupId });
  };
  useLayoutEffect(() => {
    if (action) {
      if (action.kind === "insertPath" || action.kind === "useFolder" || action.kind === "write") {
        if (consumedActions.has(action)) return;
        if (
          !action.sessionId ||
          !visible ||
          action.sessionId !== active ||
          !sessions.some((s) => s.id === active && s.status === "connected")
        ) {
          consumedActions.add(action);
          onTerminalActionConsumed?.(action);
          return;
        }
        setLocalAction(action);
      } else {
        setLocalAction({ ...action, sessionId: action.sessionId || active });
      }
    }
  }, [action]);
  useEffect(() => {
    if (group && !config.groups.some((item) => item.id === group)) setGroup("");
  }, [group, config.groups]);
  useEffect(() => {
    if (!config.settings.restoreWorkspace)
      setLayout((value) => ({
        ...defaultTerminalLayout,
        fullscreen: value.fullscreen,
      }));
  }, [config.settings.restoreWorkspace]);
  useEffect(() => {
    try {
      if (config.settings.restoreWorkspace)
        localStorage.setItem(terminalLayoutKey, JSON.stringify(layout));
      else localStorage.removeItem(terminalLayoutKey);
      localStorage.setItem(
        "nexssh.terminal.expanded",
        String(layout.fullscreen),
      );
    } catch {}
  }, [layout, config.settings.restoreWorkspace]);
  useEffect(() => {
    if (windowFullscreen || (!visible && !(mixed && workspaceShown) && !immersive)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.ctrlKey || !event.shiftKey || protectsKeyboardInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleFullscreen();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible, mixed, workspaceShown, immersive, windowFullscreen, toggleFullscreen]);
  return (
    <div
      className={`terminal-workspace ${workspaceShown ? "is-visible" : ""} ${!mixed && (filesVisible || databaseVisible) ? "files-mode" : ""}`}
      style={{ display: visible || filesVisible || databaseVisible ? "flex" : "none" }}
    >
      <div className="terminal-topline" ref={topline}>
        {immersive && <Button variant="ghost" ref={sidebarTrigger} className="session-sidebar-trigger"
          aria-label="Sidebar" aria-controls="workspace-sidebar" aria-expanded={sidebarOpen} onClick={onSidebar}>
          <PanelLeft size={17}/><span>Sidebar</span>
        </Button>}
        {config.groups.length > 0 && (
          <select
            className="terminal-group"
            aria-label="Terminal session group"
            value={group}
            onChange={(event) => {
              const groupId = event.target.value;
              setGroup(groupId);
              const first = sessions.find(
                (session) =>
                  !groupId ||
                  effectiveSessionGroup(session, config) === groupId,
              );
              if (first) setActive(first.id);
            }}
          >
            <option value="">All sessions</option>
            {config.groups.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <div
          ref={tabReorder.stripRef}
          className={`terminal-tabs ${tabReorder.drag ? "reordering-tabs" : ""}`}
          role="tablist"
          aria-label="Terminal sessions"
        >
          {groupedSessions.map((session) => {
            const progress = transferProgress.get(session.id);
            const recoverable = resumableOnTab(session, transfers || []);
            const host = config.hosts.find(
              (item) => item.id === session.hostId,
            );
            const label = sessionHostLabel(session.name, host);
            const description = `${label}${host ? ` • ${host.username}@${host.hostname}:${host.port}` : ""} • ${session.status === "saved" ? "Saved, not connected" : session.status} • Drag to reorder or onto a terminal to split • Double-click to rename`;
            const menuProps = {
              session,
              sessions,
              config,
              onDuplicate,
              onDisconnect,
              onCloseOthers,
              onRename: beginRename,
              onGroup: updateGroup,
            };
            return (
              <ContextMenu.Root key={session.id}>
                <ContextMenu.Trigger asChild>
                  <div
                    data-session-id={session.id}
                    className={`session-tab ${active === session.id ? "active" : ""} ${tabReorder.drag?.inStrip && tabReorder.drag.sourceId === session.id ? "drag-source" : ""}`}
                  >
                    <button
                      role="tab"
                      draggable={false}
                      aria-selected={active === session.id}
                      aria-label={session.name}
                      aria-describedby={`terminal-tab-identity-${session.id} terminal-tab-reorder-help`}
                      aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight"
                      onPointerDown={(event) =>
                        tabReorder.startDrag(event, session.id)
                      }
                      onKeyDown={(event) =>
                        tabReorder.onTabKeyDown(event, session.id)
                      }
                      onClick={(event) => {
                        if (
                          event.detail > 0 &&
                          tabReorder.ignoreClick(session.id)
                        ) {
                          event.preventDefault();
                          return;
                        }
                        setActive(session.id);
                        if (visible && active === session.id)
                          requestTerminalFocus((n) => n + 1);
                      }}
                      onDoubleClick={() => {
                        if (!tabReorder.ignoreClick(session.id))
                          beginRename(session);
                      }}
                      title={description}
                    >
                      <span
                        className={`status-dot ${session.status === "connected" ? "online" : session.status === "connecting" ? "connecting" : "offline"}`}
                      />
                      {host && <HostMark host={host} size={16} />}
                      <span className="session-tab-titles">
                        <span className="session-tab-name">{session.name}</span>
                        {label !== session.name && <small>{host?.name}</small>}
                      </span>
                      <span id={`terminal-tab-identity-${session.id}`} className="sr-only">
                        {host && `${host.name}, ${host.username}@${host.hostname}:${host.port}. `}{session.status}.
                      </span>
                      <EnvironmentBadge value={host?.environmentLabel} />
                    </button>
                    {progress && onOpenSessionTransfers && (
                      <SessionTransferButton
                        name={session.name}
                        progress={progress}
                        onClick={() => onOpenSessionTransfers(session.id)}
                      />
                    )}
                    {recoverable.length > 0 && (
                      <ResumeTransferButton session={session} items={recoverable} notify={notify} onQueued={onTransfersQueued} />
                    )}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <IconButton
                          className="session-tab-menu"
                          label={`Session menu for ${session.name}`}
                          draggable={false}
                        >
                          <MoreHorizontal size={14} />
                        </IconButton>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className="terminal-menu"
                          sideOffset={5}
                          align="start"
                          collisionPadding={8}
                        >
                          <SessionMenuItems
                            menu={DropdownMenu}
                            {...menuProps}
                          />
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                    <IconButton
                      className="session-tab-close"
                      label={`Close ${session.name}`}
                      draggable={false}
                      onClick={() => onDisconnect(session.id)}
                    >
                      <X size={13} />
                    </IconButton>
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content
                    className="terminal-menu"
                    collisionPadding={8}
                  >
                    <SessionMenuItems menu={ContextMenu} {...menuProps} />
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
          <IconButton
            className="new-terminal-button"
            label="New terminal (Ctrl+Shift+T)"
            onClick={onNew}
          >
            <Plus size={16} />
          </IconButton>
          <div
            ref={tabReorder.gapRef}
            className="terminal-tab-gap"
            aria-hidden="true"
          />
          {dragged && tabReorder.drag?.inStrip && (
            <div
              ref={tabReorder.ghostRef}
              className="terminal-tab-ghost"
              aria-hidden="true"
              style={{ width: tabReorder.drag.width, height: tabReorder.drag.height, transform: `translateX(${tabReorder.drag.x}px)` }}
            >
              <span className={`status-dot ${dragged.status === "connected" ? "online" : "offline"}`} />
              {draggedHost && <HostMark host={draggedHost} size={16} />}
              <span className="session-tab-name">{dragged.name}</span>
              <EnvironmentBadge value={draggedHost?.environmentLabel} />
              <MoreHorizontal size={14} />
            </div>
          )}
        </div>
        <SessionViewSwitch
          files={filesVisible}
          database={databaseVisible}
          onDatabase={onDatabase}
          shortcut={modeShortcutLabel}
          onFiles={onFiles}
          onTerminal={() => {
            onTerminal?.();
            if (visible) requestTerminalFocus((n) => n + 1);
          }}
        />
        {(visible || (mixed && workspaceShown) || immersive) && (
          <div className="terminal-layout-controls">
            {immersive && focused && (visible || mixed) && <Button variant="ghost" className="session-tools-trigger"
              aria-label="Terminal tools" title="Terminal tools" aria-controls="terminal-tools-row" aria-expanded={toolsOpen}
              onClick={() => setToolsOpen(value => !value)}><SlidersHorizontal size={16}/></Button>}
            {!windowFullscreen && <Button
              variant="ghost"
              onClick={toggleFullscreen}
              title="Toggle expanded terminal (Ctrl+Shift+Enter)"
              aria-label={fullscreen ? "Restore layout" : "Expand terminal"}
              aria-keyshortcuts="Control+Shift+Enter"
              aria-pressed={fullscreen}
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              <span>{fullscreen ? "Restore layout" : "Expand terminal"}</span>
            </Button>}
          </div>
        )}
        {workspaceShown && fullscreenButton}
      </div>
      <span id="terminal-tab-reorder-help" className="sr-only">
        Drag tabs along the strip to reorder. Drop a connected tab on the left or right of the terminal to split it.
        For keyboard reordering, focus a tab and press Control Shift Left or
        Right. Press Escape to cancel a drag. Right-click for session actions.
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {reorderNotice}
      </span>
      <section
        className="terminal-surface"
        aria-label="SSH terminals"
        hidden={!visible && !(workspaceShown && mixed)}
      >
        {!focused ? (
          <Empty
            title={group ? "No terminals in this group" : "Open a terminal"}
            description="Connect to a saved host to start an SSH session."
            action={
              <Button variant="primary" onClick={onNew}>
                Connect to host
              </Button>
            }
          />
        ) : (
          <>
            <div id="terminal-tools-row" hidden={immersive && !toolsOpen} className={`terminal-toolbar ${visible ? "" : "mixed-tool-toolbar"}`}>
              <div
                className="connection-info"
                title={
                  focusedHost
                    ? `${focusedHost.username}@${focusedHost.hostname}:${focusedHost.port}`
                    : focused.name
                }
              >
                <span
                  className={`connection-state ${focused.status === "connected" ? "connected" : ""}`}
                >
                  {focused.status === "saved"
                    ? "Not connected"
                    : focused.status}
                </span>
                <span className="connection-address">
                  {focusedHost
                    ? `${focusedHost.username}@${focusedHost.hostname}`
                    : focused.name}
                </span>
                {focused.status === "connected" && (
                  <small>{Math.round(focused.latencyMs)} ms</small>
                )}
                <EnvironmentBadge value={focusedHost?.environmentLabel} />
              </div>
              <div
                className="terminal-primary-tools"
                aria-label="Terminal tools"
              >
                <Button
                  variant="ghost"
                  disabled={
                    focused.status === "saved" ||
                    focused.status === "connecting"
                  }
                  title="Search terminal (Ctrl+Shift+F)"
                  onClick={() => act("search")}
                >
                  <Search size={15} />
                  <span>Search</span>
                </Button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button
                      variant="ghost"
                      aria-label="Split terminal"
                      disabled={!pair}
                    >
                      <Columns2 size={15} />
                      <span>Split</span>
                      <ChevronDown size={12} />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="terminal-menu"
                      sideOffset={6}
                      collisionPadding={8}
                      align="end"
                    >
                      <DropdownMenu.Label className="terminal-menu-label">
                        Terminal layout
                      </DropdownMenu.Label>
                      <DropdownMenu.RadioGroup
                        value={split}
                        onValueChange={(value) =>
                          changeSplit(value as typeof split)
                        }
                      >
                        <DropdownMenu.RadioItem value="none">
                          <TerminalSquare size={15} />
                          Single pane
                          <DropdownMenu.ItemIndicator className="terminal-menu-check">
                            <Check size={14} />
                          </DropdownMenu.ItemIndicator>
                        </DropdownMenu.RadioItem>
                        <DropdownMenu.RadioItem value="vertical">
                          <Columns2 size={15} />
                          Split side by side
                          <DropdownMenu.ItemIndicator className="terminal-menu-check">
                            <Check size={14} />
                          </DropdownMenu.ItemIndicator>
                        </DropdownMenu.RadioItem>
                        <DropdownMenu.RadioItem value="horizontal">
                          <Rows2 size={15} />
                          Split top and bottom
                          <DropdownMenu.ItemIndicator className="terminal-menu-check">
                            <Check size={14} />
                          </DropdownMenu.ItemIndicator>
                        </DropdownMenu.RadioItem>
                      </DropdownMenu.RadioGroup>
                      <DropdownMenu.Separator/>
                      <DropdownMenu.Item onSelect={onSavedLayouts}><Columns2 size={15}/>Saved layouts…</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <Button
                  variant="ghost"
                  className="file-drawer-toggle"
                  aria-label="Remote files panel"
                  title={drawerProfileChanged ? "Reconnect to browse files after a host profile change." : "Remote files panel"}
                  aria-expanded={drawerOpen && drawerAvailable}
                  aria-controls="terminal-file-drawer"
                  disabled={!drawerAvailable}
                  onClick={() => {
                    setDrawerOpen((open) => !open);
                    requestTerminalFocus((n) => n + 1);
                  }}
                >
                  <PanelRightOpen size={15} />
                  <span className="drawer-toggle-label">Remote files</span>
                </Button>
                <Button
                  variant="ghost"
                  className="command-toggle"
                  aria-expanded={composerVisible}
                  aria-controls={`command-composer-${active}`}
                  onClick={() =>
                    setLayout((value) => ({
                      ...value,
                      composerVisible: !value.composerVisible,
                    }))
                  }
                  title={
                    composerVisible ? "Hide command bar" : "Show command bar"
                  }
                >
                  <TerminalSquare size={15} />
                  <span>Command</span>
                </Button>
                <span className="terminal-tool-divider" />
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button variant="ghost" aria-label="More terminal actions">
                      <MoreHorizontal size={17} />
                      <span className="terminal-more-label">More</span>
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="terminal-menu"
                      sideOffset={6}
                      collisionPadding={8}
                      align="end"
                    >
                      <DropdownMenu.Sub>
                        <DropdownMenu.SubTrigger>
                          <Type size={15} />
                          Appearance
                          <span className="terminal-menu-detail">
                            {focusedSettings.fontSize}px
                          </span>
                          <ChevronRight size={14} />
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.SubContent
                            className="terminal-menu terminal-appearance-menu"
                            sideOffset={4}
                            collisionPadding={8}
                          >
                            <DropdownMenu.Label className="terminal-menu-label">
                              Appearance profile for this tab
                            </DropdownMenu.Label>
                            <DropdownMenu.RadioGroup
                              value={
                                focused.terminalProfileId === undefined
                                  ? "inherit"
                                  : focused.terminalProfileId || "default"
                              }
                              onValueChange={(value) =>
                                onUpdateSession(active, {
                                  terminalProfileId:
                                    value === "inherit"
                                      ? undefined
                                      : value === "default"
                                        ? ""
                                        : value,
                                  fontSize: undefined,
                                })
                              }
                            >
                              <DropdownMenu.RadioItem value="inherit">
                                Host default
                                <DropdownMenu.ItemIndicator className="terminal-menu-check">
                                  <Check size={14} />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.RadioItem>
                              <DropdownMenu.RadioItem value="default">
                                Application default
                                <DropdownMenu.ItemIndicator className="terminal-menu-check">
                                  <Check size={14} />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.RadioItem>
                              {config.terminalProfiles.map((profile) => (
                                <DropdownMenu.RadioItem
                                  key={profile.id}
                                  value={profile.id}
                                >
                                  {profile.name}
                                  <DropdownMenu.ItemIndicator className="terminal-menu-check">
                                    <Check size={14} />
                                  </DropdownMenu.ItemIndicator>
                                </DropdownMenu.RadioItem>
                              ))}
                            </DropdownMenu.RadioGroup>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Label className="terminal-menu-label">
                              Font size · {focusedSettings.fontSize} px
                            </DropdownMenu.Label>
                            <DropdownMenu.Item
                              disabled={focusedSettings.fontSize >= 32}
                              onSelect={(event) => {
                                event.preventDefault();
                                onUpdateSession(active, {
                                  fontSize: focusedSettings.fontSize + 1,
                                });
                              }}
                            >
                              <Plus size={15} />
                              Increase font size
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              disabled={focusedSettings.fontSize <= 8}
                              onSelect={(event) => {
                                event.preventDefault();
                                onUpdateSession(active, {
                                  fontSize: focusedSettings.fontSize - 1,
                                });
                              }}
                            >
                              <Minus size={15} />
                              Decrease font size
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              disabled={focused.fontSize === undefined}
                              onSelect={() =>
                                onUpdateSession(active, { fontSize: undefined })
                              }
                            >
                              <RotateCcw size={15} />
                              Reset font size
                            </DropdownMenu.Item>
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Sub>
                      <DropdownMenu.Item
                        disabled={focused.status !== "connected"}
                        onSelect={onMonitor}
                      >
                        <Activity size={15} />
                        Server monitoring
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        disabled={focused.status === "saved"}
                        onSelect={() => act("clear")}
                      >
                        <Eraser size={15} />
                        Clear scrollback
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item onSelect={() => onDuplicate(active)}>
                        <Copy size={15} />
                        Duplicate connection
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        disabled={focused.status === "connecting"}
                        onSelect={() => onReconnect(active)}
                      >
                        <RefreshCw size={15} />
                        {focused.status === "saved" ? "Connect" : "Reconnect"}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="terminal-menu-danger"
                        onSelect={() => onDisconnect(active)}
                      >
                        <Unplug size={15} />
                        {focused.status === "connected"
                          ? "Disconnect and close"
                          : "Close terminal"}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </div>
            <div className="terminal-content">
              <div
                ref={panesRef}
                className={`terminal-panes ${split !== "none" && pair ? split : "single-pane"}`}
                style={{ "--split-first": String(layout.ratio) + "fr", "--split-second": String(100 - layout.ratio) + "fr" } as CSSProperties}
              >
                {paneSessions.current.map(session => {
                  const host = config.hosts.find(item => item.id === session.hostId);
                  const paneVisible = workspaceShown && (session.id === active || (mixed && !!pair?.some(item => item.id === session.id)));
                  const paneMode = sessionMode(session);
                  return <TerminalPane
                    key={sessionTabId(session)}
                    session={session}
                    paneVisible={paneVisible && (mixed || visible)}
                    paneMode={mixed ? paneMode : "Terminal"}
                    address={host ? host.username + "@" + host.hostname : session.name}
                    onViewChange={mode => openPaneView(session.id, mode)}
                    onOpenPath={relativePath.open}
                    hostname={host?.hostname}
                    settings={terminalSettings(session, config, appearance)}
                    snippets={config.snippets}
                    workspaceId={host?.workspaceId}
                    onTerminalActionConsumed={(delivered) => {
                      setLocalAction((current) =>
                        current === delivered ? undefined : current,
                      );
                      onTerminalActionConsumed?.(delivered);
                    }}
                    visible={paneVisible && paneMode === "Terminal"}
                    position={split !== "none" && pair?.[1].id === session.id ? 2 : 0}
                    active={session.id === active}
                    focusRequest={terminalFocusRequest + dialogFocusRequest}
                    activate={() => setActive(session.id)}
                    action={
                      localAction?.sessionId === session.id
                        ? localAction
                        : undefined
                    }
                    notify={notify}
                    composerVisible={composerVisible}
                    onConnect={() => onReconnect(session.id)}
                  />;
                })}
                {split !== "none" && pair && <SplitDivider direction={split} ratio={layout.ratio}
                  onResize={ratio => setLayout(current => current.ratio === ratio ? current : { ...current, ratio })}/>}
                {dock && dragged && dockPeer && (
                  <div className="terminal-split-preview" aria-hidden="true">
                    {(["left", "right"] as const).map((side) => (
                      <div key={side} className={side === dock.side ? "receiving-pane" : ""}>
                        <span>{side === dock.side && <Columns2 size={16} />}
                          {side === dock.side ? `Open ${dragged.name} on the ${side}` : dockPeer.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {visible && drawerOpen && drawerAvailable && (
                <>
                  <DrawerResizeHandle sizes={drawerSizes} />
                  <TerminalFileDrawer
                    key={focused.id}
                    session={focused}
                    host={focusedHost}
                    downloadHistory={drawerDownloads.current}
                    onEditFile={(entry, signal) => {
                      if (!signal.aborted) void pathOpen.openPath(focused.id, {path: entry.path}, {edit: true, signal});
                    }}
                    initialFolder={remoteFolder}
                    folderRequest={pathOpen.folderRequest}
                    follow={followTerminalFolder}
                    reportedDirectory={reportedDirectory}
                    onFollowChange={onFollowTerminalFolderChange}
                    onListed={onRemoteFolderListed}
                    notify={notify}
                    transfers={transfers}
                    onUploaded={onTransfersQueued}
                    onUploadAccepted={() => requestTerminalFocus((n) => n + 1)}
                    onUseFolder={(path, drawerSignal) => setLocalAction({
                      kind: "useFolder", data: path, id: Date.now(), sessionId: focused.id, drawerSignal,
                    })}
                    onTerminalDrag={(event, path, drawerSignal) =>
                      startTerminalPathDrag(event, focused.id, drawerSignal, () => {
                        if (canFocusShell()) setLocalAction({kind:"insertPath", data:path, id:Date.now(), sessionId:focused.id, drawerSignal});
                      })}
                    onInsert={(path, drawerSignal) =>
                      setLocalAction({
                        kind: "insertPath",
                        data: path,
                        id: Date.now(),
                        sessionId: focused.id,
                        drawerSignal,
                      })
                    }
                    onClose={() => {
                      setDrawerOpen(false);
                      requestTerminalFocus((n) => n + 1);
                    }}
                  />
                </>
              )}
            </div>
          </>
        )}
      </section>
      {pathOpen.opening && <span className="path-open-status" role="status">Opening remote path…</span>}
      {relativePath.picker}
      {pathOpen.preview && (
        <Suspense fallback={<span className="path-open-status" role="status">Opening preview…</span>}>
          <TerminalPathPreview
            key={JSON.stringify([pathOpen.preview.sessionId, pathOpen.preview.path])}
            preview={pathOpen.preview}
            sessionName={previewOrigin?.name || "Disconnected session"}
            connected={previewConnected}
            onDirtyChange={onPreviewDirtyChange}
            onClose={() => {
              pathOpen.close();
              if (previewOrigin && previewConnected) {
                setActive(previewOrigin.id);
                if (!visible) onTerminal?.();
                requestTerminalFocus((n) => n + 1);
              }
            }}
          />
        </Suspense>
      )}
      <Modal
        open={!!renaming}
        onOpenChange={(value) => {
          if (!value) setRenaming(null);
        }}
        title="Rename terminal"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (renaming && name.trim()) rename(renaming.id, name.trim());
            setRenaming(null);
          }}
        >
          <div className="modal-body">
            <Field label="Terminal name">
              <input
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <footer className="modal-footer">
            <Button type="submit" variant="primary">
              Rename
            </Button>
          </footer>
        </form>
      </Modal>
    </div>
  );
}

function SessionMenuItems({
  menu: Menu,
  session,
  sessions,
  config,
  onDuplicate,
  onDisconnect,
  onCloseOthers,
  onRename,
  onGroup,
}: {
  menu: typeof ContextMenu | typeof DropdownMenu;
  session: Session;
  sessions: Session[];
  config: Config;
  onDuplicate: Props["onDuplicate"];
  onDisconnect: Props["onDisconnect"];
  onCloseOthers: Props["onCloseOthers"];
  onRename: (session: Session) => void;
  onGroup: (id: string, groupId: string) => void;
}) {
  const host = config.hosts.find((item) => item.id === session.hostId);
  return (
    <>
      <Menu.Label className="terminal-menu-label terminal-menu-heading">
        <strong>{session.name}</strong>
        {host && (
          <small>
            {host.username}@{host.hostname}:{host.port}
          </small>
        )}
      </Menu.Label>
      <Menu.Item onSelect={() => onDuplicate(session.id)}>
        <Copy size={15} />
        Duplicate connection
      </Menu.Item>
      <Menu.Item onSelect={() => onRename(session)}>
        <Pencil size={15} />
        Rename
      </Menu.Item>
      <Menu.Sub>
        <Menu.SubTrigger>
          <Folder size={15} />
          Move to group
          <ChevronRight size={14} />
        </Menu.SubTrigger>
        <Menu.Portal>
          <Menu.SubContent
            className="terminal-menu"
            sideOffset={4}
            collisionPadding={8}
          >
            <Menu.RadioGroup
              value={effectiveSessionGroup(session, config)}
              onValueChange={(value) => onGroup(session.id, value)}
            >
              <Menu.RadioItem value="">
                No group
                <Menu.ItemIndicator className="terminal-menu-check">
                  <Check size={14} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
              {config.groups.map((item) => (
                <Menu.RadioItem key={item.id} value={item.id}>
                  {item.name}
                  <Menu.ItemIndicator className="terminal-menu-check">
                    <Check size={14} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.SubContent>
        </Menu.Portal>
      </Menu.Sub>
      <Menu.Separator />
      <Menu.Item
        disabled={sessions.length < 2}
        onSelect={() => onCloseOthers(session.id, "all")}
      >
        <X size={15} />
        Close other tabs
      </Menu.Item>
      <Menu.Item
        disabled={sessions.at(-1)?.id === session.id}
        onSelect={() => onCloseOthers(session.id, "right")}
      >
        <ChevronRight size={15} />
        Close tabs to the right
      </Menu.Item>
      <Menu.Item
        className="terminal-menu-danger"
        onSelect={() => onDisconnect(session.id)}
      >
        <X size={15} />
        Close terminal
      </Menu.Item>
    </>
  );
}
function TerminalPane({
  session,
  paneVisible, paneMode, address, onViewChange,
  onOpenPath,
  hostname,
  settings,
  snippets,
  workspaceId,
  onTerminalActionConsumed,
  visible,
  position,
  active,
  focusRequest,
  activate,
  action,
  notify,
  composerVisible,
  onConnect,
}: {
  session: Session;
  paneVisible: boolean;
  paneMode: PaneView;
  address: string;
  onViewChange: (mode: PaneView) => void;
  onOpenPath: (sessionId: string, target: TerminalPath) => void;
  hostname?: string;
  settings: Config["settings"];
  snippets: Config["snippets"];
  workspaceId?: string;
  onTerminalActionConsumed?: Props["onTerminalActionConsumed"];
  visible: boolean;
  position: number;
  active: boolean;
  focusRequest: number;
  activate: () => void;
  action?: TerminalAction;
  notify: (s: string, error?: boolean) => void;
  composerVisible: boolean;
  onConnect: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [previousOutput, setPreviousOutput] = useState("");
  const transport = useRef({ id: session.id, live: session.status === "connected" });
  const reconnectButton = useRef<HTMLButtonElement>(null);
  const openOutputPath = useRef(onOpenPath);
  openOutputPath.current = onOpenPath;
  // Keep the endpoint that opened this transport even if its saved profile changes.
  const endpoint = useRef(hostname);
  useLayoutEffect(() => {
    endpoint.current = hostname;
  }, [session.id]);
  const pasteFromClipboard = useRef<(() => void) | null>(null);
  const copyMouseSelection = useRef(settings.copyOnSelect);
  const rightMouseDown = useRef(false);
  useLayoutEffect(() => {
    copyMouseSelection.current = settings.copyOnSelect;
  }, [settings.copyOnSelect]);
  const insertPath = useRef<((path: string, drawerSignal?: AbortSignal) => void) | null>(null);
  const insertFolder = useRef<((path: string, signal?: AbortSignal, cleanOnly?: boolean) => void) | null>(null);
  const shellPrompt = useRef<ReturnType<typeof observeShellPrompt> | null>(null);
  type FolderChoice = { path: string; signal?: AbortSignal };
  const [folderReview, setFolderReview] = useState<FolderChoice | null>(null);
  const reviewResult = useRef<{ insert?: FolderChoice } | null>(null);
  const focusRevision = useRef(0);
  const connected = useRef(false);
  useLayoutEffect(() => {
    transport.current = { id: session.id, live: session.status === "connected" };
    connected.current = visible && active && session.status === "connected";
    focusRevision.current++;
  }, [visible, active, session.id, session.status]);
  const resizeTerminal = useRef<(() => void) | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const closeSearch = () => {
    setSearchOpen(false);
    if (connected.current && canFocusShell()) term.current?.focus();
  };
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [found, setFound] = useState(true);
  const [hasTerminal, setHasTerminal] = useState(
    session.status === "connected",
  );
  const onError = useRef(notify);
  onError.current = notify;
  useEffect(() => {
    if (session.status === "connected") setHasTerminal(true);
  }, [session.status]);
  useEffect(() => {
    if (!element.current || !hasTerminal) return;
    const terminal = new Terminal({
      fontSize: settings.fontSize,
      cursorStyle: settings.cursorStyle,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: false,
      theme: getTerminalTheme(settings.terminalTheme, settings.terminalForeground),
    });
    const prompt = observeShellPrompt(terminal);
    const liveTransport = () => transport.current.id === session.id && transport.current.live;
    shellPrompt.current = prompt;
    const fitter = new FitAddon();
    const finder = new SearchAddon();
    terminal.loadAddon(fitter);
    terminal.loadAddon(finder);
    term.current = terminal;
    const pathLinks = registerTerminalPathLinks(terminal, (target) => {
      if (liveTransport() && connected.current && canFocusShell()) openOutputPath.current(session.id, target);
    });
    search.current = finder;
    let disposed = false;
    let opened = false;
    let removeDragSelection: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    const receive = subscribe<{ sessionId: string; data: string }>(
      "terminal-data",
      (p) => {
        if (p.sessionId !== session.id || disposed) return;
        try {
          prompt.write(Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0)));
        } catch (e) {
          onError.current(message(e), true);
        }
      },
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    void receive.then(() => {
      if (!disposed && liveTransport())
        void request("ssh_attach", { sessionId: session.id }).catch(() => {});
    });
    let inputQueue = Promise.resolve();
    const enqueueInput = (
      input: string | Promise<string>,
      revision?: number,
      signal?: AbortSignal,
      cleanOnly = false,
    ) => {
      const inputTicket = prompt.beginInput();
      const ready =
        typeof input === "string"
          ? input
          : input.catch((error) => {
              if (!disposed && !signal?.aborted) onError.current(message(error), true);
              return "";
            });
      inputQueue = inputQueue
        .then(async () => {
          const value = await ready;
          if (
            !disposed && liveTransport() && !signal?.aborted &&
            value &&
            (revision === undefined ||
              (connected.current && revision === focusRevision.current))
          ) {
            if (cleanOnly && !inputTicket.unchanged()) {
              onError.current("The prompt changed. Your input was kept. Choose Use folder again to prepare the command.");
              return;
            }
            await request("ssh_write", { sessionId: session.id, data: value });
          }
        })
        .catch((e) => onError.current(message(e), true))
        .finally(inputTicket.finish);
    };
    insertPath.current = (path, drawerSignal) => {
      const text = quoteRemotePath(path);
      if (!connected.current || drawerSignal?.aborted || !canFocusShell()) return;
      terminal.focus();
      const input = drawerSignal ? checkedDrawerInput(session.id, text, drawerSignal) : text;
      enqueueInput(input, focusRevision.current, drawerSignal);
    };
    insertFolder.current = (path, signal, cleanOnly = false) => {
      if (!connected.current || signal?.aborted || !canFocusShell()) return;
      const text = "cd -- " + quoteRemotePath(path);
      terminal.focus();
      enqueueInput(signal ? checkedDrawerInput(session.id, text, signal) : text, focusRevision.current, signal, cleanOnly);
    };
    // xterm emits onData synchronously from paste(), including bracketed-paste markers.
    let collectPaste: ((value: string) => void) | undefined;
    const data = terminal.onData((value) => {
      if (!liveTransport()) return;
      if (collectPaste) collectPaste(value);
      else enqueueInput(value);
    });
    const paste = () => {
      if (!connected.current || document.activeElement !== terminal.textarea)
        return;
      const revision = focusRevision.current;
      // Reserve the paste's position before the asynchronous clipboard read finishes.
      enqueueInput(
        readClipboardText().then((text) => {
          if (
            !text ||
            disposed ||
            revision !== focusRevision.current ||
            !connected.current ||
            document.activeElement !== terminal.textarea ||
            !document.hasFocus()
          )
            return "";
          let input = "";
          collectPaste = (value) => {
            input += value;
          };
          try {
            terminal.paste(text);
          } finally {
            collectPaste = undefined;
          }
          return input;
        }),
        revision,
      );
    };
    pasteFromClipboard.current = paste;
    const invalidatePaste = () => {
      focusRevision.current++;
    };
    const container = element.current;
    container.addEventListener("focusout", invalidatePaste);
    window.addEventListener("blur", invalidatePaste);
    terminal.attachCustomKeyEventHandler((e) => {
      const key = e.key.toUpperCase();
      if (
        e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.isComposing &&
        (key === "V" ||
          (key === "C" && (e.shiftKey || terminal.hasSelection())))
      ) {
        e.preventDefault();
        if (e.type === "keydown") {
          if (key === "V") paste();
          else if (terminal.hasSelection())
            void writeClipboardText(terminal.getSelection()).catch((error) =>
              onError.current(message(error), true),
            );
        }
        return false;
      }
      return (
        !(
          e.ctrlKey &&
          e.shiftKey &&
          ["T", "W", "F", "P", "ENTER"].includes(key)
        ) && !(e.ctrlKey && e.key === "Tab")
      );
    });
    const resize = () => {
      if (
        disposed ||
        !opened ||
        term.current !== terminal ||
        !terminal.element?.isConnected ||
        !element.current?.clientWidth ||
        !element.current.clientHeight
      )
        return;
      try {
        fitter.fit();
        if (liveTransport()) void request("ssh_resize", {
          sessionId: session.id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => {});
      } catch {}
    };
    resizeTerminal.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    // xterm 5 schedules viewport work in open(); skip StrictMode's discarded mount.
    const openingFrame = requestAnimationFrame(() => {
      if (disposed || !element.current) return;
      try {
        terminal.open(element.current);
        removeDragSelection = enableTerminalDragSelection(terminal, () => {
          if (!copyMouseSelection.current) return;
          const text = terminal.getSelection();
          if (text) void writeClipboardText(text).catch((error) => onError.current(message(error), true));
        });
        opened = true;
        resize();
        if (connected.current && canFocusShell()) terminal.focus();
      } catch (error) {
        onError.current(`Unable to display terminal: ${message(error)}`, true);
      }
    });
    return () => {
      disposed = true;
      if (transport.current.id !== session.id) {
        // Retain plain output for review. Each new transport gets a fresh VT parser,
        // prompt, path links and input queue.
        const buffers = terminal.buffer.active.type === "alternate"
          ? [terminal.buffer.normal, terminal.buffer.active] : [terminal.buffer.active];
        const text = buffers.map(buffer => {
          const rows: string[] = [];
          for (let i = 0; i < buffer.length; i++) {
            const row = buffer.getLine(i);
            if (!row) continue;
            if (row.isWrapped && rows.length) rows[rows.length - 1] += row.translateToString(true);
            else rows.push(row.translateToString(true));
          }
          return rows.join("\n").trimEnd();
        }).filter(Boolean).join("\n\n");
        if (text) setPreviousOutput(prior => (prior ? prior + "\n\n" + text : text).slice(-4 * 1024 * 1024));
      }
      insertPath.current = null;
      insertFolder.current = null;
      shellPrompt.current = null;
      prompt.dispose();
      pasteFromClipboard.current = null;
      window.removeEventListener("blur", invalidatePaste);
      container.removeEventListener("focusout", invalidatePaste);
      cancelAnimationFrame(openingFrame);
      removeDragSelection?.();
      unlisten?.();
      observer.disconnect();
      data.dispose();
      pathLinks.dispose();
      if (term.current === terminal) {
        term.current = null;
        resizeTerminal.current = null;
        search.current = null;
      }
      terminal.dispose();
    };
  }, [session.id, hasTerminal]);
  useLayoutEffect(() => {
    if (term.current) term.current.options.disableStdin = session.status !== "connected";
    if (visible && active && session.status !== "connected" &&
        term.current?.textarea === document.activeElement && canFocusShell())
      reconnectButton.current?.focus({ preventScroll: true });
  }, [session.status, visible, active]);
  useEffect(() => {
    if (!term.current || !endpoint.current || session.status !== "connected") return;
    return trackTerminalDirectory(term.current, session.id, endpoint.current);
  }, [session.id, hasTerminal, session.status]);
  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    return applyTerminalFont(terminal, settings.fontFamily, settings.fontSize, () => resizeTerminal.current?.());
  }, [session.id, hasTerminal, settings.fontFamily, settings.fontSize]);
  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    terminal.options.cursorStyle = settings.cursorStyle;
    terminal.options.theme = getTerminalTheme(settings.terminalTheme, settings.terminalForeground);
  }, [
    session.id,
    settings.cursorStyle,
    settings.terminalTheme,
    settings.terminalForeground,
    hasTerminal,
  ]);
  useLayoutEffect(() => {
    if (!visible) return;
    if (active && canFocusShell()) {
      if (connected.current && term.current?.textarea) term.current.focus();
      else if (!connected.current) reconnectButton.current?.focus({ preventScroll: true });
    }
    const frame = requestAnimationFrame(() => resizeTerminal.current?.());
    return () => cancelAnimationFrame(frame);
  }, [visible, active, hasTerminal, focusRequest]);
  useLayoutEffect(() => {
    if (action?.kind === "insertPath" || action?.kind === "useFolder") {
      if (consumedActions.has(action)) return;
      consumedActions.add(action);
      try {
        if (
          visible &&
          active &&
          session.id === action.sessionId &&
          session.status === "connected"
        ) {
          if (!insertPath.current)
            throw new Error("The terminal is not ready to receive a path.");
          if (action.kind === "insertPath") insertPath.current(action.data, action.drawerSignal);
          else if (!action.drawerSignal?.aborted && canFocusShell()) {
            quoteRemotePath(action.data);
            if (shellPrompt.current?.fresh())
              insertFolder.current?.(action.data, action.drawerSignal, true);
            else setFolderReview({path:action.data, signal:action.drawerSignal});
          }
        }
      } catch (error) {
        notify(message(error), true);
      } finally {
        onTerminalActionConsumed?.(action);
      }
    }
  }, [action]);
  const finishFolderReview = () => {
    const decision = reviewResult.current;
    if (!decision || !connected.current || !canFocusShell()) return;
    reviewResult.current = null;
    term.current?.focus();
    if (decision.insert) insertFolder.current?.(decision.insert.path, decision.insert.signal);
  };
  useLayoutEffect(() => {
    if (!visible || !active || session.status !== "connected") {
      setFolderReview(null);
      reviewResult.current = null;
      return;
    }
    if (!folderReview) finishFolderReview();
  }, [folderReview, visible, active, session.status]);
  useEffect(() => {
    const signal = folderReview?.signal;
    if (!signal) return;
    const cancel = () => {
      reviewResult.current = {};
      setFolderReview(null);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, {once:true});
    return () => signal.removeEventListener("abort", cancel);
  }, [folderReview]);
  useEffect(() => {
    if (!action || action.kind === "insertPath" || action.kind === "useFolder") return;
    if (action.kind === "search") setSearchOpen(true);
    if (action.kind === "clear") term.current?.clear();
    if (action.kind === "write") {
      if (consumedActions.has(action)) return;
      consumedActions.add(action);
      onTerminalActionConsumed?.(action);
      if (!action.data || action.sessionId !== session.id || !connected.current) return;
      const inputTicket = shellPrompt.current?.beginInput();
      void request("ssh_write", {
        sessionId: session.id,
        data: action.data,
      }).catch((e) => notify(message(e), true)).finally(inputTicket?.finish);
    }
  }, [action]);
  useEffect(() => {
    if (!context) return;
    const close = () => setContext(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [context]);
  return (
    <div
      className={`terminal-pane ${active ? "focused" : ""}`}
      data-session-id={session.id}
      data-pane-view={paneMode}
      style={{
        display: paneVisible ? "flex" : "none",
        order: position,
        background: getTerminalTheme(settings.terminalTheme).background,
      }}
      onFocus={activate}
      onPointerDownCapture={activate}
    >
      <div className="pane-label">
        <span className="pane-endpoint" title={session.name + " · " + address}>
          <i className={`status-dot ${session.status === "connected" ? "online" : "offline"}`} aria-label={session.status}/>
          <strong>{session.name}</strong><span>{address}</span>
        </span>
        <select aria-label={"View for " + session.name} value={paneMode} onChange={event => onViewChange(event.target.value as PaneView)}>
          <option value="Terminal">Terminal</option><option value="Files">SFTP</option><option value="Database">Database</option>
        </select>
      </div>
      <div className="pane-tool-slot" data-pane-dock={session.id} hidden={paneMode === "Terminal"}/>
      {hasTerminal && (session.status === "disconnected" || session.status === "error") && (
        <div className="terminal-recovery">
          <span role="status"><strong>{session.status === "error" ? "SSH connection lost" : "SSH session ended"}</strong>
            {session.disconnectReason && <small title={session.disconnectReason}>{session.disconnectReason}</small>}
          </span>
          <Button ref={reconnectButton} variant="primary" onClick={onConnect}><RefreshCw size={14}/>Reconnect</Button>
        </div>
      )}
      {previousOutput && <details className="previous-shell-output">
        <summary>Previous shell output</summary>
        <pre tabIndex={0} aria-label="Previous shell output">{previousOutput}</pre>
      </details>}
      {searchOpen && (
        <div className="terminal-search">
          <Search size={15} />
          <input
            autoFocus
            aria-label="Search terminal output"
            value={query}
            placeholder="Find in terminal…"
            onChange={(e) => {
              setQuery(e.target.value);
              setFound(
                search.current?.findNext(e.target.value) || !e.target.value,
              );
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              if (e.key === "Enter")
                setFound(search.current?.findNext(query) || false);
            }}
          />
          {!found && <small>No matches</small>}
          <IconButton
            label="Previous match"
            onClick={() =>
              setFound(search.current?.findPrevious(query) || false)
            }
          >
            <ArrowUp size={15} />
          </IconButton>
          <IconButton
            label="Next match"
            onClick={() => setFound(search.current?.findNext(query) || false)}
          >
            <ArrowDown size={15} />
          </IconButton>
          <IconButton label="Close search" onClick={closeSearch}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      <div
        ref={element}
        className="xterm-container"
        onMouseDownCapture={(event) => {
          rightMouseDown.current = event.button === 2;
          if (event.button !== 2 || !hasTerminal) return;
          // Keep the desktop clipboard gesture local in mouse-reporting TUIs.
          event.preventDefault();
          event.stopPropagation();
          term.current?.focus();
        }}
        onKeyDownCapture={() => { rightMouseDown.current = false; }}
        onContextMenuCapture={(event) => {
          if (!hasTerminal) return;
          event.preventDefault();
          event.stopPropagation();
          const shouldPaste = rightMouseDown.current && event.button === 2 &&
            !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
          rightMouseDown.current = false;
          const terminal = term.current;
          terminal?.focus();
          if (shouldPaste && session.status === "connected") {
            setContext(null);
            pasteFromClipboard.current?.();
            return;
          }
          setContext({
            x: Math.min(event.clientX, window.innerWidth - 190),
            y: Math.min(event.clientY, window.innerHeight - 150),
          });
        }}
      />
      {!hasTerminal && (
        <div className="terminal-saved-state" role="status">
          {session.status === "connecting" ? (
            <LoaderCircle size={26} className="spin" aria-hidden="true" />
          ) : (
            <TerminalSquare size={28} strokeWidth={1.5} aria-hidden="true" />
          )}
          <h2>
            {session.status === "connecting"
              ? "Connecting…"
              : session.status === "saved"
                ? "Ready to reconnect"
                : "Session disconnected"}
          </h2>
          <p>
            {session.status === "connecting"
              ? "Establishing a secure SSH session."
              : session.status === "saved"
                ? "This tab was restored. Connect when you are ready to continue."
                : "Reconnect to start a new shell in this tab."}
          </p>
          <Button
            ref={reconnectButton}
            variant="primary"
            busy={session.status === "connecting"}
            onClick={onConnect}
          >
            <Plug size={15} />
            {session.status === "connecting" ? "Connecting" : session.status === "saved" ? "Connect" : "Reconnect"}
          </Button>
        </div>
      )}
      <TerminalCommandBar
        key={session.id}
        beginInput={() => shellPrompt.current?.beginInput().finish}
        session={session}
        snippets={snippets}
        workspaceId={workspaceId}
        visible={visible && composerVisible}
        notify={notify}
        focusTerminal={() => {
          if (connected.current) term.current?.focus();
        }}
      />
      {folderReview && visible && active && (
        <Modal
          open
          title="Use folder in terminal"
          description="This will insert the command at the current cursor. Check the prompt before inserting."
          onOpenChange={(open) => {
            if (!open) {
              reviewResult.current = {};
              setFolderReview(null);
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            finishFolderReview();
          }}
        >
          <div className="modal-body"><code className="folder-command-review">{'cd -- ' + quoteRemotePath(folderReview.path)}</code></div>
          <footer className="modal-footer">
            <Button autoFocus onClick={() => { reviewResult.current = {}; setFolderReview(null); }}>Keep current input</Button>
            <Button variant="primary" onClick={() => { reviewResult.current = {insert:folderReview}; setFolderReview(null); }}>Insert at cursor</Button>
          </footer>
        </Modal>
      )}
      {context && visible && active && (
        <div
          className="context-menu"
          style={{ left: context.x, top: context.y }}
        >
          <button
            disabled={!term.current?.hasSelection()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const text = term.current?.getSelection();
              term.current?.focus();
              setContext(null);
              if (text)
                void writeClipboardText(text).catch((error) =>
                  notify(message(error), true),
                );
            }}
          >
            <Copy size={15} />
            Copy selection
          </button>
          <button
            disabled={session.status !== "connected"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              term.current?.focus();
              setContext(null);
              pasteFromClipboard.current?.();
            }}
          >
            <ClipboardPaste size={15} />
            Paste
          </button>
          <button onClick={() => term.current?.clear()}>
            <Eraser size={15} />
            Clear scrollback
          </button>
          <button onClick={() => setSearchOpen(true)}>
            <Search size={15} />
            Find
          </button>
        </div>
      )}
    </div>
  );
}
