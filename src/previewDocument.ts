import { Text, type ChangeSet } from "@codemirror/state";

// CodeMirror uses one position per line break. Keep the original separators so
// changing one line also works for files containing a mixture of LF and CRLF.
const separator = { L: "\n", C: "\r\n", R: "\r" } as const;
type Ending = keyof typeof separator;
export type PreviewDocument = { doc: Text; endings: string; preferred: Ending };

export function parsePreviewDocument(content: string): PreviewDocument {
  const breaks = /\r\n|\r|\n/g;
  const endings = (content.match(breaks) ?? [])
    .map((s) => s === "\n" ? "L" : s === "\r\n" ? "C" : "R").join("");
  return { doc: Text.of(content.split(breaks)), endings, preferred: (endings[0] || "L") as Ending };
}

export function updatePreviewDocument(previous: PreviewDocument, changes: ChangeSet, doc: Text): PreviewDocument {
  const parts: string[] = [];
  let consumed = 0;
  changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    const start = previous.doc.lineAt(from).number - 1;
    const end = previous.doc.lineAt(to).number - 1;
    parts.push(previous.endings.slice(consumed, start), previous.preferred.repeat(inserted.lines - 1));
    consumed = end;
  });
  parts.push(previous.endings.slice(consumed));
  return { doc, endings: parts.join(""), preferred: previous.preferred };
}

export function serializePreviewDocument({ doc, endings }: PreviewDocument): string {
  const parts: string[] = [];
  let i = 0;
  for (const line of doc.iterLines()) {
    parts.push(line, separator[endings[i++] as Ending] ?? "");
  }
  return parts.join("");
}

// Drop the matching prefix and suffix so even a change at the end of a large
// file is immediately visible. Show end-of-line differences explicitly.
export function changedRegion(server: string, draft: string) {
  const split = (s: string) => s.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const before = split(server);
  const after = split(draft);
  let start = 0;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (start < beforeEnd && start < afterEnd && before[start] === after[start]) start++;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const region = (lines: string[], end: number) => {
    const text = lines.slice(start, end).join("");
    return {
      range: end === start ? "No lines" : end === start + 1 ? `Line ${end}` : `Lines ${start + 1}–${end}`,
      text,
      endings: [...new Set(text.match(/\r\n|\r|\n/g) ?? [])]
        .map((eol) => eol === "\n" ? "LF" : eol === "\r" ? "CR" : "CRLF").join(", "),
      finalBreak: /[\r\n]$/.test(text),
    };
  };
  return [region(before, beforeEnd), region(after, afterEnd)] as const;
}
