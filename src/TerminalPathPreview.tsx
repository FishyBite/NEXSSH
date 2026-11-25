import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Decoration, EditorState, EditorView, highlightActiveLine, lineNumbers, minimalSetup,
} from "@uiw/react-codemirror";
import { request } from "./api";
import { changedRegion, parsePreviewDocument, serializePreviewDocument, updatePreviewDocument, type PreviewDocument } from "./previewDocument";
import type { RemotePreview } from "./useTerminalPathOpen";
import { message } from "./types";
import { Button, Modal } from "./ui";
import "./terminal-path-preview.css";

function DocumentView({ initial, target, edit, viewRef, onChange }: {
  initial: PreviewDocument; target: number; edit: boolean;
  viewRef: RefObject<EditorView | null>; onChange: (draft: PreviewDocument) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!parent.current) return;
    const line = Math.min(target, initial.doc.lines);
    const at = initial.doc.line(line).from;
    let current = initial;
    const view = new EditorView({
      parent: parent.current, doc: initial.doc, selection: { anchor: at },
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(!edit),
        EditorView.editable.of(edit),
        EditorView.contentAttributes.of({
          tabindex: "0", "aria-label": edit ? "Edit file contents" : "File contents",
          "aria-readonly": String(!edit), role: "textbox",
        }),
        edit ? [minimalSetup(), highlightActiveLine(), EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          current = updatePreviewDocument(current, update.changes, update.state.doc);
          onChange(current);
        })] : EditorView.decorations.of(Decoration.set([
          Decoration.line({ class: "preview-target-line" }).range(at),
        ])),
      ],
    });
    viewRef.current = view;
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
    if (edit) view.focus();
    return () => { viewRef.current = null; view.destroy(); };
  }, [initial, target, edit, viewRef, onChange]);
  return <div className="terminal-path-preview" ref={parent} />;
}

type FileVersion = { content: string; revision: string };

function Difference({ server, draft }: { server: FileVersion; draft: PreviewDocument }) {
  const [current, proposed] = useMemo(() =>
    changedRegion(server.content, serializePreviewDocument(draft)), [server, draft]);
  return <div className="preview-difference">
    {([["On server", current], ["Your draft", proposed]] as const).map(([title, part]) =>
      <section key={title} aria-label={title}>
        <h4>{title}</h4>
        <small>{part.range}{part.endings && " · " + part.endings}{part.text && !part.finalBreak && " · No final newline"}</small>
        <pre tabIndex={0}>{part.text || "∅"}</pre>
      </section>)}
  </div>;
}

export default function TerminalPathPreview({ preview, sessionName, connected, onClose, onDirtyChange }: {
  preview: RemotePreview; sessionName: string; connected: boolean;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const initial = useMemo(() => parsePreviewDocument(preview.content), [preview.content]);
  const [editing, setEditing] = useState(!!preview.edit);
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState({ document: initial, revision: preview.revision });
  const [conflict, setConflict] = useState<FileVersion>();
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const view = useRef<EditorView | null>(null);
  const saving = useRef(false);
  const dirty = draft.endings !== saved.document.endings || !draft.doc.eq(saved.document.doc);
  const requested = Math.max(1, preview.line || 1);
  const conflictRef = useRef<HTMLHeadingElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    onDirtyChange(dirty);
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => { window.removeEventListener("beforeunload", guard); onDirtyChange(false); };
  }, [dirty, onDirtyChange]);

  useLayoutEffect(() => {
    if (discard) keepRef.current?.focus();
    else if (conflict) conflictRef.current?.focus();
    else if (editing) view.current?.focus();
  }, [discard, conflict, editing]);

  function close() {
    if (saving.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  }

  async function save(reviewed?: FileVersion) {
    if (!connected || !dirty || saving.current || discard || (conflict && reviewed !== conflict)) return;
    const expected = reviewed?.revision ?? saved.revision;
    if (!expected) { setError("Reopen this file to obtain its server revision."); return; }
    saving.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    const target = { side: "remote", sessionId: preview.sessionId, path: preview.path };
    try {
      const result = await request<{ revision: string }>("file_save", {
        ...target, content: serializePreviewDocument(draft), revision: expected, backup: true,
      });
      setSaved({ document: draft, revision: result.revision });
      setConflict(undefined);
      setStatus("Saved with backup");
    } catch (e) {
      if (message(e).includes("File changed since it was opened")) {
        try {
          setConflict(await request<FileVersion>("file_read", target));
        } catch (readError) {
          setError("Could not read the newer server version. " + message(readError));
        }
      } else setError(message(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  // Capture before the dialog Close tooltip and global shell shortcuts.
  useLayoutEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing) return;
      const dialogs = document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
      const owner = view.current?.dom.closest('[role="dialog"]');
      if (!owner || dialogs[dialogs.length - 1] !== owner || owner.getAttribute("aria-hidden") === "true") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (discard) setDiscard(false); else close();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        if (editing && !conflict) void save();
      }
    }
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  });

  const line = Math.min(requested, draft.doc.lines);
  return (
    <Modal open title={editing ? "Edit file" : "File preview"}
      description={sessionName + " · " + preview.path} wide
      onOpenChange={(open) => { if (!open) close(); }}
      onCloseAutoFocus={(event) => event.preventDefault()}>
      <div hidden={!!conflict && !discard}>
        <DocumentView initial={initial} target={requested} edit={editing} viewRef={view} onChange={setDraft} />
      </div>
      {!connected && <p className="preview-message" role="status">This session is disconnected. You can still copy your draft.</p>}
      {error && <p className="preview-message preview-error" role="alert">{error}</p>}
      {discard ? <div className="preview-decision" aria-label="Unsaved changes">
        <strong>Discard unsaved changes?</strong>
        <div className="preview-actions">
          <Button ref={keepRef} onClick={() => setDiscard(false)}>Keep editing</Button>
          <Button variant="danger" onClick={onClose}>Discard and return</Button>
        </div>
      </div> : conflict ? <>
        <h3 className="preview-message" ref={conflictRef} tabIndex={-1}>File changed on the server</h3>
        <Difference server={conflict} draft={draft} />
        <footer className="terminal-preview-footer">
          <Button disabled={busy} onClick={() => setConflict(undefined)}>Back to draft</Button>
          <Button variant="primary" busy={busy} disabled={!connected} onClick={() => void save(conflict)}>Save reviewed draft</Button>
        </footer>
      </> : <footer className="terminal-preview-footer">
        <span role="status">{editing ? (dirty ? "Unsaved changes" : status || "Editing") : (
          <>{requested > draft.doc.lines && "Requested line " + requested + " is past the end. "}
            Line {line} of {draft.doc.lines}</>
        )}</span>
        {editing ? <div className="preview-actions">
          <Button onClick={close} disabled={busy}>Back to terminal</Button>
          <Button variant="primary" disabled={!dirty || !connected} busy={busy} onClick={() => void save()}>Save</Button>
        </div> : <div className="preview-actions"><span>Read only</span>
          <Button disabled={!connected} onClick={() => setEditing(true)}>Edit</Button></div>}
      </footer>}
    </Modal>
  );
}
