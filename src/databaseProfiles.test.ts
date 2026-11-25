import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanProfile, connectionArgs, engines, newProfile, presetFor, presets, readProfiles, saveProfiles, validateProfile } from "./databaseProfiles";

afterEach(() => vi.unstubAllGlobals());
describe("database profiles", () => {
  it("offers all eight engines with consistent cloud endpoints and TLS defaults", () => {
    expect(new Set(presets.map(preset => preset.engine))).toEqual(new Set(Object.keys(engines)));
    expect(new Set(presets.map(preset => preset.id)).size).toBe(presets.length);
    for (const item of presets) {
      const profile = newProfile(item, "test");
      expect(presetFor(profile)).toEqual(item);
      expect(profile.tls).toBe(item.engine !== "sqlite");
      if (item.group !== "Database") expect(profile.host).toBe("");
    }
  });
  it("persists only allowlisted metadata and keeps workspaces separate", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) });
    const base = { ...newProfile(presets[0], "test"), name: "An endpoint" };
    const contaminated = { ...base, password: "private-credential", sshSessionId: "old-session", result: ["private-data"] };
    saveProfiles("a", [contaminated]);
    expect(readProfiles("b")).toEqual([]);
    expect(readProfiles("a")).toEqual([base]);
    expect([...storage.values()][0]).not.toMatch(/private-credential|old-session|private-data/);
    expect(cleanProfile({ ...base, presetId: "unknown" })).toBeNull();
  });
  it("routes using the explicitly selected live session and excludes it from direct connections", () => {
    const profile = { ...newProfile(presets[0], "test"), name: "dev", sshHostId: "jump", viaSsh: true };
    expect(connectionArgs(profile, "secret", "live2")).toMatchObject({ sshSessionId: "live2", password: "secret" });
    expect(connectionArgs({ ...profile, viaSsh: false }, "", "live2")).not.toHaveProperty("sshSessionId");
    expect(validateProfile({ ...profile, host: "user:pass@example.com" })).toMatch(/hostname/);
  });
  it("uses DNS discovery for direct Atlas connections and explicit endpoints over SSH", () => {
    const profile = { ...newProfile(presets.find(preset => preset.id === "atlas-mongodb")!, "id"),
      host: "cluster.example.mongodb.net", name: "atlas" };
    expect(connectionArgs(profile, "", "")).toMatchObject({ mongoSrv: true, authSource: "admin" });
    expect(connectionArgs({ ...profile, viaSsh: true }, "", "selected")).not.toHaveProperty("mongoSrv");
    expect(validateProfile({ ...profile, host: profile.host + ":27017" })).toMatch(/without a port/);
  });
});
