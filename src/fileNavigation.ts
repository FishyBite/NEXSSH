import type { FileEntry } from "./types";

export const navigationStorageKey = "nexssh.files.navigation.v1";
const pathLimit = 4096;
export type FolderHistory = { paths: string[]; index: number };
export type FolderScope = {
  key: string;
  binding: string;
  lastPath: string;
  recent: string[];
  bookmarks: string[];
  updatedAt: number;
};
export type FolderStore = { version: 1; scopes: FolderScope[] };
export type Comparison = "only-here" | "different-type" | "different-size" | "same-metadata";

const validPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= pathLimit && !value.includes("\0");
const paths = (value: unknown, limit: number) =>
  Array.isArray(value) ? [...new Set(value.filter(validPath))].slice(0, limit) : [];

export function readFolderStore(raw: string | null): FolderStore {
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed?.version !== 1 || !Array.isArray(parsed.scopes)) return { version: 1, scopes: [] };
    const scopes: FolderScope[] = [];
    for (const item of parsed.scopes) {
      if (!item || typeof item.key !== "string" || item.key.length > 512 ||
          typeof item.binding !== "string" || item.binding.length > 65536 ||
          scopes.some((scope) => scope.key === item.key)) continue;
      scopes.push({
        key: item.key,
        binding: item.binding,
        lastPath: validPath(item.lastPath) ? item.lastPath : "",
        recent: paths(item.recent, 20),
        bookmarks: paths(item.bookmarks, 30),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      });
      if (scopes.length === 40) break;
    }
    return { version: 1, scopes };
  } catch {
    return { version: 1, scopes: [] };
  }
}

export function folderScope(store: FolderStore, key: string, binding: string): FolderScope {
  return store.scopes.find((scope) => scope.key === key && scope.binding === binding) || {
    key, binding, lastPath: "", recent: [], bookmarks: [], updatedAt: 0,
  };
}

export function putFolderScope(store: FolderStore, scope: FolderScope): FolderStore {
  return readFolderStore(JSON.stringify({
    version: 1,
    scopes: [{ ...scope, updatedAt: Date.now() }, ...store.scopes.filter((item) => item.key !== scope.key)].slice(0, 40),
  }));
}

export function rememberFolder(scope: FolderScope, path: string): FolderScope {
  if (!validPath(path)) return scope;
  return { ...scope, lastPath: path, recent: [path, ...scope.recent.filter((item) => item !== path)].slice(0, 20) };
}

export function toggleFolderBookmark(scope: FolderScope, path: string): FolderScope {
  if (!validPath(path)) return scope;
  return {
    ...scope,
    bookmarks: scope.bookmarks.includes(path)
      ? scope.bookmarks.filter((item) => item !== path)
      : [path, ...scope.bookmarks].slice(0, 30),
  };
}

export function visitFolder(history: FolderHistory | undefined, path: string, index?: number): FolderHistory {
  const current = history || { paths: [], index: -1 };
  if (!validPath(path)) return current;
  if (index !== undefined && index >= 0 && index < current.paths.length) {
    return { paths: current.paths.map((item, position) => position === index ? path : item), index };
  }
  if (current.paths[current.index] === path) return current;
  const next = [...current.paths.slice(0, current.index + 1), path].slice(-100);
  return { paths: next, index: next.length - 1 };
}

export function compareFolderEntries(entries: FileEntry[], other: FileEntry[]): Map<string, Comparison> {
  const counterparts = new Map(other.map((entry) => [entry.name, entry]));
  return new Map(entries.map((entry) => {
    const match = counterparts.get(entry.name);
    const result: Comparison = !match ? "only-here"
      : entry.isDir !== match.isDir || entry.isSymlink !== match.isSymlink ? "different-type"
      : !entry.isDir && entry.size !== match.size ? "different-size"
      : "same-metadata";
    return [entry.path, result];
  }));
}
