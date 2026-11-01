import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { contractAiView, prepareAiContext, projectAiAsset, redactAiText, renderContractMarkdown, type AiApiLocator, type ApiAsset, type ContractFolder } from "@apicc/core";
import { createHash } from "node:crypto";
import type { DeepReadonly } from "@apicc/core/assets/context";
import type { McpProjectRead, McpSource } from "./source.js";
import { boundedJson, createPager } from "./pagination.js";

const pageSchema = { limit: z.number().int().min(1).max(200).optional().describe("页大小，默认 50，范围 1–200"), cursor: z.string().max(128).optional().describe("此固定来源签发的 opaque cursor") };
const omitted = ["scripts", "dataset-rows", "request-response-bodies", "secret-values"];
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "context-budget") return "MCP context-budget：报告上下文超过输入预算；请缩小选择或分页读取。";
  if (message.includes("report-expired") || (error as { status?: number })?.status === 410) return "MCP report-expired：报告已到期或已清理；不会自动重跑。";
  if (message.includes("report-not-archived")) return "MCP report-not-archived：报告尚未归档；请稍后重新读取。";
  if (message.includes("report-unowned") || message.includes("scope-mismatch") || message.includes("binding-mismatch") || message.includes("source-mismatch")) return "MCP report-unowned：报告归属或执行来源不匹配；不可读取。";
  if (message.includes("预算") || message.includes("output-budget")) return "MCP 输出超过预算；请分页（limit/cursor）或缩小选择。";
  if (message.includes("cursor")) return "MCP cursor 已失效；请从当前固定来源的首页重新读取。";
  if (message.includes("report-unreadable") || message.includes("invalid-response") || message.includes("invalid-core-output") || error instanceof z.ZodError) return "MCP report-unreadable：报告为空、未采集、已损坏或格式不受支持；不会自动重跑。";
  return "MCP 读取失败：来源/权限或选择已失效或数据不可读；请重新登录或选择当前授权的资产/报告。";
}
function* apis(project: McpProjectRead): Generator<{ api: DeepReadonly<ApiAsset>; apiPath: string; locator: AiApiLocator }> {
  const prefix = `groups/${project.groupId}/projects/${project.projectId}`;
  function* folderRows(folder: DeepReadonly<ContractFolder>, path: string, collectionId: string, folderIds: string[]): ReturnType<typeof apis> {
    for (const api of folder.apis) yield { api, apiPath: `${path}/apis/${api.contract.id}`, locator: { collectionId, folderIds, apiId: api.contract.id } };
    for (const child of folder.folders) yield* folderRows(child, `${path}/folders/${child.id}`, collectionId, [...folderIds, child.id]);
  }
  for (const collection of project.snapshot.project.collections) {
    const path = `${prefix}/collections/${collection.id}`;
    for (const api of collection.apis) yield { api, apiPath: `${path}/apis/${api.contract.id}`, locator: { collectionId: collection.id, folderIds: [], apiId: api.contract.id } };
    for (const folder of collection.folders) yield* folderRows(folder, `${path}/folders/${folder.id}`, collection.id, [folder.id]);
  }
}
function* assets(project: McpProjectRead) {
  for (const { api, apiPath, locator } of apis(project)) {
    yield { assetId: `api:${api.contract.id}`, kind: "api", name: redactAiText(api.contract.metadata.name), apiPath };
    for (const saved of api.cases) yield { assetId: caseId(api.contract.id, saved.id, saved.scope), kind: "case", name: redactAiText(saved.name), apiPath, locator: { ...locator, caseId: saved.id, scope: saved.scope } };
  }
  for (const kind of ["models", "components", "workflows", "datasets", "suites", "environments"] as const) {
    for (const asset of project.snapshot.project[kind] ?? []) yield { assetId: `${kind}:${asset.id}`, kind, name: redactAiText(asset.name), apiPath: undefined };
  }
}
const caseId = (apiId: string, id: string, scope: string) => `case:${apiId}:${encodeURIComponent(id)}:${encodeURIComponent(scope)}`;
interface ReadPayload { data: Record<string, unknown>; revision: string; limitations?: string[]; evidenceComplete?: boolean }

