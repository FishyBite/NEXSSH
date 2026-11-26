import type { Terminal } from "@xterm/xterm";

// xterm measures cells when the font option changes. Setting a webfont before
// it loads would cache the fallback's metrics, even after the glyphs change.
export function applyTerminalFont(term: Terminal, family: string, size: number, refit: () => void) {
  const fallback = "Consolas, monospace";
  const selected = family && CSS.supports("font-family", family) ? family : fallback;
  let active = true;
  const apply = (name: string) => {
    if (!active) return;
    term.options.fontSize = size;
    term.options.fontFamily = name;
    refit();
  };
  const faces = [`${size}px ${selected}`, `bold ${size}px ${selected}`];
  try {
    if (faces.every(face => document.fonts.check(face))) {
      apply(selected);
    } else {
      void Promise.all(faces.map(face => document.fonts.load(face)))
        .then(() => apply(selected), () => apply(fallback));
    }
  } catch {
    apply(fallback);
  }
  return () => { active = false; };
}
