import { readerText, readerLanguageControl, readerLanguageScript, readerStyles } from "../report/readerPresentation.js";
import { z } from "zod";

import { DocumentDiagnosticSchema, type DocumentApi, type DocumentDiagnostic, type DocumentProjection } from "./projection.js";

export const RequestSnippetLanguageSchema = z.enum(["curl-posix", "powershell", "javascript-fetch"]);
export type RequestSnippetLanguage = z.infer<typeof RequestSnippetLanguageSchema>;

export const RequestSnippetResultSchema = z.object({
  code: z.string(),
  diagnostics: z.array(DocumentDiagnosticSchema),
}).strict();
export type RequestSnippetResult = z.infer<typeof RequestSnippetResultSchema>;

interface HeaderValue { name: string; value: string }
interface FormPart { name: string; value?: string; filename?: string; contentType?: string; variable?: string }
type BodyValue =
  | { kind: "none" }
  | { kind: "text"; value: string }
  | { kind: "multipart"; parts: FormPart[] }
  | { kind: "binary"; contentType: string; variable: string };

/** Render one sanitized projected API as a language-specific request template. */
export function generateRequestSnippet(api: DocumentApi, language: RequestSnippetLanguage): RequestSnippetResult {
  const diagnostics: DocumentDiagnostic[] = [];
  const request = api.request;
  if (request.protocol !== "http") {
    diagnostics.push(snippetDiagnostic("SNIPPET_PROTOCOL_UNSUPPORTED", "request.protocol", `${request.protocol.toUpperCase()} request snippets are not supported in this phase.`, api.contractId));
    return result("", diagnostics);
  }

  if (!request.baseUrl.trim()) {
    diagnostics.push(snippetDiagnostic("SNIPPET_BASE_URL_MISSING", "request.baseUrl", "A base URL is required to generate an HTTP request snippet.", api.contractId));
    return result("", diagnostics);
  }

  let path = request.path;
  for (const parameter of request.pathParams) {
    if (parameter.kind === "unresolved") {
      diagnostics.push(snippetDiagnostic("SNIPPET_PARAMETER_UNRESOLVED", "request.pathParams", "A path parameter reference is unresolved.", api.contractId));
      continue;
    }
    if (!parameter.enabled) continue;
    const placeholder = variablePlaceholder(parameter.name);
    const hasValue = parameter.value !== undefined && parameter.value !== "****";
    const pattern = new RegExp(`\\{\\{?${escapeRegExp(parameter.name)}\\}\\}?`, "g");
    if (!pattern.test(path)) {
      diagnostics.push(snippetDiagnostic("SNIPPET_PATH_PARAMETER_UNUSED", "request.path", `Path parameter ${parameter.name} has no matching path placeholder.`, api.contractId, "warning"));
      continue;
    }
    pattern.lastIndex = 0;
    path = path.replace(pattern, () => {
      if (!hasValue) {
        diagnostics.push(snippetDiagnostic("SNIPPET_VALUE_PLACEHOLDER", `request.pathParams.${parameter.name}`, `Replace the ${parameter.name} path placeholder before sending.`, api.contractId, "warning"));
        return placeholder;
      }
      const value = parameter.value!;
      return isVariable(value) ? value : encodeComponent(value);
    });
  }
  path = path.replace(/(^|[^{}])\{([^{}]+)\}(?!\})/g, (_match, prefix: string, name: string) => {
    diagnostics.push(snippetDiagnostic("SNIPPET_PATH_PARAMETER_UNRESOLVED", "request.path", `Path placeholder ${name} has no matching parameter definition.`, api.contractId, "warning"));
    return `${prefix}${variablePlaceholder(name)}`;
  });

  const query: Array<{ name: string; value: string }> = [];
  for (const parameter of request.query) {
    if (parameter.kind === "unresolved") {
      diagnostics.push(snippetDiagnostic("SNIPPET_PARAMETER_UNRESOLVED", "request.query", "A query parameter reference is unresolved.", api.contractId));
      continue;
    }
    if (!parameter.enabled) continue;
    query.push({ name: parameter.name, value: publicParameterValue(parameter.name, parameter.value, diagnostics, api.contractId, "request.query") });
  }

  const headers: HeaderValue[] = [];
  for (const parameter of request.headers) {
    if (parameter.kind === "unresolved") {
      diagnostics.push(snippetDiagnostic("SNIPPET_PARAMETER_UNRESOLVED", "request.headers", "A header parameter reference is unresolved.", api.contractId));
      continue;
    }
    if (!parameter.enabled) continue;
    if (!isValidHeaderName(parameter.name)) {
      diagnostics.push(snippetDiagnostic("SNIPPET_HEADER_NAME_INVALID", "request.headers", "A header name cannot be represented as a valid HTTP token.", api.contractId));
      continue;
    }
    const value = publicParameterValue(parameter.name, parameter.value, diagnostics, api.contractId, "request.headers");
    if (!isValidHeaderValue(value)) {
      diagnostics.push(snippetDiagnostic("SNIPPET_HEADER_VALUE_INVALID", "request.headers", "Header values cannot contain control characters.", api.contractId));
      continue;
    }
    headers.push({ name: parameter.name, value });
  }

  switch (request.auth.kind) {
    case "none":
      break;
    case "bearer":
      headers.push({ name: "Authorization", value: "Bearer {{BEARER_TOKEN}}" });
      break;
    case "basic":
      headers.push({ name: "Authorization", value: "Basic {{BASIC_AUTH_BASE64}}" });
      break;
    case "apikey":
      if (request.auth.placement === "query") query.push({ name: request.auth.name, value: "{{API_KEY}}" });
      else headers.push({ name: request.auth.name, value: "{{API_KEY}}" });
      break;
    case "unresolved":
      diagnostics.push(snippetDiagnostic("SNIPPET_AUTH_UNRESOLVED", "request.auth", "The authentication component is unresolved.", api.contractId));
      break;
  }

  const enabledCookies: string[] = [];
  for (const parameter of request.cookies) {
    if (parameter.kind === "unresolved") {
      diagnostics.push(snippetDiagnostic("SNIPPET_PARAMETER_UNRESOLVED", "request.cookies", "A cookie parameter reference is unresolved.", api.contractId));
      continue;
    }
    if (!parameter.enabled) continue;
    enabledCookies.push(`${parameter.name}=${publicParameterValue(parameter.name, parameter.value, diagnostics, api.contractId, "request.cookies")}`);
  }
  if (enabledCookies.length > 0) headers.push({ name: "Cookie", value: enabledCookies.join("; ") });

  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const header = headers[index]!;
    if (!isValidHeaderName(header.name)) {
      diagnostics.push(snippetDiagnostic("SNIPPET_HEADER_NAME_INVALID", "request.headers", "A header name cannot be represented as a valid HTTP token.", api.contractId));
      headers.splice(index, 1);
    } else if (!isValidHeaderValue(header.value)) {
      diagnostics.push(snippetDiagnostic("SNIPPET_HEADER_VALUE_INVALID", "request.headers", "Header values cannot contain control characters.", api.contractId));
      headers.splice(index, 1);
    }
  }

  const body = buildBody(request.body, diagnostics, api.contractId);
  const hasContentType = headers.some((header) => header.name.toLowerCase() === "content-type");
  if (!hasContentType && body.kind !== "none" && body.kind !== "multipart") {
    const contentType = inferredContentType(request.body);
    if (contentType) headers.push({ name: "Content-Type", value: contentType });
  }

  if (language === "javascript-fetch" && body.kind !== "none" && (request.method === "GET" || request.method === "HEAD")) {
    diagnostics.push(snippetDiagnostic("SNIPPET_FETCH_BODY_UNSUPPORTED", "request.body", `Fetch cannot send a ${request.method} request body.`, api.contractId));
  }
  if (language === "powershell" && body.kind === "multipart" && hasDuplicateNames(body.parts)) {
    diagnostics.push(snippetDiagnostic("SNIPPET_MULTIPART_DUPLICATE_UNSUPPORTED", "request.body.entries", "PowerShell form snippets cannot preserve duplicate multipart field names.", api.contractId));
  }
  if (language === "powershell" && hasDuplicateHeaders(headers)) {
    diagnostics.push(snippetDiagnostic("SNIPPET_POWERSHELL_DUPLICATE_HEADER", "request.headers", "PowerShell header hashtables cannot preserve duplicate header names (case-insensitively).", api.contractId));
  }
  if (language === "curl-posix" && body.kind === "multipart" && body.parts.some((part) =>
    !isCurlFormMetadataRepresentable(part.name)
    || (part.variable && (!isCurlFormMetadataRepresentable(part.filename ?? "upload.bin")
      || !isCurlFormMetadataRepresentable(part.contentType ?? ""))))) {
    diagnostics.push(snippetDiagnostic("SNIPPET_CURL_MULTIPART_METADATA_UNSUPPORTED", "request.body.entries", "A multipart field name, filename, or content type contains cURL form syntax that cannot be safely represented.", api.contractId));
  }
  if (body.kind === "multipart" && body.parts.some((part) => part.variable && part.contentType && !isValidMediaType(part.contentType))) {
    diagnostics.push(snippetDiagnostic("SNIPPET_MULTIPART_CONTENT_TYPE_INVALID", "request.body.entries", "A multipart file content type must be a valid media type.", api.contractId));
  }
  if (language === "javascript-fetch" && body.kind === "multipart" && hasContentType) {
    diagnostics.push(snippetDiagnostic("SNIPPET_FETCH_MULTIPART_CONTENT_TYPE_UNSUPPORTED", "request.headers", "Fetch generates the multipart boundary; remove the explicit Content-Type header so its boundary matches the body.", api.contractId));
  }

  const error = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const url = appendQuery(buildUrl(request.baseUrl, path), query);
  return result(error ? "" : serializeRequest(request.method, url, headers, body, language), diagnostics);
}

