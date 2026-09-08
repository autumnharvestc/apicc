/**
 * 管理面契约 zod schema（M4-A 任务 1）：对齐 M3 规格 `2026-09-03-apicc-m3-collab-design.md`
 * §3 API 契约（v1，含五次修订）中管理控制台消费的端点子集（裁定⑤：auth 四端点、工作区与
 * 成员 §3.2 全部、项目 ACL §3.3 三行含 DELETE 修订、tree GET——内容写面 batch/files PUT
 * 不属管理面，不建 schema；任务 5 起追加规格 `2026-09-08-server-accounts-roles.md` §2
 * 账号管理五端点的消费面，计划 B 任务 6 起追加规格 2026-08 §4 组织管理（分组/项目）端点的
 * 消费面）。本文件是客户端实现面的单一事实源——client 出口先 safeParse
 * 再放行（形状不符 → protocol_error），后续 store/视图复用同批推断类型，避免两处漂移。
 * 约定（§3 开头）：认证端点外全部要求 `Authorization: Bearer <token>`；错误统一
 * `{ code, message }`；时间戳 ISO-8601 UTC；不臆造规格未列字段。
 */
import { z } from "zod";

// —— 错误与通用形状 ——
/** §3 约定：错误响应统一 { code, message }。 */
export const AdminErrorSchema = z.object({ code: z.string(), message: z.string() });

// —— 角色域（§3.2/§3.3）——
/** 工作区成员角色：OWNER > ADMIN > EDITOR > VIEWER。 */
export const AdminRoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
/** 项目 ACL 角色：NONE / VIEWER / EDITOR / ADMIN（无行 = 按工作区角色继承）。 */
export const AdminAclRoleSchema = z.enum(["NONE", "VIEWER", "EDITOR", "ADMIN"]);
/**
 * 项目级有效角色（§3.4 tree.projects[].myRole）：无 ACL 行时继承工作区角色（可为 OWNER），
 * 有 ACL 行时取覆盖值。规格未钉死取值域，取两域并集防真实服务端合法输出被误判
 * protocol_error（与桌面端同裁定）。
 */
export const AdminProjectRoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER", "NONE"]);

// —— 平台角色（规格 2026-09-08 §2 账号管理；/me role）——
/** 平台角色：USER / SUPERADMIN（首个账号启动引导为 SUPERADMIN，规格 §2）。 */
export const AdminPlatformRoleSchema = z.enum(["USER", "SUPERADMIN"]);

// —— 用户与认证（§3.1）——
/**
 * 认证面用户形状：register/login/me 共用。role 为可选（规格 2026-09-08 §6 起 /me 返回，
 * session store 据此显隐超管入口；缺省视为 USER，保持 parse 往返与旧 fixture 兼容）。
 */
export const AdminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: AdminPlatformRoleSchema.optional(),
});
/** register 入参：username 3-32 字符 [a-zA-Z0-9_-]，password ≥8。 */
export const AdminRegisterInputSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(8),
  displayName: z.string(),
});
/** login 200：{ token, expiresAt, user }。Web 端 token 由会话 store（任务 2）持久化 localStorage。 */
export const AdminLoginResultSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: AdminUserSchema,
});

// —— 工作区与成员（§3.2）——
export const AdminWorkspaceSummarySchema = z.object({ id: z.string(), name: z.string(), myRole: AdminRoleSchema, createdAt: z.string() });
/** POST /workspaces 201：创建者自动 OWNER。 */
export const AdminWorkspaceCreatedSchema = z.object({ id: z.string(), name: z.string(), myRole: AdminRoleSchema });
export const AdminWorkspaceDetailSchema = z.object({ id: z.string(), name: z.string(), myRole: AdminRoleSchema, memberCount: z.number() });
export const AdminMemberSchema = z.object({ userId: z.string(), username: z.string(), displayName: z.string(), role: AdminRoleSchema });

// —— 项目 ACL（§3.3）——
export const AdminAclEntrySchema = z.object({ userId: z.string(), role: AdminAclRoleSchema });

// —— 平台账号管理（规格 2026-09-08 §2，超管专属）——
/**
 * 账号管理行：GET/POST /admin/users 成功载荷。永不投影 password；disabled=true 即被停用
 * （登录/token 全部失效）；createdAt ISO-8601 UTC。role 必填（管理面清单恒带平台角色）。
 */
export const AdminAccountSchema = AdminUserSchema.extend({
  role: AdminPlatformRoleSchema,
  disabled: z.boolean(),
  createdAt: z.string(),
});

// —— 组织管理（规格 2026-09-08 §4，计划 B 任务 2 端点/任务 6 消费面）——
/**
 * 分组视图：GET/POST /workspaces/{id}/groups、POST .../groups/{gid}/rename 成功载荷。
 * 与服务端 GroupView 逐字对齐（id/name/isDefault/createdAt；workspaceId 由路径锚定，
 * 服务端视图不回传，不臆造字段）。
 */
export const AdminGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  createdAt: z.string(),
});
/** 项目视图：GET/POST .../projects、POST .../projects/{pid}/rename 成功载荷（ProjectView 同口径）。 */
export const AdminProjectSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

// —— 树（§3.4，管理面只读消费：项目清单来自 tree.projects）——
export const AdminTreeFileSchema = z.object({ path: z.string(), hash: z.string(), version: z.number(), size: z.number() });
/**
 * tree.projects 行（path 实体化修订 2026-09-08）：服务端不再回项目目录路径——内容 path
 * 首段即项目实体 UUID，`path` 退役为可选兼容字段（内容定位按 `id` 前缀推导）。
 */
export const AdminTreeProjectSchema = z.object({ id: z.string(), name: z.string(), path: z.string().optional(), myRole: AdminProjectRoleSchema });
export const AdminTreeSchema = z.object({
  workspaceId: z.string(),
  rootVersion: z.number(),
  files: z.array(AdminTreeFileSchema),
  projects: z.array(AdminTreeProjectSchema),
});

// —— 推断类型（store/视图层的单一类型来源）——
export type AdminError = z.infer<typeof AdminErrorSchema>;
export type AdminRole = z.infer<typeof AdminRoleSchema>;
export type AdminAclRole = z.infer<typeof AdminAclRoleSchema>;
export type AdminProjectRole = z.infer<typeof AdminProjectRoleSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminPlatformRole = z.infer<typeof AdminPlatformRoleSchema>;
export type AdminAccount = z.infer<typeof AdminAccountSchema>;
export type AdminGroup = z.infer<typeof AdminGroupSchema>;
export type AdminProject = z.infer<typeof AdminProjectSchema>;
export type AdminRegisterInput = z.infer<typeof AdminRegisterInputSchema>;
export type AdminLoginResult = z.infer<typeof AdminLoginResultSchema>;
export type AdminWorkspaceSummary = z.infer<typeof AdminWorkspaceSummarySchema>;
export type AdminWorkspaceCreated = z.infer<typeof AdminWorkspaceCreatedSchema>;
export type AdminWorkspaceDetail = z.infer<typeof AdminWorkspaceDetailSchema>;
export type AdminMember = z.infer<typeof AdminMemberSchema>;
export type AdminAclEntry = z.infer<typeof AdminAclEntrySchema>;
export type AdminTreeFile = z.infer<typeof AdminTreeFileSchema>;
export type AdminTreeProject = z.infer<typeof AdminTreeProjectSchema>;
export type AdminTree = z.infer<typeof AdminTreeSchema>;
