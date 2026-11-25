import { useLayoutEffect, useRef, useState } from "react";
import { request } from "./api";
import { message } from "./types";
import type { TerminalPath } from "./terminalPathLinks";

type RemotePathResponse =
  | { kind: "file"; path: string; content: string; revision: string }
  | { kind: "directory"; path: string };
export type RemotePreview = {
  sessionId: string;
  path: string;
  content: string;
  revision: string;
  edit?: boolean;
  line?: number;
};

export function useTerminalPathOpen(
  activeId: string | undefined,
  drawerOpen: boolean,
  showDrawer: () => void,
  notify: (text: string, error?: boolean) => void,
) {
  const epoch = useRef(0);
  const [opening, setOpening] = useState(false);
  const [preview, setPreview] = useState<RemotePreview>();
  const [folderRequest, setFolderRequest] = useState<{
    id: number;
    path: string;
  }>();
  useLayoutEffect(() => {
    setOpening(false);
    setFolderRequest(undefined);
    return () => {
      epoch.current++;
    };
  }, [activeId]);
  useLayoutEffect(() => {
    if (!drawerOpen) setFolderRequest(undefined);
  }, [drawerOpen]);
  async function openPath(sessionId: string, target: TerminalPath, options?: { edit?: boolean; signal?: AbortSignal }) {
    if (sessionId !== activeId || options?.signal?.aborted || preview) return;
    const intent = ++epoch.current;
    setOpening(true);
    try {
      const result = await request<RemotePathResponse>("file_preview_path", {
        side: "remote",
        sessionId,
        path: target.path,
      });
      if (
        intent !== epoch.current || options?.signal?.aborted ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]',
        )
      )
        return;
      if (result.kind === "directory") {
        setFolderRequest({ id: intent, path: result.path });
        showDrawer();
      } else {
        setPreview({
          sessionId,
          path: result.path,
          content: result.content,
          revision: result.revision,
          edit: options?.edit,
          line: target.line,
        });
      }
    } catch (error) {
      if (intent === epoch.current && !options?.signal?.aborted)
        notify("Could not open " + target.path + " · " + message(error), true);
    } finally {
      if (intent === epoch.current) setOpening(false);
    }
  }
  return {
    openPath,
    opening,
    folderRequest,
    preview,
    close: () => setPreview(undefined),
  };
}
