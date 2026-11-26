import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { message } from "./types";

export interface DetectedPort {
  name: string;
  kind: "USB" | "Bluetooth" | "PCI" | "Serial";
  product: string | null;
  manufacturer: string | null;
  usbId: string | null;
  inUse: boolean;
}

type PortSnapshot = {
  ports: DetectedPort[];
  added: Map<string, number>;
};

export function serialPortLabel(port: DetectedPort) {
  let product = port.product?.trim() || "";
  const suffix = `(${port.name})`;
  if (product.toUpperCase().endsWith(suffix.toUpperCase())) product = product.slice(0, -suffix.length).trimEnd();
  const details = [product, port.manufacturer?.trim()].filter(Boolean);
  if (!details.length && port.kind !== "Serial") details.push(port.kind);
  if (port.usbId) details.push(port.usbId);
  return [port.name, ...new Set(details)].join(" · ");
}

// A successful first scan establishes which devices were already connected.
// Briefly retain subsequent arrivals across polls so a user can open the form.
export function updateSerialPorts(previous: PortSnapshot, current: DetectedPort[], now: number, baseline: boolean): PortSnapshot {
  const added = new Map<string, number>();
  for (const port of current) {
    if (baseline) continue;
    const last = previous.added.get(port.name);
    if (!previous.ports.some(p => p.name === port.name)) added.set(port.name, now);
    else if (last !== undefined && now - last < 30_000) added.set(port.name, last);
  }
  return { ports: current, added };
}

export function suggestedPort(current: string, snapshot: PortSnapshot) {
  if (snapshot.added.size > 1) return "";
  const selected = snapshot.ports.find(p => p.name === current);
  if (selected && !selected.inUse) return current;
  return snapshot.ports.find(p => snapshot.added.has(p.name) && !p.inUse)?.name ?? "";
}

export function useSerialPorts(visible: boolean) {
  const [snapshot, setSnapshot] = useState<PortSnapshot>({ ports: [], added: new Map() });
  const [listing, setListing] = useState(false);
  const [error, setError] = useState("");
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let pending = false;
    let baseline = true;
    let timer: number;
    let generation = 0;
    async function scan(showProgress: boolean) {
      if (pending || !active || document.hidden) return;
      clearTimeout(timer);
      pending = true;
      const scanGeneration = generation;
      if (showProgress || baseline) setListing(true);
      try {
        const ports = await request<DetectedPort[]>("serial_ports", { details: true });
        if (active && scanGeneration === generation) {
          const first = baseline;
          baseline = false;
          const now = Date.now();
          setSnapshot(previous => updateSerialPorts(previous, ports, now, first));
          setError("");
        }
      } catch (e) {
        if (active && scanGeneration === generation) setError(message(e));
      } finally {
        pending = false;
        if (active) {
          setListing(false);
          if (!document.hidden) timer = window.setTimeout(() => void scan(false), 1800);
        }
      }
    }
    const rescan = () => { void scan(true); };
    const visibilityChanged = () => {
      generation++;
      baseline = true;
      clearTimeout(timer);
      if (!document.hidden) rescan();
    };
    refresh.current = rescan;
    document.addEventListener("visibilitychange", visibilityChanged);
    rescan();
    return () => {
      active = false;
      clearTimeout(timer);
      refresh.current = () => {};
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [visible]);
  return { snapshot, listing, error, refresh: () => refresh.current() };
}
