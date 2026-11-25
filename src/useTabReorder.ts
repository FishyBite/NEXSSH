import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  reorderSessions,
  tabDropTarget,
  tabPreviewLayout,
  type TabPlacement,
} from "./sessionOrder";

type MoveTab = (
  sourceId: string,
  targetId: string,
  placement: TabPlacement,
) => void;
type SplitTarget = { peerId: string; side: "left" | "right" };
type DragState = {
  sourceId: string;
  inStrip: boolean;
  splitTarget: SplitTarget | null;
  width: number;
  height: number;
  x: number;
};

export function useTabReorder(
  ids: string[],
  onMove: MoveTab,
  splitTargetAt: (sourceId: string, x: number, y: number) => SplitTarget | null,
  onSplit: (sourceId: string, target: SplitTarget) => void,
) {
  const stripRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const gapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const current = useRef({ ids, onMove, splitTargetAt, onSplit });
  current.current = { ids, onMove, splitTargetAt, onSplit };
  const cleanup = useRef<((updateUi?: boolean) => void) | null>(null);
  const ignoredClick = useRef<string | null>(null);
  const clickTimer = useRef<number | undefined>(undefined);
  const flipFrom = useRef<Map<string, number> | null>(null);
  const animations = useRef<Animation[]>([]);
  const tabs = () =>
    Array.from(
      stripRef.current?.querySelectorAll<HTMLElement>(
        ".session-tab[data-session-id]",
      ) || [],
    );
  const clearPreview = () => {
    for (const tab of tabs()) tab.style.removeProperty("--tab-preview-x");
    if (gapRef.current) gapRef.current.style.visibility = "hidden";
  };
  const rememberPositions = () =>
    new Map(
      tabs().map((tab) => [
        tab.dataset.sessionId!,
        tab.getBoundingClientRect().left,
      ]),
    );
  useLayoutEffect(() => {
    const previous = flipFrom.current;
    flipFrom.current = null;
    if (
      !previous ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    animations.current.forEach((animation) => animation.cancel());
    animations.current = tabs().flatMap((tab) => {
      const left = previous.get(tab.dataset.sessionId!);
      const delta =
        left === undefined ? 0 : left - tab.getBoundingClientRect().left;
      return Math.abs(delta) < 1
        ? []
        : [
            tab.animate(
              [
                { transform: `translateX(${delta}px)` },
                { transform: "translateX(0)" },
              ],
              { duration: 150, easing: "cubic-bezier(.2,.8,.2,1)" },
            ),
          ];
    });
  }, [ids.join("\0")]);
  useEffect(
    () => () => {
      cleanup.current?.(false);
      window.clearTimeout(clickTimer.current);
      animations.current.forEach((animation) => animation.cancel());
    },
    [],
  );

  const startDrag = (
    event: PointerEvent<HTMLButtonElement>,
    sourceId: string,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    cleanup.current?.();
    animations.current.forEach((animation) => animation.cancel());
    const button = event.currentTarget;
    const sourceElement = button.closest<HTMLElement>(".session-tab")!;
    const sourceBounds = sourceElement.getBoundingClientRect();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const offsetX = startX - sourceBounds.left;
    let x = startX;
    let y = startY;
    let dragging = false;
    let cancelled = false;
    let frame = 0;
    let target: ReturnType<typeof tabDropTarget> = null;
    let splitTarget: SplitTarget | null = null;
    let ghostClientX = sourceBounds.left;
    const listeners = new AbortController();
    button.setPointerCapture(pointerId);

    const stop = (updateUi = true) => {
      listeners.abort();
      cancelAnimationFrame(frame);
      if (button.hasPointerCapture(pointerId))
        button.releasePointerCapture(pointerId);
      cleanup.current = null;
      clearPreview();
      if (updateUi) setDrag(null);
    };
    cleanup.current = stop;
    const updateTarget = () => {
      const strip = stripRef.current;
      if (!strip) return;
      const bounds = strip.getBoundingClientRect();
      const inStrip = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.top + strip.clientHeight;
      splitTarget = inStrip ? null : current.current.splitTargetAt(sourceId, x, y);
      const showDrag = (ghostLeft: number, width: number) =>
        setDrag((previous) =>
          previous?.sourceId === sourceId &&
          previous.inStrip === inStrip &&
          previous.width === width &&
          previous.splitTarget?.peerId === splitTarget?.peerId &&
          previous.splitTarget?.side === splitTarget?.side
            ? previous
            : { sourceId, inStrip, splitTarget, width, height: sourceBounds.height, x: ghostLeft },
        );
      if (!inStrip) {
        target = null;
        clearPreview();
        showDrag(0, sourceBounds.width);
        return;
      }
      const elements = tabs().filter((tab) =>
        current.current.ids.includes(tab.dataset.sessionId || ""),
      );
      const geometry = elements.map((tab) => ({
        id: tab.dataset.sessionId!,
        left: tab.offsetLeft,
        width: tab.offsetWidth,
      }));
      const hitBounds = geometry.map((tab) => ({
        id: tab.id,
        left: bounds.left + tab.left - strip.scrollLeft,
        right: bounds.left + tab.left + tab.width - strip.scrollLeft,
      }));
      target = tabDropTarget(hitBounds, sourceId, x);
      const preview = tabPreviewLayout(
        geometry,
        sourceId,
        target,
        parseFloat(getComputedStyle(strip).columnGap) || 0,
      );
      for (const tab of elements)
        tab.style.setProperty(
          "--tab-preview-x",
          `${tab.dataset.sessionId === sourceId ? 0 : preview.offsets.get(tab.dataset.sessionId!) || 0}px`,
        );
      if (gapRef.current) {
        gapRef.current.style.left = `${preview.gapLeft}px`;
        gapRef.current.style.width = `${sourceBounds.width}px`;
        gapRef.current.style.visibility = "visible";
      }
      const end = Math.min(bounds.right, hitBounds.at(-1)?.right ?? bounds.right);
      const width = Math.min(sourceBounds.width, Math.max(0, end - bounds.left));
      ghostClientX = Math.max(bounds.left, Math.min(x - offsetX, end - width));
      const ghostLeft = ghostClientX - bounds.left + strip.scrollLeft;
      if (ghostRef.current) ghostRef.current.style.transform = `translateX(${ghostLeft}px)`;
      showDrag(ghostLeft, width);
    };
    const scrollAtEdge = () => {
      const strip = stripRef.current;
      if (!strip || cancelled) return;
      const bounds = strip.getBoundingClientRect();
      if (y >= bounds.top && y <= bounds.bottom) {
        const delta =
          x < bounds.left + 36
            ? -Math.min(16, (bounds.left + 36 - x) / 2)
            : x > bounds.right - 36
              ? Math.min(16, (x - bounds.right + 36) / 2)
              : 0;
        if (delta && x >= bounds.left && x < bounds.right) {
          strip.scrollLeft += delta;
          updateTarget();
        }
      }
      frame = requestAnimationFrame(scrollAtEdge);
    };
    const finish = (commit: boolean) => {
      if (dragging) {
        ignoredClick.current = sourceId;
        window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          ignoredClick.current = null;
        }, 0);
      }
      const currentTabs = current.current.ids.map((id) => ({ id }));
      const accepted = commit && dragging && !cancelled && current.current.ids.includes(sourceId);
      if (accepted && splitTarget) {
        current.current.onSplit(sourceId, splitTarget);
      } else if (
        accepted &&
        target &&
        reorderSessions(
          currentTabs,
          sourceId,
          target.targetId,
          target.placement,
        ) !== currentTabs
      ) {
        flipFrom.current = rememberPositions();
        flipFrom.current.set(sourceId, ghostClientX);
        clearPreview();
        current.current.onMove(sourceId, target.targetId, target.placement);
      }
      stop();
    };
    window.addEventListener(
      "pointermove",
      (move) => {
        if (move.pointerId !== pointerId || cancelled) return;
        x = move.clientX;
        y = move.clientY;
        if (!dragging && Math.hypot(x - startX, y - startY) < 6) return;
        if (!dragging) {
          dragging = true;
          frame = requestAnimationFrame(scrollAtEdge);
        }
        move.preventDefault();
        updateTarget();
      },
      { signal: listeners.signal, passive: false },
    );
    window.addEventListener(
      "pointerup",
      (up) => {
        if (up.pointerId === pointerId) {
          x = up.clientX;
          y = up.clientY;
          if (dragging && !cancelled) updateTarget();
          finish(true);
        }
      },
      { signal: listeners.signal },
    );
    window.addEventListener(
      "pointercancel",
      (cancel) => {
        if (cancel.pointerId === pointerId) finish(false);
      },
      { signal: listeners.signal },
    );
    button.addEventListener("lostpointercapture", () => finish(false), {
      signal: listeners.signal,
    });
    window.addEventListener("blur", () => finish(false), {
      signal: listeners.signal,
    });
    window.addEventListener(
      "keydown",
      (key) => {
        if (key.key === "Escape" && dragging) {
          key.preventDefault();
          cancelled = true;
          target = null;
          splitTarget = null;
          cancelAnimationFrame(frame);
          clearPreview();
          setDrag(null);
        }
      },
      { signal: listeners.signal },
    );
  };

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    sourceId: string,
  ) => {
    if (
      !event.ctrlKey ||
      !event.shiftKey ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const targetId = ids[ids.indexOf(sourceId) + direction];
    if (!targetId) return;
    const button = event.currentTarget;
    flipFrom.current = rememberPositions();
    onMove(sourceId, targetId, direction < 0 ? "before" : "after");
    requestAnimationFrame(() => {
      if (button.isConnected) {
        button.focus();
        button.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  };

  return {
    stripRef,
    ghostRef,
    gapRef,
    drag,
    startDrag,
    onTabKeyDown,
    ignoreClick: (id: string) => ignoredClick.current === id,
  };
}
