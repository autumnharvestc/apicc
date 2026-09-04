// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import type { RunResult } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useRunStore } from "../../../src/renderer/src/stores/run.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  // 种子树：根 → 分组[0] → 项目[0] → 集合[0]
  const collectionNode = ws.tree!.children![0]!.children![0]!.children![0]!;
  const run = useRunStore(api);
  return { api, ws, run, collectionNode };
}

describe("run store", () => {
  it("runCollection 后 result 为成功 RunResult、running 复位；历史列表出现该次运行", async () => {
    const { run, collectionNode } = await seeded();
    expect(run.result).toBeNull();
    await run.runCollection(collectionNode.id);
    expect(run.running).toBe(false);
    expect(run.result).not.toBeNull();
    expect(run.result!.collectionName).toBe("示例集合");
    expect(run.result!.passed).toBe(run.result!.total);
    await run.loadHistory();
    expect(run.summaries).toHaveLength(1);
    // kind 判别（M2-D3 任务 1）：集合运行摘要带 kind: "collection"
    expect(run.summaries[0]).toMatchObject({ kind: "collection", collectionName: "示例集合" });
    expect(run.summaries[0]!.file).toMatch(/^run-memory-.*\.json$/);
  });

  it("openRun 按文件读回完整结果回填 result；未命中文件保持现状", async () => {
    const { run, collectionNode } = await seeded();
    await run.runCollection(collectionNode.id);
    await run.loadHistory();
    const file = run.summaries[0]!.file;
    run.result = null;
    await run.openRun(file);
    expect(run.result).not.toBeNull();
    expect(run.result!.collectionName).toBe("示例集合");
    // 未命中文件（主进程 runsGet 返回 null）→ result 不被清掉
    await run.openRun("不存在.json");
    expect(run.result).not.toBeNull();
  });

  it("running 门控：运行中重复触发不并发（api 只被调一次）", async () => {
    const { api, run, collectionNode } = await seeded();
    const finished: RunResult = {
      collectionId: collectionNode.id, collectionName: "示例集合",
      startedAt: "2026-09-02T00:00:00.000Z", finishedAt: "2026-09-02T00:00:00.000Z",
      total: 1, passed: 1, failed: 0, cases: [],
    };
    let calls = 0;
    let release: () => void = () => {};
    api.runCollection = async () => {
      calls++;
      return new Promise<RunResult>((resolve) => {
        release = () => resolve(finished);
      });
    };
    const first = run.runCollection(collectionNode.id);
    const second = run.runCollection(collectionNode.id); // 运行中被门控忽略
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(run.running).toBe(false);
    expect(run.result).toEqual(finished);
  });

  it("runCollection 未命中集合时上抛（与 session/memory「未找到」语义对齐），running 复位", async () => {
    const { run } = await seeded();
    await expect(run.runCollection("不存在")).rejects.toThrow(/未找到集合/);
    expect(run.running).toBe(false);
  });
});
