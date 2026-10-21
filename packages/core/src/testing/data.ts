import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractFolder } from "../contract/workspace.js";
import type { TestCase } from "../domain/common.js";
import { JsonValueSchema, type JsonValue } from "../contract/schemaNode.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import type { CredentialRequestSelection } from "../credentials/output.js";
import type { CaseExecutionLocator } from "../runner/caseExecutor.js";
import { PreparedTestDataSchema, type PreparedCaseSelection, type PreparedDataSource, type PreparedTestData, type TestDataDiagnostic } from "./dataModel.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_COLUMNS = 256;
const MAX_CELL_BYTES = 64 * 1024;
const bindings = new WeakMap<object, PreparedTestData>();
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const hash = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class TestDataError extends Error {
  constructor(readonly diagnostics: readonly TestDataDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; "));
    this.name = "TestDataError";
  }
}

/** Canonical tuple serialization, including the actual scope and ordered ancestor IDs. */
export function preparedCaseKey(locator: CaseExecutionLocator): string {
  return JSON.stringify([locator.collectionId, [...locator.folderIds], locator.apiId, locator.caseId, locator.scope]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function fail(code: string, source: string, detail: string, row?: number, column?: number): never {
  throw new TestDataError([{ code, source, ...(row === undefined ? {} : { row }), ...(column === undefined ? {} : { column }),
    message: `数据源 ${source}${row === undefined ? "" : ` 第 ${row} 行`}${column === undefined ? "" : `第 ${column} 列`}: ${detail}` }]);
}

function selectedCase(snapshot: ProjectSnapshot, locator: CaseExecutionLocator): DeepReadonly<TestCase> {
  const collection = snapshot.project.collections.find((item) => item.id === locator.collectionId);
  if (!collection) fail("DATA_SELECTION_INVALID", "selection", "集合不属于当前快照");
  let container: { readonly folders: readonly DeepReadonly<ContractFolder>[]; readonly apis: readonly DeepReadonly<ApiAsset>[] } = collection;
  for (const id of locator.folderIds) {
    const folder = container.folders.find((item) => item.id === id);
    if (!folder) fail("DATA_SELECTION_INVALID", "selection", "目录路径不属于当前快照");
    container = folder;
  }
  const asset = container.apis.find((item) => item.contract.id === locator.apiId);
  const testCase = asset?.cases.find((item) => item.id === locator.caseId && item.scope === locator.scope);
  if (!testCase) fail("DATA_SELECTION_INVALID", "selection", "用例及实际 scope 不属于所选路径");
  return testCase;
}

/** Resolve existing host selections by exact snapshot references, without reading data. */
export function testDataSelectionsForRequests(snapshot: ProjectSnapshot, selections: readonly CredentialRequestSelection[], environmentId?: string): PreparedCaseSelection[] {
  const locations = new Map<DeepReadonly<ApiAsset>, { collectionId: string; folderIds: readonly string[] }>();
  for (const collection of snapshot.project.collections) {
    const visit = (container: { readonly apis: readonly DeepReadonly<ApiAsset>[]; readonly folders: readonly DeepReadonly<ContractFolder>[] }, folderIds: readonly string[]): void => {
      for (const asset of container.apis) locations.set(asset, { collectionId: collection.id, folderIds });
      for (const folder of container.folders) visit(folder, [...folderIds, folder.id]);
    };
    visit(collection, []);
  }
  const result = new Map<string, PreparedCaseSelection>();
  for (const { asset, testCase } of selections) {
    const location = locations.get(asset);
    if (!location || (testCase !== undefined && !asset.cases.includes(testCase))) fail("DATA_SELECTION_INVALID", "selection", "准备必须使用同一快照中的接口和用例");
    const cases = testCase ? [testCase] : selectEffectiveCases(asset.cases, resolveExecutionEnvironment(snapshot.project, location.collectionId, environmentId).chain);
    for (const item of cases) {
      const locator = { ...location, apiId: asset.contract.id, caseId: item.id, scope: item.scope };
      result.set(preparedCaseKey(locator), { locator });
    }
  }
  return [...result.values()];
}

async function readBounded(path: string, label: string): Promise<Buffer> {
  let file;
  try { file = await open(path, "r"); } catch { fail("DATA_READ_FAILED", label, "无法读取所选本地文件"); }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - size));
      const result = await file.read(chunk, 0, chunk.length, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
      if (size > MAX_BYTES) fail("DATA_SOURCE_LIMIT", label, "源内容超过 10 MiB");
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof TestDataError) throw error;
    fail("DATA_READ_FAILED", label, "无法读取所选本地文件");
  } finally { await file.close(); }
}

