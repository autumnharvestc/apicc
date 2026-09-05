import type { Assertion } from "@apicc/core";

/**
 * AI 频道契约（M6-C 任务 1，规格 §2 D2/D4；两阶段执行的 fixture 自建——main 基线 core
 * 尚无 ai 模块，任务 2 同步 main 后与本契约合流）：
 * - AiSuggestedCase = TestCase 同构子集 name/scope/parameters/assertions/postScript；
 *   **不含 id**——不信任 AI 生成的 id（规格 §2 D3），用例与断言 id 均在采用时本地生成。
 * - 出口 AiKeyStatus 只含 hasKey（裁定②）：key 明文永不回传渲染层。
 * - AI_FIXTURE_SUGGESTIONS 为契约 fixture（D7：从规格构造），main IPC 桩与渲染层
 *   memory 替身共用同一份，防两侧漂移。
 */

/** 建议断言（同 core Assertion 去掉 id：断言 id 亦在采用时本地生成）。 */
export type AiSuggestedAssertion = Omit<Assertion, "id">;

export interface AiSuggestedCase {
  name: string;
  scope: string;
  parameters: Record<string, string>;
  assertions: AiSuggestedAssertion[];
  postScript?: string;
}

/** ai:save-config 入参：key 省略或空串 = 保持既有 key 不变（key 只进 main 安全存储）。 */
export interface AiSaveConfigInput { baseUrl: string; model: string; apiKey?: string }

/** ai:get-config / ai:save-config 出口：key 以 hasKey 表达，不回传明文（裁定②）。 */
export interface AiKeyStatus { hasKey: boolean }

/** ai:suggest 入参（fixture 阶段宽松：桩不消费 apiId；任务 2 切真实现时按 core 契约收紧）。 */
export interface AiSuggestInput { apiId: string }

/** 契约 fixture（固定两条建议）：形状与真实 provider 产物一致（含一条带 postScript）。 */
export const AI_FIXTURE_SUGGESTIONS: readonly AiSuggestedCase[] = [
  {
    name: "AI 建议-正常请求 200",
    scope: "base",
    parameters: {},
    assertions: [{ target: "status", op: "eq", expected: "200" }],
  },
  {
    name: "AI 建议-非法参数 400",
    scope: "base",
    parameters: {},
    assertions: [
      { target: "status", op: "eq", expected: "400" },
      { target: "bodyJson", op: "contains", path: "$.message", expected: "参数" },
    ],
    postScript: "console.log(\"AI 建议用例执行完毕\");",
  },
];
