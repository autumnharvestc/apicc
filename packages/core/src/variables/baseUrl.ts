/**
 * 前置 URL 拼接（M9-B D4）：环境按集合设置的前置 URL 生效于两通道——
 * ① 注入为内置变量 baseUrl（{{baseUrl}} 模板，变量解析层完成）；
 * ② 本工具：解析后的 URL 无协议头（相对路径）时自动拼接前置 URL（斜杠归一）。
 * 有任意 scheme（http/https/ws/wss/soap 自定义等）的绝对 URL 原样返回。
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function withBaseUrl(url: string, baseUrl: string | undefined): string {
  if (!baseUrl || SCHEME.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}
