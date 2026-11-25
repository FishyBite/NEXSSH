import { useSyncExternalStore } from "react";
import type { LayoutFolders } from "./namedLayouts";

// Native transport IDs change on reconnect. Never apply an old folder intent
// to a different transport, including a replacement for the same saved tab.
const listed = new Map<string, LayoutFolders>();
const requested = new Map<string, LayoutFolders>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function listedLayoutFolders(id: string): LayoutFolders {
  return { ...listed.get(id) };
}
export function recordLayoutFolder(id: string, side: keyof LayoutFolders, path: string) {
  listed.set(id, { ...listed.get(id), [side]: path });
}
export function requestLayoutFolders(id: string, folders: LayoutFolders) {
  if (!folders.remote && !folders.local) return;
  requested.set(id, { ...folders });
  for (const listener of listeners) listener();
}
export function useLayoutFolders(id: string | undefined) {
  return useSyncExternalStore(subscribe, () => id ? requested.get(id) : undefined);
}
export function consumeLayoutFolders(id: string, folders: LayoutFolders) {
  if (requested.get(id) === folders) {
    requested.delete(id);
    for (const listener of listeners) listener();
  }
}
export function forgetLayoutFolders(id: string) {
  listed.delete(id);
  requested.delete(id);
}
