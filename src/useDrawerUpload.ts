import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./api";
import { drawerUploadPlan } from "./fileTransferDrag";
import { captureNativeFileDropLayout, remoteDropPathBar } from "./nativeFileDropLayout";
import { queueFileTransfers } from "./queueFileTransfers";
import { message, type FileEntry, type Session } from "./types";

export function useDrawerUpload(
  listRef: RefObject<HTMLDivElement | null>,
  session: Session,
  listing: { path: string; entries: FileEntry[] } | undefined,
  notify: (text: string, error?: boolean) => void,
  onAccepted?: () => void,
  onQueued?: () => void,
) {
  const [hover, setHover] = useState<{ path: string; count: number; onPathBar: boolean } | null>(null);
  const latestNotify = useRef(notify);
  latestNotify.current = notify;
  const accepted = useRef(onAccepted);
  accepted.current = onAccepted;
  const queued = useRef(onQueued);
  queued.current = onQueued;
  useLayoutEffect(() => {
    setHover(null);
    const list = listRef.current;
    if (!desktop || !list || !listing || session.status !== "connected") return;
    const drawer = list.closest(".terminal-file-drawer");
    const directories = new Set(
      listing.entries.filter((item) => item.isDir).map((item) => item.path),
    );
    const currentWindow = getCurrentWindow();
    let disposed = false;
    let revision = 0;
    let hoverEvent = 0;
    let gesture: {
      paths: Set<string>;
      scale: Promise<number>;
      advertised: string | null;
    } | null = null;
    let unlisten: (() => void) | undefined;
    const destinationAt = (
      position: { x: number; y: number },
      scale: number,
    ) => {
      if (
        !Number.isFinite(scale) ||
        scale <= 0 ||
        document.querySelector(
          '[role="dialog"]:not([data-state="closed"]),[role="alertdialog"]:not([data-state="closed"]),[role="menu"][data-state="open"]',
        )
      )
        return null;
      const hit = document.elementFromPoint(
        position.x / scale,
        position.y / scale,
      );
      const pathBar = remoteDropPathBar(hit);
      if (pathBar && drawer?.contains(pathBar)) return { path: listing.path, onPathBar: true };
      if (!hit || !list.contains(hit)) return null;
      const folder = hit.closest<HTMLElement>("[data-drawer-directory]")
        ?.dataset.drawerDirectory;
      if (folder && !directories.has(folder)) return null;
      return { path: folder || listing.path, onPathBar: false };
    };
    void currentWindow
      .onDragDropEvent((event) => {
        if (disposed) return;
        const drop = event.payload;
        const serial = ++hoverEvent;
        if (drop.type === "leave") {
          gesture = null;
          setHover(null);
          return;
        }
        if (drop.type === "enter") {
          revision++;
          gesture = {
            paths: new Set(drop.paths),
            scale: currentWindow.scaleFactor(),
            advertised: null,
          };
        }
        const origin = gesture;
        if (!origin) return;
        if (drop.type === "enter" || drop.type === "over") {
          void origin.scale
            .then((scale) => {
              if (!disposed && gesture === origin && hoverEvent === serial) {
                const target = destinationAt(drop.position, scale);
                origin.advertised = target?.path ?? null;
                const count = origin.paths.size;
                setHover(previous => {
                  if (!target || !count) return null;
                  if (previous?.path === target.path && previous.count === count && previous.onPathBar === target.onPathBar) return previous;
                  return { ...target, count };
                });
              }
            })
            .catch(() => {
              if (!disposed && gesture === origin) setHover(null);
            });
          return;
        }
        gesture = null;
        setHover(null);
        const paths = new Set(drop.paths);
        if (
          !paths.size ||
          paths.size !== origin.paths.size ||
          [...paths].some((p) => !origin.paths.has(p))
        )
          return;
        const unchanged = captureNativeFileDropLayout(list, ".drawer-entry");
        const focusAtDrop = document.activeElement;
        const ticket = revision;
        void currentWindow
          .scaleFactor()
          .then(async (scale) => {
            if (disposed || ticket !== revision || !unchanged()) return;
            const target = destinationAt(drop.position, scale);
            if (!target || target.path !== origin.advertised) return;
            const plan = drawerUploadPlan(
              [...paths],
              target.path,
              session.id,
              session.name,
            );
            if (!plan) return;
            if (
              focusAtDrop === document.activeElement &&
              (focusAtDrop === document.body ||
                list.contains(focusAtDrop) ||
                focusAtDrop?.closest(".xterm"))
            )
              accepted.current?.();
            if (await queueFileTransfers(plan, session.tabId || session.id, latestNotify.current))
              queued.current?.();
          })
          .catch((error) => {
            if (!disposed) latestNotify.current(message(error), true);
          });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        if (!disposed) latestNotify.current(message(error), true);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [listRef, session.id, session.status, session.name, listing]);
  return hover;
}
