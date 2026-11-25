export const viewShortcuts = ["Ctrl+Shift+E", "Ctrl+Shift+Y", "Off"] as const;
export type ViewShortcut = (typeof viewShortcuts)[number];

export function viewShortcut(value: unknown): ViewShortcut {
  return viewShortcuts.find((shortcut) => shortcut === value) || viewShortcuts[0];
}

export function protectsKeyboardInput(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey) return true;
  if (document.querySelector('[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"]), [role="menu"][data-state="open"]')) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm-helper-textarea")) return false;
  if (target.matches('[data-file-side] input[type="checkbox"]')) return false;
  return !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="menu"],.cm-editor,.file-log-panel');
}
