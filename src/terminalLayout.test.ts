import { describe, expect, it } from "vitest";
import { emptyConfig, type Session, type Config } from "./types";
import {
  effectiveSessionGroup,
  normalizeTerminalLayout,
  resolveSplitPair,
  terminalSettings,
} from "./terminalLayout";

const sessions: Session[] = [
  {
    id: "native-a",
    tabId: "tab-a",
    hostId: "host-a",
    name: "A",
    status: "connected",
    latencyMs: 1,
  },
  {
    id: "native-b",
    tabId: "tab-b",
    hostId: "host-b",
    name: "B",
    status: "connected",
    latencyMs: 1,
  },
];

describe("terminal workspace preferences", () => {
  it("updates the active terminal with the app while respecting pinned palettes", () => {
    const config = { ...emptyConfig, settings: { ...emptyConfig.settings, theme: "system" as const } };
    expect(terminalSettings(sessions[0], config, "light").terminalTheme).toBe("light");
    expect(terminalSettings(sessions[0], config, "dark").terminalTheme).toBe("dark");
    for (const theme of ["midnight", "graphite", "forest", "dusk", "paper", "mist"] as const) {
      const themed = { ...config, settings: { ...config.settings, theme } };
      expect(terminalSettings(sessions[0], themed).terminalTheme).toBe(theme);
      expect(terminalSettings(sessions[0], themed, theme).terminalTheme).toBe(theme);
    }
    expect(terminalSettings(sessions[0], { ...config, settings: { ...config.settings,
      followAppTheme: false, terminalTheme: "solarized" } }, "light").terminalTheme).toBe("solarized");
  });
  it("inherits a global text color and permits independent SSH profile palettes and colors", () => {
    const session = { ...sessions[0], terminalProfileId: "ops" };
    const config: Config = {
      ...emptyConfig,
      settings: { ...emptyConfig.settings, terminalForeground: "#CCEEDD" },
      terminalProfiles: [{
        id: "ops", name: "Ops", fontFamily: "Consolas", fontSize: 14, cursorStyle: "block",
        copyOnSelect: true, environment: {}, terminalTheme: "forest",
      }],
    };
    expect(terminalSettings(session, config, "light")).toMatchObject({
      terminalTheme: "forest", terminalForeground: "#CCEEDD",
    });
    config.terminalProfiles[0].terminalForeground = "#123ABC";
    expect(terminalSettings(session, config, "light").terminalForeground).toBe("#123ABC");
    expect(terminalSettings(sessions[1], config, "light")).toMatchObject({
      terminalTheme: "light", terminalForeground: "#CCEEDD",
    });
    delete config.settings.terminalForeground;
    delete config.terminalProfiles[0].terminalForeground;
    expect(terminalSettings(session, config).terminalForeground).toBeUndefined();
  });
  it("restores a split by durable tab identity after the native connection ID changes", () => {
    expect(resolveSplitPair(sessions, "native-a", "tab-a", "tab-b")).toEqual(sessions);
    expect(
      resolveSplitPair(
        [{ ...sessions[0] }, { ...sessions[1], id: "reconnected-b" }],
        "native-a",
        "tab-a",
        "tab-b",
      )?.map(s => s.id),
    ).toEqual(["native-a", "reconnected-b"]);
    expect(resolveSplitPair(sessions, "native-b", "tab-a", "tab-b")).toEqual(sessions);
    expect(resolveSplitPair(sessions, "native-a", "tab-b", "tab-a")).toEqual([sessions[1], sessions[0]]);
    expect(
      resolveSplitPair([sessions[0]], "native-a", "tab-a", "closed-tab"),
    ).toBeUndefined();
  });
  it("accepts only bounded UI metadata and rejects malformed storage", () => {
    expect(normalizeTerminalLayout(null)).toEqual(normalizeTerminalLayout({}));
    expect(
      normalizeTerminalLayout({
        split: "vertical",
        secondaryTabId: "tab-b",
        fullscreen: true,
        composerVisible: true,
        password: "discard",
        command: "discard",
      }),
    ).toEqual({
      split: "vertical",
      ratio: 50,
      paneViews: {},
      primaryTabId: "",
      secondaryTabId: "tab-b",
      fullscreen: true,
      composerVisible: true,
    });
    expect(
      normalizeTerminalLayout({
        split: "bad",
        secondaryTabId: 42,
        fullscreen: "true",
      }),
    ).toEqual(normalizeTerminalLayout({}));
  });
  it("allows per-session overrides without changing the host or global defaults", () => {
    const config: Config = {
      ...emptyConfig,
      hosts: [
        {
          id: "host-a",
          groupId: "host-group",
          terminalProfileId: "profile-a",
        } as Config["hosts"][number],
      ],
      terminalProfiles: [
        {
          id: "profile-a",
          name: "Readable",
          fontFamily: "Consolas",
          fontSize: 18,
          cursorStyle: "bar",
          copyOnSelect: false,
          environment: {},
        },
      ],
    };
    expect(effectiveSessionGroup(sessions[0], config)).toBe("host-group");
    expect(effectiveSessionGroup({ ...sessions[0], groupId: "" }, config)).toBe(
      "",
    );
    expect(terminalSettings(sessions[0], config).fontSize).toBe(18);
    expect(terminalSettings(sessions[0], config).copyOnSelect).toBe(false);
    expect(terminalSettings({ ...sessions[0], terminalProfileId: "" }, config).copyOnSelect).toBe(true);
    expect(
      terminalSettings({ ...sessions[0], terminalProfileId: "" }, config)
        .fontSize,
    ).toBe(config.settings.fontSize);
    expect(
      terminalSettings({ ...sessions[0], fontSize: 22 }, config).fontSize,
    ).toBe(22);
    expect(
      terminalSettings({ ...sessions[0], fontSize: Infinity }, config).fontSize,
    ).toBe(14);
    expect(config.settings.fontSize).toBe(14);
  });
});