function validateRows(records: unknown, columns: readonly string[] | undefined, label: string, stringsOnly: boolean) {
  if (!Array.isArray(records)) fail("DATA_ROWS_INVALID", label, "JSON 必须为记录数组", 1, 1);
  if (records.length > MAX_ROWS) fail("DATA_ROW_LIMIT", label, "数据行超过 10000", MAX_ROWS + 1, 1);
  const names = columns ? [...columns] : [...new Set(records.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))];
  if (names.length > MAX_COLUMNS) fail("DATA_COLUMN_LIMIT", label, "列数超过 256", 1, MAX_COLUMNS + 1);
  for (const [column, name] of names.entries()) {
    if (typeof name !== "string" || name.length === 0) fail("DATA_HEADER_EMPTY", label, "列名不能为空", 1, column + 1);
    if (names.indexOf(name) !== column) fail("DATA_HEADER_DUPLICATE", label, "列名不能重复", 1, column + 1);
    if (bytes(name) > MAX_CELL_BYTES) fail("DATA_CELL_LIMIT", label, "列名超过 64 KiB", 1, column + 1);
  }
  const rows = records.map((record: unknown, index: number) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) fail("DATA_ROW_INVALID", label, "数据行必须是对象", index + 1, 1);
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(record)) {
      const column = names.indexOf(name);
      if (column < 0) fail("DATA_EXTRA_COLUMN", label, "数据行含未声明的列", index + 1, names.length + 1);
      if (stringsOnly && typeof value !== "string") fail("DATA_CELL_TYPE", label, "旧文件数据单元必须是字符串", index + 1, column + 1);
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof text !== "string") fail("DATA_CELL_TYPE", label, "单元必须是 JSON 值", index + 1, column + 1);
      if (bytes(text) > MAX_CELL_BYTES) fail("DATA_CELL_LIMIT", label, "单元超过 64 KiB", index + 1, column + 1);
      values[name] = text;
    }
    return { index, values };
  });
  return { columns: names, rows };
}

function parseRecords(content: Uint8Array, format: "csv" | "json", label: string): { records: unknown; columns?: string[] } {
  if (content.byteLength > MAX_BYTES) fail("DATA_SOURCE_LIMIT", label, "源内容超过 10 MiB");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { fail("DATA_ENCODING_INVALID", label, "源内容必须是有效 UTF-8（编码错误位置不可用）"); }
  if (format === "json") {
    let records: unknown;
    try { records = JSON.parse(text); } catch (error) {
      // Match the complete native metadata form, never phrases inside quoted source excerpts.
      const message = error instanceof SyntaxError ? error.message : "";
      const metadata = /^[^"\r\n]+ in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(message);
      if (metadata?.[2] !== undefined && metadata[3] !== undefined) fail("DATA_JSON_INVALID", label, "JSON 格式无效", Number(metadata[2]), Number(metadata[3]));
      const position = metadata ? Number(metadata[1]) : message === "Unexpected end of JSON input" ? text.length : undefined;
      if (position !== undefined && position >= 0 && position <= text.length) {
        const lines = text.slice(0, position).split(/\r\n|\r|\n/);
        fail("DATA_JSON_INVALID", label, "JSON 格式无效", lines.length, lines[lines.length - 1]!.length + 1);
      }
      fail("DATA_JSON_INVALID", label, "JSON 格式无效（语法错误位置不可用）");
    }
    return { records };
  }
  let records: string[][];
  try { records = parseCsv(text, { bom: true, skip_empty_lines: true, max_record_size: MAX_BYTES }); }
  catch (error) {
    const csv = error as { lines?: number; column?: unknown; index?: number };
    fail("DATA_CSV_INVALID", label, "CSV 格式或列数无效", Math.max(1, typeof csv.lines === "number" ? csv.lines : 1), Math.max(1, typeof csv.column === "number" ? csv.column : (csv.index ?? 0) + 1));
  }
  const columns = records.shift() ?? [];
  // Validate headers even for a legacy empty source.
  validateRows([], columns, label, true);
  const objects = records.map((cells, index) => {
    if (cells.length !== columns.length) fail("DATA_EXTRA_COLUMN", label, "数据行列数与表头不一致", index + 2, Math.min(cells.length, columns.length) + 1);
    return Object.fromEntries(columns.map((name, column) => [name, cells[column]!]));
  });
  return { records: objects, columns };
}

function parseFile(content: Buffer, format: "csv" | "json", label: string) {
  const parsed = parseRecords(content, format, label);
  return validateRows(parsed.records, parsed.columns, label, true);
}

/** Editor imports retain JSON values; only execution converts typed cells to strings. */
export function parseDatasetContent(content: Uint8Array, format: "csv" | "json"): { columns: string[]; rows: Record<string, JsonValue>[] } {
  const parsed = parseRecords(content, format, "import");
  const checked = validateRows(parsed.records, parsed.columns, "import", false);
  const rows = (parsed.records as Record<string, unknown>[]).map((row, index) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const checkedValue = JsonValueSchema.safeParse(value);
    if (!checkedValue.success) fail("DATA_CELL_TYPE", "import", "单元必须是 JSON 值", index + 1, checked.columns.indexOf(key) + 1);
    return [key, checkedValue.data];
  })));
  return { columns: checked.columns, rows };
}

