// M4-A 任务 1：管理面契约 schema 测试——fixture 逐字取自 M3 规格 §3 API 契约表格
// （`2026-09-03-apicc-m3-collab-design.md`，含五次修订中管理面相关的 projects.path
// 修订与 ACL DELETE 修订），验证 parse 往返（parse(fixture) 深等于 fixture）与非法形状拒绝。
// 覆盖面=裁定⑤管理面子集：auth 四端点、工作区/成员 §3.2、项目 ACL §3.3、tree GET。
import { describe, expect, it } from "vitest";
import {
  AdminAclEntrySchema,
  AdminErrorSchema,
  AdminLoginResultSchema,
  AdminMemberSchema,
  AdminRegisterInputSchema,
  AdminTreeSchema,
  AdminUserSchema,
  AdminWorkspaceCreatedSchema,
  AdminWorkspaceDetailSchema,
  AdminWorkspaceSummarySchema,
} from "../../src/api/contract.js";

const USER = { id: "u-1", username: "alice", displayName: "Alice" };

describe("管理面契约 schema（M3 规格 §3 fixture 往返）", () => {
  // —— §3.1 认证 ——
  it("register：入参（username 3-32 [a-zA-Z0-9_-] / password ≥8）与 201 成功载荷 { id, username, displayName }", () => {
    const input = { username: "alice", password: "password8", displayName: "Alice" };
    expect(AdminRegisterInputSchema.parse(input)).toEqual(input);
    expect(AdminUserSchema.parse(USER)).toEqual(USER);
  });

  it("register 入参拒绝：用户名过短/非法字符/超长、密码过短", () => {
    expect(AdminRegisterInputSchema.safeParse({ username: "ab", password: "password8", displayName: "x" }).success).toBe(false);
    expect(AdminRegisterInputSchema.safeParse({ username: "a.b", password: "password8", displayName: "x" }).success).toBe(false);
    expect(AdminRegisterInputSchema.safeParse({ username: "a".repeat(33), password: "password8", displayName: "x" }).success).toBe(false);
    expect(AdminRegisterInputSchema.safeParse({ username: "alice", password: "short", displayName: "x" }).success).toBe(false);
  });

  it("login：200 载荷 { token, expiresAt, user }；缺 expiresAt 拒绝", () => {
    const fixture = { token: "tok-abc123", expiresAt: "2026-10-03T00:00:00Z", user: USER };
    expect(AdminLoginResultSchema.parse(fixture)).toEqual(fixture);
    expect(AdminLoginResultSchema.safeParse({ token: "t", user: USER }).success).toBe(false);
  });

  it("统一错误形状 { code, message }（§3 约定：409 username_taken / 403 registration_disabled / 401 invalid_credentials）；缺 message 拒绝", () => {
    for (const fixture of [
      { code: "username_taken", message: "用户名已被占用" },
      { code: "registration_disabled", message: "注册已关闭" },
      { code: "invalid_credentials", message: "用户名或密码错误" },
    ]) {
      expect(AdminErrorSchema.parse(fixture)).toEqual(fixture);
    }
    expect(AdminErrorSchema.safeParse({ code: "username_taken" }).success).toBe(false);
  });

  // —— §3.2 工作区与成员 ——
  it("工作区列表行 { id, name, myRole, createdAt }；创建返回 { id, name, myRole: OWNER }（创建者自动 OWNER）", () => {
    const row = { id: "ws-1", name: "团队空间", myRole: "OWNER", createdAt: "2026-09-03T00:00:00Z" };
    expect(AdminWorkspaceSummarySchema.parse(row)).toEqual(row);
    const created = { id: "ws-1", name: "团队空间", myRole: "OWNER" };
    expect(AdminWorkspaceCreatedSchema.parse(created)).toEqual(created);
  });

  it("工作区详情 { id, name, myRole, memberCount }；myRole 越界值拒绝", () => {
    const detail = { id: "ws-1", name: "团队空间", myRole: "ADMIN", memberCount: 5 };
    expect(AdminWorkspaceDetailSchema.parse(detail)).toEqual(detail);
    expect(AdminWorkspaceDetailSchema.safeParse({ id: "ws-1", name: "x", myRole: "GUEST", memberCount: 1 }).success).toBe(false);
  });

  it("成员行 { userId, username, displayName, role }，role ∈ OWNER/ADMIN/EDITOR/VIEWER", () => {
    for (const role of ["OWNER", "ADMIN", "EDITOR", "VIEWER"]) {
      expect(AdminMemberSchema.parse({ userId: "u-2", username: "bob", displayName: "Bob", role })).toEqual({
        userId: "u-2",
        username: "bob",
        displayName: "Bob",
        role,
      });
    }
    expect(AdminMemberSchema.safeParse({ userId: "u-2", username: "bob", displayName: "Bob", role: "GUEST" }).success).toBe(false);
  });

  // —— §3.3 项目 ACL（role ∈ NONE/VIEWER/EDITOR/ADMIN）——
  it("ACL 行 { userId, role }，role 含 NONE（NONE=拒之门外）；OWNER 越界拒绝", () => {
    expect(AdminAclEntrySchema.parse({ userId: "u-2", role: "VIEWER" })).toEqual({ userId: "u-2", role: "VIEWER" });
    expect(AdminAclEntrySchema.parse({ userId: "u-3", role: "NONE" })).toEqual({ userId: "u-3", role: "NONE" });
    expect(AdminAclEntrySchema.safeParse({ userId: "u-2", role: "OWNER" }).success).toBe(false);
  });

  // —— §3.4 tree（管理面只读消费；projects.path 为契约修订 2026-09-03 的必填字段）——
  it("tree：{ workspaceId, rootVersion, files[path/hash/version/size], projects[id/name/path/myRole] }——projects.path 必填（修订 2026-09-03，同名项目权限判定按 path 定位）", () => {
    const fixture = {
      workspaceId: "ws-1",
      rootVersion: 42,
      files: [{ path: "groups/订单/a.yaml", hash: "deadbeef", version: 8, size: 128 }],
      projects: [
        { id: "p-1", name: "订单", path: "groups/订单/projects/订单", myRole: "EDITOR" },
        { id: "p-2", name: "网关", path: "groups/网关/projects/网关", myRole: "NONE" },
      ],
    };
    expect(AdminTreeSchema.parse(fixture)).toEqual(fixture);
  });

  it("tree 拒绝：projects 行缺 path（钉住修订 2026-09-03）与 myRole 越界", () => {
    const base = { workspaceId: "ws-1", rootVersion: 1, files: [] };
    expect(AdminTreeSchema.safeParse({ ...base, projects: [{ id: "p-1", name: "订单", myRole: "EDITOR" }] }).success).toBe(false);
    expect(AdminTreeSchema.safeParse({ ...base, projects: [{ id: "p-1", name: "订单", path: "p", myRole: "GUEST" }] }).success).toBe(false);
  });
});
