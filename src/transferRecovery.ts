import type { Session, Transfer } from "./types";

export function resumableOnTab(session: Session, transfers: Transfer[]) {
  if (session.status !== "connected" || !session.routeToken) return [];
  const tabId = session.tabId || session.id;
  return transfers.filter((t) => (t.tabId ? t.tabId === tabId : t.sessionId === session.id) &&
    t.routeToken === session.routeToken && t.protocol === "sftp" && t.resumable &&
    (t.status === "failed" || t.status === "cancelled"));
}