export function validateDatasetTable(dataset: { columns: readonly string[]; rows: readonly Record<string, JsonValue>[] }): void {
  if (bytes(JSON.stringify(dataset)) > MAX_BYTES) fail("DATA_SOURCE_LIMIT", "dataset", "源内容超过 10 MiB");
  validateRows(dataset.rows, dataset.columns, "dataset", false);
}

/** Capture selected source contents exactly once, before dispatch. Source errors stay per-case. */
export async function prepareTestData(snapshot: ProjectSnapshot, selections: readonly PreparedCaseSelection[], options: { workspaceRoot: string }): Promise<PreparedTestData> {
  if (!isAbsolute(options.workspaceRoot)) fail("DATA_ROOT_INVALID", "selection", "必须显式提供绝对工作区根目录");
  const sources = new Map<string, PreparedDataSource>();
  const selected = new Map<string, PreparedTestData["selections"][number]>();
  const fileContents = new Map<string, Promise<Buffer>>();
  for (const selection of selections) {
    const testCase = selectedCase(snapshot, selection.locator);
    const key = preparedCaseKey(selection.locator);
    if (selected.has(key)) {
      if (selected.get(key)!.datasetId !== selection.datasetId) fail("DATA_SELECTION_CONFLICT", "selection", "同一用例不能选择多个数据来源");
      continue;
    }
    if (selection.datasetId !== undefined && testCase.dataDriver !== undefined) fail("DATA_DRIVER_CONFLICT", "selection", "外层数据集与用例数据驱动不能同时使用");
    const driver = selection.datasetId === undefined ? testCase.dataDriver : { kind: "dataset" as const, datasetId: selection.datasetId };
    const locator = { ...selection.locator, folderIds: [...selection.locator.folderIds] };
    if (!driver) { selected.set(key, { key, locator }); continue; }
    const sourceKey = "kind" in driver ? JSON.stringify(["dataset", driver.datasetId]) : JSON.stringify(["file", resolve(options.workspaceRoot, driver.sourcePath), driver.format]);
    selected.set(key, { key, locator, ...(selection.datasetId === undefined ? {} : { datasetId: selection.datasetId }), sourceKey });
    if (sources.has(sourceKey)) continue;
    const label = `${"kind" in driver ? "dataset" : "file"}:${sources.size + 1}`;
    let source: PreparedDataSource;
    let digest: string | undefined;
    try {
      let parsed;
      if ("kind" in driver) {
        const dataset = (snapshot.project.datasets ?? []).find((item) => item.id === driver.datasetId);
        if (!dataset) fail("DATASET_MISSING", label, "所选项目数据集不存在");
        const content = canonical(dataset);
        if (bytes(content) > MAX_BYTES) fail("DATA_SOURCE_LIMIT", label, "源内容超过 10 MiB");
        digest = hash(content);
        parsed = validateRows(dataset.rows, dataset.columns, label, false);
        if (parsed.rows.length === 0) fail("DATASET_EMPTY", label, "所选项目数据集为空");
      } else {
        const path = resolve(options.workspaceRoot, driver.sourcePath);
        const fileKey = process.platform === "win32" ? path.toLowerCase() : path;
        let content = fileContents.get(fileKey);
        if (!content) { content = readBounded(path, label); fileContents.set(fileKey, content); }
        const buffer = await content;
        digest = hash(buffer);
        parsed = parseFile(buffer, driver.format, label);
      }
      const legacyEmptyFallback = !("kind" in driver) && parsed.rows.length === 0;
      source = { key: sourceKey, kind: "kind" in driver ? "dataset" : "file", label, digest, ...parsed, legacyEmptyFallback, diagnostics: legacyEmptyFallback ? [{ code: "legacy-empty-fallback", source: label, message: `数据源 ${label}: legacy-empty-fallback（旧空文件按一次无数据执行）` }] : [] };
    } catch (error) {
      if (!(error instanceof TestDataError)) throw error;
      source = { key: sourceKey, kind: "kind" in driver ? "dataset" : "file", label, ...(digest === undefined ? {} : { digest }), columns: [], rows: [], legacyEmptyFallback: false, diagnostics: error.diagnostics };
    }
    sources.set(sourceKey, source);
  }
  const payload = { formatVersion: 1 as const, projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, selections: [...selected.values()], sources: [...sources.values()] };
  const prepared = freeze({ ...payload, digest: hash(canonical(payload)) });
  bindings.set(prepared, prepared);
  return prepared;
}

