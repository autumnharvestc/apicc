import type { ApiDefinition } from "../domain/model.js";

/** 渲染 agent 可消费的接口详细设计 Markdown（规格 §7.5）。 */
// 注：任务简报中测试断言要求 `POST {{baseUrl}}/orders` 连续出现，
// 故请求行合并为单行（测试意图优先于简报实现的分行渲染）。
export function renderDesignMarkdown(api: ApiDefinition): string {
  const schemaBlock = api.body?.kind === "json" ? `\n\`\`\`json\n${api.body.content}\n\`\`\`\n` : "";
  const caseRows = api.cases
    .map((c) => `| ${c.name} | ${c.scope} | ${c.assertions.length} 条断言 |`)
    .join("\n");
  return `# 接口详细设计：${api.name}

## 定义

- 请求行：**${api.method} ${api.url}**
- 版本：${api.version}${api.deprecated ? "（已废弃）" : ""}
- 请求头：${api.headers.map((h) => `${h.key}: ${h.value}`).join("；") || "无"}

## 请求体

${schemaBlock || "无"}

## 详细设计

${api.design ?? "（未编写，可补充业务规则、校验约定、错误码）"}

## 测试用例

| 用例 | 适用环境 | 断言 |
|------|----------|------|
${caseRows}
`;
}
