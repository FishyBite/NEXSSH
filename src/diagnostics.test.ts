import { describe, expect, it } from "vitest";
import { diagnosticPayload } from "./diagnostics";

describe("display error diagnostics", () => {
  it("keeps only the class and compiled asset locations, never the error message or path", () => {
    const error = new TypeError(
      "private-key-content fake-passphrase C:\\sensitive\\key",
    );
    error.stack =
      "TypeError: private-key-content fake-passphrase\n at run (http://tauri.localhost/assets/index-ABC.js:9:96771)\n at C:\\sensitive\\private-key:1:2\n at https://private-host.example/secret.js?token=secret:1:1";
    const payload = diagnosticPayload("react", error);
    expect(payload).toEqual({
      category: "react",
      errorClass: "TypeError",
      frames: [{ asset: "index-ABC.js", line: 9, column: 96771 }],
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /passphrase|private|sensitive|token|tauri\.localhost/,
    );
  });

  it("limits stack frames and extracts a React code without its URL arguments", () => {
    const error = new Error(
      "Minified React error #185; visit https://react.dev/errors/185?args[]=secret",
    );
    error.stack = `${error.message}\n${Array.from({ length: 25 }, () => " at f (http://tauri.localhost/assets/index-ABC.js:1:2)").join("\n")}`;
    const payload = diagnosticPayload("react", error);
    expect(payload.reactCode).toBe(185);
    expect(payload.frames).toHaveLength(12);
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("does not serialize rejection objects or strings", () => {
    expect(diagnosticPayload("rejection", { password: "secret" })).toEqual({
      category: "rejection",
      errorClass: "Unknown",
      frames: [],
    });
    expect(
      diagnosticPayload("rejection", "private-key-content").frames,
    ).toEqual([]);
  });
});