/** Verify serialized worker input and bind it to the captured definition; never reads a source. */
export function bindPreparedTestData(snapshot: ProjectSnapshot, value: unknown): PreparedTestData {
  const cached = value !== null && typeof value === "object" ? bindings.get(value) : undefined;
  if (cached) {
    if (cached.projectId !== snapshot.project.id || cached.definitionRevision !== snapshot.definitionRevision) fail("DATA_PREPARATION_MISMATCH", "selection", "准备数据与项目或定义版本不一致");
    return cached;
  }
  const parsed = PreparedTestDataSchema.safeParse(value);
  if (!parsed.success) fail("DATA_PREPARATION_INVALID", "selection", "准备数据结构无效");
  const { digest, ...payload } = parsed.data;
  if (payload.projectId !== snapshot.project.id || payload.definitionRevision !== snapshot.definitionRevision || hash(canonical(payload)) !== digest) fail("DATA_PREPARATION_MISMATCH", "selection", "准备数据与项目、定义版本或内容摘要不一致");
  const keys = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const source of payload.sources) {
    if (sourceKeys.has(source.key)) fail("DATA_PREPARATION_INVALID", "selection", "准备数据来源重复");
    sourceKeys.add(source.key);
    validateRows(source.rows.map((row) => row.values), source.columns, source.label, true);
    if (source.rows.some((row, index) => row.index !== index)) fail("DATA_PREPARATION_INVALID", "selection", "准备数据行身份无效");
  }
  for (const item of payload.selections) {
    const testCase = selectedCase(snapshot, item.locator);
    if (item.key !== preparedCaseKey(item.locator) || keys.has(item.key)) fail("DATA_PREPARATION_INVALID", "selection", "准备数据选择绑定无效");
    keys.add(item.key);
    if (item.datasetId !== undefined && testCase.dataDriver !== undefined) fail("DATA_DRIVER_CONFLICT", "selection", "外层数据集与用例数据驱动不能同时使用");
    const driver = item.datasetId === undefined ? testCase.dataDriver : { kind: "dataset" as const, datasetId: item.datasetId };
    const source = payload.sources.find((source) => source.key === item.sourceKey);
    if (driver === undefined ? item.sourceKey !== undefined : !source) fail("DATA_PREPARATION_INVALID", "selection", "准备数据来源绑定无效");
    if (driver && "kind" in driver && (source?.kind !== "dataset" || source.key !== JSON.stringify(["dataset", driver.datasetId]))) fail("DATA_PREPARATION_INVALID", "selection", "准备数据集绑定无效");
    if (driver && !("kind" in driver) && source?.kind !== "file") fail("DATA_PREPARATION_INVALID", "selection", "准备文件来源绑定无效");
  }
  const prepared = freeze(parsed.data);
  bindings.set(value as object, prepared);
  bindings.set(prepared, prepared);
  return prepared;
}

/** Pure execution lookup: a missing preparation is a configuration failure, never a file read. */
export function readPreparedCaseData(snapshot: ProjectSnapshot, prepared: PreparedTestData | undefined, locator: CaseExecutionLocator): PreparedDataSource | undefined {
  const testCase = selectedCase(snapshot, locator);
  if (!prepared) {
    if (testCase.dataDriver) fail("DATA_PREPARATION_MISSING", "selection", "数据驱动用例缺少准备数据");
    return undefined;
  }
  prepared = bindPreparedTestData(snapshot, prepared);
  if (prepared.projectId !== snapshot.project.id || prepared.definitionRevision !== snapshot.definitionRevision) fail("DATA_PREPARATION_MISMATCH", "selection", "准备数据与项目或定义版本不一致");
  const selection = prepared.selections.find((item) => item.key === preparedCaseKey(locator));
  if (!selection) fail("DATA_SELECTION_MISSING", "selection", "用例不属于本次准备选择集");
  if (!selection.sourceKey) {
    if (testCase.dataDriver || selection.datasetId !== undefined) fail("DATA_PREPARATION_MISSING", "selection", "所选数据来源未准备");
    return undefined;
  }
  const source = prepared.sources.find((item) => item.key === selection.sourceKey);
  if (!source) fail("DATA_PREPARATION_MISSING", "selection", "所选数据来源未准备");
  const errors = source.diagnostics.filter((item) => item.code !== "legacy-empty-fallback");
  if (errors.length) throw new TestDataError(errors);
  return source;
}
