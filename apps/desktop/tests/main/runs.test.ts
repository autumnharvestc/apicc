import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRuns, readRun } from "../../src/main/runs.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";

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
    expect(list[0]!.collectionName).toBe("demo");
    expect(readRun(dir, "run-a.json")!.total).toBe(2);
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
});

// —— IPC run 频道（任务 6）：run:collection 走完整 Runner 并落盘 .apicc/runs，runs:list/get 读回 ——
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-runs-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir });
  return { deps, dir };
}

describe("IPC run 频道", () => {
  it("run:collection 走完整集合运行并落盘历史；runs:list/runs:get 读回", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    // 不可达地址 → 用例失败但运行本身完成（Runner 语义，与 debug:send 测试同款）
    const run = await deps.handle("run:collection", {}, { collectionId: c.id });
    expect(run.collectionName).toBe("c");
    expect(run.total).toBe(1);
    expect(run.failed).toBe(1);
    const list = await deps.handle("runs:list", {});
    expect(list).toHaveLength(1);
    expect(list[0]!.collectionName).toBe("c");
    expect(list[0]!.failed).toBe(1);
    const detail = await deps.handle("runs:get", {}, list[0]!.file);
    expect(detail).not.toBeNull();
    expect(detail!.total).toBe(1);
    expect(detail!.collectionName).toBe("c");
  });

  it("run:collection 未命中集合抛「未找到」；未知 envName 显式抛「未找到环境」；runs:list 未打开工作区抛可读错误", async () => {
    const { deps } = setup();
    await expect(deps.handle("run:collection", {}, { collectionId: "不存在" })).rejects.toThrow(/未打开工作区/);
    const { deps: fresh } = setup();
    await expect(fresh.handle("runs:list", {})).rejects.toThrow(/未打开工作区/);
    // 未知 envName：显式拒绝而非静默降级为无环境运行（审查修复）
    const { deps: full, dir: fullDir } = setup();
    await full.handle("ws:create", {}, fullDir, "w");
    const g = await full.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await full.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await full.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    await full.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    await expect(full.handle("run:collection", {}, { collectionId: c.id, envName: "ghost" })).rejects.toThrow(/未找到环境: ghost/);
    // envName 为空 = 无环境运行，不抛（走完整 Runner，不可达地址 → 运行完成、用例失败）
    const emptyEnvRun = await full.handle("run:collection", {}, { collectionId: c.id, envName: "" });
    expect(emptyEnvRun.total).toBe(1);
  });
});
