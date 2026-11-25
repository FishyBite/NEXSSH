import { sessionTabId } from "./terminalLayout";
import type { Session } from "./types";

export type RemoteFolder = { binding: string; path: string };
export type ClosedTab = Pick<Session, "hostId" | "routeToken" | "name" | "groupId" | "terminalProfileId" | "fontSize"> & {
  view: "Terminal" | "Files" | "Database";
  folder?: RemoteFolder;
};

export function visitSession(history: string[], sessions: Session[], activeId: string) {
  const active = sessions.find((session) => session.id === activeId);
  const activeTab = active && sessionTabId(active);
  const open = new Set(sessions.map(sessionTabId));
  const next = history.filter((id) => id !== activeTab && open.has(id));
  if (activeTab) next.unshift(activeTab);
  return history.length === next.length && history.every((id, i) => next[i] === id) ? history : next;
}

export function previousSession(history: string[], sessions: Session[], activeId: string) {
  const open = new Map(sessions.map((session) => [sessionTabId(session), session]));
  for (const id of history) {
    const session = open.get(id);
    if (session && session.id !== activeId) return session;
  }
}

export function closedTab(session: Session, view: string, folder?: RemoteFolder): ClosedTab {
  const { hostId, routeToken, name, groupId, terminalProfileId, fontSize } = session;
  return { hostId, routeToken, name, groupId, terminalProfileId, fontSize,
    view: view === "Files" || view === "Database" ? view : "Terminal", folder };
}

export function reopenedFolder(tab: ClosedTab, binding: string, verifiedRoute?: string): RemoteFolder {
  return verifiedRoute && tab.routeToken === verifiedRoute && tab.folder?.binding === binding
    ? tab.folder : { binding, path: "." };
}
