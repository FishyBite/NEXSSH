import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Pause,
  Play,
  RefreshCw,
  Plus,
  Network,
  Square,
  Pencil,
  ArrowRight,
  Cpu,
  MemoryStick,
  HardDrive,
  Download,
  Upload,
} from "lucide-react";
import type { Session, Metrics } from "./types";
import { formatBytes, message } from "./types";
import { request } from "./api";
import {
  Button,
  IconButton,
  Field,
  Modal,
  Empty,
  ErrorBox,
  PageHeader,
} from "./ui";
export function Monitoring({ session }: { session?: Session }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [history, setHistory] = useState<Metrics[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [interval, setIntervalValue] = useState(5);
  const inflight = useRef<{ id: string } | null>(null);
  const current = useRef(session?.id);
  current.current = session?.id;
  const refresh = async () => {
    if (!session || inflight.current?.id === session.id) return;
    const id = session.id;
    const reading = { id };
    inflight.current = reading;
    setBusy(true);
    try {
      const value = await request<Metrics>("monitor", { sessionId: id });
      if (current.current !== id || inflight.current !== reading) return;
      setMetrics(value);
      setHistory((p) => [...p.slice(-29), value]);
      setError("");
    } catch (e) {
      if (current.current === id && inflight.current === reading) setError(message(e));
    } finally {
      if (inflight.current === reading) {
        inflight.current = null;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    setMetrics(null);
    setHistory([]);
    setError("");
    setBusy(false);
    void refresh();
    return () => { inflight.current = null; };
  }, [session?.id]);
  useEffect(() => {
    if (paused || session?.status !== "connected") return;
    const timer = window.setInterval(() => void refresh(), interval * 1000);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status, paused, interval]);
  return (
    <section className="page">
      <PageHeader
        title="Server monitoring"
        description={
          session
            ? `Read-only system metrics from ${session.name}`
            : "Connect a Linux host to inspect its resources."
        }
      >
        <label className="inline-field">
          <span>Refresh</span>
          <select
            value={interval}
            onChange={(e) => setIntervalValue(Number(e.target.value))}
          >
            <option value={5}>5 seconds</option>
            <option value={10}>10 seconds</option>
            <option value={30}>30 seconds</option>
            <option value={60}>60 seconds</option>
          </select>
        </label>
        <Button disabled={!session} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={15} /> : <Pause size={15} />}{" "}
          {paused ? "Resume" : "Pause"}
        </Button>
        <IconButton
          label="Refresh metrics"
          disabled={!session || busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
        </IconButton>
      </PageHeader>
      <ErrorBox error={error} />
      {!session ? (
        <Empty
          icon={<Activity size={30} />}
          title="See what your server is doing"
          description="Open an SSH connection to monitor CPU, memory, disk usage, and running processes."
        />
      ) : !metrics ? (
        <div className="loading-block" role="status">
          {busy
            ? "Reading server metrics…"
            : "Metrics unavailable for this server."}
        </div>
      ) : (
        <>
          <div className="server-banner">
            <div>
              <strong>{metrics.hostname}</strong>
              <p>{metrics.os}</p>
            </div>
            <div>
              <span>Uptime</span>
              <strong>
                {typeof metrics.uptime === "number"
                  ? `${Math.floor(metrics.uptime / 86400)}d ${Math.floor((metrics.uptime % 86400) / 3600)}h`
                  : metrics.uptime}
              </strong>
            </div>
            <div>
              <span>Load average</span>
              <strong>
                {Array.isArray(metrics.load)
                  ? metrics.load.join(" · ")
                  : metrics.load}
              </strong>
            </div>
          </div>
          <div className="metric-grid">
            <Metric
              title="CPU usage"
              value={
                metrics.cpu == null
                  ? "Collecting…"
                  : `${metrics.cpu.toFixed(1)}%`
              }
              icon={<Cpu size={18} />}
              values={history.map((m) => m.cpu || 0)}
              detail="Across all processor cores"
            />
            <Metric
              title="Memory"
              value={`${((metrics.ram.used / Math.max(1, metrics.ram.total)) * 100).toFixed(1)}%`}
              icon={<MemoryStick size={18} />}
              values={history.map(
                (m) => (m.ram.used / Math.max(1, m.ram.total)) * 100,
              )}
              detail={`${formatBytes(metrics.ram.used)} of ${formatBytes(metrics.ram.total)}`}
            />
            <Metric
              title="Disk usage"
              value={`${((metrics.disk.used / Math.max(1, metrics.disk.total)) * 100).toFixed(1)}%`}
              icon={<HardDrive size={18} />}
              values={history.map(
                (m) => (m.disk.used / Math.max(1, m.disk.total)) * 100,
              )}
              detail={`${formatBytes(metrics.disk.used)} of ${formatBytes(metrics.disk.total)}`}
            />
          </div>
          <div className="network-strip">
            <Network size={20} />
            <strong>Network totals</strong>
            <span>
              <Download size={15} />
              {formatBytes(metrics.network.rx)} received
            </span>
            <span>
              <Upload size={15} />
              {formatBytes(metrics.network.tx)} sent
            </span>
          </div>
          <section className="process-panel">
            <header>
              <h2>Running processes</h2>
              <span>
                {paused ? "Monitoring paused" : `Updating every ${interval}s`}
              </span>
            </header>
            <pre>{metrics.processes}</pre>
          </section>
        </>
      )}
    </section>
  );
}
function Metric({
  title,
  value,
  detail,
  values,
  icon,
}: {
  title: string;
  value: string;
  detail: string;
  values: number[];
  icon: React.ReactNode;
}) {
  return (
    <article className="metric">
      <header>
        <span>{title}</span>
        {icon}
      </header>
      <strong>{value}</strong>
      <p>{detail}</p>
      <div className="metric-bars" aria-label={`${title} recent readings`}>
        {values.map((v, i) => (
          <span
            key={i}
            style={{ height: `${Math.max(2, Math.min(v, 100))}%` }}
            title={`${v.toFixed(1)}%`}
          />
        ))}
      </div>
    </article>
  );
}
type Tunnel = {
  id: string;
  sessionId: string;
  type: string;
  bindHost: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  status: string;
};
const newTunnel = { type: "local", bindHost: "127.0.0.1", bindPort: 8080, targetHost: "127.0.0.1", targetPort: 80 };
export function Tunnels({
  session,
  sessions,
  notify,
}: {
  session?: Session;
  sessions: Session[];
  notify: (s: string, error?: boolean) => void;
}) {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [error, setError] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(newTunnel);
  const target = sessions.find(item => item.id === targetId);
  const openNew = () => {
    if (session?.status !== "connected") return;
    setEditing(null);
    setForm(newTunnel);
    setTargetId(session.id);
    setError("");
  };
  const listRequest = useRef(0);
  const refresh = async () => {
    const revision = ++listRequest.current;
    try {
      const items = await request<Tunnel[]>("tunnels_list");
      if (revision !== listRequest.current) return;
      setTunnels(items);
      setError("");
    } catch (e) {
      if (revision === listRequest.current) setError(message(e));
    }
  };
  useEffect(() => {
    void refresh();
    return () => { listRequest.current++; };
  }, [sessions]);
  const start = async () => {
    if (busy || target?.status !== "connected") return;
    setBusy(true);
    setError("");
    try {
      await request(editing ? "tunnels_update" : "tunnels_start", {
        ...form,
        id: editing?.id,
        sessionId: target.id,
      });
      setTargetId(null);
      setEditing(null);
      await refresh();
      notify(editing ? "Forwarding rule updated" : "Tunnel started");
    } catch (e) {
      await refresh();
      if (editing) {
        setTargetId(null);
        setEditing(null);
      }
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="page">
      <PageHeader
        title="SSH tunnels"
        description="Forward a local port through an encrypted SSH connection."
      >
        <Button onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Refresh
        </Button>
        <Button
          variant="primary"
          disabled={session?.status !== "connected"}
          onClick={openNew}
        >
          <Plus size={16} />
          New tunnel
        </Button>
      </PageHeader>
      <ErrorBox error={!targetId ? error : ""} />
      {!tunnels.length ? (
        <Empty
          icon={<Network size={30} />}
          title="Reach services through SSH"
          description={
            session
              ? "Create a forwarding rule to access a service through this server."
              : "Connect to a host before creating a forwarding rule."
          }
          action={
            session && (
              <Button
                onClick={openNew}
                variant="primary"
              >
                Create forwarding rule
              </Button>
            )
          }
        />
      ) : (
        <div className="item-list">
          {tunnels.map((t) => {
            const owner = sessions.find(item => item.id === t.sessionId);
            return (
            <article className="tunnel-row" key={t.id}>
              <Network size={22} />
              <div className="item-content">
                <h2>
                  {t.type === "dynamic"
                    ? "SOCKS proxy"
                    : t.type === "remote"
                      ? "Remote forwarding"
                      : "Local forwarding"}
                  <small>{t.status || "active"}</small>
                </h2>
                <p>{owner?.name || "Disconnected SSH session"}</p>
                <p className="tunnel-route">
                  <code>
                    {t.bindHost}:{t.bindPort}
                  </code>
                  <ArrowRight size={16} />
                  <code>
                    {t.type === "dynamic"
                      ? "SOCKS5"
                      : `${t.targetHost}:${t.targetPort}`}
                  </code>
                </p>
              </div>
              <IconButton
                label="Edit forwarding rule"
                disabled={owner?.status !== "connected"}
                onClick={() => {
                  setError("");
                  setEditing(t);
                  setForm({
                    type: t.type,
                    bindHost: t.bindHost,
                    bindPort: t.bindPort,
                    targetHost: t.targetHost || "127.0.0.1",
                    targetPort: t.targetPort || 80,
                  });
                  setTargetId(t.sessionId);
                }}
              >
                <Pencil size={16} />
              </IconButton>
              <Button
                onClick={async () => {
                  try {
                    await request("tunnels_stop", { id: t.id });
                    await refresh();
                  } catch (e) {
                    notify(message(e), true);
                  }
                }}
              >
                <Square size={14} />
                Stop
              </Button>
            </article>
          );})}
        </div>
      )}
      <Modal
        open={targetId !== null}
        onOpenChange={(v) => {
          if (!v && !busy) setTargetId(null);
        }}
        title={editing ? "Edit forwarding rule" : "New forwarding rule"}
        description={target ? `Route traffic through ${target.name}.` : "The original SSH session is unavailable."}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="modal-body form-grid">
            <div className="span-2">
              <Field label="Forwarding type">
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  <option value="local">Local port forwarding</option>
                  <option value="remote">Remote port forwarding</option>
                  <option value="dynamic">Dynamic SOCKS5 proxy</option>
                </select>
              </Field>
              <p className="field-note">
                {form.type === "local"
                  ? "Listen on your computer and reach a service from the SSH server."
                  : form.type === "remote"
                    ? "Listen on the SSH server and forward traffic to a service on your computer."
                    : "Use this local port as a SOCKS5 proxy for applications."}
              </p>
            </div>
            <Field label="Listen address">
              <input
                required
                value={form.bindHost}
                onChange={(e) => setForm({ ...form, bindHost: e.target.value })}
              />
            </Field>
            <Field label="Listen port">
              <input
                type="number"
                min={1}
                max={65535}
                required
                value={form.bindPort}
                onChange={(e) =>
                  setForm({ ...form, bindPort: Number(e.target.value) })
                }
              />
            </Field>
            {form.type !== "dynamic" && (
              <>
                <Field label="Destination host">
                  <input
                    required
                    value={form.targetHost}
                    onChange={(e) =>
                      setForm({ ...form, targetHost: e.target.value })
                    }
                  />
                </Field>
                <Field label="Destination port">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={form.targetPort}
                    onChange={(e) =>
                      setForm({ ...form, targetPort: Number(e.target.value) })
                    }
                  />
                </Field>
              </>
            )}
            <div className="span-2">
              <ErrorBox error={targetId && target?.status !== "connected" ? "The original SSH session disconnected. Close this form and choose a connected session." : error} />
            </div>
          </div>
          <footer className="modal-footer">
            <Button disabled={busy} onClick={() => setTargetId(null)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy} disabled={target?.status !== "connected"}>
              {editing ? "Save changes" : "Start tunnel"}
            </Button>
          </footer>
        </form>
      </Modal>
    </section>
  );
}
