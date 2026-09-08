// M3-B 任务 1：契约 schema 测试——fixture 逐字取自规格 §3 API 契约表格（不臆造字段），
// 验证 parse 往返（parse(fixture) 深等于 fixture）与非法形状拒绝。
import { describe, expect, it } from "vitest";
import {
  OnlineAclEntrySchema,
  OnlineBatchEntrySchema,
  OnlineBatchResultSchema,
  OnlineErrorSchema,
  OnlineFilesResultSchema,
  OnlineLoginResultSchema,
  OnlinePathSchema,
  OnlinePutFileResultSchema,
  OnlineRegisterInputSchema,
  OnlineTreeSchema,
  OnlineUserSchema,
  OnlineVersionConflictSchema,
  OnlineWorkspaceCreatedSchema,
  OnlineWorkspaceDetailSchema,
  OnlineWorkspaceSummarySchema,
} from "../../../src/shared/online/contract.js";

// —— §3.1 认证 ——
const USER = { id: "u-1", username: "alice", displayName: "Alice" };

describe("在线契约 schema（规格 §3 fixture 往返）", () => {
  it("register：入参（username 3-32 [a-zA-Z0-9_-] / password ≥8）与 201 成功载荷", () => {
    const input = { username: "alice", password: "password8", displayName: "Alice" };
    expect(OnlineRegisterInputSchema.parse(input)).toEqual(input);
    expect(OnlineUserSchema.parse({ id: "u-1", username: "alice", displayName: "Alice" })).toEqual(USER);
  });

  it("register 入参拒绝：用户名过短/非法字符、密码过短", () => {
    expect(OnlineRegisterInputSchema.safeParse({ username: "ab", password: "password8", displayName: "x" }).success).toBe(false);
    expect(OnlineRegisterInputSchema.safeParse({ username: "a.b", password: "password8", displayName: "x" }).success).toBe(false);
    expect(OnlineRegisterInputSchema.safeParse({ username: "alice", password: "short", displayName: "x" }).success).toBe(false);
  });

  it("login：200 载荷 { token, expiresAt, user }", () => {
    const fixture = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };
    expect(OnlineLoginResultSchema.parse(fixture)).toEqual(fixture);
  });

  it("login 载荷拒绝：缺 expiresAt", () => {
    expect(OnlineLoginResultSchema.safeParse({ token: "t", user: USER }).success).toBe(false);
  });

  it("me / register 成功载荷同为 user 形状", () => {
    expect(OnlineUserSchema.parse(USER)).toEqual(USER);
  });

  it("统一错误形状 { code, message }；缺 message 拒绝", () => {
    const fixture = { code: "username_taken", message: "用户名已被占用" };
    expect(OnlineErrorSchema.parse(fixture)).toEqual(fixture);
    expect(OnlineErrorSchema.safeParse({ code: "username_taken" }).success).toBe(false);
  });

  // —— §3.2 工作区与成员 ——
  it("工作区列表行 { id, name, myRole, createdAt } 与创建返回 { id, name, myRole: OWNER }", () => {
    const row = { id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" };
    expect(OnlineWorkspaceSummarySchema.parse(row)).toEqual(row);
    const created = { id: "ws-1", name: "团队空间", myRole: "OWNER" };
    expect(OnlineWorkspaceCreatedSchema.parse(created)).toEqual(created);
    const detail = { id: "ws-1", name: "团队空间", myRole: "ADMIN", memberCount: 5 };
    expect(OnlineWorkspaceDetailSchema.parse(detail)).toEqual(detail);
  });

  it("工作区详情拒绝：myRole 越界值", () => {
    expect(OnlineWorkspaceDetailSchema.safeParse({ id: "ws-1", name: "x", myRole: "GUEST", memberCount: 1 }).success).toBe(false);
  });

  // —— §3.3 项目 ACL（role ∈ NONE/VIEWER/EDITOR/ADMIN）——
  it("ACL 行 { userId, role }，role 含 NONE（NONE=拒之门外）", () => {
    expect(OnlineAclEntrySchema.parse({ userId: "u-2", role: "VIEWER" })).toEqual({ userId: "u-2", role: "VIEWER" });
    expect(OnlineAclEntrySchema.parse({ userId: "u-3", role: "NONE" })).toEqual({ userId: "u-3", role: "NONE" });
    expect(OnlineAclEntrySchema.safeParse({ userId: "u-2", role: "OWNER" }).success).toBe(false);
  });

  // —— §3.4 内容 ——
  it("tree：{ workspaceId, rootVersion, files[path/hash/version/size], projects[id/name/myRole] }（path 实体化修订 2026-09-08：projects.path 退役为可选，按 id 前缀定位项目）", () => {
    const fixture = {
      workspaceId: "ws-1",
      rootVersion: 42,
      files: [{ path: "p-1/collections/接口/apis/登录/apicc.api.yaml", hash: "3f2a9c8b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a", version: 7, size: 512 }],
      projects: [{ id: "p-1", name: "订单", myRole: "EDITOR" }],
    };
    expect(OnlineTreeSchema.parse(fixture)).toEqual(fixture);
    // 兼容：旧服务端/替身仍回 path 字段也可解析
    expect(OnlineTreeSchema.parse({ ...fixture, projects: [{ id: "p-1", name: "订单", path: "groups/后端/projects/订单", myRole: "EDITOR" }] }).projects[0]!.path)
      .toBe("groups/后端/projects/订单");
  });

  it("tree 拒绝：file 缺 version / version 为字符串；project 缺 id（path 可选——实体化后按 id 前缀定位）", () => {
    const base = { workspaceId: "ws-1", rootVersion: 1, projects: [] };
    expect(OnlineTreeSchema.safeParse({ ...base, files: [{ path: "a.yaml", hash: "h", size: 1 }] }).success).toBe(false);
    expect(OnlineTreeSchema.safeParse({ ...base, files: [{ path: "a.yaml", hash: "h", version: "7", size: 1 }] }).success).toBe(false);
    expect(
      OnlineTreeSchema.safeParse({ ...base, files: [], projects: [{ name: "订单", myRole: "EDITOR" }] }).success,
    ).toBe(false);
  });

  it("files：{ files[path/content/version/hash], missing[] }", () => {
    const fixture = {
      files: [{ path: "apicc.workspace.yaml", content: "id: ws-1\nname: 团队空间\n", version: 3, hash: "aaaa00112233445566778899aabbccddeeff00112233445566778899aabbccdd" }],
      missing: ["groups/已删/apicc.api.yaml"],
    };
    expect(OnlineFilesResultSchema.parse(fixture)).toEqual(fixture);
  });

  it("PUT 201 { path, version, hash }；409 冲突 { code: version_conflict, currentVersion, currentHash }", () => {
    const put = { path: "apicc.workspace.yaml", version: 8, hash: "bbbb00112233445566778899aabbccddeeff00112233445566778899aabbccdd" };
    expect(OnlinePutFileResultSchema.parse(put)).toEqual(put);
    const conflict = { code: "version_conflict", currentVersion: 9, currentHash: "cccc00112233445566778899aabbccddeeff00112233445566778899aabbccdd" };
    expect(OnlineVersionConflictSchema.parse(conflict)).toEqual(conflict);
    expect(OnlineVersionConflictSchema.safeParse({ code: "other", currentVersion: 1, currentHash: "h" }).success).toBe(false);
  });

  // M3-C 前置对齐①：fixture 逐字取自服务端真实行为——新文件带过期 baseVersion（并发删除场景）
  // → ContentService 抛 VersionConflictException(0, null)，GlobalExceptionHandler 序列化为
  // { code, message, currentVersion: 0, currentHash: null }（currentHash 为 JSON null）。
  it("409 冲突 currentHash 可为 null（服务端新文件并发删除场景，M3-C 前置对齐①）", () => {
    const conflict = { code: "version_conflict", message: "baseVersion 与服务端现状不一致", currentVersion: 0, currentHash: null };
    expect(OnlineVersionConflictSchema.parse(conflict)).toEqual(conflict);
  });

  it("batch：入参条目与逐文件结果（pushed/conflict/forbidden/invalid，可选字段）", () => {
    const entry = { path: "a.yaml", content: "x", baseVersion: 0 };
    expect(OnlineBatchEntrySchema.parse(entry)).toEqual(entry);
    const result = {
      results: [
        { path: "a.yaml", status: "pushed", version: 3 },
        { path: "b.yaml", status: "conflict", currentVersion: 5 },
        { path: "c.yaml", status: "forbidden", message: "项目无写权限" },
        { path: "d.yaml", status: "invalid", message: "内容非法" },
      ],
    };
    expect(OnlineBatchResultSchema.parse(result)).toEqual(result);
    expect(OnlineBatchResultSchema.safeParse({ results: [{ path: "e.yaml", status: "merged" }] }).success).toBe(false);
  });

  // M3-C 前置对齐②：服务端单文件落盘 IO 失败以 failed 行呈现（ContentService.pushOne：
  // io_error → status "failed"，不整批 500）——客户端不认 failed 会令整批 parse 失败、
  // 迁移推送中断，故枚举必须补 failed。fixture 对应 BatchResultView.FileResult 实序列化形状。
  it("batch 逐文件结果含 failed 行（服务端 io_error 口径，M3-C 前置对齐②）", () => {
    const result = { results: [{ path: "a.yaml", status: "failed", message: "文件落盘失败，版本已回滚" }] };
    expect(OnlineBatchResultSchema.parse(result)).toEqual(result);
  });

  it("path 规则：禁止 ..、绝对路径、反斜杠、空段；另禁冒号（客户端仍拦——服务端已移除禁冒号改由首段 UUID 规则拦盘符形态，客户端放开留待任务 7）", () => {
    expect(OnlinePathSchema.safeParse("groups/订单/apicc.workspace.yaml").success).toBe(true);
    expect(OnlinePathSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(OnlinePathSchema.safeParse("a/../b").success).toBe(false);
    expect(OnlinePathSchema.safeParse("/abs/path").success).toBe(false);
    expect(OnlinePathSchema.safeParse("a\\b").success).toBe(false);
    expect(OnlinePathSchema.safeParse("a//b").success).toBe(false);
    expect(OnlinePathSchema.safeParse("").success).toBe(false);
    expect(OnlinePathSchema.safeParse("C:/etc/passwd").success).toBe(false);
    expect(OnlinePathSchema.safeParse("a:b.yaml").success).toBe(false);
  });
});
