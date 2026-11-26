import { useEffect, useState } from "react";
import { DropdownMenu } from "radix-ui";
import {
  Server,
  Plus,
  Search,
  Star,
  Copy,
  Trash2,
  Pencil,
  FolderPlus,
  FolderTree as FolderTreeIcon,
  CheckSquare,
  LockKeyhole,
  KeyRound,
  ChevronDown,
  Download,
  Upload,
  ArrowRightLeft,
} from "lucide-react";
import type { Config, Host, Session, KeyInfo, Transfer } from "./types";
import { uid, message } from "./types";
import {
  Button,
  IconButton,
  Modal,
  Field,
  ErrorBox,
  Empty,
  PageHeader,
  Confirm,
  clockDate,
} from "./ui";
import { ConnectionCard, serverAddress } from "./ConnectionCard";
import { request } from "./api";
import { AuthenticationFields } from "./AuthenticationFields";
import { authenticationChoice } from "./authentication";
import { EnvironmentBadge, environmentNames } from "./EnvironmentBadge";
import { HostMark } from "./HostIdentity";
type Props = {
  config: Config;
  workspace: string;
  sessions: Session[];
  view: string;
  save: (c: Config) => Promise<void>;
  connect: (h: Host) => void;
  notify: (s: string, error?: boolean) => void;
  editRequest?: number;
  onEditRequestConsumed: () => void;
  transfers: Transfer[];
  onOpenTransfers: () => void;
};
export function Hosts({
  config,
  workspace,
  sessions,
  view,
  save,
  connect,
  notify,
  editRequest = 0,
  onEditRequestConsumed,
  transfers,
  onOpenTransfers,
}: Props) {
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<Host | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [group, setGroup] = useState("");
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<
    Config["groups"][number] | null
  >(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkDelete, setBulkDelete] = useState(false);
  useEffect(() => {
    setGroup("");
    setSelected([]);
  }, [workspace]);
  useEffect(() => {
    if (editRequest > 0) {
      setEditor(null);
      onEditRequestConsumed();
    }
  }, [editRequest]);
  let hosts = config.hosts.filter((h) => h.workspaceId === workspace);
  if (view === "Favorites") hosts = hosts.filter((h) => h.favorite);
  if (view === "Recent")
    hosts = hosts
      .filter((h) => h.lastConnected)
      .sort((a, b) =>
        (b.lastConnected || "").localeCompare(a.lastConnected || ""),
      );
  hosts = hosts.filter(
    (h) =>
      [h.name, h.hostname, h.username, ...h.tags]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!group || h.groupId === group),
  );
  const groups = config.groups.filter((g) => g.workspaceId === workspace);
  const update = async (h: Host) => {
    await save({
      ...config,
      hosts: config.hosts.map((x) => (x.id === h.id ? h : x)),
    });
  };
  const addGroup = async () => {
    if (!groupName.trim()) return;
    try {
      await save({
        ...config,
        groups: editingGroup
          ? config.groups.map((item) =>
              item.id === editingGroup
                ? { ...item, name: groupName.trim() }
                : item,
            )
          : [
              ...config.groups,
              { id: uid(), name: groupName.trim(), workspaceId: workspace },
            ],
      });
      setGroupOpen(false);
      setGroupName("");
      setEditingGroup(null);
    } catch (e) {
      notify(message(e), true);
    }
  };
  return (
    <section className="page hosts-page">
      <PageHeader
        title={
          view === "Hosts"
            ? "Your hosts"
            : view === "Groups"
              ? "Server groups"
              : view === "Recent"
                ? "Recent connections"
                : view
        }
      >
        <Button
          onClick={() => {
            setEditingGroup(null);
            setGroupName("");
            setGroupOpen(true);
          }}
        >
          <FolderPlus size={16} />
          New group
        </Button>
        <Button variant="primary" onClick={() => setEditor(null)}>
          <Plus size={17} />
          New host
        </Button>
      </PageHeader>
      {view === "Groups" && groups.length > 0 && (
        <div className="group-list">
          {groups.map((item) => (
            <article
              className={`group-row ${group === item.id ? "selected" : ""}`}
              key={item.id}
            >
              <button
                className="group-filter"
                onClick={() => setGroup(group === item.id ? "" : item.id)}
              >
                <FolderTreeIcon />
                <span>
                  {item.name}
                  <small>
                    {
                      config.hosts.filter((host) => host.groupId === item.id)
                        .length
                    }{" "}
                    hosts
                  </small>
                </span>
              </button>
              <IconButton
                label={`Rename group ${item.name}`}
                onClick={() => {
                  setEditingGroup(item.id);
                  setGroupName(item.name);
                  setGroupOpen(true);
                }}
              >
                <Pencil size={15} />
              </IconButton>
              <IconButton
                label={`Delete group ${item.name}`}
                onClick={() => setDeletingGroup(item)}
              >
                <Trash2 size={15} />
              </IconButton>
            </article>
          ))}
        </div>
      )}
      <div className="list-controls">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="Search hosts"
            placeholder="Search name, address, or tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="filter-label">
          <span className="sr-only">Filter group</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <span className="result-count">
          {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
        </span>
      </div>
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>{selected.length} selected</span>
          <Button onClick={() => setSelected([])}>Clear</Button>
          <Button variant="danger" onClick={() => setBulkDelete(true)}>
            Delete selected
          </Button>
        </div>
      )}
      {hosts.length === 0 ? (
        <Empty
          icon={<Server size={30} strokeWidth={1.4} />}
          title={
            search || group
              ? "No matching hosts"
              : view === "Favorites"
                ? "Your favorites belong here"
                : view === "Recent"
                  ? "Your next session starts here"
                  : "Connect to your first server"
          }
          description={
            search || group
              ? "Try another name, address, or group."
              : view === "Favorites"
                ? "Star a saved host to keep it within easy reach."
                : "Save a host to open terminals, browse remote files, and manage your server from one place."
          }
          action={
            <Button variant="primary" onClick={() => setEditor(null)}>
              <Plus size={17} />
              Add a host
            </Button>
          }
        />
      ) : (
        <div className="connections-grid" aria-label="Saved SSH hosts">
          {hosts.map((h) => {
            const connected = sessions.some(s => s.hostId === h.id && s.status === "connected");
            const groupName = groups.find(g => g.id === h.groupId)?.name;
            return <ConnectionCard key={h.id} name={h.name} address={serverAddress(h.username, h.hostname, h.port)}
              icon={<HostMark host={h} size={22} />} onOpen={() => connect(h)}
              status={connected ? "Connected" : undefined}
              method={h.authMethod === "password" ? <><LockKeyhole size={12} />Password</> :
                <><KeyRound size={12} />{h.authMethod === "agent" ? "SSH agent" : "SSH key"}</>}
              favorite={h.favorite && <Star size={11} fill="currentColor" aria-label="Favorite" />}
              details={<><EnvironmentBadge value={h.environmentLabel} />{groupName && <span>{groupName}</span>}
                {h.tags.slice(0, 2).map(t => <span key={t}>{t}</span>)}
                {view === "Recent" && <span>{clockDate(h.lastConnected)}</span>}</>}
              active={selected.includes(h.id)}
              selectControl={selected.length > 0 && <label className="connection-select"><input type="checkbox" aria-label={`Select ${h.name}`}
                checked={selected.includes(h.id)} onChange={() => setSelected(ids => ids.includes(h.id) ? ids.filter(id => id !== h.id) : [...ids,h.id])} /></label>}
              actions={<>
                    <DropdownMenu.Item onSelect={() => update({...h, favorite: !h.favorite}).catch(e => notify(message(e), true))}>
                      <Star size={15} />{h.favorite ? "Remove favorite" : "Add favorite"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => setSelected(ids => ids.includes(h.id) ? ids.filter(id => id !== h.id) : [...ids, h.id])}>
                      <CheckSquare size={15} />{selected.includes(h.id) ? "Unselect host" : "Select host"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => setEditor(h)}>
                      <Pencil size={15} />
                      Edit host
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={async () => {
                        try {
                          await save({
                            ...config,
                            hosts: [
                              ...config.hosts,
                              {
                                ...h,
                                id: uid(),
                                name: `${h.name} copy`,
                                lastConnected: undefined,
                              },
                            ],
                          });
                          notify(
                            "Host duplicated. Enter credentials when connecting.",
                          );
                        } catch (e) {
                          notify(message(e), true);
                        }
                      }}
                    >
                      <Copy size={15} />
                      Duplicate
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="ui-menu-separator" />
                    <DropdownMenu.Item
                      className="danger-text"
                      onSelect={() => setDeleting(h)}
                    >
                      <Trash2 size={15} />
                      Delete host
                    </DropdownMenu.Item>
              </>} />;
          })}
        </div>
      )}
      {editor !== undefined && (
        <HostEditor
          host={editor}
          config={config}
          workspace={workspace}
          onClose={() => setEditor(undefined)}
          onSave={async (host) => {
            await save({
              ...config,
              hosts: config.hosts.some((h) => h.id === host.id)
                ? config.hosts.map((h) => (h.id === host.id ? host : h))
                : [...config.hosts, host],
            });
            setEditor(undefined);
            notify("Host saved");
          }}
        />
      )}
      <Modal
        open={groupOpen}
        onOpenChange={setGroupOpen}
        title={editingGroup ? "Rename server group" : "New server group"}
        description="Organize hosts in this workspace."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addGroup();
          }}
        >
          <div className="modal-body">
            <Field label="Group name">
              <input
                required
                autoFocus
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Production"
              />
            </Field>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setGroupOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary">
              {editingGroup ? "Save group" : "Create group"}
            </Button>
          </footer>
        </form>
      </Modal>
      <Confirm
        open={!!deleting}
        title="Delete host?"
        description={`Remove ${deleting?.name} from this workspace. Active terminals will stay open until you close them.`}
        danger
        confirmLabel="Delete host"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          await save({
            ...config,
            hosts: config.hosts.filter((h) => h.id !== deleting?.id),
          });
        }}
      />
      <Confirm
        open={bulkDelete}
        title="Delete selected hosts?"
        description={`Remove ${selected.length} saved hosts from your configuration.`}
        danger
        confirmLabel="Delete hosts"
        onClose={() => setBulkDelete(false)}
        onConfirm={async () => {
          await save({
            ...config,
            hosts: config.hosts.filter((h) => !selected.includes(h.id)),
          });
          setSelected([]);
        }}
      />
      <Confirm
        open={!!deletingGroup}
        title="Delete server group?"
        description={`Remove ${deletingGroup?.name}. Its hosts will become ungrouped.`}
        danger
        confirmLabel="Delete group"
        onClose={() => setDeletingGroup(null)}
        onConfirm={async () => {
          await save({
            ...config,
            groups: config.groups.filter(
              (item) => item.id !== deletingGroup?.id,
            ),
            hosts: config.hosts.map((host) =>
              host.groupId === deletingGroup?.id
                ? { ...host, groupId: undefined }
                : host,
            ),
          });
          if (group === deletingGroup?.id) setGroup("");
        }}
      />
      {view === "Hosts" && transfers.length > 0 && (
        <section className="recent-transfer-summary">
          <header>
            <h2>Recent file transfers</h2>
            <Button variant="ghost" onClick={onOpenTransfers}>
              View history
            </Button>
          </header>
          <ul>
            {transfers.slice(0, 3).map((transfer) => {
              const Icon = transfer.direction === "relay" ? ArrowRightLeft : transfer.direction === "upload" ? Upload : Download;
              const name = transfer.source.split(/[\\/]/).pop() || transfer.source;
              return <li key={transfer.id}>
                <button type="button" onClick={onOpenTransfers} title={name}>
                  <Icon size={15} aria-label={transfer.direction} />
                  <span className="transfer-summary-name">{name}</span>
                  <small data-status={transfer.status}>{transfer.status}</small>
                </button>
              </li>;
            })}
          </ul>
        </section>
      )}
    </section>
  );
}
export function HostEditor({
  host,
  config,
  workspace,
  onClose,
  onSave,
}: {
  host: Host | null;
  config: Config;
  workspace: string;
  onClose: () => void;
  onSave: (h: Host) => Promise<void>;
}) {
  const [form, setForm] = useState<Host>(
    host || {
      id: uid(),
      name: "",
      hostname: "",
      port: config.settings.defaultPort,
      username: "",
      authMethod: "password",
      workspaceId: workspace,
      tags: [],
      color: "#6C8CFF",
      notes: "",
      favorite: false,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [environment, setEnvironment] = useState(
    Object.entries(form.environment || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const set = <K extends keyof Host>(key: K, value: Host[K]) =>
    setForm((p) => ({ ...p, [key]: value }));
  return (
    <Modal
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title={host ? "Edit host" : "New host"}
      description="Save the connection details. Credentials are entered when you connect."
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (authenticationChoice(form) === "private-key")
              await request("identity_inspect", { path: form.identityFile });
            const env: Record<string, string> = {};
            for (const line of environment.split("\n").filter(Boolean)) {
              const i = line.indexOf("=");
              if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, i)))
                throw new Error("Environment entries must use NAME=value.");
              env[line.slice(0, i)] = line.slice(i + 1);
            }
            await onSave({
              ...form,
              name: form.name.trim(),
              hostname: form.hostname.trim(),
              username: form.username.trim(),
              environment: env,
            });
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-body form-grid">
          <Field label="Host name">
            <input
              autoFocus
              required
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Production server"
            />
          </Field>
          <Field label="Group">
            <select
              value={form.groupId || ""}
              onChange={(e) => set("groupId", e.target.value)}
            >
              <option value="">Ungrouped</option>
              {config.groups
                .filter((g) => g.workspaceId === workspace)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Hostname / IP address">
            <input
              required
              value={form.hostname}
              onChange={(e) => set("hostname", e.target.value)}
              placeholder="server.example.com"
            />
          </Field>
          <Field label="Port">
            <input
              type="number"
              required
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => set("port", Number(e.target.value))}
            />
          </Field>
          <Field label="Username">
            <input
              required
              autoComplete="username"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="ubuntu"
            />
          </Field>
          <AuthenticationFields
            host={form}
            onChange={setForm}
            disabled={busy}
          />
          <Field label="Tags" hint="Separate tags with commas.">
            <input
              value={form.tags.join(", ")}
              onChange={(e) =>
                set(
                  "tags",
                  e.target.value.split(",").map((t) => t.trim()),
                )
              }
              placeholder="web, production"
            />
          </Field>
          <Field label="Host color">
            <input
              type="color"
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
            />
          </Field>
          <Field label="Environment" hint="Shown on host rows, terminal tabs, and the remote file panel.">
            <select value={form.environmentLabel || ""} onChange={(event) => set("environmentLabel", (event.target.value || undefined) as Host["environmentLabel"])}>
              <option value="">No environment label</option>
              {Object.entries(environmentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Host icon">
            <select
              value={form.icon || "server"}
              onChange={(event) =>
                set("icon", event.target.value as Host["icon"])
              }
            >
              <option value="server">Server</option>
              <option value="database">Database</option>
              <option value="globe">Web server</option>
              <option value="cloud">Cloud infrastructure</option>
              <option value="terminal">Terminal</option>
            </select>
          </Field>
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
            />
          </Field>
          <div className="span-2">
            <Button variant="ghost" onClick={() => setAdvanced(!advanced)}>
              <ChevronDown size={15} />
              Advanced connection settings
            </Button>
          </div>
          {advanced && (
            <>
              <Field label="Timeout (seconds)">
                <input
                  type="number"
                  min={3}
                  max={300}
                  value={form.timeout || config.settings.timeout}
                  onChange={(e) => set("timeout", Number(e.target.value))}
                />
              </Field>
              <Field label="Keepalive (seconds)">
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={form.keepalive ?? config.settings.keepalive}
                  onChange={(e) => set("keepalive", Number(e.target.value))}
                />
              </Field>
              <Field
                label="Jump host (ProxyJump)"
                hint="Connect to the jump host once and save its credential before using it here."
              >
                <select
                  value={form.jumpHostId || ""}
                  onChange={(e) => set("jumpHostId", e.target.value)}
                >
                  <option value="">Direct connection</option>
                  {config.hosts
                    .filter((h) => h.id !== form.id)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Terminal profile">
                <select
                  value={form.terminalProfileId || ""}
                  onChange={(e) => set("terminalProfileId", e.target.value)}
                >
                  <option value="">Default terminal settings</option>
                  {config.terminalProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Environment variables"
                hint="One NAME=value entry per line. Server must allow these variables."
              >
                <textarea
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  rows={3}
                  placeholder="LANG=en_US.UTF-8"
                />
              </Field>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={!!form.compression}
                  onChange={(e) => set("compression", e.target.checked)}
                />
                Enable compression
              </label>
              <p className="field-note span-2">
                SSH agent forwarding is pending backend support.
              </p>
            </>
          )}
          <div className="span-2">
            <ErrorBox error={error} />
          </div>
        </div>
        <footer className="modal-footer">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" busy={busy}>
            Save host
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
