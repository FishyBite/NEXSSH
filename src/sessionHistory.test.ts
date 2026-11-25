import { describe, expect, it } from "vitest";
import { closedTab, previousSession, reopenedFolder, visitSession } from "./sessionHistory";
import type { Session } from "./types";

const a: Session = { id: "connection-a", tabId: "tab-a", hostId: "same", routeToken: "original-token", name: "Deploy", status: "connected", latencyMs: 12 };
const b = { ...a, id: "connection-b", tabId: "tab-b", name: "Logs" };
const c = { ...a, id: "connection-c", tabId: "tab-c", name: "Scratch" };
const sessions = [a, b, c];

describe("recently used session tabs", () => {
  it("toggles between two visited tabs irrespective of their visual order", () => {
    const seen = [b, c, a].reduce((history, session) => visitSession(history, sessions, session.id), [] as string[]);
    expect(previousSession(seen, [a, b, c], a.id)).toBe(c);
    expect(visitSession(seen, sessions, a.id)).toBe(seen);
    const back = visitSession(seen, sessions, c.id);
    expect(previousSession(back, [b, c, a], c.id)).toBe(a);
  });
  it("uses logical tab IDs on reconnect and skips closed and unvisited tabs", () => {
    const reconnected = { ...b, id: "new-ssh-connection" };
    const seen = visitSession(["tab-c", "tab-b"], [a, reconnected], a.id);
    expect(seen).toEqual(["tab-a", "tab-b"]);
    expect(previousSession(seen, [a, reconnected], a.id)).toBe(reconnected);
    expect(previousSession(["tab-a"], sessions, a.id)).toBeUndefined();
    expect(visitSession(seen, [], "")).toEqual([]);
  });
});

describe("reopen closed session metadata", () => {
  const folder = { binding: "original route", path: "/deploy" };
  it("keeps only connection profile, presentation options, view and folder", () => {
    const entry = closedTab({ ...a, groupId: "ops", fontSize: 18 }, "Files", folder);
    expect(entry).toEqual({ hostId: "same", routeToken: "original-token", name: "Deploy", groupId: "ops", fontSize: 18,
      terminalProfileId: undefined, view: "Files", folder });
    expect(closedTab(b, "Transfers").view).toBe("Terminal");
    expect(closedTab(b, "Database").view).toBe("Database");
  });
  it("restores a folder only for the same verified route", () => {
    const entry = closedTab(a, "Files", folder);
    expect(reopenedFolder(entry, folder.binding, a.routeToken)).toBe(folder);
    expect(reopenedFolder(entry, "changed route", a.routeToken)).toEqual({ binding: "changed route", path: "." });
    expect(reopenedFolder(entry, folder.binding, "rotated-key").path).toBe(".");
    expect(reopenedFolder(entry, folder.binding).path).toBe(".");
    expect(reopenedFolder(closedTab(a, "Terminal"), folder.binding, a.routeToken).path).toBe(".");
  });
});
