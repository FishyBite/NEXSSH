import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useSessionSidebar(immersive: boolean, sessionId: string, view: string, workspace: string, focusTerminal: () => void) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem("nexssh.session.sidebar.pinned") === "true"; }
    catch { return false; }
  });
  const sidebar = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = immersive && (open || pinned);
  const overlay = immersive && open && !pinned;
  useLayoutEffect(() => { setOpen(false); }, [immersive, sessionId, view, workspace]);

  const dismiss = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (!restoreFocus) return;
    trigger.current?.focus({ preventScroll: true });
    if (view === "Terminal") focusTerminal();
  }, [view, focusTerminal]);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    try { localStorage.setItem("nexssh.session.sidebar.pinned", String(next)); } catch {}
    if (next) setOpen(false);
    else dismiss();
  };

  useLayoutEffect(() => {
    if (!overlay) return;
    const panel = sidebar.current;
    if (!panel) return;
    (panel.querySelector<HTMLElement>('[aria-current="page"]') || panel).focus({preventScroll:true});
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
      } else if (event.key === "Tab") {
        const controls = Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)"))
          .filter(node => node.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        const target = document.activeElement;
        if (event.shiftKey && target === first) { event.preventDefault(); trigger.current?.focus(); }
        else if (event.shiftKey && target === trigger.current) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && target === last) { event.preventDefault(); trigger.current?.focus(); }
        else if (!event.shiftKey && target === trigger.current) { event.preventDefault(); first?.focus(); }
      }
    };
    const outsideHeader = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".terminal-topline") && !trigger.current?.contains(target)) dismiss(false);
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outsideHeader, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outsideHeader, true);
    };
  }, [overlay, dismiss]);
  return { sidebar, trigger, pinned, overlay, visible, dismiss, togglePin, toggle: () => {
    if (pinned) togglePin();
    else if (open) dismiss();
    else setOpen(true);
  } };
}
