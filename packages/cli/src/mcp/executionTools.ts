import { z } from "zod";
import { DebugInvocationSchema } from "@apicc/core/schema";
import { ExecutionLocationSchema, RunConfigSchema, TaskTargetSchema } from "@apicc/execution/contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpExecutionOutcomeUncertainError, type McpExecutionHost } from "./execution.js";
import { CredentialError, HttpFileError, NetworkProfileError } from "@apicc/core";
import type { McpSource } from "./source.js";
import { boundedJson } from "./pagination.js";
import { ExecutionHttpError } from "@apicc/execution/client";

// Reuse the saved-target contracts, but never expose free requests, stress or operator permissions.
const prepareSchema = z.object({
  projectId: z.string().min(1).max(512), location: ExecutionLocationSchema,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("debug"), invocation: DebugInvocationSchema.options[1] }).strict(),
    TaskTargetSchema.options[2],
    // Core's custom JsonValue validator has the same z.json wire metadata, which SDK cannot emit.
    // Keep only this declaration projection JSON-Schema-compatible; Core still validates the target.
    TaskTargetSchema.options[3].extend({ inputs: z.record(z.string(), z.json()).optional() }),
  ]), environmentId: z.string().min(1).max(512).optional(), runConfig: RunConfigSchema.omit({ stress: true }).optional(),
}).strict();
const startSchema = z.object({ ticketId: z.string().uuid(), intentId: z.string().min(1).max(512) }).strict();
const cancelSchema = z.object({ runId: z.string().min(1).max(512) }).strict();

const safeReasons = new Map<string, string>([
  ["intent_conflict", "意图与原固定输入冲突；不得换票据重发，请查询原运行。"],
  ["mcp-ticket-capacity", "未使用票据已满；请使用或等待原票据到期。"],
  ["mcp-ticket-expired", "票据已到期，执行未开始；请重新检查保存的输入。"],
  ["mcp-local-job-timeout-not-started", "job-timeout：准备或票据等待预算已耗尽，执行未开始。"],
  ["mcp-local-job-timeout", "job-timeout：总执行预算已耗尽；请查询原运行，不要重发。"],
  ["mcp-local-jobTimeout-policy-invalid", "总执行期限不满足当前默认策略（含清理宽限约束）。"],
  ["mcp-ticket-definition-changed", "保存的定义已变化，执行未开始；原票据不能继续。"],
  ["mcp-local-active-capacity", "活动或不确定运行已满；请先查询和收束原运行。"],
  ["mcp-local-intent-metadata-capacity", "防重元数据额度已满；原运行仍可查询，不会忘记已消费意图。"],
  ["mcp-execution-host-closed", "本宿主已关闭，不能再启动运行。"],
  ["mcp-run-unavailable", "本宿主没有该运行的精确取消引用；未按 ID 猜测或取消其他运行。"],
  ["mcp-ticket-unavailable", "票据不可用或无法对账；不代表从未执行，请勿重新提交。"],
  ["execution-outcome-uncertain", "执行结果不确定；仅可查询原票据和意图，请勿重新提交。"],
  ["mcp-local-run-config-unsupported", "当前保存目标的运行配置不支持；执行未开始。"],
  ["mcp-local-input-material-unavailable", "固定输入材料不可用；执行未开始。"],
]);
const authorityReasons = new Map([
  ["forbidden", "权限不足（forbidden）"], ["unauthorized", "当前登录授权失效（unauthorized），请重新登录"],
  ["script_approval_required", "保存脚本需要批准"], ["script_permission_denied", "没有保存脚本执行权限"],
  ["script_grant_changed", "保存脚本批准版本已改变"], ["material_version_conflict", "固定材料版本已变化"],
  ["CREDENTIAL_VERSION_CONFLICT", "固定凭据版本已变化"], ["CREDENTIAL_MISSING", "缺少固定凭据材料"],
  ["CREDENTIAL_UNAVAILABLE", "固定凭据材料不可用"], ["FILE_SOURCE_CHANGED", "固定文件材料已变化"],
  ["FILE_SOURCE_NOT_REPLAYABLE", "固定文件材料不可读取"], ["UPLOAD_LIMIT_EXCEEDED", "文件材料超过上传预算"],
]);
type ExecutionStage = "prepare" | "start" | "cancel";
function safeError(error: unknown, stage: ExecutionStage): string {
  // Never forward arbitrary adapter message/body/cause/path or structural .code values.
  if (error instanceof McpExecutionOutcomeUncertainError) {
    const reason = authorityReasons.get(error.reasonCode) ?? "服务端拒绝了本次执行操作";
    return `${reason}；执行结果不确定（execution-outcome-uncertain）。仅可查询原票据和意图，勿重新提交。`;
  }
  if (stage === "prepare" && error instanceof ExecutionHttpError) {
    const reason = authorityReasons.get(error.code ?? "") ?? (error.status === 403 ? "权限不足" : error.status === 401 ? "当前登录授权失效，请重新登录" : "服务端拒绝了准备操作");
    return `${reason}；准备未完成，执行未开始，未返回执行票据。请操作人修正权限或配置后显式重新准备；不会自动启动或重试。`;
  }
  if (error instanceof CredentialError) {
    return `${authorityReasons.get(error.code) ?? "固定凭据材料缺失、不可读或无效"}；准备未完成。请操作人在凭据管理中补齐或更新材料后重新准备；不会自动启动或重试。`;
  }
  if (error instanceof HttpFileError || error instanceof NetworkProfileError) {
    return `${authorityReasons.get(error.code) ?? "固定输入材料缺失、不可读或无效"}；准备未完成，不会自动启动或重试。`;
  }
  if (error instanceof Error) {
    const known = safeReasons.get(error.message); if (known) return known;
    if (error.name === "ZodError") return "工具参数不符合保存目标和运行配置约束；请检查选择。";
  }
  return "执行操作被拒绝或未能完成；结果尚未确认，请查询原票据/运行，不要重新提交。原始错误与秘密未返回。";
}