/** Render a readable Markdown document from the same sanitized DTO used by preview/snippets. */
export function renderDocumentMarkdown(projection: DocumentProjection): string {
  const sections = [`# ${escapeMarkdown(projection.project.name)}`];
  for (const api of projection.apis) sections.push(renderApiMarkdown(api));
  if (projection.diagnostics.length > 0) sections.push(renderDiagnostics("Document diagnostics", projection.diagnostics));
  return sections.join("\n\n");
}

/** Render the sanitized projection as one offline HTML document. User content is escaped text; the script below is fixed code. */
// Only explicitly marked presentation fields use this dictionary.
const documentLabels: Record<string, string> = {"Contents": "目录", "Search API name, method, path or tag": "搜索接口名、方法、路径或标签", "Offline API documentation": "离线 API 文档", "Document diagnostics": "文档诊断", "Field": "字段", "Value": "值", "Collection": "模块", "Folders": "目录", "Version": "版本", "Lifecycle": "生命周期", "Tags": "标签", "Protocol": "协议", "Base URL": "基础地址", "Path": "路径", "Description": "说明", "Authentication": "认证", "Path parameters": "路径参数", "Query parameters": "查询参数", "Headers": "请求头", "Cookies": "Cookie", "Name": "名称", "Required": "必填", "Enabled": "启用", "Schema": "数据结构", "Responses": "响应", "Unresolved response": "未解析响应", "Missing response component": "缺少响应组件", "Response header": "响应头", "Example": "示例", "Missing example": "缺少示例", "Models": "模型", "Missing model": "缺少模型", "References": "引用", "Reusable components": "可复用组件", "Kind": "类型", "Definition": "定义", "Documentation": "文档说明", "Test cases": "测试用例", "Scope": "范围", "Assertions": "断言数", "Definition diagnostics": "定义诊断", "Severity": "级别", "Issue": "问题", "Request": "请求", "Body": "正文", "Not available.": "不可用。", "No body.": "无正文。", "Operation name": "操作名称", "Text": "文本", "File": "文件", "Replace with a user-supplied file": "请替换为用户提供的文件", "Binary file": "二进制文件", "Use a user-supplied file.": "请使用用户提供的文件。", "Value / file": "值 / 文件", "Content type": "内容类型", "Yes": "是", "No": "否", "JSON schema": "JSON 数据结构", "Response schema": "响应数据结构", "Model schema": "模型数据结构", "Body schema": "正文数据结构", "Missing component": "缺少组件", "draft": "草稿", "published": "已发布", "deprecated": "已弃用", "parameter": "参数", "response": "响应", "example": "示例", "auth": "认证", "base": "基础", "env": "环境", "error": "错误", "warning": "警告", "info": "提示", "SOAP envelope": "SOAP 信封", "WebSocket message": "WebSocket 消息", "GraphQL query": "GraphQL 查询", "GraphQL variables": "GraphQL 变量"};
function labelHtml(en: string): string { return Object.hasOwn(documentLabels, en) ? readerText(documentLabels[en]!, en) : htmlEscape(en); }
function isRawDefinition(value: unknown): value is {readerRaw: string} { return !!value && typeof value === 'object' && Object.hasOwn(value, 'readerRaw') && typeof (value as {readerRaw?: unknown}).readerRaw === 'string'; }
const L = (readerLabel: string) => ({ readerLabel });
function isLabel(value: unknown): value is {readerLabel: string} { return !!value && typeof value === 'object' && 'readerLabel' in value && typeof value.readerLabel === 'string'; }
function renderAuthHtml(auth: DocumentApi['request']['auth']): string {
  switch(auth.kind) {
    case 'none': return readerText('无认证','None');
    case 'bearer': return readerText('Bearer（令牌占位符）','Bearer (token placeholder)');
    case 'basic': return readerText('Basic（用户名/密码占位符）','Basic (username/password placeholders)');
    case 'apikey': return `${readerText('API 密钥','API key')} ${htmlEscape(auth.placement)} · ${htmlEscape(auth.name)} (${readerText('值占位符','value placeholder')})`;
    case 'unresolved': return `${readerText('未解析认证组件','Unresolved auth component')}: ${htmlEscape(auth.componentId)}`;
  }
}

