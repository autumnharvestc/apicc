import { z } from "zod";
import type { AiConnection, AiResolvedInvocation } from "./config.js";
import type { HttpErrorKind } from "../http/client.js";
export type { AiProtocol, AiPurpose, AiProviderTemplate, AiConnection, AiModelProfile, AiPurposeBinding, AiConfigDocument, AiBudgetOverrides, AiResolvedInvocation } from "./config.js";

import { AssertionSchema, OperationListSchema } from "../domain/common.js";
import { builtinAssertDescriptors } from "../assert/operators.js";
import type { AiContextPreview, AiEvidence } from "./context.js";
import type { AiAssertionCandidate } from "./assertions.js";
import type { AiCaseExplanation } from "./suggest.js";
import type { AiAnalysisDraft } from "./analysis.js";
export type { AiSourceBinding, AiSourceSummary, AiApiLocator, AiContextInput, AiContextPreview, AiEvidence, AiBusinessRequest, AiReadableReport } from "./context.js";

// M6-A core ai 模块契约面（规格 §2 D1/D3）。core 只认显式传入的 config，
// 配置解析（env/用户级文件）归宿主（CLI/桌面），密钥永不落工作区。

/** provider 配置（D1）。timeoutMs 缺省 60_000（裁定①）。 */
export interface AiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** 缺省超时（裁定①）。 */
export const DEFAULT_AI_TIMEOUT_MS = 60_000;

/** 建议用例条数缺省上限（裁定⑤）。 */
export const DEFAULT_SUGGEST_LIMIT = 5;

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** provider 抽象：输入对话消息，输出 assistant 回复文本（createAiProvider 的产物形态，测试可直接注入替身函数）。 */
export type AiProvider = (messages: AiChatMessage[]) => Promise<string>;

/** Trusted host only. audience binds these headers to the exact normalized connection base URL. */
export interface AiResolvedCredentials { audience: string; headers: Record<string, string> }
export interface AiCredentialResolver { resolve(connection: AiConnection): Promise<AiResolvedCredentials> }
export interface AiUsage { inputTokens?: number; outputTokens?: number }
export interface AiCallResult { text: string; terminal: "completed"; requestId?: string; usage?: AiUsage }
export interface AiProgress { phase: "queued" | "request" | "receiving" | "retrying" | "completed"; attempt: number; receivedBytes?: number }
export interface AiOperationInput { resolved: AiResolvedInvocation; signal: AbortSignal; onProgress?: (progress: AiProgress) => void }
export interface AiAttemptInput { messages: readonly AiChatMessage[]; outputSchema: unknown; kind: "initial" | "repair" }
export interface AiOperationSession { invoke(input: AiAttemptInput): Promise<AiCallResult> }
export interface AiInvocationHost { run<T>(input: AiOperationInput, work: (session: AiOperationSession) => Promise<T>): Promise<T> }

/** Stable safe errors never hold upstream body, prompt, credentials or an unsafe cause. */
export class AiInvocationError extends Error {
  readonly networkKind?: HttpErrorKind;
  constructor(readonly code: string, readonly status?: number, readonly requestId?: string, networkKind?: HttpErrorKind) {
    super(`AI 调用失败（${code}）${status === undefined ? "" : ` HTTP ${status}`}`);
    this.name = "AiInvocationError";
    this.networkKind = networkKind;
  }
}

/**
 * AI 产出的用例草稿（name/scope/parameters/operations/assertions）。
 * strict：未知字段（含 AI 自带的 id——裁定④不信任 AI id）一律拒绝，进修复重试而非静默丢弃。
 */
export const AiCaseDraftSchema = z.object({
  name: z.string(),
  scope: z.string().default("base"),
  parameters: z.record(z.string(), z.string()).default({}),
  preOperations: OperationListSchema,
  postOperations: OperationListSchema,
  assertions: z.array(AssertionSchema.refine(assertion => Object.hasOwn(builtinAssertDescriptors, assertion.op), "Unsupported AI assertion operator")).default([]),
}).strict();
export type AiCaseDraft = z.output<typeof AiCaseDraftSchema>;

/** 建议用例 = 草稿 + 本地 ULID id；整体可直接通过 TestCaseSchema 校验（并入接口前仍须人工审阅）。 */
export type AiSuggestedCase = AiCaseDraft & { id: string };

/** AI 输出信封的严格 schema：只接受 {"cases":[...]} 形状的 JSON 对象。 */
export const AiSuggestOutputSchema = z.object({ cases: z.array(AiCaseDraftSchema).max(50) }).strict();

/** 建议结果信封（宿主/桌面侧消费的人工审阅列表形态；suggestCases 本身返回 AiSuggestedCase[]）。 */
export type AiSuggestResult = { cases: AiSuggestedCase[] };

export interface AiSuggestOptions {
  /** AI provider（通常为 createAiProvider 产物；测试注入替身函数）。 */
  provider: AiProvider;
  /** 用户补充指令（可选）。 */
  instruction?: string;
  /** 返回条数上限，缺省 5（裁定⑤）。 */
  limit?: number;
}

// Native strict structured output: every object is closed and every field required.
// Dynamic maps use entries; JSON-valued options cross the wire as explicit JSON text.
export const AiWireStringEntriesSchema = z.array(z.object({ name: z.string(), value: z.string() }).strict());
export const AiWireAssertionSchema = z.object({
  target: z.enum(["status", "responseTime", "header", "bodyText", "bodyJson", "bodyXml", "cookie"]),
  op: z.string(), expected: z.string().nullable(), path: z.string().nullable(), headerName: z.string().nullable(),
  cookieName: z.string().nullable(), namespaces: AiWireStringEntriesSchema.nullable(),
  match: z.enum(["first", "all"]).nullable(), optionsJson: z.string().nullable(),
}).strict();
const wireOperation = z.object({ type: z.literal("script"), content: z.string() }).strict();
export const AiCaseWireOutputSchema = z.object({ cases: z.array(z.object({
  name: z.string(), scope: z.string(), parameters: AiWireStringEntriesSchema,
  preOperations: z.array(wireOperation), postOperations: z.array(wireOperation), assertions: z.array(AiWireAssertionSchema),
  reason: z.string(), evidenceIds: z.array(z.string()),
}).strict()).max(50) }).strict();
export const AiAssertionWireOutputSchema = z.object({ assertions: z.array(z.object({
  assertion: AiWireAssertionSchema, basis: z.enum(["contract", "observation"]), reason: z.string(),
  evidenceIds: z.array(z.string()).min(1), requiresUserJudgment: z.boolean(),
}).strict()) }).strict();

interface AiBusinessMetadata {
  source: AiContextPreview["source"];
  model: { profileId: string; modelId: string; connectionId: string };
  generatedAt: string;
  timeZone: "UTC";
  label: "AI 辅助";
  usage?: AiUsage;
}
export type AiAnalysisResult = Omit<AiAnalysisDraft, "observedFacts"> & { observedFacts: AiEvidence[] };
export type AiBusinessResult = AiBusinessMetadata & (
  | { purpose: "case-suggestion"; cases: AiSuggestedCase[]; explanations: AiCaseExplanation[] }
  | { purpose: "assertion-suggestion"; assertions: AiAssertionCandidate[]; evidence: readonly AiEvidence[] }
  | { purpose: "report-analysis"; analysis: AiAnalysisResult; evidence: readonly AiEvidence[]; evidenceSelection: NonNullable<AiContextPreview["evidenceSelection"]> }
);
