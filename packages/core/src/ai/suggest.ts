import { monotonicFactory } from "ulid";

import type { ApiDefinition } from "../domain/model.js";
import { buildSuggestMessages } from "./prompt.js";
import {
  AiSuggestOutputSchema,
  DEFAULT_SUGGEST_LIMIT,
  type AiCaseDraft,
  type AiSuggestedCase,
  type AiSuggestOptions,
} from "./types.js";

/** 建议用例文件名/落盘 ID：进程内单调递增 ULID（裁定④：不信任 AI 生成的 id）。 */
const nextCaseId = monotonicFactory();

const SNIPPET_MAX = 200;

/** 解析失败错误：携带两次尝试的问题摘要（裁定③：修复重试恰好一次，仍失败报错带原因）。 */
export class AiSuggestError extends Error {
  constructor(message: string, readonly attempts: string[]) {
    super(message);
    this.name = "AiSuggestError";
  }
}

interface ParseOutcome {
  ok: boolean;
  cases?: AiCaseDraft[];
  problems: string[];
}

/** 解析一次 provider 输出：JSON.parse + zod strict 校验；失败返回问题清单（不抛出，供修复重试使用）。 */
function parseOutput(content: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return { ok: false, problems: [`输出不是合法 JSON：${(e as Error)?.message ?? String(e)}`] };
  }
  const parsed = AiSuggestOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "<根对象>"}: ${i.message}`),
    };
  }
  return { ok: true, cases: parsed.data.cases, problems: [] };
}

function summarizeAttempt(stage: string, content: string, problems: string[]): string {
  return `${stage}：\n${problems.map((p) => `- ${p}`).join("\n")}\n原始输出片段：${content.slice(0, SNIPPET_MAX)}`;
}

function buildRepairMessage(problems: string[]): string {
  return [
    "你上一次的输出未通过校验，问题清单：",
    ...problems.map((p) => `- ${p}`),
    '请修正以上问题后重新输出；仍然只输出 JSON 对象 {"cases":[...]}，不要包含任何其他文本。',
  ].join("\n");
}

/**
 * AI 用例生成内核（D3）：prompt 构造 → provider 调用 → zod 严格解析 →
 * 失败携 issues 恰好一次修复重试（裁定③）→ 本地补 ULID id（裁定④）→ limit 截断（缺省 5，裁定⑤）。
 * AI 产出只作为候选用例返回，是否采用由人工决定，绝不静默落盘。
 */
export async function suggestCases(api: ApiDefinition, opts: AiSuggestOptions): Promise<AiSuggestedCase[]> {
  const limit = opts.limit ?? DEFAULT_SUGGEST_LIMIT;
  const baseMessages = buildSuggestMessages(api, { instruction: opts.instruction, limit });

  const firstContent = await opts.provider(baseMessages);
  let outcome = parseOutput(firstContent);

  if (!outcome.ok) {
    const attempts = [summarizeAttempt("第一次输出未通过校验", firstContent, outcome.problems)];
    // 修复重试恰好一次：回传原始输出 + 问题清单，重申输出格式。
    const retryMessages = [
      ...baseMessages,
      { role: "assistant" as const, content: firstContent },
      { role: "user" as const, content: buildRepairMessage(outcome.problems) },
    ];
    const secondContent = await opts.provider(retryMessages);
    outcome = parseOutput(secondContent);
    if (!outcome.ok) {
      attempts.push(summarizeAttempt("第二次输出仍未通过校验", secondContent, outcome.problems));
      throw new AiSuggestError(`AI 建议用例解析失败（已重试一次）：\n${attempts.join("\n")}`, attempts);
    }
  }

  return (outcome.cases ?? [])
    .slice(0, limit)
    .map((c) => ({ ...c, id: nextCaseId() }));
}
