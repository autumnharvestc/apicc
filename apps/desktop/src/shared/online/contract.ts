/**
 * 在线契约 zod schema（M3-B 任务 1）：逐端点对齐规格 `2026-09-03-apicc-m3-collab-design.md`
 * §3 API 契约（v1）。本文件是客户端实现面的单一事实源——client 出口先 safeParse 再放行
 * （形状不符 → protocol_error），IPC 入参校验表复用同批 schema，避免两处漂移。
 * 约定（§3 开头）：认证端点外全部要求 `Authorization: Bearer <token>`；错误统一
 * `{ code, message }`；时间戳 ISO-8601 UTC；不臆造规格未列字段。
 */
import { z } from "zod";

// —— 错误与通用形状 ——
/** §3 约定：错误响应统一 { code, message }。 */
export const OnlineErrorSchema = z.object({ code: z.string(), message: z.string() });
/** §3.4 PUT 409：`{ code: version_conflict, currentVersion, currentHash }`（message 为规格统一错误形状的可选兼容字段）。 */
export const OnlineVersionConflictSchema = z.object({
  code: z.literal("version_conflict"),
  currentVersion: z.number(),
  currentHash: z.string(),
  message: z.string().optional(),
});

// —— 角色域（§2 D5）——
/** 工作区成员角色：OWNER > ADMIN > EDITOR > VIEWER。 */
export const OnlineRoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
/** 项目 ACL 角色：NONE / VIEWER / EDITOR / ADMIN（无行 = 按工作区角色继承）。 */
export const OnlineAclRoleSchema = z.enum(["NONE", "VIEWER", "EDITOR", "ADMIN"]);
/**
 * 项目级有效角色（§3.4 tree.projects[].myRole）：无 ACL 行时继承工作区角色（可为 OWNER），
 * 有 ACL 行时取覆盖值（理论可为 NONE，但无读权项目子树整体不出现）。规格未钉死取值域，
 * 取两域并集防真实服务端合法输出被误判 protocol_error。
 */
export const OnlineProjectRoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER", "NONE"]);

// —— 用户与认证（§3.1）——
export const OnlineUserSchema = z.object({ id: z.string(), username: z.string(), displayName: z.string() });
/** register 入参：username 3-32 字符 [a-zA-Z0-9_-]，password ≥8。 */
export const OnlineRegisterInputSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(8),
  displayName: z.string(),
});
/** login 200：{ token, expiresAt, user }（token 只留在 main 进程，不出 IPC 出口）。 */
export const OnlineLoginResultSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  user: OnlineUserSchema,
});

// —— 工作区与成员（§3.2）——
export const OnlineWorkspaceSummarySchema = z.object({ id: z.string(), name: z.string(), myRole: OnlineRoleSchema, createdAt: z.string() });
/** POST /workspaces 201：创建者自动 OWNER。 */
export const OnlineWorkspaceCreatedSchema = z.object({ id: z.string(), name: z.string(), myRole: OnlineRoleSchema });
export const OnlineWorkspaceDetailSchema = z.object({ id: z.string(), name: z.string(), myRole: OnlineRoleSchema, memberCount: z.number() });
export const OnlineMemberSchema = z.object({ userId: z.string(), username: z.string(), displayName: z.string(), role: OnlineRoleSchema });

// —— 项目 ACL（§3.3）——
export const OnlineAclEntrySchema = z.object({ userId: z.string(), role: OnlineAclRoleSchema });

// —— 内容（§3.4，核心同步面）——
export const OnlineTreeFileSchema = z.object({ path: z.string(), hash: z.string(), version: z.number(), size: z.number() });
/**
 * tree.projects 行（契约修订 2026-09-03，main @ 3d8b3fc）：`path` 为项目目录相对工作区根的
 * `/` 分隔路径，必填——同名项目按 name 匹配权限会张冠李戴，客户端 ACL 判定按 path 定位。
 */
