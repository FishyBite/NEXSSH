import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sessionTabId } from "./terminalLayout";
import type { Session } from "./types";

// A tool normally uses one workspace, including its open documents. Allocate a
// second instance only when both panes need that tool at the same time.
export function useToolSlots(wanted: Session[], sessions: Session[], keepPrimary: boolean, showStandalone: boolean) {
  const previous = useRef<string[]>([]);
  const owners = previous.current.map(tab => sessions.some(s => sessionTabId(s) === tab) ? tab : "");
  const ids = wanted.map(sessionTabId);
  for (const id of ids) {
    if (owners.includes(id)) continue;
    const free = owners.findIndex(tab => !ids.includes(tab));
    owners[free < 0 ? owners.length : free] = id;
  }
  if (!owners.length && (keepPrimary || showStandalone)) owners.push("");
  useLayoutEffect(() => { previous.current = owners; });
  return owners.map((tab, index) => ({
    session: sessions.find(item => sessionTabId(item) === tab),
    shown: (index === 0 && showStandalone) || (!!tab && ids.includes(tab)),
  }));
}

// Keep the React portal target stable when a tool moves from full-window
// to split view. Query documents, editor undo history and transfers stay live.
export function PaneDock({ sessionId, visible, activate, children }: {
  sessionId?: string; visible: boolean; activate?: () => void; children: ReactNode;
}) {
  const home = useRef<HTMLDivElement>(null);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "pane-docked-content";
    return element;
  });
  useLayoutEffect(() => {
    const destination = (sessionId && visible
      ? document.querySelector<HTMLElement>(`[data-pane-dock="${CSS.escape(sessionId)}"]`) : null) || home.current;
    if (destination && container.parentElement !== destination) destination.appendChild(container);
  });
  useLayoutEffect(() => () => { container.remove(); }, [container]);
  return <><div ref={home} className="session-file-body" hidden={!visible || !!sessionId} />
    {createPortal(<div className="pane-tool-content" onPointerDownCapture={activate} onFocusCapture={activate}>{children}</div>, container)}
  </>;
}
