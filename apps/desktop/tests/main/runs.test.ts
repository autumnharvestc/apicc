import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRuns, readRun, readScopedStressRun, writeStressRunScope } from "../../src/main/runs.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { createStressController } from "../../src/main/stress.js";
import { IDS, uuid } from "./helpers/contract-assets.js";
import { computeReport, StressPlanSchema } from "@apicc/core";

const sample = {
  collectionId: "c", collectionName: "demo", startedAt: "2026-09-02T00:00:00.000Z",
  finishedAt: "2026-09-02T00:00:01.000Z", total: 2, passed: 1, failed: 1, cases: [],
};

describe("runs 历史", () => {
  it("reads explicit v2 unavailable metrics without a legacy numeric projection and rejects unknown versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "f6-v2-history-"));
    const legacy = computeReport([], { concurrency: 1, startedAt: 0, finishedAt: 0 });
    const missing = { availability: "unavailable", reason: "no-data" }, complete = { complete: true, reasons: [] };
    const target = { kind: "workflow", workflowId: "wf" };
    const value = { ...legacy, formatVersion: 2, runId: "r", projectId: IDS.projectOne, definitionRevision: "rev", target,
      plan: StressPlanSchema.parse({ formatVersion: 1, target, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }),
      environmentId: null, dataIdentity: { digest: null, datasetIds: [] }, rps: missing, latency: missing, scriptLatency: missing, iterationLatency: missing,
      verdict: { status: "no-data", passed: false, violations: [] }, iterations: { planned: 0, started: 0, completed: 0, passed: 0, failed: 0, aborted: 0, dropped: 0, latency: missing, startDelay: missing },
      caseRows: { total: 0, ok: 0, failed: 0, failures: legacy.failures }, requests: { started: 0, completed: 0, eligibleCompleted: 0, failed: 0 }, httpExchanges: { started: 0, completed: 0 },
      phases: [], nodes: [], lifecycle: [], timeline: { bucketWidthMs: 1000, aligned: true, uncertaintyMs: 0, buckets: [] },
      load: { plannedDurationMs: null, measurementDurationMs: 0, drainDurationMs: 0, policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1 },
      statistics: { method: "exact-nearest-rank", exact: true, relativeError: 0, minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256, underflow: 0, overflow: 0 }, completeness: { execution: complete, metrics: complete, load: complete } };
    writeFileSync(join(dir, "v2.json"), JSON.stringify(value)); writeFileSync(join(dir, "unknown.json"), JSON.stringify({ ...value, formatVersion: 3 }));
    expect(readRun(dir, "v2.json")).toMatchObject({ kind: "stress", report: { formatVersion: 2, rps: missing } });
    expect(listRuns(dir)).toEqual([expect.objectContaining({ formatVersion: 2, file: "v2.json", rps: null, verdict: "no-data" })]);
    expect(readRun(dir, "unknown.json")).toBeNull();
  });
  it("C1 separates project and suite/workflow kind while reading old evidence-free JSON unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-c1-history-"));
    writeFileSync(join(dir, "old.json"), JSON.stringify(sample));
    writeFileSync(join(dir, "suite.json"), JSON.stringify({ ...sample, kind: "suite", projectId: "project-a", suite: { projectId: "project-a" } }));
    writeFileSync(join(dir, "workflow.json"), JSON.stringify({ ...sample, kind: "workflow", projectId: "project-b", workflowId: "wf" }));
    expect(listRuns(dir).find((row) => row.file === "suite.json")).toMatchObject({ kind: "suite", projectId: "project-a" });
    expect(listRuns(dir).find((row) => row.file === "workflow.json")).toMatchObject({ kind: "workflow", projectId: "project-b" });
    expect(readRun(dir, "old.json")).toEqual(sample);
    writeFileSync(join(dir, "v2.json"), JSON.stringify({ ...sample, kind: "workflow", workflowId: "wf", reportingMode: "workflow-invocation-v2", workflowUnits: [{ entryId: "wf", workflowId: "wf", invocationId: "invocation", verdict: "passed" }], workflow: { verdict: "passed" } }));
    expect(listRuns(dir).find((row) => row.file === "v2.json")).toMatchObject({ failed: 1, reportingMode: "workflow-invocation-v2", logicalVerdict: "passed", reportingUnits: { total: 1, passed: 1, failed: 0 } });
    writeFileSync(join(dir, "container.json"), JSON.stringify({ ...sample, total: 1, passed: 1, failed: 0, reportingUnits: { total: 2, passed: 1, failed: 1, skipped: 0, entryDiagnostics: 1 } }));
    expect(listRuns(dir).find((row) => row.file === "container.json")).toMatchObject({ total: 1, passed: 1, failed: 0, reportingUnits: { total: 2, failed: 1, entryDiagnostics: 1 } });
  });
  it("listRuns 返回摘要（新→旧），readRun 读回完整结果", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runslist-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-a.json"), JSON.stringify({ ...sample, startedAt: "2026-09-02T01:00:00.000Z" }));
    writeFileSync(join(dir, "run-b.json"), JSON.stringify(sample));
    const list = listRuns(dir);
    expect(list).toHaveLength(2);
    expect(list[0]!.file).toBe("run-a.json");
    // kind 判别（M2-D3 任务 1）：联合摘要按 kind 收窄访问集合字段
    expect(list[0]!.kind).toBe("collection");
    expect(list[0]).toMatchObject({ collectionName: "demo" });
    expect(readRun(dir, "run-a.json")).toMatchObject({ collectionName: "demo", total: 2 });
  });
  it("集合历史摘要透传 skipped，旧报告缺字段回退为 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runslist-skipped-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.json"), JSON.stringify(sample));
    writeFileSync(join(dir, "new.json"), JSON.stringify({ ...sample, skipped: 1 }));
    expect(listRuns(dir).find((row) => row.file === "old.json")).toMatchObject({ skipped: 0 });
    expect(listRuns(dir).find((row) => row.file === "new.json")).toMatchObject({ skipped: 1 });
  });
  it("非法文件跳过不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runslist2-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{broken");
    expect(listRuns(dir)).toEqual([]);
    // readRun 路径穿越防护：相对路径（含 /）与绝对路径（含 \ 或 /）一律拒绝返回 null
    expect(readRun(dir, "../x.json")).toBeNull();
    expect(readRun(dir, join(dir, "run-a.json"))).toBeNull();
  });
  it("合法 JSON 但形状不对：listRuns 跳过、readRun 返回 null（宽审查修复 3）", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runslist3-"));
    mkdirSync(dir, { recursive: true });
    // 合法 JSON，但缺 collectionName/startedAt/total/passed/failed/cases
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ hello: "world" }));
    // total 非数字同样不匹配最小形状
    writeFileSync(join(dir, "wrong-type.json"), JSON.stringify({ ...sample, total: "2" }));
    expect(listRuns(dir)).toEqual([]);
    expect(readRun(dir, "wrong-shape.json")).toBeNull();
    expect(readRun(dir, "wrong-type.json")).toBeNull();
    // 混合目录：形状不对的跳过，合法的照常列出
    writeFileSync(join(dir, "good.json"), JSON.stringify(sample));
    const list = listRuns(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.file).toBe("good.json");
  });
});

