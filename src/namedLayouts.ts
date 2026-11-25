import { fileSessionBinding } from "./fileSessions";
import { isPaneView, resolveSplitPair, sessionTabId, splitRatio, type PaneView, type TerminalLayout } from "./terminalLayout";
import type { Host, Session } from "./types";

export type LayoutFolders = { local?: string; remote?: string };
export type LayoutPane = {
  hostId: string;
  tabId: string;
  binding: string;
  routeToken: string;
  view: PaneView;
  folders: LayoutFolders;
};
export type LayoutSnapshot = {
  split: "vertical" | "horizontal";
  ratio: number;
  activePane: 0 | 1;
  panes: [LayoutPane, LayoutPane];
};
export type NamedLayout = LayoutSnapshot & { id: string; name: string };
export const layoutStorageKey = (workspace: string) => `nexssh.layouts.v1.${workspace}`;

export function captureLayout(layout: TerminalLayout, active: string, sessions: Session[], hosts: Host[],
  foldersFor: (session: Session) => LayoutFolders): LayoutSnapshot | undefined {
  if (layout.split === "none") return;
  const pair = resolveSplitPair(sessions, active, layout.primaryTabId, layout.secondaryTabId);
  if (!pair) return;
  const capture = (session: Session): LayoutPane | undefined => {
    if (session.status !== "connected" || !session.routeToken || !hosts.some(h => h.id === session.hostId)) return;
    const tabId = sessionTabId(session);
    return { hostId: session.hostId, tabId, binding: fileSessionBinding(session.hostId, hosts),
      routeToken: session.routeToken, view: layout.paneViews[tabId] || "Terminal", folders: foldersFor(session) };
  };
  const first = capture(pair[0]), second = capture(pair[1]);
  if (first && second) return { split: layout.split, ratio: layout.ratio, activePane: pair[1].id === active ? 1 : 0, panes: [first, second] };
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
}
function parsePane(value: unknown): LayoutPane | undefined {
  if (!value || typeof value !== "object") return;
  const pane = value as Partial<LayoutPane>;
  if (!boundedText(pane.hostId, 160) || !boundedText(pane.tabId, 160) || !boundedText(pane.binding, 131072) ||
    !boundedText(pane.routeToken, 256) || !isPaneView(pane.view)) return;
  const local = pane.folders?.local, remote = pane.folders?.remote;
  return {hostId:pane.hostId, tabId:pane.tabId, binding:pane.binding, routeToken:pane.routeToken,
    view: pane.view, folders: { ...(boundedText(local, 32767) && {local}), ...(boundedText(remote, 4096) && {remote}) }};
}
export function readNamedLayouts(raw: string | null): NamedLayout[] {
  try {
    const entries: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(entries)) return [];
    const layouts: NamedLayout[] = [];
    for (const entry of entries) {
      if (!entry || !boundedText(entry.id, 160) || !boundedText(entry.name, 80) || !entry.name.trim() ||
        (entry.split !== "vertical" && entry.split !== "horizontal") ||
        !Number.isFinite(entry.ratio) || !Array.isArray(entry.panes) || entry.panes.length !== 2) continue;
      const first = parsePane(entry.panes[0]), second = parsePane(entry.panes[1]);
      if (!first || !second || first.tabId === second.tabId || layouts.some(item => item.id === entry.id)) continue;
      layouts.push({id: entry.id, name: entry.name.trim(), split:entry.split, ratio:splitRatio(entry.ratio),
        activePane:entry.activePane === 1 ? 1 : 0, panes:[first, second]});
    }
    return layouts;
  } catch { return []; }
}

type LayoutRestore = {
  hosts: () => Host[];
  sessions: () => Session[];
  connect: (hostId: string) => Promise<Session>;
  close: (session: Session) => Promise<void>;
  verify: (session: Session) => Promise<void>;
  commit: (pair: [Session, Session], opened: Session[]) => void;
  signal: AbortSignal;
};

// Publish both slots together. A rejected fingerprint or a cancelled second
// login must release only the SSH transports opened for this attempt.
export async function restoreNamedLayout(layout: NamedLayout, restore: LayoutRestore) {
  const opened: Session[] = [];
  const chosen: Session[] = [];
  function verifyProfiles() {
    restore.signal.throwIfAborted();
    const hosts = restore.hosts();
    for (const pane of layout.panes) {
      const host = hosts.find(item => item.id === pane.hostId);
      if (!host) throw new Error("A host in this layout is no longer in this workspace.");
      if (fileSessionBinding(host.id, hosts) !== pane.binding)
        throw new Error(`Connection settings for ${host.name} changed. Connect manually and save a new layout.`);
    }
  }
  try {
    verifyProfiles();
    for (const pane of layout.panes) {
      const matching = restore.sessions().filter(s => s.status === "connected" && s.hostId === pane.hostId &&
        s.routeToken === pane.routeToken && !chosen.some(other => other.id === s.id));
      const preferred = matching.find(s => sessionTabId(s) === pane.tabId);
      const available = matching.find(s => !layout.panes.some(other => other !== pane && other.tabId === sessionTabId(s)));
      let session = preferred || available;
      if (!session) {
        session = await restore.connect(pane.hostId);
        opened.push(session);
        verifyProfiles();
        if (session.hostId !== pane.hostId || session.routeToken !== pane.routeToken)
          throw new Error("The verified SSH route changed. Connect manually and save a new layout.");
      }
      chosen.push(session);
    }
    await Promise.all(chosen.map(session => restore.verify(session)));
    verifyProfiles();
    if (chosen.some(s => !opened.includes(s) && !restore.sessions().some(live => live.id === s.id && live.status === "connected")))
      throw new Error("A layout session disconnected. Open the layout again.");
    restore.commit([chosen[0], chosen[1]], opened);
  } catch (error) {
    await Promise.all(opened.map(session => restore.close(session)));
    throw error;
  }
}