export function renderDocumentHtml(projection: DocumentProjection): string {
  const contents = projection.apis.map((api) => `<li data-api-target="${htmlEscape(apiAnchor(api.contractId))}"><a href="#${htmlEscape(apiAnchor(api.contractId))}">${htmlEscape(api.metadata.name)} <span>${htmlEscape(api.request.protocol === "http" || api.request.protocol === "soap" ? api.request.method : api.request.protocol.toUpperCase())} ${htmlEscape(api.request.path)}</span></a></li>`).join("\n");
  const apis = projection.apis.map(renderApiHtml).join("\n");
  const diagnostics = projection.diagnostics.length > 0
    ? `<section class="diagnostics"><h2>${labelHtml("Document diagnostics")}</h2>${htmlTable(["Severity", "Path", "Issue"], projection.diagnostics.map((diagnostic) => [L(diagnostic.severity), diagnostic.path || "—", diagnostic.message]))}</section>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(projection.project.name)} · API 文档</title>
<style>
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif;--line:#8885;--panel:#8881;--link:#3984d6}*{box-sizing:border-box}body{max-width:1500px;margin:0 auto;padding:24px;overflow-wrap:anywhere;display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px}a{color:var(--link)}header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:24px}nav,section.api,section.diagnostics{border:1px solid var(--line);border-radius:8px;padding:16px;margin:18px 0}nav ul{padding-left:22px}nav li{margin:4px 0}nav li span{opacity:.75;display:block}input[type=search]{width:min(100%,520px);padding:9px 12px;font:inherit}table{border-collapse:collapse;width:100%;margin:10px 0 18px}th,td{text-align:left;vertical-align:top;border:1px solid var(--line);padding:7px 9px}th{background:var(--panel)}.plain-text{white-space:pre-wrap;margin:8px 0 14px}.code-sample{position:relative;margin:12px 0 18px}.code-sample button{float:right}.code-sample pre{clear:both;overflow:auto;background:var(--panel);padding:12px;border-radius:5px;white-space:pre}.api-heading{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.api-heading .route{font-family:ui-monospace,monospace;opacity:.8}.muted{opacity:.75}.model{border-top:1px solid var(--line);padding-top:8px;margin-top:14px}pre{overflow:auto} [hidden]{display:none!important}
.document-sidebar{min-width:0;position:sticky;top:24px;align-self:start;display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);background:Canvas}.document-controls{flex:none}.document-controls label{display:block}.document-controls input{display:block;margin-top:8px}#search-summary{margin:8px 0 0}main{min-width:0}#document-contents{min-height:0;margin:0;overflow:auto;overflow-wrap:anywhere}#document-contents h2{margin-top:0}#contents-toggle{display:none;font:inherit;padding:9px 12px;max-width:100%;white-space:normal;overflow-wrap:anywhere}
@media(max-width:800px){html{scroll-padding-top:calc(var(--document-sidebar-height,14rem) + 16px)}body{display:block;padding:16px}.document-sidebar{top:0;z-index:1;padding:12px 0;margin-bottom:16px;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px)}#contents-toggle{display:inline-block;margin-top:12px}#document-contents{display:none;max-height:min(30vh,16rem);max-height:min(30dvh,16rem)}#document-contents.is-open{display:block}}
${readerStyles}
:root{color-scheme:light dark;--line:#d7e1ed;--panel:#edf2f9}body{max-width:1600px;gap:24px}.document-sidebar{padding:16px;border:1px solid var(--line);border-radius:10px;background:white}.document-controls select{display:block;margin:4px 0 12px}#document-contents{border:0;padding:8px 0}#document-contents ul{list-style:none;padding:0;margin:0}#document-contents a{display:block;padding:8px;border-radius:6px;text-decoration:none}#document-contents a:hover{background:#edf3fc}#document-contents h2{font-size:16px}header{padding:8px 0 16px;margin-bottom:16px}section.api,section.diagnostics{background:white;border-radius:10px;padding:20px;box-shadow:0 2px 8px #20345405}section.api{scroll-margin-top:16px}section.api h2{margin:0}.table-scroll{overflow:auto;max-height:28rem;margin:10px 0 18px}table{margin:0}th,td{min-width:7rem;max-width:34rem;overflow-wrap:anywhere}th{position:sticky;top:0;z-index:1}pre{max-height:28rem}label{font-weight:600}#search-summary{font-size:13px;color:#52647c}@media(max-width:800px){.document-sidebar{border-radius:8px;padding:10px 12px}.document-controls select{display:inline-block;margin:0 8px 6px}section.api,section.diagnostics{padding:14px}}
@media(prefers-color-scheme:dark){:root{color:#dce7f6;background:#131d2d;--line:#35445a;--panel:#26354a;--link:#8ebaff}.document-sidebar,section.api,section.diagnostics{background:#1a283c}a{color:#8ebaff}button,input:not([type=checkbox]):not([type=radio]),select{background:#203049;color:#e4edfa;border-color:var(--line)}button:hover,#document-contents a:hover{background:#29415d}#search-summary{color:#b0c3dc}}
.document-sidebar{z-index:5}@media(max-width:800px){.document-controls>label[for=reader-language]{display:inline-block;margin-right:8px}}@media(max-height:500px){.document-sidebar{padding:8px 12px;gap:6px}.document-controls label{font-size:12px}.document-controls input[type=search]{padding:5px 8px;margin-top:4px}.document-controls select{padding:4px 8px;margin-bottom:4px}#search-summary{margin-top:4px}#contents-toggle{padding:4px 10px;margin-top:6px}}
</style>
</head>
<body>
<aside id="document-sidebar" class="document-sidebar"><div class="document-controls">${readerLanguageControl}<label for="document-search">${labelHtml("Search API name, method, path or tag")}</label><input id="document-search" type="search" autocomplete="off"><p id="search-summary" aria-live="polite">显示 ${projection.apis.length} / ${projection.apis.length} 个接口</p><button id="contents-toggle" type="button" aria-controls="document-contents" aria-expanded="false">${labelHtml("Contents")}</button></div><nav id="document-contents" aria-label="目录" data-reader-aria-zh="目录" data-reader-aria-en="Contents"><h2>${labelHtml("Contents")}</h2><ul>${contents}</ul></nav></aside>
<main>
<header><h1>${htmlEscape(projection.project.name)}</h1><p class="muted">${labelHtml("Offline API documentation")}</p></header>
${apis}
${diagnostics}
</main>
<script>
(() => {
  const search = document.getElementById("document-search");
  const summary = document.getElementById("search-summary");
  const apiSections = Array.from(document.querySelectorAll("[data-search]"));
  const contents = document.getElementById("document-contents");
  const contentsToggle = document.getElementById("contents-toggle");
  const contentsEntries = Array.from(document.querySelectorAll("[data-api-target]"));
  const sidebar = document.getElementById("document-sidebar");
  const updateSidebarHeight = () => document.documentElement.style.setProperty("--document-sidebar-height", sidebar.getBoundingClientRect().height + "px");
  contentsToggle.addEventListener("click", () => {
    const expanded = contentsToggle.getAttribute("aria-expanded") !== "true";
    contentsToggle.setAttribute("aria-expanded", String(expanded));
    contents.classList.toggle("is-open", expanded);
    updateSidebarHeight();
  });
  const filter = (resetScroll = true) => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const section of apiSections) {
      const match = query === "" || section.dataset.search.toLocaleLowerCase().includes(query);
      section.hidden = !match;
      if (match) visible += 1;
    }
    for (const entry of contentsEntries) entry.hidden = document.getElementById(entry.dataset.apiTarget).hidden;
    summary.textContent = document.documentElement.lang === "en" ? "Showing " + visible + " of " + apiSections.length + " APIs" : "显示 " + visible + " / " + apiSections.length + " 个接口";
    contents.scrollTop = 0;
    updateSidebarHeight();
    if (resetScroll) window.scrollTo({ top: 0, behavior: "instant" });
  };
  search.addEventListener("input", () => filter());
  window.addEventListener("reader-language-change", () => filter(false));
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-button]");
    if (!button) return;
    const code = button.closest(".code-sample").querySelector("code").textContent;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(code);
      else {
        const area = document.createElement("textarea");
        area.value = code;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      button.dataset.readerZh = "已复制"; button.dataset.readerEn = "Copied";
      button.textContent = document.documentElement.lang === "en" ? "Copied" : "已复制";
    } catch {
      button.dataset.readerZh = "复制失败"; button.dataset.readerEn = "Copy failed";
      button.textContent = document.documentElement.lang === "en" ? "Copy failed" : "复制失败";
    }
  });
  updateSidebarHeight();
  window.addEventListener("resize", updateSidebarHeight);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateSidebarHeight).observe(sidebar);
})();
</script>
${readerLanguageScript}
</body>
</html>`;
}

