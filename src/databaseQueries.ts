import { uid, type Session } from "./types";
import type { DatabaseProfile, Engine } from "./databaseProfiles";

export interface DatabaseContext { sessionId: string; hostId: string; name: string }
export interface DatabaseFileRequest { id: string; sessionId: string; hostId: string; name: string; text: string }
export interface HostBinding { sessionId: string; hostId: string; tabId?: string; routeToken?: string }
export function bindHost(context: DatabaseContext, sessions: Session[]): HostBinding {
  const session = sessions.find(s => s.id === context.sessionId && s.hostId === context.hostId);
  return { hostId: context.hostId, sessionId: context.sessionId, tabId: session?.tabId, routeToken: session?.routeToken };
}
export function hostMatch(binding: HostBinding | undefined, now: HostBinding): boolean {
  if (!binding || binding.hostId !== now.hostId) return false;
  if (binding.sessionId === now.sessionId) return true;
  return !!binding.tabId && binding.tabId === now.tabId && !!binding.routeToken && binding.routeToken === now.routeToken;
}
export function targetLabel(profile: DatabaseProfile, engine: Engine) {
  if (engine === "sqlite") return profile.path;
  return profile.host + (profile.presetId === "atlas-mongodb" && !profile.viaSsh ? "" : ":" + profile.port)
    + (profile.database ? " / " + profile.database : "");
}
export function executionText(text: string, start: number, end: number): string {
  return (start < end ? text.slice(start, end) : text).trim();
}
export interface SavedQuery { id: string; name: string; text: string }
export const libraryKey = (workspace: string, profile: string) => "nexssh.db.queries.v1." + JSON.stringify([workspace, profile]);
export function savedQueries(key: string): SavedQuery[] {
  const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
  if (!Array.isArray(value)) throw new Error("The saved query library could not be read.");
  return value.filter((q): q is SavedQuery => q && typeof q.id === "string" && typeof q.name === "string" && typeof q.text === "string");
}
export function saveNamedQuery(key: string, id: string | undefined, name: string, text: string): SavedQuery {
  const list = savedQueries(key);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Enter a name for this query.");
  if (list.some(q => q.id !== id && q.name.toLowerCase() === cleanName.toLowerCase()))
    throw new Error("This name already exists for this database profile.");
  const entry = { id: id || uid(), name: cleanName, text };
  const index = list.findIndex(q => q.id === entry.id);
  if (index < 0) list.push(entry); else list[index] = entry;
  localStorage.setItem(key, JSON.stringify(list));
  return entry;
}
export function deleteNamedQuery(key: string, id: string) {
  localStorage.setItem(key, JSON.stringify(savedQueries(key).filter(q => q.id !== id)));
}
export function initialQuery(engine: Engine) {
  if (engine === "mongodb") return '{ "ping": 1 }';
  if (engine === "redis") return '["PING"]';
  if (engine === "oracle") return "SELECT 1 FROM dual";
  return "SELECT 1";
}
