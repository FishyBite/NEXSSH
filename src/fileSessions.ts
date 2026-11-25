import type { Host } from "./types";

export function fileSessionBinding(hostId: string, hosts: Host[]): string {
  const route: unknown[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = hostId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const host = hosts.find((item) => item.id === currentId) as
      (Host & { proxyJump?: string; hostKeyAlgorithm?: string }) | undefined;
    if (!host) {
      route.push({ missingHost: currentId });
      currentId = undefined;
      break;
    }
    route.push({
      id: host.id,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authMethod: host.authMethod,
      keySource: host.keySource,
      keyId: host.keyId,
      identityFile: host.identityFile,
      hostKeyAlgorithm: host.hostKeyAlgorithm,
      jumpHostId: host.jumpHostId || host.proxyJump,
    });
    currentId = host.jumpHostId || host.proxyJump;
  }
  if (currentId && seen.has(currentId)) route.push({ cycle: currentId });
  return JSON.stringify(route);
}
