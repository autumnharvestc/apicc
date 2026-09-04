// M3-B 任务 1：memory 替身 online:* 方法测试——与主进程 online 会话同构的契约钉住
// （登录态串联/树与文件版本内存模型/put 版本递增/登录前可读错误），不发真实网络。
import { describe, expect, it } from "vitest";
import { OnlineTreeSchema, type OnlineUser } from "../../../src/shared/online/contract.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";

const USER: OnlineUser = { id: "u-online-1", username: "alice", displayName: "示例用户" };
const LOGIN_INPUT = { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" };

describe("memory 替身 online:*", () => {
  it("login 返回 { expiresAt, user }（不含 token）；未登录时内容频道抛「尚未登录」", async () => {
    const api = createMemoryApi();
    await expect(api.onlineMe()).rejects.toThrow(/尚未登录/);
    const result = await api.onlineLogin(LOGIN_INPUT);
    expect(result.user).toEqual(USER);
    expect(result).not.toHaveProperty("token");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await api.onlineMe()).toEqual(USER);
  });

  it("logout 清登录态；register 不建立登录态", async () => {
    const api = createMemoryApi();
    await api.onlineRegister({ baseUrl: "http://127.0.0.1:8080", username: "bob", password: "password8", displayName: "Bob" });
    await expect(api.onlineMe()).rejects.toThrow(/尚未登录/);
    await api.onlineLogin(LOGIN_INPUT);
    await api.onlineLogout();
    await expect(api.onlineMe()).rejects.toThrow(/尚未登录/);
  });

  it("工作区列表/创建：创建者 OWNER 入列", async () => {
    const api = createMemoryApi();
    await api.onlineLogin(LOGIN_INPUT);
    const list = await api.onlineWorkspaceList();
    expect(list.length).toBeGreaterThan(0);
    const created = await api.onlineWorkspaceCreate({ name: "新空间" });
    expect(created.myRole).toBe("OWNER");
    const after = await api.onlineWorkspaceList();
    expect(after.find((w) => w.id === created.id)).toMatchObject({ name: "新空间", myRole: "OWNER" });
  });

  it("树与文件：getTree 过契约 schema；getFiles 命中/missing；put 版本递增且 getFiles 读回新版本", async () => {
    const api = createMemoryApi();
    await api.onlineLogin(LOGIN_INPUT);
    const ws = (await api.onlineWorkspaceList())[0]!;
    const tree = await api.onlineTreeGet(ws.id);
    // 替身载荷钉在契约 schema 上（契约漂移即红）
    expect(OnlineTreeSchema.parse(tree)).toEqual(tree);
    expect(tree.files.length).toBeGreaterThan(0);
    const target = tree.files[0]!;
    const fetched = await api.onlineFilesGet({ workspaceId: ws.id, paths: [target.path, "groups/不存在.yaml"] });
    expect(fetched.files).toHaveLength(1);
    expect(fetched.files[0]!.path).toBe(target.path);
    expect(fetched.missing).toEqual(["groups/不存在.yaml"]);
    const put = await api.onlineFilePut({ workspaceId: ws.id, path: target.path, content: "id: updated\n", baseVersion: target.version });
    expect(put.outcome).toBe("pushed");
    if (put.outcome === "pushed") {
      expect(put.result.version).toBe(target.version + 1);
      expect(put.result.path).toBe(target.path);
    }
    const reread = await api.onlineFilesGet({ workspaceId: ws.id, paths: [target.path] });
    expect(reread.files[0]!.version).toBe(target.version + 1);
    expect(reread.files[0]!.content).toBe("id: updated\n");
  });

  it("batch 逐文件 pushed 并递增版本；delete 返回 { outcome: deleted } 后文件进 missing", async () => {
    const api = createMemoryApi();
    await api.onlineLogin(LOGIN_INPUT);
    const ws = (await api.onlineWorkspaceList())[0]!;
    const batch = await api.onlineFilesBatch({
      workspaceId: ws.id,
      files: [
        { path: "groups/推送/a.yaml", content: "a", baseVersion: 0 },
        { path: "groups/推送/b.yaml", content: "b", baseVersion: 0 },
      ],
    });
    expect(batch.results.map((r) => r.status)).toEqual(["pushed", "pushed"]);
    expect(batch.results[0]!.version).toBe(1);
    const del = await api.onlineFileDelete({ workspaceId: ws.id, path: "groups/推送/a.yaml", baseVersion: 1 });
    expect(del).toEqual({ outcome: "deleted" });
    const fetched = await api.onlineFilesGet({ workspaceId: ws.id, paths: ["groups/推送/a.yaml"] });
    expect(fetched.missing).toEqual(["groups/推送/a.yaml"]);
  });

  // —— 任务 2 裁定 D：batch 对「文件不存在但 baseVersion>0」对齐服务端乐观并发语义 ——
  it("batch：文件不存在但 baseVersion>0 → conflict（currentVersion=0，不存在 = 版本 0 不匹配）", async () => {
    const api = createMemoryApi();
    await api.onlineLogin(LOGIN_INPUT);
    const ws = (await api.onlineWorkspaceList())[0]!;
    const result = await api.onlineFilesBatch({
      workspaceId: ws.id,
      files: [
        { path: "groups/推送/新建.yaml", content: "x", baseVersion: 3 },
        { path: "groups/推送/新文件.yaml", content: "x", baseVersion: 0 },
      ],
    });
    expect(result.results[0]).toEqual({ path: "groups/推送/新建.yaml", status: "conflict", currentVersion: 0 });
    expect(result.results[1]).toMatchObject({ status: "pushed" });
    // 冲突文件未被写入
    const fetched = await api.onlineFilesGet({ workspaceId: ws.id, paths: ["groups/推送/新建.yaml"] });
    expect(fetched.missing).toEqual(["groups/推送/新建.yaml"]);
  });

  // —— 任务 2 裁定 A：onlineResume 替身（实例内登录态语义） ——
  it("onlineResume：已登录（此前 login）→ restored 携用户；未登录 → signed-out（不抛）", async () => {
    const api = createMemoryApi();
    await expect(api.onlineResume({ baseUrl: "http://127.0.0.1:8080" })).resolves.toEqual({ outcome: "signed-out" });
    const login = await api.onlineLogin(LOGIN_INPUT);
    await expect(api.onlineResume({ baseUrl: "http://127.0.0.1:8080" })).resolves.toEqual({ outcome: "restored", user: login.user });
  });
});
