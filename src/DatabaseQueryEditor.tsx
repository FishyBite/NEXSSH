import { useEffect, useRef, useState } from "react";
import { BookOpen, Play, Plus, Save, Square, X } from "lucide-react";
import { request } from "./api";
import { Button, Confirm, ErrorBox, Field, IconButton, Modal } from "./ui";
import { message, uid } from "./types";
import { deleteNamedQuery, executionText, initialQuery, libraryKey, saveNamedQuery, savedQueries, type DatabaseFileRequest, type SavedQuery } from "./databaseQueries";
import type { DbGrid, Engine } from "./databaseProfiles";

interface Draft {
  id: string; name: string; text: string; original: string; savedId?: string;
  result?: DbGrid; error?: string;
}
function draft(name: string, text: string, savedId?: string): Draft {
  return { id: uid(), name, text, original: text, savedId };
}

interface Props {
  workspace: string; profileId: string; nativeId: string; engine: Engine; target: string;
  enabled: boolean; shown: boolean; file?: DatabaseFileRequest; onFileConsumed?: (id: string) => void;
  onRunning: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}
export function DatabaseQueryEditor({ workspace, profileId, nativeId, engine, target, enabled, shown, file, onFileConsumed, onRunning, onDirtyChange }: Props) {
  const json = engine === "mongodb" || engine === "redis";
  const [tabs, setTabs] = useState(() => [draft("Query 1", initialQuery(engine))]);
  const [selected, select] = useState(tabs[0].id);
  const tab = tabs.find(t => t.id === selected) || tabs[0];
  const [operation, setOperation] = useState<{ native: string; token: string; tab: string } | null>(null);
  const running = useRef(operation);
  const [cancelling, setCancelling] = useState(false);
  const [closingTab, setClosingTab] = useState<Draft | null>(null);
  const [dialog, openDialog] = useState<"save" | "open" | null>(null);
  const [name, setName] = useState("");
  const [library, setLibrary] = useState<SavedQuery[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [deleting, setDeleting] = useState<SavedQuery | null>(null);
  const nextNumber = useRef(2);
  const input = useRef<HTMLTextAreaElement>(null);
  const consumed = useRef("");
  const alive = useRef(false);
  const currentId = useRef(nativeId);
  const key = libraryKey(workspace, profileId);
  const dirty = tabs.some(draft => draft.text !== draft.original);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (currentId.current === nativeId) return;
    currentId.current = nativeId;
    running.current = null;
    setOperation(null); setCancelling(false); onRunning(false);
    setTabs(previous => previous.map(t => ({ ...t, result: undefined, error: undefined })));
  }, [nativeId, onRunning]);

  function add(next: Draft) {
    setTabs(prev => [...prev, next]);
    select(next.id);
  }
  useEffect(() => {
    if (!file || json || consumed.current === file.id) return;
    consumed.current = file.id;
    add(draft(file.name, file.text));
    onFileConsumed?.(file.id);
  }, [file, json, onFileConsumed]);

  function change(id: string, update: Partial<Draft>) {
    setTabs(previous => previous.map(d => d.id === id ? { ...d, ...update } : d));
  }
  function close(id: string) {
    if (running.current?.tab === id) return;
    const remaining = tabs.filter(t => t.id !== id);
    if (!remaining.length) remaining.push(draft("Query " + nextNumber.current++, ""));
    setTabs(remaining);
    if (id === selected) select(remaining[remaining.length-1].id);
    setClosingTab(null);
  }
  async function execute() {
    if (!enabled || running.current || !nativeId || !input.current) return;
    const query = json ? tab.text.trim() : executionText(tab.text, input.current.selectionStart, input.current.selectionEnd);
    if (!query) return;
    const op = { native: nativeId, token: uid(), tab: tab.id };
    running.current = op;
    setOperation(op); setCancelling(false); onRunning(true);
    change(op.tab, { result: undefined, error: undefined });
    try {
      const result = await request<DbGrid>("db_query", { id: op.native, requestId: op.token, query });
      if (alive.current && running.current === op) change(op.tab, { result });
    } catch (e) {
      if (alive.current && running.current === op) change(op.tab, { error: message(e) });
    } finally {
      if (alive.current && running.current === op) {
        running.current = null; setOperation(null); setCancelling(false); onRunning(false);
      }
    }
  }
  async function cancel() {
    const op = running.current;
    if (!op || cancelling) return;
    setCancelling(true);
    try {
      const result = await request<{ cancelled: boolean }>("db_cancel", { id: op.native, requestId: op.token });
      if (!result.cancelled && alive.current && running.current === op) setCancelling(false);
    } catch (e) {
      if (alive.current && running.current === op) { setCancelling(false); change(op.tab, { error: message(e) }); }
    }
  }
  function openLibrary() {
    setLibraryError(""); openDialog("open");
    try { setLibrary(savedQueries(key)); } catch (e) { setLibrary([]); setLibraryError(message(e)); }
  }
  function openSave() { setName(tab.name); setLibraryError(""); openDialog("save"); }
  function save() {
    try {
      const entry = saveNamedQuery(key, tab.savedId, name, tab.text);
      change(tab.id, { name: entry.name, original: entry.text, savedId: entry.id });
      openDialog(null);
    } catch (e) { setLibraryError(message(e)); }
  }
  const busy = operation?.tab === tab.id;
  return <div className="db-query-pane" hidden={!shown}>
    <div className="db-query-tabs">
      <div className="db-open-queries" role="group" aria-label="Open queries">
        {tabs.map(t => <div key={t.id} className={t.id === tab.id ? "db-doc active" : "db-doc"}>
          <button type="button" title={t.name + " · " + target} aria-pressed={t.id === tab.id} onClick={() => select(t.id)}>{t.name}{t.text !== t.original && " •"}</button>
          <IconButton label={"Close " + t.name} disabled={operation?.tab === t.id} onClick={() => t.text !== t.original ? setClosingTab(t) : close(t.id)}><X size={12} /></IconButton>
        </div>)}
      </div>
      <IconButton label="New query tab" onClick={() => add(draft("Query " + nextNumber.current++, ""))}><Plus size={15} /></IconButton>
    </div>
    <div className="db-editor-head"><div className="toolbar">
      <Button onClick={openLibrary}><BookOpen size={14}/> Saved queries</Button>
      <IconButton label="Save named query" onClick={openSave}><Save size={15}/></IconButton>
    </div><div className="toolbar">
      {operation && <Button disabled={cancelling} onClick={() => void cancel()} title={"Cancel " + (tabs.find(t => t.id === operation.tab)?.name || "query")}><Square size={12}/> {cancelling ? "Cancelling…" : "Cancel query"}</Button>}
      <Button variant="primary" disabled={!enabled || !!operation || !tab.text.trim()} onClick={() => void execute()} title="Run selection or query (Ctrl+Enter)"><Play size={14}/> Run</Button>
    </div></div>
    {json && <span className="db-editor-hint">{engine === "mongodb" ? "Enter a MongoDB command as a JSON object." : "Enter a Redis command as a JSON array of strings."}</span>}
    <textarea ref={input} className="db-query" aria-label={json ? "Database command" : "SQL query"} value={tab.text} spellCheck={false}
      onChange={e => change(tab.id, { text: e.target.value })} onKeyDown={e => {
        if (!(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) void execute(); }
        if (e.key.toLowerCase() === "s") { e.preventDefault(); if (!e.repeat) openSave(); }
      }} />
    <section className="db-results" aria-label="Results">
      <header><h3>Results</h3>{tab.result && <small>{tab.result.affected != null ? tab.result.affected + " affected" : tab.result.rows.length + " rows"}{tab.result.truncated && " · limited"}</small>}</header>
      <ErrorBox error={tab.error || ""} />
      {busy && <p className="db-note" role="status">Running…</p>}
      {!busy && !tab.result && !tab.error && <p className="db-note">Run a query to see results.</p>}
      {tab.result && <ResultGrid grid={tab.result}/>}
    </section>
    <Modal open={dialog !== null} onOpenChange={value => { if (!value) openDialog(null); }} title={dialog === "save" ? "Save query" : "Saved queries"} description={target}>
      {dialog === "save" ? <form onSubmit={e => { e.preventDefault(); save(); }}>
        <div className="modal-body"><Field label="Query name"><input autoFocus required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></Field><ErrorBox error={libraryError}/></div>
        <footer className="modal-footer"><Button onClick={() => openDialog(null)}>Cancel</Button><Button type="submit" variant="primary">Save query</Button></footer>
      </form> : <div className="modal-body"><ErrorBox error={libraryError}/>
        {!library.length && !libraryError && <p className="db-note">No saved queries for this profile.</p>}
        {library.map(q => <div className="db-saved-query" key={q.id}><Button onClick={() => {
          const open = tabs.find(t => t.savedId === q.id);
          if (open) select(open.id); else add(draft(q.name, q.text, q.id));
          openDialog(null);
        }}>{q.name}</Button><IconButton label={"Delete saved query " + q.name} onClick={() => setDeleting(q)}><X size={14}/></IconButton></div>)}
      </div>}
    </Modal>
    <Confirm open={!!closingTab} title="Discard unsaved query changes?" description={closingTab?.name || ""} confirmLabel="Discard" danger
      onClose={() => setClosingTab(null)} onConfirm={() => { if (closingTab) close(closingTab.id); }} />
    <Confirm open={!!deleting} title="Delete saved query?" description={deleting?.name || ""} confirmLabel="Delete" danger onClose={() => setDeleting(null)} onConfirm={() => {
      if (deleting) { deleteNamedQuery(key, deleting.id); setLibrary(savedQueries(key)); setTabs(previous => previous.map(t => t.savedId === deleting.id ? { ...t, savedId: undefined } : t)); }
    }}/>
  </div>;
}

export function ResultGrid({ grid }: { grid: DbGrid }) {
  if (!grid.columns.length) return <p className="db-note">Command completed.</p>;
  return <div className="db-grid" tabIndex={0}><table>
    <thead><tr>{grid.columns.map((column, i) => <th scope="col" key={i}>{column}</th>)}</tr></thead>
    <tbody>{grid.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell == null ? <em>NULL</em> : cell}</td>)}</tr>)}</tbody>
  </table></div>;
}
