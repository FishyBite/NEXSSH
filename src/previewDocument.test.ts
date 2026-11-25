import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { changedRegion, parsePreviewDocument, serializePreviewDocument, updatePreviewDocument } from "./previewDocument";

describe("terminal preview document", () => {
  it.each(["", "\r", "x\na\r\nb\rc\r\n", "x\r\n", "x\ny", "x"])("round trips text exactly", (text) => {
    expect(serializePreviewDocument(parsePreviewDocument(text))).toBe(text);
  });

  it("retains the untouched separators around multiple changes", () => {
    const previous = parsePreviewDocument("a\r\nb\nc\rd\r\n");
    const edits = ChangeSet.of([{ from: 2, to: 3, insert: "new\nline" }, { from: 6, to: 7 }], previous.doc.length);
    const updated = updatePreviewDocument(previous, edits, edits.apply(previous.doc));
    expect(serializePreviewDocument(updated)).toBe("a\r\nnew\r\nline\nc\r\r\n");
  });

  it("shows a changed line late in a file, including a removed final newline", () => {
    const unchanged = "head\n".repeat(3_000);
    const [server, draft] = changedRegion(unchanged + "old\n", unchanged + "new");
    expect(server).toMatchObject({ range: "Line 3001", text: "old\n", finalBreak: true });
    expect(draft).toMatchObject({ range: "Line 3001", text: "new", finalBreak: false });
  });

  it("represents both empty documents and inserted lines", () => {
    expect(changedRegion("", "one")[0]).toMatchObject({ range: "No lines", text: "" });
    expect(changedRegion("one\nnext", "one\ntwo\nnext")[1]).toMatchObject({ range: "Line 2", text: "two\n" });
  });
});
