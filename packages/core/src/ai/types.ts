import { z } from "zod";

import { AssertionSchema } from "../domain/model.js";

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

/**
 * AI 产出的用例草稿（D3：TestCase 同构子集 name/scope/parameters/assertions/postScript）。
 * strict：未知字段（含 AI 自带的 id——裁定④不信任 AI id）一律拒绝，进修复重试而非静默丢弃。
 */
export const AiCaseDraftSchema = z.object({
  name: z.string(),
  scope: z.string().default("base"),
  parameters: z.record(z.string(), z.string()).default({}),
  assertions: z.array(AssertionSchema).default([]),
  postScript: z.string().optional(),
}).strict();
export type AiCaseDraft = z.output<typeof AiCaseDraftSchema>;

/** 建议用例 = 草稿 + 本地 ULID id；整体可直接通过 TestCaseSchema 校验（并入接口前仍须人工审阅）。 */
export type AiSuggestedCase = AiCaseDraft & { id: string };

/** AI 输出信封的严格 schema：只接受 {"cases":[...]} 形状的 JSON 对象。 */
export const AiSuggestOutputSchema = z.object({ cases: z.array(AiCaseDraftSchema) }).strict();

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
