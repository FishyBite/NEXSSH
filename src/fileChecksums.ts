import type { FileEntry } from "./types";

export function checksumFiles(
  local: FileEntry[],
  remote: FileEntry[],
  selected: { local: string[]; remote: string[] },
) {
  if (selected.local.length > 1 || selected.remote.length > 1) return;
  let left = local.find((entry) => entry.path === selected.local[0]);
  let right = remote.find((entry) => entry.path === selected.remote[0]);
  if (!left && !selected.local.length && right) left = local.find((entry) => entry.name === right!.name);
  if (!right && !selected.remote.length && left) right = remote.find((entry) => entry.name === left!.name);
  if (!left || !right || left.isDir || left.isSymlink || right.isDir || right.isSymlink) return;
  return { local: left, remote: right };
}
