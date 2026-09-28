import type { StressTargetPolicy } from "../domain/model.js";

export type StressSafetyErrorCode =
  | "invalid_target_origin"
  | "target_confirmation_required"
  | "target_denied"
  | "concurrency_policy_exceeded"
  | "max_rps_policy_exceeded"
  | "invalid_stress_policy";

/** Structured, stable errors consumed by CLI and desktop confirmation flows. */
export class StressSafetyError extends Error {
  readonly code: StressSafetyErrorCode;
  readonly targetOrigin?: string;

  constructor(code: StressSafetyErrorCode, message: string, targetOrigin?: string) {
    super(`[${code}] ${message}`);
    this.name = "StressSafetyError";
    this.code = code;
    this.targetOrigin = targetOrigin;
  }
}
/** Canonicalize a URL to an HTTP(S) origin (default ports, host case and IPv6 included). */
export function normalizeStressOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StressSafetyError("invalid_target_origin", `目标 URL 不是合法 HTTP(S) URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new StressSafetyError("invalid_target_origin", `目标协议必须为 HTTP(S): ${parsed.protocol}`);
  }
  return parsed.origin;
}

function policyError(message: string): never {
  throw new StressSafetyError("invalid_stress_policy", message);
}

/** Normalize policy values at the safety boundary as well as in ProjectSchema. */
export function normalizeStressPolicy(policy?: StressTargetPolicy): StressTargetPolicy {
  if (!policy) return { trustedOrigins: [], deniedOrigins: [] };
  const normalizeList = (values: string[] | undefined, field: string): string[] => {
    if (values === undefined) return [];
    if (!Array.isArray(values)) policyError(`stressPolicy.${field} 必须是数组`);
    const out: string[] = [];
    for (const value of values) {
      if (typeof value !== "string") policyError(`stressPolicy.${field} 必须只包含字符串`);
      const origin = normalizeStressOrigin(value);
      if (!out.includes(origin)) out.push(origin);
    }
    return out;
  };
  if (policy.maxConcurrency !== undefined && (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency <= 0)) {
    policyError("stressPolicy.maxConcurrency 必须为正整数");
  }
  if (policy.maxRps !== undefined && (!Number.isFinite(policy.maxRps) || policy.maxRps <= 0)) {
    policyError("stressPolicy.maxRps 必须为有限正数");
  }
  return {
    trustedOrigins: normalizeList(policy.trustedOrigins, "trustedOrigins"),
    deniedOrigins: normalizeList(policy.deniedOrigins, "deniedOrigins"),
    ...(policy.maxConcurrency !== undefined ? { maxConcurrency: policy.maxConcurrency } : {}),
    ...(policy.maxRps !== undefined ? { maxRps: policy.maxRps } : {}),
  };
}

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.slice(1).every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export interface StressSafetyDecision {
  targetOrigin: string;
  loopback: boolean;
  confirmation: "explicit" | "project-policy";
  appliedPolicy?: StressTargetPolicy;
}

export function assertStressTargetAllowed(input: {
  url: string;
  confirmedTargetOrigins?: string[];
  policy?: StressTargetPolicy;
  concurrency: number;
  maxRps?: number;
}): StressSafetyDecision {
  const targetOrigin = normalizeStressOrigin(input.url);
  const policy = normalizeStressPolicy(input.policy);
  // Denial is deliberately checked before every other permission, including an explicit CLI confirmation.
  if (policy.deniedOrigins?.includes(targetOrigin)) {
    throw new StressSafetyError("target_denied", `目标被项目策略禁用: ${targetOrigin}`, targetOrigin);
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency <= 0) {
    throw new StressSafetyError("invalid_stress_policy", `concurrency 必须为正整数，收到 ${input.concurrency}`, targetOrigin);
  }
  if (policy.maxConcurrency !== undefined && input.concurrency > policy.maxConcurrency) {
    throw new StressSafetyError(
      "concurrency_policy_exceeded",
      `并发数 ${input.concurrency} 超过项目上限 ${policy.maxConcurrency}`,
      targetOrigin,
    );
  }
  if (input.maxRps !== undefined && (!Number.isFinite(input.maxRps) || input.maxRps <= 0)) {
    throw new StressSafetyError("invalid_stress_policy", `maxRps 必须为有限正数，收到 ${input.maxRps}`, targetOrigin);
  }
  if (policy.maxRps !== undefined && input.maxRps !== undefined && input.maxRps > policy.maxRps) {
    throw new StressSafetyError(
      "max_rps_policy_exceeded",
      `maxRps ${input.maxRps} 超过项目上限 ${policy.maxRps}`,
      targetOrigin,
    );
  }
  const explicit = (input.confirmedTargetOrigins ?? []).map((value) => normalizeStressOrigin(value)).includes(targetOrigin);
  const projectTrusted = policy.trustedOrigins?.includes(targetOrigin) ?? false;
  if (!explicit && !projectTrusted) {
    throw new StressSafetyError(
      "target_confirmation_required",
      `目标需要确认: ${targetOrigin}${isLoopbackOrigin(targetOrigin) ? "（loopback 也不自动放行）" : ""}`,
      targetOrigin,
    );
  }
  return {
    targetOrigin,
    loopback: isLoopbackOrigin(targetOrigin),
    confirmation: projectTrusted ? "project-policy" : "explicit",
    appliedPolicy: policy,
  };
}