export function registerExecutionTools(server: McpServer, getSource: () => Promise<McpSource>, getHost: () => Promise<McpExecutionHost>, maxBytes: number): void {
  const result = (source: McpSource | undefined, data: object, message: string, isError = false) => {
    const value = { content: [{ type: "text" as const, text: message }], structuredContent: { source: source?.identity ?? null, data }, ...(isError ? { isError: true } : {}) };
    boundedJson(value, maxBytes); return value;
  };
  const invoke = async (stage: ExecutionStage, action: (host: McpExecutionHost) => Promise<{ data: object; text: string }>) => {
    let source: McpSource | undefined;
    try { source = await getSource(); const value = await action(await getHost()); return result(source, value.data, value.text); }
    catch (error) {
      const message = safeError(error, stage);
      try { return result(source, { error: message }, message, true); }
      catch { return result(undefined, {}, "操作结果超过输出预算；请查询原运行，请勿重新提交。", true); }
    }
  };
  server.registerTool("prepare-run", { title: "准备保存的执行目标", description: "只准备当前来源的保存 case/suite/workflow，不发送业务请求；权限、档位与额度由操作人启动配置固定。", inputSchema: prepareSchema, annotations: { readOnlyHint: false } }, async (input, extra) => invoke("prepare", async host => {
    const summary = await host.prepare(input, extra.signal);
    const targets = { debug: "保存用例调试", suite: "测试套件", workflow: "工作流" };
    const profiles = { "no-script": "无脚本", "trusted-core-script": "受信脚本" };
    return { data: summary, text: `执行准备完成；目标 ${targets[summary.targetKind]}，档位 ${summary.executionProfile ? profiles[summary.executionProfile] : "服务端固定"}，票据 ${summary.ticketId}，到期 ${summary.expiresAt}。${summary.deadlineAt ? `总期限 ${summary.deadlineAt}（含准备与票据等待）。` : ""}尚未发送业务请求；请用 start-run 接纳运行。` };
  }));
  server.registerTool("start-run", { title: "启动已准备的保存目标", description: "消费原票据与稳定 intentId；重复同一调用查询原运行，不重发业务。返回接纳句柄而非成功结论。", inputSchema: startSchema, annotations: { readOnlyHint: false, destructiveHint: true } }, async (input, extra) => invoke("start", async host => {
    const handle = await host.start(input, extra.signal);
    const locations = { local: "本地", agent: "代理" }, states = { preparing: "准备中", running: "运行中", queued: "排队中", ended: "已结束" };
    return { data: handle, text: `已接纳运行 ${handle.runId}；位置 ${locations[handle.location.kind]}，状态 ${states[handle.state]}。接纳不保证业务完成或成功；用 get-run/get-report 读取原运行，勿换 intentId 重发。` };
  }));
  server.registerTool("cancel-run", { title: "取消精确拥有的运行", description: "只取消本宿主已知的精确运行；本地等待实际收束，在线按当前成员权限提出取消。", inputSchema: cancelSchema, annotations: { readOnlyHint: false, destructiveHint: true } }, async (input, extra) => invoke("cancel", async host => {
    await host.cancel(input.runId, extra.signal);
    return { data: { runId: input.runId }, text: `运行 ${input.runId} 的取消请求已处理；远端请求被接纳不代表已终止，请查询原运行状态。` };
  }));
}
