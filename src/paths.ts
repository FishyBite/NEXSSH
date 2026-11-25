export function parentPath(path: string): string {
  const value = path.replace(/[\\/]+$/, "");
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (/^[A-Za-z]:[\\/]/.test(path) && separator <= 2) return path.slice(0, 3);
  return separator > 0
    ? value.slice(0, separator)
    : path.startsWith("/")
      ? "/"
      : path;
}
