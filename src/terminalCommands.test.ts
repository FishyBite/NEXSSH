import { describe, expect, it } from "vitest";
import { numberSessionTabs, quoteRemotePath } from "./terminalCommands";
import type { Session, Host } from "./types";

const hosts = [{ id: "h", name: "OpenShift" }] as Host[];
const tab = (id: string, name = "OpenShift") =>
  ({ id, name, hostId: "h" }) as Session;
describe("persistent tab labels", () => {
  it("numbers restored default labels while reserving existing labels", () => {
    const sessions = [
      tab("a"),
      tab("b", "OpenShift · 2"),
      tab("c", "Deploy"),
      tab("d"),
    ];
    const result = numberSessionTabs(sessions, hosts);
    expect(result.map((s) => s.name)).toEqual([
      "OpenShift · 1",
      "OpenShift · 2",
      "Deploy",
      "OpenShift · 3",
    ]);
    result.reverse();
    expect(numberSessionTabs(result, hosts)).toBe(result);
    const extra = numberSessionTabs(
      [...result, { ...result[0], id: "e" }],
      hosts,
    );
    expect(extra.at(-1)?.name).toBe("OpenShift · 4");
  });
  it("keeps a sole default tab and a custom name intact", () => {
    const sessions = [tab("a"), tab("b", "Logs")];
    expect(numberSessionTabs(sessions, hosts)).toBe(sessions);
  });
});
describe("remote shell path insertion", () => {
  it("quotes single quotes and shell metacharacters in one absolute path", () => {
    expect(quoteRemotePath("/tmp/John's $report;1")).toBe(
      "'/tmp/John'\\''s $report;1'",
    );
  });
  it.each([
    "relative",
    "/tmp/a\rcommand",
    "/tmp/a\tb",
    "/tmp/a\nb",
    "/tmp/\x1b[200~",
  ])("rejects terminal control characters and relative paths", (path) => {
    expect(() => quoteRemotePath(path)).toThrow();
  });
});
