import type { Host, Session, Snippet } from "./types";
import { snippetAvailable } from "./snippetScope";

function tabTitle(base: string, number: string) {
  const suffix = " · " + number;
  return base.slice(0, 120 - suffix.length) + suffix;
}

export function numberSessionTabs(
  sessions: Session[],
  hosts: Host[],
): Session[] {
  const byHost = new Map(hosts.map((host) => [host.id, host.name]));
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const base = byHost.get(session.hostId);
    if (!base) continue;
    const ordinal = / · ([1-9]\d*)$/.exec(session.name);
    if (
      session.name !== base &&
      session.name !== base.slice(0, 120) &&
      !(ordinal && session.name === tabTitle(base, ordinal[1]))
    )
      continue;
    const group = groups.get(base) || [];
    group.push(session);
    groups.set(base, group);
  }
  const taken = new Set(sessions.map((session) => session.name));
  const renamed = new Map<string, string>();
  for (const [base, group] of groups) {
    if (group.length < 2) continue;
    let number = 1;
    const seen = new Set<string>();
    for (const session of group) {
      if (
        session.name === base ||
        session.name === base.slice(0, 120) ||
        seen.has(session.name)
      ) {
        let name: string;
        do {
          name = tabTitle(base, String(number++));
        } while (taken.has(name));
        taken.add(name);
        renamed.set(session.id, name);
      }
      seen.add(session.name);
    }
  }
  return renamed.size
    ? sessions.map((session) => {
        const name = renamed.get(session.id);
        return name ? { ...session, name } : session;
      })
    : sessions;
}

export function quoteRemotePath(path: string): string {
  if (!path.startsWith("/") || /[\u0000-\u001f\u007f-\u009f]/u.test(path))
    throw new Error(
      "Choose an absolute remote path without control characters.",
    );
  return "'" + path.replaceAll("'", "'\\''") + "'";
}

export type CommandSuggestion = {
  name: string;
  command: string;
  source: "Snippet" | "History";
};

export function commandSuggestions(
  text: string,
  snippets: Snippet[],
  history: string[],
  hostId: string,
  workspaceId?: string,
): CommandSuggestion[] {
  const query = text.trim().toLowerCase();
  const matches = snippets
    .filter(
      (s) =>
        query &&
        snippetAvailable(s, workspaceId, hostId) &&
        (s.name.toLowerCase().includes(query) ||
          s.command.toLowerCase().includes(query)),
    )
    .sort((a, b) => Number(b.favorite) - Number(a.favorite));
  const candidates: CommandSuggestion[] = [
    ...matches.map(({ name, command }) => ({
      name,
      command,
      source: "Snippet" as const,
    })),
    ...history
      .filter((command) => command.toLowerCase().includes(query))
      .map((command) => ({ name: "", command, source: "History" as const })),
  ];
  const unique = new Map<string, CommandSuggestion>();
  for (const item of candidates) {
    if (!unique.has(item.command)) unique.set(item.command, item);
    if (unique.size === 6) break;
  }
  return [...unique.values()];
}
