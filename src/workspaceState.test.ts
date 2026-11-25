import { describe, expect, it } from "vitest";
import { emptyConfig, type Host, type Session } from "./types";
import { restoreWorkspace, serializeWorkspace } from "./workspaceState";

const config = { ...emptyConfig, hosts: [{ id: "host1", name: "Server", hostname: "example.test" } as Host] };
const session: Session = { id: "native-id", tabId: "durable-tab", hostId: "host1", name: "Operations", status: "connected", latencyMs: 12, fontSize: 18 };
describe("workspace restoration", () => {
  it("restores metadata as disconnected saved tabs and preserves order and selection", () => {
    const second = { ...session, id: "native-second", tabId: "tab-second" };
    const restored = restoreWorkspace(serializeWorkspace([second, session], session.id, second.id, "default", "Terminal"), config);
    expect(restored.sessions.map((session) => session.tabId)).toEqual(["tab-second", "durable-tab"]);
    expect(restored.sessions.every((session) => session.status === "saved" && session.latencyMs === 0)).toBe(true);
    expect(restored.active).toBe("saved-durable-tab");
    expect(restored.fileSessionId).toBe("saved-tab-second");
    expect(restored.sessions[0].fontSize).toBe(18);
  });
  it("whitelists metadata and never saves credentials, output or native session IDs", () => {
    const raw = serializeWorkspace([{ ...session, routeToken: "verified-route", password: "secret-value", passphrase: "other-secret", privateKey: "key-content", output: "terminal-secret" } as Session], session.id, null, "default", "Terminal");
    for (const excluded of ["password", "passphrase", "privateKey", "secret", "output", "native-id", "routeToken", "verified-route"]) expect(raw).not.toContain(excluded);
  });
  it("rejects corrupt, unsupported, deleted-host, duplicate or oversized state", () => {
    expect(restoreWorkspace("{", config).sessions).toEqual([]);
    expect(restoreWorkspace("x".repeat(100001), config).sessions).toEqual([]);
    const raw = serializeWorkspace([session, session, { ...session, tabId: "gone", hostId: "deleted" }], "", null, "", "Settings");
    expect(restoreWorkspace(raw, config).sessions).toHaveLength(1);
    expect(restoreWorkspace(raw, { ...config, settings: { ...config.settings, restoreWorkspace: false } }).sessions).toEqual([]);
  });
});
