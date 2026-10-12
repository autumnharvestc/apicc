import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRuns, readRun } from "../../src/main/runs.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IDS, uuid } from "./helpers/contract-assets.js";

const sample = {
  collectionId: "c", collectionName: "demo", startedAt: "2026-09-02T00:00:00.000Z",
  finishedAt: "2026-09-02T00:00:01.000Z", total: 2, passed: 1, failed: 1, cases: [],
};

describe("runs 历史", () => {
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
  it("run:collection 走完整集合运行并落盘历史；runs:list/runs:get 读回", async () => {
    const { deps, dir } = setup();
    const { collection } = await createRunFixture(deps, dir);
    // 不可达地址 → 用例失败但运行本身完成（Runner 语义，与 debug:send 测试同款）
    const run = await deps.handle("run:collection", {}, { locator: collection.locator });
    if (!run || "kind" in run) throw new Error("Expected collection run result");
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
    if (!detail || "kind" in detail) throw new Error("Expected collection run detail");
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
