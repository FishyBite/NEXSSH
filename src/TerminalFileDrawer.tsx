import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  ArrowUp,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderInput,
  FolderOpen,
  Pencil,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { drawerDownloadPlan, type DrawerDownloadHistory } from "./drawerDownloads";
import { queueFileTransfers } from "./queueFileTransfers";
import { sessionTabId } from "./terminalLayout";
import { request } from "./api";
import { message, type FileEntry, type Host, type Session, type Transfer } from "./types";
import { HostMark, sessionHostLabel } from "./HostIdentity";
import { fileDropHeading } from "./fileTransferDrag";
import { incomingTransfers } from "./fileLocations";
import { useDrawerUpload } from "./useDrawerUpload";
import { Button, IconButton } from "./ui";
import "./terminal-file-drawer.css";

type Listing = { path: string; entries: FileEntry[] };
type Destination = { path: string };
type Response = { destination: Destination; listing?: Listing; error?: string };
const noTransfers: Transfer[] = [];
const noNotice = () => {};
export type { DrawerDownloadHistory } from "./drawerDownloads";

export function TerminalFileDrawer({
  session,
  host,
  initialFolder,
  follow,
  reportedDirectory,
  folderRequest,
  onFollowChange,
  onListed,
  onInsert,
  onUseFolder,
  onTerminalDrag,
  onEditFile,
  downloadHistory,
  transfers = noTransfers,
  notify = noNotice,
  onUploadAccepted,
  onUploaded,
  onClose,
}: {
  session: Session;
  host?: Host;
  initialFolder?: string;
  follow: boolean;
  reportedDirectory?: string;
  folderRequest?: { id: number; path: string };
  onFollowChange?: (enabled: boolean) => void;
  onListed?: (sessionId: string, path: string) => void;
  onInsert: (path: string, signal: AbortSignal) => void;
  onUseFolder?: (path: string, signal: AbortSignal) => void;
  onEditFile?: (entry: FileEntry, signal: AbortSignal) => void;
  downloadHistory?: Map<string, DrawerDownloadHistory>;
  onTerminalDrag?: (
    event: PointerEvent<HTMLButtonElement>,
    path: string,
    signal: AbortSignal,
  ) => void;
  transfers?: Transfer[];
  notify?: (text: string, error?: boolean) => void;
  onUploadAccepted?: () => void;
  onUploaded?: () => void;
  onClose: () => void;
}) {
  const [destination, setDestination] = useState<Destination>(() => ({
    path:
      folderRequest?.path ||
      (follow && reportedDirectory) ||
      initialFolder ||
      ".",
  }));
  const [address, setAddress] = useState(destination.path);
  const [response, setResponse] = useState<Response>();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef("");
  const downloadButton = useRef<HTMLButtonElement>(null);
  const choosing = useRef(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const localHistory = useRef(new Map<string, DrawerDownloadHistory>());
  const history = downloadHistory ?? localHistory.current;
  const tabKey = sessionTabId(session);
  const [refresh, setRefresh] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listingLife = useRef<AbortController | null>(null);
  const focusAfterNavigation = useRef(false);
  const inFlight = useRef(new Set<Promise<void>>());
  const pendingInsert = useRef<AbortController | null>(null);
  const previousFollow = useRef({ follow, reportedDirectory });
  const navigate = (path: string, focusList = false) => {
    pendingInsert.current?.abort();
    listingLife.current?.abort();
    focusAfterNavigation.current = focusList;
    if (focusList) listRef.current?.focus({ preventScroll: true });
    setAddress(path);
    setSelectedPaths([]);
    selectionAnchor.current = "";
    setFilter("");
    setDestination({ path });
  };
  useLayoutEffect(() => {
    const previous = previousFollow.current;
    previousFollow.current = { follow, reportedDirectory };
    if (
      follow &&
      reportedDirectory &&
      (!previous.follow || reportedDirectory !== previous.reportedDirectory)
    )
      navigate(reportedDirectory);
  }, [follow, reportedDirectory]);
  const previousRequest = useRef(folderRequest?.id);
  useLayoutEffect(() => {
    if (folderRequest && folderRequest.id !== previousRequest.current)
      navigate(folderRequest.path);
    previousRequest.current = folderRequest?.id;
  }, [folderRequest?.id, folderRequest?.path]);

  useLayoutEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const listing = await request<Listing>("file_list", {
          side: "remote",
          sessionId: session.id,
          path: destination.path,
        });
        if (!current) return;
        setResponse({ destination, listing });
        setAddress((value) =>
          value === destination.path ? listing.path : value,
        );
        // This callback belongs to the route that requested the listing.
        onListed?.(session.id, listing.path);
      } catch (error) {
        if (current) setResponse({ destination, error: message(error) });
      }
    };
    // A slow listing can be overtaken. Bound concurrent SSH connections and skip obsolete requests.
    const schedule = async () => {
      if (inFlight.current.size >= 2) await Promise.race(inFlight.current);
      if (!current) return;
      const loading = load();
      inFlight.current.add(loading);
      try {
        await loading;
      } finally {
        inFlight.current.delete(loading);
      }
    };
    queueMicrotask(() => {
      if (current) void schedule();
    });
    return () => {
      current = false;
    };
  }, [destination, session.id, refresh]);
  useLayoutEffect(
    () => () => {
      pendingInsert.current?.abort();
    },
    [destination, session.id],
  );
  const ready = response?.destination === destination ? response : undefined;
  const listing = ready?.listing;
  const path = listing?.path || destination.path;
  const visibleEntries = listing?.entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  ) ?? [];
  const selectedSet = new Set(selectedPaths);
  const selectedEntries = listing?.entries.filter((entry) => !entry.isDir && selectedSet.has(entry.path)) ?? [];
  const selected = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const tabDownloads = history.get(tabKey);
  const lastDownload = transfers.find((transfer) =>
    tabDownloads?.transferIds.has(transfer.id) && transfer.direction === "download" &&
    transfer.status === "completed" && !transfer.skippedFiles,
  );
  const hover = useDrawerUpload(
    listRef,
    session,
    listing,
    notify,
    onUploadAccepted,
    onUploaded,
  );
  useLayoutEffect(() => {
    if (!listing) return;
    const lifetime = new AbortController();
    listingLife.current = lifetime;
    if (
      focusAfterNavigation.current &&
      document.activeElement === listRef.current
    )
      listRef.current
        ?.querySelector<HTMLButtonElement>(".drawer-entry")
        ?.focus({ preventScroll: true });
    focusAfterNavigation.current = false;
    return () => lifetime.abort();
  }, [listing]);
  const completed = incomingTransfers(transfers, "remote", path, session.id)
    .filter((t) => t.status === "completed")
    .map((t) => t.id);
  const knownCompletions = useRef(
    new Set(transfers.filter((t) => t.status === "completed").map((t) => t.id)),
  );
  useLayoutEffect(() => {
    if (!listing) return;
    const fresh = completed.some((id) => !knownCompletions.current.has(id));
    for (const id of completed) knownCompletions.current.add(id);
    if (fresh) setRefresh((n) => n + 1);
  }, [listing, transfers]);
  function startAction(
    path: string,
    action: (path: string, signal: AbortSignal) => void,
  ) {
    pendingInsert.current?.abort();
    pendingInsert.current = new AbortController();
    action(path, pendingInsert.current.signal);
  }
  async function downloadSelected() {
    const signal = listingLife.current?.signal;
    if (!signal || signal.aborted || choosing.current || !selectedEntries.length) return;
    choosing.current = true;
    setChoosingFolder(true);
    try {
      const folder = await open({ title: "Download to…", directory: true, multiple: false,
        defaultPath: tabDownloads?.directory });
      if (signal.aborted) return;
      const focused = document.activeElement;
      if (focused === downloadButton.current || focused === document.body)
        onUploadAccepted?.();
      if (!folder) return;
      const plan = drawerDownloadPlan(selectedEntries, folder, session);
      const record = tabDownloads ?? { directory: folder, transferIds: new Set<string>() };
      record.directory = folder;
      history.set(tabKey, record);
      const queued = await queueFileTransfers(plan, session.tabId || session.id, notify, (id) => record.transferIds.add(id));
      if (queued) onUploaded?.();
    } catch (error) {
      if (!signal.aborted) notify(message(error), true);
    } finally {
      choosing.current = false;
      setChoosingFolder(false);
    }
  }
  function selectFile(entry: FileEntry, toggle: boolean, range: boolean) {
    pendingInsert.current?.abort();
    const anchor = visibleEntries.findIndex((item) => item.path === selectionAnchor.current);
    if (range && anchor >= 0) {
      const index = visibleEntries.indexOf(entry);
      const paths = visibleEntries.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
        .filter((item) => !item.isDir).map((item) => item.path);
      setSelectedPaths((current) => toggle ? [...new Set([...current, ...paths])] : paths);
    } else {
      selectionAnchor.current = entry.path;
      setSelectedPaths((current) => !toggle ? [entry.path] : current.includes(entry.path)
        ? current.filter((path) => path !== entry.path) : [...current, entry.path]);
    }
  }
  function activate(entry: FileEntry) {
    if (entry.isDir) navigate(entry.path, true);
    else {
      selectFile(entry, false, false);
      if (onEditFile && !entry.isSymlink)
        startAction(entry.path, (_, signal) => onEditFile(entry, signal));
    }
  }
  function moveInList(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !event.altKey) {
      event.preventDefault();
      setSelectedPaths(visibleEntries.filter((entry) => !entry.isDir).map((entry) => entry.path));
      return;
    }
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(".drawer-entry"),
    );
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "Enter" && visibleEntries.length) {
      event.preventDefault();
      activate(visibleEntries[Math.max(index, 0)]);
      return;
    }
    if (event.key === "Escape" && filter) {
      event.preventDefault();
      setFilter("");
      listRef.current?.focus();
      return;
    }
    if (event.key === " " && index >= 0 && !visibleEntries[index].isDir) {
      event.preventDefault();
      selectFile(visibleEntries[index], true, false);
      return;
    }
    if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      setFilter((current) => current + event.key);
      filterRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown")
      next = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === "ArrowUp")
      next = rows[index < 0 ? rows.length - 1 : Math.max(index - 1, 0)];
    else if (event.key === "Home") next = rows[0];
    else if (event.key === "End") next = rows.at(-1);
    else if (event.key === "ArrowLeft" && listing && listing.path !== "/") {
      event.preventDefault();
      navigate(
        listing.path.slice(0, listing.path.lastIndexOf("/")) || "/",
        true,
      );
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <aside
      id="terminal-file-drawer"
      className="terminal-file-drawer"
      aria-label={`Remote files for ${sessionHostLabel(session.name, host)}`}
    >
      <header className="drawer-header">
        {host ? <HostMark host={host}/> : <FolderOpen size={16} aria-hidden="true" />}
        <div>
          <h2>Remote files</h2>
          <small title={sessionHostLabel(session.name, host)}>{sessionHostLabel(session.name, host)}</small>
        </div>
        <IconButton label="Close remote files panel" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>
      <form
        className="drawer-address"
        onSubmit={(event) => {
          event.preventDefault();
          if (address) navigate(address);
        }}
      >
        <IconButton
          label="Parent remote folder"
          disabled={!path.startsWith("/") || path === "/"}
          onClick={() => navigate(path.slice(0, path.lastIndexOf("/")) || "/")}
        >
          <ArrowUp size={15} />
        </IconButton>
        <input
          aria-label="Remote folder path"
          title={path}
          value={address}
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
        />
        <IconButton
          label="Refresh remote folder"
          onClick={() => navigate(path)}
        >
          <RefreshCw size={14} />
        </IconButton>
      </form>
      {onFollowChange && (
        <div className="drawer-follow">
          <label>
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => onFollowChange(event.target.checked)}
            />
            Follow terminal folder
          </label>
          {follow && !reportedDirectory && (
            <small role="status">
              Waiting for the shell to report its folder.
            </small>
          )}
        </div>
      )}
      <div className="drawer-filter">
        <Search size={14} aria-hidden="true" />
        <input ref={filterRef} aria-label="Filter remote files" placeholder="Type to filter…"
          value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setFilter("");
              listRef.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const rows = listRef.current?.querySelectorAll<HTMLButtonElement>(".drawer-entry");
              if (rows?.length) rows[event.key === "ArrowDown" ? 0 : rows.length - 1].focus();
            } else if (event.key === "Enter" && visibleEntries.length) {
              event.preventDefault();
              activate(visibleEntries[0]);
            }
          }} />
        {filter && <IconButton label="Clear remote file filter" onClick={() => {
          setFilter(""); filterRef.current?.focus();
        }}><X size={13} /></IconButton>}
      </div>
      <div className="drawer-list-wrap">
        <div
          ref={listRef}
          tabIndex={0}
          role="group"
          onKeyDown={moveInList}
          className="drawer-entries"
          aria-label="Remote entries"
          data-upload-hover={
            hover && hover.path === listing?.path ? "true" : undefined
          }
          aria-busy={!ready}
        >
          {!ready && <p role="status">Loading folder…</p>}
          {ready?.error && <p role="alert">{ready.error}</p>}
          {listing && listing.entries.length === 0 && (
            <p>This folder is empty.</p>
          )}
          {listing && listing.entries.length > 0 && !visibleEntries.length && <p role="status">No matching files.</p>}
          {visibleEntries.map((entry) => (
            <div key={entry.path} className="drawer-entry-row">
            <button
              type="button"
              tabIndex={-1}
              data-can-drag={
                !entry.isDir && !!onTerminalDrag ? "true" : undefined
              }
              data-drawer-directory={entry.isDir ? entry.path : undefined}
              data-upload-hover={hover?.path === entry.path ? "true" : undefined}
              className="drawer-entry"
              aria-pressed={entry.isDir ? undefined : selectedSet.has(entry.path)}
              aria-label={
                entry.isDir
                  ? `Open folder ${entry.name}`
                  : `Select ${entry.name}`
              }
              title={entry.name}
              onPointerDown={(event) => {
                const signal = listingLife.current?.signal;
                if (!entry.isDir && signal && !signal.aborted)
                  onTerminalDrag?.(event, entry.path, signal);
              }}
              onClick={(event) => {
                pendingInsert.current?.abort();
                if (entry.isDir) navigate(entry.path, true);
                else selectFile(entry, event.ctrlKey || event.metaKey, event.shiftKey);
              }}
            >
              {entry.isDir ? <Folder size={15} /> : <File size={15} />}
              <span>{entry.name}</span>
              {entry.isDir && <ChevronRight size={13} />}
            </button>
            {!entry.isDir && <input type="checkbox" className="drawer-select-file" tabIndex={-1}
              checked={selectedSet.has(entry.path)} aria-label={"Include " + entry.name + " in selection"}
              onChange={() => selectFile(entry, true, false)} />}
            </div>
          ))}
        </div>
        {hover && (
          <div className="drawer-drop-hint" role="status">
            <span>
              {fileDropHeading("local", hover.count, host?.name || session.name)} · {hover.path}
            </span>
          </div>
        )}
      </div>
      <footer className="drawer-footer">
        <div className="drawer-file-actions">
          <Button ref={downloadButton} disabled={!selectedEntries.length || choosingFolder}
            onClick={() => void downloadSelected()} title={tabDownloads?.directory}>
            <Download size={15} /> {selectedEntries.length > 1 ? "Download " + selectedEntries.length + " to…" : "Download to…"}
          </Button>
          {onEditFile && <Button disabled={!selected || selected.isSymlink}
            onClick={() => { if (selected) startAction(selected.path, (_, signal) => onEditFile(selected, signal)); }}>
            <Pencil size={14} /> Edit file
          </Button>}
        </div>
        {lastDownload && <Button variant="ghost" title={lastDownload.renamedPaths?.[lastDownload.destination] || lastDownload.destination}
          onClick={() => void request("transfer_reveal", { id: lastDownload.id }).catch((error) => notify(message(error), true))}>
          <FolderOpen size={14} /> Show in Explorer
        </Button>}
        {onUseFolder && (
          <Button
            variant="secondary"
            disabled={!listing}
            onClick={() => {
              if (listing) startAction(listing.path, onUseFolder);
            }}
          >
            <FolderInput size={15} /> Use folder in terminal
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={!selected || !listing}
          title={selected?.path}
          onClick={() => {
            if (!selected || !listing) return;
            startAction(selected.path, onInsert);
          }}
        >
          <TerminalSquare size={15} /> Insert path into terminal
        </Button>
      </footer>
    </aside>
  );
}
