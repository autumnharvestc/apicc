import { parseDatasetContent, type DatasetAsset } from "@apicc/core";

/** Host-only dataset exchange shared by local and online editors. No session or path access. */
export function importDatasetContent(content: string, format: "csv" | "json") {
  return parseDatasetContent(new TextEncoder().encode(content), format);
}

export function exportDatasetContent(dataset: Pick<DatasetAsset, "columns" | "rows">, format: "csv" | "json") {
  if (format === "json") return JSON.stringify(dataset.rows, null, 2);
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return [dataset.columns.map(cell).join(","), ...dataset.rows.map(row => dataset.columns.map(name => cell(!(name in row) ? "" : typeof row[name] === "string" ? row[name] : JSON.stringify(row[name]))).join(","))].join("\r\n");
}
