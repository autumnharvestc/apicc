import type { ApiDefinition } from "../domain/model.js";
import type { AuthProvider, ExecutableRequest } from "../plugin/types.js";
import type { VariableResolver } from "../variables/resolver.js";

/**
 * 将接口定义解析为压测可执行请求：变量解析 + 启用项过滤 + 认证应用。
 * query 仅保留启用项，URL 拼接沿用 http client buildUrl 语义（此处不拼）。
 * 认证遍历 providers 取首个 type 匹配者应用；无 auth 或无匹配 provider 时不改写请求。
 */
export function buildStressRequest(
  api: ApiDefinition,
  resolver: VariableResolver,
  authProviders: AuthProvider[],
): ExecutableRequest {
  const request: ExecutableRequest = {
    method: api.method,
    url: resolver.resolve(api.url),
    headers: Object.fromEntries(
      api.headers.filter((h) => h.enabled).map((h) => [h.key, resolver.resolve(h.value)]),
    ),
    query: api.query.filter((q) => q.enabled).map((q) => ({ ...q, value: resolver.resolve(q.value) })),
    // form 请求体逐项解析变量值（JSON/xml/raw/graphql 走 content 字符串）；发送侧编码由 http client 负责。
    body: api.body
      ? {
          ...api.body,
          content: resolver.resolve(api.body.content),
          form: api.body.form?.map((kv) => ({ ...kv, value: resolver.resolve(kv.value) })),
        }
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
