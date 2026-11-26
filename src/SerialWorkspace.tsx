import { useEffect, useRef, useState } from "react";
import { Cable, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { ConnectionCard } from "./ConnectionCard";
import {
  Button,
  Confirm,
  ErrorBox,
  Field,
  IconButton,
  Modal,
  PageHeader,
} from "./ui";
import { message, type Config } from "./types";
import {
  newSerialProfile,
  serialFraming,
  validSerialProfile,
  type SerialProfile,
} from "./serialProfile";
import SerialConsole from "./SerialConsole";
import { serialPortLabel, suggestedPort, useSerialPorts } from "./useSerialPorts";
import "./serial.css";

interface Props {
  visible: boolean;
  workspace: string;
  config: Config;
  save: (config: Config) => Promise<void>;
  appearance: Config["settings"]["terminalTheme"];
}
type Session = { id: string; profile: SerialProfile };
const baudRates = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export default function SerialWorkspace({
  visible,
  workspace,
  config,
  save,
  appearance,
}: Props) {
  const profiles = (
    Array.isArray(config.serialProfiles) ? config.serialProfiles : []
  ).filter(validSerialProfile);
  const saved = profiles.filter((p) => p.workspaceId === workspace);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeByWorkspace, setActiveByWorkspace] = useState<Record<string, string>>({});
  function selectSession(id: string) {
    setActiveByWorkspace((previous) => ({ ...previous, [workspace]: id }));
  }
  const [draft, setDraft] = useState<SerialProfile | null>(null);
  const [manualPort, setManualPort] = useState(false);
  const [customBaud, setCustomBaud] = useState(false);
  const [remove, setRemove] = useState<SerialProfile | null>(null);
  const { snapshot, listing, error: portError, refresh } = useSerialPorts(visible);
  const { ports, added } = snapshot;
  const autoSelect = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const localSessions = sessions.filter(
    (s) => s.profile.workspaceId === workspace,
  );
  const shown =
    localSessions.find((s) => s.id === activeByWorkspace[workspace]) || localSessions.at(-1);
  const editing = !!draft && profiles.some((p) => p.id === draft.id);

  useEffect(() => {
    if (portError || !autoSelect.current) return;
    setDraft(current => {
      if (!current) return null;
      const port = suggestedPort(current.port, snapshot);
      return port === current.port ? current : { ...current, port };
    });
  }, [snapshot, portError]);
  function edit(profile: SerialProfile) {
    setError("");
    setManualPort(false);
    setCustomBaud(!baudRates.includes(profile.baud));
    autoSelect.current = !profile.port;
    setDraft({ ...profile, port: profile.port || (portError ? "" : suggestedPort("", snapshot)) });
  }
  function connect(profile: SerialProfile) {
    if (!profile.port.trim()) {
      edit(profile);
      return;
    }
    const id = crypto.randomUUID();
    const port = profile.port.trim().replace(/^com(\d+)$/i, "COM$1");
    setSessions((items) => [...items, { id, profile: { ...profile, port } }]);
    selectSession(id);
    setDraft(null);
  }
  function change<K extends keyof SerialProfile>(
    field: K,
    value: SerialProfile[K],
  ) {
    setDraft((p) => (p ? { ...p, [field]: value } : p));
    setError("");
  }
  async function submit(intent: "save" | "connect") {
    if (!draft || saving) return;
    if (manualPort && !draft.port.trim()) {
      setError("Enter a port name.");
      return;
    }
    if (!validSerialProfile(draft)) {
      setError(
        "Use a baud rate between 50 and 4000000 and valid framing settings.",
      );
      return;
    }
    const clean = {
      ...draft,
      name: draft.name.trim(),
      port: draft.port.trim().replace(/^com(\d+)$/i, "COM$1"),
    };
    if (intent === "connect") {
      if (!clean.port) {
        setError("Select a serial port or enter its name.");
        return;
      }
      connect(clean);
      return;
    }
    if (!clean.name) {
      setError("Enter a name for the saved profile.");
      return;
    }
    setSaving(true);
    try {
      await save({
        ...config,
        serialProfiles: [...profiles.filter((p) => p.id !== clean.id), clean],
      });
      setDraft(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  const pickedPort = ports.find(p => p.name === draft?.port);
  const portStatus = pickedPort?.inUse ? "This port is open in VEXSSH. Disconnect its session to use it here."
    : (!portError && !listing && draft?.port && !pickedPort && !manualPort) ? "This port is not currently detected. Reconnect the device or choose another port."
    : !portError && added.size > 1 ? "Multiple ports were just connected. Choose the one for your device."
    : !portError && pickedPort && added.has(pickedPort.name) ? `${pickedPort.name} was just connected.`
    : !portError && !listing && ports.length === 0 ? "No serial ports detected. Plug in the device or enter a port manually."
    : "";
  return (
    <div
      hidden={!visible}
      className={"page serial-page" + (shown ? " has-session" : "")}
    >
      <PageHeader
        title="Serial console"
        description={
          shown ? undefined : "Connect to a device through a local serial port."
        }
      >
        <Button
          variant="primary"
          onClick={() => edit(newSerialProfile(workspace))}
        >
          <Plus size={16} />
          New serial session
        </Button>
      </PageHeader>
      {saved.length > 0 && (
        <details
          className="serial-profiles"
          open={shown ? undefined : true}
          key={shown ? "sessions" : "profiles"}
        >
          <summary>Saved profiles ({saved.length})</summary>
          <div className="serial-card-grid">
            {saved.map((p) => (
              <ConnectionCard
                key={p.id}
                name={p.name}
                address={p.port || "Choose port at connect"}
                icon={<Cable size={20} />}
                method={p.baud + " bps · " + serialFraming(p)}
                onOpen={() => connect(p)}
                actions={
                  <>
                    <DropdownMenu.Item onSelect={() => edit(p)}>
                      <Pencil size={14} />
                      Edit profile
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => setRemove(p)}>
                      <Trash2 size={14} />
                      Delete profile
                    </DropdownMenu.Item>
                  </>
                }
              />
            ))}
          </div>
        </details>
      )}
      <details className="serial-devices" key={shown ? "compact-devices" : "detected-devices"} open={shown ? undefined : true}>
        <summary>Detected ports ({ports.length})</summary>
        <div className="serial-devices-body">
          {portError ? <ErrorBox error={portError} />
            : ports.length === 0 && <p>{listing ? "Checking serial ports…" : "Plug in a serial device to see its port here."}</p>}
          {ports.map(p => (
            <button key={p.name} type="button" className="serial-device" disabled={p.inUse || !!portError}
              onClick={() => edit({ ...newSerialProfile(workspace), port: p.name })}>
              <Cable size={15} aria-hidden="true" />
              <span>{serialPortLabel(p)}</span>
              <small className={added.has(p.name) ? "serial-new" : undefined}>
                {p.inUse ? "Open in VEXSSH" : added.has(p.name) ? "Just connected" : "Detected"}
              </small>
            </button>
          ))}
          {portError && <Button onClick={refresh} disabled={listing}>Refresh ports</Button>}
        </div>
      </details>
      {localSessions.length > 0 && (
        <div className="serial-session-list" aria-label="Serial sessions">
          {localSessions.map((s) => (
            <div key={s.id} className={s.id === shown?.id ? "selected" : ""}>
              <Button
                variant="ghost"
                aria-pressed={s.id === shown?.id}
                onClick={() => selectSession(s.id)}
              >
                <Cable size={14} />
                {s.profile.name || s.profile.port}
              </Button>
              <IconButton
                label={
                  "Close serial session " + (s.profile.name || s.profile.port)
                }
                onClick={() =>
                  setSessions((items) =>
                    items.filter((item) => item.id !== s.id),
                  )
                }
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {sessions.map((s) => (
        <SerialConsole
          key={s.id}
          profile={s.profile}
          visible={visible && shown?.id === s.id}
          settings={config.settings}
          appearance={appearance}
        />
      ))}
      {draft && (
        <Modal
          open
          title={editing ? "Serial profile" : "New serial session"}
          description="Use the port and speed specified by your device."
          onOpenChange={(v) => {
            if (!v && !saving) setDraft(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit("connect");
            }}
          >
            <div className="modal-body serial-form">
              <Field label="Profile name">
                <input
                  maxLength={100}
                  value={draft.name}
                  placeholder="e.g. Lab switch"
                  onChange={(e) => change("name", e.target.value)}
                />
              </Field>
              <div className="serial-port">
                <Field label="Serial port">
                  <select aria-label="Serial port" aria-busy={listing}
                    value={manualPort ? "manual" : draft.port ? "port:" + draft.port : ""}
                    onChange={event => {
                      const value = event.target.value;
                      autoSelect.current = false;
                      setManualPort(value === "manual");
                      if (value === "manual") setError("");
                      else change("port", value.slice("port:".length));
                    }}>
                    <option value="">Choose at connect</option>
                    {draft.port && !pickedPort && !manualPort && (
                      <option value={"port:" + draft.port}>{draft.port}{listing ? "" : " (not listed)"}</option>
                    )}
                    {ports.map(port => <option key={port.name} value={"port:" + port.name} disabled={port.inUse}>
                      {serialPortLabel(port)}{port.inUse ? " (open in VEXSSH)" : added.has(port.name) ? " (just connected)" : ""}
                    </option>)}
                    <option value="manual">Enter manually…</option>
                  </select>
                </Field>
                <IconButton label="Refresh serial ports" disabled={listing} type="button" onClick={refresh}>
                  <RefreshCw size={15} />
                </IconButton>
              </div>
              {portStatus && <p className="field-note serial-port-status" role="status">{portStatus}</p>}
              {manualPort && <Field label="Port name">
                <input maxLength={128} value={draft.port} placeholder="COM7" spellCheck={false}
                  onChange={event => change("port", event.target.value)}/>
              </Field>}
              <div className={customBaud ? "serial-form-row" : undefined}>
                <Field label="Speed (bps)">
                  <select aria-label="Speed (bps)" value={customBaud ? "custom" : String(draft.baud)}
                    onChange={event => {
                      const value = event.target.value;
                      setCustomBaud(value === "custom");
                      if (value === "custom") setError("");
                      else change("baud", Number(value));
                    }}>
                    {baudRates.map(rate => <option key={rate} value={rate}>{rate}</option>)}
                    <option value="custom">Custom…</option>
                  </select>
                </Field>
                {customBaud && <Field label="Custom speed (bps)">
                  <input type="number" min={50} max={4000000} required value={draft.baud || ""}
                    onChange={event => change("baud", Number(event.target.value))}/>
                </Field>}
              </div>
              <ErrorBox error={portError} />
              <details>
                <summary>Advanced serial settings</summary>
                <div className="serial-form-row">
                  <Field label="Data bits">
                    <select
                      value={draft.dataBits}
                      onChange={(e) =>
                        change("dataBits", Number(e.target.value))
                      }
                    >
                      {[5, 6, 7, 8].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Parity">
                    <select
                      value={draft.parity}
                      onChange={(e) =>
                        change(
                          "parity",
                          e.target.value as SerialProfile["parity"],
                        )
                      }
                    >
                      <option value="none">None</option>
                      <option value="even">Even</option>
                      <option value="odd">Odd</option>
                    </select>
                  </Field>
                  <Field label="Stop bits">
                    <select
                      value={draft.stopBits}
                      onChange={(e) =>
                        change("stopBits", Number(e.target.value))
                      }
                    >
                      <option>1</option>
                      <option>2</option>
                    </select>
                  </Field>
                  <Field label="Flow control">
                    <select
                      value={draft.flow}
                      onChange={(e) =>
                        change("flow", e.target.value as SerialProfile["flow"])
                      }
                    >
                      <option value="none">None</option>
                      <option value="hardware">Hardware (RTS/CTS)</option>
                      <option value="software">Software (XON/XOFF)</option>
                    </select>
                  </Field>
                </div>
              </details>
              <details>
                <summary>Terminal settings</summary>
                <Field label="Enter sends">
                  <select
                    value={draft.enter}
                    onChange={(e) =>
                      change("enter", e.target.value as SerialProfile["enter"])
                    }
                  >
                    <option value="cr">CR</option>
                    <option value="lf">LF</option>
                    <option value="crlf">CR + LF</option>
                  </select>
                </Field>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={draft.localEcho}
                    onChange={(e) => change("localEcho", e.target.checked)}
                  />
                  Local echo
                </label>
              </details>
              <ErrorBox error={error} />
            </div>
            <footer className="modal-footer">
              <Button
                type="button"
                disabled={saving}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                busy={saving}
                onClick={() => void submit("save")}
              >
                Save profile
              </Button>
              <Button type="submit" disabled={saving || pickedPort?.inUse} variant="primary">
                <Cable size={15} />
                Connect
              </Button>
            </footer>
          </form>
        </Modal>
      )}
      <Confirm
        open={!!remove}
        title="Delete serial profile?"
        description={remove?.name || ""}
        danger
        confirmLabel="Delete profile"
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          await save({
            ...config,
            serialProfiles: profiles.filter((p) => p.id !== remove?.id),
          });
        }}
      />
    </div>
  );
}
