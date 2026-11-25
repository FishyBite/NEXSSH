import type { IMarker, Terminal } from "@xterm/xterm";

type Token = { path: string; start: number; end: number };
type Proof = Token & { folder: string };
type LineRecord = { marker: IMarker; proofs: Proof[] };
type Cut = { offset: number; directory: string | null };
type Observer = {
  report: (folder: string | null) => void;
  reset: () => void;
  write: (bytes: Uint8Array, done: () => void) => void;
};
const observers = new WeakMap<Terminal, Observer>();

// Called from the same parsed OSC 7 handler that validates the SSH endpoint.
// A write can contain several directory changes. React's latest cwd is too late.
export function reportPathDirectory(terminal: Terminal, folder: string | null) {
  observers.get(terminal)?.report(folder);
}

export function resetPathDirectories(terminal: Terminal) {
  observers.get(terminal)?.reset();
}

export function writeTerminalOutput(terminal: Terminal, bytes: Uint8Array, done: () => void) {
  const observer = observers.get(terminal);
  if (observer) observer.write(bytes, done);
  else terminal.write(bytes, done);
}

export function recordPathOrigins(terminal: Terminal, tokenize: (text: string) => Token[]) {
  let directory: string | null = null;
  let cuts: Cut[] = [{ offset: 0, directory }];
  let current: LineRecord | undefined;
  let trailingReturn = false;
  let skipCapture = false;
  const records = new Set<LineRecord>();
  const maxRows = () => Math.max(1, Math.floor(16384 / Math.max(1, terminal.cols)));
  function readLine(row: number) {
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal" || row < 0) return;
    let first = row;
    while (buffer.getLine(first)?.isWrapped) {
      if (first === 0 || row - first >= maxRows()) return;
      first--;
    }
    let text = "";
    for (let i = first; i < row; i++)
      text += buffer.getLine(i)?.translateToString(true) ?? "";
    const line = buffer.getLine(row);
    if (!line) return;
    const offset = text.length + line.translateToString(false, 0, buffer.cursorX).length;
    return { first, text: text + line.translateToString(true), offset };
  }
  const cursorRow = () => terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
  function capture(row: number, completed: boolean) {
    if (current?.marker.isDisposed) startLine(null);
    if (skipCapture || (!cuts.some((cut) => cut.directory) && !current)) return;
    const line = readLine(row);
    if (!line) return;
    if (current?.marker.line !== line.first) current = undefined;
    if (!current && !line.text.includes("/")) return;
    const proofs: Proof[] = [];
    for (const token of tokenize(line.text)) {
      if (token.path.startsWith("/") || (!completed && token.end > line.offset)) continue;
      let index = cuts.length - 1;
      while (index >= 0 && cuts[index].offset > token.start) index--;
      const cut = cuts[index];
      if (cut?.directory && !(cuts[index+1] && cuts[index+1].offset < token.end))
        proofs.push({ ...token, folder: cut.directory });
    }
    if (!current && proofs.length) {
      // A marker follows its logical line through scrolling and xterm reflow.
      // Bound retained metadata even for long-running, path-heavy commands.
      if (records.size >= 2048) records.values().next().value?.marker.dispose();
      const marker = terminal.registerMarker(line.first - cursorRow());
      const record: LineRecord = { marker, proofs };
      records.add(record);
      marker.onDispose(() => records.delete(record));
      current = record;
    }
    if (current) current.proofs = proofs;
  }
  function startLine(folder: string | null) {
    current = undefined;
    cuts = [{ offset: 0, directory: folder }];
  }
  function reset() {
    directory = null;
    startLine(null);
    for (const record of records) record.marker.dispose();
  }
  function report(folder: string | null) {
    if (terminal.buffer.active.type !== "normal" || (directory === folder && cuts.at(-1)?.directory === folder)) return;
    const line = readLine(cursorRow());
    directory = folder;
    if (!line) { startLine(null); return; }
    // An OSC at column zero of an occupied row does not establish a base for
    // existing cells (a carriage return often precedes a prompt redraw).
    const offset = line.offset || line.text.length;
    cuts = cuts.filter((cut) => cut.offset < offset);
    cuts.push({ offset, directory });
    capture(cursorRow(), false);
  }
  function invalidateScreen() {
    if (terminal.buffer.active.type === "normal") {
      const buffer = terminal.buffer.active;
      let base = buffer.baseY;
      while (base > 0 && buffer.getLine(base)?.isWrapped) base--;
      for (const record of records) if (record.marker.line >= base) record.marker.dispose();
      startLine(null);
    }
    return false; // xterm still handles the original control sequence.
  }
  function invalidateLine() {
    const line = readLine(cursorRow());
    if (!line) return false;
    for (const record of records) if (record.marker.line === line.first) record.marker.dispose();
    startLine(line.text ? null : directory);
    return false;
  }
  // xterm has parser hooks for CSI/ESC but not for C0. A standalone CR or BS
  // can overwrite exactly the same word from another directory. Split only
  // those writes, keeping ordinary CRLF pairs (including split packets) intact.
  function write(bytes: Uint8Array, done: () => void) {
    if (!bytes.length) { terminal.write(bytes, done); return; }
    if (trailingReturn && bytes[0] !== 10) terminal.write("", invalidateLine);
    trailingReturn = bytes[bytes.length - 1] === 13;
    let start = 0;
    let controls = 0;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (byte !== 8 && !(byte === 13 && i + 1 < bytes.length && bytes[i + 1] !== 10)) continue;
      if (++controls > 32) {
        // Bound the xterm write queue on redraw-heavy/binary output.
        terminal.write("", () => { invalidateScreen(); skipCapture = true; });
        terminal.write(bytes.subarray(start), () => {
          skipCapture = false;
          invalidateLine();
          done();
        });
        return;
      }
      terminal.write(bytes.subarray(start, i + 1), invalidateLine);
      start = i + 1;
    }
    terminal.write(bytes.subarray(start), done);
  }
  const subscriptions = [
    terminal.onLineFeed(() => {
      if (terminal.buffer.active.type !== "normal") return;
      const row = cursorRow();
      capture(row - 1, true);
      const existing = terminal.buffer.active.getLine(row)?.translateToString(true);
      startLine(existing ? null : directory);
    }),
    terminal.onWriteParsed(() => capture(cursorRow(), false)),
    terminal.onCursorMove(() => capture(cursorRow(), false)),
    terminal.buffer.onBufferChange(() => startLine(null)),
    terminal.onResize(() => startLine(null)),
    // Screen-oriented programs can replace the same cells, even with identical
    // text. Drop visible claims before cursor relocation or destructive edits.
    ..."ABEFHJLMSTdefu".split("").map((final) =>
      terminal.parser.registerCsiHandler({ final }, invalidateScreen)),
    ..."CDGKPX\x60a@".split("").map((final) =>
      terminal.parser.registerCsiHandler({ final }, invalidateLine)),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "J" }, invalidateScreen),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "K" }, invalidateLine),
    ...["8", "M", "c"].map((final) =>
      terminal.parser.registerEscHandler({ final }, final === "c" ? () => { reset(); return false; } : invalidateScreen)),
  ];
  observers.set(terminal, { report, reset, write });
  return {
    lookup(row: number, start: number, end: number, path: string) {
      if (terminal.buffer.active.type !== "normal") return undefined;
      for (const record of records) if (record.marker.line === row) {
        const proof = record.proofs.find(p => p.start === start && p.end === end && p.path === path);
        if (proof) return proof.folder;
      }
      return undefined;
    },
    dispose() {
      observers.delete(terminal);
      subscriptions.forEach((subscription) => subscription.dispose());
      reset();
    },
  };
}
