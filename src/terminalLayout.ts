import type { Config, Session } from "./types";

export type PaneView = "Terminal" | "Files" | "Database";
export function isPaneView(value: unknown): value is PaneView {
  return value === "Terminal" || value === "Files" || value === "Database";
}
export function splitRatio(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(80, Math.max(20, Math.round(value * 10) / 10))
    : 50;
}
export type TerminalLayout = {
  split: "none" | "horizontal" | "vertical";
  primaryTabId: string;
  secondaryTabId: string;
  ratio: number;
  paneViews: Record<string, PaneView>;
  fullscreen: boolean;
  composerVisible: boolean;
};
export const terminalLayoutKey = "nexssh.terminal.layout.v1";
export const defaultTerminalLayout: TerminalLayout = {
  split: "none",
  primaryTabId: "",
  secondaryTabId: "",
  ratio: 50,
  paneViews: {},
  fullscreen: false,
  composerVisible: false,
};

export function normalizeTerminalLayout(value: unknown): TerminalLayout {
  if (!value || typeof value !== "object") return { ...defaultTerminalLayout };
  const candidate = value as Partial<TerminalLayout>;
  const paneViews = candidate.paneViews && typeof candidate.paneViews === "object" && !Array.isArray(candidate.paneViews)
    ? Object.fromEntries(Object.entries(candidate.paneViews).filter(([id, mode]) =>
        id.length > 0 && id.length <= 160 && isPaneView(mode)).slice(0, 256))
    : {};
  return {
    ratio: splitRatio(candidate.ratio),
    paneViews,
    split:
      candidate.split === "horizontal" || candidate.split === "vertical"
        ? candidate.split
        : "none",
    primaryTabId: typeof candidate.primaryTabId === "string" ? candidate.primaryTabId.slice(0, 160) : "",
    secondaryTabId:
      typeof candidate.secondaryTabId === "string"
        ? candidate.secondaryTabId.slice(0, 160)
        : "",
    fullscreen: candidate.fullscreen === true,
    composerVisible: candidate.composerVisible === true,
  };
}

export function sessionTabId(session: Pick<Session, "id" | "tabId">): string {
  return session.tabId || session.id;
}

// The display slots belong to tab identities. Focusing the other slot must
// never shuffle the panes or switch either pane to a third SSH transport.
export function resolveSplitPair(
  sessions: Session[],
  activeId: string,
  primaryTabId: string,
  secondaryTabId: string,
): [Session, Session] | undefined {
  const active = sessions.find((session) => session.id === activeId);
  if (!active) return;
  const second = sessions.find((session) => sessionTabId(session) === secondaryTabId);
  const first = sessions.find((session) => sessionTabId(session) === primaryTabId);
  const fallback = sessions.find((session) => session.id !== activeId);
  if (!fallback) return;
  if (second === active) return [first && first !== active ? first : fallback, active];
  return [active, second || fallback];
}

export function effectiveSessionGroup(
  session: Session,
  config: Config,
): string {
  return (
    session.groupId ??
    config.hosts.find((host) => host.id === session.hostId)?.groupId ??
    ""
  );
}

export function terminalSettings(
  session: Session,
  config: Config,
  appearance: Config["settings"]["terminalTheme"] = config.settings.theme === "system" ? "dark" : config.settings.theme,
): Config["settings"] {
  const profileId =
    session.terminalProfileId ??
    config.hosts.find((host) => host.id === session.hostId)?.terminalProfileId;
  const profile = config.terminalProfiles.find((item) => item.id === profileId);
  const fontSize =
    session.fontSize ?? profile?.fontSize ?? config.settings.fontSize;
  return {
    ...config.settings,
    ...profile,
    terminalTheme: profile?.terminalTheme ?? (config.settings.followAppTheme ? appearance : config.settings.terminalTheme),
    terminalForeground: profile?.terminalForeground ?? config.settings.terminalForeground,
    fontSize: Number.isFinite(fontSize)
      ? Math.max(8, Math.min(32, fontSize))
      : 14,
  };
}
