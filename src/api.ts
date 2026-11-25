import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
export const desktop = isTauri();
export async function request<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  if (!desktop)
    throw new Error(
      "Open VEXSSH desktop to use SSH, your saved configuration, and local files.",
    );
  return invoke<T>("request", { action, payload });
}
export async function subscribe<T>(
  event: string,
  handler: (payload: T) => void,
) {
  if (!desktop) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}
