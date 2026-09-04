// memory 替身压测语义（M2-D3 任务 1）：stressRun 用进程内 StressRunner + 可注入假 client，
// 与真实 IPC 同构（单活动拒绝/stop/错误文案/历史 kind 判别），测试不需要真实网络。
import { describe, expect, it } from "vitest";
import { StressReportSchema, type ProtocolClient } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";

/** 夹具：种子工作区并定位到唯一接口（group→project→collection→api）。 */
async function seededMemory(client?: ProtocolClient) {
  const api = createMemoryApi(client ? { stressClient: client } : undefined);
  api.seedWorkspace();
  const tree = await api.treeGet();
  const apiNode = tree.children![0]!.children![0]!.children![0]!.children![0]!;
  const detail = await api.apiGet(apiNode.id);
  return { api, apiId: apiNode.id, caseId: detail.api.cases[0]!.id };
}

/** 挂起假 client：execute 进入即计数并停在 gate 上，制造「活动运行窗口」。 */
function hangingClient() {
  let entered = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const client: ProtocolClient = {
    name: "hanging",
    canHandle: () => true,
    execute: async () => {
      entered += 1;
      await gate;
      return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
    },
  };
  return { client, waitEntered: async () => { while (entered === 0) await new Promise((r) => setTimeout(r, 1)); }, release: () => release() };
}

describe("memory 替身压测语义", () => {
  it("stressRun 用假 client 产出 {report,file}：报告过 schema、计入历史 stress 行、runsGet 读回 StressReportDTO", async () => {
    let calls = 0;
    const client: ProtocolClient = {
      name: "fake",
      canHandle: () => true,
      execute: async () => {
        calls += 1;
        return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
      },
    };
    const { api, apiId, caseId } = await seededMemory(client);
    const out = await api.stressRun({ apiId, caseId, concurrency: 2, maxIterations: 4 });
    expect(calls).toBe(4); // 假 client 替代真实网络
    expect(() => StressReportSchema.parse(out.report)).not.toThrow();
    expect(out.report.totalRequests).toBe(4);
    expect(out.file).toMatch(/^stress-.+-\d+\.json$/);
    const list = await api.runsList();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("stress");
    expect(list[0]).toMatchObject({ totalRequests: 4, ok: 4, failed: 0 });
    const detail = await api.runsGet(out.file!);
    expect(detail).toEqual({ kind: "stress", report: out.report });
  });

  it("单活动拒绝与 stop：活动窗口内二次启动抛「已有压测进行中」，stop 返回部分报告，无活动抛「没有进行中的压测」", async () => {
    const fake = hangingClient();
    const { api, apiId, caseId } = await seededMemory(fake.client);
    await expect(api.stressStop()).rejects.toThrow(/没有进行中的压测/);
    const first = api.stressRun({ apiId, caseId, concurrency: 1, maxIterations: 100 });
    await fake.waitEntered();
    await expect(api.stressRun({ apiId, caseId, concurrency: 1, maxIterations: 100 })).rejects.toThrow(/已有压测进行中/);
    const stopping = api.stressStop();
    fake.release();
    const stopped = await stopping;
    expect(stopped.report.totalRequests).toBeGreaterThanOrEqual(1);
    expect(stopped.report.totalRequests).toBeLessThanOrEqual(100);
    await first;
    await expect(api.stressStop()).rejects.toThrow(/没有进行中的压测/);
  });

  it("错误契约同构：未找到接口/用例/环境文案与主进程一致", async () => {
    const { api, apiId, caseId } = await seededMemory();
    await expect(api.stressRun({ apiId: "ghost", caseId: "x", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/未找到接口: ghost/);
    await expect(api.stressRun({ apiId, caseId: "ghost", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/用例不存在: ghost/);
    await expect(api.stressRun({ apiId, caseId, envName: "ghost", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/未找到环境: ghost/);
  });

  it("终止条件缺失：沿用 core 文案「压测终止条件缺失」", async () => {
    const { api, apiId, caseId } = await seededMemory();
    await expect(api.stressRun({ apiId, caseId, concurrency: 1 })).rejects.toThrow(/压测终止条件缺失/);
  });

  it("深拷贝回归：改动返回的报告对象不影响内存历史读回内容", async () => {
    const { api, apiId, caseId } = await seededMemory();
    const out = await api.stressRun({ apiId, caseId, concurrency: 1, maxIterations: 2 });
    out.report.totalRequests = 999;
    const detail = await api.runsGet(out.file!);
    expect(detail).toMatchObject({ kind: "stress", report: { totalRequests: 2 } });
  });
});