function renderApiHtml(api: DocumentApi): string {
  const request = api.request;
  const method = request.protocol === "http" || request.protocol === "soap" ? request.method : request.protocol.toUpperCase();
  const searchText = [api.metadata.name, method, request.path, ...api.metadata.tags].join(" ");
  const apiTitle = `<div class="api-heading"><h2>${htmlEscape(api.metadata.name)}</h2><span class="route">${htmlEscape(method)} ${htmlEscape(request.path)}</span></div>`;
  const metadata = htmlTable(["Field", "Value"], [
    ["Collection", api.collection.name],
    ["Folders", api.folders.map((folder) => folder.name).join(" / ") || "—"],
    ["Version", api.metadata.version],
    ["Lifecycle", api.metadata.status],
    ["Tags", api.metadata.tags.join(", ") || "—"],
    ["Protocol", request.protocol.toUpperCase()],
    ["Base URL", request.baseUrl],
    ["Path", request.path],
  ].map((row, index) => [L(row[0]!), index === 3 ? L(row[1]!) : row[1]]));
  const description = api.metadata.description ? `<h3>${labelHtml("Description")}</h3>${htmlPlainText(api.metadata.description)}` : "";
  const auth = `<p><strong>${labelHtml("Authentication")}:</strong> ${renderAuthHtml(request.auth)}</p>`;
  const parameterGroups = [
    ["Path parameters", request.pathParams],
    ["Query parameters", request.query],
    ["Headers", request.headers],
    ["Cookies", request.cookies],
  ] as const;
  const parameters = parameterGroups.filter(([, values]) => values.length > 0).map(([label, values]) => {
    const rows = values.map((parameter) => parameter.kind === "unresolved"
      ? [L("Missing component"), parameter.componentId, "—", "—", "—"]
      : [parameter.name, parameter.value ?? "—", L(yesNo(parameter.required)), L(yesNo(parameter.enabled)), parameter.description]);
    return `<h4>${labelHtml(label)}</h4>${htmlTable(["Name", "Value", "Required", "Enabled", "Description"], rows)}${values.map((parameter) => parameter.kind === "unresolved" || !parameter.schema ? "" : `<details><summary>${htmlEscape(parameter.name)} ${labelHtml("Schema")}</summary>${htmlCode(JSON.stringify(parameter.schema, null, 2), "JSON schema")}</details>`).join("")}`;
  }).join("");
  const responses = api.responses.length === 0 ? "" : `<h3>${labelHtml("Responses")}</h3>${api.responses.map((response, index) => {
    if (response.kind === "unresolved") return `<h4>${labelHtml("Unresolved response")} ${index + 1}</h4><p>${labelHtml("Missing response component")}: ${htmlEscape(response.componentId)}</p>`;
    const headers = Object.keys(response.headers).length > 0 ? htmlTable(["Response header", "Value"], Object.entries(response.headers)) : "";
    const content = Object.entries(response.content).map(([mediaType, value]) => `<h5>${htmlEscape(mediaType)}</h5>${value.schema ? htmlCode(JSON.stringify(value.schema, null, 2), "Response schema") : ""}${value.examples.length > 0 ? htmlTable(["Example", "Value"], value.examples.map((example) => example.kind === "unresolved" ? [L("Missing example"), example.componentId] : [example.name, JSON.stringify(example.value)])) : ""}`).join("");
    return `<h4>${htmlEscape(response.status)}</h4>${htmlPlainText(response.description || "—")}${headers}${content}`;
  }).join("")}`;
  const models = api.models.length === 0 ? "" : `<h3>${labelHtml("Models")}</h3>${api.models.map((model) => {
    const references = collectModelReferences(model.schema).map((id) => {
      const referenced = api.models.find((candidate) => candidate.id === id);
      return referenced ? `<a href="#${htmlEscape(modelAnchor(api.contractId, id))}">${htmlEscape(referenced.name)}</a>` : `${labelHtml("Missing model")} ${htmlEscape(id)}`;
    });
    return `<section class="model" id="${htmlEscape(modelAnchor(api.contractId, model.id))}"><h4>${htmlEscape(model.name)}</h4>${htmlPlainText(model.description || "—")}${references.length > 0 ? `<p>${labelHtml("References")}: ${[...new Set(references)].join(", ")}</p>` : ""}${htmlCode(JSON.stringify(model.schema, null, 2), "Model schema")}</section>`;
  }).join("")}`;
  const components = api.components.length === 0 ? "" : `<h3>${labelHtml("Reusable components")}</h3>${htmlTable(["Name", "Kind", "Description", "Definition"], api.components.map((component) => [component.name, L(component.kind), component.description, {readerRaw: JSON.stringify(component.definition, null, 2)}]))}`;
  const documentation = api.documentation ? `<h3>${labelHtml("Documentation")}</h3>${htmlPlainText(api.documentation)}` : "";
  const caseSummaries = api.caseSummaries.length === 0 ? "" : `<h3>${labelHtml("Test cases")}</h3>${htmlTable(["Name", "Scope", "Assertions"], api.caseSummaries.map((summary) => [summary.name, summary.scope === "base" ? L("base") : summary.scope, summary.assertionCount]))}`;
  const diagnostics = api.diagnostics.length > 0 ? `<h3>${labelHtml("Definition diagnostics")}</h3>${htmlTable(["Severity", "Path", "Issue"], api.diagnostics.map((diagnostic) => [L(diagnostic.severity), diagnostic.path || "—", diagnostic.message]))}` : "";
  const snippets = ([
    ["cURL (POSIX shell)", "curl-posix"],
    ["PowerShell 7", "powershell"],
    ["JavaScript fetch", "javascript-fetch"],
  ] as const).map(([label, language]) => {
    const result = generateRequestSnippet(api, language);
    return result.code ? htmlCode(result.code, label, true) : `<h4>${labelHtml(label)}</h4>${result.diagnostics.length > 0 ? htmlTable(["Severity", "Path", "Issue"], result.diagnostics.map((diagnostic) => [L(diagnostic.severity), diagnostic.path || "—", diagnostic.message])) : `<p>${labelHtml("Not available.")}</p>`}`;
  }).join("");
  return `<section class="api" id="${htmlEscape(apiAnchor(api.contractId))}" data-search="${htmlEscape(searchText)}">${apiTitle}${description}${metadata}<h3>${labelHtml("Request")}</h3>${auth}${parameters}<h4>${labelHtml("Body")}</h4>${renderBodyHtml(api)}${snippets}${responses}${models}${components}${documentation}${caseSummaries}${diagnostics}</section>`;
}

