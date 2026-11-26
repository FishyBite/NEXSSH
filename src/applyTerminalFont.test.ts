import { afterEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { applyTerminalFont } from "./applyTerminalFont";

afterEach(() => vi.unstubAllGlobals());

it("measures cold webfonts after both weights load and ignores a superseded font choice", async () => {
  const pending = new Map<string, () => void>();
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("document", { fonts: {
    check: () => false,
    load: (font: string) => new Promise<void>(done => pending.set(font, done)),
  } });
  const term = { options: { fontFamily: "Consolas" } } as Terminal;
  const measured: string[] = [];
  const refit = () => measured.push(term.options.fontFamily!);
  const cancel = applyTerminalFont(term, "JetBrains Mono", 14, refit);
  cancel();
  applyTerminalFont(term, "IBM Plex Mono", 16, refit);
  pending.get("16px IBM Plex Mono")!();
  await Promise.resolve();
  expect(measured).toEqual([]);
  pending.get("bold 16px IBM Plex Mono")!();
  await vi.waitFor(() => expect(measured).toEqual(["IBM Plex Mono"]));
  pending.get("14px JetBrains Mono")!();
  pending.get("bold 14px JetBrains Mono")!();
  await new Promise(done => setTimeout(done, 0));
  expect(measured).toEqual(["IBM Plex Mono"]);
  expect(term.options.fontSize).toBe(16);
});
