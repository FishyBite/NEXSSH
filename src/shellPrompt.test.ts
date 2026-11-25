import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { observeShellPrompt } from "./shellPrompt";

describe("confirmed empty shell prompt", () => {
  it("accepts parsed fragmented prompt endings and invalidates on input, output and alternate screens", async () => {
    const terminal = new Terminal();
    const prompt = observeShellPrompt(terminal);
    const send = async (text: string) => {
      prompt.write(new TextEncoder().encode(text));
      await new Promise<void>((done) => terminal.write("", done));
    };
    try {
      expect(prompt.fresh()).toBe(false);
      await send("$ ");
      expect(prompt.fresh()).toBe(false);
      await send("\x1b]133;");
      await send("B\x1b\\");
      expect(prompt.fresh()).toBe(true);
      const first = prompt.beginInput();
      expect(prompt.fresh()).toBe(false);
      expect(first.unchanged()).toBe(true);
      const second = prompt.beginInput();
      second.finish();
      expect(first.unchanged()).toBe(false);
      await send("\x1b]133;B\x07");
      first.finish();
      expect(prompt.fresh()).toBe(false);
      await send("\x1b]133;B\x07editor");
      expect(prompt.fresh()).toBe(false);
      await send("\x1b[?1049h\x1b]133;B\x07");
      expect(prompt.fresh()).toBe(false);
      await send("\x1b[?1049l\x1b]133;B\x07");
      expect(prompt.fresh()).toBe(true);
      await send("\r");
      expect(prompt.fresh()).toBe(false);
    } finally {
      prompt.dispose();
      terminal.dispose();
    }
  });
});
