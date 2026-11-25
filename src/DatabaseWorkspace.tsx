import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Database, FolderTree, Pencil, Plus, RefreshCw, Search, Table2, Trash2, Unplug } from "lucide-react";
import { request } from "./api";
import { Button, Confirm, Empty, ErrorBox, IconButton, PageHeader } from "./ui";
import { message, uid, type Host, type Session } from "./types";
import { HostMark, sessionHostLabel } from "./HostIdentity";
import { DropdownMenu } from "radix-ui";
import { ConnectionCard, serverAddress } from "./ConnectionCard";
import { DatabaseConnection } from "./DatabaseConnection";
import { DatabaseQueryEditor, ResultGrid } from "./DatabaseQueryEditor";
import { DatabaseTableBrowser } from "./DatabaseTableBrowser";
import { bindHost, hostMatch, libraryKey, targetLabel, type DatabaseContext, type DatabaseFileRequest, type HostBinding } from "./databaseQueries";
import { usesMongoSrv, connectionArgs, engines, newProfile, presetFor, presets, readProfiles, saveProfiles, type DatabaseProfile, type DbGrid, type DbObject } from "./databaseProfiles";
import "./databases.css";
import { observeProfiles } from "./databaseProfiles";

interface Connection {
  slot: string; id: string; profile: DatabaseProfile; readOnly: boolean; sshId?: string; sshRouteToken?: string; route: string; source?: HostBinding;
}
interface FormState { profile: DatabaseProfile; source?: DatabaseContext; previous?: Connection; credentialsOnly?: boolean; error?: string }
interface Props {
  hosts?: Host[];
  workspace: string; sessions: Session[]; active: string; notify: (text: string, error?: boolean) => void;
  openRequest?: {id:string; profile:string} | null; onOpenConsumed?: (id:string) => void;
  context?: DatabaseContext; fileRequest?: DatabaseFileRequest | null; onFileConsumed?: (id: string) => void;
  onConnectSsh?: (hostId: string, signal: AbortSignal, replacementId?: string) => Promise<Session>;
  onDirtyChange?: (dirty: boolean) => void;
}
function linkKey(workspace: string, hostId: string) { return "vexssh.db.link.v1." + JSON.stringify([workspace, hostId]); }
export default function DatabaseWorkspace({ workspace, sessions, hosts = [], active, notify, context, openRequest, onOpenConsumed, fileRequest, onFileConsumed, onConnectSsh, onDirtyChange }: Props) {
  const [profiles, setProfiles] = useState(() => readProfiles(workspace));
  useEffect(() => observeProfiles(workspace, () => setProfiles(readProfiles(workspace))), [workspace]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [globalSlot, select] = useState("");
  const [tabProfiles, setTabProfiles] = useState<Record<string,string>>({});
  const [dirtySlots, setDirtySlots] = useState<ReadonlySet<string>>(() => new Set());
  const [discardConnection, setDiscardConnection] = useState<Connection | null>(null);
  const [form, edit] = useState<FormState | null>(null);
  const [removing, remove] = useState<DatabaseProfile | null>(null);
  const [closing, setClosing] = useState("");
  const pending = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState("");
  const handles = useRef(new Set<string>());
  const present = useRef(true);
  const binding = context && bindHost(context, sessions);
  const sessionHost = context && hosts.find(host => host.id === context.hostId);
  const sourceMatches = (c: Connection) => !binding || hostMatch(c.source, binding);
  const scoped = connections.filter(sourceMatches);
  const linkedId = binding && (tabProfiles[binding.tabId || binding.sessionId] ?? localStorage.getItem(linkKey(workspace, binding.hostId)));
  const selected = context ? scoped.find(c => c.profile.id === linkedId)?.slot : (connections.find(c => c.slot === globalSlot) || connections[0])?.slot;
  const incoming = context && fileRequest?.sessionId === context.sessionId && fileRequest.hostId === context.hostId ? fileRequest : undefined;
  const eligible = (profile: DatabaseProfile) => !context || !profile.viaSsh || profile.sshHostId === context.hostId;
  const choices = profiles.filter(eligible);
  const markDirty = useCallback((slot: string, dirty: boolean) => {
    setDirtySlots(previous => {
      if (previous.has(slot) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(slot); else next.delete(slot);
      return next;
    });
  }, []);
  const hasUnsavedQueries = dirtySlots.size > 0;
  useEffect(() => { onDirtyChange?.(hasUnsavedQueries); }, [onDirtyChange, hasUnsavedQueries]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    present.current = true;
    return () => {
      present.current = false;
      pending.current?.abort();
      for (const id of handles.current) void request("db_disconnect", { id }).catch(() => {});
      handles.current.clear();
    };
  }, []);
  function remember(profile: DatabaseProfile, source?: DatabaseContext, available = sessions) {
    if (!source) return;
    localStorage.setItem(linkKey(workspace, source.hostId), profile.id);
    const tab = bindHost(source, available);
    setTabProfiles(current => ({ ...current, [tab.tabId || tab.sessionId]: profile.id }));
  }
  function save(profile: DatabaseProfile) {
    // Read from disk again so another completed connection cannot be overwritten by a pending form.
    const stored = readProfiles(workspace);
    const list = stored.some(p => p.id === profile.id) ? stored.map(p => p.id === profile.id ? profile : p) : [...stored, profile];
    saveProfiles(workspace, list); setProfiles(list);
  }
  const identity = (profile: DatabaseProfile) => ({ workspaceId: workspace, profileId: profile.id, sshHostId: profile.sshHostId });
  async function connect(target: FormState, password = "", chosenSsh = "", quick = false) {
    if (pending.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const { profile, previous } = target;
    let source = target.source;
    let route: Session | undefined;
    let attemptId: string | undefined;
    const cancelNative = () => {
      if (attemptId) void request("db_cancel_connect", { id: attemptId }).catch(() => {});
    };
    pending.current = controller;
    setOpening(profile.name);
    signal.addEventListener("abort", cancelNative);
    try {
      if (profile.viaSsh) {
        if (!profile.sshHostId || (source && source.hostId !== profile.sshHostId))
          throw new Error("Choose the saved SSH host for this database.");
        const exactId = source?.sessionId || chosenSsh;
        if (source && chosenSsh && source.sessionId !== chosenSsh) throw new Error("Choose the SSH session for this tab.");
        const candidates = sessions.filter(s => s.hostId === profile.sshHostId && s.status === "connected");
        route = exactId ? candidates.find(s => s.id === exactId) : candidates.find(s => s.id === active) || candidates[0];
        if (!route && onConnectSsh) route = await onConnectSsh(profile.sshHostId, signal, exactId || undefined);
        signal.throwIfAborted();
        if (!route || route.hostId !== profile.sshHostId || route.status !== "connected") throw new Error("Reconnect the saved SSH host first.");
        if (previous?.sshRouteToken && previous.sshRouteToken !== route.routeToken)
          throw new Error("The verified SSH route changed. Open a new database connection for this route.");
        if (source) source = { sessionId: route.id, hostId: route.hostId, name: route.name };
      }
      if (quick && profile.passwordMode === "prompt") {
        edit({ ...target, source, credentialsOnly: true });
        return;
      }
      attemptId = (await request<{ id: string }>("db_prepare_connect", {})).id;
      if (signal.aborted) { cancelNative(); signal.throwIfAborted(); }
      const args = { ...connectionArgs(profile, password, route?.id || ""), ...identity(profile), attemptId,
        useSavedPassword: profile.passwordMode === "saved" && !password,
        rememberPassword: profile.passwordMode === "saved" && !!password,
        forgetPassword: !quick && profile.passwordMode !== "saved" };
      const { id, readOnly } = await request<{ id: string; readOnly: boolean }>("db_connect", args);
      if (signal.aborted || !present.current) { await request("db_disconnect", { id }); signal.throwIfAborted(); return; }
      const available = route ? [route, ...sessions] : sessions;
      try { save(profile); remember(profile, source, available); }
      catch (error) { await request("db_disconnect", { id }); throw error; }
      const next: Connection = { slot: previous?.slot || uid(), id, profile, readOnly: readOnly ?? profile.readOnly, sshId: route?.id,
        route: route ? "SSH · " + route.name : "Direct", sshRouteToken: route?.routeToken,
        source: source ? bindHost(source, available) : previous?.source };
      handles.current.add(id);
      setConnections(items => previous ? items.map(c => c.slot === previous.slot ? next : c) : [...items,next]);
      select(next.slot);
      if (previous) void request("db_disconnect", { id: previous.id }).then(() => handles.current.delete(previous.id)).catch(() => {});
    } catch (error) {
      if (signal.aborted) throw new Error("Database connection cancelled.");
      const detail = message(error);
      if (quick && presetFor(profile).engine !== "sqlite" && /password|authentication|access denied|login failed|noauth|wrongpass|ora-01017|sasl|needs auth|not authorized/i.test(detail)) {
        edit({ ...target, source, credentialsOnly: true, error: detail });
      } else throw error;
    } finally {
      signal.removeEventListener("abort", cancelNative);
      if (pending.current === controller) { pending.current = null; if (present.current) setOpening(""); }
    }
  }
  function openProfile(profile: DatabaseProfile, previous?: Connection) {
    const opened = scoped.find(c => c.profile.id === profile.id);
    if (!previous && opened) { remember(profile, context); select(opened.slot); return; }
    void connect({ profile, source: context, previous }, "", "", true).catch(error => {
      if (message(error) !== "Database connection cancelled." && present.current) notify(message(error), true);
    });
  }
  const consumedRequest = useRef("");
  useEffect(() => {
    if (!openRequest || context || consumedRequest.current === openRequest.id || opening) return;
    consumedRequest.current = openRequest.id;
    onOpenConsumed?.(openRequest.id);
    const profile = readProfiles(workspace).find(p => p.id === openRequest.profile);
    if (profile) openProfile(profile);
    else notify("This database connection was removed.", true);
  }, [openRequest, context, opening, workspace, onOpenConsumed]);
  async function disconnect(c: Connection) {
    setClosing(c.slot);
    try {
      await request("db_disconnect", { id: c.id });
      handles.current.delete(c.id);
      markDirty(c.slot, false);
      setConnections(items => items.filter(item => item.slot !== c.slot));
      select(prev => prev === c.slot ? connections.find(item => item.slot !== c.slot)?.slot || "" : prev);
    } catch (cause) { notify(message(cause), true); } finally { setClosing(""); }
  }
  function startNew() {
    const profile = newProfile(presets[0], uid());
    if (context) { profile.viaSsh = true; profile.sshHostId = context.hostId; }
    edit({ profile, source: context });
  }
  // When the host tab changes, a modal opened on the previous tab must not connect its credentials to the new tab.
  const formVisible = form && (!form.source || form.source.sessionId === context?.sessionId || (form.previous && !context));
  return <section className="page db-page">
    <PageHeader title={context ? <span className="db-host-heading">{sessionHost && <HostMark host={sessionHost}/>}
      <span>Database · {sessionHostLabel(context.name, sessionHost)}</span></span> : "Databases"}>
      <Button variant="primary" disabled={!!opening} onClick={startNew}><Plus size={16} /> New connection</Button>
    </PageHeader>
    {opening && !form && <div className="db-file-banner" role="status">Connecting to {opening}… <Button onClick={() => pending.current?.abort()}>Cancel</Button></div>}
    {incoming && <p className="db-file-banner" role="status">Choose a SQL connection for <strong>{incoming.name}</strong>.
      <Button onClick={() => onFileConsumed?.(incoming.id)}>Dismiss</Button></p>}
    <div className={"db-layout" + (!selected ? " db-picking" : "")}>
      <section className="db-profiles" aria-label="Saved database connections">
        {!!selected && <h2><Database size={16} /> Connections <small>{choices.length}</small></h2>}
        {!choices.length && <Empty icon={<Database size={26}/>} title="No saved connections"
          description={context ? "Create a connection for this host or open a local SQLite file." : "Choose New connection to open a database."} />}
        <div className={selected ? "db-compact-cards" : "connections-grid"}>{choices.flatMap(profile => {
          const opened = scoped.filter(c => c.profile.id === profile.id);
          const preset = presetFor(profile);
          const tunnelHost = profile.viaSsh && hosts.find(host => host.id === profile.sshHostId);
          const address = preset.engine === "sqlite" ? profile.path : serverAddress(profile.username, profile.host, usesMongoSrv(profile) ? undefined : profile.port);
          const editable = !connections.some(item => item.profile.id === profile.id);
          return (opened.length ? opened : [undefined]).map(c => {
            const live = c && (!c.sshId || sessions.some(s => s.id === c.sshId && s.status === "connected"));
            return <ConnectionCard key={c?.slot || profile.id} name={profile.name} address={address} icon={<Database size={18}/>}
              label={c ? "Switch to " + profile.name + (opened.length > 1 ? " via " + c.route : "") : "Connect to " + profile.name}
              active={!!c && c.slot === selected} disabled={!c && !!opening}
              method={preset.title} status={live ? "Connected" : undefined}
              details={<>{profile.viaSsh && <span className="db-tunnel-host">{tunnelHost && <HostMark host={tunnelHost} size={14}/>}
                {tunnelHost ? "SSH tunnel · " + tunnelHost.name : "SSH tunnel"}</span>}{(c?.readOnly ?? profile.readOnly) && <span>Read only</span>}
                {profile.production && <span className="environment-badge env-production">Production</span>}
                {opened.length > 1 && <span>{c?.route}</span>}{c && !live && <span>SSH disconnected</span>}</>}
              onOpen={() => { if (c) { remember(profile, context); select(c.slot); } else openProfile(profile); }}
              actions={editable && <>
                <DropdownMenu.Item disabled={!!opening} onSelect={() => edit({ profile, source: context })}><Pencil size={14}/>Edit connection</DropdownMenu.Item>
                <DropdownMenu.Item disabled={!!opening} className="danger-text" onSelect={() => remove(profile)}><Trash2 size={14}/>Delete connection</DropdownMenu.Item>
              </>} />;
          });
        })}</div>
      </section>
      {connections.map(c => {
        const live = !c.sshId || sessions.some(s => s.id === c.sshId && s.status === "connected");
        const file = selected === c.slot && incoming && !["redis","mongodb"].includes(presetFor(c.profile).engine) ? incoming : undefined;
        return <DatabaseSession key={c.slot} workspace={workspace} connection={c} visible={c.slot === selected} routeLost={!live}
          closing={closing === c.slot} file={file} onFileConsumed={onFileConsumed} onDirtyChange={markDirty}
          onDisconnect={() => dirtySlots.has(c.slot) ? setDiscardConnection(c) : void disconnect(c)}
          onReconnect={() => openProfile(c.profile, c)} />;
      })}
    </div>
    {formVisible && <DatabaseConnection key={form.profile.id + (form.previous?.slot || "") + (form.source?.sessionId || "")} profile={form.profile}
      reconnect={!!form.previous} boundSessionId={form.source?.sessionId} isNew={!profiles.some(p => p.id === form.profile.id)} sessions={sessions} active={active}
      credentialsOnly={form.credentialsOnly} initialError={form.error}
      onClose={() => { pending.current?.abort(); edit(null); }} onSave={async (profile, password, sshId) => {
        if (profile.passwordMode === "saved" && password) {
          await request("db_password_save", { ...connectionArgs(profile, password, sshId), ...identity(profile) });
        } else if (profile.passwordMode !== "saved" && form.profile.passwordMode === "saved") {
          await request("db_password_forget", identity(profile));
        }
        save(profile); remember(profile, form.source);
      }} onConnect={(profile, password, sshId) => connect({ ...form, profile }, password, sshId)}/>}
    <Confirm open={!!discardConnection} title="Disconnect database?" confirmLabel="Discard and disconnect" danger
      description={"Unsaved query edits in " + (discardConnection?.profile.name || "this connection") + " will be discarded."}
      onClose={() => setDiscardConnection(null)} onConfirm={async () => {
        if (discardConnection) await disconnect(discardConnection);
        setDiscardConnection(null);
      }}/>
    <Confirm open={!!removing} title="Delete database profile?" description={removing?.name + " and its named queries will be removed."} confirmLabel="Delete profile" danger
      onClose={() => remove(null)} onConfirm={async () => {
        if (!removing) return;
        await request("db_password_forget", identity(removing));
        const list = readProfiles(workspace).filter(p => p.id !== removing.id);
        saveProfiles(workspace,list); setProfiles(list); localStorage.removeItem(libraryKey(workspace,removing.id));
      }}/>
  </section>;
}
interface SessionProps {
  workspace: string; connection: Connection; visible: boolean; routeLost: boolean; closing: boolean;
  file?: DatabaseFileRequest; onFileConsumed?: (id:string)=>void; onDisconnect:()=>void; onReconnect:()=>void;
  onDirtyChange: (slot: string, dirty: boolean) => void;
}
function DatabaseSession({ workspace, connection:c, visible, routeLost, closing, file, onFileConsumed, onDisconnect, onReconnect, onDirtyChange }: SessionProps) {
  const { profile, id, readOnly } = c;
  const { engine } = presetFor(profile);
  const relational = engine !== "mongodb" && engine !== "redis";
  const target = targetLabel(profile,engine);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [objectError, setObjectError] = useState("");
  const [fetching, setFetching] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const [filter,setFilter] = useState("");
  const [table, setTable] = useState<DbObject | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const reportDirty = useCallback((dirty: boolean) => onDirtyChange(c.slot, dirty), [onDirtyChange, c.slot]);
  const unavailable = closing || routeLost;
  useEffect(() => { setTable(null); setShowTable(false); }, [id]);
  useEffect(() => { if (file) setShowTable(false); }, [file]);
  useEffect(() => {
    let current = true;
    if (routeLost) return;
    setFetching(true); setObjectError("");
    void request<DbObject[]>("db_objects",{id}).then(list => { if (current) setObjects(list); })
      .catch(e => { if(current) setObjectError(message(e)); }).finally(() => { if(current) setFetching(false); });
    return () => { current = false; };
  }, [id,refresh,routeLost]);
  const groups = new Map<string,DbObject[]>();
  for (const o of objects) {
    if (!(o.schema + "." + o.name).toLowerCase().includes(filter.toLowerCase())) continue;
    const list = groups.get(o.schema);
    if (list) list.push(o); else groups.set(o.schema,[o]);
  }
  return <div className="db-session" hidden={!visible}>
    <aside className="db-objects" aria-label={"Objects for " + profile.name}>
      <header><h2><FolderTree size={16}/> Objects</h2>
        <IconButton label="Refresh objects" disabled={fetching || unavailable || busy} onClick={() => setRefresh(x => x+1)}><RefreshCw size={14}/></IconButton></header>
      <label className="db-search"><Search size={14}/><input type="search" aria-label="Filter database objects" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter objects…"/></label>
      <ErrorBox error={objectError}/>
      {fetching ? <p className="db-note" role="status">Loading objects…</p> : !groups.size && !objectError && <p className="db-note">{filter ? "No matching objects." : "No objects found."}</p>}
      <div className="db-tree">{[...groups].map(([schema,items]) => <details key={schema} open><summary><ChevronRight size={13}/>{schema || profile.database || engines[engine].name}<small>{items.length}</small></summary>
        {items.map(o => <button key={JSON.stringify([o.kind,o.name])} type="button" title={"Preview " + o.kind + " " + o.name} disabled={unavailable || busy}
          onClick={() => { setTable(o); setShowTable(true); }}><Table2 size={14}/><span>{o.name}</span><small>{o.kind}</small></button>)}</details>)}</div>
    </aside>
    <section className="db-workbench" aria-label={"Database session " + profile.name}>
      <header className="db-session-header"><div><h2><span className={"status-dot" + (routeLost ? "" : " online")}/>{profile.name}
        {profile.production && <small className="db-prod">Production</small>}{readOnly && <small>Read-only</small>}</h2>
        <small title={target}>{engines[engine].name} · {target}{engine !== "sqlite" && " · " + c.route}</small></div>
        <div className="toolbar">
          <IconButton label="Reconnect database" disabled={closing || (busy && !routeLost)} onClick={onReconnect}><RefreshCw size={15}/></IconButton>
          <IconButton label="Disconnect database" disabled={busy || closing} onClick={onDisconnect}><Unplug size={16}/></IconButton>
        </div></header>
      {routeLost && <div className="db-file-banner" role="status">SSH disconnected. Reconnect the SSH session, then reconnect this database to use your drafts.<Button onClick={onReconnect}>Reconnect</Button></div>}
      {table && <div className="db-workbench-mode"><Button aria-pressed={!showTable} onClick={() => setShowTable(false)}>Query editor</Button>
        <Button aria-pressed={showTable} onClick={() => setShowTable(true)}><Table2 size={14}/>{table.name}</Button></div>}
      <DatabaseQueryEditor workspace={workspace} profileId={profile.id} nativeId={id} engine={engine} target={profile.name + " · " + target}
        shown={!showTable} enabled={!unavailable} file={file} onFileConsumed={onFileConsumed} onRunning={setBusy} onDirtyChange={reportDirty}/>
      {table && showTable && (relational
        ? <DatabaseTableBrowser key={JSON.stringify([id, table.schema, table.name, table.kind])} id={id} object={table} readOnly={readOnly} disabled={unavailable} connectionLabel={profile.name + " · " + target}/>
        : <ObjectPreview key={JSON.stringify([id,table.schema,table.name])} id={id} object={table} disabled={unavailable}/>)}
    </section>
  </div>;
}
function ObjectPreview({id,object,disabled}:{id:string;object:DbObject;disabled:boolean}){
  const [grid,setGrid]=useState<DbGrid | null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    let current=true;
    if (disabled) return;
    void request<DbGrid>("db_preview",{id,...object}).then(data=>{if(current) setGrid(data);}).catch(e=>{if(current) setError(message(e));});
    return ()=>{current=false;};
  },[id,object,disabled]);
  return <section className="db-results"><ErrorBox error={error}/>{grid ? <ResultGrid grid={grid}/> : !error && !disabled && <p className="db-note" role="status">Loading…</p>}</section>;
}
