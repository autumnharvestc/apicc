import type { ApiDefinition, ProjectGlobals } from "../domain/model.js";
import type { AuthProvider, ExecutableRequest } from "../plugin/types.js";
import type { VariableResolver } from "../variables/resolver.js";
import { withBaseUrl } from "../variables/baseUrl.js";

/**
 * 将接口定义解析为压测可执行请求：变量解析 + 启用项过滤 + 认证应用。
 * query 仅保留启用项；URL 相对路径时自动拼接前置 URL（M9-B：环境按集合的 baseUrl
 * 已由调用方注入变量层，{{baseUrl}} 模板与相对 URL 两通道同效，与调试/集合运行同口径）。
 * M10：globals（项目级全局参数）可选传入——query/header 追加（接口同名项优先）、
 * cookies 序列化为 Cookie 头（接口自有 Cookie 头整头优先）、body 仅合并进 form 请求体。
 * 认证遍历 providers 取首个 type 匹配者应用；无 auth 或无匹配 provider 时不改写请求。
 */
export function buildStressRequest(
  api: ApiDefinition,
  resolver: VariableResolver,
  authProviders: AuthProvider[],
  globals?: ProjectGlobals,
): ExecutableRequest {
  const headers = Object.fromEntries(
    api.headers.filter((h) => h.enabled).map((h) => [h.key, resolver.resolve(h.value)]),
  );
  const query = api.query.filter((q) => q.enabled).map((q) => ({ ...q, value: resolver.resolve(q.value) }));
  if (globals) {
    for (const h of globals.headers) {
      if (h.enabled && h.key && !api.headers.some((a) => a.key === h.key)) headers[h.key] = resolver.resolve(h.value);
    }
    for (const q of globals.query) {
      if (q.enabled && q.key && !api.query.some((a) => a.key === q.key)) query.push({ ...q, value: resolver.resolve(q.value) });
    }
  }
  const hasCookieHeader = Object.keys(headers).some((k) => k.toLowerCase() === "cookie");
  if (globals && !hasCookieHeader) {
    const cookie = globals.cookies
      .filter((c) => c.enabled && c.key)
      .map((c) => `${resolver.resolve(c.key)}=${resolver.resolve(c.value)}`)
      .join("; ");
    if (cookie) headers["Cookie"] = cookie;
  }
  const request: ExecutableRequest = {
    method: api.method,
    url: withBaseUrl(resolver.resolve(api.url), resolver.get("baseUrl")),
    headers,
    query,
    // form 请求体逐项解析变量值（JSON/xml/raw/graphql 走 content 字符串）；发送侧编码由 http client 负责。
    // M10：全局 body 参数仅合并进 form 请求体（接口同名 key 优先），不改变请求形态。
    body: api.body
      ? (() => {
          const form = api.body.form?.map((kv) => ({ ...kv, value: resolver.resolve(kv.value) }));
          if (api.body.kind !== "form" || !globals) {
            return { ...api.body, content: resolver.resolve(api.body.content), form };
          }
          const existing = new Set((form ?? []).map((f) => f.key));
          const extra = globals.body
            .filter((b) => b.enabled && b.key && !existing.has(b.key))
            .map((b) => ({ key: b.key, value: resolver.resolve(b.value), enabled: true }));
          return { kind: api.body.kind, content: resolver.resolve(api.body.content), form: [...(form ?? []), ...extra] };
        })()
      : undefined,
    auth: api.auth,
    // M5 D5/D7：协议分发键与 ws/soap 模板字段随请求透传（变量解析与 url/body 同管线）；
    // 旧 yaml 无这些字段 → 请求形状不变（protocolOf 缺省 http），压测面零破坏。
    protocol: api.protocol,
    message: api.message === undefined ? undefined : resolver.resolve(api.message),
    envelope: api.envelope === undefined ? undefined : resolver.resolve(api.envelope),
    soapAction: api.soapAction === undefined ? undefined : resolver.resolve(api.soapAction),
  };
  const auth = api.auth;
  if (auth) {
    const provider = authProviders.find((p) => p.type === auth.type);
    provider?.apply(request, auth, (n) => resolver.get(n));
  }
  return request;
}
