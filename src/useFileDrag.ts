import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./api";
import { message } from "./types";
import { captureNativeFileDropLayout, remoteDropPathBar } from "./nativeFileDropLayout";
import {
  acceptFileDrop,
  captureExternalFiles,
  captureFileDrag,
  fileDragStillValid,
  type FileDragContext,
  type FileDragSnapshot,
  type FileDropTarget,
  type FileSide,
  type FileTransferPlan,
} from "./fileTransferDrag";

export function fileDropHit(
  x: number,
  y: number,
): {
  target: FileDropTarget | null;
  list?: HTMLElement;
  row?: HTMLElement;
  pathBar?: HTMLElement;
} {
  const element = document.elementFromPoint(x, y);
  const pathBar = remoteDropPathBar(element);
  if (pathBar) return { target: { side: "remote" }, pathBar };
  const leftPathBar = !element?.closest("button") && element?.closest<HTMLElement>('[data-file-drop-path="local"]');
  if (leftPathBar) return { target: { side: "local" }, pathBar: leftPathBar };
  const list = element?.closest<HTMLElement>("[data-file-drop-list]");
  if (!element || !list) return { target: null };
  const side = list.dataset.fileDropList;
  if (side !== "local" && side !== "remote") return { target: null };
  if (element.closest(".file-table-heading,.file-loading,.file-inline-transfer"))
    return { target: null, list };
  const control = element.closest(
    "button,input,select,textarea,a,[role=button]",
  );
  const row = element.closest<HTMLElement>(".file-row[data-file-path]");
  if (row) {
    if (
      row.dataset.fileDirectory !== "true" ||
      (control && !control.classList.contains("file-name"))
    )
      return { target: null, list };
    return { target: { side, directory: row.dataset.filePath }, list, row };
  }
  return { target: control ? null : { side }, list };
}

type DragUi = {
  snapshot: FileDragSnapshot;
  destination: string | null;
  x: number;
  y: number;
};

export function useFileDrag(
  getContext: () => FileDragContext,
  onDrop: (plan: FileTransferPlan) => void,
) {
  const current = useRef({ getContext, onDrop });
  current.current = { getContext, onDrop };
  const ghostRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragUi | null>(null);
  const gesture = useRef<{
    validate: () => void;
    stop: (updateUi?: boolean) => void;
  } | null>(null);
  const ignoredClick = useRef(false);
  const clickTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    gesture.current?.validate();
  });
  useEffect(
    () => () => {
      gesture.current?.stop(false);
      window.clearTimeout(clickTimer.current);
    },
    [],
  );

  const startDrag = (
    event: PointerEvent<HTMLButtonElement>,
    side: FileSide,
    path: string,
    selected: readonly string[],
    protocol: string,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    ignoredClick.current = false;
    window.clearTimeout(clickTimer.current);
    const snapshot = captureFileDrag(
      current.current.getContext(),
      side,
      path,
      selected,
      protocol,
    );
    if (!snapshot) return;
    gesture.current?.stop();
    const button = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let x = startX;
    let y = startY;
    let dragging = false;
    let cancelled = false;
    let frame = 0;
    let hit: ReturnType<typeof fileDropHit> = { target: null };
    let highlight: HTMLElement | undefined;
    let highlightClass = "";
    const listeners = new AbortController();
    button.setPointerCapture(pointerId);
    const clearHighlight = () => {
      if (highlight && highlightClass)
        highlight.classList.remove(highlightClass);
      highlight = undefined;
    };
    const stop = (updateUi = true) => {
      listeners.abort();
      cancelAnimationFrame(frame);
      clearHighlight();
      if (button.hasPointerCapture(pointerId))
        button.releasePointerCapture(pointerId);
      gesture.current = null;
      if (updateUi) setDrag(null);
    };
    const cancel = () => {
      cancelled = true;
      hit = { target: null };
      cancelAnimationFrame(frame);
      clearHighlight();
      setDrag(null);
    };
    const validate = () => {
      if (
        !cancelled &&
        !fileDragStillValid(snapshot, current.current.getContext())
      )
        cancel();
    };
    gesture.current = { validate, stop };
    const update = () => {
      validate();
      if (cancelled) return;
      const context = current.current.getContext();
      hit = fileDropHit(x, y);
      if (!button.closest(".files-page")?.contains(hit.pathBar || hit.list || null)) hit = { target: null };
      const accepted = acceptFileDrop(snapshot, context, hit.target);
      const targetElement = accepted ? hit.pathBar || hit.row || hit.list : undefined;
      const targetClass = hit.row ? "drop-target" : "file-drop-target";
      if (targetElement !== highlight || targetClass !== highlightClass) {
        clearHighlight();
        highlight = targetElement;
        highlightClass = targetClass;
      }
      highlight?.classList.add(highlightClass);
      const ghostX = Math.max(8, Math.min(x + 14, innerWidth - 304));
      const ghostY = Math.max(8, Math.min(y + 14, innerHeight - (ghostRef.current?.offsetHeight || 66) - 8));
      if (ghostRef.current)
        ghostRef.current.style.transform = `translate3d(${ghostX}px,${ghostY}px,0)`;
      const destination = accepted?.destinationDirectory || null;
      setDrag((previous) =>
        previous?.snapshot === snapshot && previous.destination === destination
          ? previous
          : { snapshot, destination, x: ghostX, y: ghostY },
      );
    };
    const scrollAtEdge = () => {
      if (cancelled) return;
      update();
      if (cancelled) return;
      const list = hit.list;
      if (list && list.dataset.fileDropList !== snapshot.side) {
        const bounds = list.getBoundingClientRect();
        if (
          x >= bounds.left &&
          x <= bounds.right &&
          y >= bounds.top &&
          y <= bounds.bottom
        ) {
          const delta =
            y < bounds.top + 40
              ? -Math.min(12, (bounds.top + 40 - y) / 3)
              : y > bounds.bottom - 40
                ? Math.min(12, (y - bounds.bottom + 40) / 3)
                : 0;
          if (delta) {
            list.scrollTop += delta;
            update();
          }
        }
      }
      frame = requestAnimationFrame(scrollAtEdge);
    };
    const finish = (commit: boolean) => {
      if (dragging || cancelled) {
        ignoredClick.current = true;
        window.clearTimeout(clickTimer.current);
        // A lost capture can precede pointerup; suppress that late click until a new gesture.
        if (commit)
          clickTimer.current = window.setTimeout(() => {
            ignoredClick.current = false;
          }, 0);
      }
      const plan =
        commit && dragging && !cancelled
          ? acceptFileDrop(snapshot, current.current.getContext(), hit.target)
          : null;
      stop();
      if (plan) current.current.onDrop(plan);
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
        update();
      },
      { signal: listeners.signal, passive: false },
    );
    window.addEventListener(
      "pointerup",
      (up) => {
        if (up.pointerId !== pointerId) return;
        x = up.clientX;
        y = up.clientY;
        if (dragging && !cancelled) update();
        finish(true);
      },
      { signal: listeners.signal },
    );
    window.addEventListener(
      "pointercancel",
      (event) => {
        if (event.pointerId === pointerId) finish(false);
      },
      { signal: listeners.signal },
    );
    button.addEventListener("lostpointercapture", () => finish(false), {
      signal: listeners.signal,
    });
    window.addEventListener("blur", () => finish(false), {
      signal: listeners.signal,
    });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) finish(false);
      },
      { signal: listeners.signal },
    );
    window.addEventListener(
      "keydown",
      (key) => {
        if (key.key === "Escape" && dragging) {
          key.preventDefault();
          key.stopPropagation();
          cancel();
        }
      },
      { signal: listeners.signal },
    );
  };

  return { drag, ghostRef, startDrag, ignoreClick: () => ignoredClick.current };
}

