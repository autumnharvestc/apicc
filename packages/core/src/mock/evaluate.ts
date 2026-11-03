import type { CompiledMockPlan, CompiledMockRoute } from "./compile.js";
import type { MockCondition } from "./config.js";

export interface MockEvaluationInput {
  method: string;
  target: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface MockEvaluation {
  status: number;
  mediaType: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  delayMs: number;
  ruleId?: string;
  routeTemplate?: string;
  reason: string;
  contractId?: string;
  responseBindingId?: string;
}

export function evaluateMock(plan: CompiledMockPlan, input: MockEvaluationInput): MockEvaluation {
  return evaluateMockWithHeaderValues(plan, input, (name) => Object.entries(input.headers)
    .filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value));
}

/** Local transport supplies raw duplicate values; both hosts execute this single matcher. */
export function evaluateMockWithHeaderValues(
  plan: CompiledMockPlan,
  input: MockEvaluationInput,
  headerValues: (name: string) => string[],
): MockEvaluation {
  const target = decodeTarget(input.target);
  if ("error" in target) return statusResponse(input.method, 400, target.error);
  let route: CompiledMockRoute | undefined;
  const pathParameters = findRoute(plan.routes, input.method, target.pathSegments, (matchedRoute) => { route = matchedRoute; });
  if (!pathParameters || !route) return statusResponse(input.method, 404, "NO_ROUTE");

  let parsedBody: unknown;
  let bodyIsParsed = false;
  let bodyParseFailed = false;
  const parseBody = (): boolean => {
    if (bodyIsParsed) return !bodyParseFailed;
    bodyIsParsed = true;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(input.body)) as unknown;
      return true;
    } catch {
      bodyParseFailed = true;
      return false;
    }
  };
  const queryValues = (name: string): string[] => target.query.getAll(name);
  const rule = route.rules.find((candidate) => candidate.conditions.every((condition) => {
    if (condition.source === "body" && !parseBody()) return false;
    return matchesCondition(condition, pathParameters, queryValues, headerValues, parsedBody);
  }));
  const identity = { routeTemplate: route.pathTemplate, contractId: route.contractId };
  if (!rule) return { ...statusResponse(input.method, 501, "NO_RULE_MATCH"), ...identity };
  return {
    status: rule.status, mediaType: rule.mediaType, headers: rule.headers,
    body: input.method === "HEAD" || rule.status === 204 || rule.status === 304 ? new Uint8Array() : Uint8Array.from(rule.body),
    delayMs: rule.delayMs, ruleId: rule.id, responseBindingId: rule.responseBindingId, reason: "MATCHED", ...identity,
  };
}

function statusResponse(method: string, status: number, reason: string): MockEvaluation {
  const messages: Record<number, string> = { 400: "Bad Request", 404: "Not Found", 501: "Mock Rule Not Matched" };
  return { status, mediaType: "text/plain; charset=utf-8", headers: {},
    body: method === "HEAD" ? new Uint8Array() : new TextEncoder().encode(messages[status]!), delayMs: 0, reason };
}

type DecodedTarget = { pathSegments: string[]; query: URLSearchParams } | { error: "MALFORMED_REQUEST_TARGET" | "MALFORMED_PATH_ENCODING" };
function decodeTarget(target: string): DecodedTarget {
  if (!target.startsWith("/")) return { error: "MALFORMED_REQUEST_TARGET" };
  const queryIndex = target.indexOf("?");
  const rawPath = queryIndex < 0 ? target : target.slice(0, queryIndex);
  let pathSegments: string[];
  try { pathSegments = rawPath.split("/").map((segment) => decodeURIComponent(segment)); }
  catch { return { error: "MALFORMED_PATH_ENCODING" }; }
  return { pathSegments, query: new URLSearchParams(queryIndex < 0 ? "" : target.slice(queryIndex + 1)) };
}

function findRoute(routes: readonly CompiledMockRoute[], method: string, pathSegments: readonly string[], onMatch: (route: CompiledMockRoute) => void): Record<string, string> | undefined {
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== pathSegments.length) continue;
    const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
    let matches = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index]!;
      const value = pathSegments[index]!;
      if (segment.kind === "literal") {
        if (segment.value !== value) { matches = false; break; }
      } else parameters[segment.name] = value;
    }
    if (matches) { onMatch(route); return parameters; }
  }
  return undefined;
}

function matchesCondition(condition: MockCondition, pathParameters: Record<string, string>, queryValues: (name: string) => string[], headerValues: (name: string) => string[], body: unknown): boolean {
  if (condition.source === "body") {
    const pointer = resolveJsonPointer(body, condition.pointer);
    if (condition.op === "exists") return pointer.found;
    return pointer.found && pointer.value === condition.value;
  }
  let values: string[];
  if (condition.source === "path") values = Object.hasOwn(pathParameters, condition.name) ? [pathParameters[condition.name]!] : [];
  else if (condition.source === "query") values = queryValues(condition.name);
  else values = headerValues(condition.name);
  if (condition.op === "exists") return values.length > 0;
  return values.some((value) => value === condition.value);
}

function resolveJsonPointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  const tokens = pointer === "" ? [] : pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = root;
  for (const token of tokens) {
    if (typeof value !== "object" || value === null) return { found: false };
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= value.length) return { found: false };
      value = value[index]; continue;
    }
    if (!Object.hasOwn(value, token)) return { found: false };
    value = (value as Record<string, unknown>)[token];
  }
  return { found: true, value };
}
