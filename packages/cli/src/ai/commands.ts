import type { Command } from "commander";
import {
  AiModelProfileSchema, AiModelCapabilitiesSchema, AiBudgetOverridesSchema, AiPurposeSchema, createAiConnectionFromTemplate, AiConnectionSchema, createInitialAiModelBudgets,
  createProjectSnapshot, prepareAiContext, inspectAiContextChoices, aiPersonalProjectKey, sameAiSourceBinding,
  createAiInvocationHost, runAiAssistance,
  migrateLegacyAiConfig,
  type PluginRegistry, type RunResult, type AiBusinessRequest, type ReadableStressReport, type Workspace,
} from "@apicc/core";
import { assertWorkspaceUsable, loadWorkspace, locateApi, locateProject } from "../workspace.js";
import { legacyAiFile, personalAiHost, readAiSecret, resolveCliAiInvocation, type CliAiConfigDeps } from "./config.js";
import { aiLabel, renderAiBudgetOverrides, renderAiPreview, renderAiResult, writeAiOutput } from "./output.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createOutputSanitizer } from "../output.js";
import { readLocalAiReports } from "../mcp/reports.js";
import { createMcpSource, type McpSource, type McpProjectRead } from "../mcp/source.js";
import type { McpProfileDeps } from "../mcp/profiles.js";
export { readLocalAiReports } from "../mcp/reports.js";

export interface AiCommandDeps extends CliAiConfigDeps, McpProfileDeps {
  registry: PluginRegistry; log(line: string): void; workspaceRoot(): string | null;
}
async function captureProject(source: McpSource, path: string, signal: AbortSignal) {
  const match = /^groups\/([^/]+)\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) throw new Error("AI 目标须为固定来源的完整项目/接口路径");
  const read = await source.readProject(match[2]!, signal);
  if (read.groupId !== match[1]) throw new Error("AI source scope 与目标不匹配");
  const project = structuredClone(read.snapshot.project) as Workspace["groups"][number]["projects"][number];
  const workspace: Workspace = { formatVersion: 1, id: read.workspaceId, name: "captured source", variables: {}, groups: [{ id: read.groupId, name: "captured group", projects: [project] }] };
  return { read, workspace, path: `groups/${read.groupId}/projects/${read.snapshot.project.id}${match[3] ?? ""}` };
}
async function selectSourceReport(source: McpSource, project: McpProjectRead, reportId: string, signal: AbortSignal) {
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await source.listRuns(project.projectId, { limit: 200, cursor }, signal);
    if (page.items.some(run => run.runId === reportId)) {
      const selected = await source.getReport(reportId, {}, signal);
      if (selected.project.projectId !== project.projectId || selected.project.groupId !== project.groupId || selected.project.workspaceId !== project.workspaceId) throw new Error("AI 报告归属与来源不匹配");
      if (!selected.report) throw new Error("AI 报告未采集：执行未开始或结果不确定，没有原生报告；不会重跑");
      return { ...selected, report: selected.report };
    }
    cursor = page.nextCursor; if (!cursor) break;
  }
  throw new Error("AI 报告选择不可用；请先运行 ai reports，或缩小受控归档集合");
}
const collect = (value: string, previous: string[] = []) => [...previous, value];
function fields(values: string[], boolean = false): Record<string, number | boolean> {
  const result: Record<string, number | boolean> = {};
  for (const value of values) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=(\d+|true|false)$/.exec(value);
    if (!match || (!boolean && /^(true|false)$/.test(match[2]!))) throw new Error("AI 设置须为已知字段 name=数值（能力字段也允许 true/false）");
    result[match[1]!] = match[2] === "true" ? true : match[2] === "false" ? false : Number(match[2]);
  }
  return result;
}

