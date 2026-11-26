import { viewShortcut, type ViewShortcut } from "./sessionShortcuts";
import { validAppTheme, type AppTheme } from "./appThemes";
import { validTerminalForeground, validTerminalPalette, type TerminalPaletteId } from "./terminalThemes";

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  keyId?: string;
  keySource?: "file" | "stored";
  groupId?: string;
  workspaceId: string;
  tags: string[];
  color: string;
  notes: string;
  favorite: boolean;
  lastConnected?: string;
  environment?: Record<string, string>;
  timeout?: number;
  keepalive?: number;
  compression?: boolean;
  jumpHostId?: string;
  agentForwarding?: boolean;
  identityFile?: string;
  terminalProfileId?: string;
  environmentLabel?: "production" | "staging" | "development" | "lab";
  icon?: "server" | "database" | "globe" | "cloud" | "terminal";
}
export interface TerminalProfile {
  id: string;
  name: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: Settings["cursorStyle"];
  copyOnSelect: boolean;
  environment: Record<string, string>;
  terminalTheme?: TerminalPaletteId;
  terminalForeground?: string;
}
export interface Snippet {
  id: string;
  name: string;
  command: string;
  category: string;
  scope: "global" | "workspace" | "host";
  workspaceId?: string;
  hostId?: string;
  favorite: boolean;
}
export interface Settings {
  sessionViewShortcut?: ViewShortcut;
  theme: AppTheme;
  terminalTheme: TerminalPaletteId;
  terminalForeground?: string;
  followAppTheme: boolean;
  fontFamily: string;
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  copyOnSelect: boolean;
  timeout: number;
  keepalive: number;
  defaultPort: number;
  downloadDirectory: string;
  transferConcurrency: number;
  sidebarCollapsed: boolean;
  reconnectAttempts: number;
  reconnectDelay: number;
  restoreWorkspace: boolean;
}
export interface Config {
  serialProfiles?: import("./serialProfile").SerialProfile[];
  hosts: Host[];
  workspaces: { id: string; name: string }[];
  groups: { id: string; name: string; workspaceId: string }[];
  snippets: Snippet[];
  terminalProfiles: TerminalProfile[];
  settings: Settings;
}
export interface Session {
  id: string;
  routeToken?: string;
  tabId?: string;
  hostId: string;
  name: string;
  status: string;
  disconnectReason?: string;
  latencyMs: number;
  groupId?: string;
  terminalProfileId?: string;
  fontSize?: number;
  followTerminalFolder?: boolean;
}
export interface KeyInfo {
  id: string;
  name: string;
  type: string;
  fingerprint: string;
  publicKey: string;
  createdAt: string;
}
export interface Transfer {
  id: string;
  sessionId: string;
  tabId?: string | null;
  routeToken?: string | null;
  source: string;
  destination: string;
  direction: string;
  protocol: string;
  status: string;
  totalBytes: number;
  transferredBytes: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  durationSeconds?: number;
  resumable?: boolean;
  resumedBytes?: number;
  skippedFiles?: number;
  renamedPaths?: Record<string,string>;
  conflict?: {
    token: string;
    source: string;
    destination: string;
    sourceSize: number;
    destinationSize: number;
    sourceModified: number | null;
    destinationModified: number | null;
    canReplace: boolean;
  } | null;
}
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number;
  permissions: string;
}
export interface Metrics {
  hostname: string;
  os: string;
  uptime: string | number;
  load: string | number[];
  cpu: number | null;
  ram: { used: number; total: number };
  disk: { used: number; total: number };
  network: { rx: number; tx: number };
  processes: string;
}
export const defaultSettings: Settings = {
  sessionViewShortcut: "Ctrl+Shift+E",
  theme: "dark",
  terminalTheme: "dark",
  followAppTheme: true,
  fontFamily: "Consolas",
  fontSize: 14,
  cursorStyle: "block",
  copyOnSelect: true,
  timeout: 15,
  keepalive: 30,
  defaultPort: 22,
  downloadDirectory: "",
  transferConcurrency: 2,
  sidebarCollapsed: false,
  reconnectAttempts: 0,
  reconnectDelay: 5,
  restoreWorkspace: true,
};
export const emptyConfig: Config = {
  hosts: [],
  workspaces: [{ id: "default", name: "Personal workspace" }],
  groups: [],
  snippets: [],
  terminalProfiles: [],
  settings: defaultSettings,
};
export const uid = () => crypto.randomUUID();
export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function normalizeConfig(value: Partial<Config>): Config {
  const theme = validAppTheme(value.settings?.theme) ? value.settings.theme : defaultSettings.theme;
  return {
    ...emptyConfig,
    ...value,
    hosts: (value.hosts || []).map((host) => ({
      ...host,
      tags: host.tags || [],
      workspaceId:
        host.workspaceId ||
        value.workspaces?.[0]?.id ||
        emptyConfig.workspaces[0].id,
      favorite: host.favorite ?? false,
      notes: host.notes || "",
      color: host.color || "#6C8CFF",
      authMethod: host.authMethod || "password",
      port: host.port || 22,
      environmentLabel: ["production", "staging", "development", "lab"].includes(host.environmentLabel || "") ? host.environmentLabel : undefined,
    })),
    groups: value.groups || [],
    snippets: value.snippets || [],
    terminalProfiles: (value.terminalProfiles || []).map(profile => ({
      ...profile,
      terminalTheme: validTerminalPalette(profile.terminalTheme) ? profile.terminalTheme : undefined,
      terminalForeground: validTerminalForeground(profile.terminalForeground) ? profile.terminalForeground : undefined,
    })),
    workspaces: value.workspaces?.length
      ? value.workspaces
      : emptyConfig.workspaces,
    settings: {
      ...defaultSettings, ...value.settings,
      theme,
      terminalTheme: validTerminalPalette(value.settings?.terminalTheme) ? value.settings.terminalTheme : defaultSettings.terminalTheme,
      terminalForeground: validTerminalForeground(value.settings?.terminalForeground) ? value.settings.terminalForeground : undefined,
      followAppTheme: value.settings?.followAppTheme ?? (
        !value.settings?.terminalTheme || value.settings.terminalTheme === theme
      ),
      sessionViewShortcut: viewShortcut(value.settings?.sessionViewShortcut),
    },
  };
}
