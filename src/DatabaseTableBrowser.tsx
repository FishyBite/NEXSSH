import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Filter, KeyRound, Pencil, RefreshCw } from "lucide-react";
import { request } from "./api";
import type { DbObject } from "./databaseProfiles";
import { csvFilename, editableRow, filteredRequest, sortedRequest, type EditRow, type TablePage, type TableRequest } from "./databaseTable";
import { Button, ErrorBox, Field, IconButton, Modal } from "./ui";
import { message } from "./types";
import "./databaseTable.css";

interface Props {
  id: string;
  object: DbObject;
  readOnly: boolean;
  disabled?: boolean;
  connectionLabel?: string;
}

interface PageResponse {
  request: TableRequest;
  revision: number;
  page?: TablePage;
  error?: string;
}

export function DatabaseTableBrowser(props: Props) {
  const { id, object } = props;
  return <TableBrowser key={JSON.stringify([id, object.schema, object.name, object.kind])} {...props} />;
}

function TableBrowser({ id, object, readOnly, disabled = false, connectionLabel }: Props) {
  const { name, schema, kind } = object;
  const caption = [schema, name].filter(Boolean).join(".");
  const [criteria, setCriteria] = useState<TableRequest>({ offset: 0, limit: 50 });
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [revision, setRevision] = useState(0);
  const [response, setResponse] = useState<PageResponse>();
  const [columnsVisible, setColumnsVisible] = useState(false);
  const [filterVisible, setFilterVisible] = useState(false);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [edit, setEdit] = useState<{ row: EditRow; column: string }>();
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const current = response?.request === criteria && response.revision === revision ? response : undefined;
  const page = current?.page;
  const loading = !disabled && !current;
  const locked = disabled || loading || !!edit || exportOpen;
  const [metadata, setMetadata] = useState<TablePage["metadata"]>([]);
  const selectedColumn = metadata.some(col => col.name === filterColumn) ? filterColumn : metadata[0]?.name || "";

  useEffect(() => {
    if (disabled) return;
    let active = true;
    void request<TablePage>("db_table_page", { id, schema, name, kind, ...criteria })
      .then(result => {
        if (!active) return;
        setResponse({ request: criteria, revision, page: result });
        setMetadata(result.metadata);
      })
      .catch(error => {
        if (active) setResponse({ request: criteria, revision, error: message(error) });
      });
    return () => { active = false; };
  }, [id, schema, name, kind, criteria, revision, disabled]);

  function changeCriteria(next: TableRequest) {
    setPreviousOffsets([]);
    setCriteria(next);
    setNotice("");
  }
  function changePage(forward: boolean) {
    if (!page || locked) return;
    if (forward && page.hasMore && page.rows.length) {
      setPreviousOffsets([...previousOffsets, criteria.offset]);
      setCriteria({ ...criteria, offset: criteria.offset + page.rows.length });
    } else if (!forward && previousOffsets.length) {
      setCriteria({ ...criteria, offset: previousOffsets[previousOffsets.length - 1] });
      setPreviousOffsets(previousOffsets.slice(0, -1));
    }
    setNotice("");
  }
  function beginEdit(index: number, requestedColumn?: string) {
    if (!page || locked || readOnly) return;
    const row = editableRow(page, index);
    if (!row) return;
    const column = requestedColumn ?? row.fields[0].name;
    if (row.fields.some(field => field.name === column)) setEdit({ row, column });
  }
  const primaryKeys = new Set(metadata.filter(col => col.primaryKey).map(col => col.name));
  const allowEdit = !readOnly && primaryKeys.size > 0 && metadata.some(col => col.editable && !col.primaryKey);
  return <section className="db-table-browser" aria-label={"Table browser " + caption}>
    <header className="db-table-bar"><div className="db-table-name">
      <h3 title={caption}>{caption}</h3>
      {readOnly && <small>Read-only</small>}
    </div><div className="db-table-actions">
      <Button aria-pressed={columnsVisible} onClick={() => setColumnsVisible(!columnsVisible)}>Columns</Button>
      <IconButton label="Refresh table" disabled={locked} onClick={() => { setNotice(""); setRevision(n => n + 1); }}><RefreshCw size={14} /></IconButton>
      <Button disabled={locked || !page} onClick={() => setExportOpen(true)}><Download size={14} />Export CSV</Button>
    </div></header>
    {columnsVisible && <div className="db-column-info" aria-label="Column definitions">
      <table><thead><tr><th>Column</th><th>Type</th><th>Key</th></tr></thead><tbody>
        {metadata.map(col => <tr key={col.name}><td>{col.name}</td><td>{col.type || "—"}</td><td>{col.primaryKey ? "Primary key" : "—"}</td></tr>)}
      </tbody></table>
    </div>}
    <div className="db-table-bar db-table-tools">
      <Button variant={criteria.filterColumn ? "secondary" : "ghost"} aria-expanded={filterVisible}
        disabled={!metadata.length} onClick={() => setFilterVisible(!filterVisible)}><Filter size={13} />Filter</Button>
      {criteria.filterColumn && <small className="db-table-summary" title={criteria.filterValue}>{criteria.filterColumn} contains “{criteria.filterValue}”</small>}
      <label className="db-page-size">Rows per page
        <select value={criteria.limit} disabled={locked} onChange={e => changeCriteria({ ...criteria, limit: Number(e.target.value), offset: 0 })}>
          {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
    {filterVisible && <form className="db-table-filter" onSubmit={e => {
      e.preventDefault();
      if (!locked && selectedColumn) changeCriteria(filteredRequest(criteria, selectedColumn, filterValue));
    }}>
      <select aria-label="Filter column" disabled={locked} value={selectedColumn} onChange={e => setFilterColumn(e.target.value)}>
        {metadata.map(col => <option key={col.name}>{col.name}</option>)}
      </select>
      <input aria-label="Contains text" placeholder="Contains text…" disabled={locked}
        value={filterValue} onChange={e => setFilterValue(e.target.value)} />
      <Button type="submit" disabled={locked || !selectedColumn}>Apply</Button>
      {Boolean(filterValue || criteria.filterColumn) && <Button variant="ghost" disabled={locked} onClick={() => {
        setFilterValue("");
        changeCriteria(filteredRequest(criteria, "", ""));
      }}>Clear</Button>}
    </form>}
    <ErrorBox error={current?.error || ""} />
    {loading && <p role="status" className="db-note">Loading rows…</p>}
    {page && <div className="db-grid db-table-grid" tabIndex={0} aria-label="Table rows">
      <table><thead><tr>{allowEdit && <th scope="col"><span className="sr-only">Edit row</span></th>}
        {page.columns.map((column, i) => {
          const sorted = criteria.sortColumn === column;
          return <th scope="col" key={i} aria-sort={sorted ? (criteria.sortDirection === "asc" ? "ascending" : "descending") : undefined}>
            <button type="button" className="db-table-sort" title={"Sort by " + column} aria-label={"Sort by " + column}
              disabled={locked} onClick={() => changeCriteria(sortedRequest(criteria, column))}>
              {primaryKeys.has(column) && <KeyRound size={12} aria-label="Primary key" />}{column}
              {sorted && (criteria.sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            </button>
          </th>;
        })}
      </tr></thead><tbody>{page.rows.map((values, i) => {
        return <tr key={i}>{allowEdit && <td className="db-row-action">
          <button type="button" aria-label={"Edit row " + (criteria.offset + i + 1)} title="Edit a cell"
            disabled={locked || !page.editableRows[i]} onClick={() => beginEdit(i)}><Pencil size={13} /></button>
        </td>}{values.map((value, j) => <td key={j} onDoubleClick={() => beginEdit(i, page.columns[j])}>
          {value === null ? <em>NULL</em> : value}</td>)}</tr>;
      })}</tbody></table>
      {!page.rows.length && <p className="db-note">No rows on this page.</p>}
    </div>}
    <footer className="db-table-bar db-pager">
      <small aria-live="polite">{page && (page.rows.length ? `Rows ${criteria.offset + 1}–${criteria.offset + page.rows.length}` : "0 rows")}</small>
      <IconButton label="Previous page" disabled={locked || !previousOffsets.length} onClick={() => changePage(false)}><ChevronLeft size={16} /></IconButton>
      <IconButton label="Next page" disabled={locked || !page?.hasMore || !page.rows.length} onClick={() => changePage(true)}><ChevronRight size={16} /></IconButton>
    </footer>
    {notice && <p className="db-note" role="status">{notice}</p>}
    {edit && <EditCell id={id} object={object} row={edit.row} column={edit.column} target={[connectionLabel, caption].filter(Boolean).join(" · ")}
      disabled={disabled || readOnly} onClose={() => setEdit(undefined)} onSaved={() => {
        setEdit(undefined);
        setNotice("Cell updated.");
        setRevision(n => n + 1);
      }} />}
    {exportOpen && <ExportCsv id={id} object={object} criteria={criteria} caption={caption} disabled={disabled}
      onClose={() => setExportOpen(false)} onExported={count => {
        setExportOpen(false);
        setNotice(`Exported ${count} ${count === 1 ? "row" : "rows"} to CSV.`);
      }} />}
  </section>;
}

function EditCell({ id, object, row, column, target, disabled, onClose, onSaved }: {
  id: string; object: DbObject; row: EditRow; column: string; target: string; disabled: boolean; onClose(): void; onSaved(): void;
}) {
  const [selected, setSelected] = useState(column);
  const original = row.fields.find(field => field.name === selected)!.original;
  const [value, setValue] = useState(original ?? "");
  const [isNull, setNull] = useState(original === null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const proposed = isNull ? null : value;
  async function apply() {
    if (disabled || pending.current || proposed === original) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await request<{ affected: number }>("db_update_cell", {
        id, ...object, column: selected, key: row.key, oldValue: original, newValue: proposed,
      });
      if (result.affected !== 1) throw new Error("The row changed. Refresh the table before trying again.");
      onSaved();
    } catch (cause) { setError(message(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal open title="Edit cell" description={target} onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <div className="modal-body">
      <div className="db-key-values"><KeyRound size={13} />{Object.entries(row.key).map(([k,v]) => <code key={k}>{k} = {v}</code>)}</div>
      <Field label="Column"><select value={selected} disabled={busy} onChange={e => {
        const field = row.fields.find(item => item.name === e.target.value)!;
        setSelected(field.name); setValue(field.original ?? ""); setNull(field.original === null); setError("");
      }}>{row.fields.map(field => <option key={field.name}>{field.name}</option>)}</select></Field>
      <div className="db-edit-values">
        <Field label="Original value"><textarea readOnly value={original ?? "NULL"} /></Field>
        <Field label="New value"><textarea autoFocus disabled={busy || isNull || disabled} value={isNull ? "NULL" : value}
          onChange={e => { setValue(e.target.value); setError(""); }} /></Field>
      </div>
      <label className="db-null-check"><input type="checkbox" checked={isNull} disabled={busy || disabled}
        onChange={e => { setNull(e.target.checked); setError(""); }} />Set new value to NULL</label>
      <ErrorBox error={error} />
    </div>
    <footer className="modal-footer"><Button disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={disabled || proposed === original} onClick={() => void apply()}>Save change</Button></footer>
  </Modal>;
}

function ExportCsv({ id, object, criteria, caption, disabled, onClose, onExported }: {
  id: string; object: DbObject; criteria: TableRequest; caption: string; disabled: boolean; onClose(): void; onExported(count: number): void;
}) {
  const [scope, setScope] = useState<"all" | "page">("all");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const canExport = useRef(false);
  useEffect(() => { canExport.current = !disabled; return () => { canExport.current = false; }; }, [disabled]);
  const [error, setError] = useState("");
  async function exportRows() {
    if (pending.current || !canExport.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const path = await save({ defaultPath: csvFilename(object.name), filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path || !canExport.current) return;
      const result = await request<{ rows: number }>("db_export_csv", { id, ...object, ...criteria, path, scope });
      if (canExport.current) onExported(result.rows);
    } catch (cause) { setError(message(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal open title="Export CSV" description={caption} onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <div className="modal-body">
      <Field label="Rows to export"><select value={scope} disabled={busy} onChange={e => setScope(e.target.value === "page" ? "page" : "all")}>
        <option value="all">{criteria.filterColumn ? "All matching rows" : "All rows"}</option>
        <option value="page">Current page</option></select></Field>
      {criteria.filterColumn && <small>{criteria.filterColumn} contains “{criteria.filterValue}”</small>}
      <ErrorBox error={error} />
    </div>
    <footer className="modal-footer"><Button onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant="primary" disabled={disabled} busy={busy} onClick={() => void exportRows()}>Choose file…</Button></footer>
  </Modal>;
}
