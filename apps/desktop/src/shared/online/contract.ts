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
/** §3.4 PUT 409：`{ code: version_conflict, currentVersion, currentHash }`（message 为规格统一错误形状的可选兼容字段）。
 * currentHash 可空（M3-C 前置对齐①）：服务端新文件并发删除场景抛 VersionConflictException(0, null)，
 * 409 体序列化为 currentHash: null——strict string 会 parse 失败退化普通错误、冲突对话框不出现。 */
export const OnlineVersionConflictSchema = z.object({
  code: z.literal("version_conflict"),
  currentVersion: z.number(),
  currentHash: z.string().nullable(),
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
 * tree.projects 行（path 实体化修订 2026-09-08）：服务端不再回项目目录路径——内容 path
 * 首段即项目实体 UUID（`<projectId>/...` 前缀可推导），`path` 退役为可选兼容字段；
 * 消费方按 `id` 前缀定位文件所属项目。`groupId` 为所属分组实体 id（服务端已下发，
 * 原任务 7 计划的 schema 声明随 e2e 断言先行落地——zod 严格按声明键透传，未声明会被剥离）。
 */
export const OnlineTreeProjectSchema = z.object({ id: z.string(), name: z.string(), path: z.string().optional(), groupId: z.string().optional(), myRole: OnlineProjectRoleSchema });
export const OnlineTreeSchema = z.object({
  workspaceId: z.string(),
  rootVersion: z.number(),
  files: z.array(OnlineTreeFileSchema),
  projects: z.array(OnlineTreeProjectSchema),
});
export const OnlineFileContentSchema = z.object({ path: z.string(), content: z.string(), version: z.number(), hash: z.string() });
export const OnlineFilesResultSchema = z.object({ files: z.array(OnlineFileContentSchema), missing: z.array(z.string()) });
export const OnlinePutFileResultSchema = z.object({ path: z.string(), version: z.number(), hash: z.string() });
/** §3.4 path 规则：禁止 ..、绝对路径、反斜杠、空段。禁冒号已放开（任务 7，对齐服务端
 * 实体化 2026-09-08：盘符形态由服务端「首段非 UUID」规则拦，客户端不再预拦冒号）。 */
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
/** batch 逐文件结果：status 含 failed（M3-C 前置对齐②）——服务端单文件落盘 IO 失败以 failed 行
 * 呈现（ContentService.pushOne 的 io_error 口径，部分成功语义），客户端不认则整批 parse 失败、
 * 迁移推送中断。conflict 行仅携 currentVersion（currentHash 不出批量面）。 */
export const OnlineBatchResultItemSchema = z.object({
  path: z.string(),
  status: z.enum(["pushed", "conflict", "forbidden", "invalid", "failed"]),
  version: z.number().optional(),
  currentVersion: z.number().optional(),
  message: z.string().optional(),
});
export const OnlineBatchResultSchema = z.object({ results: z.array(OnlineBatchResultItemSchema) });
/** GET files 查询：≤200 路径/批。 */
export const OnlineGetFilesInputSchema = z.object({ paths: z.array(z.string()).min(1).max(200) });

// —— 组织分组只读面（计划 C 任务 2 迁移拉取：groupId → 组名反查；§4 GET groups，成员可读）——
export const OnlineGroupSchema = z.object({ id: z.string(), name: z.string(), isDefault: z.boolean(), createdAt: z.string() });

// —— 迁移映射桥（计划 C 任务 1 服务端端点 / 任务 2 客户端消费）——
/** POST /workspaces/{id}/project-mapping 载荷条目：本地名称目录二元组 + 按需建开关（名称约束与组织 API 一致，≤200 条/批）。 */
export const OnlineMappingEntrySchema = z.object({
  group: z.string().min(1).max(64),
  project: z.string().min(1).max(64),
  createIfMissing: z.boolean(),
});
/** 载荷：{ entries: [...] }（服务端 @NotEmpty + 容器元素校验；批量上限 200 → batch_too_large）。 */
export const OnlineMappingInputSchema = z.object({ entries: z.array(OnlineMappingEntrySchema).min(1).max(200) });
/**
 * 响应行三态（服务端 NON_NULL——缺席字段不序列化，故除 group/project 外全部 optional）：
 * ①解析/建成 {group, project, groupId, projectId, created}（created=true 仅本轮新建过实体）；
 * ②缺失未建（createIfMissing=false 或替身简化建模）{group, project, missing: true}；
 * ③请求创建但权限不足 {group, project, forbidden: true}（行级 403 语义，部分成功不整批失败）。
 */
export const OnlineMappingRowSchema = z.object({
  group: z.string(),
  project: z.string(),
  groupId: z.string().optional(),
  projectId: z.string().optional(),
  created: z.boolean().optional(),
  missing: z.boolean().optional(),
  forbidden: z.boolean().optional(),
});
/** 响应：{ mappings: [...] }（逐条目部分成功——单行不建实体不整批失败）。 */
export const OnlineMappingResultSchema = z.object({ mappings: z.array(OnlineMappingRowSchema) });

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
export type OnlineGroup = z.infer<typeof OnlineGroupSchema>;
export type OnlineMappingEntry = z.infer<typeof OnlineMappingEntrySchema>;
export type OnlineMappingRow = z.infer<typeof OnlineMappingRowSchema>;
export type OnlineMappingResult = z.infer<typeof OnlineMappingResultSchema>;
