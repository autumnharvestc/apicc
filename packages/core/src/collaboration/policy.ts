import type { CompiledMockPlan } from "../mock/compile.js";
import type { MockDiagnostic } from "../mock/config.js";
import type { SharedMockPolicy } from "./types.js";
import { CompiledMockPlanSchema, SharedMockPolicySchema } from "./shared.js";
import { isCredentialFieldName } from "../import/schemaMapping.js";
import { redactKnownPrivatePaths } from "./privacy.js";

const sensitiveHeaders = new Set(["authorization", "cookie", "proxy-authorization", "x-apicc-token", "x-apicc-mock-key", "x-apicc-share-key"]);
const forbiddenHeaders = new Set(["set-cookie", "location", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"]);

export function validateSharedMock(plan: CompiledMockPlan, policy: SharedMockPolicy): readonly MockDiagnostic[] {
  const diagnostics: MockDiagnostic[] = [];
  const add = (code: string, path: string, message: string, ownerId?: string): void => { diagnostics.push({ severity: "error", code, path, message, lossy: false, ...(ownerId ? { ownerId } : {}) }); };
  const policyParsed = SharedMockPolicySchema.safeParse(policy);
  const planParsed = CompiledMockPlanSchema.safeParse(plan);
  const pathText = (parts: readonly PropertyKey[]): string => parts.map((part, index) => typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${String(part)}`).join("");
  if (!policyParsed.success) {
    for (const issue of policyParsed.error.issues) {
      const keys = issue.code === "unrecognized_keys" ? issue.keys : [undefined];
      for (const key of keys) add("SHARED_MOCK_POLICY_INVALID", `policy.${pathText([...issue.path, ...(key ? [key] : [])])}`, "共享 Mock 额度或策略字段无效。");
    }
    return diagnostics;
  }
  if (!planParsed.success) {
    for (const issue of planParsed.error.issues) {
      const keys = issue.code === "unrecognized_keys" ? issue.keys : [undefined];
      for (const key of keys) add("SHARED_MOCK_PLAN_INVALID", pathText([...issue.path, ...(key ? [key] : [])]), "编译计划包含无效字段或非声明式材料。");
    }
    return diagnostics;
  }
  if (policy.extraSensitiveHeaders.length + policy.extraSensitiveQuery.length + policy.extraSensitiveFields.length + policy.extraSensitivePointers.length > 200) {
    add("SHARED_MOCK_POLICY_INVALID", "policy.extraSensitive", "额外敏感规则合计不能超过 200 项。"); return diagnostics;
  }
  const additionalHeaders = new Set(policy.extraSensitiveHeaders.map((name) => name.toLowerCase()));
  const queryNames = new Set(policy.extraSensitiveQuery.map((name) => name.toLowerCase()));
  const fieldNames = new Set(policy.extraSensitiveFields.map((name) => name.toLowerCase()));
  const sensitivePointer = (pointer: string): boolean => policy.extraSensitivePointers.some((parent) => pointer === parent || pointer.startsWith(`${parent}/`))
    || pointer.split("/").slice(1).some((token) => { const name = token.replace(/~1/g, "/").replace(/~0/g, "~"); return fieldNames.has(name.toLowerCase()) || isCredentialFieldName(name); });
  const sensitiveText = (text: string): boolean => /\{\{\s*(?:credential|secret|auth|cookie|token)(?::|\.)[^}]*\}\}/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]+/i.test(text) || redactKnownPrivatePaths(text) !== text;
  const sensitiveJson = (value: unknown, pointer: string): boolean => {
    if (policy.extraSensitivePointers.includes(pointer)) return true;
    if (typeof value === "string") return sensitiveText(value);
    if (Array.isArray(value)) return value.some((item, index) => sensitiveJson(item, `${pointer}/${index}`));
    if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => fieldNames.has(key.toLowerCase()) || isCredentialFieldName(key)
      || sensitiveJson(item, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
    return false;
  };
  plan.routes.forEach((route, routeIndex) => route.rules.forEach((rule, ruleIndex) => {
    const root = `routes[${routeIndex}].rules[${ruleIndex}]`;
    rule.conditions.forEach((condition, index) => {
      const forbidden = condition.source === "header" ? sensitiveHeaders.has(condition.name.toLowerCase()) || additionalHeaders.has(condition.name.toLowerCase()) || isCredentialFieldName(condition.name)
        : condition.source === "query" ? queryNames.has(condition.name.toLowerCase()) || isCredentialFieldName(condition.name)
          : condition.source === "body" ? sensitivePointer(condition.pointer) : false;
      if (forbidden) add("SHARED_MOCK_SENSITIVE_CONDITION", `${root}.conditions[${index}].${condition.source === "body" ? "pointer" : "name"}`, "规则依赖不会传入共享服务的敏感字段。", rule.id);
    });
    for (const name of [...Object.keys(rule.headers), ...(rule.excludedResponseHeaders ?? [])]) {
      const key = name.toLowerCase();
      if (forbiddenHeaders.has(key) || key.startsWith("access-control-") || key.startsWith("cross-origin-") || rule.excludedResponseHeaders?.includes(name) || isCredentialFieldName(name) || additionalHeaders.has(key)) add("SHARED_MOCK_RESPONSE_HEADER_FORBIDDEN", `${root}.headers.${name}`, "共享 Mock 不允许覆盖此响应控制或平台安全头。", rule.id);
      if (rule.headers[name] !== undefined && sensitiveText(rule.headers[name]!)) add("SHARED_MOCK_SENSITIVE_MATERIAL", `${root}.headers.${name}`, "响应头包含敏感材料。", rule.id);
    }
    const body = new TextDecoder().decode(Uint8Array.from(rule.body));
    let material = sensitiveText(body);
    try { material ||= sensitiveJson(JSON.parse(body), ""); } catch { /* Fixed text responses need not be JSON. */ }
    if (material) add("SHARED_MOCK_SENSITIVE_MATERIAL", `${root}.body`, "编译正文包含敏感材料或运行时秘密占位符。", rule.id);
    if (rule.body.length > policy.maxResponseBytes) add("SHARED_MOCK_RESPONSE_TOO_LARGE", `${root}.body`, "编译响应超过当前有效字节额度。", rule.id);
    if (rule.delayMs > policy.maxDelayMs) add("SHARED_MOCK_DELAY_LIMIT", `${root}.delayMs`, "规则延时超过当前有效上限。", rule.id);
    if (rule.delayMs >= policy.requestDeadlineMs) add("SHARED_MOCK_DEADLINE_INVALID", `${root}.delayMs`, "调用期限必须大于启用规则的延时并留出处理时间。", rule.id);
  }));
  return diagnostics;
}
