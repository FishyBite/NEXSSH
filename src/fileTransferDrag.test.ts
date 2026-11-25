import { describe, expect, it } from "vitest";
import {
  acceptFileDrop,
  captureExternalFiles,
  captureFileDrag,
  fileDragStillValid,
  type FileDragContext,
} from "./fileTransferDrag";
import type { FileEntry } from "./types";

const file = (path: string, isDir = false): FileEntry => ({
  name: path.split(/[\\/]/).pop()!,
  path,
  isDir,
  isSymlink: false,
  size: 1,
  modified: 0,
  permissions: "644",
});
function context(): FileDragContext {
  return {
    visible: true,
    blocked: false,
    sessionId: "ssh-a",
    sessionName: "A",
    binding: "verified-route-a",
    remoteReady: true,
    panes: {
      local: {
        path: "C:\\work",
        epoch: 1,
        busy: false,
        error: "",
        entries: [
          file("C:\\work\\one.txt"),
          file("C:\\work\\two.txt"),
          file("C:\\work\\folder", true),
        ],
      },
      remote: {
        path: "/home/test",
        epoch: 3,
        busy: false,
        error: "",
        entries: [
          file("/home/test/remote.txt"),
          file("/home/test/incoming", true),
        ],
      },
    },
  };
}

describe("cross-panel file transfer snapshots", () => {
  it("uploads the selected batch into a hovered folder without moving originals or changing directories", () => {
    const current = context();
    const snapshot = captureFileDrag(
      current,
      "local",
      "C:\\work\\one.txt",
      ["C:\\work\\one.txt", "C:\\work\\folder"],
      "sftp",
    )!;
    const plan = acceptFileDrop(snapshot, current, {
      side: "remote",
      directory: "/home/test/incoming",
    })!;
    expect(plan.requests).toEqual([
      {
        sessionId: "ssh-a",
        source: "C:\\work\\one.txt",
        destination: "/home/test/incoming/one.txt",
        direction: "upload",
        protocol: "sftp",
      },
      {
        sessionId: "ssh-a",
        source: "C:\\work\\folder",
        destination: "/home/test/incoming/folder",
        direction: "upload",
        protocol: "sftp",
      },
    ]);
    expect(current.panes.remote.path).toBe("/home/test");
  });
  it("drags only an unselected row and downloads into the exact local directory", () => {
    const current = context();
    const unselected = captureFileDrag(
      current,
      "local",
      "C:\\work\\two.txt",
      ["C:\\work\\one.txt"],
      "scp",
    )!;
    expect(unselected.entries.map((entry) => entry.name)).toEqual(["two.txt"]);
    const download = captureFileDrag(
      current,
      "remote",
      "/home/test/remote.txt",
      [],
      "scp",
    )!;
    expect(
      acceptFileDrop(download, current, { side: "local" })?.requests[0],
    ).toEqual({
      sessionId: "ssh-a",
      source: "/home/test/remote.txt",
      destination: "C:\\work\\remote.txt",
      direction: "download",
      protocol: "scp",
    });
  });
  it("rejects both-pane navigation, refresh, session/profile change, disconnect, hidden view, loading and errors", () => {
    const original = context();
    const snapshot = captureFileDrag(
      original,
      "local",
      "C:\\work\\one.txt",
      [],
      "sftp",
    )!;
    const changed: FileDragContext[] = [
      { ...context(), visible: false },
      { ...context(), blocked: true },
      { ...context(), remoteReady: false },
      { ...context(), sessionId: "ssh-b" },
      { ...context(), binding: "changed-route" },
    ];
    for (const side of ["local", "remote"] as const) {
      for (const patch of [
        { path: "changed" },
        { epoch: 20 },
        { busy: true },
        { error: "Listing failed" },
      ]) {
        const value = context();
        value.panes[side] = { ...value.panes[side], ...patch };
        changed.push(value);
      }
    }
    for (const value of changed) {
      expect(fileDragStillValid(snapshot, value)).toBe(false);
      expect(acceptFileDrop(snapshot, value, { side: "remote" })).toBeNull();
    }
  });
  it("rejects same-side, absent and forged/non-directory destinations", () => {
    const current = context();
    const snapshot = captureFileDrag(
      current,
      "local",
      "C:\\work\\one.txt",
      [],
      "sftp",
    )!;
    expect(acceptFileDrop(snapshot, current, null)).toBeNull();
    expect(acceptFileDrop(snapshot, current, { side: "local" })).toBeNull();
    expect(
      acceptFileDrop(snapshot, current, {
        side: "remote",
        directory: "/outside",
      }),
    ).toBeNull();
    expect(
      acceptFileDrop(snapshot, current, {
        side: "remote",
        directory: "/home/test/remote.txt",
      }),
    ).toBeNull();
  });
  it("keeps accepted payloads pinned after later selection, listing or server changes", () => {
    const current = context();
    const snapshot = captureFileDrag(
      current,
      "local",
      "C:\\work\\one.txt",
      [],
      "sftp",
    )!;
    const plan = acceptFileDrop(snapshot, current, { side: "remote" })!;
    current.sessionId = "ssh-b";
    current.panes.local.entries[0].path = "different-source";
    current.panes.remote.path = "/different-target";
    expect(plan.requests[0]).toMatchObject({
      sessionId: "ssh-a",
      source: "C:\\work\\one.txt",
      destination: "/home/test/one.txt",
    });
  });
  it("pins Explorer paths before asynchronous scale conversion", () => {
    const current = context();
    const snapshot = captureExternalFiles(
      current,
      ["C:\\external\\archive.zip", "C:\\external\\folder"],
      "sftp",
    )!;
    expect(
      acceptFileDrop(snapshot, current, {
        side: "remote",
        directory: "/home/test/incoming",
      })?.requests.map((request) => request.destination),
    ).toEqual([
      "/home/test/incoming/archive.zip",
      "/home/test/incoming/folder",
    ]);
    current.panes.remote.epoch++;
    expect(acceptFileDrop(snapshot, current, { side: "remote" })).toBeNull();
  });
});
