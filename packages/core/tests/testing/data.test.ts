import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { prepareTestData, bindPreparedTestData, readPreparedCaseData, preparedCaseKey, testDataSelectionsForRequests } from "../../src/testing/data.js";
import { createContractExecutionProject, contractExecutionIds as ids } from "../helpers/contractExecutionFixtures.js";
import { CollectionRunner } from "../../src/runner/runner.js";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { createEventBus } from "../../src/events/bus.js";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

const datasetId = "10000000-0000-4000-8000-000000000090";
function fixture() {
  const project = createContractExecutionProject("http://127.0.0.1");
  const collection = project.collections[0]!;
  collection.folders[0]!.folders[0]!.preOperations = [];
  collection.folders[0]!.folders[0]!.postOperations = [];
  const asset = collection.folders[0]!.folders[0]!.apis[0]!;
  const testCase = asset.cases[0]!;
  testCase.preOperations = [];
  asset.contract.request = { protocol: "http", method: "GET", baseUrl: "http://127.0.0.1", path: "/{{value}}", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } };
  const locator = { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case, scope: "base" };
  return { project, asset, testCase, locator };
}
function runner(seen: ExecutableRequest[]) {
  const registry = createPluginRegistry();
  registry.registerScriptEngine(jsScriptEngine);
  registry.registerProtocol({ name: "data-observer", canHandle: () => true, async execute(request) { seen.push(request); return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; } });
  return new CollectionRunner({ registry, bus: createEventBus(), timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 }, failFast: false });
}
const credentialBindings = { versions: {}, resolve: () => { throw new Error("No credential expected"); } };

