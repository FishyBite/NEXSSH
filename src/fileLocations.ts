import { parentPath } from "./paths";
import type { Transfer } from "./types";
import type { FileSide } from "./fileTransferDrag";

export const pairStorage = "vexssh.files.pairs.v1";
export type FolderPair = {
  id: string;
  name: string;
  hostId: string;
  binding: string;
  local: string;
  remote: string;
};

export function readPairs(raw: string | null): FolderPair[] {
  try {
    const data: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(data)) return [];
    const valid = (value: unknown, limit: number) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= limit &&
      !value.includes("\0");
    return data
      .filter(
        (p) =>
          p &&
          valid(p.id, 120) &&
          valid(p.name, 100) &&
          valid(p.hostId, 512) &&
          valid(p.binding, 65536) &&
          valid(p.local, 4096) &&
          valid(p.remote, 4096),
      )
      .slice(0, 100)
      .map(({ id, name, hostId, binding, local, remote }) => ({
        id,
        name,
        hostId,
        binding,
        local,
        remote,
      }));
  } catch {
    return [];
  }
}

export function incomingTransfers(
  items: Transfer[],
  side: FileSide,
  path: string,
  sessionId?: string,
) {
  if (!path || !sessionId) return [];
  const localKey = (p: string) =>
    p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return items.filter((t) => {
    if (
      t.sessionId !== sessionId ||
      (t.direction === "upload" ? "remote" : "local") !== side
    )
      return false;
    if (side === "local")
      return localKey(parentPath(t.destination)) === localKey(path);
    const end = t.destination.lastIndexOf("/");
    return (
      end >= 0 &&
      (t.destination.slice(0, end) || "/") === (path.replace(/\/+$/, "") || "/")
    );
  });
}
