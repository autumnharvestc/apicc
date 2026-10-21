import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import type { JsonValue } from "../contract/schemaNode.js";
import type { ExecutionResponse } from "../plugin/types.js";
import { ResponseSelectorSchema, type ResponseSelector } from "../testing/model.js";

export class AssertionValueError extends Error {
  constructor(public readonly code: string, message: string, public readonly kind: "config" | "assertion" = "config") {
    super(message);
    this.name = "AssertionValueError";
  }
}
export interface SelectedResponseValue { found: boolean; value?: JsonValue; sourcePath?: string }
type JsonStep = { recursive: boolean; key: string | number | null };
const hitLimit = 1000;
export function assertPathBound(path: string): void {
  if (new TextEncoder().encode(path).length > 2048) throw new AssertionValueError("SELECTOR_LIMIT", "Selector path exceeds 2 KiB");
}
function jsonSteps(path: string): JsonStep[] {
  assertPathBound(path);
  if (!path.startsWith("$")) throw new AssertionValueError("SELECTOR_SYNTAX", "JSONPath must begin with $");
  const steps: JsonStep[] = [];
  let rest = path.slice(1);
  while (rest) {
    let recursive = false;
    if (rest.startsWith("..")) { recursive = true; rest = rest.slice(2); }
    else if (rest.startsWith(".")) {
      rest = rest.slice(1);
      if (rest.startsWith("[")) throw new AssertionValueError("SELECTOR_SYNTAX", "A JSONPath dot must be followed by a child name or wildcard");
    }
    else if (!rest.startsWith("[")) throw new AssertionValueError("SELECTOR_SYNTAX", "Unsupported JSONPath syntax");
    const dot = /^(\*|[A-Za-z_$][\w$-]*)/.exec(rest);
    const bracket = /^\[(\*|0|[1-9]\d*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]/.exec(rest);
    const token = bracket?.[1] ?? dot?.[1];
    if (token === undefined) throw new AssertionValueError("SELECTOR_SYNTAX", "Only JSONPath child, index, wildcard and recursive selection are supported");
    let key: string | number | null;
    if (token === "*") key = null;
    else if (bracket && /^\d+$/.test(token)) key = Number(token);
    else if (token.startsWith('"')) key = JSON.parse(token) as string;
    else if (token.startsWith("'")) key = token.slice(1, -1).replace(/\\(['\\])/g, "$1");
    else key = token;
    steps.push({ recursive, key });
    rest = rest.slice((bracket ?? dot)![0].length);
  }
  return steps;
}
export function validateResponseSelector(selector: ResponseSelector): void {
  if (selector.target === "header" && !selector.headerName?.trim()) throw new AssertionValueError("SELECTOR_CONFIG", "Header name is required");
  if (selector.target === "cookie" && !selector.cookieName?.trim()) throw new AssertionValueError("SELECTOR_CONFIG", "Cookie name is required");
  if (selector.target === "bodyJson") jsonSteps(selector.path ?? "$");
  if (selector.target === "bodyXml") {
    if (!selector.path?.trim()) throw new AssertionValueError("SELECTOR_CONFIG", "XPath is required");
    assertPathBound(selector.path);
    const withoutLiterals = selector.path.replace(/'[^']*'|"[^"]*"/g, "");
    for (const match of withoutLiterals.matchAll(/\b([A-Za-z_][\w.-]*):(?!:)/g)) {
      if (match[1] !== "xml" && !selector.namespaces?.[match[1]!]) throw new AssertionValueError("SELECTOR_CONFIG", `Unbound XPath namespace: ${match[1]}`);
    }
    // xpath 0.0.34 exposes its parser at runtime but omits it from its declaration file.
    try { (xpath as typeof xpath & { parse(expression: string): unknown }).parse(selector.path); }
    catch { throw new AssertionValueError("SELECTOR_SYNTAX", "Invalid XPath expression"); }
  }
}
type Parsed = { json?: JsonValue; xml?: Node; jsonError?: AssertionValueError; xmlError?: AssertionValueError };
// Weak keys keep cached full parses local to the response lifetime, without retaining completed runs.
const parsedResponses = new WeakMap<ExecutionResponse, Parsed>();
function parsed(response: ExecutionResponse, target: "json" | "xml"): JsonValue | Node {
  const cache = parsedResponses.get(response) ?? {};
  parsedResponses.set(response, cache);
  const errorKey = target === "json" ? "jsonError" : "xmlError";
  if (cache[errorKey]) throw cache[errorKey];
  if (Object.hasOwn(cache, target)) return cache[target]!;
  try {
    if (target === "json") {
      cache.json = JSON.parse(response.bodyText, (_key, value: unknown) => {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("JSON number is not finite");
        return value;
      }) as JsonValue;
    }
    else cache.xml = new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(response.bodyText, "text/xml") as unknown as Node;
    return cache[target]!;
  } catch (error) {
    const diagnostic = new AssertionValueError("RESPONSE_PARSE", `${target.toUpperCase()} parse failed: ${String(error)}`, "assertion");
    cache[errorKey] = diagnostic;
    throw diagnostic;
  }
}
export function selectResponseValue(selector: ResponseSelector, response: ExecutionResponse): SelectedResponseValue {
  const normalized = ResponseSelectorSchema.safeParse(selector);
  if (!normalized.success) throw new AssertionValueError("SELECTOR_CONFIG", normalized.error.message);
  selector = normalized.data;
  validateResponseSelector(selector);
  const hits: { value: JsonValue; path: string }[] = [];
  const add = (value: JsonValue, path: string): void => {
    if (hits.length >= hitLimit) throw new AssertionValueError("SELECTOR_LIMIT", "Selector exceeds 1000 hits");
    hits.push({ value, path });
  };
  const pairs = response.rawHeaders ?? Object.entries(response.headers);
  switch (selector.target) {
    case "status": add(response.status, "status"); break;
    case "responseTime": add(response.timeMs, "responseTime"); break;
    case "header":
      for (const [name, value] of pairs) if (name.toLowerCase() === selector.headerName!.toLowerCase()) add(value, `header.${name}`);
      break;
    case "cookie":
      for (const [name, value] of pairs) {
        if (name.toLowerCase() !== "set-cookie") continue;
        // Each raw header is a cookie; Expires commas are never separators.
        const pair = value.split(";", 1)[0]!;
        const equals = pair.indexOf("=");
        if (equals > 0 && pair.slice(0, equals).trim() === selector.cookieName) add(pair.slice(equals + 1).trim(), `cookie.${selector.cookieName}`);
      }
      break;
    case "bodyText":
      if (response.textAvailable === false) throw new AssertionValueError("RESPONSE_UNAVAILABLE", "Reliable response text is unavailable", "assertion");
      add(response.bodyText, "bodyText"); break;
    case "bodyJson": {
      if (response.textAvailable === false || response.jsonAvailable === false) throw new AssertionValueError("RESPONSE_UNAVAILABLE", "Reliable JSON is unavailable", "assertion");
      const root = parsed(response, "json") as JsonValue;
      let current = [{ value: root, path: "$" }];
      for (const step of jsonSteps(selector.path ?? "$")) {
        const next: typeof current = [];
        const visit = (entry: typeof current[number]): void => {
          const value = entry.value;
          if (value === null || typeof value !== "object") return;
          for (const key of Object.keys(value)) {
            const child = { value: (value as Record<string, JsonValue>)[key]!, path: Array.isArray(value) ? `${entry.path}[${key}]` : `${entry.path}[${JSON.stringify(key)}]` };
            if (step.key === null || (typeof step.key === "number" ? Array.isArray(value) && String(step.key) === key : step.key === key)) {
              if (next.length >= hitLimit) throw new AssertionValueError("SELECTOR_LIMIT", "Selector exceeds 1000 hits");
              next.push(child);
            }
          }
        };
        for (const entry of current) {
          visit(entry);
          if (step.recursive) {
            const stack = [entry.value];
            const paths = [entry.path];
            while (stack.length) {
              const parent = stack.pop(); const path = paths.pop()!;
              if (parent === null || typeof parent !== "object") continue;
              const children = Object.entries(parent);
              // Reverse stack insertion preserves document order for recursive descent.
              for (let index = children.length - 1; index >= 0; index--) {
                const [key, value] = children[index]!;
                if (value === null || typeof value !== "object") continue;
                const childPath = Array.isArray(parent) ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
                stack.push(value); paths.push(childPath);
              }
              if (parent !== entry.value) visit({ value: parent, path });
            }
          }
        }
        current = next;
      }
      for (const entry of current) add(entry.value, entry.path);
      break;
    }
    case "bodyXml": {
      if (response.textAvailable === false) throw new AssertionValueError("RESPONSE_UNAVAILABLE", "Reliable XML is unavailable", "assertion");
      try {
        const result = xpath.useNamespaces(selector.namespaces ?? {})(selector.path!, parsed(response, "xml") as Node);
        const values = Array.isArray(result) ? result : [result];
        for (const value of values) {
          if (typeof value === "number" && !Number.isFinite(value)) throw new AssertionValueError("SELECTOR_VALUE", "XPath returned a non-finite number", "assertion");
          if (value !== undefined && value !== null) add(typeof value === "object" ? value.textContent ?? "" : value, selector.path!);
        }
      } catch (error) {
        if (error instanceof AssertionValueError) throw error;
        throw new AssertionValueError("SELECTOR_SYNTAX", `XPath selection failed: ${String(error)}`);
      }
      break;
    }
  }
  return hits.length === 0 ? { found: false } : {
    found: true, value: selector.match === "all" ? hits.map((hit) => hit.value) : hits[0]!.value,
    sourcePath: hits[0]!.path,
  };
}
