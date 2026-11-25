import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { IconButton } from "./ui";
import "./connection-cards.css";

export function serverAddress(user: string, host: string, port?: number) {
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return (user ? user + "@" : "") + address + (port ? ":" + port : "");
}

type Props = {
  name: string;
  address: string;
  icon: ReactNode;
  method: ReactNode;
  label?: string;
  details?: ReactNode;
  status?: string;
  active?: boolean;
  disabled?: boolean;
  color?: string;
  favorite?: ReactNode;
  actions?: ReactNode;
  selectControl?: ReactNode;
  onOpen: () => void;
};

export function ConnectionCard({ name, address, icon, method, label, details, status,
  active, disabled, color, favorite, actions, selectControl, onOpen }: Props) {
  return <article className={"connection-card" + (active ? " is-current" : "")}>
    <button type="button" className="connection-card-open" aria-label={label || name}
      title={(label || "Connect to " + name) + "\n" + address} disabled={disabled} onClick={onOpen}>
      <span className="connection-card-top">
        <span className="connection-card-icon" style={{color}} aria-hidden="true">{icon}</span>
        <span className="connection-card-identity">
          <strong>{name}{favorite}</strong>
          <span className="connection-card-address">{address}</span>
        </span>
      </span>
      <span className="connection-card-meta">
        <span className="connection-method">{method}</span>
        {details}
        {status && <span className="connection-live"><i aria-hidden="true" />{status}</span>}
      </span>
    </button>
    {actions && <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><IconButton className="connection-card-menu" label={`Actions for ${name}`}><MoreHorizontal size={16} /></IconButton></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="ui-menu" align="end" sideOffset={4} collisionPadding={8}>{actions}</DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>}
    {selectControl}
  </article>;
}