export function registerAiCommands(program: Command, deps: AiCommandDeps): void {
  const ai = program.command("ai").description("个人 AI 辅助（模型配置不等于在线项目登录来源）");
  const config = ai.command("config").description("仅修改当前宿主私有 AI 配置");
  config.command("templates").action(async () => {
    const { host } = await personalAiHost(deps); const result = await host.reloadCatalog();
    for (const template of result.catalog) deps.log(`${template.id}：${template.name}；${template.baseUrl}；协议 ${template.protocols.join("、")}`);
    for (const error of result.errors) deps.log(`模板不可读：${error.file}；${error.message}`);
  });
  config.command("migrate-legacy").option("--confirm-address <url>", "确认旧配置原始 API 根地址")
    .option("--insecure-local-test", "本次明确仅允许回环 HTTP 测试", false).action(async opts => {
      const { repository, secretBackend } = await personalAiHost(deps);
      const result = await migrateLegacyAiConfig({ repository, secretBackend, insecureLocalTest: opts.insecureLocalTest,
        confirmOriginalAddress: async baseUrl => { deps.log(`旧 AI 配置原始地址：${baseUrl}`); return opts.confirmAddress; },
        source: { kind: "cli-file-v1", async readConfiguration() {
          const raw = legacyAiFile(deps.aiHomeDir) as Record<string, unknown> | undefined;
          return raw ? { baseUrl: raw.baseUrl, model: raw.model } : undefined;
        }, async readSecret() {
          const raw = legacyAiFile(deps.aiHomeDir) as Record<string, unknown> | undefined;
          return typeof raw?.apiKey === "string" ? { state: "available", value: raw.apiKey } : { state: "missing" };
        } },
      });
      const status = { migrated: "已迁移；原文件保留", "already-migrated": "此前已迁移", "confirmation-required": "需要 --confirm-address 原始地址确认", "needs-configuration": "旧配置不可迁移，请手动配置" };
      deps.log(`AI 配置迁移：${status[result.status]}；凭据状态 ${aiLabel(result.credentialState)}`);
    });
  config.command("show").action(async () => {
    const { host } = await personalAiHost(deps);
    const { document, credentials } = await host.snapshot();
    deps.log("个人 AI 配置");
    for (const c of document.connections) deps.log(`连接 ${c.id}：${c.name}；${c.baseUrl}；凭据 ${aiLabel(credentials.find(s => s.connectionId === c.id)?.state ?? "missing")}`);
    for (const m of document.models) deps.log(`模型配置 ${m.id}：${m.modelId}；连接 ${m.connectionId}；协议 ${m.protocol}；能力 ${aiLabel(m.capabilities.status)}`);
    deps.log("预算继承来源：应用用途默认 → 模型通用 → 模型用途 → 个人用途绑定 → 个人项目用途覆盖 → 本次调用；最终仍受模型能力与应用保护限制");
    for (const [purpose, budgets] of Object.entries(document.application.purposeDefaults)) deps.log(`来源 应用默认 / ${aiLabel(purpose)}：${renderAiBudgetOverrides(budgets)}`);
    for (const m of document.models) {
      deps.log(`来源 模型通用 / ${m.id}：${renderAiBudgetOverrides(m.budgets)}`);
      for (const [purpose, budgets] of Object.entries(m.purposeBudgets)) deps.log(`来源 模型用途 / ${m.id} / ${aiLabel(purpose)}：${renderAiBudgetOverrides(budgets)}`);
    }
    for (const b of document.bindings) deps.log(`用途 ${aiLabel(b.purpose)} → 模型配置 ${b.modelProfileId}；来源 个人用途绑定：${renderAiBudgetOverrides(b.budgets)}`);
    for (const p of document.projectOverrides) deps.log(`项目用途预算覆盖 ${p.projectKey} / ${aiLabel(p.purpose)} → 模型配置 ${p.modelProfileId ?? "继承用途绑定"}；来源 个人项目：${renderAiBudgetOverrides(p.budgets)}`);
  });
  config.command("connection").argument("<id>").option("--name <name>").option("--template <id>")
    .option("--base-url <url>").option("--protocol <protocol>", "明确启用协议，可重复", collect, [])
    .option("--auth <kind>", "bearer | api-key | none").option("--api-key-header <name>")
    .option("--insecure-local-test", "显式仅允许回环 HTTP 测试", false)
    .action(async (id: string, opts) => {
      const { host } = await personalAiHost(deps);
      const { document } = await host.snapshot();
      const previous = document.connections.find(c => c.id === id);
      const catalog = await host.reloadCatalog();
      if (catalog.errors.length) throw new Error("AI 供应商模板不可读取或无效");
      const template = opts.template ? catalog.catalog.find(t => t.id === opts.template) : undefined;
      if (opts.template && !template) throw new Error("AI 供应商模板不存在");
      const base = template ? createAiConnectionFromTemplate(template, { id, name: opts.name ?? id }) : previous;
      const connection = AiConnectionSchema.safeParse({ ...base, id, name: opts.name ?? base?.name ?? id,
        revision: previous?.revision ?? 1, owner: { kind: "personal" },
        baseUrl: opts.baseUrl ?? base?.baseUrl, protocols: opts.protocol.length ? opts.protocol : base?.protocols,
        auth: opts.auth ? opts.auth === "api-key" ? { kind: opts.auth, header: opts.apiKeyHeader } : { kind: opts.auth } : base?.auth,
        insecureLocalTest: opts.insecureLocalTest || base?.insecureLocalTest,
      });
      if (!connection.success) throw new Error("AI 连接配置无效；协议和鉴权必须明确，HTTP 仅限显式回环测试");
      await host.saveConnection(connection.data, document.revision);
      deps.log(`已保存个人 AI 连接 ${id}`);
    });
  config.command("model").argument("<id>").requiredOption("--connection <id>").requiredOption("--model <id>")
    .requiredOption("--protocol <protocol>").requiredOption("--output-mode <mode>", "json-schema | json-object | prompt-json")
    .option("--budget <name=value>", "模型或用途预算字段，可重复", collect, [])
    .option("--purpose <purpose>", "仅修改此模型的指定用途预算")
    .option("--capability <name=value>", "显式声明能力字段，可重复", collect, [])
    .option("--confirm-capabilities", "明确确认所声明模型能力", false)
    .option("--no-streaming", "禁用流式响应").action(async (id: string, opts) => {
      const { repository } = await personalAiHost(deps);
      const document = await repository.read();
      const previous = document.models.find(m => m.id === id);
      const capability = AiModelCapabilitiesSchema.safeParse({ ...(previous?.capabilities ?? { status: "unconfirmed", source: "user-configuration" }),
        ...fields(opts.capability, true), ...(opts.confirmCapabilities ? { status: "confirmed", source: "user-confirmed" } : {}) });
      const budget = AiBudgetOverridesSchema.safeParse(fields(opts.budget));
      const purpose = opts.purpose ? AiPurposeSchema.safeParse(opts.purpose) : undefined;
      if (!capability.success || !budget.success || (purpose && !purpose.success)) throw new Error("AI 模型能力或预算字段无效");
      const budgets = { ...(previous?.budgets ?? createInitialAiModelBudgets(capability.data)), ...(purpose ? {} : budget.data) };
      const purposeBudgets = { ...previous?.purposeBudgets, ...(purpose?.success ? { [purpose.data]: { ...previous?.purposeBudgets[purpose.data], ...budget.data } } : {}) };
      const model = AiModelProfileSchema.safeParse({ ...previous, id, revision: (previous?.revision ?? 0) + 1,
        connectionId: opts.connection, modelId: opts.model, protocol: opts.protocol, structuredOutput: opts.outputMode,
        streaming: opts.streaming, capabilities: capability.data, budgets, purposeBudgets,
      });
      if (!model.success) throw new Error("AI 模型配置无效");
      document.models = previous ? document.models.map(m => m.id === id ? model.data : m) : [...document.models, model.data];
      await repository.write(document, document.revision);
      deps.log(`已保存个人 AI 模型配置 ${id}`);
    });
  config.command("bind").argument("<purpose>").argument("<modelProfileId>")
    .option("--project <projectPath>", "当前本地项目的个人用途偏好，仅写私有配置")
    .option("--budget <name=value>", "用途预算字段，可重复", collect, [])
    .action(async (purpose: string, modelProfileId: string, opts) => {
    const parsed = AiPurposeSchema.safeParse(purpose);
    if (!parsed.success) throw new Error("AI 用途无效");
    const { repository } = await personalAiHost(deps);
    const document = await repository.read();
    const budget = AiBudgetOverridesSchema.safeParse(fields(opts.budget));
    if (!budget.success) throw new Error("AI 用途预算无效");
    if (opts.project) {
      const root = deps.workspaceRoot(); if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const state = await loadWorkspace(deps.registry, root); assertWorkspaceUsable(state);
      const { project, group } = locateProject(state.workspace, opts.project);
      const projectKey = aiPersonalProjectKey({ kind: "local", root: realpathSync(root), workspaceId: state.workspace.id, groupId: group.id, projectId: project.id });
      const previous = document.projectOverrides.find(b => b.projectKey === projectKey && b.purpose === parsed.data);
      document.projectOverrides = [...document.projectOverrides.filter(b => !(b.projectKey === projectKey && b.purpose === parsed.data)), { projectKey, purpose: parsed.data, modelProfileId, budgets: { ...previous?.budgets, ...budget.data } }];
    } else {
      const previous = document.bindings.find(b => b.purpose === parsed.data);
      document.bindings = [...document.bindings.filter(b => b.purpose !== parsed.data), { purpose: parsed.data, modelProfileId, budgets: { ...previous?.budgets, ...budget.data } }];
    }
    await repository.write(document, document.revision);
    deps.log(`已绑定用途 ${purpose} → ${modelProfileId}`);
  });
  config.command("credential").argument("<connectionId>").option("--secret-env <name>", "秘密所在的环境变量名")
    .option("--secret-stdin", "从受控标准输入读取秘密", false).action(async (connectionId: string, opts) => {
      const controller = new AbortController(); const cancel = () => controller.abort();
      process.once("SIGINT", cancel); process.once("SIGTERM", cancel); deps.aiSignal?.addEventListener("abort", cancel, { once: true });
      if (deps.aiSignal?.aborted) cancel();
      try {
        const { host } = await personalAiHost(deps);
        const { document } = await host.snapshot();
        const value = await readAiSecret(opts, deps, controller.signal);
        if (controller.signal.aborted) throw new Error("AI 操作已取消");
        await host.setCredential(connectionId, value, "persistent", document.revision);
        deps.log("个人 AI 凭据已保存到宿主安全存储");
      } catch (error) {
        if (controller.signal.aborted) { deps.log("AI 操作已取消"); process.exitCode = 130; return; }
        throw error;
      } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); deps.aiSignal?.removeEventListener("abort", cancel); }
    });
  ai.command("reports").argument("<projectPath>").option("--online-profile <id>", "固定在线成员来源")
    .action(async (projectPath: string, opts) => {
    const root = deps.workspaceRoot(); if (!opts.onlineProfile && !root) throw new Error("未找到 apicc.workspace.yaml");
    const source = await createMcpSource(opts.onlineProfile ? { onlineProfile: opts.onlineProfile, ...deps } : { workspace: root!, registry: deps.registry });
    try {
    const captured = await captureProject(source, projectPath, deps.aiSignal ?? new AbortController().signal);
    const reports: import("../mcp/source.js").McpRun[] = []; let cursor: string | undefined;
    const diagnostics = new Map<string, number>();
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await source.listRuns(captured.read.projectId, { limit: 50, cursor }, deps.aiSignal ?? new AbortController().signal);
      reports.push(...page.items); for (const diagnostic of page.diagnostics ?? []) diagnostics.set(diagnostic.code, diagnostic.count);
      cursor = page.nextCursor; if (!cursor) break;
    }
    deps.log(`既有报告：${reports.length} 份（只读；通过 --report 选择 ID）`);
    deps.log("仅列出归属可靠且格式可读的当前项目报告；旧归属未知报告不可选择");
    if (diagnostics.size) deps.log(`受控归档来源级省略：不可读 ${diagnostics.get("unreadable") ?? 0} 份；归属不明 ${diagnostics.get("unattributable") ?? 0} 份（不归入当前项目；不展示文件名或路径）。`);
    for (const item of reports) deps.log(`${item.runId}；${item.startedAt ?? "开始时间未采集"} → ${item.finishedAt ?? "结束时间未采集"}；归档状态 ${({ archived: "已归档", expired: "已到期", none: "未归档", pending: "归档中" } as Record<string, string>)[String(item.reportState)] ?? item.reportState}；定义 ${item.definitionRevision ?? "未知"}`);
    if (cursor) deps.log("已达到 CLI 1000 份枚举上限，仍有报告未列出；请使用固定 MCP 连接分页读取，不能跨连接复用游标。");
    } finally { await source.close(); }
  });
  for (const [name, purpose] of [["suggest-cases", "case-suggestion"], ["suggest-assertions", "assertion-suggestion"], ["analyze-report", "report-analysis"]] as const) {
  const command = ai.command(name).argument(purpose === "report-analysis" ? "<projectPath>" : "<apiPath>").option("--instruction <text>").option("--limit <n>", "候选上限", Number)
    .option("--out <file>").option("--overwrite", "仅覆盖显式候选输出", false)
    .option("--model-profile <id>", "个人 AI 模型配置（非在线来源登录 profile）")
    .option("--online-profile <id>", "固定的在线成员来源 profile（与 --model-profile 分开）")
    .option("--secret-env <name>", "本次会话秘密环境变量名（须 --session-only）")
    .option("--secret-stdin", "本次会话从受控 stdin 读取秘密（须 --session-only）", false)
    .option("--session-only", "明确仅在本次进程内使用秘密", false)
    .option("--include-body <id>", "显式选取已投影的正文位置，可重复", collect, [])
    .option("--evidence <id>", "报告证据 ID，可重复以缩小选择并重新预览", collect, [])
    .option("--confirm-send", "确认此命令预览的固定来源与目标外发", false)
    .option("--insecure-local-test", "本次显式允许回环 HTTP 测试", false);
  if (purpose === "assertion-suggestion") command.requiredOption("--case <id>", "明确选择既有用例").requiredOption("--scope <scope>", "明确既有用例作用域")
    .option("--basis <kind>", "contract | observation", "contract").option("--report <id>", "已有受控报告 ID").option("--case-index <n>", "报告中准确用例行", Number);
  if (purpose === "report-analysis") command.requiredOption("--report <id>", "ai reports 中已有的 opaque 报告 ID");
  command.action(async (apiPath: string, opts) => {
      if (deps.aiSignal?.aborted) { deps.log("AI 操作已取消"); process.exitCode = 130; return; }
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 50)) throw new Error("limit 必须为正整数，范围 1–50");
      const root = deps.workspaceRoot();
      if (!opts.onlineProfile && !root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const source = await createMcpSource(opts.onlineProfile ? { onlineProfile: opts.onlineProfile, ...deps } : { workspace: root!, registry: deps.registry });
      try {
      const captured = await captureProject(source, apiPath, deps.aiSignal ?? new AbortController().signal);
      const location = purpose === "report-analysis" ? locateProject(captured.workspace, captured.path) : locateApi(captured.workspace, captured.path);
      const snapshot = captured.read.snapshot;
      const projectKey = captured.read.preferenceKey;
      const selectedConfiguration = await resolveCliAiInvocation(deps, { purpose, projectKey, modelProfileId: opts.modelProfile, insecureLocalTest: opts.insecureLocalTest });
      const { resolved, credentials } = selectedConfiguration;
      if (resolved.connection.networkProfileId) throw new Error("所选 AI 网络配置当前不支持；请明确配置直接连接，不能静默绕过");
      let request: AiBusinessRequest;
      let selectedReport: { reportId: string; revision: string } | undefined;
      if (purpose === "report-analysis") {
        const selected = await selectSourceReport(source, captured.read, opts.report, deps.aiSignal ?? new AbortController().signal);
        selectedReport = { reportId: selected.reportId, revision: selected.revision };
        request = { purpose, reportId: selected.reportId, report: selected.report, ...(opts.evidence.length ? { evidenceSelection: opts.evidence } : {}) };
      } else {
        const api = locateApi(captured.workspace, captured.path);
        const target = { collectionId: api.collection.id, folderIds: api.folderIds, apiId: api.api.contract.id };
        if (purpose === 'assertion-suggestion' && opts.basis === 'observation') {
          if (!opts.report || !Number.isInteger(opts.caseIndex) || opts.caseIndex < 0) throw new Error('观察依据须明确 --report 和非负整数 --case-index');
          const selected = await selectSourceReport(source, captured.read, opts.report, deps.aiSignal ?? new AbortController().signal);
          if (!('cases' in selected.report)) throw new Error('evidence-unavailable');
          selectedReport = { reportId: selected.reportId, revision: selected.revision };
          request = { purpose, target: { ...target, caseId: opts.case, scope: opts.scope }, basis: { kind: 'observation', reportId: selected.reportId, report: selected.report, caseIndex: opts.caseIndex } };
        } else {
          if (purpose === 'assertion-suggestion' && opts.basis !== 'contract') throw new Error('依据须为 contract 或 observation');
          request = purpose === "case-suggestion" ? { purpose, target } : { purpose, target: { ...target, caseId: opts.case, scope: opts.scope }, basis: { kind: "contract" } };
        }
      }
      const catalogRequest = request.purpose === 'report-analysis' ? { ...request, evidenceSelection: undefined } : request;
      const metadataInput = { ...catalogRequest, snapshot, context: snapshot.context, source: captured.read.binding };
      const defaultChoices = inspectAiContextChoices({ ...metadataInput, bodySelection: [] });
      if (opts.includeBody.some((location: string) => !defaultChoices.bodies.slice(0, 200).some(item => item.location === location))) throw new Error('body-selection-unavailable');
      const metadata = inspectAiContextChoices({ ...metadataInput, bodySelection: opts.includeBody });
      if (opts.evidence.some((id: string) => !metadata.evidence.slice(0, 1000).some(item => item.id === id))) throw new Error('evidence-selection-unavailable');
      deps.log(`证据共 ${metadata.evidence.length} 项，可选择 ${Math.min(metadata.evidence.length, 1000)} 项，目录省略 ${Math.max(0, metadata.evidence.length - 1000)} 项；正文共 ${metadata.bodies.length} 项，可选择 ${Math.min(metadata.bodies.length, 200)} 项，目录省略 ${Math.max(0, metadata.bodies.length - 200)} 项（默认关闭）；通过 --evidence / --include-body 明确选择后重新预览。`);
      for (const item of metadata.evidence.slice(0, 1000)) deps.log(`证据 ${item.id} · ${item.kind} · ${item.location} · ${aiLabel(item.state)}`);
      for (const item of metadata.bodies.slice(0, 200)) deps.log(`可选正文 ${item.location}（${opts.includeBody.includes(item.location) ? '已明确选择' : '未选择'}）`);
      if (metadata.evidence.length > 1000 || metadata.bodies.length > 200) deps.log('目录有省略：证据最多1000项，正文位置最多200项；原报告保留。');
      const preview = prepareAiContext({ ...request, snapshot, context: snapshot.context,
        source: captured.read.binding,
        bodySelection: opts.includeBody, maxContextBytes: resolved.budgets.maxInputBytes, candidateCount: resolved.budgets.candidateCount, limit: opts.limit, instruction: opts.instruction,
      });
      deps.log(renderAiPreview(preview, resolved));
      if (!opts.confirmSend) throw new Error("需明确 --confirm-send 确认外发范围");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      deps.aiSignal?.addEventListener("abort", cancel, { once: true });
      if (deps.aiSignal?.aborted) cancel();
      const secretMarkers: string[] = [];
      const recheckSource = async (signal: AbortSignal) => {
        const current = await source.readProject(captured.read.projectId, signal);
        if (!sameAiSourceBinding(captured.read.binding, current.binding)) throw new Error("AI source/来源已改变；请重新预览并确认");
        if (selectedReport) {
          const currentReport = await source.getReport(selectedReport.reportId, {}, signal);
          if (currentReport.revision !== selectedReport.revision) throw new Error("AI archive changed：报告内容已改变；请重新预览并确认");
        }
      };
      const host = createAiInvocationHost({ fetch: async (input, init) => {
        await recheckSource(init?.signal ?? controller.signal);
        return (deps.aiFetch ?? fetch)(input, init);
      }, credentials: { async resolve(connection) {
        const result = await credentials.resolve(connection);
        for (const value of Object.values(result.headers)) { secretMarkers.push(value); if (/^Bearer /i.test(value)) secretMarkers.push(value.slice(7)); }
        return result;
      } } });
      try {
        if (opts.secretEnv || opts.secretStdin) {
          if (!opts.sessionOnly) throw new Error("瞬时秘密必须明确 --session-only；持久保存请使用 ai config credential");
          const personal = selectedConfiguration.personal;
          if (!personal) throw new Error("瞬时个人秘密需要个人模型配置；不混用旧兼容来源");
          const value = await readAiSecret(opts, deps, controller.signal);
          const current = await personal.host.snapshot();
          await personal.host.setCredential(resolved.connection.id, value, "session-only", current.document.revision);
        }
        const result = await runAiAssistance(preview, resolved, host, { signal: controller.signal });
        await recheckSource(controller.signal);
        const text = renderAiResult(createOutputSanitizer(secretMarkers).redactValue(result));
        if (opts.out) { writeAiOutput(opts.out, text, opts.overwrite, root ?? undefined); deps.log(`AI 候选已独立写出 → ${opts.out}`); }
        else deps.log(text);
      } catch (error) {
        if (controller.signal.aborted) { deps.log("AI 操作已取消；未交付部分结果"); process.exitCode = 130; return; }
        if ((error as { code?: string }).code === "evidence-selection-too-large") throw new Error(`报告已选 ${preview.evidence.length} 项，配置上限 ${resolved.budgets.evidenceCount} 项；请缩小 --evidence <ID> 选择并重新预览/确认`);
        throw error;
      } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); deps.aiSignal?.removeEventListener("abort", cancel); }
      } finally { await source.close(); }
    });
  }
}
