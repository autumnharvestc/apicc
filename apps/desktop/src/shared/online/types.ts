/**
 * online 渲染层 DTO（M3-B 任务 1）：契约（contract.ts）之上的 IPC 出口形状。
 * 契约形状原样出口（type-only，zod 不进渲染层运行时）；IPC 复合 DTO 只补两件事：
 * ① login 出口剥掉 token（token 只留在 main 进程，经 tokenStore 持久化）；
 * ② put/delete 的 409 冲突不跨 IPC 抛错（Error 越结构化克隆通道会丢自定义字段），
 *    转为可辨别的 outcome 结果对象，渲染层按 outcome 分支渲染冲突对话框（任务 3）。
 */
import type { OnlineBatchEntry, OnlineMappingEntry, OnlinePutFileResult, OnlineRegisterInput, OnlineRole, OnlineTreeProject, OnlineUser, OnlineVersionConflict } from "./contract.js";
import type { TreeNodeDTO } from "../tree-dto.js";
import type { ProjectDirRef } from "./migrate.js";

export type {
  OnlineAclEntry,
  OnlineAclRole,
  OnlineBatchEntry,
  OnlineBatchInput,
  OnlineBatchResult,
  OnlineError,
  OnlineFilesResult,
  OnlineGroup,
  OnlineLoginResult,
  OnlineMappingEntry,
  OnlineMappingResult,
  OnlineMappingRow,
  OnlineMember,
  OnlineProjectRole,
  OnlinePutFileResult,
  OnlineRegisterInput,
  OnlineRole,
  OnlineTree,
  OnlineTreeFile,
  OnlineTreeProject,
  OnlineUser,
  OnlineVersionConflict,
  OnlineWorkspaceCreated,
  OnlineWorkspaceDetail,
  OnlineWorkspaceSummary,
} from "./contract.js";

/** online:login 入参：baseUrl 定位自托管服务端（服务器档案按此字段切换）。 */
export interface OnlineLoginInput { baseUrl: string; username: string; password: string }
/** online:register 入参：register 契约入参 + baseUrl（注册不需要也不建立登录态）。 */
export type OnlineRegisterChannelInput = OnlineRegisterInput & { baseUrl: string };
/** online:login 出口：剥掉 token 的 login 结果（expiresAt 供登录态过期展示）。 */
export interface OnlineLoginOutput { expiresAt: string; user: OnlineUser }
/**
 * 服务器档案（任务 2 裁定 C）：url + 昵称，多档案并存；与登录态分离（登出不清档案）。
 * 非敏感数据（token 不在其中，token 留 main 进程 tokenStore），渲染层 localStorage 持久化。
 */
export interface OnlineServerProfile { baseUrl: string; name: string }
/** online:resume 入参：对指定服务器尝试恢复登录态。 */
export interface OnlineResumeInput { baseUrl: string }
/**
 * online:resume 出口（任务 2 裁定 A）：restored = token 存档验活通过（登录态恢复，user 为
 * 服务端 /me 结果）；signed-out = 无存档或验活失败（已清档），保持登出态。resume 不抛错。
 */
export type OnlineResumeOutput = { outcome: "restored"; user: OnlineUser } | { outcome: "signed-out" };
/** online:files:put 出口：pushed 携带契约 PUT 结果；conflict 原样携带服务端 409 冲突对象。 */
export type OnlinePushOutcome =
  | { outcome: "pushed"; result: OnlinePutFileResult }
  | { outcome: "conflict"; conflict: OnlineVersionConflict };
/** online:files:delete 出口：deleted 或 409 冲突（同 PUT 并发语义）。 */
export type OnlineDeleteOutcome =
  | { outcome: "deleted" }
  | { outcome: "conflict"; conflict: OnlineVersionConflict };
/** online:files:get 入参。 */
export interface OnlineFilesGetInput { workspaceId: string; paths: string[] }
/** online:files:put 入参（新文件 baseVersion=0）。 */
export interface OnlineFilePutInput { workspaceId: string; path: string; content: string; baseVersion: number }
/** online:files:batch 入参。 */
export interface OnlineFilesBatchInput { workspaceId: string; files: OnlineBatchEntry[] }
/** online:files:delete 入参。 */
export interface OnlineFileDeleteInput { workspaceId: string; path: string; baseVersion: number }
/** online:workspaces:create 入参。 */
export interface OnlineWorkspaceCreateInput { name: string }

// —— 在线工作区浏览/迁移（M3-B 任务 3，裁定 A/D/E）——
/** online:workspace:open 入参：工作区摘要三元组（列表项原样回传，main 记录当前在线工作区）。 */
export interface OnlineWorkspaceOpenInput { workspaceId: string; name: string; myRole: OnlineRole }
/**
 * 在线工作区视图：树 DTO（main 进程 onlineTreeToDto 由 path 清单映射，裁定 A）+
 * 项目角色清单（渲染层按 projects[].myRole 判定逐项目只读/可写，NONE 项目已在服务端过滤）。
 */
export interface OnlineWorkspaceView {
  workspaceId: string;
  name: string;
  myRole: OnlineRole;
  projects: OnlineTreeProject[];
  tree: TreeNodeDTO;
}
/**
 * online:migrate:scan 出口：本地目录文本文件清单（/ 相对路径 + sha-256 + utf8 内容 + 项目目录
 * 归属——groups/<组>/projects/<名> 二元组，根级/非项目内文件为 null，供迁移映射桥载荷提取）。
 */
export interface OnlineMigrateScanResult {
  files: Array<{ path: string; hash: string; content: string; projectDir: ProjectDirRef | null }>;
}
/** online:migrate:write 入参：迁移拉取的落盘批（≤200/批，路径过契约 path 规则）。 */
export interface OnlineMigrateWriteInput { dir: string; files: Array<{ path: string; content: string }> }
/** online:project-mapping 入参：本地名称目录清单（≤200/批，与映射端点批量上限一致）。 */
export interface OnlineProjectMappingInput { workspaceId: string; entries: OnlineMappingEntry[] }
/** 迁移逐文件动作（拉取：pulled/updated/skipped/failed；推送：pushed/conflict/forbidden/invalid/skipped）。 */
export type MigrationFileAction = "pulled" | "updated" | "skipped" | "failed" | "pushed" | "conflict" | "forbidden" | "invalid";
/**
 * 迁移结果清单（裁定 D：计数 + 明细；冲突默认跳过并列出）。details.path 统一**本地名称路径**
 * （计划 C 任务 2：push=原扫描路径、pull=还原后落盘路径——服务端实体路径对用户无意义不出 UI）；
 * note = 可选退化注记（拉取孤儿 projectId 按实体路径原样落盘时标注）。
 */
export interface MigrationResult {
  direction: "pull" | "push";
  pulled: number;
  updated: number;
  skipped: number;
  pushed: number;
  conflicts: number;
  failed: number;
  details: Array<{ path: string; action: MigrationFileAction; note?: string }>;
}
