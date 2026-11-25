import { describe, expect, it } from "vitest";
import type { FileEntry } from "./types";
import { compareFolderEntries, folderScope, putFolderScope, readFolderStore, rememberFolder, toggleFolderBookmark, visitFolder } from "./fileNavigation";

describe("file navigation scopes", () => {
  it("never restores saved folders across host or route identity changes", () => {
    const empty = readFolderStore(null);
    const saved = putFolderScope(empty, rememberFolder(folderScope(empty, "host-a", "route-a"), "/private-project"));
    expect(folderScope(saved, "host-a", "route-a").lastPath).toBe("/private-project");
    expect(folderScope(saved, "host-b", "route-a").lastPath).toBe("");
    expect(folderScope(saved, "host-a", "route-b").lastPath).toBe("");
  });
  it("persists only supported bounded metadata and tolerates damaged storage", () => {
    expect(readFolderStore("broken").scopes).toEqual([]);
    const stored = readFolderStore(JSON.stringify({ version: 1, scopes: [{ key: "local", binding: "", lastPath: "/home", recent: [...Array(30)].map((_, i) => `/folder/${i}`), bookmarks: ["/one", "/one", 4, "bad\0path"], password: "must-not-survive", passphrase: "must-not-survive" }] }));
    expect(stored.scopes[0].recent).toHaveLength(20);
    expect(stored.scopes[0].bookmarks).toEqual(["/one"]);
    expect(JSON.stringify(stored)).not.toContain("must-not-survive");
    let bounded = stored;
    for (let i = 0; i < 45; i++) bounded = putFolderScope(bounded, folderScope(bounded, `host-${i}`, "route"));
    expect(bounded.scopes).toHaveLength(40);
    expect(bounded.scopes[0].key).toBe("host-44");
  });
  it("keeps recent folders unique and removes bookmarks without deleting files", () => {
    let scope = folderScope(readFolderStore(null), "local", "");
    scope = rememberFolder(rememberFolder(rememberFolder(scope, "/a"), "/b"), "/a");
    expect(scope.recent).toEqual(["/a", "/b"]);
    scope = toggleFolderBookmark(scope, "/a");
    expect(scope.bookmarks).toEqual(["/a"]);
    expect(toggleFolderBookmark(scope, "/a").bookmarks).toEqual([]);
  });
});

describe("folder history", () => {
  it("branches after going back, skips refresh duplicates, and remains session-local", () => {
    const first = visitFolder(visitFolder(undefined, "/a"), "/b");
    expect(visitFolder(first, "/b")).toBe(first);
    const previous = visitFolder(first, "/a", 0);
    expect(visitFolder(previous, "/c")).toEqual({ paths: ["/a", "/c"], index: 1 });
    expect(first).toEqual({ paths: ["/a", "/b"], index: 1 });
    expect(visitFolder(undefined, "/other")).toEqual({ paths: ["/other"], index: 0 });
  });
});

describe("folder metadata comparison", () => {
  const entry = (name: string, size = 1, isDir = false, isSymlink = false): FileEntry => ({ name, path: `/a/${name}`, size, isDir, isSymlink, modified: 0, permissions: "644" });
  it("distinguishes missing names, types and file sizes without asserting equal contents", () => {
    const local = [entry("only-local"), entry("changed", 3), entry("type", 1, true), entry("same"), entry("directory", 4096, true), entry("link", 1, false, true)];
    const remote = [entry("changed", 4), entry("type"), entry("same"), entry("directory", 0, true), entry("link")];
    expect([...compareFolderEntries(local, remote).values()]).toEqual(["only-here", "different-size", "different-type", "same-metadata", "same-metadata", "different-type"]);
  });
});
