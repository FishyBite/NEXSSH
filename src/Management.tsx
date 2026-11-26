import { useEffect, useRef, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Plus,
  KeyRound,
  Download,
  Upload,
  Copy,
  Trash2,
  Star,
  Search,
  Play,
  Pencil,
  Settings2,
  ShieldCheck,
  RefreshCw,
  Check,
  ArrowRight,
  Save,
} from "lucide-react";
import type {
  Config,
  KeyInfo,
  Snippet,
  Session,
  Settings,
  TerminalProfile,
} from "./types";
import { maxSftpLimitKiB, message, uid, validSftpLimit } from "./types";
import { appThemes, appThemeOptions, type AppTheme } from "./appThemes";
import { getTerminalTheme, validTerminalForeground } from "./terminalThemes";
import { terminalFontFamilies, TerminalPaletteOptions, TerminalPreview, TerminalTextColor } from "./TerminalAppearance";
import type { IdentityInspection } from "./authentication";
import { request } from "./api";
import { writeClipboardText } from "./clipboard";
import { viewShortcut, viewShortcuts } from "./sessionShortcuts";
import { snippetAvailable } from "./snippetScope";
import { version as appVersion } from "../package.json";
import { UpdatesPanel } from "./UpdatesPanel";
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
type Notify = (text: string, error?: boolean) => void;
function TerminalProfiles({
  config,
  appearance,
  save,
  notify,
}: {
  config: Config;
  appearance: Exclude<AppTheme, "system">;
  save: (config: Config) => Promise<void>;
  notify: Notify;
}) {
  const [editing, setEditing] = useState<TerminalProfile | null>(null);
  const [environment, setEnvironment] = useState("");
  const [error, setError] = useState("");
  const profilePalette = editing?.terminalTheme ?? (config.settings.followAppTheme ? appearance : config.settings.terminalTheme);
  const inheritedColors = getTerminalTheme(profilePalette, config.settings.terminalForeground);
  const profileColors = validTerminalForeground(editing?.terminalForeground)
    ? getTerminalTheme(profilePalette, editing.terminalForeground) : inheritedColors;
  const invalidForeground = !!editing?.terminalForeground && !validTerminalForeground(editing.terminalForeground);
  const edit = (profile?: TerminalProfile) => {
    const next = profile || {
      id: uid(),
      name: "",
      fontFamily: config.settings.fontFamily,
      fontSize: config.settings.fontSize,
      cursorStyle: config.settings.cursorStyle,
      copyOnSelect: config.settings.copyOnSelect,
      terminalTheme: undefined,
      environment: {},
    };
    setEditing(next);
    setEnvironment(
      Object.entries(next.environment)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    setError("");
  };
  const persist = async () => {
    if (!editing || invalidForeground) return;
    try {
      const env: Record<string, string> = {};
      for (const line of environment.split("\n").filter(Boolean)) {
        const split = line.indexOf("=");
        if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, split)))
          throw new Error("Environment entries must use NAME=value.");
        env[line.slice(0, split)] = line.slice(split + 1);
      }
      const profile = { ...editing, environment: env };
      await save({
        ...config,
        terminalProfiles: config.terminalProfiles.some(
          (p) => p.id === profile.id,
        )
          ? config.terminalProfiles.map((p) =>
              p.id === profile.id ? profile : p,
            )
          : [...config.terminalProfiles, profile],
      });
      setEditing(null);
      notify("Terminal profile saved");
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className="profile-manager">
      <div className="profile-heading">
        <h3>Terminal profiles</h3>
        <Button onClick={() => edit()}>
          <Plus size={14} />
          New profile
        </Button>
      </div>
      <p className="field-note">
        Assign a profile in a host’s advanced settings.
      </p>
      {config.terminalProfiles.map((profile) => (
        <div className="known-host" key={profile.id}>
          <div>
            <strong>{profile.name}</strong>
            <code>
              {profile.fontFamily} · {profile.fontSize}px ·{" "}
              {profile.cursorStyle}
            </code>
          </div>
          <div className="toolbar">
            <IconButton
              label={`Edit ${profile.name}`}
              onClick={() => edit(profile)}
            >
              <Pencil size={15} />
            </IconButton>
            <IconButton
              label={`Delete ${profile.name}`}
              onClick={() =>
                void save({
                  ...config,
                  terminalProfiles: config.terminalProfiles.filter(
                    (p) => p.id !== profile.id,
                  ),
                  hosts: config.hosts.map((host) =>
                    host.terminalProfileId === profile.id
                      ? { ...host, terminalProfileId: undefined }
                      : host,
                  ),
                }).catch((e) => notify(message(e), true))
              }
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        </div>
      ))}
      <Modal
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Terminal profile"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void persist();
          }}
        >
          <div className="modal-body form-grid">
            <Field label="Profile name">
              <input
                required
                value={editing?.name || ""}
                onChange={(event) =>
                  setEditing((profile) =>
                    profile
                      ? { ...profile, name: event.target.value }
                      : profile,
                  )
                }
              />
            </Field>
            <Field label="Font family">
              <input
                required
                list="terminal-profile-fonts"
                value={editing?.fontFamily || ""}
                onChange={(event) =>
                  setEditing((profile) =>
                    profile
                      ? { ...profile, fontFamily: event.target.value }
                      : profile,
                  )
                }
              />
            </Field>
            <datalist id="terminal-profile-fonts">
              {terminalFontFamilies.map(font => <option key={font} value={font} />)}
            </datalist>
            <Field label="Font size">
              <input
                type="number"
                min={10}
                max={32}
                required
                value={editing?.fontSize || 14}
                onChange={(event) =>
                  setEditing((profile) =>
                    profile
                      ? { ...profile, fontSize: Number(event.target.value) }
                      : profile,
                  )
                }
              />
            </Field>
            <Field label="Cursor style">
              <select
                value={editing?.cursorStyle || "block"}
                onChange={(event) =>
                  setEditing((profile) =>
                    profile
                      ? {
                          ...profile,
                          cursorStyle: event.target
                            .value as Settings["cursorStyle"],
                        }
                      : profile,
                  )
                }
              >
                <option value="block">Block</option>
                <option value="bar">Bar</option>
                <option value="underline">Underline</option>
              </select>
            </Field>
            <Field label="Terminal color theme">
              <select
                value={editing?.terminalTheme || ""}
                onChange={(event) =>
                  setEditing((profile) =>
                    profile
                      ? {
                          ...profile,
                          terminalTheme: event.target.value
                            ? event.target.value as Settings["terminalTheme"]
                            : undefined,
                        }
                      : profile,
                  )
                }
              >
                <option value="">Use workspace colors</option>
                <TerminalPaletteOptions />
              </select>
            </Field>
            {editing && <>
              <TerminalTextColor value={editing.terminalForeground}
                fallback={inheritedColors.foreground!} background={inheritedColors.background!}
                resetLabel="Use workspace text color"
                onChange={terminalForeground => setEditing({ ...editing, terminalForeground })} />
              <TerminalPreview colors={profileColors} fontFamily={editing.fontFamily}
                fontSize={editing.fontSize} cursorStyle={editing.cursorStyle} />
            </>}
            <div className="span-2">
              <Field
                label="Shell environment"
                hint="One NAME=value per line. The SSH server must accept the variables."
              >
                <textarea
                  rows={4}
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value)}
                />
              </Field>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editing?.copyOnSelect ?? config.settings.copyOnSelect}
                onChange={(event) =>
                  setEditing((profile) =>
                    profile
                      ? { ...profile, copyOnSelect: event.target.checked }
                      : profile,
                  )
                }
              />
              Automatically copy mouse selections
            </label>
            <div className="span-2">
              <ErrorBox error={error} />
            </div>
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={invalidForeground}>
              Save profile
            </Button>
          </footer>
        </form>
      </Modal>
    </div>
  );
}
export function Keys({ notify }: { notify: Notify }) {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<"generate" | "import" | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("ed25519");
  const [passphrase, setPassphrase] = useState("");
  const [path, setPath] = useState("");
  const [inspection, setInspection] = useState<IdentityInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<KeyInfo | null>(null);
  const [filter, setFilter] = useState("");
  const refresh = async () => {
    try {
      setKeys(await request<KeyInfo[]>("keys_list"));
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    let active = true;
    setPassphrase("");
    setError("");
    setInspection(null);
    setInspectionError("");
    if (form !== "import" || !path) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    const timer = window.setTimeout(() => {
      void request<IdentityInspection>("identity_inspect", { path })
        .then((value) => {
          if (active) setInspection(value);
        })
        .catch((error) => {
          if (active) setInspectionError(message(error));
        })
        .finally(() => {
          if (active) setInspecting(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [form, path]);
  const beginForm = (mode: "generate" | "import") => {
    setForm(mode);
    setPassphrase("");
    setError("");
    setPath("");
    setName("");
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (form === "import") {
        const current = await request<IdentityInspection>("identity_inspect", {
          path,
        });
        setInspection(current);
        if (current.encrypted && !passphrase)
          throw new Error(
            "This private key is encrypted. Enter its passphrase to import it.",
          );
        await request("keys_import", {
          name,
          path,
          passphrase: current.encrypted ? passphrase : undefined,
        });
      } else {
        await request("keys_generate", {
          name,
          type,
          passphrase: passphrase || undefined,
        });
      }
      setForm(null);
      setPassphrase("");
      setName("");
      setPath("");
      await refresh();
      notify("SSH key stored securely");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const exportKey = async (key: KeyInfo) => {
    try {
      const selected = await saveDialog({
        defaultPath: `${key.name}.pub`,
        filters: [{ name: "Public key", extensions: ["pub"] }],
      });
      if (selected) {
        await request("keys_export", { id: key.id, path: selected });
        notify("Public key exported");
      }
    } catch (e) {
      notify(message(e), true);
    }
  };
  return (
    <section className="page">
      <PageHeader
        title="SSH keys"
        description="Manage identities for your server connections."
      >
        <Button onClick={() => beginForm("import")}>
          <Upload size={16} />
          Import key
        </Button>
        <Button variant="primary" onClick={() => beginForm("generate")}>
          <Plus size={16} />
          Generate key
        </Button>
      </PageHeader>
      <div className="security-note">
        <ShieldCheck size={18} />
        <span>
          Private keys are encrypted on this device. Export provides the public
          key.
        </span>
      </div>
      <label className="search-input compact">
        <Search size={16} />
        <input
          aria-label="Search SSH keys"
          placeholder="Search key name or fingerprint…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <ErrorBox error={!form ? error : ""} />
      {loading ? (
        <div className="loading-block" role="status">
          Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <Empty
          icon={<KeyRound size={28} />}
          title="Your identities, kept locally"
          description="Generate an Ed25519 or RSA key, or import an existing private key for your hosts."
          action={
            <Button onClick={() => beginForm("generate")} variant="primary">
              Generate SSH key
            </Button>
          }
        />
      ) : (
        <div className="item-list">
          {keys
            .filter((k) =>
              [k.name, k.fingerprint]
                .join(" ")
                .toLowerCase()
                .includes(filter.toLowerCase()),
            )
            .map((k) => (
              <article className="key-row" key={k.id}>
                <div className="item-icon">
                  <KeyRound size={21} />
                </div>
                <div className="item-content">
                  <h2>
                    {k.name}
                    <small>{k.type.toUpperCase()}</small>
                  </h2>
                  <code>{k.fingerprint}</code>
                  <p>Created {clockDate(k.createdAt)}</p>
                </div>
                <div className="toolbar">
                  <IconButton
                    label="Copy public key"
                    onClick={() =>
                      void writeClipboardText(k.publicKey)
                        .then(() => notify("Public key copied"))
                        .catch((e) => notify(message(e), true))
                    }
                  >
                    <Copy size={16} />
                  </IconButton>
                  <IconButton
                    label="Export public key"
                    onClick={() => void exportKey(k)}
                  >
                    <Download size={16} />
                  </IconButton>
                  <IconButton
                    label="Delete SSH key"
                    onClick={() => setRemove(k)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </article>
            ))}
        </div>
      )}
      <Modal
        open={!!form}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setForm(null);
            setPassphrase("");
          }
        }}
        title={form === "generate" ? "Generate SSH key" : "Import private key"}
        description="The private key is encrypted before it is saved."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="modal-body">
            <Field label="Key name">
              <input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Personal laptop"
              />
            </Field>
            {form === "generate" ? (
              <Field label="Algorithm">
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="ed25519">Ed25519</option>
                  <option value="rsa">RSA</option>
                </select>
              </Field>
            ) : (
              <>
                <Field
                  label="Private key file"
                  hint="Choose an OpenSSH Ed25519 or RSA private key file. Files without an extension are supported."
                >
                  <div className="input-action">
                    <input
                      required
                      disabled={busy}
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      autoComplete="off"
                      placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                    />
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        try {
                          const p = await open({
                            multiple: false,
                            directory: false,
                            title: "Choose OpenSSH private key to import",
                            defaultPath: path || undefined,
                          });
                          if (p) setPath(p);
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Browse
                    </Button>
                  </div>
                </Field>
                {path && (
                  <div>
                    <span className="field-note">
                      Selected file · {path.split(/[\\/]/).pop()}
                    </span>
                    <code className="fingerprint">{path}</code>
                  </div>
                )}
                {inspecting && (
                  <p className="field-note" role="status">
                    Checking private key format…
                  </p>
                )}
                {inspection && (
                  <p className="identity-inspection">
                    <KeyRound size={14} />
                    {inspection.algorithm.toUpperCase()} ·{" "}
                    {inspection.encrypted
                      ? "Encrypted key · passphrase required"
                      : "Unencrypted key · ready to import"}
                  </p>
                )}
                <ErrorBox error={inspectionError} />
              </>
            )}
            {(form === "generate" || inspection?.encrypted) && (
              <Field
                label={
                  form === "import"
                    ? "Private key passphrase"
                    : "Passphrase (optional)"
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  required={form === "import" && inspection?.encrypted}
                  disabled={busy}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
            )}
            <ErrorBox error={error} />
          </div>
          <footer className="modal-footer">
            <Button
              onClick={() => {
                setForm(null);
                setPassphrase("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={
                form === "import" &&
                (inspecting || !inspection || !!inspectionError)
              }
            >
              {form === "generate" ? "Generate key" : "Import key"}
            </Button>
          </footer>
        </form>
      </Modal>
      <Confirm
        open={!!remove}
        title="Delete SSH key?"
        description={`Remove ${remove?.name} from secure storage. Hosts using this key will need a new identity.`}
        danger
        confirmLabel="Delete key"
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          try {
            await request("keys_delete", { id: remove?.id });
            await refresh();
          } catch (e) {
            notify(message(e), true);
          }
        }}
      />
    </section>
  );
}
export function Snippets({
  config,
  workspace,
  session,
  save,
  run,
  notify,
  reviewRequest,
  onReviewConsumed,
}: {
  config: Config;
  workspace: string;
  session?: Session;
  save: (c: Config) => Promise<void>;
  run: (snippet: Snippet, sessionId: string) => void;
  notify: Notify;
  reviewRequest: Snippet | null;
  onReviewConsumed: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [executing, setExecuting] = useState<{ snippet: Snippet; sessionId: string; sessionName: string } | null>(null);
  const [command, setCommand] = useState("");
  const targetWorkspace = config.hosts.find(host => host.id === session?.hostId)?.workspaceId;
  const canRunHere = (snippet: Snippet) => session?.status === "connected"
    && snippetAvailable(snippet, workspace, session.hostId)
    && snippetAvailable(snippet, targetWorkspace, session.hostId);
  const review = (snippet: Snippet) => {
    if (!session || !canRunHere(snippet)) return;
    setExecuting({ snippet, sessionId: session.id, sessionName: session.name });
    setCommand(snippet.command);
  };
  useEffect(() => {
    if (reviewRequest) {
      review(reviewRequest);
      onReviewConsumed();
    }
  }, [reviewRequest]);
  const [error, setError] = useState("");
  const snippets = config.snippets.filter(
    (s) =>
      snippetAvailable(s, workspace, session?.hostId) &&
      [s.name, s.command, s.category]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const newSnippet = () =>
    setEditing({
      id: uid(),
      name: "",
      command: "",
      category: "Linux Administration",
      scope: "global",
      favorite: false,
      workspaceId: workspace,
      hostId: session?.hostId,
    });
  const canExecute = executing && executing.sessionId === session?.id && canRunHere(executing.snippet);
  const exportSnippets = async () => {
    try {
      const path = await saveDialog({ defaultPath: "vexssh-snippets.json" });
      if (path) {
        await request("snippets_export", { path });
        notify("Snippets exported");
      }
    } catch (e) {
      notify(message(e), true);
    }
  };
  const importSnippets = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        const result = await request<Config>("snippets_import", { path });
        await save(result);
        notify("Snippets imported");
      }
    } catch (e) {
      notify(message(e), true);
    }
  };
  return (
    <section className="page">
      <PageHeader
        title="Command library"
        description="Keep frequently used commands ready for your next session."
      >
        <Button onClick={() => void importSnippets()}>
          <Upload size={16} />
          Import
        </Button>
        <Button onClick={() => void exportSnippets()}>
          <Download size={16} />
          Export
        </Button>
        <Button variant="primary" onClick={newSnippet}>
          <Plus size={16} />
          New snippet
        </Button>
      </PageHeader>
      <label className="search-input compact">
        <Search size={16} />
        <input
          aria-label="Search snippets"
          placeholder="Search commands and categories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {!snippets.length ? (
        <Empty
          title="Make your commands reusable"
          description="Save a command or a template with {{variables}}. Review the final command before sending it to a terminal."
          action={
            <Button variant="primary" onClick={newSnippet}>
              Create snippet
            </Button>
          }
        />
      ) : (
        <div className="snippet-grid">
          {snippets.map((s) => (
            <article className="snippet-card" key={s.id}>
              <header>
                <div>
                  <span className="muted small">
                    {s.category} · {s.scope}
                  </span>
                  <h2>{s.name}</h2>
                </div>
                <IconButton
                  label={s.favorite ? "Remove favorite" : "Favorite snippet"}
                  onClick={() =>
                    void save({
                      ...config,
                      snippets: config.snippets.map((x) =>
                        x.id === s.id ? { ...x, favorite: !x.favorite } : x,
                      ),
                    }).catch((e) => notify(message(e), true))
                  }
                >
                  <Star size={16} fill={s.favorite ? "currentColor" : "none"} />
                </IconButton>
              </header>
              <pre>{s.command}</pre>
              <footer>
                <div className="toolbar">
                  <IconButton
                    label="Edit snippet"
                    onClick={() => setEditing(s)}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    label="Copy command"
                    onClick={() =>
                      void writeClipboardText(s.command)
                        .then(() => notify("Command copied"))
                        .catch((e) => notify(message(e), true))
                    }
                  >
                    <Copy size={15} />
                  </IconButton>
                  <IconButton
                    label="Delete snippet"
                    onClick={() => setDeleting(s)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
                <Button
                  disabled={!canRunHere(s)}
                  onClick={() => review(s)}
                >
                  <Play size={14} />
                  Review & run
                </Button>
              </footer>
            </article>
          ))}
        </div>
      )}
      <Modal
        open={!!editing}
        onOpenChange={(v) => {
          if (!v) setEditing(null);
        }}
        title={
          config.snippets.some((s) => s.id === editing?.id)
            ? "Edit snippet"
            : "New snippet"
        }
        wide
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editing) return;
            try {
              await save({
                ...config,
                snippets: config.snippets.some((s) => s.id === editing.id)
                  ? config.snippets.map((s) =>
                      s.id === editing.id ? editing : s,
                    )
                  : [...config.snippets, editing],
              });
              setEditing(null);
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          <div className="modal-body form-grid">
            <Field label="Name">
              <input
                required
                value={editing?.name || ""}
                onChange={(e) =>
                  setEditing((s) => (s ? { ...s, name: e.target.value } : s))
                }
              />
            </Field>
            <Field label="Category">
              <input
                required
                value={editing?.category || ""}
                onChange={(e) =>
                  setEditing((s) =>
                    s ? { ...s, category: e.target.value } : s,
                  )
                }
                list="snippet-categories"
              />
              <datalist id="snippet-categories">
                {[
                  "Linux Administration",
                  "Docker",
                  "Git",
                  "Nginx",
                  "MySQL",
                  "PostgreSQL",
                  "System Monitoring",
                  "Network Tools",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </datalist>
            </Field>
            <Field label="Scope">
              <select
                value={editing?.scope || "global"}
                onChange={(e) =>
                  setEditing((s) =>
                    s ? { ...s, scope: e.target.value as Snippet["scope"] } : s,
                  )
                }
              >
                <option value="global">All workspaces</option>
                <option value="workspace">Current workspace</option>
                <option value="host" disabled={!session}>
                  Active host
                </option>
              </select>
            </Field>
            <div className="span-2">
              <Field
                label="Command"
                hint="Use {{name}} placeholders for values you want to fill before running."
              >
                <textarea
                  className="code-input"
                  required
                  rows={6}
                  value={editing?.command || ""}
                  onChange={(e) =>
                    setEditing((s) =>
                      s ? { ...s, command: e.target.value } : s,
                    )
                  }
                />
              </Field>
            </div>
            <ErrorBox error={error} />
          </div>
          <footer className="modal-footer">
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" type="submit">
              Save snippet
            </Button>
          </footer>
        </form>
      </Modal>
      <Modal
        open={!!executing}
        onOpenChange={(v) => {
          if (!v) setExecuting(null);
        }}
        title="Review command"
        description={`This command will run on ${executing?.sessionName || "the selected session"}.`}
      >
        <div className="modal-body">
          <Field label="Command to execute">
            <textarea
              className="code-input"
              rows={5}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </Field>
          {/\{\{.*?\}\}/.test(command) && (
            <ErrorBox error="Replace each {{variable}} before executing." />
          )}
          {executing && !canExecute && <ErrorBox error="The reviewed SSH session is no longer available here. Close and review the snippet on the intended session." />}
          {/\b(rm|mkfs|dd|shutdown|reboot|truncate|drop|delete)\b/i.test(
            command,
          ) && (
            <div className="warning-box">
              This command can delete data or interrupt services. Verify the
              target and arguments before executing.
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <Button onClick={() => setExecuting(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              !command.trim() ||
              /\{\{.*?\}\}/.test(command) ||
              !canExecute
            }
            onClick={() => {
              if (!executing || !canExecute) return;
              run({ ...executing.snippet, command: command + "\r" }, executing.sessionId);
              setExecuting(null);
            }}
          >
            Execute on {executing?.sessionName}
          </Button>
        </footer>
      </Modal>
      <Confirm
        open={!!deleting}
        title="Delete snippet?"
        description={`Remove ${deleting?.name} from your library.`}
        danger
        confirmLabel="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          save({
            ...config,
            snippets: config.snippets.filter((s) => s.id !== deleting?.id),
          })
        }
      />
    </section>
  );
}
export function SettingsView({
  config,
  appearance,
  save,
  notify,
  reload,
}: {
  config: Config;
  appearance: Exclude<AppTheme, "system">;
  save: (c: Config) => Promise<void>;
  notify: Notify;
  reload: () => Promise<void>;
}) {
  const [tab, setTab] = useState("Appearance");
  const terminalCategory = useRef<HTMLButtonElement>(null);
  const [changes, setChanges] = useState<Partial<Settings>>({});
  const draft = { ...config.settings, ...changes };
  let previewPalette = draft.terminalTheme;
  if (draft.followAppTheme) {
    previewPalette = appearance;
    if (draft.theme !== config.settings.theme) {
      previewPalette = draft.theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : draft.theme;
    }
  }
  const palette = getTerminalTheme(previewPalette);
  const previewColors = getTerminalTheme(previewPalette, draft.terminalForeground);
  const invalidForeground = !!draft.terminalForeground && !validTerminalForeground(draft.terminalForeground);
  const invalidTransferLimit = !validSftpLimit(draft.sftpUploadLimitKiB) || !validSftpLimit(draft.sftpDownloadLimitKiB);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<"export" | "import" | null>(null);
  const [password, setPassword] = useState("");
  const [known, setKnown] = useState<
    { hostId: string; hostname?: string; fingerprint: string }[]
  >([]);
  const [remove, setRemove] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setChanges(current => {
      if (current.sidebarCollapsed === undefined) return current;
      const next = { ...current };
      delete next.sidebarCollapsed;
      return next;
    });
  }, [config.settings.sidebarCollapsed]);
  useEffect(() => {
    if (tab === "Security")
      void request<typeof known>("known_hosts_list")
        .then(setKnown)
        .catch((e) => setError(message(e)));
  }, [tab]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setChanges(current => ({ ...current, [key]: value }));
  const persist = async () => {
    if (invalidForeground) {
      setTab("Terminal");
      return;
    }
    if (invalidTransferLimit) {
      setTab("File transfer");
      return;
    }
    setBusy(true);
    try {
      await save({ ...config, settings: draft });
      setChanges({});
      notify("Settings saved");
    } catch (e) {
      notify(message(e), true);
    } finally {
      setBusy(false);
    }
  };
  const backupAction = async () => {
    setBusy(true);
    setError("");
    try {
      const path =
        backup === "export"
          ? await saveDialog({
              defaultPath: password
                ? "vexssh-backup.enc"
                : "vexssh-config.json",
            })
          : await open({ multiple: false });
      if (path) {
        await request(backup === "export" ? "backup_export" : "backup_import", {
          path,
          password: password || undefined,
        });
        if (backup === "import") {
          await reload();
          setChanges({});
        }
        notify(
          backup === "export"
            ? "Configuration exported"
            : "Configuration restored",
        );
        setBackup(null);
        setPassword("");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="page settings-page">
      <PageHeader
        title="Settings"
        description="Make this workspace feel like yours."
      >
        <Button variant="primary" busy={busy} disabled={(tab === "Terminal" && invalidForeground) || (tab === "File transfer" && invalidTransferLimit)} onClick={() => void persist()}>
          <Save size={15} />
          Save changes
        </Button>
      </PageHeader>
      <div className="settings-layout">
        <nav aria-label="Settings categories" className="settings-nav">
          {[
            "Appearance",
            "Terminal",
            "Connections",
            "Security",
            "File transfer",
            "Keyboard shortcuts",
            "General",
            "Updates",
          ].map((x) => (
            <button
              key={x}
              ref={x === "Terminal" ? terminalCategory : undefined}
              className={tab === x ? "active" : ""}
              aria-current={tab === x ? "page" : undefined}
              onClick={() => setTab(x)}
            >
              {x}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <h2>{tab}</h2>
          {tab === "Appearance" && (
            <>
              <div className="theme-options" role="group" aria-label="Application theme">
                {appThemeOptions.map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    className={`theme-option ${draft.theme === theme ? "selected" : ""}`}
                    aria-pressed={draft.theme === theme}
                    onClick={() => set("theme", theme)}
                  >
                    <span className={`theme-swatch ${theme}`} data-app-theme={theme} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="theme-option-label">
                      {appThemes[theme].label}
                      {draft.theme === theme && <Check size={13} aria-hidden="true" />}
                    </span>
                  </button>
                ))}
              </div>
              <div className="appearance-controls">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={draft.sidebarCollapsed}
                    onChange={(e) => set("sidebarCollapsed", e.target.checked)}
                  />
                  Compact sidebar
                </label>
                <button type="button" className="text-button" onClick={() => {
                  setTab("Terminal");
                  terminalCategory.current?.focus();
                }}>
                  Terminal colors and fonts <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
          {tab === "Terminal" && (
            <div className="form-grid">
              <Field label="Terminal font">
                <select
                  value={draft.fontFamily}
                  onChange={(e) => set("fontFamily", e.target.value)}
                >
                  {!terminalFontFamilies.includes(draft.fontFamily) && <option>{draft.fontFamily}</option>}
                  {terminalFontFamilies.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </Field>
              <Field label="Font size">
                <input
                  type="number"
                  min={10}
                  max={32}
                  value={draft.fontSize}
                  onChange={(e) => set("fontSize", Number(e.target.value))}
                />
              </Field>
              <Field label="Cursor style">
                <select
                  value={draft.cursorStyle}
                  onChange={(e) =>
                    set(
                      "cursorStyle",
                      e.target.value as Settings["cursorStyle"],
                    )
                  }
                >
                  <option value="block">Block</option>
                  <option value="bar">Bar</option>
                  <option value="underline">Underline</option>
                </select>
              </Field>
              <div>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={draft.copyOnSelect}
                    onChange={(e) => set("copyOnSelect", e.target.checked)}
                  />
                  Automatically copy mouse selections
                </label>
                <small className="field-note">Right-click to paste. Shift+right-click opens the terminal menu.</small>
              </div>
              <Field label="Terminal color theme">
                <select
                  value={draft.followAppTheme ? "app" : draft.terminalTheme}
                  onChange={(event) => {
                    const palette = event.target.value;
                    setChanges(s => ({ ...s, followAppTheme: palette === "app",
                      ...(palette === "app" ? {} : { terminalTheme: palette as Settings["terminalTheme"] }) }));
                  }}
                >
                  <option value="app">Follow app theme</option>
                  <TerminalPaletteOptions />
                </select>
              </Field>
              <TerminalTextColor value={draft.terminalForeground}
                fallback={palette.foreground!} background={palette.background!} resetLabel="Reset to theme color"
                onChange={color => set("terminalForeground", color)} />
              <TerminalPreview colors={previewColors} fontFamily={draft.fontFamily}
                fontSize={draft.fontSize} cursorStyle={draft.cursorStyle} />
              <p className="field-note span-2">
                Shell command history and completion use the connected server’s
                shell. Commands sent from the command bar are available for
                completion during the session.
              </p>
              <div className="span-2">
                <TerminalProfiles config={config} appearance={appearance} save={save} notify={notify} />
              </div>
            </div>
          )}
          {tab === "Connections" && (
            <div className="form-grid">
              <Field label="Default SSH port">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.defaultPort}
                  onChange={(e) => set("defaultPort", Number(e.target.value))}
                />
              </Field>
              <Field label="Connection timeout (seconds)">
                <input
                  type="number"
                  min={3}
                  max={300}
                  value={draft.timeout}
                  onChange={(e) => set("timeout", Number(e.target.value))}
                />
              </Field>
              <Field label="Keepalive interval (seconds)">
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={draft.keepalive}
                  onChange={(e) => set("keepalive", Number(e.target.value))}
                />
              </Field>
              <Field
                label="Automatic reconnect attempts"
                hint="0 disables automatic reconnect. Changed fingerprints always require approval."
              >
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={draft.reconnectAttempts}
                  onChange={(event) =>
                    set("reconnectAttempts", Number(event.target.value))
                  }
                />
              </Field>
              <Field label="Reconnect delay (seconds)">
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={draft.reconnectDelay}
                  onChange={(event) =>
                    set("reconnectDelay", Number(event.target.value))
                  }
                />
              </Field>
              <p className="field-note span-2">
                Host-specific connection settings override these defaults.
              </p>
            </div>
          )}
          {tab === "Security" && (
            <>
              <div className="security-note">
                <ShieldCheck size={20} />
                <span>
                  Server fingerprints require your approval on the first
                  connection and whenever a key changes.
                </span>
              </div>
              <h3>Known hosts</h3>
              <ErrorBox error={error} />
              {!known.length ? (
                <p>No server fingerprints have been saved.</p>
              ) : (
                known.map((k) => (
                  <div className="known-host" key={k.hostId}>
                    <div>
                      <strong>
                        {config.hosts.find((h) => h.id === k.hostId)?.name ||
                          k.hostname ||
                          k.hostId}
                      </strong>
                      <code>{k.fingerprint}</code>
                    </div>
                    <IconButton
                      label="Forget server fingerprint"
                      onClick={() => setRemove(k.hostId)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                ))
              )}
            </>
          )}
          {tab === "File transfer" && (
            <>
              <Field label="Default download folder">
                <div className="input-action">
                  <input
                    value={draft.downloadDirectory}
                    onChange={(e) => set("downloadDirectory", e.target.value)}
                  />
                  <Button
                    onClick={async () => {
                      try {
                        const path = await open({
                          directory: true,
                          multiple: false,
                        });
                        if (path) set("downloadDirectory", path);
                      } catch (e) {
                        notify(message(e), true);
                      }
                    }}
                  >
                    Browse
                  </Button>
                </div>
              </Field>
              <Field label="Concurrent transfers">
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={draft.transferConcurrency}
                  onChange={(e) =>
                    set("transferConcurrency", Number(e.target.value))
                  }
                />
              </Field>
              {([
                ["sftpUploadLimitKiB", "SFTP upload limit (KiB/s)"],
                ["sftpDownloadLimitKiB", "SFTP download limit (KiB/s)"],
              ] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input type="number" min={0} max={maxSftpLimitKiB} step={1}
                    value={Number.isFinite(draft[key]) ? draft[key] : ""}
                    aria-invalid={!validSftpLimit(draft[key])} aria-describedby="sftp-limit-help"
                    onChange={event => set(key, event.currentTarget.valueAsNumber)} />
                </Field>
              ))}
              <p className="field-note" id="sftp-limit-help">
                {invalidTransferLimit && "Enter a whole number from 0 to 1,048,576. "}
                Set 0 for unlimited speed. Active SFTP transfers share the limit for their direction.
              </p>
              <p>
                Interrupted transfers can be retried from the transfer history.
              </p>
            </>
          )}
          {tab === "Keyboard shortcuts" && (
            <div className="shortcut-list">
              {[
                ["New terminal", "Ctrl + Shift + T"],
                ["Close terminal", "Ctrl + Shift + W"],
                ["Next terminal", "Ctrl + Tab"],
                ["Previous terminal", "Ctrl + Shift + Tab"],
                ["Switch to last used tab", "Ctrl + Shift + Space"],
                ["Search terminal", "Ctrl + Shift + F"],
                ["Toggle window full screen", "F11"],
                ["Command palette", "Ctrl + Shift + P"],
              ].map(([label, key]) => (
                <div key={label}>
                  <span>{label}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
          )}
          {tab === "General" && (
            <>
              <h3>Session shortcuts</h3>
              <Field label="Switch Terminal / SFTP">
                <select value={viewShortcut(draft.sessionViewShortcut)}
                  onChange={(event) => set("sessionViewShortcut", viewShortcut(event.target.value))}>
                  {viewShortcuts.map((shortcut) => <option key={shortcut}>{shortcut}</option>)}
                </select>
              </Field>
              <h3>Workspace restoration</h3>
              <label className="checkbox-field">
                <input type="checkbox" checked={draft.restoreWorkspace} onChange={(event) => set("restoreWorkspace", event.target.checked)} />
                Restore tabs and layout when VEXSSH opens
              </label>
              <p>Restored tabs wait for you to connect. Credentials, terminal output, and commands are not saved with the layout.</p>
              <h3>Configuration backup</h3>
              <p>
                Export hosts, groups, snippets, workspace settings, and terminal
                preferences. Set a password to encrypt the backup.
              </p>
              <div className="toolbar">
                <Button onClick={() => setBackup("export")}>
                  <Download size={16} />
                  Export configuration
                </Button>
                <Button onClick={() => setBackup("import")}>
                  <Upload size={16} />
                  Restore configuration
                </Button>
              </div>
              <div className="security-note">
                <ShieldCheck size={18} />
                <span>
                  Credentials and private keys stay in secure storage on this
                  device.
                </span>
              </div>
              <h3>VEXSSH</h3>
              <p>Version {appVersion} · Desktop SSH workspace</p>
            </>
          )}
          {tab === "Updates" && <UpdatesPanel />}
        </div>
      </div>
      <Modal
        open={!!backup}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setBackup(null);
            setPassword("");
          }
        }}
        title={
          backup === "export" ? "Export configuration" : "Restore configuration"
        }
        description={
          backup === "export"
            ? "Choose an optional password to encrypt the backup."
            : "Restoring replaces the current configuration. Export a backup first to keep a recoverable copy."
        }
      >
        <div className="modal-body">
          <Field label="Backup password (optional)">
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorBox error={error} />
        </div>
        <footer className="modal-footer">
          <Button onClick={() => setBackup(null)}>Cancel</Button>
          <Button
            busy={busy}
            variant="primary"
            onClick={() => void backupAction()}
          >
            {backup === "export" ? "Choose destination" : "Choose backup file"}
          </Button>
        </footer>
      </Modal>
      <Confirm
        open={!!remove}
        title="Forget server fingerprint?"
        description="The next connection to this server will require fingerprint approval again."
        confirmLabel="Forget fingerprint"
        danger
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          try {
            await request("known_hosts_delete", { hostId: remove });
            setKnown(known.filter((k) => k.hostId !== remove));
          } catch (e) {
            notify(message(e), true);
          }
        }}
      />
    </section>
  );
}