export const OnlineTreeProjectSchema = z.object({ id: z.string(), name: z.string(), path: z.string(), myRole: OnlineProjectRoleSchema });
export const OnlineTreeSchema = z.object({
  workspaceId: z.string(),
  rootVersion: z.number(),
  files: z.array(OnlineTreeFileSchema),
  projects: z.array(OnlineTreeProjectSchema),
});
export const OnlineFileContentSchema = z.object({ path: z.string(), content: z.string(), version: z.number(), hash: z.string() });
export const OnlineFilesResultSchema = z.object({ files: z.array(OnlineFileContentSchema), missing: z.array(z.string()) });
export const OnlinePutFileResultSchema = z.object({ path: z.string(), version: z.number(), hash: z.string() });
/** §3.4 path 规则：禁止 ..、绝对路径、反斜杠、空段。 */
export const OnlinePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\\"), "path 禁止反斜杠")
  .refine((p) => !p.startsWith("/") && !p.endsWith("/"), "path 禁止绝对路径/尾空段")
  .refine((p) => p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== ".."), "path 禁止空段与 . / ..");
/** batch 条目：{ path, content, baseVersion }（新文件 baseVersion=0）。 */
export const OnlineBatchEntrySchema = z.object({ path: OnlinePathSchema, content: z.string(), baseVersion: z.number().int().nonnegative() });
/** batch 入参：≤200 条/批。 */
export const OnlineBatchInputSchema = z.object({ files: z.array(OnlineBatchEntrySchema).min(1).max(200) });
export const OnlineBatchResultItemSchema = z.object({
  path: z.string(),
  status: z.enum(["pushed", "conflict", "forbidden", "invalid"]),
  version: z.number().optional(),
  currentVersion: z.number().optional(),
  message: z.string().optional(),
});
export const OnlineBatchResultSchema = z.object({ results: z.array(OnlineBatchResultItemSchema) });
/** GET files 查询：≤200 路径/批。 */
export const OnlineGetFilesInputSchema = z.object({ paths: z.array(z.string()).min(1).max(200) });

/** IPC/客户端共用的 baseUrl 形状：自托管服务端，http/https 均可（尾随 / 由 client 归一）。 */
export const OnlineBaseUrlSchema = z
  .string()
  .min(1)
  .refine((s) => s.startsWith("http://") || s.startsWith("https://"), "baseUrl 必须以 http:// 或 https:// 开头");

// —— 推断类型（渲染层 DTO 的单一来源，shared/online/types.ts 再出口）——
export type OnlineError = z.infer<typeof OnlineErrorSchema>;
export type OnlineVersionConflict = z.infer<typeof OnlineVersionConflictSchema>;
export type OnlineRole = z.infer<typeof OnlineRoleSchema>;
export type OnlineAclRole = z.infer<typeof OnlineAclRoleSchema>;
export type OnlineUser = z.infer<typeof OnlineUserSchema>;
export type OnlineRegisterInput = z.infer<typeof OnlineRegisterInputSchema>;
export type OnlineLoginResult = z.infer<typeof OnlineLoginResultSchema>;
export type OnlineWorkspaceSummary = z.infer<typeof OnlineWorkspaceSummarySchema>;
export type OnlineWorkspaceCreated = z.infer<typeof OnlineWorkspaceCreatedSchema>;
export type OnlineWorkspaceDetail = z.infer<typeof OnlineWorkspaceDetailSchema>;
export type OnlineMember = z.infer<typeof OnlineMemberSchema>;
export type OnlineAclEntry = z.infer<typeof OnlineAclEntrySchema>;
export type OnlineProjectRole = z.infer<typeof OnlineProjectRoleSchema>;
export type OnlineTreeFile = z.infer<typeof OnlineTreeFileSchema>;
export type OnlineTreeProject = z.infer<typeof OnlineTreeProjectSchema>;
export type OnlineTree = z.infer<typeof OnlineTreeSchema>;
export type OnlineFilesResult = z.infer<typeof OnlineFilesResultSchema>;
export type OnlinePutFileResult = z.infer<typeof OnlinePutFileResultSchema>;
export type OnlineBatchEntry = z.infer<typeof OnlineBatchEntrySchema>;
export type OnlineBatchInput = z.infer<typeof OnlineBatchInputSchema>;
export type OnlineBatchResult = z.infer<typeof OnlineBatchResultSchema>;
