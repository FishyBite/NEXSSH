import { describe, expect, it } from "vitest";
import { csvFilename, editableRow, filteredRequest, sortedRequest, type TablePage } from "./databaseTable";

const page: TablePage = {
  columns: ["account", "id", "memo", "attachment"],
  metadata: [
    { name: "account", type: "varchar", primaryKey: true, editable: false },
    { name: "id", type: "bigint", primaryKey: true, editable: false },
    { name: "memo", type: "varchar", primaryKey: false, editable: true },
    { name: "attachment", type: "blob", primaryKey: false, editable: false },
  ],
  rows: [["00-1", "9007199254740993", null, "[3 bytes]"], ["00-2", "42", "clipped…", null]],
  truncated: true, hasMore: true, editableRows: [true, false],
};

describe("table browser", () => {
  it("keeps a composite key intact and preserves NULL for optimistic cell edits", () => {
    expect(editableRow(page, 0)).toEqual({
      key: { account: "00-1", id: "9007199254740993" }, fields: [{ name: "memo", original: null }],
    });
    expect(editableRow(page, 1)).toBeUndefined();
    expect(editableRow({ ...page, rows: [[null, "1", "", ""]] }, 0)).toBeUndefined();
    expect(editableRow({ ...page, metadata: page.metadata.map(c => ({ ...c, primaryKey: false })) }, 0)).toBeUndefined();
  });
  it("resets to the first page and sends the literal filter to the database", () => {
    const query = { limit: 50, offset: 100, sortColumn: "id", sortDirection: "asc" } as const;
    const filter = filteredRequest(query, "memo", " A%_🥝 ");
    expect(filter).toEqual({ ...query, offset: 0, filterColumn: "memo", filterValue: " A%_🥝 " });
    expect(filteredRequest(filter, "memo", "")).toEqual({ ...query, offset: 0 });
  });
  it("cycles sorting without losing the active filter", () => {
    const base = { offset: 150, limit: 25, filterColumn: "id", filterValue: "1" };
    const asc = sortedRequest(base, "memo");
    const desc = sortedRequest(asc, "memo");
    expect(asc).toEqual({ ...base, offset: 0, sortColumn: "memo", sortDirection: "asc" });
    expect(desc.sortDirection).toBe("desc");
    expect(sortedRequest(desc, "memo")).toEqual({ ...base, offset: 0 });
    expect(sortedRequest(desc, "id").sortDirection).toBe("asc");
  });
  it("suggests a single Windows-compatible CSV filename", () => {
    expect(csvFilename("Finance/Rows:2026")).toBe("Finance_Rows_2026.csv");
    expect(csvFilename("CON")).toBe("table-CON.csv");
    expect(csvFilename("..")).toBe("table.csv");
    expect(csvFilename("pé订单")).toBe("pé订单.csv");
  });
});
