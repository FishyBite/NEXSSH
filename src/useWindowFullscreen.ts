import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./api";
import { message } from "./types";

function readFullscreen() {
  return desktop ? getCurrentWindow().isFullscreen() : Promise.resolve(!!document.fullscreenElement);
}

export function useWindowFullscreen(notify: (text: string, error: boolean) => void) {
  const [active, setActive] = useState(false);
  const transitioning = useRef(false);
  const revision = useRef(0);
  const toggle = useCallback(async () => {
    if (transitioning.current) return;
    transitioning.current = true;
    revision.current++;
    try {
      if (desktop) {
        const win = getCurrentWindow();
        const next = !(await win.isFullscreen());
        await win.setFullscreen(next);
        setActive(next);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        setActive(!!document.fullscreenElement);
      } else {
        await document.documentElement.requestFullscreen();
        setActive(!!document.fullscreenElement);
      }
    } catch (error) {
      notify("Could not switch full screen. " + message(error), true);
    } finally {
      transitioning.current = false;
    }
  }, [notify]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      if (transitioning.current) return;
      const current = ++revision.current;
      void readFullscreen().then(value => {
        if (current === revision.current) setActive(!!value);
      }).catch(() => {});
    };
    const resized = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, 140);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F11" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void toggle();
    };
    sync();
    window.addEventListener("resize", resized);
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      revision.current++;
      window.removeEventListener("resize", resized);
      document.removeEventListener("fullscreenchange", sync);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [toggle]);
  return { active, toggle };
}