export function registerSourceTools(server: McpServer, getSource: () => Promise<McpSource>, maxBytes: number, legacy = true) {
  const pager = createPager();
  const envelope = (source: McpSource | undefined, payload: ReadPayload, name: string, error = false) => {
    const data = payload.data; const diagnostics = data.diagnostics as Array<{ code: string; count: number }> | undefined;
    const sourceComplete = !diagnostics?.some(item => item.count > 0); const pageComplete = !data.nextCursor;
    const completeness = { complete: !error && pageComplete && sourceComplete && payload.evidenceComplete !== false, pageComplete: !error && pageComplete, sourceComplete: !error && sourceComplete, ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}), ...(payload.evidenceComplete === undefined ? {} : { evidenceComplete: payload.evidenceComplete }) };
    const count = Array.isArray(data.items) ? data.items.length : undefined;
    const noun = name.includes("asset") ? "资产" : name.includes("report") ? "报告" : "运行";
    let detail = "";
    if (name === "get-run") {
      const states: Record<string, string> = { queued: "排队中", preparing: "准备中", running: "运行中", ended: "已结束" };
      const archives: Record<string, string> = { archived: "已归档", expired: "已到期", none: "未归档", pending: "归档中" };
      detail = `运行状态：${states[String(data.state)] ?? redactAiText(String(data.state ?? "未采集"))}；报告状态：${archives[String(data.reportState)] ?? redactAiText(String(data.reportState ?? "未采集"))}。`;
    }
    if (name === "get-report" && Array.isArray(data.evidence)) {
      const evidence = data.evidence as Array<{ kind: string; state: string; value: unknown }>;
      const logical = evidence.find(item => item.kind === "logical-summary")?.value as Record<string, unknown> | undefined;
      const observed = (field: string) => typeof logical?.[field] === "number" ? logical[field] : "未采集";
      detail = `安全证据 ${evidence.length} 条。${logical ? `逻辑结果：总计 ${observed("total")}，通过 ${observed("passed")}，失败 ${observed("failed")}。` : ""}${evidence.some(item => item.kind === "request-summary" && item.state !== "collected") ? "请求事实未采集，不补零。" : ""}`;
    }
    if (name === "get-report" && data.failure) {
      const failure = data.failure as { reasonCode: string; executionFact: string };
      detail = `${failure.executionFact === "not-started" ? "执行未开始" : "执行结果不确定"}：${failure.reasonCode}。没有可用原生报告或完整请求事实；不会重新提交。`;
    }
    const summary = error ? String(data.error) : `${noun}读取${count === undefined ? "完成" : `：本页 ${count} 项`}；${pageComplete ? "本选择无下一页" : "仍有下一页"}。${detail}${sourceComplete ? "" : "来源有不可读或不可归属记录，详见来源级计数。"}默认省略脚本、正文、数据行及秘密；安全证据不等同完整请求事实。`;
    const result = { ...text(summary), structuredContent: { source: source?.identity ?? null, revision: payload.revision, data, completeness, limitations: payload.limitations ?? omitted }, ...(error ? { isError: true } : {}) };
    boundedJson(result, maxBytes); return result;
  };
  const tool = (name: string, description: string, inputSchema: z.ZodRawShape, handler: (args: any, source: McpSource, signal: AbortSignal) => Promise<unknown>, structured = true) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true } }, async (args, extra) => {
      let source: McpSource | undefined;
      let revision = "unknown";
      try {
        source = await getSource(); const output = await handler(args, source, extra.signal);
        if (structured) { revision = (output as ReadPayload).revision; return envelope(source, output as ReadPayload, name); }
        const result = text(boundedJson(output, maxBytes)); boundedJson(result, maxBytes); return result;
      } catch (error) {
        const message = failure(error);
        if (!structured) return { ...text(message), isError: true };
        return envelope(source, { data: { error: message }, revision, limitations: ["selection-unavailable"] }, name, true);
      }
    });
  };
  tool("list-assets", "列出固定来源的项目或项目资产摘要；默认省略脚本、正文和数据行。", { projectId: z.string().optional(), ...pageSchema }, async (args, source, signal) => {
    if (!args.projectId) {
      const projects = (await source.projects(signal)).map(({ projectId, name, workspaceId, groupId }) => ({ projectId, name, workspaceId, groupId }));
      const revision = createHash("sha256").update(boundedJson(projects, 16 * 1024 * 1024)).digest("hex");
      return { data: pager.page(projects.map(project => ({ ...project, name: redactAiText(project.name) })), args, `${source.identity.bindingId}:${revision}:projects`), revision };
    }
    const project = await source.readProject(args.projectId, signal);
    return { data: pager.page(assets(project), args, `${source.identity.bindingId}:${args.projectId}:${project.revision}:assets`), revision: project.revision };
  });
  tool("get-asset", "读取同源资产的安全投影；API 契约默认省略正文，数据集仅列与行数。", { projectId: z.string(), assetId: z.string().max(256) }, async (args, source, signal) => {
    const project = await source.readProject(args.projectId, signal);
    for (const { api, locator } of apis(project)) {
      if (args.assetId === `api:${api.contract.id}`) return { data: { ...projectAiAsset(project.snapshot, { kind: "api", locator }), cases: api.cases.map(saved => ({ id: saved.id, name: redactAiText(saved.name), scope: redactAiText(saved.scope) })) }, revision: project.revision };
      for (const saved of api.cases) if (args.assetId === caseId(api.contract.id, saved.id, saved.scope)) return { data: projectAiAsset(project.snapshot, { kind: "case", locator: { ...locator, caseId: saved.id, scope: saved.scope } }), revision: project.revision };
    }
    for (const kind of ["models", "components", "workflows", "datasets", "suites", "environments"] as const) {
      const asset = project.snapshot.project[kind]?.find(item => args.assetId === `${kind}:${item.id}`);
      if (asset) return { data: projectAiAsset(project.snapshot, { kind, id: asset.id }), revision: project.revision };
    }
    throw new Error("asset-unavailable");
  });
  tool("list-runs", "分页列出已授权项目的既有运行和归档状态；不会启动执行。", { projectId: z.string(), ...pageSchema }, async (args, source, signal) => ({ data: await source.listRuns(args.projectId, args, signal), revision: (await source.readProject(args.projectId, signal)).revision }));
  tool("get-run", "读取 opaque 运行 ID 对应的当前状态；不会重跑不可读报告。", { runId: z.string().max(256) }, async (args, source, signal) => { const run = await source.getRun(args.runId, signal); return { data: run, revision: (await source.readProject(run.projectId, signal)).revision }; });
  tool("get-report", "读取已验证归属的既有报告安全证据；仅可显式选择已有安全有界正文位置。", { runId: z.string().max(256), bodySelection: z.array(z.string().max(256)).max(20).optional() }, async (args, source, signal) => {
    const selected = await source.getReport(args.runId, { bodySelection: args.bodySelection }, signal);
    const project = selected.project;
    if (selected.failure) return { data: { reportId: selected.reportId, reportRevision: selected.revision, failure: selected.failure }, revision: project.revision,
      evidenceComplete: false, limitations: ["no-native-report", "request-facts-not-collected", "execution-will-not-be-resubmitted"] };
    const preview = prepareAiContext({ purpose: "report-analysis", reportId: selected.reportId, report: selected.report, snapshot: project.snapshot, context: project.snapshot.context, source: project.binding, bodySelection: args.bodySelection ?? [] });
    return { data: { reportId: selected.reportId, reportRevision: selected.revision, source: preview.source, evidence: preview.evidence, omitted: preview.omitted, evidenceSelection: preview.evidenceSelection }, revision: project.revision, evidenceComplete: preview.omitted.length === 0, limitations: [...omitted, "evidence-is-not-complete-request-facts"] };
  });
  if (legacy) {
    tool("list-apis", "兼容接口摘要数组；显式 limit/cursor 返回分页 envelope，超预算须分页。", pageSchema, async (args, source, signal) => {
      const projects = await source.projects(signal); const captured: McpProjectRead[] = [];
      for (const ref of projects) {
        captured.push(await source.readProject(ref.projectId, signal));
      }
      function* rows() {
        for (const project of captured) for (const { api, apiPath } of apis(project)) {
          yield { id: api.contract.id, name: redactAiText(api.contract.metadata.name), protocol: api.contract.request.protocol, url: redactAiText(`${api.contract.request.baseUrl}${api.contract.request.path}`), apiPath };
        }
      }
      if (args.limit !== undefined || args.cursor !== undefined) return pager.page(rows(), args, `${source.identity.bindingId}:${captured.map(project => project.revision).join(":")}:apis`);
      const complete: Array<Record<string, string>> = []; let bytes = 2;
      for (const row of rows()) {
        bytes += Buffer.byteLength(boundedJson(row, maxBytes)) + (complete.length ? 1 : 0);
        if (bytes > maxBytes) throw new Error("MCP 输出超过预算；请分页（limit/cursor）");
        complete.push(row);
      }
      return complete;
    }, false);
    server.registerTool("get-api-design", { description: "按 list-apis 完整 UUID 定位符读取安全 Markdown 设计；默认省略正文。", inputSchema: { apiPath: z.string().min(1) }, annotations: { readOnlyHint: true } }, async ({ apiPath }, extra) => {
      try {
        const source = await getSource();
        for (const ref of await source.projects(extra.signal)) {
          const project = await source.readProject(ref.projectId, extra.signal);
          for (const row of apis(project)) if (row.apiPath === apiPath) {
            boundedJson(contractAiView(row.api, project.snapshot.context, { includeBodies: false }), maxBytes);
            const output = renderContractMarkdown(row.api, project.snapshot.context, { includeBodies: false });
            if (Buffer.byteLength(output) > maxBytes) throw new Error("output-budget");
            const result = text(output); boundedJson(result, maxBytes); return result;
          }
        }
        throw new Error("api-unavailable");
      } catch { return { ...text("未找到接口或来源无权/不可读/超过输出预算；请检查完整 UUID 路径与固定来源。"), isError: true }; }
    });
  }
}
