import type { Terminal } from "@xterm/xterm";
import { writeTerminalOutput } from "./terminalPathOrigins";

/** A PTY exposes bytes, not a remotely editable command buffer. Only trust a
 * parsed OSC 133 B at the very end of the latest output, in the main screen. */
export function observeShellPrompt(terminal: Terminal) {
  let revision = 0;
  let pendingWrites = 0;
  let fresh = false;
  let tail = "";
  let parsedMarkers = 0;
  let previousMarkers = 0;
  const parser = terminal.parser.registerOscHandler(133, (data) => {
    if (data === "B") parsedMarkers++;
    return false;
  });
  return {
    fresh: () => fresh && pendingWrites === 0 && terminal.buffer.active.type === "normal",
    beginInput() {
      const ticket = ++revision;
      fresh = false;
      tail = "";
      pendingWrites++;
      return {
        unchanged: () => revision === ticket && terminal.buffer.active.type === "normal",
        finish: () => { pendingWrites--; },
      };
    },
    write(bytes: Uint8Array) {
      if (!bytes.length) return;
      const ticket = ++revision;
      fresh = false;
      tail = (tail + String.fromCharCode(...bytes.subarray(-10))).slice(-10);
      const endsAtPrompt = tail.endsWith("\x1b]133;B\x07") || tail.endsWith("\x1b]133;B\x1b\\");
      writeTerminalOutput(terminal, bytes, () => {
        const parsed = parsedMarkers !== previousMarkers;
        previousMarkers = parsedMarkers;
        if (ticket === revision && parsed && endsAtPrompt && pendingWrites === 0)
          fresh = terminal.buffer.active.type === "normal";
      });
    },
    dispose: () => parser.dispose(),
  };
}
