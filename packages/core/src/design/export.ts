import type { ApiDefinition } from "../domain/model.js";

/** 渲染 agent 可消费的接口详细设计 Markdown（规格 §7.5）。 */
// 注：任务简报中测试断言要求 `POST {{baseUrl}}/orders` 连续出现，
// 故请求行合并为单行（测试意图优先于简报实现的分行渲染）。
export function renderDesignMarkdown(api: ApiDefinition): string {
  const schemaBlock = api.body?.kind === "json" ? `\n\`\`\`json\n${api.body.content}\n\`\`\`\n` : "";
  const caseRows = api.cases
    .map((c) => `| ${c.name} | ${c.scope} | ${c.assertions.length} 条断言 |`)
    .join("\n");
  // M5 D5：非 HTTP 协议的最小适配——协议行 + 协议专属载荷说明（http 输出逐字节不变，既有测试零改动）。
  const protocolLine = api.protocol && api.protocol !== "http" ? `\n- 协议：**${api.protocol}**` : "";
  const wsBlock =
    api.protocol === "websocket" && api.message !== undefined
      ? `\n\n\`\`\`text\n${api.message}\n\`\`\`\n（WebSocket：连接后发送以上消息模板，首个文本帧作为响应体）`
      : "";
  const soapBlock =
    api.protocol === "soap"
      ? `\n\n\`\`\`xml\n${api.envelope ?? ""}\n\`\`\`\n（SOAP 1.1：以上信封作为请求体${api.soapAction ? `，SOAPAction: ${api.soapAction}` : ""}）`
      : "";
  return `# 接口详细设计：${api.name}

## 定义

- 请求行：**${api.method} ${api.url}**${protocolLine}${wsBlock}${soapBlock}
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
