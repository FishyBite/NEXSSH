import type { Host } from "./types";
export type AuthenticationChoice =
  "password" | "private-key" | "saved-key" | "agent";
export interface IdentityInspection {
  encrypted: boolean;
  algorithm: string;
}
export function authenticationChoice(host: Host): AuthenticationChoice {
  if (host.authMethod !== "key") return host.authMethod;
  if (
    host.keySource === "file" ||
    (!host.keySource && !!host.identityFile && !host.keyId)
  )
    return "private-key";
  return "saved-key";
}
export function changeAuthentication(
  host: Host,
  choice: AuthenticationChoice,
): Host {
  if (choice === "private-key")
    return { ...host, authMethod: "key", keySource: "file", keyId: undefined };
  if (choice === "saved-key")
    return {
      ...host,
      authMethod: "key",
      keySource: "stored",
      identityFile: undefined,
    };
  return { ...host, authMethod: choice, keySource: undefined };
}
export function connectionCredentials(
  host: Host,
  verifyOnly: boolean,
  inspection: IdentityInspection | null,
  password: string,
  passphrase: string,
): { password?: string; passphrase?: string } {
  if (verifyOnly) return {};
  if (host.authMethod === "password") return password ? { password } : {};
  if (host.authMethod !== "key") return {};
  if (!inspection)
    throw new Error("Check the selected SSH key before connecting.");
  if (!inspection.encrypted) return {};
  if (!passphrase)
    throw new Error("This SSH key is encrypted. Enter its passphrase.");
  return { passphrase };
}
