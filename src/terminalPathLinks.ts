import type { IBufferCellPosition, ILink, Terminal } from "@xterm/xterm";
import { recordPathOrigins } from "./terminalPathOrigins";

export type TerminalPath = { path: string; line?: number };
type PathMatch = TerminalPath & { start: number; end: number };

export function findTerminalPaths(text: string): PathMatch[] {
  // A slash after a relative directory name distinguishes a path from prose.
  // Require a token boundary so URLs, SSH destinations and switches stay plain.
  const token =
    /(^|[\s=(\[<{,]|:(?=["']))(?:"([\p{L}\p{N}_. -]*\/[^"\r\n]*)"(?::([1-9]\d*)(?::\d+)?)?|'([\p{L}\p{N}_. -]*\/[^'\r\n]*)'(?::([1-9]\d*)(?::\d+)?)?|((?:[\p{L}\p{N}_.-]|\\ )*\/(?:\\ |[^\s\\<>"\x00-\x1f\x7f-\x9f])*))/gu;
  const found: PathMatch[] = [];
  for (const match of text.matchAll(token)) {
    const start = match.index! + match[1].length;
    const quoted = match[2] !== undefined || match[4] !== undefined;
    let raw = match[2] ?? match[4] ?? match[6];
    let end = match.index! + match[0].length;
    if (!quoted) {
      const clean = raw.replace(/[),;.!:\]}'\u2019]+$/u, "");
      end -= raw.length - clean.length;
      raw = clean.replaceAll("\\ ", " ");
      // Avoid treating a DOS-style path or truncated backslash escape as a POSIX file.
      if (text[end] === "\\") continue;
    }
    let lineText: string | undefined = match[3] ?? match[5];
    if (!lineText) {
      const suffix = /:([1-9]\d*)(?::\d+)?$/u.exec(raw);
      if (suffix) {
        lineText = suffix[1];
        raw = raw.slice(0, suffix.index);
      }
    }
    if (
      raw.startsWith("//") ||
      raw.startsWith("-") ||
      raw.length > 4096 ||
      /[\\\x00-\x1f\x7f-\x9f]/u.test(raw)
    )
      continue;
    const line = lineText && Number(lineText);
    found.push({
      path: raw,
      line: line && Number.isSafeInteger(line) ? line : undefined,
      start,
      end,
    });
  }
  return found;
}

export function pathLinksForRow(
  terminal: Terminal,
  row: number,
  open: (target: TerminalPath) => void,
  recordedFolder?: (row: number, start: number, end: number, path: string) => string | undefined,
): ILink[] {
  const buffer = terminal.buffer.active;
  if (!buffer.getLine(row - 1)) return [];
  // Bound mouse-hover work even when a command prints megabytes without a newline.
  const maxRows = Math.max(1, Math.floor(16384 / Math.max(terminal.cols, 1)));
  let first = row - 1;
  let last = first;
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    if (last - first + 1 >= maxRows) return [];
    first--;
  }
  while (buffer.getLine(last + 1)?.isWrapped) {
    if (last - first + 1 >= maxRows) return [];
    last++;
  }
  let text = "";
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  const cell = buffer.getNullCell();
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y)!;
    let used = Math.min(line.length, terminal.cols);
    while (used && !line.getCell(used - 1, cell)?.getChars()) used--;
    for (let x = 0; x < used; x++) {
      const entry = line.getCell(x, cell);
      if (!entry || !entry.getWidth()) continue;
      const chars = entry.getChars() || " ";
      text += chars;
      const start = { x: x + 1, y: y + 1 };
      const end = { x: x + entry.getWidth(), y: y + 1 };
      for (let i = 0; i < chars.length; i++) {
        starts.push(start);
        ends.push(end);
      }
    }
  }
  return findTerminalPaths(text).flatMap(({ path, line, start, end }) => {
    const range = { start: starts[start], end: ends[end - 1] };
    if (row < range.start.y || row > range.end.y) return [];
    const origin = !path.startsWith("/") && recordedFolder?.(first, start, end, path);
    return [
      {
        text: text.slice(start, end),
        range,
        hover() {
          terminal.element?.setAttribute(
            "title",
            "Ctrl+click to open this remote path",
          );
        },
        leave() {
          if (terminal.element?.title === "Ctrl+click to open this remote path")
            terminal.element.removeAttribute("title");
        },
        activate(event: MouseEvent) {
          if (
            event.button === 0 &&
            event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            !event.metaKey &&
            !terminal.hasSelection()
          ) {
            const current = origin && recordedFolder?.(first, start, end, path) === origin;
            open({ path: current ? resolveRemotePath(origin, path) : path, line });
          }
        },
      },
    ];
  });
}

export function registerTerminalPathLinks(
  terminal: Terminal,
  open: (target: TerminalPath) => void,
) {
  const origins = recordPathOrigins(terminal, findTerminalPaths);
  const links = terminal.registerLinkProvider({
    provideLinks(row, done) {
      done(pathLinksForRow(terminal, row, open, origins.lookup));
    },
  });
  return { dispose() { links.dispose(); origins.dispose(); } };
}

export function resolveRemotePath(folder: string, relative: string): string {
  // The SFTP server canonicalizes '..' after traversing any remote symlink.
  return folder.replace(/\/+$/u, "") + "/" + relative.replace(/^(?:\.\/)+/u, "");
}