describe("B1 centralized test data", () => {
  it("captures relative/absolute CSV once, survives source replacement, and re-prepares new values", async () => {
    const { project, asset, testCase, locator } = fixture();
    const root = mkdtempSync(join(tmpdir(), "apicc-b1-capture-"));
    const file = join(root, "rows.csv");
    writeFileSync(file, '\ufeffvalue\n"old\nquoted"\n');
    asset.contract.request.path = "/fixed";
    testCase.postOperations = [{ id: "verify-old-row", type: "script", content: 'pm.assert(pm.variables.get("value") === "old\\nquoted", "captured value");' }];
    testCase.dataDriver = { sourcePath: "rows.csv", format: "csv" };
    asset.cases.push({ ...testCase, id: "absolute", dataDriver: { sourcePath: file, format: "csv" } });
    const snapshot = createProjectSnapshot(project);
    const selections = [{ locator }, { locator: { ...locator, caseId: "absolute" } }];
    const prepared = await prepareTestData(snapshot, selections, { workspaceRoot: root });
    expect(prepared.sources).toHaveLength(1);
    expect(readPreparedCaseData(snapshot, prepared, locator)!.rows).toEqual([{ index: 0, values: { value: "old\nquoted" } }]);
    writeFileSync(file, "value\nnew\n");
    const transferred = bindPreparedTestData(snapshot, JSON.parse(JSON.stringify(prepared)));
    const seen: ExecutableRequest[] = [];
    const result = await runner(seen).run({ snapshot, credentialBindings, preparedTestData: transferred }, ids.collection);
    expect(result.passed).toBe(2);
    expect(result.cases.map((item) => [item.row, item.locator?.scope])).toEqual([[0, "base"], [0, "base"]]);
    expect(result.cases.flatMap((item) => item.assertions).map((item) => item.pass)).toEqual([true, true]);
    expect(seen.map((request) => request.url)).toEqual(["http://127.0.0.1/fixed", "http://127.0.0.1/fixed"]);
    const next = await prepareTestData(snapshot, selections, { workspaceRoot: root });
    expect(next.sources[0]!.digest).not.toBe(prepared.sources[0]!.digest);
    expect(readPreparedCaseData(snapshot, next, locator)!.rows[0]!.values.value).toBe("new");
    expect(Object.isFrozen(transferred.sources[0]!.rows[0]!.values)).toBe(true);
  });

  it("runs project JSON values as explicit text, preserves empty/null/false/zero and absent fallback", async () => {
    const { project, asset, testCase, locator } = fixture();
    project.datasets = [{ formatVersion: 1, id: datasetId, name: "typed", columns: ["value", "flag", "nil", "empty", "missing"], rows: [{ value: 0, flag: false, nil: null, empty: "" }] }];
    testCase.dataDriver = { kind: "dataset", datasetId };
    testCase.parameters = { missing: "lower", value: "wrong", flag: "wrong", nil: "wrong", empty: "wrong" };
    testCase.postOperations = [{ id: "verify", type: "script", content: 'for (const [key, value] of Object.entries({value:"0", flag:"false", nil:"null", empty:"", missing:"lower"})) pm.assert(pm.variables.get(key) === value, key);' }];
    const snapshot = createProjectSnapshot(project);
    const snapshotAsset = snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const selections = testDataSelectionsForRequests(snapshot, [{ asset: snapshotAsset, testCase: snapshotAsset.cases[0]! }]);
    expect(selections).toEqual([{ locator }]);
    const prepared = await prepareTestData(snapshot, selections, { workspaceRoot: tmpdir() });
    expect(readPreparedCaseData(snapshot, prepared, locator)!.rows[0]).toEqual({ index: 0, values: { value: "0", flag: "false", nil: "null", empty: "" } });
    const seen: ExecutableRequest[] = [];
    const result = await runner(seen).run({ snapshot, credentialBindings, preparedTestData: prepared }, ids.collection);
    expect(result.passed).toBe(1);
    expect(result.cases[0]!.row).toBe(0);
    expect(result.cases[0]!.assertions.every((item) => item.pass)).toBe(true);
    expect(seen[0]!.url).toBe("http://127.0.0.1/0");
    void asset;
  });

  it.each([
    ["duplicate", "csv", "secret,secret\na,b", "DATA_HEADER_DUPLICATE"],
    ["empty-header", "csv", ",x\nsecret,b", "DATA_HEADER_EMPTY"],
    ["extra", "csv", "x\nsecret,second", "DATA_CSV_INVALID"],
    ["quote", "csv", 'x\n"secret', "DATA_CSV_INVALID"],
    ["array", "json", '["secret"]', "DATA_ROW_INVALID"],
    ["object", "json", '{"secret":1}', "DATA_ROWS_INVALID"],
    ["legacy-number", "json", '[{"x":0}]', "DATA_CELL_TYPE"],
    ["json", "json", '[{"secret":', "DATA_JSON_INVALID"],
    ["encoding", "csv", Buffer.from([0xff, 0xfe]), "DATA_ENCODING_INVALID"],
    ["cell", "csv", `x\n${"s".repeat(65537)}`, "DATA_CELL_LIMIT"],
    ["columns", "csv", Array.from({ length: 257 }, (_, index) => `c${index}`).join(","), "DATA_COLUMN_LIMIT"],
    ["rows", "csv", `x\n${"s\n".repeat(10001)}`, "DATA_ROW_LIMIT"],
    ["source", "csv", Buffer.alloc(10 * 1024 * 1024 + 1, 0x73), "DATA_SOURCE_LIMIT"],
  ] as const)("rejects %s with safe source/row/column diagnostics", async (name, format, content, code) => {
    const { project, testCase, locator } = fixture();
    const root = mkdtempSync(join(tmpdir(), "apicc-b1-invalid-"));
    writeFileSync(join(root, name), content);
    testCase.dataDriver = { sourcePath: name, format };
    const snapshot = createProjectSnapshot(project);
    const prepared = await prepareTestData(snapshot, [{ locator }], { workspaceRoot: root });
    const diagnostic = prepared.sources[0]!.diagnostics[0]!;
    expect(diagnostic.code).toBe(code);
    expect(diagnostic.source).toBe("file:1");
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    if (code === "DATA_ENCODING_INVALID") {
      expect(diagnostic.row).toBeUndefined(); expect(diagnostic.column).toBeUndefined();
      expect(diagnostic.message).toContain("位置不可用");
    } else if (code !== "DATA_SOURCE_LIMIT") { expect(diagnostic.row).toBeGreaterThan(0); expect(diagnostic.column).toBeGreaterThan(0); }
    expect(() => readPreparedCaseData(snapshot, prepared, locator)).toThrow();
  });

  it.each([
    ['[\n {"value" 1}\n]', 2, 11],
    ['[\n {"value":', 2, 11],
    ['[\n {"value": }\n]', undefined, undefined],
    ["line 2 column 3", undefined, undefined],
    ["position 3", undefined, undefined],
    ["Unexpected end of JSON input", undefined, undefined],
  ] as const)("reports JSON syntax/EOF positions or explicit unavailable without source excerpts", async (content, row, column) => {
    const { project, testCase, locator } = fixture();
    const root = mkdtempSync(join(tmpdir(), "apicc-b1-json-position-"));
    writeFileSync(join(root, "rows.json"), content);
    testCase.dataDriver = { sourcePath: "rows.json", format: "json" };
    const prepared = await prepareTestData(createProjectSnapshot(project), [{ locator }], { workspaceRoot: root });
    const diagnostic = prepared.sources[0]!.diagnostics[0]!;
    expect(diagnostic.code).toBe("DATA_JSON_INVALID");
    expect([diagnostic.row, diagnostic.column]).toEqual([row, column]);
    if (row === undefined) expect(diagnostic.message).toContain("位置不可用");
    expect(diagnostic.message).not.toContain("value");
  });

  it("rejects selected empty datasets, retains legacy empty warning, and reports per-case failures", async () => {
    const { project, asset, testCase, locator } = fixture();
    project.datasets = [{ formatVersion: 1, id: datasetId, name: "draft", columns: ["value"], rows: [] }];
    testCase.dataDriver = { kind: "dataset", datasetId };
    asset.cases.push({ ...testCase, id: "good", dataDriver: undefined });
    const snapshot = createProjectSnapshot(project);
    const prepared = await prepareTestData(snapshot, [{ locator }, { locator: { ...locator, caseId: "good" } }], { workspaceRoot: tmpdir() });
    expect(prepared.sources[0]!.diagnostics[0]!.code).toBe("DATASET_EMPTY");
    const seen: ExecutableRequest[] = [];
    const result = await runner(seen).run({ snapshot, credentialBindings, preparedTestData: prepared }, ids.collection);
    expect(result.cases.map((item) => item.failureKind)).toEqual(["config", undefined]);
    expect(seen).toHaveLength(1);
    const root = mkdtempSync(join(tmpdir(), "apicc-b1-empty-"));
    writeFileSync(join(root, "empty.csv"), "value\n");
    testCase.dataDriver = { sourcePath: "empty.csv", format: "csv" };
    const legacySnapshot = createProjectSnapshot(project);
    const legacyData = await prepareTestData(legacySnapshot, [{ locator }, { locator: { ...locator, caseId: "good" } }], { workspaceRoot: root });
    const legacy = await runner([]).run({ snapshot: legacySnapshot, credentialBindings, preparedTestData: legacyData }, ids.collection);
    expect(legacy.passed).toBe(2);
    expect(legacy.warnings?.join()).toContain("legacy-empty-fallback");
  });

  it("rejects missing, changed project/revision/selection and mutated worker data without file reads", async () => {
    const { project, testCase, locator } = fixture();
    testCase.dataDriver = { sourcePath: "does-not-exist.csv", format: "csv" };
    const snapshot = createProjectSnapshot(project);
    expect(() => readPreparedCaseData(snapshot, undefined, locator)).toThrow(/缺少准备/);
    const missing = await runner([]).run({ snapshot, credentialBindings }, ids.collection);
    expect(missing.cases[0]!.failureKind).toBe("config");
    const prepared = await prepareTestData(snapshot, [], { workspaceRoot: tmpdir() });
    expect(() => readPreparedCaseData(snapshot, prepared, locator)).toThrow(/选择集/);
    project.name = "revision changed";
    expect(() => bindPreparedTestData(createProjectSnapshot(project), prepared)).toThrow(/版本/);
    project.id = datasetId;
    expect(() => bindPreparedTestData(createProjectSnapshot(project), prepared)).toThrow(/项目/);
    const tampered = JSON.parse(JSON.stringify(prepared));
    tampered.projectId = "other";
    expect(() => bindPreparedTestData(snapshot, tampered)).toThrow(/摘要|项目/);
    expect(preparedCaseKey({ ...locator, caseId: "x/y", scope: "z" })).not.toBe(preparedCaseKey({ ...locator, caseId: "x", scope: "y/z" }));
    expect(() => readPreparedCaseData(snapshot, prepared, { ...locator, scope: "other" })).toThrow(/scope/);
  });

  it("prepares explicit outer sources while refusing existing child data drivers", async () => {
    const { project, testCase, locator } = fixture();
    project.datasets = [{ formatVersion: 1, id: datasetId, name: "outer", columns: ["value"], rows: [{ value: "outer" }] }];
    const snapshot = createProjectSnapshot(project);
    const prepared = await prepareTestData(snapshot, [{ locator, datasetId }], { workspaceRoot: tmpdir() });
    expect(prepared.selections[0]!.datasetId).toBe(datasetId);
    expect(readPreparedCaseData(snapshot, prepared, locator)!.rows[0]!.values.value).toBe("outer");
    testCase.dataDriver = { kind: "dataset", datasetId };
    await expect(prepareTestData(createProjectSnapshot(project), [{ locator, datasetId }], { workspaceRoot: tmpdir() })).rejects.toThrow(/不能同时/);
  });
});
