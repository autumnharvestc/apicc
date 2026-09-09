// @vitest-environment jsdom
// M3-B 任务 3：onlineStore 工作区浏览/编辑/冲突/迁移动作测试（渲染侧装配核心）。
// 覆盖 plan 任务 3 步骤 1：①打开在线工作区（树/项目角色入 store）②编辑保存（baseVersion
// 推送 + 成功前移）与 409 冲突（拉取覆盖我的/放弃）③迁移拉取（计数 + 落盘）④迁移推送
// （batch 差异 + 冲突跳过列出）⑤⑥关闭清理与迁移单活动护栏。坏数据进 problems 不崩。
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi, ONLINE_SEED_PROJECT_ID } from "../../../src/renderer/src/api/memory.js";
import { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import type { OnlineBatchResult } from "../../../src/shared/online/contract.js";

const SERVER = "http://127.0.0.1:8080";
// path 实体化（2026-09-08）：种子内容 path 首段=项目实体 UUID（memory 替身种子常量防漂移）
const API_PATH = `${ONLINE_SEED_PROJECT_ID}/collections/示例集合/apis/示例接口/api.yaml`;
const VALID_API_YAML = [
  "id: api-online-1",
  "name: 示例接口",
  "version: 1.0.0",
  "deprecated: false",
  "method: GET",
  'url: "/ping"',
  "headers: []",
  "query: []",
  "cases: []",
  "",
].join("\n");

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function setup() {
  const api = createMemoryApi();
  const store = createOnlineStore({ api, storage: memStorage() });
  store.addProfile(SERVER, "甲");
  await store.login("alice", "password8");
  await store.refreshWorkspaces();
  return { api, store };
}

async function opened() {
  const ctx = await setup();
  await ctx.store.openWorkspace(ctx.store.workspaces[0]!);
  return ctx;
}

describe("打开/关闭在线工作区（步骤 1①⑥）", () => {
  it("openWorkspace：activeWorkspace/树视图/项目角色入 store；树 root label = 工作区名", async () => {
    const { store } = await setup();
    const ws = store.workspaces[0]!;
    await store.openWorkspace(ws);
    expect(store.activeWorkspace).toEqual({ id: ws.id, name: ws.name, myRole: "OWNER" });
    expect(store.onlineTree?.kind).toBe("root");
    expect(store.onlineTree?.label).toBe(ws.name);
    expect(store.projects).toHaveLength(1);
    expect(store.error).toBeNull();
  });

  it("closeWorkspace：清工作区态 + 树 + 编辑缓冲（裁定 E 会话清理）", async () => {
    const { store } = await opened();
    await store.selectNode("file", "apicc.workspace.yaml");
    expect(store.editorPath).toBe("apicc.workspace.yaml");
    await store.closeWorkspace();
    expect(store.activeWorkspace).toBeNull();
    expect(store.onlineTree).toBeNull();
    expect(store.projects).toEqual([]);
    expect(store.editorPath).toBeNull();
    expect(store.editorApi).toBeNull();
    expect(store.editorRaw).toBe("");
    expect(store.conflict).toBeNull();
  });

  it("openWorkspace 失败（api 抛错）→ error 通道、状态不变", async () => {
    const { api, store } = await setup();
    api.onlineWorkspaceOpen = async () => {
      throw new Error("服务器失联");
    };
    await store.openWorkspace(store.workspaces[0]!);
    expect(store.error).toBe("服务器失联");
    expect(store.activeWorkspace).toBeNull();
  });
});

describe("在线接口编辑（步骤 1①②：VIEWER 只读 vs EDITOR 可编辑，坏数据进 problems）", () => {
  it("selectNode api：合法 api.yaml → 解析进编辑缓冲，dirty 快照复位；修改 → dirty", async () => {
    const { api, store } = await opened();
    await api.onlineFilePut({ workspaceId: store.activeWorkspace!.id, path: API_PATH, content: VALID_API_YAML, baseVersion: 1 });
    await store.selectNode("api", API_PATH);
    expect(store.editorKind).toBe("api");
    expect(store.editorApi?.method).toBe("GET");
    expect(store.editorDirty).toBe(false);
    expect(store.editorProblems).toEqual([]);
    expect(store.editorVersion).toBe(2);
    store.editorApi!.name = "改名";
    expect(store.editorDirty).toBe(true);
  });

  it("selectNode api：坏数据（schema 不符）→ problems 展示、editorApi 为 null、不抛", async () => {
    const { store } = await opened();
    await store.selectNode("api", API_PATH); // 种子内容缺 method/url → 校验失败
    expect(store.editorApi).toBeNull();
    expect(store.editorProblems.length).toBeGreaterThan(0);
    expect(store.editorRaw).toContain("api-online-1");
    expect(store.editorKind).toBe("api");
  });

  it("canEdit：工作区 VIEWER → 恒只读；EDITOR + 项目 VIEWER/NONE 覆盖 → 该项目只读（path 实体化：按 projects.id 前缀定位）", async () => {
    // path 实体化（2026-09-08）：内容 path 首段=项目实体 id（2026-09-09 BIGINT 化后为数字字符串），所属项目按 id 前缀匹配
    const pid = "101";
    const pidPath = `${pid}/collections/示例集合/apis/示例接口/api.yaml`;
    const { store } = await opened();
    expect(store.canEdit(pidPath)).toBe(true);
    // 项目级 ACL 覆盖：pidPath 首段命中示例项目 id，覆盖为 VIEWER/NONE → 只读
    store.projects = [{ id: pid, name: "示例项目", myRole: "VIEWER" }];
    expect(store.canEdit(pidPath)).toBe(false);
    store.projects = [{ id: pid, name: "示例项目", myRole: "NONE" }];
    expect(store.canEdit(pidPath)).toBe(false);
    // 前缀必须整段命中：另一项目（不同 id）→ 不误伤（相邻数字 id 亦不前缀串扰）
    store.projects = [{ id: "999", name: "示例项目", myRole: "NONE" }];
    expect(store.canEdit(pidPath)).toBe(true);
    // 同名项目按 id 定位（同名回归：按 name 匹配会张冠李戴）：
    // 两个同名「示例项目」，甲 VIEWER、乙 EDITOR——pidPath 属乙（id=pid）→ 可编辑
    store.projects = [
      { id: "102", name: "示例项目", myRole: "VIEWER" },
      { id: pid, name: "示例项目", myRole: "EDITOR" },
    ];
    expect(store.canEdit(pidPath)).toBe(true);
    expect(store.canEdit(`102/collections/c/apis/a/api.yaml`)).toBe(false);
    // 工作区配置叶（apicc.workspace.yaml）：不受项目 ACL 影响；对齐服务端 ADMIN+ 守卫
    // （计划 C 任务 4 / B-任务 7 遗留④）：仅 ADMIN/OWNER 可编辑，EDITOR 也只读
    store.projects = [{ id: pid, name: "示例项目", myRole: "VIEWER" }];
    expect(store.canEdit("apicc.workspace.yaml")).toBe(true); // 默认 OWNER
    store.activeWorkspace = { ...store.activeWorkspace!, myRole: "ADMIN" };
    expect(store.canEdit("apicc.workspace.yaml")).toBe(true);
    store.activeWorkspace = { ...store.activeWorkspace!, myRole: "EDITOR" };
    expect(store.canEdit("apicc.workspace.yaml")).toBe(false); // 收紧：EDITOR 推送服务端 403
    // 收紧只影响配置叶：EDITOR 工作区角色下项目内 api 叶仍按项目 ACL 放行
    store.projects = [{ id: pid, name: "示例项目", myRole: "EDITOR" }];
    expect(store.canEdit(pidPath)).toBe(true);
    // 工作区级 VIEWER：一切只读
    store.activeWorkspace = { ...store.activeWorkspace!, myRole: "VIEWER" };
    expect(store.canEdit(pidPath)).toBe(false);
    expect(store.canEdit("apicc.workspace.yaml")).toBe(false);
    expect(store.canEdit(null)).toBe(false);
  });

  it("saveApi：序列化回文本 putFile（baseVersion=当前 version）→ 版本前移、dirty 复位", async () => {
    const { api, store } = await opened();
    await api.onlineFilePut({ workspaceId: store.activeWorkspace!.id, path: API_PATH, content: VALID_API_YAML, baseVersion: 1 });
    await store.selectNode("api", API_PATH);
    const calls: Array<{ path: string; baseVersion: number }> = [];
    const originalPut = api.onlineFilePut.bind(api);
    api.onlineFilePut = async (input) => {
      calls.push({ path: input.path, baseVersion: input.baseVersion });
      return originalPut(input);
    };
    store.editorApi!.name = "在线改名";
    await store.saveApi();
    expect(store.conflict).toBeNull();
    expect(calls[0]).toEqual({ path: API_PATH, baseVersion: 2 });
    expect(store.editorVersion).toBe(3);
    expect(store.editorDirty).toBe(false);
    // 服务端读回：序列化内容包含新名（YAML 文本推送）
    const reread = await api.onlineFilesGet({ workspaceId: store.activeWorkspace!.id, paths: [API_PATH] });
    expect(reread.files[0]!.content).toContain("在线改名");
  });

  it("saveApi 409 → conflict 入 store；拉取覆盖我的 → 重取重渲染（丢弃本地编辑）；放弃 → 保留缓冲", async () => {
    const { api, store } = await opened();
    await api.onlineFilePut({ workspaceId: store.activeWorkspace!.id, path: API_PATH, content: VALID_API_YAML, baseVersion: 1 });
    await store.selectNode("api", API_PATH);
    store.editorApi!.name = "我的本地编辑";
    api.onlineFilePut = async () => ({
      outcome: "conflict",
      conflict: { code: "version_conflict", currentVersion: 9, currentHash: "h9" },
    });
    await store.saveApi();
    expect(store.conflict).toEqual({ code: "version_conflict", currentVersion: 9, currentHash: "h9" });
    expect(store.editorDirty).toBe(true); // 本地编辑还在，等用户抉择
    // 放弃：清冲突、缓冲保留
    store.conflictDiscard();
    expect(store.conflict).toBeNull();
    expect(store.editorApi?.name).toBe("我的本地编辑");
    // 拉取覆盖我的：重取服务端最新并重新渲染
    api.onlineFilePut = async () => {
      throw new Error("不应再推送");
    };
    store.conflict = { code: "version_conflict", currentVersion: 9, currentHash: "h9" };
    await store.conflictPullOverwrite();
    expect(store.conflict).toBeNull();
    expect(store.editorApi?.name).toBe("示例接口"); // 服务端内容
    expect(store.editorDirty).toBe(false);
    expect(store.editorVersion).toBe(2);
  });

  it("selectNode file（只读配置叶）：原文进 editorRaw，无编辑缓冲", async () => {
    const { store } = await opened();
    await store.selectNode("file", "apicc.workspace.yaml");
    expect(store.editorKind).toBe("file");
    expect(store.editorApi).toBeNull();
    expect(store.editorRaw).toContain("ws-online-1");
    expect(store.editorProblems).toEqual([]);
  });
});

describe("迁移-拉取（步骤 1③ + 计划 C 任务 2：实体路径还原本地名称形态 + 进度 + 计数 + 落盘）", () => {
  it("拉取：<projectId>/... 还原为 groups/<组名>/projects/<项目名>/... 落盘（根级文件原样）；再拉 → 全部 skipped", async () => {
    const { api, store } = await opened();
    const dir = mkdtempSync(join(tmpdir(), "apicc-pull-"));
    // 钉落盘路径形态：migrateWrite 收到的必须是本地名称树路径（服务端实体路径不出 IPC 写面）
    const writes: string[][] = [];
    const originalWrite = api.onlineMigrateWrite.bind(api);
    api.onlineMigrateWrite = async (input) => {
      writes.push(input.files.map((f) => f.path));
      return originalWrite(input);
    };
    try {
      await store.migratePull(dir);
      expect(store.error).toBeNull();
      const result = store.migrationResult!;
      expect(result.direction).toBe("pull");
      expect(result.pulled).toBe(6); // 种子文件数（根配置+项目内 5；分组已实体化，无 group.yaml）
      expect(result.skipped).toBe(0);
      expect(writes).toHaveLength(1); // 单批（≤200）
      expect(writes[0]!.sort()).toEqual([
        "apicc.workspace.yaml",
        "groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml",
        "groups/示例分组/projects/示例项目/collections/示例集合/collection.yaml",
        "groups/示例分组/projects/示例项目/environments/dev.yaml",
        "groups/示例分组/projects/示例项目/project.yaml",
        "groups/示例分组/projects/示例项目/workflows/示例流/workflow.yaml",
      ]);
      // 落盘内容按本地名称路径可读回
      expect(readFileSync(join(dir, "apicc.workspace.yaml"), "utf8")).toContain("ws-online-1");
      expect(
        readFileSync(join(dir, "groups", "示例分组", "projects", "示例项目", "collections", "示例集合", "apis", "示例接口", "api.yaml"), "utf8"),
      ).toContain("api-online-1");
      // 明细 path 统一本地名称形态
      expect(result.details.some((d) => d.path === API_PATH)).toBe(false);
      // 第二次拉取：同 hash 全部跳过
      await store.migratePull(dir);
      expect(store.migrationResult?.pulled).toBe(0);
      expect(store.migrationResult?.skipped).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("拉取：组名不可得（孤儿 projectId，groups 清单为空）→ 退化为实体路径原样落盘并在明细注记", async () => {
    const { api, store } = await opened();
    api.onlineGroupsList = async () => [];
    const dir = mkdtempSync(join(tmpdir(), "apicc-pull-orphan-"));
    try {
      await store.migratePull(dir);
      expect(store.error).toBeNull();
      const result = store.migrationResult!;
      expect(result.pulled).toBe(6); // 孤儿仍落盘（退化为实体路径），不算失败
      const projectRows = result.details.filter((d) => d.path !== "apicc.workspace.yaml");
      expect(projectRows.length).toBe(5);
      expect(projectRows.every((d) => d.path.startsWith(`${ONLINE_SEED_PROJECT_ID}/`))).toBe(true);
      expect(projectRows.every((d) => d.note !== undefined)).toBe(true); // details 标注退化
      expect(result.details.find((d) => d.path === "apicc.workspace.yaml")!.note).toBeUndefined(); // 根级文件非孤儿
      // 落盘退化为 <projectId>/... 原样
      expect(existsSync(join(dir, ...`${ONLINE_SEED_PROJECT_ID}/project.yaml`.split("/")))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("拉取：同组同名项目并存（两实体还原同一路径）→ 先行者正常 pulled，后行者 failed+冲突注记，落盘为先行者内容", async () => {
    // 计划 B：服务端允许同组同名项目并存（不同 projectId）——两实体还原出同一条本地路径。
    // 护栏（宽范围审查发现 1）：后行者不进取数/落盘清单（否则取数换算表后行覆盖先行、
    // 先行者内容取不回且落盘后写覆盖先写），计 failed + 冲突注记；先行者正常取数落盘。
    // 替身内存库是单实体模型，双实体树与逐实体取数在此桩出。
    const { api, store } = await opened();
    // BIGINT 化夹具：实体 id 为数字字符串（2026-09-09 服务端主键口径）
    const P1 = "111";
    const P2 = "222";
    api.onlineTreeGet = async () => ({
      workspaceId: store.activeWorkspace!.id,
      rootVersion: 2,
      files: [
        { path: `${P1}/project.yaml`, hash: "h1", version: 1, size: 18 },
        { path: `${P2}/project.yaml`, hash: "h2", version: 1, size: 18 },
      ],
      projects: [
        { id: P1, name: "同名项目", groupId: "g-1", myRole: "OWNER" },
        { id: P2, name: "同名项目", groupId: "g-1", myRole: "OWNER" },
      ],
    });
    api.onlineGroupsList = async () => [{ id: "g-1", name: "电商", isDefault: false, createdAt: "2026-09-09T00:00:00Z" }];
    // 钉取数寻址：两实体只取先行者（后行者不进取数清单，不发生后行覆盖先行的换算错位）
    const fetched: string[] = [];
    api.onlineFilesGet = async (input) => {
      fetched.push(...input.paths);
      return {
        files: input.paths.map((p) => ({
          path: p,
          content: p.startsWith(P1) ? "先行者内容\n" : "后行者内容\n",
          version: 1,
          hash: p.startsWith(P1) ? "h1" : "h2",
        })),
        missing: [],
      };
    };
    const writes: Array<Array<{ path: string; content: string }>> = [];
    const originalWrite = api.onlineMigrateWrite.bind(api);
    api.onlineMigrateWrite = async (input) => {
      writes.push(input.files.map((f) => ({ ...f })));
      return originalWrite(input);
    };
    const dir = mkdtempSync(join(tmpdir(), "apicc-pull-clash-"));
    try {
      await store.migratePull(dir);
      expect(store.error).toBeNull();
      const result = store.migrationResult!;
      expect(result.pulled).toBe(1); // 先行者
      expect(result.failed).toBe(1); // 后行者（同名冲突）
      expect(fetched).toEqual([`${P1}/project.yaml`]); // 只取先行者实体（先行者内容不被挤掉）
      // 落盘恰一行：本地名称路径 + 先行者内容（非后写覆盖）
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual([{ path: "groups/电商/projects/同名项目/project.yaml", content: "先行者内容\n" }]);
      expect(readFileSync(join(dir, "groups", "电商", "projects", "同名项目", "project.yaml"), "utf8")).toBe("先行者内容\n");
      // 明细：先行者 pulled、后行者 failed + 冲突注记（同一路径两行，路径统一本地名称形态）
      const pulledRow = result.details.find((d) => d.action === "pulled")!;
      expect(pulledRow.path).toBe("groups/电商/projects/同名项目/project.yaml");
      const failedRow = result.details.find((d) => d.action === "failed")!;
      expect(failedRow.path).toBe("groups/电商/projects/同名项目/project.yaml");
      expect(failedRow.note).toContain("同名项目冲突");
      expect(failedRow.note).toContain("groups/电商/projects/同名项目/project.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("迁移单活动护栏：进行中二次启动被拒（scan 只调一次）", async () => {
    const { api, store } = await opened();
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.onlineMigrateScan = async (dir: string) => {
      scans += 1;
      await gate;
      return { files: [{ path: "a.yaml", hash: "h", content: "a", projectDir: null }] };
    };
    const first = store.migratePull(join(tmpdir(), "apicc-pull-guard"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.migrating).toBe(true);
    const second = store.migratePull(join(tmpdir(), "apicc-pull-guard"));
    await second; // 立即返回（不启动）
    expect(scans).toBe(1);
    release();
    await first;
    expect(store.migrating).toBe(false);
    expect(store.error).toBeNull();
  });

  it("拉取失败（目录不存在）→ error 通道、migrating 复位、无结果", async () => {
    const { store } = await opened();
    await store.migratePull(join(tmpdir(), "apicc-not-exists-拉取"));
    expect(store.error).toBeTruthy();
    expect(store.migrating).toBe(false);
    expect(store.migrationResult).toBeNull();
  });
});

describe("迁移-推送（步骤 1④ + 计划 C 任务 2：映射桥换算 <projectId>/... + 差异 batch + 冲突默认跳过列出）", () => {
  it("推送：本地名称路径经映射桥换算 <projectId>/<项目内相对路径> 推 batch；明细 path 保持本地名称形态", async () => {
    const { api, store } = await opened();
    const wsYaml = "apicc.workspace.yaml";
    const LOCAL_API = "groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml";
    // 服务端现内容：API_PATH 保持原样（同 hash → 跳过）；wsYaml 本地改内容（→ 带服务端版本推送）
    const serverFiles = await api.onlineFilesGet({ workspaceId: store.activeWorkspace!.id, paths: [wsYaml, API_PATH] });
    const same = serverFiles.files.find((f) => f.path === API_PATH)!;
    api.onlineMigrateScan = async () => ({
      files: [
        { path: wsYaml, hash: "different", content: "changed-local\n", projectDir: null },
        { path: LOCAL_API, hash: same.hash, content: same.content, projectDir: { group: "示例分组", project: "示例项目" } },
        { path: "groups/示例分组/projects/示例项目/新接口/api.yaml", hash: "new", content: "brand: new\n", projectDir: { group: "示例分组", project: "示例项目" } },
      ],
    });
    // 钉映射桥载荷：去重目录清单 + createIfMissing=true（根级文件不参与映射）
    const mappingCalls: Array<{ group: string; project: string; createIfMissing: boolean }> = [];
    const originalMapping = api.onlineProjectMapping.bind(api);
    api.onlineProjectMapping = async (input) => {
      for (const entry of input.entries) mappingCalls.push({ ...entry });
      return originalMapping(input);
    };
    // 钉 batch 载荷：必须已换算 <projectId>/...（直发名称路径服务端 400 path_invalid）
    const batchCalls: Array<Array<{ path: string; baseVersion: number }>> = [];
    const originalBatch = api.onlineFilesBatch.bind(api);
    api.onlineFilesBatch = async (input) => {
      batchCalls.push(input.files.map((f) => ({ path: f.path, baseVersion: f.baseVersion })));
      return originalBatch(input);
    };
    await store.migratePush(join(tmpdir(), "apicc-push-noop"));
    const result = store.migrationResult!;
    expect(result.direction).toBe("push");
    expect(result.pushed).toBe(2); // 根级变更文件 + 项目内新文件
    expect(result.skipped).toBe(1); // 同 hash（内容未变）
    expect(result.conflicts).toBe(0);
    expect(mappingCalls).toEqual([{ group: "示例分组", project: "示例项目", createIfMissing: true }]);
    const flat = batchCalls.flat();
    expect(flat.find((e) => e.path === `${ONLINE_SEED_PROJECT_ID}/新接口/api.yaml`)!.baseVersion).toBe(0); // 新文件 baseVersion=0
    expect(flat.some((e) => e.path.includes("groups/"))).toBe(false); // 绝不直发名称路径
    // 明细 path 统一本地名称形态（用户可读；服务端实体路径不出 UI）
    const actions = Object.fromEntries(result.details.map((d) => [d.path, d.action]));
    expect(actions[wsYaml]).toBe("pushed");
    expect(actions[LOCAL_API]).toBe("skipped");
    expect(actions["groups/示例分组/projects/示例项目/新接口/api.yaml"]).toBe("pushed");
    expect(result.details.some((d) => d.path === API_PATH)).toBe(false);
    // 推送后树已刷新（缓存失效重取，root label 仍为工作区名）
    expect(store.onlineTree?.label).toBe(store.activeWorkspace!.name);
  });

  it("推送：本地目录名带首尾空格（服务端 trim 回显）→ 按条目位置关联换算成功，不误报 failed", async () => {
    // 审查重要 1：服务端对名称 trim() 后回显并建实体——旧实现按回显名回查，本地目录名带
    // 首尾空格时回查恒 miss → 映射实际成功却整项目误计 failed 且重试复现。修后按条目位置
    // 关联（mappings[i] ↔ entries[i]，服务端顺序保证），映射表 key 用本地目录原名。
    const { api, store } = await opened();
    const localApi = "groups/ 示例分组 /projects/ 示例项目 /空格目录/api.yaml";
    api.onlineMigrateScan = async () => ({
      files: [{ path: localApi, hash: "h1", content: "a\n", projectDir: { group: " 示例分组 ", project: " 示例项目 " } }],
    });
    const batchCalls: string[][] = [];
    const originalBatch = api.onlineFilesBatch.bind(api);
    api.onlineFilesBatch = async (input) => {
      batchCalls.push(input.files.map((f) => f.path));
      return originalBatch(input);
    };
    await store.migratePush(join(tmpdir(), "apicc-push-trim"));
    const result = store.migrationResult!;
    expect(result.failed).toBe(0); // 不再误报 failed（映射实际成功）
    expect(result.pushed).toBe(1);
    expect(batchCalls.flat()).toEqual([`${ONLINE_SEED_PROJECT_ID}/空格目录/api.yaml`]); // 已换算实体路径
    expect(result.details).toEqual([{ path: localApi, action: "pushed" }]); // 明细保持本地原名路径
    expect(store.error).toBeNull();
  });

  it("推送：映射 missing 行（替身只解析种子目录）→ 该项目全部文件计 failed（本地路径明细，不进 batch）", async () => {
    const { api, store } = await opened();
    api.onlineMigrateScan = async () => ({
      files: [
        { path: "groups/新分组/新项目/api.yaml", hash: "h1", content: "a\n", projectDir: { group: "新分组", project: "新项目" } },
        { path: "groups/新分组/新项目/other.yaml", hash: "h2", content: "b\n", projectDir: { group: "新分组", project: "新项目" } },
        { path: "apicc.workspace.yaml", hash: "h3", content: "ws\n", projectDir: null },
      ],
    });
    const batches: string[][] = [];
    const originalBatch = api.onlineFilesBatch.bind(api);
    api.onlineFilesBatch = async (input) => {
      batches.push(input.files.map((f) => f.path));
      return originalBatch(input);
    };
    await store.migratePush(join(tmpdir(), "apicc-push-missing"));
    const result = store.migrationResult!;
    expect(result.failed).toBe(2);
    expect(result.pushed).toBe(1); // 根级 wsYaml（tree 同名文件 hash 不同 → 变更推送）
    expect(result.details.filter((d) => d.action === "failed").map((d) => d.path).sort()).toEqual([
      "groups/新分组/新项目/api.yaml",
      "groups/新分组/新项目/other.yaml",
    ]);
    // 缺失项目无处可推：不进任何 batch
    expect(batches.flat().every((p) => !p.includes("新项目"))).toBe(true);
    expect(store.error).toBeNull();
  });

  it("推送：映射 forbidden 行（无权建）→ 该项目文件计 failed，不吞不静默跳过", async () => {
    const { api, store } = await opened();
    api.onlineMigrateScan = async () => ({
      files: [{ path: "groups/别组/别项目/api.yaml", hash: "h1", content: "a\n", projectDir: { group: "别组", project: "别项目" } }],
    });
    api.onlineProjectMapping = async (input) => ({
      mappings: input.entries.map((e) => ({ group: e.group, project: e.project, forbidden: true })),
    });
    await store.migratePush(join(tmpdir(), "apicc-push-forbidden"));
    const result = store.migrationResult!;
    expect(result.failed).toBe(1);
    expect(result.details).toEqual([{ path: "groups/别组/别项目/api.yaml", action: "failed" }]);
    expect(store.error).toBeNull();
  });

  it("推送冲突：conflict 计数与明细列出（默认跳过，不重试不覆盖；明细还原本地名称路径）", async () => {
    const { api, store } = await opened();
    const LOCAL_CONFLICT = "groups/示例分组/projects/示例项目/conflict.yaml";
    api.onlineMigrateScan = async () => ({
      files: [{ path: LOCAL_CONFLICT, hash: "h1", content: "mine\n", projectDir: { group: "示例分组", project: "示例项目" } }],
    });
    api.onlineFilesBatch = async (input): Promise<OnlineBatchResult> => ({
      results: input.files.map((f) => ({ path: f.path, status: "conflict" as const, currentVersion: 4 })),
    });
    await store.migratePush(join(tmpdir(), "apicc-push-conflict"));
    const result = store.migrationResult!;
    expect(result.conflicts).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.details).toEqual([{ path: LOCAL_CONFLICT, action: "conflict" }]);
    expect(store.error).toBeNull();
  });

  it("推送失败（scan 抛错）→ error 通道、migrating 复位", async () => {
    const { api, store } = await opened();
    api.onlineMigrateScan = async () => {
      throw new Error("目录不可读");
    };
    await store.migratePush(join(tmpdir(), "apicc-push-fail"));
    expect(store.error).toBe("目录不可读");
    expect(store.migrating).toBe(false);
    expect(store.migrationResult).toBeNull();
  });
});
