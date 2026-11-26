import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./search";
import { parentPath } from "./paths";
import { defaultSettings, normalizeConfig, type Host } from "./types";
import { getTerminalTheme, terminalPaletteNames } from "./terminalThemes";
import {
  authenticationChoice,
  changeAuthentication,
  connectionCredentials,
} from "./authentication";

describe("workspace compatibility", () => {
  it("enables mouse selection copying by default and keeps an explicit opt-out", () => {
    expect(normalizeConfig({}).settings.copyOnSelect).toBe(true);
    const config = normalizeConfig({ settings: { ...defaultSettings, copyOnSelect: false } });
    expect(config.settings.copyOnSelect).toBe(false);
  });
  it("upgrades older host records and preserves stored terminal preferences", () => {
    const config = normalizeConfig({
      hosts: [
        {
          id: "one",
          name: "Legacy",
          hostname: "example.org",
          username: "user",
        } as Host,
      ],
      settings: { ...defaultSettings, fontSize: 18 },
    });
    expect(config.hosts[0].tags).toEqual([]);
    expect(config.hosts[0].workspaceId).toBe(config.workspaces[0].id);
    expect(config.hosts[0].port).toBe(22);
    expect(config.terminalProfiles).toEqual([]);
    expect(config.settings.fontSize).toBe(18);
  });
  it("retains profiles across load and supplies a workspace to empty backups", () => {
    const profile = {
      id: "p",
      name: "Operations",
      fontFamily: "Consolas",
      fontSize: 16,
      cursorStyle: "bar" as const,
      copyOnSelect: false,
      environment: { LANG: "C" },
    };
    const config = normalizeConfig({
      terminalProfiles: [profile],
      workspaces: [],
    });
    expect(config.terminalProfiles[0]).toEqual(profile);
    expect(config.workspaces).toHaveLength(1);
  });
});
describe("command palette matching", () => {
  it("matches ordered abbreviations without requiring exact capitalization", () => {
    expect(fuzzyMatch("prdsrv", "Production Server")).toBe(true);
    expect(fuzzyMatch("PRD", "Production")).toBe(true);
    expect(fuzzyMatch("xyz", "Production Server")).toBe(false);
    expect(fuzzyMatch("aa", "a")).toBe(false);
    expect(fuzzyMatch("", "Production")).toBe(true);
  });
});
describe("filesystem parent navigation", () => {
  it("keeps Windows drive roots absolute", () => {
    expect(parentPath("C:\\Users")).toBe("C:\\");
    expect(parentPath("C:\\")).toBe("C:\\");
    expect(parentPath("C:\\Users\\Alice")).toBe("C:\\Users");
  });
  it("stops at the remote filesystem root", () => {
    expect(parentPath("/home/user")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });
});
describe("terminal colors", () => {
  it.each(Object.keys(terminalPaletteNames))("%s overrides ordinary text without changing ANSI or the saved palette", name => {
    const base = getTerminalTheme(name);
    expect(getTerminalTheme(name, "#Ad127e")).toEqual({ ...base, foreground: "#Ad127e" });
    expect(getTerminalTheme(name)).toBe(base);
    expect(getTerminalTheme(name).foreground).not.toBe("#Ad127e");
  });
  it("discards malformed custom colors and unknown palette identifiers from imported settings", () => {
    for (const color of ["red", "#ABC", "#FFFFFF\n", "#12345678", "url(a)", ""]) {
      const saved = normalizeConfig({ settings: { ...defaultSettings, terminalForeground: color } });
      expect(saved.settings.terminalForeground).toBeUndefined();
      expect(getTerminalTheme("paper", color)).toBe(getTerminalTheme("paper"));
    }
    for (const name of ["unknown", "constructor", "__proto__"]) {
      expect(getTerminalTheme(name)).toBe(getTerminalTheme("dark"));
    }
  });
  it("defaults old preferences safely and offers distinct themes", () => {
    expect(getTerminalTheme(undefined).background).toBe("#0B0D12");
    expect(getTerminalTheme("unknown").background).toBe("#0B0D12");
    expect(getTerminalTheme("light").background).toBe("#F8FAFD");
    expect(getTerminalTheme("solarized").background).toBe("#002B36");
    expect(normalizeConfig({}).settings.terminalTheme).toBe("dark");
    expect(normalizeConfig({}).settings.followAppTheme).toBe(true);
    const oldPrefs = { ...normalizeConfig({}).settings };
    Reflect.deleteProperty(oldPrefs, "followAppTheme");
    expect(normalizeConfig({ settings: oldPrefs }).settings.followAppTheme).toBe(true);
    expect(normalizeConfig({ settings: { ...oldPrefs, terminalTheme: "solarized" } }).settings.followAppTheme).toBe(false);
  });
});
describe("private key authentication", () => {
  const host: Host = {
    id: "host",
    name: "Server",
    hostname: "192.0.2.1",
    port: 22,
    username: "core",
    authMethod: "key",
    keyId: "saved",
    workspaceId: "default",
    tags: [],
    color: "#6C8CFF",
    notes: "",
    favorite: false,
  };
  it("makes local private key selection explicit and clears saved-key precedence", () => {
    const local = changeAuthentication(
      { ...host, identityFile: "C:\\keys\\fixture-ed25519" },
      "private-key",
    );
    expect(authenticationChoice(local)).toBe("private-key");
    expect(local.authMethod).toBe("key");
    expect(local.keySource).toBe("file");
    expect(local.keyId).toBeUndefined();
    expect(local.identityFile).toBe("C:\\keys\\fixture-ed25519");
    expect(local).not.toHaveProperty("passphrase");
    expect(local).not.toHaveProperty("privateKey");
  });
  it("supports older saved key and identity path profiles without switching to password", () => {
    expect(authenticationChoice(host)).toBe("saved-key");
    expect(
      authenticationChoice({
        ...host,
        keyId: undefined,
        identityFile: "C:\\keys\\id_ed25519",
      }),
    ).toBe("private-key");
    expect(
      authenticationChoice({
        ...host,
        keySource: "file",
        identityFile: "C:\\keys\\id_rsa",
      }),
    ).toBe("private-key");
  });
  it("changes to stored identity only when selected explicitly", () => {
    const stored = changeAuthentication(
      { ...host, keySource: "file", identityFile: "C:\\keys\\fixture-ed25519" },
      "saved-key",
    );
    expect(stored.keySource).toBe("stored");
    expect(stored.identityFile).toBeUndefined();
    expect(authenticationChoice(stored)).toBe("saved-key");
  });
  it("withholds credentials during fingerprint verification", () => {
    expect(
      connectionCredentials(
        host,
        true,
        { encrypted: true, algorithm: "ssh-ed25519" },
        "stale-password",
        "secret-passphrase",
      ),
    ).toEqual({});
  });
  it("blocks a newly encrypted key until its passphrase is entered", () => {
    expect(() =>
      connectionCredentials(
        host,
        false,
        { encrypted: true, algorithm: "ssh-ed25519" },
        "stale-password",
        "",
      ),
    ).toThrow("Enter its passphrase");
  });
  it("sends only the credential required by the current key", () => {
    expect(
      connectionCredentials(
        host,
        false,
        { encrypted: false, algorithm: "ssh-ed25519" },
        "stale-password",
        "stale-passphrase",
      ),
    ).toEqual({});
    expect(
      connectionCredentials(
        host,
        false,
        { encrypted: true, algorithm: "ssh-rsa" },
        "stale-password",
        "key-passphrase",
      ),
    ).toEqual({ passphrase: "key-passphrase" });
    expect(
      connectionCredentials(
        { ...host, authMethod: "password" },
        false,
        null,
        "user-password",
        "stale-passphrase",
      ),
    ).toEqual({ password: "user-password" });
  });
});