function renderBodyHtml(api: DocumentApi): string {
  const request = api.request;
  if (request.protocol === "soap") return htmlCode(request.envelope, "SOAP envelope");
  if (request.protocol === "websocket") return htmlCode(request.message ?? "", "WebSocket message");
  switch (request.body.kind) {
    case "none": return `<p>${labelHtml("No body.")}</p>`;
    case "json":
    case "xml":
    case "text": return `${htmlCode(request.body.content, request.body.kind.toUpperCase())}${request.body.schema ? htmlCode(JSON.stringify(request.body.schema, null, 2), "Body schema") : ""}`;
    case "graphql": return `${request.body.operationName ? `<p><strong>${labelHtml("Operation name")}:</strong> ${htmlEscape(request.body.operationName)}</p>` : ""}${htmlCode(request.body.query, "GraphQL query")}${request.body.variables ? htmlCode(request.body.variables, "GraphQL variables") : ""}`;
    case "urlencoded": return htmlTable(["Field", "Value", "Enabled"], request.body.fields.map((field) => [field.name, field.value, L(yesNo(field.enabled))]));
    case "multipart": return htmlTable(["Field", "Kind", "Value / file", "Content type", "Enabled"], request.body.entries.map((entry) => entry.kind === "text"
      ? [entry.name, L("Text"), entry.value, "—", L(yesNo(entry.enabled))]
      : [entry.name, L("File"), entry.filename ?? L("Replace with a user-supplied file"), entry.contentType ?? "—", L(yesNo(entry.enabled))]));
    case "binary": return `<p>${labelHtml("Binary file")}${request.body.contentType ? ` · ${htmlEscape(request.body.contentType)}` : ""}; ${labelHtml("Use a user-supplied file.")}</p>`;
  }
}

