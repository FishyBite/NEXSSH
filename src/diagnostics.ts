import { desktop, request } from "./api";

type ErrorCategory = "react" | "window" | "rejection";
const errorClasses = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
]);

export function diagnosticPayload(category: ErrorCategory, error: unknown) {
  let name = "Unknown";
  let stack = "";
  let reactCode: number | undefined;
  if (error instanceof Error) {
    if (errorClasses.has(error.name)) name = error.name;
    stack = typeof error.stack === "string" ? error.stack : "";
    const match = /^Minified React error #(\d{1,4});/.exec(error.message);
    if (match && Number(match[1]) > 0) reactCode = Number(match[1]);
  }
  const frames: { asset: string; line: number; column: number }[] = [];
  const locations =
    /(?:^|[\/\\])([A-Za-z0-9][A-Za-z0-9_-]{0,95}\.js):(\d{1,8}):(\d{1,8})(?=[\s)]|$)/gm;
  for (const match of stack
    .split("\n")
    .slice(1)
    .join("\n")
    .matchAll(locations)) {
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (line > 0 && line <= 10_000_000 && column > 0 && column <= 10_000_000) {
      frames.push({ asset: match[1], line, column });
    }
    if (frames.length === 12) break;
  }
  return {
    category,
    errorClass: name,
    ...(reactCode ? { reactCode } : {}),
    frames,
  };
}

let reports = 0;
export function reportDisplayError(category: ErrorCategory, error: unknown) {
  if (!desktop || reports >= 20) return;
  reports++;
  try {
    void request(
      "diagnostics_report",
      diagnosticPayload(category, error),
    ).catch(() => {});
  } catch {
    // Error reporting must not interrupt workspace recovery.
  }
}

export function installDisplayDiagnostics() {
  const onError = (event: ErrorEvent) =>
    reportDisplayError("window", event.error);
  const onRejection = (event: PromiseRejectionEvent) =>
    reportDisplayError("rejection", event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
