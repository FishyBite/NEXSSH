import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Files,
  Database,
  TerminalSquare,
} from "lucide-react";
import type { Transfer } from "./types";

export function SessionViewSwitch({
  files,
  database = false,
  onDatabase,
  onTerminal,
  onFiles,
  shortcut,
}: {
  files: boolean;
  database?: boolean;
  onDatabase?: () => void;
  onTerminal: () => void;
  onFiles: () => void;
  shortcut?: string;
}) {
  return (
    <div className="session-view-switch" role="group" aria-label="Session view">
      <button
        type="button"
        aria-pressed={!files && !database}
        onClick={onTerminal}
        title={
          files && shortcut ? `Open terminal (${shortcut})` : "Open terminal"
        }
      >
        <TerminalSquare size={14} aria-hidden="true" /> Terminal
      </button>
      <button
        type="button"
        aria-pressed={files}
        onClick={onFiles}
        title={!files && shortcut ? `Open SFTP (${shortcut})` : "Open SFTP"}
      >
        <Files size={14} aria-hidden="true" /> SFTP
      </button>
      {onDatabase && <button type="button" aria-pressed={database} onClick={onDatabase} title="Open database for this session">
        <Database size={14} aria-hidden="true" /> Database
      </button>}
    </div>
  );
}

type Progress = {
  count: number;
  upload: boolean;
  download: boolean;
  waiting: boolean;
  measured: boolean;
  total: number;
  done: number;
};

export function progressBySession(transfers: Transfer[]) {
  const groups = new Map<string, Progress>();
  function add(sessionId: string, item: Transfer, direction: string) {
    let progress = groups.get(sessionId);
    if (!progress) {
      progress = {
        count: 0,
        upload: false,
        download: false,
        waiting: false,
        measured: true,
        total: 0,
        done: 0,
      };
      groups.set(sessionId, progress);
    }
    progress.count++;
    progress.upload ||= direction === "upload";
    progress.download ||= direction === "download";
    progress.waiting ||= item.status === "conflict";
    progress.measured &&= item.totalBytes > 0;
    progress.total += item.totalBytes;
    progress.done += Math.min(
      item.totalBytes,
      Math.max(0, item.transferredBytes),
    );
  }
  for (const item of transfers) {
    if (!["queued", "running", "conflict"].includes(item.status)) continue;
    add(item.sessionId, item, item.direction === "relay" ? "upload" : item.direction);
    if (item.direction === "relay" && item.sourceSessionId && item.sourceSessionId !== item.sessionId) {
      add(item.sourceSessionId, item, "download");
    }
  }
  return groups;
}

export function SessionTransferButton({
  name,
  progress,
  onClick,
}: {
  name: string;
  progress: Progress;
  onClick: () => void;
}) {
  const { upload, download, count, waiting, measured, done, total } = progress;
  const Icon = upload && download ? ArrowUpDown : upload ? ArrowUp : ArrowDown;
  const kind = upload && download ? "transfer" : upload ? "upload" : "download";
  const percent = measured ? Math.floor((100 * done) / total) : undefined;
  const status = waiting
    ? "waiting for a decision"
    : percent !== undefined
      ? `${percent}%`
      : "in queue";
  const label = `Transfers for ${name}: ${count} ${kind}${count === 1 ? "" : "s"}, ${status}`;
  return (
    <button
      type="button"
      className="session-transfer"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={13} aria-hidden="true" />
      {waiting ? "!" : percent !== undefined ? `${percent}%` : count}
    </button>
  );
}
