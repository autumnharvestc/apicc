/**
 * 前置 URL 拼接（M9-B D4）：环境按集合设置的前置 URL 生效于两通道——
 * ① 注入为内置变量 baseUrl（{{baseUrl}} 模板，变量解析层完成）；
 * ② 本工具：解析后的 URL 为相对路径时按 WHATWG URL 语义解析前置 URL。
 * 可独立解析的绝对 URL（http/https/ws/wss/soap 自定义等）原样返回。
 */
export function withBaseUrl(url: string, baseUrl: string | undefined): string {
  if (!baseUrl) return url;
  try {
    // WHATWG accepts special forms such as `https:example.com`, ASCII
    // whitespace around an URL, and backslashes. Keep the source text here;
    // protocol-specific safety/transport layers canonicalize HTTP(S) later.
    new URL(url);
    return url;
  } catch {
    return new URL(url, baseUrl).href;
  }
}
