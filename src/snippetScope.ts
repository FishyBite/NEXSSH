import type { Snippet } from "./types";

export function snippetAvailable(snippet: Snippet, workspaceId?: string, hostId?: string) {
  return snippet.scope === "global" ||
    (snippet.scope === "workspace" && !!workspaceId && snippet.workspaceId === workspaceId) ||
    (snippet.scope === "host" && !!hostId && snippet.hostId === hostId);
}
