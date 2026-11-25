import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, PackageOpen, RefreshCw } from "lucide-react";
import { version } from "../package.json";
import { request } from "./api";
import { message, formatBytes } from "./types";
import { Button, ErrorBox } from "./ui";

interface UpdateStatus {
  currentVersion: string;
  source: "local";
  canInstall: boolean;
  canCancel?: boolean;
  pendingError?: string | null;
  pending: null | { version: string; size: number; sha256: string; installOnExit: boolean };
  lastResult?: { state: "installed" | "failed"; version: string; code: string; at: number } | null;
}
export function UpdatesPanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void request<UpdateStatus>("updates_status").then((next) => {
      if (!disposed) setStatus(next);
    }).catch((error) => { if (!disposed) setError(message(error)); });
    return () => { disposed = true; };
  }, []);
  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(true); setError("");
    try { setStatus(await request<UpdateStatus>(action, payload)); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const choose = async () => {
    try {
      const path = await open({ multiple: false, title: "Choose VEXSSH update package", filters: [{ name: "VEXSSH update package", extensions: ["zip"] }] });
      if (typeof path === "string") await run("updates_prepare", { path });
    } catch (error) { setError(message(error)); }
  };
  const resultMessages: Record<string, string> = {
    installed: `Updated to VEXSSH ${status?.lastResult?.version || version}.`,
    update_start_failed: "The update could not start. Your existing installation remains available. Choose the package again to retry.",
    installation_failed: "The update could not be installed. Choose the package again to retry.",
    rollback_failed: "The update could not be restored automatically. Reinstall VEXSSH before retrying the update.",
    restart_failed: "The update was installed. Open VEXSSH again from your taskbar.",
  };
  return <div className="updates-panel">
    <p>VEXSSH {status?.currentVersion || version}</p>
    <p>Choose a VEXSSH update package from this device. Updates are installed after you close the app and keep your existing taskbar launcher.</p>
    <div className="toolbar">
      <Button busy={busy} onClick={() => void choose()}><PackageOpen size={16} />Choose update package</Button>
      <Button disabled={busy} onClick={() => void run("updates_status")}><RefreshCw size={15} />Refresh status</Button>
    </div>
    <ErrorBox error={error} />
    <ErrorBox error={status?.pendingError || ""} />
    {status?.canCancel && !status.pending && <Button disabled={busy} onClick={() => void run("updates_cancel")}>Clear pending update</Button>}
    {status?.pending && <div className="update-summary" role="status">
      <strong>VEXSSH {status.pending.version} is ready</strong>
      <span className="update-state ready"><CheckCircle2 size={16} />Verified package · {formatBytes(status.pending.size)}</span>
      {status.pending.installOnExit
        ? <p>This update will install when you close VEXSSH. Finish your SSH work and save any file edits before closing.</p>
        : <p>Your current sessions keep running until you choose to close the app.</p>}
      {!status.canInstall && <p>Open the installed VEXSSH application to schedule this update.</p>}
      <div className="toolbar">
        {!status.pending.installOnExit && <Button variant="primary" disabled={busy || !status.canInstall} onClick={() => void run("updates_install_on_exit")}>Install when VEXSSH closes</Button>}
        <Button disabled={busy} onClick={() => void run("updates_cancel")}>{status.pending.installOnExit ? "Cancel scheduled update" : "Remove package"}</Button>
      </div>
    </div>}
    {status?.lastResult && <p className="update-state">{resultMessages[status.lastResult.code] || "The previous update could not finish. Choose the package again to retry."}</p>}
  </div>;
}
