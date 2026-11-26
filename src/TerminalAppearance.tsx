import { useId } from "react";
import type { ITheme } from "@xterm/xterm";
import type { Settings } from "./types";
import { terminalPaletteNames, validTerminalForeground } from "./terminalThemes";
import { Button } from "./ui";

export const terminalFontFamilies = [
  "Cascadia Code, Consolas, monospace",
  "Consolas", "Cascadia Code", "JetBrains Mono", "IBM Plex Mono", "Courier New", "monospace",
];

export function TerminalPaletteOptions() {
  return Object.entries(terminalPaletteNames).map(([id, name]) =>
    <option key={id} value={id}>{name}</option>
  );
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function TerminalTextColor({ value, fallback, background, resetLabel, onChange }: {
  value?: string;
  fallback: string;
  background: string;
  resetLabel: string;
  onChange: (color: string | undefined) => void;
}) {
  const id = useId();
  const invalid = !!value && !validTerminalForeground(value);
  const color = validTerminalForeground(value) ? value : fallback;
  const text = luminance(color);
  const bg = luminance(background);
  const contrast = (Math.max(text, bg) + 0.05) / (Math.min(text, bg) + 0.05);
  const note = invalid ? "Enter a six-digit hex color, e.g. #8FE388."
    : contrast < 4.5 ? "Low contrast against this terminal background." : undefined;
  return (
    <div className="field terminal-text-color span-2">
      <label htmlFor={id}>Text color</label>
      <div className="text-color-controls">
        <input type="color" aria-label="Pick text color" value={color}
          onChange={e => onChange(e.target.value.toUpperCase())} />
        <input id={id} aria-label="Text color (hex)" inputMode="text" spellCheck={false}
          autoComplete="off" placeholder={fallback.toUpperCase()} value={value ?? ""}
          aria-invalid={invalid} aria-describedby={note ? id + "-hint" : undefined}
          onChange={e => onChange(e.target.value || undefined)} />
        <Button variant="ghost" disabled={!value} onClick={() => onChange(undefined)}>{resetLabel}</Button>
      </div>
      {note && <small id={id + "-hint"} role="status">{note}</small>}
    </div>
  );
}

export function TerminalPreview({ colors, fontFamily, fontSize, cursorStyle }: {
  colors: ITheme;
  fontFamily: string;
  fontSize: number;
  cursorStyle: Settings["cursorStyle"];
}) {
  return (
    <div className="terminal-preview span-2" role="group" aria-label="Terminal preview"
      style={{ fontFamily, fontSize, color: colors.foreground, background: colors.background }}>
      <div><span style={{ color: colors.green }}>user@server</span> ~ $ ls /var/log</div>
      <div>access.log  0 O  1 l I</div>
      <div><span style={{ color: colors.red }}>error</span>  Permission denied</div>
      <div>$ <span className={`preview-cursor ${cursorStyle}`} style={{ background: colors.cursor }} /></div>
    </div>
  );
}
