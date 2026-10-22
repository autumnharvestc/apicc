import type { DeepReadonly } from "../assets/context.js";
import type { JsonValue } from "../contract/schemaNode.js";
import { WorkflowPredicateSchema, WorkflowValueSchema, type WorkflowPredicate, type WorkflowValue } from "./model.js";

export type WorkflowPredicateContext = Readonly<Record<"inputs" | "vars" | "env" | "previous" | "error" | "loop", DeepReadonly<Record<string, JsonValue>>>>;
export type WorkflowPredicateVerdict = { kind: "matched" } | { kind: "pruned" } | { kind: "error"; message: string };
export const WORKFLOW_MISSING = Symbol("workflow missing value");
export function resolveWorkflowValue(value: DeepReadonly<WorkflowValue>, context: WorkflowPredicateContext): DeepReadonly<JsonValue> | typeof WORKFLOW_MISSING {
  const parsed = WorkflowValueSchema.parse(value);
  if (parsed.kind === "literal") return parsed.value;
  let current: DeepReadonly<JsonValue> = context[parsed.source];
  for (const segment of parsed.path) {
    if (current === null || typeof current !== "object") return WORKFLOW_MISSING;
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return WORKFLOW_MISSING;
    current = descriptor.value;
  }
  return current;
}

function jsonEqual(left: DeepReadonly<JsonValue>, right: DeepReadonly<JsonValue>): boolean {
  const pending = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as Record<string, JsonValue>)[key]!, (b as Record<string, JsonValue>)[key]!]);
    }
  }
  return true;
}

/** Validate the bounded whole AST first, then short circuit only valid predicates. */
export function evaluateWorkflowPredicate(predicate: DeepReadonly<WorkflowPredicate>, context: WorkflowPredicateContext): WorkflowPredicateVerdict {
  const parsed = WorkflowPredicateSchema.safeParse(predicate);
  if (!parsed.success) return { kind: "error", message: "Invalid workflow predicate structure or budget" };
  const evaluate = (node: WorkflowPredicate): boolean => {
    if (node.op === "not") return !evaluate(node.item);
    if (node.op === "and" || node.op === "or") return node.op === "and" ? node.items.every(evaluate) : node.items.some(evaluate);
    if (node.op === "exists" || node.op === "notExists") {
      const exists = resolveWorkflowValue(node.value, context) !== WORKFLOW_MISSING;
      return node.op === "exists" ? exists : !exists;
    }
    if (!("left" in node)) throw new Error("Invalid workflow predicate");
    const left = resolveWorkflowValue(node.left, context), right = resolveWorkflowValue(node.right, context);
    if (left === WORKFLOW_MISSING || right === WORKFLOW_MISSING) throw new Error("Workflow comparison references a missing value");
    if (node.op === "eq" || node.op === "neq") return jsonEqual(left, right) === (node.op === "eq");
    if (!((typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string"))) {
      throw new Error("Workflow ordering requires two numbers or two strings of the same type");
    }
    switch (node.op) {
      case "lt": return left < right;
      case "lte": return left <= right;
      case "gt": return left > right;
      case "gte": return left >= right;
    }
  };
  try { return { kind: evaluate(parsed.data) ? "matched" : "pruned" }; }
  catch (error) { return { kind: "error", message: error instanceof Error ? error.message : String(error) }; }
}
