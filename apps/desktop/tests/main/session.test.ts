import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StressReportSchema, type ProtocolClient } from "@apicc/core";
import { createSession, sameName } from "../../src/main/session.js";
import { createStressController } from "../../src/main/stress.js";

const root = () => mkdtempSync(join(tmpdir(), "apicc-ui-"));

describe("createSession", () => {
  it("create 建立最小工作区并 open 读回", async () => {
    const s = createSession();
    const dir = root();
    const created = await s.create(dir, "演示");
    expect(created.workspace.name).toBe("演示");
    const opened = await s.open(dir);
    expect(opened.workspace.groups).toEqual([]);
    expect(s.root).toBe(dir);
  });

  it("未打开时 locate 抛错；open 后可经路径定位接口", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g1");
    const p = s.createProject(g.id, "p1");
    const c = s.createCollection(p.id, "c1");
    const api = s.createApi(c.id, null, { name: "ping", method: "GET", url: "{{baseUrl}}/x" });
    const found = s.locateApi(api.id);
    expect(found?.collection.id).toBe(c.id);
    expect(found?.project.id).toBe(p.id);
    expect(s.locateApi("missing")).toBeUndefined();
    const s2 = createSession();
    expect(() => s2.locateApi(api.id)).toThrow(/未打开/);
  });

  it("createApi 附带基座冒烟用例；delete 级联删除接口", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "a", method: "POST", url: "/" });
    expect(api.cases).toHaveLength(1);
    expect(api.cases[0]!.scope).toBe("base");
    await s.save();
    const apiDir = join(dir, "groups", "g", "projects", "p", "collections", "c", "apis", "a");
    expect(existsSync(apiDir)).toBe(true);
    s.deleteNode("api", api.id);
    await s.save();
    expect(s.locateApi(api.id)).toBeUndefined();
    const s2 = createSession();
    await s2.open(dir);
    expect(existsSync(apiDir)).toBe(false);
  });

  it("saveApi 更新接口并落盘（重开读回验证）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "a", method: "GET", url: "/x" });
    api.url = "/changed";
    await s.saveApi(api);
    const s2 = createSession();
    const reopened = await s2.open(dir);
    const found = s2.locateApi(api.id);
    expect(found?.api.url).toBe("/changed");
    expect(reopened.workspace.groups).toHaveLength(1);
  });

  it("deleteNode group 未命中时抛「未找到」（与 memory 契约对齐，宽审查 I3）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    expect(() => s.deleteNode("group", "不存在")).toThrow(/未找到/);
  });

  it("createEnvironment 派生环境并继承父变量；setEnvironmentVariables 覆盖", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    p.environments.push({ id: "e-dev", name: "dev", variables: { baseUrl: "http://d", token: "t" } });
    const env = s.createEnvironment(p.id, { name: "sit", extends: "dev" });
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const sit = s2.workspace!.groups[0]!.projects[0]!.environments.find((e) => e.name === "sit")!;
    expect(sit.extends).toBe("dev");
    await s2.setEnvironmentVariables(sit.id, { baseUrl: "http://s" });
    // 简报修正：session 变更操作不自动落盘（承重语义备忘，IPC 层显式 save），
    // 重开读回前须显式 save——与本文件 renameNode 用例的既有模式一致。
    await s2.save();
    const reopened = createSession();
    await reopened.open(dir);
    const sitVars = reopened.workspace!.groups[0]!.projects[0]!.environments.find((e) => e.name === "sit")!.variables;
    expect(sitVars).toEqual({ baseUrl: "http://s" });
    expect(env.name).toBe("sit");
  });

  it("renameWorkflow 改名后旧目录清理、新目录可读", async () => {
    // 简报骨架：建 g/p/workflow("旧名") → save（断言旧目录存在）→ renameWorkflow → save
    // → 重开断言 workflows[0].name === "新名" 且 join(root, ..., "workflows", "旧名") 不存在。
    // 盘上名刻意用中文（产品常态输入）：清理走 node:fs/promises rm——本机（Windows+Node24）
    // 实测 rmSync 对非 ASCII 路径静默失效/硬崩，此用例同时钉住该修复不回退到 rmSync。
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "旧名");
    await s.save();
    const oldDir = join(dir, "groups", "g", "projects", "p", "workflows", "旧名");
    expect(existsSync(oldDir)).toBe(true);
    await s.renameWorkflow(wf.id, "新名");
    expect(existsSync(oldDir)).toBe(false);
    // 同项目重名拒绝（与 createWorkflow 同文案）：wf 已改名后，另一条流不得再改成「新名」
    const other = s.createWorkflow(p.id, "另一条流");
    await s.save();
    await expect(s.renameWorkflow(other.id, "新名")).rejects.toThrow(/工作流已存在: 新名/);
    expect(s.locateWorkflow(other.id)?.workflow.name).toBe("另一条流");
    const s2 = createSession();
    const reopened = await s2.open(dir);
    // 重开读回：改名已持久化（按 id 取，不依赖盘上目录的字典序）
    const reopenedWfs = reopened.workspace.groups[0]!.projects[0]!.workflows;
    expect(reopenedWfs.find((w) => w.id === wf.id)!.name).toBe("新名");
    expect(existsSync(join(dir, "groups", "g", "projects", "p", "workflows", "新名"))).toBe(true);
    expect(s2.locateWorkflow(wf.id)?.workflow.name).toBe("新名");
  });

  it("cleanupOrphanDirs 清理已删除工作流的残留目录", async () => {
    // 简报骨架：save 含 wf → 内存 deleteWorkflow → save → 旧目录不存在（中文盘上名同上）
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "残留流");
    await s.save();
    const wfDir = join(dir, "groups", "g", "projects", "p", "workflows", "残留流");
    expect(existsSync(wfDir)).toBe(true);
    s.deleteWorkflow(wf.id);
    await s.save();
    expect(existsSync(wfDir)).toBe(false);
    expect(s.locateWorkflow(wf.id)).toBeUndefined();
  });

  // —— C1（Critical）回归：win32 大小写不敏感文件系统上的改名孤儿清理 ——
  // NTFS 上 save 按 name 写盘时 `workflows\Flow` 解析命中既有 `flow` 目录（盘名保持
  // flow），cleanup 若按 x.name === "Flow" 严格比较 readdir 得 ["flow"] 不匹配，会把
  // 刚写入的目录当孤儿递归删除（数据破坏）。平台判定经 createSession({ platform })
  // 注入（默认取 process.platform），本用例未注入——本机（Windows）即真实 NTFS 语义
  // 端到端复现；POSIX 平台大小写敏感、save 正常新建目录，行为等价通过。
  it("win32 大小写改名 flow→Flow：save 后重开工作流仍在、盘上目录不丢（C1 端到端）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "flow");
    await s.save();
    const flowDir = join(dir, "groups", "g", "projects", "p", "workflows", "flow");
    expect(existsSync(flowDir)).toBe(true);
    await s.renameWorkflow(wf.id, "Flow");
    if (process.platform === "win32") {
      // 修复前：刚写入（NTFS 解析到既有同名目录）的工作流目录被 cleanup 递归删除
      expect(existsSync(flowDir)).toBe(true);
    }
    const s2 = createSession();
    const reopened = await s2.open(dir);
    const found = reopened.workspace.groups[0]!.projects[0]!.workflows.find((w) => w.id === wf.id);
    expect(found?.name).toBe("Flow");
  });

  // 注入 win32 平台标志复现「模型名 Flow、盘上目录 flow」的 NTFS 解析态（C1 归一匹配）：
  // cleanup 各层（workflows/collections/groups/projects/apis/folders）按 sameName 比较，
  // 大小写变体目录不得被判孤儿。POSIX 上改名会真实新建 Flow 目录（大小写敏感语义），
  // 本用例只钉「大小写变体不判孤儿」这一 win32 行为，任意平台可复现。
  it("注入 win32：cleanupOrphanDirs 不把大小写变体目录当孤儿（C1 归一匹配）", async () => {
    const s = createSession({ platform: "win32" });
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "flow");
    await s.save();
    await s.renameWorkflow(wf.id, "Flow");
    await s.save();
    // 修复前（严格比较）：flow 目录与模型名 Flow 不匹配 → 被递归删除
    expect(existsSync(join(dir, "groups", "g", "projects", "p", "workflows", "flow"))).toBe(true);
  });

  it("注入 win32：createWorkflow/renameWorkflow 重名检查大小写归一（C1）", async () => {
    const s = createSession({ platform: "win32" });
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const flow = s.createWorkflow(p.id, "flow");
    // win32 上 flow/FLOW 是同一盘上目录：重名拒绝（修复前严格比较放行 → save 双写同目录互覆）
    expect(() => s.createWorkflow(p.id, "FLOW")).toThrow(/工作流已存在: FLOW/);
    const other = s.createWorkflow(p.id, "其它流");
    await expect(s.renameWorkflow(other.id, "Flow")).rejects.toThrow(/工作流已存在: Flow/);
    // 自身大小写改名放行（id 排除自身）——修正大小写是最常见改名动机
    await expect(s.renameWorkflow(flow.id, "Flow")).resolves.toBeUndefined();
    expect(s.locateWorkflow(flow.id)?.workflow.name).toBe("Flow");
    // 对照：非 win32 平台标志保持严格比较（POSIX 大小写敏感，变体名不冲突）
    const s2 = createSession({ platform: "linux" });
    const dir2 = root();
    await s2.create(dir2, "w");
    await s2.open(dir2);
    const g2 = s2.createGroup("g");
    const p2 = s2.createProject(g2.id, "p");
    s2.createWorkflow(p2.id, "flow");
    expect(() => s2.createWorkflow(p2.id, "FLOW")).not.toThrow();
  });

  it("sameName 纯函数：win32 两侧 toLowerCase 归一，其余平台严格相等", () => {
    expect(sameName("Flow", "flow", "win32")).toBe(true);
    expect(sameName("FLOW", "flow", "win32")).toBe(true);
    expect(sameName("flow", "flow", "win32")).toBe(true);
    expect(sameName("flow", "flowx", "win32")).toBe(false);
    expect(sameName("Flow", "flow", "linux")).toBe(false);
    expect(sameName("Flow", "Flow", "darwin")).toBe(true);
    // 默认平台参数 = process.platform（win32 归一，其余严格）
    expect(sameName("a", "a")).toBe(true);
    expect(sameName("a", "A", process.platform)).toBe(process.platform === "win32");
  });

  it("renameNode 重命名集合（盘上目录随 save 更新，旧目录清理）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "old-name");
    await s.save();
    const oldDir = join(dir, "groups", "g", "projects", "p", "collections", "old-name");
    expect(existsSync(oldDir)).toBe(true);
    s.renameNode("collection", c.id, "new-name");
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const names = s2.workspace!.groups[0]!.projects[0]!.collections.map((x) => x.name);
    expect(names).toEqual(["new-name"]);
    expect(existsSync(oldDir)).toBe(false);
  });
});

