import type { PointerEvent as ReactPointerEvent } from "react";

// WebView2 native file-drop events and web DataTransfer cannot both drive this
// gesture. An in-app pointer drag carries only the listing's path + live session.
export function startTerminalPathDrag(
  event: ReactPointerEvent<HTMLButtonElement>, sessionId: string, signal: AbortSignal,
  insert: () => void,
) {
  if (event.button !== 0 || !event.isPrimary || signal.aborted) return;
  const button = event.currentTarget;
  const { pointerId, clientX, clientY } = event;
  const listeners = new AbortController();
  const options = { signal: listeners.signal, capture: true };
  let dragging = false;
  let highlight: HTMLElement | null = null;
  const hit = (x: number, y: number) => {
    const surface = document.elementFromPoint(x, y)?.closest<HTMLElement>(".xterm-container");
    const pane = surface?.closest<HTMLElement>(".terminal-pane.focused");
    return pane?.dataset.sessionId === sessionId ? surface || null : null;
  };
  const show = (next: HTMLElement | null) => {
    if (next === highlight) return;
    highlight?.classList.remove("remote-path-drop");
    highlight = next;
    highlight?.classList.add("remote-path-drop");
  };
  const stop = () => {
    listeners.abort();
    show(null);
    button.classList.remove("dragging-terminal-path");
    if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
  };
  button.setPointerCapture(pointerId);
  window.addEventListener("pointermove", (move) => {
    if (move.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(move.clientX - clientX, move.clientY - clientY) < 6) return;
    dragging = true;
    button.classList.add("dragging-terminal-path");
    move.preventDefault();
    show(hit(move.clientX, move.clientY));
  }, { ...options, passive: false });
  window.addEventListener("pointerup", (up) => {
    if (up.pointerId !== pointerId) return;
    const accepted = dragging && !signal.aborted && hit(up.clientX, up.clientY);
    if (dragging) {
      const suppress = (click: MouseEvent) => {
        click.preventDefault();
        click.stopImmediatePropagation();
      };
      button.addEventListener("click", suppress, {capture:true, once:true});
      window.setTimeout(() => button.removeEventListener("click", suppress, true), 0);
    }
    stop();
    if (accepted) insert();
  }, options);
  window.addEventListener("pointercancel", (e) => { if (e.pointerId === pointerId) stop(); }, options);
  button.addEventListener("lostpointercapture", stop, options);
  // Ordinary focus transfer from xterm to the pressed row also emits a captured
  // blur. Only cancel when the window itself loses focus.
  window.addEventListener("blur", stop, {signal: listeners.signal});
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dragging) {
      e.preventDefault();
      e.stopPropagation();
      stop();
    }
  }, options);
  signal.addEventListener("abort", stop, options);
}
