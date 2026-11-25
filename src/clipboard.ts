import { request } from "./api";

// Clipboard operations from different panes share the same Windows clipboard.
let pending = Promise.resolve();

function inOrder<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function writeClipboardText(text: string): Promise<void> {
  return inOrder(() => request<void>("clipboard_write_text", { text }));
}

export function readClipboardText(): Promise<string> {
  return inOrder(() => request<string>("clipboard_read_text"));
}
