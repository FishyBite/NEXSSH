import type { FileEntry } from "./types";

export type FileSide = "local" | "remote";
export function fileDropHeading(side: FileSide, count: number, server: string, peer?: string) {
  const action = peer ? "Copy" : side === "local" ? "Upload" : "Download";
  const target = side === "local" ? server : peer || "This computer";
  return `${action} ${count} ${count === 1 ? "item" : "items"} to ${target}`;
}
type ListedPane = {
  path: string;
  epoch: number;
  entries: readonly FileEntry[];
  busy: boolean;
  error: string;
};
export type FileDragContext = {
  visible: boolean;
  blocked: boolean;
  sessionId?: string;
  sessionName: string;
  binding: string;
  remoteReady: boolean;
  peer?: { id: string; name: string; binding: string; ready: boolean };
  panes: Record<FileSide, ListedPane>;
};
type SourceEntry = Pick<FileEntry, "name" | "path" | "isDir">;
export type FileDragSnapshot = {
  side: FileSide;
  entries: SourceEntry[];
  sessionId: string;
  sessionName: string;
  binding: string;
  peer?: FileDragContext["peer"];
  external?: boolean;
  protocol: "sftp" | "scp";
  panes: Record<FileSide, { path: string; epoch: number }>;
  targetDirectories: string[];
};
export type FileDropTarget = { side: FileSide; directory?: string };
export type FileTransferPlan = {
  sessionName: string;
  destinationDirectory: string;
  direction: "upload" | "download" | "relay";
  requests: {
    sessionId: string;
    source: string;
    destination: string;
    sourceSessionId?: string;
    direction: "upload" | "download" | "relay";
    protocol: "sftp" | "scp";
  }[];
};

export function joinFilePath(parent: string, name: string, side: FileSide) {
  return (
    parent.replace(side === "local" ? /[\\/]+$/ : /\/+$/, "") +
    (side === "local" && parent.includes("\\") ? "\\" : "/") +
    name
  );
}

export function fileContextReady(context: FileDragContext): boolean {
  return (
    context.visible &&
    !context.blocked &&
    !!context.sessionId &&
    !!context.binding &&
    context.remoteReady &&
    (!context.peer || (context.peer.ready && context.peer.id !== context.sessionId)) &&
    (["local", "remote"] as const).every((side) => {
      const pane = context.panes[side];
      return !!pane.path && !pane.busy && !pane.error;
    })
  );
}

function snapshot(
  context: FileDragContext,
  side: FileSide,
  entries: SourceEntry[],
  protocol: string,
): FileDragSnapshot | null {
  if (
    !fileContextReady(context) ||
    !entries.length ||
    !["sftp", "scp"].includes(protocol)
  )
    return null;
  const targetSide = side === "local" ? "remote" : "local";
  return {
    side,
    entries: entries.map(({ name, path, isDir }) => ({ name, path, isDir })),
    sessionId: context.sessionId!,
    sessionName: context.sessionName,
    binding: context.binding,
    peer: context.peer && { ...context.peer },
    protocol: protocol as "sftp" | "scp",
    panes: {
      local: {
        path: context.panes.local.path,
        epoch: context.panes.local.epoch,
      },
      remote: {
        path: context.panes.remote.path,
        epoch: context.panes.remote.epoch,
      },
    },
    targetDirectories: context.panes[targetSide].entries
      .filter((entry) => entry.isDir)
      .map((entry) => entry.path),
  };
}

export function captureFileDrag(
  context: FileDragContext,
  side: FileSide,
  path: string,
  selected: readonly string[],
  protocol: string,
): FileDragSnapshot | null {
  const paths = new Set(selected.includes(path) ? selected : [path]);
  const entries = context.panes[side].entries.filter((entry) =>
    paths.has(entry.path),
  );
  if (!entries.some((entry) => entry.path === path)) return null;
  return snapshot(context, side, entries, protocol);
}

function externalEntries(paths: string[]): SourceEntry[] {
  return [...new Set(paths)].flatMap((path) => {
    const name = path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    return name && name !== "." && name !== ".."
      ? [{ name, path, isDir: false }]
      : [];
  });
}

export function captureExternalFiles(
  context: FileDragContext,
  paths: string[],
  protocol: string,
): FileDragSnapshot | null {
  const result = snapshot(context, "local", externalEntries(paths), protocol);
  return result && { ...result, external: true };
}

export function drawerUploadPlan(
  paths: string[],
  directory: string,
  sessionId: string,
  sessionName: string,
): FileTransferPlan | null {
  const entries = externalEntries(paths);
  if (!entries.length || !directory.startsWith("/") || !sessionId) return null;
  return {
    sessionName,
    direction: "upload",
    destinationDirectory: directory,
    requests: entries.map((entry) => ({
      sessionId,
      source: entry.path,
      destination: joinFilePath(directory, entry.name, "remote"),
      direction: "upload",
      protocol: "sftp",
    })),
  };
}

export function fileDragStillValid(
  snapshot: FileDragSnapshot,
  context: FileDragContext,
): boolean {
  return (
    fileContextReady(context) &&
    snapshot.sessionId === context.sessionId &&
    snapshot.binding === context.binding &&
    snapshot.peer?.id === context.peer?.id &&
    snapshot.peer?.binding === context.peer?.binding &&
    (["local", "remote"] as const).every(
      (side) =>
        snapshot.panes[side].path === context.panes[side].path &&
        snapshot.panes[side].epoch === context.panes[side].epoch,
    )
  );
}

export function acceptFileDrop(
  snapshot: FileDragSnapshot,
  context: FileDragContext,
  target: FileDropTarget | null,
): FileTransferPlan | null {
  if (
    !target ||
    target.side === snapshot.side ||
    !fileDragStillValid(snapshot, context)
  )
    return null;
  if (
    target.directory !== undefined &&
    !snapshot.targetDirectories.includes(target.directory)
  )
    return null;
  const destinationDirectory =
    target.directory ?? snapshot.panes[target.side].path;
  const relay = snapshot.external ? undefined : snapshot.peer;
  const fromLeft = snapshot.side === "local";
  const direction = relay ? "relay" : fromLeft ? "upload" : "download";
  const destinationId = relay && !fromLeft ? relay.id : snapshot.sessionId;
  return {
    sessionName: relay && !fromLeft ? relay.name : snapshot.sessionName,
    destinationDirectory,
    direction,
    requests: snapshot.entries.map((entry) => ({
      sessionId: destinationId,
      ...(relay && { sourceSessionId: fromLeft ? relay.id : snapshot.sessionId }),
      source: entry.path,
      destination: joinFilePath(destinationDirectory, entry.name, relay ? "remote" : target.side),
      direction,
      protocol: relay ? "sftp" : snapshot.protocol,
    })),
  };
}
