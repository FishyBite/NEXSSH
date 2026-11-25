import { request } from "./api";

export type HostVerification = {
  verificationRequired: true;
  fingerprint: string;
  previousFingerprint?: string;
  changed: boolean;
  hostId: string;
  hostname: string;
  port: number;
};
export type CredentialChallenge = {
  credentialRequired: "password" | "passphrase";
  hostId: string;
  routeToken: string;
  message: string;
};
export type ConnectedShell = {
  sessionId: string;
  routeToken: string;
  latencyMs: number;
  hostId: string;
  connectedAt: number;
};
export type SshResponse = HostVerification | CredentialChallenge | ConnectedShell;

export async function connectSsh(hostId: string, signal: AbortSignal, options: Record<string, unknown> = {}) {
  signal.throwIfAborted();
  const attemptId = crypto.randomUUID();
  await request("ssh_begin_connect", { attemptId });
  const cancel = () => { void request("ssh_cancel_connect", { attemptId }).catch(() => {}); };
  if (signal.aborted) {
    cancel();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await request<SshResponse>("ssh_connect", { ...options, hostId, attemptId, cols: 100, rows: 30 });
    if (signal.aborted && "sessionId" in result) {
      await request("ssh_disconnect", { sessionId: result.sessionId }).catch(() => {});
    }
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
