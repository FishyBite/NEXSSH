import { useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Play } from "lucide-react";
import { request } from "./api";
import { message, type Session, type Transfer } from "./types";

export function ResumeTransferButton({ session, items, notify, onQueued }: {
  session: Session; items: Transfer[]; notify: (text: string, error?: boolean) => void; onQueued?: () => void;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const resume = async (item: Transfer) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await request("transfer_resume", {id: item.id, requiredSessionId: session.id, tabId: session.tabId || session.id});
      onQueued?.();
      notify(`Resume queued for ${item.source}`);
    } catch (error) { notify(message(error), true); }
    finally { pending.current = false; setBusy(false); }
  };
  const title = items.length === 1 ? `Resume ${items[0].source} on ${session.name}` :
    `Choose a file to resume on ${session.name} (${items.length} available)`;
  const button = <button type="button" className="session-transfer" aria-label={title} title={title} disabled={busy}
    onClick={items.length === 1 ? () => void resume(items[0]) : undefined}><Play size={12} /> {items.length === 1 ? "Resume" : "Resume…"}</button>;
  if (items.length === 1) return button;
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild>{button}</DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="terminal-menu transfer-recovery-menu" align="start" sideOffset={4}>
      <DropdownMenu.Label className="terminal-menu-label">Choose a file to resume</DropdownMenu.Label>
      {items.map((item) => <DropdownMenu.Item key={item.id} title={item.destination}
        onSelect={() => void resume(item)}>{item.direction === "download" ? "Download" : "Upload"} {item.source}
        <small>{item.destination}</small></DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
