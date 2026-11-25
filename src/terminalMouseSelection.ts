import type { Terminal } from "@xterm/xterm";

// Mouse-reporting programs need a real click, while a drag should select
// locally. Wait until the gesture is known before xterm sees the mouse press.
export function enableTerminalDragSelection(terminal: Terminal, onMouseSelection: () => void) {
  const screen = terminal.element!.querySelector<HTMLElement>(".xterm-screen")!;
  const doc = screen.ownerDocument;
  const win = doc.defaultView!;
  let gesture: AbortController | undefined;
  let selection: AbortController | undefined;
  let replay: MouseEvent | undefined;

  function cancel() {
    gesture?.abort();
    gesture = undefined;
  }
  function onDown(down: MouseEvent) {
    if (down === replay) return;
    cancel();
    selection?.abort();
    if (down.button === 0 && !down.ctrlKey && !down.metaKey) {
      // Only a finished mouse selection owns the clipboard. Search and other
      // programmatic selections share xterm's general selection-change event.
      const tracking = new AbortController();
      selection = tracking;
      const stop = () => tracking.abort();
      win.addEventListener("blur", stop, { signal: tracking.signal });
      doc.addEventListener("pointercancel", stop, { capture: true, signal: tracking.signal });
      win.addEventListener("mouseup", (up) => {
        if (up.button !== 0) return;
        stop();
        if (doc.activeElement !== terminal.textarea || !screen.isConnected) return;
        if (down.detail < 2 && !down.shiftKey && up.clientX === down.clientX && up.clientY === down.clientY) return;
        onMouseSelection();
      }, { capture: true, signal: tracking.signal });
    }
    const mode = terminal.modes.mouseTrackingMode;
    if (mode === "none" || down.button !== 0 || down.buttons !== 1 ||
        down.ctrlKey || down.altKey || down.shiftKey || down.metaKey) return;

    down.preventDefault();
    down.stopImmediatePropagation();
    terminal.focus();
    terminal.clearSelection();
    gesture = new AbortController();
    const options = { capture: true, signal: gesture.signal };

    function handToXterm(select: boolean) {
      cancel();
      if (!screen.isConnected || !screen.getClientRects().length ||
          terminal.modes.mouseTrackingMode !== mode || doc.activeElement !== terminal.textarea) return;
      // xterm uses Shift on Windows to select text in mouse-reporting mode.
      // Its own selection handles wrapped lines, scrolling and wide characters.
      replay = new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, view: win, button: 0, buttons: 1,
        detail: select ? 1 : down.detail,
        clientX: down.clientX, clientY: down.clientY,
        screenX: down.screenX, screenY: down.screenY, shiftKey: select,
      });
      try {
        screen.dispatchEvent(replay);
      } finally {
        replay = undefined;
      }
    }
    doc.addEventListener("mousemove", (move) => {
      if (move.buttons !== 1) { cancel(); return; }
      if (Math.hypot(move.clientX - down.clientX, move.clientY - down.clientY) >= 3)
        handToXterm(true);
    }, options);
    // At window capture the original release still has to reach xterm's
    // document listeners, including the one registered by the replayed press.
    win.addEventListener("mouseup", (up) => {
      if (up.button === 0) handToXterm(false);
    }, options);
    win.addEventListener("blur", cancel, { signal: gesture.signal });
    terminal.textarea?.addEventListener("blur", cancel, { signal: gesture.signal });
    doc.addEventListener("pointercancel", cancel, options);
  }
  screen.addEventListener("mousedown", onDown, true);
  return () => {
    cancel();
    selection?.abort();
    screen.removeEventListener("mousedown", onDown, true);
  };
}
