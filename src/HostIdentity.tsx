import { Cloud, Database, Globe, Server, TerminalSquare } from "lucide-react";
import type { Host } from "./types";
import "./connection-cards.css";

const hostIcons = { server: Server, database: Database, globe: Globe, cloud: Cloud, terminal: TerminalSquare };

export function sessionHostLabel(sessionName: string, host?: Host) {
  if (!host || sessionName === host.name || sessionName.replace(/ · [1-9]\d*$/, "") === host.name) return sessionName;
  return sessionName + " · " + host.name;
}

export function HostMark({ host, size = 18 }: { host: Host; size?: number }) {
  const Icon = hostIcons[host.icon || "server"] || Server;
  const color = /^#[\da-f]{6}$/i.test(host.color) ? host.color : "#6C8CFF";
  const [r, g, b] = [1, 3, 5].map(start => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const ink = r * 0.2126 + g * 0.7152 + b * 0.0722 > 0.179 ? "#000" : "#fff";
  return <span className="host-mark" aria-hidden="true" style={{ backgroundColor: color, color: ink, width: size, height: size }}>
    <Icon size={size - 4} strokeWidth={2} />
  </span>;
}
