// @vitest-environment jsdom
// M3-B 任务 3：onlineStore 工作区浏览/编辑/冲突/迁移动作测试（渲染侧装配核心）。
// 覆盖 plan 任务 3 步骤 1：①打开在线工作区（树/项目角色入 store）②编辑保存（baseVersion
// 推送 + 成功前移）与 409 冲突（拉取覆盖我的/放弃）③迁移拉取（计数 + 落盘）④迁移推送
// （batch 差异 + 冲突跳过列出）⑤⑥关闭清理与迁移单活动护栏。坏数据进 problems 不崩。
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import type { OnlineBatchResult } from "../../../src/shared/online/contract.js";

const SERVER = "http://127.0.0.1:8080";
const API_PATH = "groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml";
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

  it("canEdit：工作区 VIEWER → 恒只读；EDITOR + 项目 VIEWER/NONE 覆盖 → 该项目只读（契约修订：按 projects.path 前缀定位）", async () => {
    const { store } = await opened();
    expect(store.canEdit(API_PATH)).toBe(true);
    // 项目级 ACL 覆盖：示例项目 path 命中 API_PATH 前缀，覆盖为 VIEWER/NONE → 只读
    store.projects = [{ id: "p-online-1", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "VIEWER" }];
    expect(store.canEdit(API_PATH)).toBe(false);
    store.projects = [{ id: "p-online-1", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "NONE" }];
    expect(store.canEdit(API_PATH)).toBe(false);
    // 路径前缀必须整段匹配：另一项目 path 是本 path 的字符串前缀但非目录前缀 → 不误伤
    store.projects = [{ id: "p-other", name: "示例项目", path: "groups/示例分组/projects/示例项目其他", myRole: "NONE" }];
    expect(store.canEdit(API_PATH)).toBe(true);
    // 同名项目按 path 定位（重要 2 回归：按 name 匹配会张冠李戴）：
    // 两个同名「示例项目」，path 甲 VIEWER、path 乙 EDITOR——API_PATH 属乙 → 可编辑
    store.projects = [
      { id: "p-a", name: "示例项目", path: "groups/甲/projects/示例项目", myRole: "VIEWER" },
      { id: "p-b", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "EDITOR" },
    ];
    expect(store.canEdit(API_PATH)).toBe(true);
    expect(store.canEdit("groups/甲/projects/示例项目/collections/c/apis/a/api.yaml")).toBe(false);
    // 非项目子树（根配置）：不受项目 ACL 影响，按工作区角色可写
    store.projects = [{ id: "p-a", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "VIEWER" }];
    expect(store.canEdit("apicc.workspace.yaml")).toBe(true);
    // 工作区级 VIEWER：一切只读
    store.activeWorkspace = { ...store.activeWorkspace!, myRole: "VIEWER" };
    expect(store.canEdit(API_PATH)).toBe(false);
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

describe("迁移-拉取（步骤 1③：进度 + 计数 + 落盘）", () => {
  it("拉取到本地目录：全部新拉 → 计数与文件落盘；再拉 → 全部 skipped", async () => {
    const { store } = await opened();
    const dir = mkdtempSync(join(tmpdir(), "apicc-pull-"));
    try {
      await store.migratePull(dir);
      expect(store.error).toBeNull();
      expect(store.migrationResult?.direction).toBe("pull");
      expect(store.migrationResult?.pulled).toBe(7); // 种子文件数（含只读配置叶）
      expect(store.migrationResult?.skipped).toBe(0);
      expect(readFileSync(join(dir, "apicc.workspace.yaml"), "utf8")).toContain("ws-online-1");
      expect(readFileSync(join(dir, API_PATH), "utf8")).toContain("api-online-1");
      // 第二次拉取：同 hash 全部跳过
      await store.migratePull(dir);
      expect(store.migrationResult?.pulled).toBe(0);
      expect(store.migrationResult?.skipped).toBe(7);
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
      return { files: [{ path: "a.yaml", hash: "h", content: "a" }] };
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

describe("迁移-推送（步骤 1④：差异 batch + 冲突默认跳过列出）", () => {
  it("推送：新/变更/同 hash 跳过 → 计数与明细；推送后刷新树", async () => {
    const { api, store } = await opened();
    const wsYaml = "apicc.workspace.yaml";
    // 服务端现内容：API_PATH 保持原样（同 hash → 跳过）；wsYaml 本地改内容（→ 带服务端版本推送）
    const serverFiles = await api.onlineFilesGet({ workspaceId: store.activeWorkspace!.id, paths: [wsYaml, API_PATH] });
    const same = serverFiles.files.find((f) => f.path === API_PATH)!;
    api.onlineMigrateScan = async () => ({
      files: [
        { path: wsYaml, hash: "different", content: "changed-local\n" },
        { path: API_PATH, hash: same.hash, content: same.content },
        { path: "groups/新分组/新接口/api.yaml", hash: "new", content: "brand: new\n" },
      ],
    });
    const batchCalls: Array<Array<{ path: string; baseVersion: number }>> = [];
    const originalBatch = api.onlineFilesBatch.bind(api);
    api.onlineFilesBatch = async (input) => {
      batchCalls.push(input.files.map((f) => ({ path: f.path, baseVersion: f.baseVersion })));
      return originalBatch(input);
    };
    await store.migratePush(join(tmpdir(), "apicc-push-noop"));
    const result = store.migrationResult!;
    expect(result.direction).toBe("push");
    expect(result.pushed).toBe(2); // 新文件 + 变更文件
    expect(result.skipped).toBe(1); // 同 hash
    expect(result.conflicts).toBe(0);
    const actions = Object.fromEntries(result.details.map((d) => [d.path, d.action]));
    expect(actions[wsYaml]).toBe("pushed");
    expect(actions[API_PATH]).toBe("skipped");
    expect(actions["groups/新分组/新接口/api.yaml"]).toBe("pushed");
    // 新文件 baseVersion=0；变更文件带服务端当前版本（D8 从不盲目覆盖）
    const flat = batchCalls.flat();
    expect(flat.find((e) => e.path === "groups/新分组/新接口/api.yaml")!.baseVersion).toBe(0);
    // 推送后树已刷新（缓存失效重取，root label 仍为工作区名）
    expect(store.onlineTree?.label).toBe(store.activeWorkspace!.name);
  });

  it("推送冲突：conflict 计数与明细列出（默认跳过，不重试不覆盖）", async () => {
    const { api, store } = await opened();
    api.onlineMigrateScan = async () => ({
      files: [{ path: "groups/g/conflict.yaml", hash: "h1", content: "mine\n" }],
    });
    api.onlineFilesBatch = async (input): Promise<OnlineBatchResult> => ({
      results: input.files.map((f) => ({ path: f.path, status: "conflict" as const, currentVersion: 4 })),
    });
    await store.migratePush(join(tmpdir(), "apicc-push-conflict"));
    const result = store.migrationResult!;
    expect(result.conflicts).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.details).toEqual([{ path: "groups/g/conflict.yaml", action: "conflict" }]);
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
