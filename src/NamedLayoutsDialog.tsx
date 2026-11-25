import { useState } from "react";
import { Columns2, Rows2, Trash2 } from "lucide-react";
import { Button, ErrorBox, Field, IconButton, Modal } from "./ui";
import { layoutStorageKey, readNamedLayouts, type LayoutSnapshot, type NamedLayout } from "./namedLayouts";
import { message, uid, type Host } from "./types";
import "./namedLayouts.css";

type Props = {
  workspace: string;
  hosts: Host[];
  snapshot?: LayoutSnapshot;
  verifySnapshot: (snapshot: LayoutSnapshot) => Promise<void>;
  onOpen: (layout: NamedLayout) => void;
  onClose: () => void;
};
export function NamedLayoutsDialog({workspace, hosts, snapshot, verifySnapshot, onOpen, onClose}: Props) {
  const key = layoutStorageKey(workspace);
  const [layouts, setLayouts] = useState(() => {
    try { return readNamedLayouts(localStorage.getItem(key)); } catch { return []; }
  });
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState("");
  function write(next: NamedLayout[]) {
    localStorage.setItem(key, JSON.stringify(next));
    setLayouts(next);
    setError("");
  }
  return <Modal open onOpenChange={open => { if (!open) onClose(); }} title="Saved layouts">
    <div className="modal-body named-layouts">
      {snapshot && <form className="named-layout-save" onSubmit={async event => {
        event.preventDefault();
        if (busy || !name.trim()) return;
        if (layouts.some(layout => layout.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) {
          setError("Choose a different name for this layout."); return;
        }
        setBusy(true);
        try {
          await verifySnapshot(snapshot);
          write([...layouts, { ...snapshot, name:name.trim(), id:uid() }]);
          setName("");
        } catch (e) { setError(message(e)); } finally { setBusy(false); }
      }}>
        <Field label="Layout name"><input value={name} onChange={event => setName(event.target.value)} maxLength={80}
          placeholder="e.g. App and database" autoComplete="off" /></Field>
        <Button variant="primary" type="submit" busy={busy} disabled={!name.trim()}>Save current split</Button>
      </form>}
      {!layouts.length && <p className="named-layout-empty">{snapshot
        ? "No layouts saved in this workspace yet." : "Split two connected sessions to save your first layout."}</p>}
      <ErrorBox error={error} />
      {!!layouts.length && <ul className="named-layout-list">{layouts.map(layout => {
        const Icon = layout.split === "vertical" ? Columns2 : Rows2;
        const hasHosts = layout.panes.every(p => hosts.some(host => host.id === p.hostId && host.workspaceId === workspace));
        const details = layout.panes.map(p => {
          const host = hosts.find(h => h.id === p.hostId);
          return `${host?.name || "Missing host"} · ${p.view === "Files" ? "SFTP" : p.view}`;
        });
        return <li key={layout.id}>
          <Icon aria-hidden="true" size={18}/>
          <div className="named-layout-label"><strong>{layout.name}</strong><small title={details.join(" / ")}>{details.join(" / ")}</small></div>
          {removing === layout.id ? <>
            <Button variant="ghost" onClick={() => setRemoving("")}>Cancel</Button>
            <Button variant="danger" onClick={() => {
              try {write(layouts.filter(item => item.id !== layout.id)); setRemoving("");} catch(e) {setError(message(e));}
            }}>Remove</Button>
          </> : <>
            <Button disabled={!hasHosts || busy} onClick={() => onOpen(layout)} aria-label={`Open layout ${layout.name}`}>Open</Button>
            <IconButton disabled={busy} label={`Remove layout ${layout.name}`} onClick={() => setRemoving(layout.id)}><Trash2 size={15}/></IconButton>
          </>}
        </li>;
      })}</ul>}
    </div>
  </Modal>;
}
