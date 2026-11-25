import { joinFilePath, type FileTransferPlan } from "./fileTransferDrag";
import type { FileEntry, Session } from "./types";

export interface DrawerDownloadHistory {
  directory: string;
  transferIds: Set<string>;
}

export function drawerDownloadPlan(
  entries: FileEntry[],
  directory: string,
  session: Session,
): FileTransferPlan {
  const requests = entries.map(({ path, name }) => {
    // Remote names can contain separators and device names that Windows interprets specially.
    if (!name || /[<>:"/\\|?*\x00-\x1f]|[. ]$/u.test(name) ||
        /^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/iu.test(name))
      throw new Error("Cannot download this filename on Windows: " + name);
    return {
      source: path,
      destination: joinFilePath(directory, name, "local"),
      direction: "download" as const,
      protocol: "sftp" as const,
      sessionId: session.id,
    };
  });
  return { sessionName: session.name, destinationDirectory: directory, direction: "download", requests };
}