// —— kind 判别（M2-D3 任务 1）：runs 目录混合集合运行与压测报告，listRuns/readRun 按内容判别 ——
const stressReport = {
  concurrency: 2, totalRequests: 4, ok: 3, failed: 1, durationMs: 100, rps: 40,
  latency: { min: 1, avg: 2, max: 3, p50: 2, p90: 2.5, p95: 2.8, p99: 3 },
  statusDist: { "200": 3, "500": 1 }, errorKinds: { HTTP_500: 1 },
  startedAt: 1725300000000, finishedAt: 1725300000100,
};

describe("runs kind 判别", () => {
  it("requires proven root/full-project ownership and rejects changed report bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "f6-scope-")), dir = join(root, ".apicc", "runs"); mkdirSync(dir, { recursive: true });
    const scope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const value = { ...stressReport, projectId: IDS.projectOne }; writeFileSync(join(dir, "saved.json"), JSON.stringify(value));
    expect(() => readScopedStressRun(root, scope, "saved.json")).toThrow(/归属未证明/);
    writeStressRunScope(root, "saved.json", scope);
    expect(readScopedStressRun(root, scope, "saved.json")).toEqual(value);
    expect(() => readScopedStressRun(root, { ...scope, groupId: IDS.groupTwo }, "saved.json")).toThrow(/归属/);
    writeFileSync(join(dir, "saved.json"), JSON.stringify({ ...value, ok: 2 }));
    expect(() => readScopedStressRun(root, scope, "saved.json")).toThrow(/归属/);
  });
  it("listRuns 判别 collection/stress 两行，形状不对的 JSON 跳过（不产 undefined 字段行）", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runs-kind-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-a.json"), JSON.stringify(sample));
    writeFileSync(join(dir, "stress-api-1.json"), JSON.stringify(stressReport));
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ hello: "world" }));
    const list = listRuns(dir);
    expect(list).toHaveLength(2);
    const collection = list.find((r) => r.kind === "collection")!;
    expect(collection).toMatchObject({ kind: "collection", file: "run-a.json", collectionName: "demo", total: 2, passed: 1, failed: 1 });
    const stress = list.find((r) => r.kind === "stress")!;
    expect(stress).toEqual({
      kind: "stress", file: "stress-api-1.json",
      startedAt: new Date(1725300000000).toISOString(),
      totalRequests: 4, ok: 3, failed: 1, rps: 40,
    });
  });

  it("readRun 对 stress 文件返回 {kind:'stress', report}、对集合文件返回既有 RunResult 形状", () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runs-kind2-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run-a.json"), JSON.stringify(sample));
    writeFileSync(join(dir, "stress-api-1.json"), JSON.stringify(stressReport));
    const collection = readRun(dir, "run-a.json");
    // 既有 RunResult 形状：无 kind 包装字段
    expect(collection).toMatchObject({ collectionName: "demo", total: 2 });
    expect(collection).not.toHaveProperty("kind");
    const stress = readRun(dir, "stress-api-1.json");
    expect(stress).toEqual({ kind: "stress", report: stressReport });
  });
});

