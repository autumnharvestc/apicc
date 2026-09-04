// M3-B 任务 3：memory 替身 online 工作区/迁移方法——与主进程同构（树视图经同一
// onlineTreeToDto 映射、open/close 状态、scan/write 真实文件面），载荷钉在契约上。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import type { OnlineWorkspaceView } from "../../../src/shared/online/types.js";

const LOGIN_INPUT = { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" };

async function loggedIn() {
  const api = createMemoryApi();
  await api.onlineLogin(LOGIN_INPUT);
  const ws = (await api.onlineWorkspaceList())[0]!;
  return { api, ws };
}

describe("memory 替身 onlineWorkspaceOpen/Close/TreeView（任务 3）", () => {
  it("open 记录工作区并返回视图：树 DTO（root label = 工作区名，M1 §6 层级 + 只读 file 叶）+ projects", async () => {
    const { api, ws } = await loggedIn();
    const view = (await api.onlineWorkspaceOpen({ workspaceId: ws.id, name: ws.name, myRole: ws.myRole })) as OnlineWorkspaceView;
    expect(view.workspaceId).toBe(ws.id);
    expect(view.name).toBe(ws.name);
    expect(view.projects).toEqual([{ id: "p-online-1", name: "示例项目", path: "groups/示例分组/projects/示例项目", myRole: "EDITOR" }]);
    const root = view.tree;
    expect(root.kind).toBe("root");
    expect(root.label).toBe(ws.name);
    const labels = (root.children ?? []).map((c) => `${c.kind}:${c.label}`);
    expect(labels).toContain("file:apicc.workspace.yaml");
    expect(labels).toContain("group:示例分组");
    const group = root.children!.find((c) => c.label === "示例分组")!;
    const project = group.children!.find((c) => c.kind === "project")!;
    expect(project.label).toBe("示例项目");
    const collection = project.children!.find((c) => c.kind === "collection")!;
    const apiNode = collection.children!.find((c) => c.kind === "api")!;
    expect(apiNode.label).toBe("示例接口");
    expect(apiNode.id).toBe("groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml");
    // 只读叶：项目配置 / 环境 / 工作流
    const projectFiles = project.children!.filter((c) => c.kind === "file").map((c) => c.label);
    expect(projectFiles).toContain("project.yaml");
    expect(projectFiles).toContain("dev.yaml");
    expect(projectFiles).toContain("示例流");
  });

  it("close 后 tree:view 拒绝「尚未打开在线工作区」；未登录 open 拒绝「尚未登录」且不残留状态", async () => {
    const { api, ws } = await loggedIn();
    await api.onlineWorkspaceOpen({ workspaceId: ws.id, name: ws.name, myRole: "EDITOR" });
    await api.onlineWorkspaceClose();
    await expect(api.onlineTreeView(ws.id)).rejects.toThrow(/尚未打开在线工作区/);
    // 未登录（与 main IPC 面同构：open 即取视图 → 需要登录态）：拒绝且不残留半开状态
    const fresh = createMemoryApi();
    await expect(fresh.onlineWorkspaceOpen({ workspaceId: "ws-x", name: "x", myRole: "EDITOR" })).rejects.toThrow(/尚未登录/);
    await expect(fresh.onlineTreeView("ws-x")).rejects.toThrow(/尚未打开在线工作区/);
    await expect(fresh.onlineTreeView("ws-other")).rejects.toThrow(/尚未打开在线工作区/);
  });

  it("tree:view 反映最新内容（put 后版本前移），出口仍过契约形状", async () => {
    const { api, ws } = await loggedIn();
    await api.onlineWorkspaceOpen({ workspaceId: ws.id, name: ws.name, myRole: "EDITOR" });
    const target = "groups/示例分组/projects/示例项目/collections/示例集合/apis/示例接口/api.yaml";
    await api.onlineFilePut({ workspaceId: ws.id, path: target, content: "id: api-online-1\nname: 改名\n", baseVersion: 1 });
    const view = await api.onlineTreeView(ws.id);
    const apiNode = view.tree
      .children!.find((c) => c.kind === "group")! // 示例分组（file:group.yaml 也在 root 下排序）
      .children!.find((c) => c.kind === "project")!
      .children!.find((c) => c.kind === "collection")!
      .children!.find((c) => c.kind === "api")!;
    expect(apiNode.id).toBe(target);
    const fetched = await api.onlineFilesGet({ workspaceId: ws.id, paths: [target] });
    expect(fetched.files[0]!.version).toBe(2);
    expect(fetched.files[0]!.content).toContain("改名");
  });
});

describe("memory 替身 onlineMigrateScan/Write（任务 3，真实文件面）", () => {
  it("scan 递归扫描（跳过 .apicc/.git）；write 落盘并返回 written", async () => {
    const { api } = await loggedIn();
    const dir = mkdtempSync(join(tmpdir(), "apicc-mem-scan-"));
    try {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "a.yaml"), "a: 1\n", "utf8");
      writeFileSync(join(dir, "sub", "b.yaml"), "b: 2\n", "utf8");
      const scan = await api.onlineMigrateScan(dir);
      expect(scan.files.map((f) => f.path).sort()).toEqual(["a.yaml", "sub/b.yaml"]);
      const write = await api.onlineMigrateWrite({ dir, files: [{ path: "x/y.yaml", content: "x: 1\n" }] });
      expect(write.written).toEqual(["x/y.yaml"]);
      expect(readFileSync(join(dir, "x", "y.yaml"), "utf8")).toBe("x: 1\n");
      await expect(api.onlineMigrateWrite({ dir, files: [{ path: "../out.yaml", content: "x" }] })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
