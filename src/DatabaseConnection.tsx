import { useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, PlugZap } from "lucide-react";
import { Button, ErrorBox, Field, Modal } from "./ui";
import { message, type Session } from "./types";
import { cleanProfile, engines, newProfile, presetFor, presetGroups, presets, usesMongoSrv, validateProfile, type DatabaseProfile } from "./databaseProfiles";

interface Props {
  profile: DatabaseProfile;
  sessions: Session[];
  active: string;
  isNew: boolean;
  reconnect?: boolean;
  credentialsOnly?: boolean;
  initialError?: string;
  boundSessionId?: string;
  onSave: (profile: DatabaseProfile, password: string, sessionId: string) => Promise<void>;
  onConnect: (profile: DatabaseProfile, password: string, sessionId: string) => Promise<void>;
  onClose: () => void;
}
export function DatabaseConnection({ profile, sessions, active, isNew, reconnect = false, credentialsOnly, initialError, boundSessionId, onSave, onConnect, onClose }: Props) {
  const [draft, setDraft] = useState(profile);
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(profile.passwordMode === "saved");
  const live = sessions.filter(session => session.status === "connected" &&
    (!boundSessionId || session.id === boundSessionId) && (!reconnect || !profile.viaSsh || session.hostId === profile.sshHostId));
  const [sshId, setSshId] = useState(() => {
    const matching = live.filter(session => !profile.sshHostId || session.hostId === profile.sshHostId);
    return matching.find(session => session.id === active)?.id || matching[0]?.id || "";
  });
  const [error, setError] = useState(initialError || "");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const type = presetFor(draft);
  const atlas = type.id === "atlas-mongodb";
  const srv = usesMongoSrv(draft);
  const localFile = type.engine === "sqlite";
  const selectedSsh = live.find(session => session.id === sshId);
  function update<K extends keyof DatabaseProfile>(key: K, value: DatabaseProfile[K]) {
    const newTarget = ["host", "port", "username", "viaSsh", "sshHostId", "tls", "database", "authSource"].includes(key);
    if (newTarget) { setPassword(""); setRememberPassword(false); }
    setDraft(current => ({ ...current, ...(newTarget ? { passwordMode: undefined } : {}), ...(key === "viaSsh" && atlas ? { host: "" } : {}), [key]: value }));
    setError("");
  }
  function selectPreset(id: string) {
    const next = newProfile(presets.find(preset => preset.id === id)!, draft.id);
    setDraft({ ...next, name: draft.name, viaSsh: next.presetId !== "sqlite" && draft.viaSsh, sshHostId: draft.sshHostId, production: draft.production, readOnly: draft.readOnly });
    setPassword("");
    setRememberPassword(false);
    setError("");
  }
  async function submit(connect: boolean) {
    if (pending.current) return;
    const value = cleanProfile({ ...draft, sshHostId: selectedSsh?.hostId || draft.sshHostId });
    if (!value) return;
    const reason = validateProfile(value);
    if (reason) { setError(reason); return; }
    if (value.viaSsh && !selectedSsh && (!value.sshHostId || (!connect && rememberPassword && password))) {
      setError("Open an SSH terminal for the jump host, then select its session here.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!localFile) {
        if (rememberPassword && !password && draft.passwordMode !== "saved") throw new Error("Enter a password to save.");
        value.passwordMode = rememberPassword ? "saved" : password ? "prompt" :
          connect ? "none" : draft.passwordMode === "none" ? "none" : undefined;
      }
      if (connect) await onConnect(value, password, sshId);
      else await onSave(value, password, sshId);
      setPassword("");
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function browse() {
    try {
      const path = await open({ multiple: false, title: "Open SQLite database",
        filters: [{ name: "SQLite databases", extensions: ["db", "sqlite", "sqlite3", "db3"] }, { name: "All files", extensions: ["*"] }] });
      if (typeof path === "string") update("path", path);
    } catch (cause) { setError(message(cause)); }
  }
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(true);
  }
  return <Modal open onOpenChange={next => { if (!next) onClose(); }}
    title={reconnect ? "Reconnect to " + profile.name : credentialsOnly ? "Connect to " + profile.name : isNew ? "New database connection" : profile.name} description={credentialsOnly ? profile.username + (profile.username ? "@" : "") + profile.host + ":" + profile.port : reconnect ? "Your query drafts will stay open." : "Connection settings for this workspace."}>
    <form onSubmit={onSubmit}>
      <fieldset disabled={busy} className="modal-body db-form">
        {!credentialsOnly && <fieldset className="db-form db-target-fields" disabled={reconnect}>
        <Field label="Connection name">
          <input autoFocus required value={draft.name} placeholder="e.g. Reporting" onChange={e => update("name", e.target.value)} />
        </Field>
        <Field label="Database type">
          <select aria-label="Database type" value={draft.presetId} onChange={e => selectPreset(e.target.value)}>
            {presetGroups.map(group => <optgroup key={group} label={group}>
              {presets.filter(preset => preset.group === group).map(preset => <option key={preset.id} value={preset.id}>{preset.title}</option>)}
            </optgroup>)}
          </select>
        </Field>
        {localFile ? <div className="db-field-row">
          <Field label="Database file"><input value={draft.path} onChange={e => update("path", e.target.value)} placeholder="Path to a SQLite file" /></Field>
          <Button onClick={() => void browse()}><FolderOpen size={15} /> Browse</Button>
        </div> : <>
          <div className={srv ? "" : "db-field-pair db-port"}>
            <Field label={srv ? "Atlas cluster hostname" : atlas ? "Atlas member hostname" : "Host"}
              hint={srv ? "Use the hostname from the mongodb+srv address. DNS supplies the ports." : atlas ? "Use an individual member hostname from the standard connection string." : type.group === "Database" ? undefined : "Enter the service endpoint hostname."}>
              <input autoCapitalize="off" spellCheck={false} value={draft.host} onChange={e => update("host", e.target.value)} placeholder={srv ? "cluster.example.mongodb.net" : "db.example.com"} />
            </Field>
            {!srv && <Field label="Port"><input type="number" min="1" max="65535" value={draft.port || ""} onChange={e => update("port", Number(e.target.value))} /></Field>}
          </div>
          <div className={type.engine === "mongodb" ? "db-field-pair" : ""}>
            <Field label={type.engine === "oracle" ? "Service name" : type.engine === "redis" ? "Database index" : "Database"}>
              <input value={draft.database} autoCapitalize="off" spellCheck={false} onChange={e => update("database", e.target.value)} placeholder={engines[type.engine].database || undefined} />
            </Field>
            {type.engine === "mongodb" && <Field label="Authentication database">
              <input value={draft.authSource} placeholder="Same as database" onChange={e => update("authSource", e.target.value)} />
            </Field>}
          </div>
          <div className="db-field-pair">
            <Field label="Network route"><select aria-label="Network route" value={draft.viaSsh ? "ssh" : "direct"} onChange={e => update("viaSsh", e.target.value === "ssh")}>
              <option value="direct">Direct connection</option><option value="ssh">Via SSH session</option>
            </select></Field>
            <Field label="TLS"><select aria-label="TLS" value={draft.tls ? "verify" : "disable"} onChange={e => update("tls", e.target.value === "verify")}>
              <option value="verify">Verify server certificate</option><option value="disable" disabled={srv}>Off</option>
            </select></Field>
          </div>
        </>}
        <div className="db-field-pair">
          <Field label="Environment"><select aria-label="Environment" value={draft.production ? "production" : "standard"} onChange={e => {
            const production = e.target.value === "production";
            setDraft(current => ({ ...current, production, readOnly: production || current.readOnly }));
          }}><option value="standard">Standard</option><option value="production">Production</option></select></Field>
          <Field label="Access"><select aria-label="Access" value={draft.readOnly ? "read" : "write"} onChange={e => update("readOnly", e.target.value === "read")}>
            <option value="read">Read-only</option><option value="write">Read and write</option></select></Field>
        </div>
        </fieldset>}
        {!localFile && <>
          {!credentialsOnly && draft.viaSsh && <Field label="SSH session" hint="The jump host must be able to reach the database hostname and port.">
            <select aria-label="SSH session" value={selectedSsh?.id || ""} onChange={e => { setSshId(e.target.value); update("sshHostId", live.find(session => session.id === e.target.value)?.hostId || ""); }}>
              <option value="">{live.length ? "Choose a connected SSH session" : "No connected SSH sessions"}</option>
              {live.map(session => <option key={session.id} value={session.id}>{session.name}{session.id === active ? " (active)" : ""}</option>)}
            </select>
          </Field>}
          <div className={credentialsOnly ? undefined : "db-field-pair"}>
            {!credentialsOnly && <Field label="Username"><input disabled={reconnect} autoComplete="off" spellCheck={false} value={draft.username} onChange={e => update("username", e.target.value)} /></Field>}
            <Field label="Password"><input autoFocus={credentialsOnly} type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder={rememberPassword && draft.passwordMode === "saved" ? "Use saved password" : undefined} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={rememberPassword} onChange={e => setRememberPassword(e.target.checked)} /> Remember password in secure storage</label>
        </>}
        <ErrorBox error={error} />
      </fieldset>
      <footer className="modal-footer">
        <Button onClick={onClose}>Cancel</Button>
        {!credentialsOnly && !reconnect && <Button disabled={busy} onClick={() => void submit(false)}>Save profile</Button>}
        <Button type="submit" variant="primary" busy={busy}><PlugZap size={15} />{reconnect ? "Reconnect" : isNew ? "Save & connect" : "Connect"}</Button>
      </footer>
    </form>
  </Modal>;
}
