import { useSyncExternalStore } from "react";
import type { Terminal } from "@xterm/xterm";
import { reportPathDirectory, resetPathDirectories } from "./terminalPathOrigins";

const directories = new Map<string, string>();
const listeners = new Set<() => void>();
const controlOrBackslash = /[\\\u0000-\u001f\u007f-\u009f]/u;
const pathLimit = 4096;

function comparableHostname(value: string): string | null {
  if (value.includes(":")) {
    const literal = value.startsWith("[") ? value : "[" + value + "]";
    if (!/^\[[0-9a-f:.]+\]$/i.test(literal)) return null;
    try {
      return new URL("http://" + literal).hostname;
    } catch {
      return null;
    }
  }
  // Compare the SSH endpoint literally. A URI parser can rewrite aliases such as localhost.
  const name = value.toLowerCase().replace(/\.$/, "");
  return /^[\p{L}\p{N}_.-]+$/u.test(name) ? name : null;
}

export function parseTerminalDirectory(report: string, hostname: string): string | null {
  // A percent-encoded UTF-8 byte can occupy three characters in an OSC 7 file URI.
  if (report.length > 3 * pathLimit + 512 || !hostname) return null;
  const uri = /^file:\/\/([^/?#]*)(\/[^?#]*)$/iu.exec(report);
  if (!uri) return null;
  if (uri[1]) {
    const authority = comparableHostname(uri[1]);
    if (!authority || authority !== comparableHostname(hostname)) return null;
  }
  try {
    const path = decodeURIComponent(uri[2]);
    if (path.length > pathLimit || path.startsWith("//") || controlOrBackslash.test(path)
      || path.split("/").some((part) => part === "." || part === "..")) return null;
    return path;
  } catch {
    return null;
  }
}

function notifyDirectoryChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentTerminalDirectory(sessionId: string | undefined) {
  return sessionId ? directories.get(sessionId) ?? null : null;
}

export function useTerminalDirectory(sessionId: string | undefined) {
  return useSyncExternalStore(subscribe, () => currentTerminalDirectory(sessionId));
}

export function trackTerminalDirectory(terminal: Terminal, sessionId: string, hostname: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: string | null = null;
  const handler = terminal.parser.registerOscHandler(7, (data) => {
    const path = parseTerminalDirectory(data, hostname);
    reportPathDirectory(terminal, path);
    if (path && path !== latest) {
      latest = path;
      clearTimeout(timer);
      // A sequence of prompt updates should request only the final SFTP listing.
      timer = setTimeout(() => {
        if (directories.get(sessionId) === path) return;
        directories.set(sessionId, path);
        notifyDirectoryChange();
      }, 180);
    }
    return true;
  });
  return () => {
    handler.dispose();
    resetPathDirectories(terminal);
    clearTimeout(timer);
    if (directories.delete(sessionId)) notifyDirectoryChange();
  };
}
