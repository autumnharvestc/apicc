import { z } from "zod";

export const AiProtocolSchema = z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]);
export type AiProtocol = z.infer<typeof AiProtocolSchema>;
export const AiPurposeSchema = z.enum(["case-suggestion", "assertion-suggestion", "report-analysis"]);
export type AiPurpose = z.infer<typeof AiPurposeSchema>;
const id = z.string().trim().min(1).max(256);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const KiB = 1024, MiB = KiB * KiB;

/** Usage fields only; identity, protocol, capabilities and shared protection are separate. */
export const AiBudgetOverridesSchema = z.object({
  deadlineMs: integer(10000, 7200000).optional(), requestTimeoutMs: integer(10000, 3600000).optional(),
  maxRequests: integer(1, 10).optional(), transportRetries: integer(0, 9).optional(), repairAttempts: integer(0, 3).optional(),
  maxInputBytes: integer(4 * KiB, 4 * MiB).optional(), maxInstructionBytes: integer(KiB, 64 * KiB).optional(),
  maxOutputBytes: integer(64 * KiB, 32 * MiB).optional(), maxInputTokens: integer(1, Number.MAX_SAFE_INTEGER).optional(),
  maxOutputTokens: integer(16, Number.MAX_SAFE_INTEGER).optional(), totalOutputTokens: integer(16, Number.MAX_SAFE_INTEGER).optional(),
  candidateCount: integer(1, 50).optional(), evidenceCount: integer(1, 200).optional(),
  maxEventBytes: integer(16 * KiB, 4 * MiB).optional(), maxStreamBytes: integer(MiB, 512 * MiB).optional(),
}).strict();
export type AiBudgetOverrides = z.infer<typeof AiBudgetOverridesSchema>;
export type AiEffectiveBudgets = Required<Omit<AiBudgetOverrides, "maxInputTokens">> & { maxInputTokens?: number };
export const AiApplicationProtectionSchema = z.object({
  maxOutputTokens: integer(16, Number.MAX_SAFE_INTEGER), maxInputBytes: integer(4 * KiB, 4 * MiB),
  maxInstructionBytes: integer(KiB, 64 * KiB), maxOutputBytes: integer(64 * KiB, 32 * MiB),
  maxEventBytes: integer(16 * KiB, 4 * MiB), maxStreamBytes: integer(MiB, 512 * MiB),
  hostConcurrency: integer(1, 8), hostQueueSize: integer(0, 32), hostPayloadBufferBytes: integer(16 * MiB, 512 * MiB),
  connectionTestTimeoutMs: integer(1000, 180000), modelDiscoveryTimeoutMs: integer(1000, 120000),
}).strict();
export type AiApplicationProtection = z.infer<typeof AiApplicationProtectionSchema>;

