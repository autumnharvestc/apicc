import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import { redactCommonCredentialText } from "../import/schemaMapping.js";
import { contractAiView } from "./contractView.js";
import type { AiChatMessage } from "./types.js";

/**
 * 系统提示词（中文内置）：只输出候选 JSON；不接受或暴露凭据绑定。
 * 建议用例只描述正式 operations，是否采用始终由人工决定。
 */
export const AI_SUGGEST_SYSTEM_PROMPT = [
  "你是一名资深 API 测试工程师，负责基于完整项目快照中的接口契约设计高质量测试用例。",
  "",
  "输出要求（必须严格遵守）：",
  '1. 只输出一个 JSON 对象，形如 {"cases":[...]}；不要输出 Markdown 代码块、解释或其他文本。',
  "2. cases 数组元素字段 schema：",
  "   - name（必填字符串）；scope（可选字符串，缺省 base）；parameters（可选字符串键值对象）；",
  "   - preOperations、postOperations（可选数组），元素为 {id, type: \"script\", content}；",
  '   - assertions（可选数组），元素为 {"id", "target", "op", "expected"?, "headerName"?, "path"?}。',
  "3. 只生成新用例，避免与用户消息中列出的既有用例重复。",
  "4. 不要输出用例 id 字段；用例与断言 ID 由本地按现有规则补齐。",
].join("\n");

/** Assemble a redacted view from the supplied asset and its matching full-project snapshot context. */
export function buildSuggestMessages(
  asset: DeepReadonly<ApiAsset>,
  context: ProjectAssetContextReadView,
  opts: { instruction?: string; limit: number },
): AiChatMessage[] {
  const contract = contractAiView(asset, context);
  const userView = {
    contract,
    documentation: asset.documentation ? redactCommonCredentialText(asset.documentation) : "",
    existingCases: asset.cases.map(({ name, scope }) => ({ name, scope })),
  };
  const parts: string[] = [
    "以下接口、引用模型及既有用例均来自同一只读项目快照；认证值已脱敏：",
    JSON.stringify(userView, null, 2),
  ];
  if (opts.instruction) parts.push(`用户补充指令：${opts.instruction}`);
  parts.push(`请最多生成 ${opts.limit} 条新用例，只输出 JSON 对象 {"cases":[...]}。`);
  return [
    { role: "system", content: AI_SUGGEST_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}
