import { describe, expect, it, vi } from "vitest";
import { captureLayout, layoutStorageKey, readNamedLayouts, restoreNamedLayout, type NamedLayout } from "./namedLayouts";
import { defaultTerminalLayout } from "./terminalLayout";
import type { Host, Session } from "./types";

const hosts: Host[] = ["alpha", "beta"].map(id => ({
  id, name:id, hostname:id + ".example", username:"user", port:22, authMethod:"password",
  workspaceId:"work", favorite:false, tags:[], color:"", notes:"",
}));
const sessions: Session[] = hosts.map(h => ({
  id:"native-" + h.id, tabId:"tab-" + h.id, hostId:h.id,
  name:h.name, status:"connected", latencyMs:3, routeToken:"verified-" + h.id,
}));
const terminal = {...defaultTerminalLayout, primaryTabId:"tab-alpha", secondaryTabId:"tab-beta",
  split:"vertical" as const, ratio:64, paneViews:{"tab-beta":"Files" as const}};
const folders = (s: Session) => ({local:"C:\\Work\\" + s.hostId, remote:"/home/" + s.hostId});
const named: NamedLayout = {...captureLayout(terminal, sessions[1].id, sessions, hosts, folders)!, id:"layout", name:"Ops"};
function callbacks(live: Session[] = []) {
  const controller = new AbortController();
  return {
    hosts:() => hosts, sessions:() => live, signal: controller.signal, controller,
    connect:vi.fn(async (id: string) => ({...sessions.find(s => s.hostId === id)!, id:"new-" + id})),
    close:vi.fn(async (_: Session) => {}), verify:vi.fn(async (_: Session) => {}), commit:vi.fn(),
  };
}
describe("named split layouts", () => {
  it("captures pane order, focused side, modes and both file paths, isolated by workspace", () => {
    expect(named).toMatchObject({ratio:64, split:"vertical", activePane:1,
      panes:[{hostId:"alpha", view:"Terminal", folders:folders(sessions[0])}, {hostId:"beta", view:"Files", folders:folders(sessions[1])}]});
    expect(readNamedLayouts(JSON.stringify([named]))).toEqual([named]);
    expect(layoutStorageKey("team-a")).not.toBe(layoutStorageKey("team-b"));
    expect(captureLayout(terminal, sessions[0].id, [{...sessions[0], status:"saved"}, sessions[1]], hosts, folders)).toBeUndefined();
  });
  it("discards corrupt entries and persists only known fields", () => {
    expect(readNamedLayouts("!")).toEqual([]);
    expect(readNamedLayouts(JSON.stringify([null, {...named, panes:[{},{}]}, {...named, password:"BAD",
      panes:named.panes.map(p => ({...p, password:"BAD", folders:{...p.folders, passphrase:"BAD"}}))}]))).toEqual([named]);
  });
  it("reuses matching sessions even after their transport IDs change", async () => {
    const live = sessions.map(s => ({...s, id:s.id + "-new"}));
    const cb = callbacks(live);
    await restoreNamedLayout(named, cb);
    expect(cb.connect).not.toHaveBeenCalled();
    expect(cb.commit).toHaveBeenCalledWith(live, []);
    expect(cb.verify).toHaveBeenCalledTimes(2);
  });
  it("opens a separate transport when both panes reference the same host", async () => {
    const same = {...named, panes:[named.panes[0], {...named.panes[0], tabId:"other"}] as NamedLayout["panes"]};
    const cb = callbacks([sessions[0]]);
    await restoreNamedLayout(same, cb);
    expect(cb.connect).toHaveBeenCalledTimes(1);
    expect(cb.commit.mock.calls[0][0].map((s: Session) => s.id)).toEqual(["native-alpha","new-alpha"]);
  });
  it("checks both saved endpoints before opening the first connection", async () => {
    const cb = {...callbacks(), hosts:() => [hosts[0], {...hosts[1], port:2222}]};
    await expect(restoreNamedLayout(named, cb)).rejects.toThrow("settings");
    expect(cb.connect).not.toHaveBeenCalled();
  });
  it("preserves the second pane's exact tab when only that duplicate session is open", async () => {
    const same = {...named, panes:[{...named.panes[0], tabId:"absent"}, named.panes[0]] as NamedLayout["panes"]};
    const cb = callbacks([sessions[0]]);
    await restoreNamedLayout(same, cb);
    expect(cb.commit.mock.calls[0][0].map((s: Session) => s.id)).toEqual(["new-alpha","native-alpha"]);
  });
  it("closes staged transports if a fingerprint changes on the second server", async () => {
    const cb = callbacks();
    cb.connect.mockResolvedValueOnce(sessions[0]).mockResolvedValueOnce({...sessions[1], routeToken:"new-fingerprint"});
    await expect(restoreNamedLayout(named, cb)).rejects.toThrow("route changed");
    expect(cb.close).toHaveBeenCalledTimes(2);
    expect(cb.commit).not.toHaveBeenCalled();
  });
  it("cancels without publishing a partially connected layout", async () => {
    const cb = callbacks();
    cb.connect.mockResolvedValueOnce(sessions[0]).mockRejectedValueOnce(new Error("SSH connection cancelled"));
    await expect(restoreNamedLayout(named, cb)).rejects.toThrow("cancelled");
    expect(cb.close).toHaveBeenCalledExactlyOnceWith(sessions[0]);
    expect(cb.commit).not.toHaveBeenCalled();
  });
  it("never closes preexisting sessions when native endpoint validation fails", async () => {
    const cb = callbacks([sessions[0]]);
    cb.verify.mockRejectedValueOnce(new Error("binding changed"));
    await expect(restoreNamedLayout(named, cb)).rejects.toThrow("binding changed");
    expect(cb.close).toHaveBeenCalledTimes(1);
    expect(cb.close.mock.calls[0][0].hostId).toBe("beta");
  });
});
