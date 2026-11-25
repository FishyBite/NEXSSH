import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { currentTerminalDirectory, parseTerminalDirectory, trackTerminalDirectory } from "./terminalDirectory";

describe("OSC 7 working directory", () => {
  it("decodes absolute POSIX paths once and keeps URI metacharacters in filenames", () => {
    expect(parseTerminalDirectory("file://SERVER.lan./ops/Deploy%20%231/%E6%97%A5%3F%25", "server.lan"))
      .toBe("/ops/Deploy #1/日?%");
    expect(parseTerminalDirectory("file:///srv/%252f/a'b", "192.0.2.169")).toBe("/srv/%2f/a'b");
    expect(parseTerminalDirectory("file://[::1]/", "0:0:0:0:0:0:0:1")).toBe("/");
    expect(parseTerminalDirectory("file://127.0.0.1/tmp", "127.0.0.1")).toBe("/tmp");
  });

  it("ignores foreign authorities, paths with controls and ambiguous file URIs", () => {
    for (const report of [
      "https://server.lan/etc", "/tmp", "file:relative", "file://elsewhere/tmp", "file://localhost/tmp",
      "file://server.lan:22/tmp", "file://server.lan@other/tmp", "file://user@server.lan/tmp",
      "file://%73erver.lan/tmp", "file:///var#fragment", "file:///var?query", "file:///no%XX",
      "file:///no%80", "file:////share/file", "file:///%2Fshare/file", "file:///%5Cshare",
      "file:///tmp/%2e%2e/folder", "file:///tmp/%0aexit", "file:///tmp/%00", "file:///tmp/%C2%9B",
      "file:///" + "a".repeat(4096),
    ]) expect(parseTerminalDirectory(report, "server.lan"), report).toBeNull();
    expect(parseTerminalDirectory("file:///var", "")).toBeNull();
  });

  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
  function start(id: string) {
    const terminal = new Terminal({ allowProposedApi: false });
    cleanups.push(() => terminal.dispose(), trackTerminalDirectory(terminal, id, "server.lan"));
    return (data: string) => new Promise<void>((done) => terminal.write(data, done));
  }

  it("handles fragmented SSH output with both terminators and isolates same-host sessions", async () => {
    const a = start("osc-session-a");
    const b = start("osc-session-b");
    await a("text\x1b]7;file://server.");
    await a("lan/old\x07\x1b]7;file:///deploy");
    await a("\x1b\\prompt");
    await b("\x1b]7;file:///logs\x07");
    await b("\x1b]7;file://elsewhere/foreign\x07");
    await expect.poll(() => [
      currentTerminalDirectory("osc-session-a"), currentTerminalDirectory("osc-session-b"),
    ]).toEqual(["/deploy", "/logs"]);
    expect(currentTerminalDirectory("replacement-id")).toBeNull();
  });

  it("drops queued reports and forgets accepted paths on disconnect", async () => {
    const terminal = new Terminal();
    const dispose = trackTerminalDirectory(terminal, "osc-disconnect", "server.lan");
    try {
      await new Promise<void>((done) => terminal.write("\x1b]7;file://server.lan/old\x07", done));
      await expect.poll(() => currentTerminalDirectory("osc-disconnect")).toBe("/old");
      await new Promise<void>((done) => terminal.write("\x1b]7;file:///pending\x07", done));
    } finally {
      dispose();
      terminal.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(currentTerminalDirectory("osc-disconnect")).toBeNull();
  });
});
