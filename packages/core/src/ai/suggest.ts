import { monotonicFactory } from "ulid";

import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import type { AiContextPreview } from "./context.js";
import { decodeAiStringEntries, decodeAiWireAssertion, validateAiAssertions } from "./assertions.js";
import { buildSuggestMessages } from "./prompt.js";
import {
  AiSuggestOutputSchema,
  DEFAULT_SUGGEST_LIMIT,
  type AiCaseDraft,
  type AiSuggestedCase,
  type AiSuggestOptions,
  AiCaseWireOutputSchema,
} from "./types.js";

/** 建议用例文件名/落盘 ID：进程内单调递增 ULID（裁定④：不信任 AI 生成的 id）。 */
const nextCaseId = monotonicFactory();

export interface AiCaseExplanation { caseId: string; reason: string; evidenceIds: string[] }
export function parseAiCaseOutput(text: string, preview: AiContextPreview): { cases: AiSuggestedCase[]; explanations: AiCaseExplanation[] } {
  try {
    const wire = AiCaseWireOutputSchema.parse(JSON.parse(stripCodeFence(text)));
    if (wire.cases.length > (preview.limit ?? DEFAULT_SUGGEST_LIMIT)) throw new Error("case-output-invalid");
    const knownEvidence = new Set(preview.evidence.map(item => item.id));
    if (wire.cases.some(candidate => candidate.evidenceIds.some(id => !knownEvidence.has(id)))) throw new Error("case-output-invalid");
    const decoded = wire.cases.map(candidate => ({
      name: candidate.name, scope: candidate.scope, parameters: decodeAiStringEntries(candidate.parameters),
      preOperations: candidate.preOperations.map(operation => ({ ...operation, id: nextCaseId() })),
      postOperations: candidate.postOperations.map(operation => ({ ...operation, id: nextCaseId() })),
      assertions: candidate.assertions.map(decodeAiWireAssertion),
    }));
    const outcome = parseOutput(JSON.stringify({ cases: decoded }));
    if (!outcome.ok) throw new Error("case-output-invalid");
    for (const candidate of outcome.cases!) validateAiAssertions(candidate.assertions, preview);
    const cases = materializeSuggestedCases(outcome.cases!, outcome.cases!.length);
    return { cases, explanations: cases.map((candidate, index) => ({ caseId: candidate.id, reason: wire.cases[index]!.reason, evidenceIds: wire.cases[index]!.evidenceIds })) };
  } catch { throw new Error("case-output-invalid"); }
}

const SNIPPET_MAX = 200;

/**
 * 剥一层 markdown code fence（审查顺修①）：```json … ``` / ``` … ```。
 * json_object 模式外部分网关仍会包围栏；只剥一层（最外层），非围栏文本原样返回。
 */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const m = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

/**
 * assertion id 本地回填（审查顺修②，裁定④精神——不信任 AI id）：仅当元素缺 id 字段时
 * 补本地 ULID；解析阶段保留已给 id 以让 zod strict 拒绝数字等类型错误，
 * 最终候选在 materializeSuggestedCases 统一生成新身份。
 */
function backfillAssertionIds(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const envelope = raw as { cases?: unknown };
  if (!Array.isArray(envelope.cases)) return raw;
  return {
    ...envelope,
    cases: envelope.cases.map((c) => {
      if (c === null || typeof c !== "object" || !Array.isArray((c as { assertions?: unknown }).assertions)) return c;
      const draft = c as { assertions: unknown[] };
      return {
        ...draft,
        assertions: draft.assertions.map((a) =>
          a !== null && typeof a === "object" && !("id" in a) ? { ...(a as object), id: nextCaseId() } : a,
        ),
      };
    }),
  };
}

/** limit 缺省 5；显式值须为 1–50 的整数，在调用 provider 之前拒绝非法值。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SUGGEST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error(`limit 须为正整数，范围 1–50，收到 ${limit}`);
  }
  return limit;
}

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

/** 解析一次 provider 输出：剥围栏 → JSON.parse → assertion id 回填 → zod strict 校验；失败返回问题清单（不抛出，供修复重试使用）。 */
function parseOutput(content: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(content));
  } catch (e) {
    return { ok: false, problems: [`输出不是合法 JSON：${(e as Error)?.message ?? String(e)}`] };
  }
  const parsed = AiSuggestOutputSchema.safeParse(backfillAssertionIds(raw));
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

export function buildRepairMessage(problems: string[], format = '{"cases":[...]}'): string {
  return [
    "你上一次的输出未通过校验，问题清单：",
    ...problems.map((p) => `- ${p}`),
    `请修正以上问题后重新输出；仍然只输出 JSON 对象 ${format}，不要包含任何其他文本。`,
  ].join("\n");
}

/**
 * AI 用例生成内核（D3）：prompt 构造 → provider 调用 → zod 严格解析 →
 * 失败携 issues 恰好一次修复重试（裁定③）→ 本地补 ULID id（裁定④）→ limit 截断（缺省 5，裁定⑤）。
 * AI 产出只作为候选用例返回，是否采用由人工决定，绝不静默落盘。
 */
export async function suggestCases(
  asset: DeepReadonly<ApiAsset>,
  context: ProjectAssetContextReadView,
  opts: AiSuggestOptions,
): Promise<AiSuggestedCase[]> {
  const limit = normalizeLimit(opts.limit);
  const baseMessages = buildSuggestMessages(asset, context, { instruction: opts.instruction, limit });

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

  return materializeSuggestedCases(outcome.cases ?? [], limit);
}

function materializeSuggestedCases(drafts: AiCaseDraft[], limit: number): AiSuggestedCase[] {
  return drafts
    .slice(0, limit)
    .map((c) => ({
      ...c, id: nextCaseId(),
      assertions: c.assertions.map(assertion => ({ ...assertion, id: nextCaseId() })),
      preOperations: c.preOperations.map(operation => ({ ...operation, id: nextCaseId() })),
      postOperations: c.postOperations.map(operation => ({ ...operation, id: nextCaseId() })),
    }));
}
