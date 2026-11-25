import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { request } from "./api";
import { Button, ErrorBox, Modal } from "./ui";
import { formatBytes, message, type FileEntry } from "./types";

interface Result {
  local: string;
  remote: string;
  matches: boolean;
}

function ChecksumDialog({ sessionId, local, remote, onClose }: {
  sessionId: string; local: FileEntry; remote: FileEntry; onClose: () => void;
}) {
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [bytes, setBytes] = useState(0);
  const localPath = local.path;
  const remotePath = remote.path;
  useEffect(() => {
    let active = true;
    let id: string | undefined;
    let timer: number | undefined;
    const cancel = (ticket: string) => void request("file_checksum_cancel", { id: ticket }).catch(() => {});
    async function verify() {
      try {
        id = await request<string>("file_checksum_prepare", { sessionId });
        if (!active) { cancel(id); return; }
        const update = async () => {
          try {
            const count = await request<number>("file_checksum_progress", { id });
            if (active) setBytes(count);
          } catch { return; } // Stop polling. The checksum request reports the result or error.
          if (active && id) timer = window.setTimeout(update, 500);
        };
        timer = window.setTimeout(update, 500);
        const response = await request<Result>("file_checksum_run", { id, localPath, remotePath });
        if (active) setResult(response);
      } catch (e) {
        if (active) setError(message(e));
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
        if (id && active) cancel(id);
        id = undefined;
      }
    }
    void verify();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      if (id) cancel(id);
    };
  }, [sessionId, localPath, remotePath]);
  const total = local.size + remote.size;
  return <Modal open title="Verify file contents" description="SHA-256 comparison" onOpenChange={(open) => { if (!open) onClose(); }}>
    <div className="modal-body file-checksum">
      {error ? <ErrorBox error={error} /> : <strong role="status">
        {result ? (result.matches ? "File contents match" : "File contents differ") : `Reading files · ${formatBytes(bytes)} processed`}
      </strong>}
      {!result && !error && <progress aria-label="File comparison progress" value={total ? Math.min(bytes, total) : undefined} max={Math.max(total, 1)} />}
      <dl>{(["local", "remote"] as const).map((side) => <div key={side}>
        <dt>{side === "local" ? "This computer" : "Remote server"}</dt>
        <dd>{side === "local" ? localPath : remotePath}</dd>
        {result && <dd><code>{result[side]}</code></dd>}
      </div>)}</dl>
    </div>
    <footer className="modal-footer"><Button onClick={onClose}>{result || error ? "Close" : "Cancel comparison"}</Button></footer>
  </Modal>;
}

export function FileChecksum({ sessionId, pair }: {sessionId: string; pair?: { local: FileEntry; remote: FileEntry }}) {
  const [open, setOpen] = useState(false);
  return <>
    <Button disabled={!pair} title="Select one file in each pane, or one file with a matching name in the other pane." onClick={() => setOpen(true)}>
      <Fingerprint size={15} /> Verify SHA-256
    </Button>
    {open && pair && <ChecksumDialog sessionId={sessionId} {...pair} onClose={() => setOpen(false)} />}
  </>;
}
