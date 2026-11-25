import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Folder, ArrowUp } from "lucide-react";
import { request } from "./api";
import { parentPath } from "./paths";
import { resolveRemotePath, type TerminalPath } from "./terminalPathLinks";
import { message, type FileEntry } from "./types";
import { Button, ErrorBox, Field, IconButton, Modal } from "./ui";

type Choice = { sessionId: string; target: TerminalPath };
type Listing = { path: string; entries: FileEntry[] };

export function useRelativePathOpen(
  activeId: string | undefined,
  openPath: (sessionId: string, target: TerminalPath) => void,
  restoreFocus: () => void,
) {
  const [choice, setChoice] = useState<Choice>();
  const confirmed = useRef<string | undefined>(undefined);
  const active = useRef(activeId);
  useLayoutEffect(() => {
    active.current = activeId;
    confirmed.current = undefined;
    setChoice(undefined);
    return () => { active.current = undefined; };
  }, [activeId]);
  return {
    open(sessionId: string, target: TerminalPath) {
      if (active.current !== sessionId) return;
      if (target.path.startsWith("/")) openPath(sessionId, target);
      else setChoice({ sessionId, target });
    },
    picker: choice && choice.sessionId === activeId && (
      <FolderPicker
        choice={choice}
        onClose={(folder) => { confirmed.current = folder; setChoice(undefined); }}
        afterClose={() => {
          if (active.current !== choice.sessionId) return;
          const folder = confirmed.current;
          confirmed.current = undefined;
          restoreFocus();
          if (folder) openPath(choice.sessionId, {
            ...choice.target, path: resolveRemotePath(folder, choice.target.path),
          });
        }}
      />
    ),
  };
}

function FolderPicker({ choice, onClose, afterClose }: {
  choice: Choice;
  onClose: (folder?: string) => void;
  afterClose: () => void;
}) {
  const [location, setLocation] = useState({ path: "." });
  const [address, setAddress] = useState("");
  const [listing, setListing] = useState<Listing>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void request<Listing>("file_list", {
      side: "remote", sessionId: choice.sessionId, path: location.path,
    }).then((result) => {
      if (!current) return;
      setListing(result);
      setAddress(result.path);
    }, (reason) => { if (current) setError(message(reason)); });
    return () => { current = false; };
  }, [choice.sessionId, location]);
  const navigate = (path: string) => {
    setListing(undefined);
    setError("");
    setAddress(path);
    setLocation({ path });
  };
  const valid = address.startsWith("/") && !address.startsWith("//") && !/[\\\x00-\x1f\x7f-\x9f]/u.test(address);
  return (
    <Modal open title="Choose remote folder"
      description={"Choose the folder that “" + choice.target.path + "” was relative to when it was printed."}
      onOpenChange={(value) => { if (!value) onClose(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); afterClose(); }}>
      <div className="modal-body relative-folder-picker">
        <form className="relative-folder-address" onSubmit={(e) => { e.preventDefault(); if (valid) navigate(address); }}>
          <Field label="Remote folder"><input value={address} placeholder="/path/to/folder" onChange={(e) => setAddress(e.target.value)} /></Field>
          <Button type="submit" disabled={!valid}>Go</Button>
        </form>
        <ErrorBox error={error} />
        {listing ? <>
          <div className="relative-folder-current">
            <IconButton label="Parent folder" disabled={listing.path === "/"} onClick={() => navigate(parentPath(listing.path))}><ArrowUp size={16} /></IconButton>
            <code>{listing.path}</code>
          </div>
          <div className="relative-folder-list" aria-label="Remote folders">
            {listing.entries.filter((entry) => entry.isDir).map((entry) => (
              <button type="button" className="drawer-entry" key={entry.path} onClick={() => navigate(entry.path)}>
                <Folder size={15} /><span>{entry.name}</span>
              </button>
            ))}
          </div>
        </> : !error && <span role="status">Loading folders…</span>}
      </div>
      <footer className="modal-footer">
        <Button onClick={() => onClose()}>Cancel</Button>
        <Button variant="primary" disabled={!listing || !valid || listing.path !== address} onClick={() => onClose(listing?.path)}>Use this folder</Button>
      </footer>
    </Modal>
  );
}
