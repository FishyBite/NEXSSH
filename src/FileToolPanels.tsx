import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Folder, Pause, Play, Trash2, X } from "lucide-react";
import { request } from "./api";
import { writeClipboardText } from "./clipboard";
import type { FolderPair } from "./fileLocations";
import { Button, ErrorBox, Field, IconButton, Modal, clockDate } from "./ui";
import { formatBytes, message, type Host, type Transfer } from "./types";
import { fileSessionBinding } from "./fileSessions";

export function PairDialog({
  pairs,
  hosts,
  canSave,
  onSave,
  onRemove,
  onVisit,
  onClose,
}: {
  pairs: FolderPair[];
  hosts: Host[];
  canSave: boolean;
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
  onVisit: (pair: FolderPair) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Folder pairs"
    >
      <div className="modal-body file-pair-list">
        {pairs.map((pair) => {
          const host = hosts.find((h) => h.id === pair.hostId);
          const valid =
            host && pair.binding === fileSessionBinding(pair.hostId, hosts);
          return (
            <div className="file-pair-item" key={pair.id}>
              <button
                type="button"
                disabled={!valid}
                onClick={() => onVisit(pair)}
              >
                <Folder size={16} />
                <span>
                  <strong>{pair.name}</strong>
                  <small>{pair.local}</small>
                  <small>
                    {host?.name || "Removed host"} · {pair.remote}
                  </small>
                  {!valid && (
                    <small>Connection profile changed. Save a new pair.</small>
                  )}
                </span>
              </button>
              <IconButton
                label={`Remove folder pair ${pair.name}`}
                onClick={() => onRemove(pair.id)}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          );
        })}
        {!pairs.length && (
          <p>Save the two open folders to return to them together.</p>
        )}
        <form
          className="file-pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && name.trim()) {
              onSave(name.trim());
              setName("");
            }
          }}
        >
          <Field label="Pair name">
            <input
              value={name}
              maxLength={100}
              placeholder="e.g. Keysafe"
              disabled={!canSave}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!canSave || !name.trim()}>
            <Folder size={15} />
            Save current pair
          </Button>
        </form>
      </div>
    </Modal>
  );
}

export function useConflictReview(
  transfers: Transfer[],
  enabled: boolean,
  refresh: () => void,
) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [chosen, setChosen] = useState("");
  const active = transfers.filter(
    (t) => t.status === "conflict" && t.conflict?.token,
  );
  const item =
    enabled &&
    (active.find((t) => t.id === chosen) ||
      active.find((t) => !dismissed.includes(t.conflict!.token)));
  const close = (token: string) => {
    setDismissed((items) => [...items.slice(-200), token]);
    setChosen("");
  };
  return {
    review: setChosen,
    modal:
      item && item.conflict ? (
        <ConflictDialog
          key={item.conflict.token}
          transfer={item}
          onClose={() => close(item.conflict!.token)}
          onResolved={refresh}
        />
      ) : null,
  };
}

