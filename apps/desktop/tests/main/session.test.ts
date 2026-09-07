import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
    // M10：新建目录自带默认分组
    expect(opened.workspace.groups).toHaveLength(1);
    expect(opened.workspace.groups[0]).toMatchObject({ name: "默认分组", default: true });
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
    // id 布局（轨一）：盘上目录名=实体 id
    const apiDir = join(dir, "groups", g.id, "projects", p.id, "collections", c.id, "apis", api.id);
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
    expect(reopened.workspace.groups).toHaveLength(2); // 默认分组 + 自建分组
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
    // id 布局（轨一）：环境文件名=环境 id，夹具 id 须 UUID 形态
    p.environments.push({ id: randomUUID(), name: "dev", variables: { baseUrl: "http://d", token: "t" }, baseUrls: {} });
    const env = s.createEnvironment(p.id, { name: "sit", extends: "dev" });
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const sit = s2.workspace!.groups.find((x) => x.name === "g")!.projects[0]!.environments.find((e) => e.name === "sit")!;
    expect(sit.extends).toBe("dev");
    await s2.setEnvironmentVariables(sit.id, { baseUrl: "http://s" });
    // 简报修正：session 变更操作不自动落盘（承重语义备忘，IPC 层显式 save），
    // 重开读回前须显式 save——与本文件 renameNode 用例的既有模式一致。
    await s2.save();
    const reopened = createSession();
    await reopened.open(dir);
    const sitVars = reopened.workspace!.groups.find((x) => x.name === "g")!.projects[0]!.environments.find((e) => e.name === "sit")!.variables;
    expect(sitVars).toEqual({ baseUrl: "http://s" });
    expect(env.name).toBe("sit");
  });

  it("renameWorkflow 改名后仅名称变化、盘上 id 目录不丢", async () => {
    // id 布局（轨一）：目录名=工作流 id，改名只改 yaml 内名称——目录恒在、重开读回新名。
    // 清理语义仍由 node:fs/promises rm 承担（本机 Windows+Node24 对非 ASCII 路径 rmSync
    // 静默失效/硬崩的修复不回退），删除工作流场景见下一用例。
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const wf = s.createWorkflow(p.id, "旧名");
    await s.save();
    const wfDir = join(dir, "groups", g.id, "projects", p.id, "workflows", wf.id);
    expect(existsSync(wfDir)).toBe(true);
    await s.renameWorkflow(wf.id, "新名");
    // 改名不动盘上目录（id 目录恒在）
    expect(existsSync(wfDir)).toBe(true);
    const s2 = createSession();
    const reopened = await s2.open(dir);
    // 重开读回：改名已持久化（按 id 取，不依赖盘上目录的字典序）
    const reopenedWfs = reopened.workspace.groups.find((x) => x.name === "g")!.projects[0]!.workflows;
    expect(reopenedWfs.find((w) => w.id === wf.id)!.name).toBe("新名");
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
    const wfDir = join(dir, "groups", g.id, "projects", p.id, "workflows", wf.id);
    expect(existsSync(wfDir)).toBe(true);
    s.deleteWorkflow(wf.id);
    await s.save();
    expect(existsSync(wfDir)).toBe(false);
    expect(s.locateWorkflow(wf.id)).toBeUndefined();
  });

  // —— C1（Critical）回归的两条 NTFS 大小写用例随 id 布局（轨一）移除：目录名=UUID 后
  // 「模型名 Flow / 盘上目录 flow」的解析态这一错误类别整体消亡，rename 仅改 yaml 名称
  // 且 id 目录恒在（由 renameWorkflow 用例钉住）。同名放开（轨二）后重名拒绝整体移除，
  // sameName 归一比较仅剩 ensureDefaultGroup 的同名补标记在用。 ——
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

  it("renameNode 重命名集合（仅名称变化，id 目录恒在）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "old-name");
    await s.save();
    const cDir = join(dir, "groups", g.id, "projects", p.id, "collections", c.id);
    expect(existsSync(cDir)).toBe(true);
    s.renameNode("collection", c.id, "new-name");
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    const names = s2.workspace!.groups.find((x) => x.name === "g")!.projects[0]!.collections.map((x) => x.name);
    expect(names).toEqual(["new-name"]);
    expect(existsSync(cDir)).toBe(true);
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
    const c = s.workspace!.groups.find((x) => x.name === "g")!.projects[0]!.collections[0]!;
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

// —— M9-A2：名称净化（非法字符 mkdir ENOENT 用户回归）。id 布局（轨一）后名称不再
// 上盘，净化保留为名称卫生（显示/导出口径）；同级重名拒绝仍在（轨二放开后移除） ——
describe("session 名称净化（M9-A2）", () => {
  it("createApi 名称含路径非法字符：净化为安全名称并重开可读（用户 ENOENT 回归）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const api = s.createApi(c.id, null, { name: "http://localhost:8080/api/health", method: "GET", url: "/health" });
    for (const ch of ["/", ":", String.fromCharCode(92)]) expect(api.name).not.toContain(ch);
    expect(api.name).toContain("http");
    await s.save();
    // id 布局：盘上目录=接口 id，名称仅存 yaml 内容
    const apiDir = join(dir, "groups", g.id, "projects", p.id, "collections", c.id, "apis", api.id);
    expect(existsSync(apiDir)).toBe(true);
    const s2 = createSession();
    await s2.open(dir);
    expect(s2.locateApi(api.id)?.api.name).toBe(api.name);
  });

  it("create*/renameNode 统一净化：非法字符替换、结尾点清理、空名回退", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("  ");
    expect(g.name).toBe("未命名");
    const p = s.createProject(g.id, 'a*b<c>?"|');
    expect(p.name).toBe("a-b-c----");
    const c = s.createCollection(p.id, "dir.");
    expect(c.name).toBe("dir");
    const api = s.createApi(c.id, null, { name: "x", method: "GET", url: "/" });
    s.renameNode("api", api.id, "y/z:*");
    expect(s.locateApi(api.id)?.api.name).toBe("y-z--");
  });

  it("同级同名并存：分组/项目/集合/接口创建与重命名（轨二同名放开，id 为身份）", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const g2 = s.createGroup("g");
    expect(g2.id).not.toBe(g.id); // 同名分组并存
    const p = s.createProject(g.id, "p");
    const pDup = s.createProject(g.id, "p");
    expect(pDup.id).not.toBe(p.id); // 同分组同名项目并存
    const c = s.createCollection(p.id, "c");
    const cDup = s.createCollection(p.id, "c");
    expect(cDup.id).not.toBe(c.id); // 同名模块并存
    s.createApi(c.id, null, { name: "a", method: "GET", url: "/" });
    const aDup = s.createApi(c.id, null, { name: "a", method: "GET", url: "/" });
    expect(aDup.name).toBe("a"); // 同目录同名接口并存
    // 重命名到已存在名称直接成功（默认分组守卫与「未找到」仍保留）
    s.renameNode("collection", cDup.id, "c");
    expect(s.locateCollection(cDup.id)!.collection.name).toBe("c");
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    // id 布局（轨一）：重开加载按目录名（=UUID）字典序，分组顺序随机——按名称聚合断言
    const groups = s2.workspace!.groups.filter((x) => x.name === "g");
    expect(groups).toHaveLength(2);
    const withProjects = groups.filter((x) => x.projects.length === 2);
    expect(withProjects).toHaveLength(1); // 两个同名分组中，仅先建的承载项目；后建的为空壳并存
    expect(withProjects[0]!.projects.filter((x) => x.name === "p")).toHaveLength(2);
    // 项目内模块顺序同为 UUID 字典序（随机）——按内容定位承载集合的项目
    const hostProject = withProjects[0]!.projects.find((x) => x.collections.length === 2)!;
    expect(hostProject.collections.filter((x) => x.name === "c")).toHaveLength(2);
  });
});

