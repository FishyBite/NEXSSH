import type { Config, Session } from "./types";

export const WORKSPACE_KEY = "vexssh.workspace.v1";
const MAX_TABS = 64;
const cleanName = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function serializeWorkspace(
  sessions: Session[], active: string, fileSessionId: string | null,
  workspaceId: string, view: string,
) {
  const tabId = (session?: Session) => session?.tabId || session?.id;
  return JSON.stringify({
    version: 1,
    workspaceId,
    view: ["Terminal", "Files", "Database"].includes(view) ? view : "Hosts",
    activeTabId: tabId(sessions.find((session) => session.id === active)),
    fileTabId: tabId(sessions.find((session) => session.id === fileSessionId)),
    tabs: sessions.slice(0, MAX_TABS).map((session) => ({
      tabId: tabId(session), hostId: session.hostId,
      name: cleanName(session.name), groupId: session.groupId,
      terminalProfileId: session.terminalProfileId, fontSize: session.fontSize,
    })),
  });
}

export function restoreWorkspace(raw: string | null, config: Config) {
  const empty = { sessions: [] as Session[], active: "", fileSessionId: null as string | null,
    workspaceId: config.workspaces[0]?.id || "default", view: "Hosts" };
  if (!raw || raw.length > 100_000 || !config.settings.restoreWorkspace) return empty;
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.tabs)) return empty;
    const seen = new Set<string>();
    const sessions: Session[] = [];
    for (const entry of data.tabs.slice(0, MAX_TABS)) {
      if (!entry || !validId(entry.tabId) || seen.has(entry.tabId)) continue;
      const host = config.hosts.find((host) => host.id === entry.hostId);
      if (!host) continue;
      seen.add(entry.tabId);
      sessions.push({
        id: `saved-${entry.tabId}`, tabId: entry.tabId, hostId: host.id,
        name: typeof entry.name === "string" && cleanName(entry.name).trim() ? cleanName(entry.name) : host.name,
        status: "saved", latencyMs: 0,
        groupId: entry.groupId === "" ? "" : config.groups.some((group) => group.id === entry.groupId) ? entry.groupId : undefined,
        terminalProfileId: entry.terminalProfileId === "" ? "" : config.terminalProfiles.some((profile) => profile.id === entry.terminalProfileId) ? entry.terminalProfileId : undefined,
        fontSize: Number.isInteger(entry.fontSize) && entry.fontSize >= 8 && entry.fontSize <= 32 ? entry.fontSize : undefined,
      });
    }
    const active = sessions.find((session) => session.tabId === data.activeTabId)?.id || sessions[0]?.id || "";
    return {
      sessions, active,
      fileSessionId: sessions.find((session) => session.tabId === data.fileTabId)?.id || null,
      workspaceId: config.workspaces.some((workspace) => workspace.id === data.workspaceId) ? data.workspaceId : empty.workspaceId,
      view: sessions.length && ["Terminal", "Files", "Database"].includes(data.view) ? data.view : "Hosts",
    };
  } catch { return empty; }
}