const forbiddenHeader = /^(?:host|content-length|connection|transfer-encoding|upgrade|te|trailer|proxy-.*|authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(s => !forbiddenHeader.test(s), "受保护或秘密请求头");
export const AiAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bearer") }).strict(),
  z.object({ kind: z.literal("api-key"), header: z.string().regex(/^[A-Za-z0-9-]+$/).refine(s => !/^(host|content-length|connection|transfer-encoding|upgrade|te|trailer|cookie|set-cookie|proxy-.*)$/i.test(s), "传输头不能绑定秘密") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
const endpointFields = {
  baseUrl: z.string().url().transform(value => value.replace(/\/+$/, "")),
  insecureLocalTest: z.boolean().optional(), auth: AiAuthSchema,
  headers: z.record(headerName, z.string().refine(s => !/[\r\n]/.test(s), "请求头禁止换行")).default({}),
};
function endpointCheck(value: { baseUrl: string; insecureLocalTest?: boolean; auth: z.infer<typeof AiAuthSchema>; headers: Record<string, string> }, ctx: z.RefinementCtx) {
  if (value.auth.kind === "api-key") {
    const secretHeader = value.auth.header.toLowerCase();
    for (const header of Object.keys(value.headers)) {
      if (header.toLowerCase() === secretHeader) ctx.addIssue({ code: "custom", path: ["headers", header], message: "秘密鉴权头只能通过凭据引用提供，不能写入静态请求头" });
    }
  }
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { return; } // The URL schema supplies the field error.
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value.baseUrl)) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "URL 禁止用户信息、query 和 fragment" });
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && value.insecureLocalTest)) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "须使用 HTTPS；仅显式回环测试允许 HTTP" });
  if (value.auth.kind === "none" && !(loopback && value.insecureLocalTest)) ctx.addIssue({ code: "custom", path: ["auth"], message: "无鉴权仅供显式本地测试" });
}
export const AiProviderTemplateSchema = z.object({
  id, formatVersion: z.literal(1), revision: integer(1, Number.MAX_SAFE_INTEGER), name: id,
  ...endpointFields, protocols: z.array(AiProtocolSchema).min(1), defaultProtocol: AiProtocolSchema,
  modelDiscovery: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  endpointCheck(value, ctx);
  if (!value.protocols.includes(value.defaultProtocol)) ctx.addIssue({ code: "custom", path: ["defaultProtocol"], message: "默认协议必须已启用" });
});
export type AiProviderTemplate = z.infer<typeof AiProviderTemplateSchema>;
export const AiConnectionSchema = z.object({
  id, revision: integer(1, Number.MAX_SAFE_INTEGER), name: id, owner: z.object({ kind: z.literal("personal") }).strict(),
  templateSource: z.object({ id, revision: integer(1, Number.MAX_SAFE_INTEGER) }).strict().optional(),
  ...endpointFields, protocols: z.array(AiProtocolSchema).min(1), credentialRef: id.optional(), networkProfileId: id.optional(),
}).strict().superRefine(endpointCheck);
export type AiConnection = z.infer<typeof AiConnectionSchema>;
/** Stable identity shared by trusted credential storage and invocation hosts. */
export function aiCredentialAudience(connection: AiConnection): string {
  return JSON.stringify([1, connection.id, new URL(connection.baseUrl).href.replace(/\/+$/, ""), connection.auth.kind,
    connection.auth.kind === "api-key" ? connection.auth.header.toLowerCase() : ""]);
}
export const AiModelCapabilitiesSchema = z.object({
  status: z.enum(["confirmed", "unconfirmed"]), source: id,
  contextWindowTokens: integer(1, Number.MAX_SAFE_INTEGER).optional(), maxInputTokens: integer(1, Number.MAX_SAFE_INTEGER).optional(),
  maxOutputTokens: integer(1, Number.MAX_SAFE_INTEGER).optional(), sharedContextWindow: z.boolean().optional(), outputIncludesReasoning: z.boolean().optional(),
}).strict();
export type AiModelCapabilities = z.infer<typeof AiModelCapabilitiesSchema>;
/** Call only when creating a model; never reinitialize persisted budgets on edit or resolution. */
export function createInitialAiModelBudgets(capabilities: AiModelCapabilities): AiBudgetOverrides {
  return capabilities.outputIncludesReasoning === true ? { maxOutputTokens: 32768, totalOutputTokens: 98304 } : {};
}
const purposeBudgets = z.object({ "case-suggestion": AiBudgetOverridesSchema.optional(), "assertion-suggestion": AiBudgetOverridesSchema.optional(), "report-analysis": AiBudgetOverridesSchema.optional() }).strict();
export const AiModelProfileSchema = z.object({
  id, revision: integer(1, Number.MAX_SAFE_INTEGER), connectionId: id, modelId: id, protocol: AiProtocolSchema,
  structuredOutput: z.enum(["json-schema", "json-object", "prompt-json"]), streaming: z.boolean().default(true),
  chatCompletionTokenParameter: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  supportedParameters: z.array(z.enum(["temperature", "reasoning"])).default([]),
  capabilities: AiModelCapabilitiesSchema, budgets: AiBudgetOverridesSchema.default({}), purposeBudgets: purposeBudgets.default({}),
}).strict();
export type AiModelProfile = z.infer<typeof AiModelProfileSchema>;
export const AiPurposeBindingSchema = z.object({ purpose: AiPurposeSchema, modelProfileId: id, budgets: AiBudgetOverridesSchema.default({}) }).strict();
export type AiPurposeBinding = z.infer<typeof AiPurposeBindingSchema>;
export const AiConfigDocumentSchema = z.object({
  formatVersion: z.literal(1), revision: integer(1, Number.MAX_SAFE_INTEGER),
  application: z.object({ purposeDefaults: purposeBudgets, protection: AiApplicationProtectionSchema }).strict(),
  connections: z.array(AiConnectionSchema), models: z.array(AiModelProfileSchema), bindings: z.array(AiPurposeBindingSchema),
  projectOverrides: z.array(z.object({ projectKey: id, purpose: AiPurposeSchema, modelProfileId: id.optional(), budgets: AiBudgetOverridesSchema.default({}) }).strict()).default([]),
}).strict().superRefine((document, ctx) => {
  const issue = (path: (string | number)[]) => ctx.addIssue({ code: "custom", path, message: "ID 重复、引用缺失或协议不匹配" });
  const unique = (values: string[], path: string) => { if (new Set(values).size !== values.length) issue([path]); };
  unique(document.connections.map(c => c.id), "connections");
  unique(document.models.map(m => m.id), "models");
  unique(document.bindings.map(b => b.purpose), "bindings");
  unique(document.projectOverrides.map(p => JSON.stringify([p.projectKey, p.purpose])), "projectOverrides");
  document.models.forEach((model, index) => {
    const connection = document.connections.find(c => c.id === model.connectionId);
    if (!connection) issue(["models", index, "connectionId"]);
    else if (!connection.protocols.includes(model.protocol)) issue(["models", index, "protocol"]);
  });
  document.bindings.forEach((binding, index) => { if (!document.models.some(m => m.id === binding.modelProfileId)) issue(["bindings", index, "modelProfileId"]); });
  document.projectOverrides.forEach((binding, index) => { if (binding.modelProfileId && !document.models.some(m => m.id === binding.modelProfileId)) issue(["projectOverrides", index, "modelProfileId"]); });
});
export type AiConfigDocument = z.infer<typeof AiConfigDocumentSchema>;