// —— M9-B：环境前置 URL 与工作区全局设置通道（落盘重开读回） ——
describe("session 环境模型（M9-B）", () => {
  it("setEnvironmentBaseUrls 落盘重开读回；setWorkspaceGlobals 整体替换并读回", async () => {
    const s = createSession();
    const dir = root();
    await s.create(dir, "w");
    await s.open(dir);
    const g = s.createGroup("g");
    const p = s.createProject(g.id, "p");
    const c = s.createCollection(p.id, "c");
    const env = s.createEnvironment(p.id, { name: "dev" });
    s.setEnvironmentBaseUrls(env.id, { [c.id]: "http://base" });
    // M10：项目级全局设置（参数四类；全局变量=project.variables 另行编辑）
    s.setProjectGlobals(p.id, { variables: {}, query: [{ key: "q", value: "1", enabled: true }], headers: [], cookies: [], body: [] });
    await s.save();
    const s2 = createSession();
    await s2.open(dir);
    // 打开即保障默认分组：seed 无任何带标记分组 → 同名就地补标记（不新建、不覆盖）
    const defaultGroup = s2.workspace!.groups.find((x) => x.default === true);
    expect(defaultGroup).toBeDefined();
    const project = s2.workspace!.groups.find((x) => x.name === "g")!.projects[0]!;
    expect(project.environments[0]!.baseUrls).toEqual({ [c.id]: "http://base" });
    expect(s2.getProjectGlobals(p.id)).toEqual({
      variables: {}, query: [{ key: "q", value: "1", enabled: true }], headers: [], cookies: [], body: [],
    });
    // 未命中环境照旧抛「未找到」
    expect(() => s2.setEnvironmentBaseUrls("nope", {})).toThrow("未找到环境");
  });
});