function htmlTable(headers: string[], rows: Array<Array<unknown>>): string {
  return `<div class="table-scroll" tabindex="0"><table><thead><tr>${headers.map((header) => `<th scope="col">${labelHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${isLabel(cell) ? labelHtml(cell.readerLabel) : isRawDefinition(cell) ? `<details><summary>${readerText("查看组件契约", "View component contract")}</summary><pre>${htmlEscape(cell.readerRaw)}</pre></details>` : htmlEscape(String(cell ?? "—"))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function htmlPlainText(value: string): string { return `<div class="plain-text">${htmlEscape(value)}</div>`; }

function htmlCode(value: string, label: string, copy = false): string {
  return `<div class="code-sample"><strong>${labelHtml(label)}</strong>${copy ? '<button type="button" data-copy-button data-reader-zh="复制" data-reader-en="Copy">复制</button>' : ""}<pre><code>${htmlEscape(value)}</code></pre></div>`;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function apiAnchor(contractId: string): string { return `api-${contractId}`; }
function modelAnchor(contractId: string, modelId: string): string { return `model-${contractId}-${modelId}`; }

function renderApiMarkdown(api: DocumentApi): string {
  const request = api.request;
  const rows: Array<[string, string]> = [
    ["Collection", api.collection.name],
    ["Folders", api.folders.map((folder) => folder.name).join(" / ") || "—"],
    ["Version", api.metadata.version],
    ["Lifecycle", api.metadata.status],
    ["Tags", api.metadata.tags.join(", ") || "—"],
    ["Protocol", request.protocol.toUpperCase()],
    ["Method", request.protocol === "http" || request.protocol === "soap" ? request.method : "—"],
    ["Base URL", request.baseUrl],
    ["Path", request.path],
  ];
  const sections = [`<a id="api-${api.contractId}"></a>\n## ${escapeMarkdown(api.metadata.name)}`, api.metadata.description, markdownTable(["Field", "Value"], rows)];
  sections.push("### Request");
  sections.push(`Authentication: ${renderAuth(request.auth)}`);
  const groups = [
    ["Path parameters", request.pathParams],
    ["Query parameters", request.query],
    ["Headers", request.headers],
    ["Cookies", request.cookies],
  ] as const;
  for (const [label, parameters] of groups) {
    if (parameters.length === 0) continue;
    sections.push(`#### ${label}\n${markdownTable(["Name", "Value", "Required", "Enabled", "Description", "Schema"], parameters.map((parameter) => [
      parameter.kind === "unresolved" ? `[missing: ${parameter.componentId}]` : parameter.name,
      parameter.kind === "unresolved" ? "—" : parameter.value ?? "—",
      parameter.kind === "unresolved" ? "—" : yesNo(parameter.required),
      parameter.kind === "unresolved" ? "—" : yesNo(parameter.enabled),
      parameter.kind === "unresolved" ? "—" : parameter.description,
      parameter.kind === "unresolved" ? "—" : renderSchemaMarkdownCell(api, parameter.schema),
    ]))}`);
  }
  sections.push(`#### Body\n${renderBodyMarkdown(api)}`);
  if (api.responses.length > 0) {
    sections.push("### Responses");
    for (const [index, response] of api.responses.entries()) {
      if (response.kind === "unresolved") {
        sections.push(`#### Unresolved response ${index + 1}\nMissing response component: \`${escapeMarkdown(response.componentId)}\``);
        continue;
      }
      sections.push(`#### ${escapeMarkdown(response.status)}\n${escapeMarkdown(response.description || "—")}`);
      const headerRows = Object.entries(response.headers).map(([name, value]) => [name, value]);
      if (headerRows.length > 0) sections.push(`Response headers\n${markdownTable(["Name", "Value"], headerRows)}`);
      for (const [mediaType, content] of Object.entries(response.content)) {
        sections.push(`**${escapeMarkdown(mediaType)}**`);
        if (content.schema) sections.push(codeFence(JSON.stringify(content.schema, null, 2), "json"));
        if (content.examples.length > 0) {
          sections.push(markdownTable(["Example", "Value"], content.examples.map((example) => [
            example.kind === "unresolved" ? `[missing: ${example.componentId}]` : example.name,
            example.kind === "unresolved" ? "—" : JSON.stringify(example.value),
          ])));
        }
      }
    }
  }
  if (api.models.length > 0) {
    sections.push("### Models");
    for (const model of api.models) {
      const references = collectModelReferences(model.schema).map((id) => {
        const referenced = api.models.find((candidate) => candidate.id === id);
      return referenced ? `[${escapeMarkdown(referenced.name)}](#${modelAnchor(api.contractId, id)})` : `Missing model \`${escapeMarkdown(id)}\``;
      });
      sections.push(`<a id="${modelAnchor(api.contractId, model.id)}"></a>\n#### ${escapeMarkdown(model.name)}\n${escapeMarkdown(model.description || "—")}`);
      if (references.length > 0) sections.push(`References: ${[...new Set(references)].join(", ")}`);
      sections.push(codeFence(JSON.stringify(model.schema, null, 2), "json"));
    }
  }
  if (api.components.length > 0) {
    sections.push("### Reusable components");
    sections.push(markdownTable(["Name", "Kind", "Description", "Definition"], api.components.map((component) => [
      component.name, component.kind, component.description, JSON.stringify(component.definition),
    ])));
  }
  if (api.documentation) sections.push(`### Documentation\n\n${api.documentation}`);
  if (api.caseSummaries.length > 0) sections.push(`### Test cases\n\n${markdownTable(["Name", "Scope", "Assertions"], api.caseSummaries.map((summary) => [summary.name, summary.scope, summary.assertionCount]))}`);
  if (api.diagnostics.length > 0) sections.push(renderDiagnostics("Definition diagnostics", api.diagnostics));
  return sections.filter(Boolean).join("\n\n");
}

function renderAuth(auth: DocumentApi["request"]["auth"]): string {
  switch (auth.kind) {
    case "none": return "None";
    case "bearer": return "Bearer (token placeholder)";
    case "basic": return "Basic (username/password placeholders)";
    case "apikey": return `API key ${auth.placement} · ${escapeMarkdown(auth.name)} (value placeholder)`;
    case "unresolved": return `Unresolved auth component: \`${escapeMarkdown(auth.componentId)}\``;
  }
}

function renderBodyMarkdown(api: DocumentApi): string {
  const request = api.request;
  if (request.protocol !== "http") {
    return request.protocol === "soap" ? codeFence(request.envelope, "xml") : codeFence(request.message ?? "", "text");
  }
  const body = request.body;
  switch (body.kind) {
    case "none": return "No body.";
    case "json": return [codeFence(body.content, "json"), body.schema ? renderSchemaMarkdown(api, body.schema) : ""].filter(Boolean).join("\n\n");
    case "xml": return [codeFence(body.content, "xml"), body.schema ? renderSchemaMarkdown(api, body.schema) : ""].filter(Boolean).join("\n\n");
    case "text": return [codeFence(body.content, "text"), body.schema ? renderSchemaMarkdown(api, body.schema) : ""].filter(Boolean).join("\n\n");
    case "graphql": return [
      body.operationName ? `Operation name: ${escapeMarkdown(body.operationName)}` : "",
      codeFence(body.query, "graphql"),
      body.variables ? `Variables\n${codeFence(body.variables, "json")}` : "",
    ].filter(Boolean).join("\n\n");
    case "urlencoded": return markdownTable(["Field", "Value", "Enabled"], body.fields.map((field) => [field.name, field.value, yesNo(field.enabled)]));
    case "multipart": return markdownTable(["Field", "Kind", "Value / file", "Content type", "Enabled"], body.entries.map((entry) => entry.kind === "text"
      ? [entry.name, "Text", entry.value, "—", yesNo(entry.enabled)]
      : [entry.name, "File", entry.filename ?? "Replace with a user-supplied file", entry.contentType ?? "—", yesNo(entry.enabled)]));
    case "binary": return `Binary file${body.contentType ? ` · ${escapeMarkdown(body.contentType)}` : ""}; use a user-supplied file.`;
  }
}

function renderSchemaMarkdown(api: DocumentApi, schema: unknown): string {
  const references = collectModelReferences(schema).map((id) => {
    const model = api.models.find((candidate) => candidate.id === id);
    return model ? `[${escapeMarkdown(model.name)}](#${modelAnchor(api.contractId, id)})` : `Missing model \`${escapeMarkdown(id)}\``;
  });
  return ["Schema", codeFence(JSON.stringify(schema, null, 2), "json"), references.length > 0 ? `Models: ${[...new Set(references)].join(", ")}` : ""]
    .filter(Boolean).join("\n\n");
}

function renderSchemaMarkdownCell(api: DocumentApi, schema: unknown): string {
  const json = JSON.stringify(schema);
  const references = collectModelReferences(schema).map((id) => {
    const model = api.models.find((candidate) => candidate.id === id);
    return model ? `[${escapeMarkdown(model.name)}](#${modelAnchor(api.contractId, id)})` : `Missing model \`${escapeMarkdown(id)}\``;
  });
  return [json, ...new Set(references)].join("; ");
}

function buildBody(body: Extract<DocumentApi["request"], { protocol: "http" }>["body"], diagnostics: DocumentDiagnostic[], ownerId: string): BodyValue {
  switch (body.kind) {
    case "none": return { kind: "none" };
    case "json":
    case "xml":
    case "text": return { kind: "text", value: body.content };
    case "graphql": {
      const fields = [`"query":${JSON.stringify(body.query)}`];
      if (body.operationName !== undefined) fields.push(`"operationName":${JSON.stringify(body.operationName)}`);
      if (body.variables !== undefined) {
        try {
          JSON.parse(body.variables);
          fields.push(`"variables":${body.variables}`);
        } catch {
          diagnostics.push(snippetDiagnostic("SNIPPET_GRAPHQL_VARIABLES_INVALID", "request.body.variables", "GraphQL variables must contain valid JSON.", ownerId));
        }
      }
      return { kind: "text", value: `{${fields.join(",")}}` };
    }
    case "urlencoded": {
      const fields = body.fields.filter((field) => field.enabled).map((field) => `${encodeComponent(field.name)}=${encodeFormValue(field.value)}`);
      return { kind: "text", value: fields.join("&") };
    }
    case "multipart": {
      const parts: FormPart[] = [];
      let fileIndex = 0;
      for (const entry of body.entries) {
        if (!entry.enabled) continue;
        if (entry.kind === "text") parts.push({ name: entry.name, value: entry.value });
        else {
          const variable = `file${fileIndex++}`;
          parts.push({ name: entry.name, filename: entry.filename ?? "upload.bin", contentType: entry.contentType, variable });
        }
      }
      return { kind: "multipart", parts };
    }
    case "binary": return { kind: "binary", contentType: body.contentType, variable: "bodyFile" };
  }
}

function inferredContentType(body: Extract<DocumentApi["request"], { protocol: "http" }>["body"]): string | undefined {
  switch (body.kind) {
    case "none":
    case "multipart": return undefined;
    case "json": return "application/json";
    case "xml": return "application/xml";
    case "text": return "text/plain;charset=UTF-8";
    case "graphql": return "application/json";
    case "urlencoded": return "application/x-www-form-urlencoded";
    case "binary": return body.contentType || undefined;
  }
}

function serializeRequest(method: string, url: string, headers: HeaderValue[], body: BodyValue, language: RequestSnippetLanguage): string {
  if (language === "curl-posix") return serializeCurl(method, url, headers, body);
  if (language === "powershell") return serializePowerShell(method, url, headers, body);
  return serializeJavaScript(method, url, headers, body);
}

function serializeCurl(method: string, url: string, headers: HeaderValue[], body: BodyValue): string {
  const lines = [`curl --globoff --request ${quotePosix(method)} --url ${quotePosix(url)}`];
  for (const header of headers) lines.push(`  --header ${quotePosix(`${header.name}: ${header.value}`)}`);
  if (body.kind === "text") lines.push(`  --data-raw ${quotePosix(body.value)}`);
  if (body.kind === "binary") lines.push(`  --data-binary ${quotePosix(`@<PATH_TO_FILE>`)}`);
  if (body.kind === "multipart") {
    for (const part of body.parts) {
      const value = part.variable
        ? `@<PATH_TO_FILE>;filename=${part.filename}${part.contentType ? `;type=${part.contentType}` : ""}`
        : part.value ?? "";
      lines.push(`  ${part.variable ? "--form" : "--form-string"} ${quotePosix(`${part.name}=${value}`)}`);
    }
  }
  return lines.join(" \\\n");
}

function serializePowerShell(method: string, url: string, headers: HeaderValue[], body: BodyValue): string {
  const comments: string[] = [];
  const lines = body.kind === "multipart" ? [] : [`Invoke-RestMethod -Uri ${quotePowerShell(url)} -Method ${method}`];
  if (headers.length > 0 && body.kind !== "multipart") lines.push(`  -Headers @{ ${headers.map((header) => `${quotePowerShell(header.name)} = ${quotePowerShell(header.value)}`).join("; ")} }`);
  if (body.kind === "text") lines.push(`  -Body ${quotePowerShell(body.value)}`);
  if (body.kind === "binary") lines.push(`  -InFile ${quotePowerShell("<PATH_TO_FILE>")}`);
  if (body.kind === "multipart") {
    lines.push("$multipartContent = [System.Net.Http.MultipartFormDataContent]::new()");
    body.parts.forEach((part, index) => {
      if (part.variable) {
        const stream = `$fileStream${index}`;
        const content = `$fileContent${index}`;
        lines.push(`${stream} = [System.IO.File]::OpenRead(${quotePowerShell("<PATH_TO_FILE>")})`);
        lines.push(`${content} = [System.Net.Http.StreamContent]::new(${stream})`);
        if (part.contentType) lines.push(`${content}.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse(${quotePowerShell(part.contentType)})`);
        lines.push(`$multipartContent.Add(${content}, ${quotePowerShell(part.name)}, ${quotePowerShell(part.filename ?? "upload.bin")})`);
        comments.push(`# Replace <PATH_TO_FILE> with the user-supplied file for field ${safePowerShellComment(part.name)}.`);
        return;
      }
      const content = `$textContent${index}`;
      lines.push(`${content} = [System.Net.Http.StringContent]::new(${quotePowerShell(part.value ?? "")})`);
      lines.push(`$multipartContent.Add(${content}, ${quotePowerShell(part.name)})`);
    });
    lines.push("try {");
    lines.push(`  Invoke-RestMethod -Uri ${quotePowerShell(url)} -Method ${method}${headers.length > 0 ? ` -Headers @{ ${headers.map((header) => `${quotePowerShell(header.name)} = ${quotePowerShell(header.value)}`).join("; ")} }` : ""} -Body $multipartContent`);
    lines.push("} finally {");
    lines.push("  $multipartContent.Dispose()");
    lines.push("}");
    return `${comments.length ? `${comments.join("\n")}\n` : ""}${lines.join("\n")}`;
  }
  return `${comments.length ? `${comments.join("\n")}\n` : ""}${lines.join(" `\n")}`;
}

function serializeJavaScript(method: string, url: string, headers: HeaderValue[], body: BodyValue): string {
  const lines: string[] = [];
  let bodyExpression: string | undefined;
  if (body.kind === "text") bodyExpression = JSON.stringify(body.value);
  if (body.kind === "binary") {
    lines.push("const bodyFile = null; // Replace with a user-supplied File or Blob.");
    lines.push('if (!(bodyFile instanceof Blob)) throw new Error("Replace bodyFile with a user-supplied File or Blob.");');
    bodyExpression = "bodyFile";
  }
  if (body.kind === "multipart") {
    lines.push("const form = new FormData();");
    for (const part of body.parts) {
      if (part.variable) {
        lines.push(`const ${part.variable} = null; // Replace with a user-supplied File or Blob from <PATH_TO_FILE>.`);
        lines.push(`if (!(${part.variable} instanceof Blob)) throw new Error(${JSON.stringify(`Replace ${part.variable} with a user-supplied File or Blob.`)});`);
        const fileValue = part.contentType
          ? `new Blob([${part.variable}], { type: ${JSON.stringify(part.contentType)} })`
          : part.variable;
        if (part.contentType) lines.push(`const upload${part.variable.slice("file".length)} = ${fileValue};`);
        lines.push(`form.append(${JSON.stringify(part.name)}, ${part.contentType ? `upload${part.variable.slice("file".length)}` : part.variable}, ${JSON.stringify(part.filename)});`);
      } else lines.push(`form.append(${JSON.stringify(part.name)}, ${JSON.stringify(part.value ?? "")});`);
    }
    bodyExpression = "form";
  }
  lines.push(`const response = await fetch(${JSON.stringify(url)}, {`);
  lines.push(`  method: ${JSON.stringify(method)},`);
  if (headers.length > 0) {
    lines.push("  headers: new Headers([");
    for (const header of headers) lines.push(`    [${JSON.stringify(header.name)}, ${JSON.stringify(header.value)}],`);
    lines.push("  ]),");
  }
  if (bodyExpression !== undefined) lines.push(`  body: ${bodyExpression},`);
  lines.push("});");
  return lines.join("\n");
}

function appendQuery(url: string, parameters: Array<{ name: string; value: string }>): string {
  if (parameters.length === 0) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : url.slice(hashIndex);
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${separator}${parameters.map(({ name, value }) => `${encodeComponent(name)}=${encodeComponent(value)}`).join("&")}${hash}`;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function publicParameterValue(name: string, value: string | undefined, diagnostics: DocumentDiagnostic[], ownerId: string, path: string): string {
  if (value === undefined || value === "****") {
    diagnostics.push(snippetDiagnostic("SNIPPET_VALUE_PLACEHOLDER", path, `Replace the ${name} placeholder before sending.`, ownerId, "warning"));
    return variablePlaceholder(name);
  }
  return value;
}

function variablePlaceholder(name: string): string {
  const label = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "VALUE";
  return `{{${label}}}`;
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeFormValue(value: string): string {
  return encodeComponent(value).replace(/%20/g, "+");
}

function isVariable(value: string): boolean { return /^\{\{[^{}]+\}\}$/.test(value); }
function isValidHeaderName(value: string): boolean { return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value); }
function isValidHeaderValue(value: string): boolean { return !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function quotePosix(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function quotePowerShell(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function safePowerShellComment(value: string): string { return value.replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]/g, " "); }
function hasDuplicateNames(parts: FormPart[]): boolean {
  const names = parts.map((part) => part.name.toLowerCase());
  return new Set(names).size !== names.length;
}
function hasDuplicateHeaders(headers: HeaderValue[]): boolean {
  const names = headers.map((header) => header.name.toLowerCase());
  return new Set(names).size !== names.length;
}
function isCurlFormMetadataRepresentable(value: string): boolean {
  return !/[,;"\\=\u0000-\u001f\u007f]/.test(value);
}
function isValidMediaType(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*"))*$/i.test(value);
}

function snippetDiagnostic(
  code: string,
  path: string,
  message: string,
  ownerId?: string,
  severity: DocumentDiagnostic["severity"] = "error",
): DocumentDiagnostic {
  return { severity, code, path, message, lossy: severity === "error", ...(ownerId === undefined ? {} : { ownerId }) };
}

function result(code: string, diagnostics: DocumentDiagnostic[]): RequestSnippetResult {
  return RequestSnippetResultSchema.parse({ code, diagnostics });
}

function renderDiagnostics(title: string, diagnostics: DocumentDiagnostic[]): string {
  return `### ${title}\n\n${markdownTable(["Severity", "Path", "Issue"], diagnostics.map((diagnostic) => [
    diagnostic.severity, diagnostic.path || "—", diagnostic.message,
  ]))}`;
}

function markdownTable(headers: string[], rows: Array<Array<unknown>>): string {
  const renderRow = (cells: Array<unknown>): string => `| ${cells.map((cell) => escapeMarkdown(String(cell ?? "—"))).join(" | ")} |`;
  return [renderRow(headers), renderRow(headers.map(() => "---")), ...rows.map(renderRow)].join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function codeFence(value: string, language: string): string {
  const longest = [...value.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

function yesNo(value: boolean): string { return value ? "Yes" : "No"; }

function collectModelReferences(value: unknown, found: Set<string> = new Set()): string[] {
  if (value === null || typeof value !== "object") return [...found];
  if (Array.isArray(value)) for (const item of value) collectModelReferences(item, found);
  else {
    const record = value as Record<string, unknown>;
    if (record.kind === "modelRef" && typeof record.modelId === "string") found.add(record.modelId);
    for (const child of Object.values(record)) collectModelReferences(child, found);
  }
  return [...found];
}
