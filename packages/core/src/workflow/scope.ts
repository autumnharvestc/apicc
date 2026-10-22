import type { DeepReadonly } from "../assets/context.js";
import { JsonValueSchema, StringRecordSchema, type JsonValue } from "../contract/schemaNode.js";
import { createExtractionRuntimeState, type ExtractionBinding } from "../testing/extraction.js";
import type { WorkflowPredicateContext } from "./predicate.js";

/** Internal tombstone. Never project this marker into a report or public JSON DTO. */
export const WORKFLOW_DELETE = Symbol("workflow variable deleted");
export type WorkflowScopeWrite = DeepReadonly<JsonValue> | typeof WORKFLOW_DELETE;
export interface WorkflowScopeWrites {
  vars?: Readonly<Record<string, WorkflowScopeWrite>>;
  extractions?: Readonly<Record<string, ExtractionBinding | typeof WORKFLOW_DELETE>>;
}
function copy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(copy)) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))) as T;
}
const view = (value: unknown): WorkflowPredicateContext["vars"] => copy(StringRecordSchema(JsonValueSchema).parse(value));

/** A frame owns all values. fork copies state; only explicitly staged writes may commit. */
export function createWorkflowScope(initial: Partial<WorkflowPredicateContext> = {}) {
  return new WorkflowScope(initial);
}
export class WorkflowScope {
  readonly extractions = createExtractionRuntimeState();
  private readonly vars = new Map<string, DeepReadonly<JsonValue>>();
  private readonly writes = new Map<string, WorkflowScopeWrite>();
  private readonly inheritedExtractions = new Map<string, ExtractionBinding>();
  private readonly invalidated = new Set<string>();
  private readonly views: { -readonly [Key in Exclude<keyof WorkflowPredicateContext, "vars">]: WorkflowPredicateContext[Key] };
  constructor(initial: Partial<WorkflowPredicateContext> = {}) {
    this.views = { inputs: view(initial.inputs ?? {}), env: view(initial.env ?? {}), previous: view(initial.previous ?? {}), error: view(initial.error ?? {}), loop: view(initial.loop ?? {}) };
    for (const [key, value] of Object.entries(view(initial.vars ?? {}))) this.vars.set(key, value);
  }
  context(): WorkflowPredicateContext {
    const variables = new Map(this.vars);
    for (const [name, binding] of this.extractions.bindings) variables.set(name, copy(binding.value));
    return Object.freeze({ ...this.views, vars: copy(Object.fromEntries(variables)) });
  }
  setPrevious(previous: WorkflowPredicateContext["previous"]): void { this.views.previous = view(previous); }
  setLoop(loop: WorkflowPredicateContext["loop"]): void { this.views.loop = view(loop); }
  fork(): WorkflowScope {
    const child = createWorkflowScope({ ...this.views, vars: Object.fromEntries(this.vars) });
    for (const [name, binding] of this.extractions.bindings) {
      const cloned = copy(binding);
      child.extractions.bindings.set(name, cloned);
      child.inheritedExtractions.set(name, cloned);
    }
    return child;
  }
  /** Validate and copy the whole batch before modifying this frame. */
  stage(batch: WorkflowScopeWrites): void {
    const values = Object.entries(batch.vars ?? {}).map(([name, value]) => [name, value === WORKFLOW_DELETE ? value : copy(JsonValueSchema.parse(value))] as const);
    const bindings = Object.entries(batch.extractions ?? {}).map(([name, binding]) => [name, binding === WORKFLOW_DELETE ? binding : copy({ ...binding, value: JsonValueSchema.parse(binding.value) })] as const);
    for (const [name, value] of values) {
      this.writes.set(name, value);
      if (value === WORKFLOW_DELETE) this.vars.delete(name); else this.vars.set(name, value);
      // An explicit assignment supersedes an older extraction of the same name.
      this.extractions.bindings.delete(name);
    }
    for (const [name, binding] of bindings) {
      if (binding === WORKFLOW_DELETE) { this.extractions.bindings.delete(name); this.invalidated.add(name); }
      else this.extractions.bindings.set(name, binding);
    }
  }
  invalidateExtractions(names: readonly string[]): void { for (const name of names) this.invalidated.add(name); }
  /** Failed requests publish only extractor invalidation, never positive attempt writes. */
  commitOutputs(target: WorkflowScope, options: { failed?: boolean } = {}): void {
    const changed = new Map<string, ExtractionBinding | typeof WORKFLOW_DELETE>();
    if (options.failed) {
      for (const name of this.invalidated) changed.set(name, WORKFLOW_DELETE);
    } else {
      for (const name of this.inheritedExtractions.keys()) if (!this.extractions.bindings.has(name)) changed.set(name, WORKFLOW_DELETE);
      for (const name of this.invalidated) if (!this.extractions.bindings.has(name)) changed.set(name, WORKFLOW_DELETE);
      for (const [name, binding] of this.extractions.bindings) if (binding !== this.inheritedExtractions.get(name)) changed.set(name, binding);
    }
    target.stage({ vars: options.failed ? {} : Object.fromEntries(this.writes), extractions: Object.fromEntries(changed) });
  }
  runtimeVariables(): Record<string, string> {
    return Object.fromEntries([...this.vars].map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]));
  }
}