export type NativeDropPreview = { snapshot: FileDragSnapshot; destination: string; onPathBar: boolean };

export function useNativeFileDrop(
  page: RefObject<HTMLElement | null>, sessionId: string | undefined, protocol: string,
  getContext: () => FileDragContext, onDrop: (plan: FileTransferPlan) => Promise<void>,
  notify: (text: string, error?: boolean) => void,
) {
  const latest = useRef({ getContext, onDrop, notify });
  latest.current = { getContext, onDrop, notify };
  // Some transports deliver drop alone. Once enter is available, a drop must belong
  // to this pane's advertised gesture, including after switching sessions or protocols.
  const receivesEnter = useRef(false);
  const [preview, setPreview] = useState<NativeDropPreview | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!desktop || !sessionId) return;
    const win = getCurrentWindow();
    let disposed = false;
    let revision = 0;
    let gesture: { snapshot: FileDragSnapshot | null; advertised: string | null } | undefined;
    let unlisten: (() => void) | undefined;
    void win.onDragDropEvent(async ({ payload }) => {
      const ticket = ++revision;
      if (disposed) return;
      if (payload.type === "leave") {
        gesture = undefined;
        setPreview(null);
        return;
      }
      const context = latest.current.getContext();
      if (payload.type === "enter") {
        receivesEnter.current = true;
        gesture = { snapshot: captureExternalFiles(context, payload.paths, protocol), advertised: null };
        setPreview(null);
      }
      const origin = gesture;
      const dropping = payload.type === "drop";
      const snapshot = origin?.snapshot ?? (dropping && !receivesEnter.current ? captureExternalFiles(context, payload.paths, protocol) : null);
      if (dropping) {
        gesture = undefined;
        setPreview(null);
      }
      if (!snapshot) return;
      if (dropping && origin) {
        const actual = new Set(payload.paths);
        if (actual.size !== snapshot.entries.length || snapshot.entries.some(entry => !actual.has(entry.path))) return;
      }
      const list = page.current?.querySelector<HTMLElement>('[data-file-drop-list="remote"]') || null;
      const pane = list?.closest('[data-file-side="remote"]');
      const layoutUnchanged = dropping && captureNativeFileDropLayout(list);
      try {
        const scale = await win.scaleFactor();
        if (disposed || (!dropping && ticket !== revision) || !Number.isFinite(scale) || scale <= 0 || (layoutUnchanged && !layoutUnchanged())) return;
        const hit = fileDropHit(payload.position.x / scale, payload.position.y / scale);
        const plan = pane?.contains(hit.pathBar || hit.list || null)
          ? acceptFileDrop(snapshot, latest.current.getContext(), hit.target)
          : null;
        if (dropping) {
          if (plan && (!origin || origin.advertised === plan.destinationDirectory)) await latest.current.onDrop(plan);
        } else if (origin) {
          origin.advertised = plan?.destinationDirectory || null;
          const destination = origin.advertised;
          const onPathBar = !!hit.pathBar;
          setPreview(previous => destination
            ? previous?.snapshot === snapshot && previous.destination === destination && previous.onPathBar === onPathBar
              ? previous : { snapshot, destination, onPathBar }
            : null);
        }
      } catch (error) {
        if (disposed || ticket !== revision) return;
        setPreview(null);
        if (origin) origin.advertised = null;
        if (dropping) latest.current.notify(message(error), true);
      }
    }).then(fn => {
      if (disposed) fn(); else unlisten = fn;
    }).catch(error => { if (!disposed) latest.current.notify(message(error), true); });
    return () => { disposed = true; unlisten?.(); };
  }, [page, sessionId, protocol]);
  return preview && fileDragStillValid(preview.snapshot, getContext()) ? preview : null;
}