// —— IPC run 频道（任务 6）：run:collection 走完整 Runner 并落盘 .apicc/runs，runs:list/get 读回 ——
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-runs-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
  return { deps, dir, session };
}

async function createRunFixture(deps: ReturnType<typeof createIpcDeps>, dir: string) {
  const opened = await deps.handle("ws:create", {}, dir, "w");
  const group = await deps.handle("node:create", {}, { kind: "group", parent: { workspaceId: opened.workspace.id }, name: "g" });
  if (group.kind !== "group") throw new Error(`Expected group DTO, received ${group.kind}`);
  const project = await deps.handle("node:create", {}, { kind: "project", parent: group.locator, name: "p" });
  if (project.kind !== "project") throw new Error(`Expected project DTO, received ${project.kind}`);
  const collection = await deps.handle("node:create", {}, { kind: "collection", parent: project.locator, name: "c" });
  if (collection.kind !== "collection") throw new Error(`Expected collection DTO, received ${collection.kind}`);
  const api = await deps.handle("node:create", {}, {
    kind: "api", parent: collection.locator,
    api: { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" },
  });
  if (api.kind !== "api") throw new Error(`Expected API DTO, received ${api.kind}`);
  return { opened, group, project, collection, api };
}

describe("IPC run 频道", () => {
  it("saves scoped configuration and exports/compares only proven same-project saved files", async () => {
    const { deps, dir, session } = setup(); const { project } = await createRunFixture(deps, dir), scope = project.locator;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: "wf" }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } });
    const saved = await deps.handle("stress-plans:save", {}, scope, { name: "nightly", plan });
    expect(await deps.handle("stress-plans:get", {}, scope, saved.id)).toEqual(saved);
    const reopened = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
    expect(await reopened.handle("stress-plans:list", {}, scope)).toEqual([saved]);
    const runs = join(dir, ".apicc", "runs"); mkdirSync(runs, { recursive: true });
    const value = { ...stressReport, projectId: scope.projectId }; writeFileSync(join(runs, "base.json"), JSON.stringify(value)); writeFileSync(join(runs, "next.json"), JSON.stringify({ ...value, rps: 50 }));
    await expect(deps.handle("stress:compare", {}, scope, { baseFile: "base.json", candidateFile: "next.json" })).rejects.toThrow(/归属/);
    writeStressRunScope(dir, "base.json", scope); writeStressRunScope(dir, "next.json", scope);
    writeFileSync(join(runs, 'other-group.json'), JSON.stringify(value));
    writeStressRunScope(dir, 'other-group.json', { ...scope, groupId: IDS.groupTwo });
    writeFileSync(join(runs, 'unproved.json'), JSON.stringify(stressReport));
    expect((await deps.handle('stress-runs:list', {}, scope)).map(row => row.file).sort()).toEqual(['base.json', 'next.json']);
    expect(await deps.handle('stress-runs:get', {}, scope, 'base.json')).toEqual({ kind: 'stress', report: value });
    await expect(deps.handle('stress-runs:get', {}, scope, 'other-group.json')).rejects.toThrow(/归属/);
    await expect(deps.handle('stress-runs:get', {}, scope, 'unproved.json')).rejects.toThrow(/归属/);
    expect((await deps.handle('runs:list', {})).map(row => row.file).sort()).toEqual(['base.json', 'next.json', 'other-group.json', 'unproved.json']);
    expect(await deps.handle('runs:get', {}, 'unproved.json')).toEqual({ kind: 'stress', report: stressReport });
    expect(await deps.handle("stress:compare", {}, scope, { baseFile: "base.json", candidateFile: "next.json" })).toMatchObject({ metrics: { rps: { absolute: 10, relative: 0.25 } } });
    let content = "";
    const exporter = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async (_name, value) => { content = value; return "selected.html"; } });
    expect(await exporter.handle("stress:export", {}, scope, { file: "next.json", baselineFile: "base.json", format: "html" })).toEqual({ saved: true, file: "selected.html" }); expect(content).toContain("Failure evidence");
    expect(await reopened.handle("stress:export", {}, scope, { file: "next.json", format: "json" })).toEqual({ saved: false, file: "" });
    expect(await deps.handle("stress-plans:remove", {}, scope, saved.id)).toEqual(saved);
    writeFileSync(join(runs, 'next.json'), JSON.stringify({ ...value, rps: 60 }));
    await expect(deps.handle('stress-runs:get', {}, scope, 'next.json')).rejects.toThrow(/内容已改变/);
  });
  it("retains a safe in-memory report without claiming saved success when ownership persistence fails", async () => {
    const { deps, dir, session } = setup(); const { api } = await createRunFixture(deps, dir);
    const controller = createStressController(session, { writeReportScope: () => { throw new Error("interrupted scope write"); } });
    const detail = await deps.handle("api:get", {}, api.locator);
    const output = await controller.run({ locator: api.locator, caseId: detail.api.cases[0]!.id, concurrency: 1, maxIterations: 1, confirmedTargetOrigins: ["http://127.0.0.1:1"] });
    expect(output.ok).toBe(true); expect(output.report.totalRequests).toBe(1); expect(output).not.toHaveProperty("file");
  });
  it("run:collection 走完整集合运行并落盘历史；runs:list/runs:get 读回", async () => {
    const { deps, dir } = setup();
    const { collection } = await createRunFixture(deps, dir);
    // 不可达地址 → 用例失败但运行本身完成（Runner 语义，与 debug:send 测试同款）
    const run = await deps.handle("run:collection", {}, { locator: collection.locator });
    if (!run) throw new Error("Expected collection run result");
    expect(run.kind ?? "collection").toBe("collection");
    expect(run.collectionName).toBe("c");
    expect(run.total).toBe(1);
    expect(run.failed).toBe(1);
    const list = await deps.handle("runs:list", {});
    expect(list).toHaveLength(1);
    const summary = list[0];
    if (!summary || summary.kind !== "collection") throw new Error("Expected collection run summary");
    expect(summary.collectionName).toBe("c");
    expect(summary.failed).toBe(1);
    const detail = await deps.handle("runs:get", {}, summary.file);
    if (!detail || detail.kind === "stress") throw new Error("Expected collection run detail");
    expect(detail.kind ?? "collection").toBe("collection");
    expect(detail.total).toBe(1);
    expect(detail.collectionName).toBe("c");
  });

  it("run:collection 未命中集合抛「未找到」；未知 envName 显式抛「未找到环境」；runs:list 未打开工作区抛可读错误", async () => {
    const { deps } = setup();
    await expect(deps.handle("run:collection", {}, { locator: {
      workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne,
    } })).rejects.toThrow(/未打开工作区/);
    const { deps: fresh } = setup();
    await expect(fresh.handle("runs:list", {})).rejects.toThrow(/未打开工作区/);
    // 未知 envName：显式拒绝而非静默降级为无环境运行（审查修复）
    const { deps: full, dir: fullDir } = setup();
    const { collection } = await createRunFixture(full, fullDir);
    await expect(full.handle("run:collection", {}, { locator: { ...collection.locator, collectionId: uuid(2700) } }))
      .rejects.toThrow(/未找到集合/);
    await expect(full.handle("run:collection", {}, { locator: collection.locator, envName: "ghost" })).rejects.toThrow(/未找到环境: ghost/);
    // envName 为空 = 无环境运行，不抛（走完整 Runner，不可达地址 → 运行完成、用例失败）
    const emptyEnvRun = await full.handle("run:collection", {}, { locator: collection.locator, envName: "" });
    expect(emptyEnvRun.total).toBe(1);
  });
});
