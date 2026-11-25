import type { DbGrid } from "./databaseProfiles";

export interface TableColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  editable: boolean;
}

export interface TablePage extends DbGrid {
  metadata: TableColumn[];
  editableRows: boolean[];
  hasMore: boolean;
}

export interface TableRequest {
  offset: number;
  limit: number;
  filterColumn?: string;
  filterValue?: string;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
}

export function sortedRequest(current: TableRequest, column: string): TableRequest {
  const next = { ...current, offset: 0 };
  if (current.sortColumn !== column) {
    return { ...next, sortColumn: column, sortDirection: "asc" };
  }
  if (current.sortDirection === "asc") return { ...next, sortDirection: "desc" };
  delete next.sortColumn;
  delete next.sortDirection;
  return next;
}

export function filteredRequest(current: TableRequest, column: string, value: string): TableRequest {
  const next = { ...current, offset: 0 };
  if (column && value !== "") return { ...next, filterColumn: column, filterValue: value };
  delete next.filterColumn;
  delete next.filterValue;
  return next;
}

export interface EditRow {
  key: Record<string, string>;
  fields: { name: string; original: string | null }[];
}

export function editableRow(page: TablePage, index: number): EditRow | undefined {
  if (!page.editableRows[index]) return;
  const row = page.rows[index];
  if (!row || page.columns.length !== row.length) return;
  const values = new Map(page.columns.map((name, i) => [name, row[i]]));
  const keys: [string, string][] = [];
  const fields: EditRow["fields"] = [];
  for (const column of page.metadata) {
    const original = values.get(column.name);
    if (original === undefined) return;
    if (column.primaryKey) {
      if (original === null) return;
      keys.push([column.name, original]);
    } else if (column.editable) {
      fields.push({ name: column.name, original });
    }
  }
  if (!keys.length || !fields.length) return;
  return { key: Object.fromEntries(keys), fields };
}

export function csvFilename(name: string): string {
  let stem = Array.from(name, char => (char.codePointAt(0)! < 32 || /[<>:"/\\|?*]/.test(char)) ? "_" : char)
    .slice(0, 100).join("").trim().replace(/[. ]+$/, "");
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = "table" + (stem && "-" + stem);
  return stem + ".csv";
}