// —— 压测控制器（M2-D3 任务 1）：main 进程 StressRunner 执行/停止/单活动约束 ——
/** 夹具：工作区 + 分组/项目/集合/接口各一（接口指向不可达地址，采样快速失败不依赖网络）。 */
async function setupStress() {
  const s = createSession();
  const dir = root();
  await s.create(dir, "w");
  await s.open(dir);
  const g = s.createGroup("g");
  const p = s.createProject(g.id, "p");
  const c = s.createCollection(p.id, "c");
  const api = s.createApi(c.id, null, { name: "ping", method: "GET", url: "http://127.0.0.1:1/" });
  return { s, dir, api };
}

/** 挂起假 client：execute 进入即计数并停在 gate 上，制造「活动运行窗口」供并发/停止断言。 */
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

describe("createStressController", () => {
  it("迭代压测：报告过 StressReportSchema、totalRequests 与迭代数一致，落盘 .apicc/runs/stress-*.json", async () => {
    const { s, dir, api } = await setupStress();
    const controller = createStressController(s);
    const out = await controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 2, maxIterations: 4 });
    expect(() => StressReportSchema.parse(out.report)).not.toThrow();
    expect(out.report.totalRequests).toBe(4);
    expect(out.file).toMatch(new RegExp(`^stress-${api.id}-\\d+\\.json$`));
    expect(existsSync(join(dir, ".apicc", "runs", out.file!))).toBe(true);
  });

  it("单活动约束：活动运行未结束时再次 stressRun 抛「已有压测进行中」", async () => {
    const { s, api } = await setupStress();
    const fake = hangingClient();
    const controller = createStressController(s, { client: fake.client });
    const first = controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 2 });
    await fake.waitEntered();
    await expect(controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 2 })).rejects.toThrow(/已有压测进行中/);
    fake.release();
    expect((await first).report.totalRequests).toBe(2);
  });

  it("stress:stop：运行中 abort 返回部分报告（totalRequests ≤ maxIterations）并落盘；无活动运行抛「没有进行中的压测」", async () => {
    const { s, dir, api } = await setupStress();
    const fake = hangingClient();
    const controller = createStressController(s, { client: fake.client });
    await expect(controller.stop()).rejects.toThrow(/没有进行中的压测/);
    const first = controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 100 });
    await fake.waitEntered();
    const stopping = controller.stop();
    fake.release(); // 信号语义：停止发起新采样、等在途请求完成后聚合
    const stopped = await stopping;
    expect(stopped.report.totalRequests).toBeGreaterThanOrEqual(1);
    expect(stopped.report.totalRequests).toBeLessThanOrEqual(100);
    expect(existsSync(join(dir, ".apicc", "runs", stopped.file!))).toBe(true);
    await first;
    // 完成后活动状态清空：再次 stop 回到「没有进行中的压测」
    await expect(controller.stop()).rejects.toThrow(/没有进行中的压测/);
  });

  it("未找到接口/用例/环境：错误文案与 debug 频道同款", async () => {
    const { s, api } = await setupStress();
    const controller = createStressController(s);
    await expect(controller.run({ apiId: "ghost", caseId: "x", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/未找到接口: ghost/);
    await expect(controller.run({ apiId: api.id, caseId: "ghost", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/用例不存在: ghost/);
    await expect(controller.run({ apiId: api.id, caseId: api.cases[0]!.id, envName: "ghost", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/未找到环境: ghost/);
  });

  it("迭代与时长都缺：抛「压测终止条件缺失」（沿用 core 文案）", async () => {
    const { s, api } = await setupStress();
    const controller = createStressController(s);
    await expect(controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1 })).rejects.toThrow(/压测终止条件缺失/);
  });

  it("落盘失败降级：写盘异常不阻断报告返回（file 省略）并 console.warn 含路径与原因（与集合运行口径一致）", async () => {
    const { s, api } = await setupStress();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const controller = createStressController(s, {
        // 注入写盘失败（代码库既有模式为控制器 deps 注入，同 client/pickDirectory/saveFile 先例）
        writeReport: () => {
          throw new Error("disk full");
        },
      });
      const out = await controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 1 });
      expect(out.report.totalRequests).toBe(1);
      expect(out.file).toBeUndefined();
      expect("file" in out).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const [msg] = warn.mock.calls[0]!;
      expect(msg).toContain("落盘失败");
      expect(msg).toContain("stress-"); // 文件路径
      expect(msg).toContain("disk full"); // 原因
    } finally {
      warn.mockRestore();
    }
  });

  it("深拷贝回归：改动返回的报告对象不影响已落盘历史内容", async () => {
    const { s, dir, api } = await setupStress();
    const controller = createStressController(s);
    const out = await controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 2 });
    out.report.totalRequests = 999;
    const onDisk = JSON.parse(readFileSync(join(dir, ".apicc", "runs", out.file!), "utf8")) as { totalRequests: number };
    expect(onDisk.totalRequests).toBe(2);
  });

  it("M5 终审：非 HTTP 接口压测 fail-fast 拒绝（对齐 CLI 协议感知），HTTP 接口照常", async () => {
    const { s, api } = await setupStress();
    // 计数假 client：守卫必须在任何采样前拒绝（calls 恒 0），否则钉死 httpClient 的
    // 桌面控制器会对非 HTTP 接口以错协议静默错执行（SOAP 无信封 POST / WS scheme 错）。
    let calls = 0;
    const counting: ProtocolClient = {
      name: "counting",
      canHandle: () => true,
      execute: async () => {
        calls += 1;
        return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
      },
    };
    const c = s.workspace!.groups[0]!.projects[0]!.collections[0]!;
    const soapApi = s.createApi(c.id, null, { name: "soap-op", method: "POST", url: "http://127.0.0.1:1/soap" });
    soapApi.protocol = "soap";
    soapApi.envelope = "<Envelope/>";
    await s.saveApi(soapApi);
    const wsApi = s.createApi(c.id, null, { name: "ws-op", method: "GET", url: "ws://127.0.0.1:1/echo" });
    wsApi.protocol = "websocket";
    wsApi.message = "ping";
    await s.saveApi(wsApi);

    const controller = createStressController(s, { client: counting });
    await expect(
      controller.run({ apiId: soapApi.id, caseId: soapApi.cases[0]!.id, concurrency: 1, maxIterations: 1 }),
    ).rejects.toThrow("桌面压测面板当前仅支持 HTTP 接口（WS/SOAP 压测请使用 CLI run-stress）");
    await expect(
      controller.run({ apiId: wsApi.id, caseId: wsApi.cases[0]!.id, concurrency: 1, maxIterations: 1 }),
    ).rejects.toThrow(/桌面压测面板当前仅支持 HTTP 接口/);
    expect(calls).toBe(0); // 拒绝发生在任何采样之前（fail-fast，不产出错协议报告）
    expect(s.root && existsSync(join(s.root, ".apicc", "runs"))).toBe(false); // 无报告落盘

    // HTTP 接口不受守卫影响，照常执行
    const out = await controller.run({ apiId: api.id, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 1 });
    expect(out.report.totalRequests).toBe(1);
    expect(calls).toBe(1);
  });
});
