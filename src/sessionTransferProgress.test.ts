import { expect, it } from "vitest";
import { progressBySession } from "./SessionViewControls";
import type { Transfer } from "./types";

function transfer(sessionId: string, state: Partial<Transfer>): Transfer {
  return {
    id: "job",
    sessionId,
    source: "",
    destination: "",
    direction: "upload",
    protocol: "sftp",
    status: "running",
    totalBytes: 100,
    transferredBytes: 40,
    speedBytesPerSecond: 12,
    etaSeconds: 5,
    startedAt: 1,
    ...state,
  };
}

it("shows an active relay on the source and destination tabs", () => {
  const groups = progressBySession([transfer("beta", { sourceSessionId: "alpha", direction: "relay" })]);
  expect(groups.get("alpha")).toMatchObject({ count: 1, download: true, upload: false, done: 40 });
  expect(groups.get("beta")).toMatchObject({ count: 1, upload: true, download: false, done: 40 });
});

it("sums bytes for simultaneous transfers on the same tab and excludes completed jobs", () => {
  const bySession = progressBySession([
    transfer("a", {}),
    transfer("a", {
      direction: "download",
      totalBytes: 300,
      transferredBytes: 60,
    }),
    transfer("a", { status: "completed" }),
    transfer("b", { status: "queued", totalBytes: 0, transferredBytes: 0 }),
    transfer("c", { status: "failed" }),
  ]);
  expect(bySession.get("a")).toEqual({
    count: 2,
    upload: true,
    download: true,
    waiting: false,
    measured: true,
    total: 400,
    done: 100,
  });
  expect(bySession.get("b")).toMatchObject({ measured: false, count: 1 });
  expect(bySession.has("c")).toBe(false);
});