function ConflictDialog({
  transfer,
  onClose,
  onResolved,
}: {
  transfer: Transfer;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [apply, setApply] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const c = transfer.conflict!;
  const decide = async (choice: "skip" | "keepBoth" | "replace") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(choice);
    try {
      await request("transfer_resolve", {
        id: transfer.id,
        token: c.token,
        choice,
        applyToAll: apply,
      });
      onClose();
      onResolved();
    } catch (e) {
      setError(message(e));
      onResolved();
    } finally {
      pending.current = false;
      setBusy("");
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Destination already exists"
      description="Choose how to handle this transfer."
    >
      <div className="modal-body transfer-conflict">
        {(
          [
            [transfer.sourceHostName ? `Incoming · ${transfer.sourceHostName}` : "Incoming", c.source, c.sourceSize, c.sourceModified],
            [
              transfer.destinationHostName ? `Existing · ${transfer.destinationHostName}` : "Existing",
              c.destination,
              c.destinationSize,
              c.destinationModified,
            ],
          ] as const
        ).map(([label, path, size, date]) => (
          <div key={label}>
            <strong>{label}</strong>
            <code>{path}</code>
            <small>
              {formatBytes(size)} ·{" "}
              {date == null ? "Unknown modification time" : clockDate(date)}
            </small>
          </div>
        ))}
        <label>
          <input
            type="checkbox"
            checked={apply}
            onChange={(e) => setApply(e.target.checked)}
          />
          Apply to remaining conflicts in this batch
        </label>
        <ErrorBox error={error} />
      </div>
      <footer className="modal-footer">
        <Button
          disabled={!!busy}
          busy={busy === "skip"}
          onClick={() => void decide("skip")}
        >
          Skip
        </Button>
        <Button
          variant="primary"
          disabled={!!busy}
          busy={busy === "keepBoth"}
          onClick={() => void decide("keepBoth")}
        >
          Keep both
        </Button>
        <Button
          variant="danger"
          disabled={!c.canReplace || !!busy}
          busy={busy === "replace"}
          onClick={() => void decide("replace")}
        >
          Replace
        </Button>
      </footer>
    </Modal>
  );
}

export type LogSource = {
  sessionId: string;
  binding: string;
  name: string;
  path: string;
};
type TailCursor = { offset: number; anchor: string };
type TailResult = {
  text: string;
  cursor: TailCursor;
  reset: boolean;
  more: boolean;
};

export function LogPanel({
  source,
  available,
  close,
}: {
  source: LogSource;
  available: boolean;
  close: () => void;
}) {
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{
    index: number;
    text: string;
  } | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [retry, setRetry] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    if (!available) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let cursor: TailCursor | undefined;
    const viewerId = crypto.randomUUID();
    const release = () => {
      void request("file_tail_close", { viewerId }).catch(() => {});
    };
    const poll = async () => {
      if (closed) return;
      if (pausedRef.current) {
        timer = setTimeout(poll, 400);
        return;
      }
      try {
        const result = await request<TailResult>("file_tail", {
          side: "remote",
          viewerId,
          sessionId: source.sessionId,
          path: source.path,
          cursor,
        });
        if (closed) {
          release();
          return;
        }
        if (!pausedRef.current) {
          const fresh = !cursor || result.reset;
          cursor = result.cursor;
          if (fresh || result.text) {
            setContent((prev) =>
              ((fresh ? "" : prev) + result.text)
                .slice(-256 * 1024)
                .split("\n")
                .slice(-1000)
                .join("\n"),
            );
            if (fresh) setSelection(null);
          }
          setError("");
        }
        timer = setTimeout(
          poll,
          result.more && !pausedRef.current ? 100 : 1000,
        );
      } catch (e) {
        if (!closed) {
          setError(message(e));
          release();
        }
      }
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
      release();
    };
  }, [source.sessionId, source.path, available, retry]);
  useEffect(() => {
    if (following.current && !query && !paused && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [content, query, paused, folded]);
  const lines = content ? content.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const matches = lines
    .map((value, index) => ({ text: value.replace(/\r$/, ""), index }))
    .filter(
      (line) => !query || line.text.toLowerCase().includes(query.toLowerCase()),
    );
  const selected = matches.find(
    (line) => line.index === selection?.index && line.text === selection.text,
  );
  return createPortal(
    <aside className="file-log-panel" aria-label="Live log viewer">
      <header>
        <div>
          <strong>{source.path.split("/").pop()}</strong>
          <small title={source.path}>
            {source.name} · {source.path}
          </small>
        </div>
        <Button aria-expanded={!folded} onClick={() => setFolded((v) => !v)}>
          {folded ? "Expand" : "Collapse"}
        </Button>
        <IconButton label="Close log viewer" onClick={close}>
          <X size={16} />
        </IconButton>
      </header>
      {!folded && (
        <>
          <div className="file-log-tools">
            <Button
              aria-pressed={paused}
              disabled={!available || !!error}
              onClick={() => {
                pausedRef.current = !paused;
                setPaused(!paused);
              }}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}{" "}
              {paused ? "Resume" : "Pause"}
            </Button>
            <input
              aria-label="Search log lines"
              placeholder="Search lines…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              disabled={!selected}
              onClick={() => {
                if (selected)
                  void writeClipboardText(selected.text)
                    .then(() => setCopyError(""))
                    .catch((e) => setCopyError(message(e)));
              }}
            >
              <Copy size={14} />
              Copy line
            </Button>
          </div>
          {!available && (
            <p role="status">The original server session is disconnected.</p>
          )}
          {error && (
            <div className="file-log-error">
              <ErrorBox error={error} />
              <Button
                onClick={() => {
                  pausedRef.current = false;
                  setPaused(false);
                  setRetry((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </div>
          )}
          {copyError && <ErrorBox error={copyError} />}
          <div
            className="file-log-lines"
            ref={list}
            onScroll={(e) => {
              const el = e.currentTarget;
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            }}
          >
            {matches.map((line) => (
              <button
                key={line.index}
                aria-pressed={selected?.index === line.index}
                onClick={() => setSelection(line)}
              >
                {line.text || "\u00a0"}
              </button>
            ))}
            {!matches.length && (
              <small>
                {query ? "No matching lines" : "Waiting for log output…"}
              </small>
            )}
          </div>
        </>
      )}
    </aside>,
    document.body,
  );
}