/** Persisted defaults: total tokens are set once, never derived from request count during resolution. */
export function createDefaultAiConfigDocument(): AiConfigDocument {
  const defaults = (deadlineMs: number, maxOutputTokens: number, candidateCount: number): AiBudgetOverrides => ({
    deadlineMs, requestTimeoutMs: 300000, maxRequests: 3, transportRetries: 1, repairAttempts: 1,
    maxInputBytes: 256 * KiB, maxInstructionBytes: 8 * KiB, maxOutputBytes: 4 * MiB,
    maxOutputTokens, totalOutputTokens: maxOutputTokens * 3, candidateCount, evidenceCount: 20,
    maxEventBytes: 256 * KiB, maxStreamBytes: 64 * MiB,
  });
  return { formatVersion: 1, revision: 1, application: { purposeDefaults: {
    "case-suggestion": defaults(600000, 16384, 5), "assertion-suggestion": defaults(300000, 8192, 10), "report-analysis": defaults(900000, 16384, 5),
  }, protection: { maxOutputTokens: 262144, maxInputBytes: 4 * MiB, maxInstructionBytes: 64 * KiB, maxOutputBytes: 32 * MiB,
    maxEventBytes: 4 * MiB, maxStreamBytes: 512 * MiB, hostConcurrency: 1, hostQueueSize: 8, hostPayloadBufferBytes: 64 * MiB,
    connectionTestTimeoutMs: 30000, modelDiscoveryTimeoutMs: 15000,
  } }, connections: [], models: [], bindings: [], projectOverrides: [] };
}
export class AiConfigurationError extends Error {
  constructor(readonly code: string, readonly field: string, readonly source: string, readonly allowed?: number | string) {
    super(`AI 配置冲突：${field}（来源 ${source}）${allowed === undefined ? "" : `，允许 ${allowed}`}`);
    this.name = "AiConfigurationError";
  }
}
export type AiBudgetSource = { source: "application" | "model" | "purpose" | "project" | "invocation"; limitedBy?: "model"; explanation?: string };
export type AiCapabilityConfirmation = Record<Exclude<keyof AiModelCapabilities, "status" | "source">, "confirmed" | "unconfirmed">;
export interface AiResolveInput { document: AiConfigDocument; purpose: AiPurpose; modelProfileId?: string; projectKey?: string; overrides?: AiBudgetOverrides }
export interface AiResolvedInvocation {
  purpose: AiPurpose; connection: AiConnection; model: AiModelProfile; budgets: AiEffectiveBudgets;
  sources: Record<Exclude<keyof AiEffectiveBudgets, "maxInputTokens">, AiBudgetSource> & { maxInputTokens?: AiBudgetSource }; protection: AiApplicationProtection;
  capabilityStatus: "confirmed" | "unconfirmed"; capabilityConfirmation: AiCapabilityConfirmation; warnings: string[];
}
function parse<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const origin = source === "document" ? ({ models: "model", bindings: "purpose", projectOverrides: "project", application: "application" } as Record<string, string>)[String(issue.path[0])] ?? source : source;
    const allowed = issue.code === "too_big" ? `≤${issue.maximum}` : issue.code === "too_small" ? `≥${issue.minimum}` : undefined;
    throw new AiConfigurationError("invalid-configuration", String(issue.path.at(-1) ?? "configuration"), origin, allowed);
  }
  return result.data;
}
export function resolveAiInvocation(input: AiResolveInput): AiResolvedInvocation {
  const document = parse(AiConfigDocumentSchema, input.document, "document");
  const purpose = parse(AiPurposeSchema, input.purpose, "invocation");
  const override = parse(AiBudgetOverridesSchema, input.overrides ?? {}, "invocation");
  const binding = document.bindings.find(b => b.purpose === purpose);
  const project = document.projectOverrides.find(b => b.projectKey === input.projectKey && b.purpose === purpose);
  const model = document.models.find(m => m.id === (input.modelProfileId ?? project?.modelProfileId ?? binding?.modelProfileId));
  if (!model) throw new AiConfigurationError("missing-model", "modelProfileId", "purpose");
  const connection = document.connections.find(c => c.id === model.connectionId);
  if (!connection) throw new AiConfigurationError("missing-connection", "connectionId", "model");
  if (!connection.protocols.includes(model.protocol)) throw new AiConfigurationError("unsupported-protocol", "protocol", "model");
  const factoryDefaults = createDefaultAiConfigDocument().application.purposeDefaults[purpose]!;
  const application = { ...factoryDefaults, ...Object.fromEntries(Object.entries(document.application.purposeDefaults[purpose] ?? {}).filter(([, value]) => value !== undefined)) };
  const budgets = {} as AiEffectiveBudgets;
  const sources = {} as AiResolvedInvocation["sources"];
  const hasConfirmedInputCapacity = model.capabilities.status === "confirmed" && (
    model.capabilities.maxInputTokens !== undefined ||
    (model.capabilities.sharedContextWindow === true && model.capabilities.contextWindowTokens !== undefined)
  );
  const layers = [["application", application], ["model", model.budgets], ["model", model.purposeBudgets[purpose]], ["purpose", binding?.budgets], ["project", project?.budgets], ["invocation", override]] as const;
  for (const [source, layer] of layers) for (const [key, value] of Object.entries(layer ?? {})) {
    if (value === undefined) continue;
    if (!hasConfirmedInputCapacity && key === "maxInputBytes" && value > factoryDefaults.maxInputBytes!) throw new AiConfigurationError("capability-unconfirmed", key, source, factoryDefaults.maxInputBytes);
    if (!hasConfirmedInputCapacity && key === "maxInputTokens") throw new AiConfigurationError("capability-unconfirmed", key, source, "请补充已确认的独立输入上限或共享上下文窗口");
    // Invalid explicit declarations remain errors even when a later layer would conceal them.
    if (source !== "application" && model.capabilities.status === "confirmed" && (key === "maxOutputTokens" || key === "maxInputTokens")) {
      const allowed = model.capabilities[key];
      if (allowed !== undefined && value > allowed) throw new AiConfigurationError("budget-exceeded", key, source, allowed);
    }
    (budgets as Record<string, number>)[key] = value;
    sources[key as keyof AiEffectiveBudgets] = { source };
  }
  const protection = document.application.protection;
  const capabilityConfirmation = Object.fromEntries((["contextWindowTokens", "maxInputTokens", "maxOutputTokens", "sharedContextWindow", "outputIncludesReasoning"] as const).map(key => [key, model.capabilities.status === "confirmed" && model.capabilities[key] !== undefined ? "confirmed" : "unconfirmed"])) as AiCapabilityConfirmation;
  if (capabilityConfirmation.maxOutputTokens !== "confirmed" && budgets.maxOutputTokens > factoryDefaults.maxOutputTokens!) throw new AiConfigurationError("capability-unconfirmed", "maxOutputTokens", sources.maxOutputTokens.source, factoryDefaults.maxOutputTokens);
  for (const key of ["maxOutputTokens", "maxInputBytes", "maxInstructionBytes", "maxOutputBytes", "maxEventBytes", "maxStreamBytes"] as const) {
    if (budgets[key] > protection[key]) throw new AiConfigurationError("budget-exceeded", key, sources[key].source, protection[key]);
  }
  if (model.capabilities.status === "confirmed") {
    for (const key of ["maxOutputTokens", "maxInputTokens"] as const) {
      const allowed = model.capabilities[key], current = budgets[key];
      if (allowed === undefined || current === undefined || current <= allowed) continue;
      if (sources[key]?.source !== "application") throw new AiConfigurationError("budget-exceeded", key, sources[key]!.source, allowed);
      budgets[key] = allowed;
      sources[key] = { source: "application", limitedBy: "model", explanation: "继承应用默认，受模型限制" };
    }
    if (model.capabilities.sharedContextWindow === true && model.capabilities.contextWindowTokens !== undefined) {
      const window = model.capabilities.contextWindowTokens;
      const availableInput = window - budgets.maxOutputTokens;
      if (availableInput < 0) throw new AiConfigurationError("budget-exceeded", "maxOutputTokens", sources.maxOutputTokens.source, window);
      for (const [source, layer] of layers) {
        if (source !== "application" && layer?.maxInputTokens !== undefined && layer.maxInputTokens > availableInput) throw new AiConfigurationError("budget-exceeded", "maxInputTokens", source, availableInput);
      }
      if (budgets.maxInputTokens !== undefined && budgets.maxInputTokens > availableInput) {
        // Only a purely inherited application input default may be derived downwards.
        budgets.maxInputTokens = availableInput;
        sources.maxInputTokens = { source: "application", limitedBy: "model", explanation: "继承应用默认，受模型限制" };
      }
    }
  }
  if (budgets.totalOutputTokens < budgets.maxOutputTokens || budgets.totalOutputTokens > budgets.maxOutputTokens * 10) throw new AiConfigurationError("budget-exceeded", "totalOutputTokens", sources.totalOutputTokens.source, `${budgets.maxOutputTokens}–${budgets.maxOutputTokens * 10}`);
  return { purpose, connection, model, budgets, sources, protection, capabilityStatus: model.capabilities.status, capabilityConfirmation,
    warnings: budgets.maxRequests > 5 ? ["请求次数超过 5，可能增加费用和等待时间"] : [] };
}
