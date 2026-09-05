import type { ApiDefinition } from "../domain/model.js";
import type { AiChatMessage } from "./types.js";

/**
 * 系统提示词（裁定⑥，中文内置）：结构要点——
 * ①角色：API 测试工程师；②只输出 JSON 对象 {"cases":[...]}；③避免与既有用例重复；
 * ④字段 schema 说明；⑤不输出 id（由本地补 ULID）。
 * 文本可打磨，结构要点保全。
 */
export const AI_SUGGEST_SYSTEM_PROMPT = [
  "你是一名资深 API 测试工程师，负责基于接口定义为 REST/HTTP 服务设计高质量的测试用例。",
  "",
  "输出要求（必须严格遵守）：",
  '1. 只输出一个 JSON 对象，形如 {"cases":[...]}；不要输出 Markdown 代码块、解释或任何其他文本。',
  "2. cases 数组元素字段 schema：",
  "   - name（必填，字符串）：用例名称，简明表达验证意图；",
  '   - scope（可选，字符串）：用例作用域，"base" 或环境名，缺省 "base"；',
  "   - parameters（可选，对象）：字符串键值对的参数表；",
  "   - assertions（可选，数组）：断言列表，元素为 {\"id\", \"target\", \"op\", \"expected\"?, \"headerName\"?, \"path\"?}；",
  "     其中 target ∈ status | header | bodyJson | responseTime，op ∈ eq | neq | contains | lt | gt | lte | gte，id 为你自拟的唯一字符串；",
  "   - postScript（可选，字符串）：响应后脚本（JavaScript）。",
  "3. 只生成新用例，避免与用户消息中列出的既有用例重复。",
  "4. 不要输出用例 id 字段——id 由系统在本地生成。",
].join("\n");

/** ApiDefinition 摘要（D3：name/protocol/method/url/headers/body(kind+content)/design/既有 cases 的 name+scope 清单）。 */
function summarizeApi(api: ApiDefinition): string {
  const lines: string[] = [];
  lines.push(`接口名称：${api.name}`);
  lines.push(`协议：${api.protocol ?? "http"}`);
  lines.push(`方法：${api.method}`);
  lines.push(`URL：${api.url}`);
  const headers = api.headers
    .filter((h) => h.enabled && h.key !== "")
    .map((h) => `- ${h.key}: ${h.value}`);
  if (headers.length > 0) lines.push(`请求头：\n${headers.join("\n")}`);
  if (api.body) {
    lines.push(`请求体：kind=${api.body.kind}`);
    if (api.body.content !== "") lines.push(`请求体内容：\n${api.body.content}`);
  }
  if (api.design) lines.push(`设计文档：\n${api.design}`);
  const existing = api.cases.map((c) => `- ${c.name}（scope=${c.scope}）`);
  if (existing.length > 0) lines.push(`既有用例清单（生成时避免与其重复）：\n${existing.join("\n")}`);
  return lines.join("\n");
}

/** 组装建议用例的对话消息：[系统提示词, 接口摘要 + 指令 + 条数上限]。 */
export function buildSuggestMessages(
  api: ApiDefinition,
  opts: { instruction?: string; limit: number },
): AiChatMessage[] {
  const parts: string[] = [summarizeApi(api)];
  if (opts.instruction) parts.push(`用户补充指令：${opts.instruction}`);
  parts.push(`请最多生成 ${opts.limit} 条新用例，只输出 JSON 对象 {"cases":[...]}。`);
  return [
    { role: "system", content: AI_SUGGEST_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}
