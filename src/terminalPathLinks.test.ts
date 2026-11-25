import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { findTerminalPaths, pathLinksForRow } from "./terminalPathLinks";
import { recordPathOrigins, writeTerminalOutput } from "./terminalPathOrigins";
import { trackTerminalDirectory } from "./terminalDirectory";

describe("terminal output path links", () => {
  it("parses quoted POSIX paths and compiler locations without treating URLs as remote files", () => {
    const text =
      'Failed (/etc/nginx/nginx.conf:42:9), "/var/log/Team A/error.log":11; /srv/Team\\ B. ' +
      "http://example.test/path git@example.test:/repo foo/bar //network/file";
    expect(
      findTerminalPaths(text).map(({ path, line }) => [path, line]),
    ).toEqual([
      ["/etc/nginx/nginx.conf", 42],
      ["/var/log/Team A/error.log", 11],
      ["/srv/Team B", undefined],
      ["foo/bar", undefined],
    ]);
    expect(findTerminalPaths('"/bad\nfile" /server\\suffix')).toHaveLength(0);
    expect(
      findTerminalPaths('{"location":"/srv/entry.js:8"}')[0],
    ).toMatchObject({ path: "/srv/entry.js", line: 8 });
    expect(findTerminalPaths('"Team A/log.txt":18 Team\\ B/file.log').map(({path,line}) => [path,line]))
      .toEqual([["Team A/log.txt",18],["Team B/file.log",undefined]]);
  });
  it("maps multicell text and wrapped lines, validates the mouse gesture before opening", async () => {
    const terminal = new Terminal({ cols: 10, rows: 5 });
    const open = vi.fn();
    try {
      await new Promise<void>((done) =>
        terminal.write("界  /etc/service:6", done),
      );
      const [link] = pathLinksForRow(terminal, 2, open);
      expect(link.text).toBe("/etc/service:6");
      expect(link.range).toEqual({
        start: { x: 5, y: 1 },
        end: { x: 8, y: 2 },
      });
      const event = { button: 0, ctrlKey: false } as MouseEvent;
      link.activate(event, link.text);
      expect(open).not.toHaveBeenCalled();
      link.activate(
        { ...event, ctrlKey: true, button: 2 } as MouseEvent,
        link.text,
      );
      expect(open).not.toHaveBeenCalled();
      vi.spyOn(terminal, "hasSelection").mockReturnValue(false);
      link.activate({ ...event, ctrlKey: true } as MouseEvent, link.text);
      expect(open).toHaveBeenCalledExactlyOnceWith({
        path: "/etc/service",
        line: 6,
      });
    } finally {
      terminal.dispose();
    }
  });
});

const report = (path: string, host = "server") => "\x1b]7;file://" + host + path + "\x07";
function fixture(cols = 60, rows = 4, scrollback = 12) {
  const terminal = new Terminal({ cols, rows, scrollback });
  const origins = recordPathOrigins(terminal, findTerminalPaths);
  const stop = trackTerminalDirectory(terminal, "fixture", "server");
  vi.spyOn(terminal, "hasSelection").mockReturnValue(false);
  return {
    terminal,
    write: (data: string) => new Promise<void>((done) =>
      writeTerminalOutput(terminal, new TextEncoder().encode(data), done)),
    click(row: number, path: string) {
      const open = vi.fn();
      const link = pathLinksForRow(terminal, row, open, origins.lookup).find((l) => l.text === path);
      expect(link, "clickable token at row " + row).toBeDefined();
      link!.activate({ button: 0, ctrlKey: true } as MouseEvent, path);
      return open.mock.calls[0]?.[0];
    },
    close() { stop(); origins.dispose(); terminal.dispose(); },
  };
}

describe("remote working directory at output time", () => {
  it("keeps independent origins across split writes, mid-line OSCs, and multiple cwd changes in one write", async () => {
    const term = fixture();
    try {
      await term.write("./unknown.txt " + report("/first") + "./a");
      await term.write(".txt " + report("/second") + "./b.txt:18\r\n../parent/x\r\n" + report("/last") + "logs/c.txt");
      expect(term.click(1, "./unknown.txt").path).toBe("./unknown.txt");
      expect(term.click(1, "./a.txt").path).toBe("/first/a.txt");
      expect(term.click(1, "./b.txt:18")).toEqual({path:"/second/b.txt",line:18});
      expect(term.click(2, "../parent/x").path).toBe("/second/../parent/x");
      expect(term.click(3, "logs/c.txt").path).toBe("/last/logs/c.txt");
    } finally { term.close(); }
  });

  it("preserves surviving wrapped lines after trimming the OSC line and forgets replaced cells", async () => {
    const term = fixture(12, 3, 6);
    try {
      await term.write(report("/before") + "head\r\nx\r\ny\r\n界 ./logs/long.log:2\r\n" + report("/after") + "1\r\n2\r\n3\r\n4\r\n5");
      expect(term.click(3, "./logs/long.log:2")).toEqual({path:"/before/logs/long.log",line:2});
      await term.write("\x1b[2J\x1b[H./logs/long.log:2\r\n");
      const base = term.terminal.buffer.active.baseY;
      expect(term.click(base + 1, "./logs/long.log:2").path).toBe("./logs/long.log");
    } finally { term.close(); }
  });

  it("does not reuse a prior host's cwd for a rejected or incomplete OSC report", async () => {
    const term = fixture();
    try {
      await term.write(report("/mine") + "./old.log\r\n" + report("/foreign", "other") + "./foreign.log\r\n");
      expect(term.click(1, "./old.log").path).toBe("/mine/old.log");
      expect(term.click(2, "./foreign.log").path).toBe("./foreign.log");
      await term.write("\x1b]7;file://server/res");
      await term.write("tored\x07./valid.log");
      expect(term.click(3, "./valid.log").path).toBe("/restored/valid.log");
    } finally { term.close(); }
  });
  it("drops claims on a same-cell repaint and preserves ordinary CRLF split across packets", async () => {
    const term = fixture();
    try {
      await term.write(report("/one") + "./old.txt" + report("/two") + "\r");
      await term.write("./old.txt\r\n./kept.txt\r");
      await term.write("\n");
      expect(term.click(1, "./old.txt").path).toBe("./old.txt");
      expect(term.click(2, "./kept.txt").path).toBe("/two/kept.txt");
    } finally { term.close(); }
  });
  it("follows reflowed scrollback, isolates alternate screen output, and releases cleared lines", async () => {
    const term = fixture(24, 3, 16);
    try {
      await term.write(report("/source") + "界 ./logs/service-long.log:11\r\nb\r\nc\r\nd\r\n" + report("/destination"));
      term.terminal.resize(14, 3);
      expect(term.click(2, "./logs/service-long.log:11").path).toBe("/source/logs/service-long.log");
      await term.write("\x1b[?1049h\x1b[H" + report("/screen") + "./other.log");
      expect(term.click(1,"./other.log").path).toBe("./other.log");
      await term.write("\x1b[?1049l");
      expect(term.click(2, "./logs/service-long.log:11").path).toBe("/source/logs/service-long.log");
      term.terminal.clear();
      await term.write("\r\n./new.log\r\n");
      expect(term.click(2,"./new.log").path).toBe("/destination/new.log");
    } finally { term.close(); }
  });
});
