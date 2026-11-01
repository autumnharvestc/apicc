import type { DesktopAiPersonal } from "./personal.js";
import type { DesktopAiSources } from "./sources.js";
import type { AiPrepareInput, AiStartInput, AiBusinessResultDto, AiContextPreviewDto, AiChoicesInput, AiChoicesDto, AiChoicesPageInput, AiChoicesPageDto } from "../../shared/ai/contract.js";
import { AiPrepareSchema, AiStartSchema } from "../../shared/ai/contract.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createAiInvocationHost, resolveAiInvocation, prepareAiContext, inspectAiContextChoices, runAiAssistance, createCredentialOutputSanitizer, type AiContextChoices, type AiContextPreview, type AiResolvedInvocation, type AiResolvedCredentials, type AiBusinessResult } from "@apicc/core";
import { AiApplicationProtectionSchema } from "@apicc/core/schema";
import type { CapturedAiSource } from "./sources.js";

type PreviewRecord = { id: string; selection: AiPrepareInput["selection"]; context: CapturedAiSource; preview: AiContextPreview; resolved: AiResolvedInvocation; revision: number };
type ChoicesRecord = { id: string; input: AiPrepareInput; context: CapturedAiSource; resolved: AiResolvedInvocation; revision: number; metadata: AiContextChoices; totals: { evidence: number; bodies: number }; cursors: Partial<Record<'evidence' | 'bodies', { token: string; offset: number; limit: number }>> };
type OwnerState = { closed: boolean; preparing?: AbortController; preview?: PreviewRecord; choices?: ChoicesRecord; operations: Map<string, AbortController> };
type Credentials = { value: AiResolvedCredentials };
/** Observe late readonly completion/failure, but never hold a cancelled caller open. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const detach = () => signal.removeEventListener("abort", abort);
    const abort = () => { detach(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    promise.then(value => { detach(); if (!signal.aborted) resolve(value); }, error => { detach(); reject(error); });
  });
}
type AuxiliaryDeadline = "connectionTestTimeoutMs" | "modelDiscoveryTimeoutMs";
function publicPreview(record: PreviewRecord): AiContextPreviewDto {
  const p = record.preview, r = record.resolved;
  return structuredClone({ purpose: p.purpose, bytes: p.bytes, source: p.source, evidence: p.evidence, included: p.included, omitted: p.omitted, redaction: p.redaction,
    ...(p.limit !== undefined ? { limit: p.limit } : {}), ...(p.evidenceSelection ? { evidenceSelection: p.evidenceSelection } : {}),
    destination: { baseUrl: r.connection.baseUrl, modelProfileId: r.model.id, modelId: r.model.modelId, protocol: r.model.protocol },
    budgets: r.budgets, budgetSources: r.sources, capabilityStatus: r.capabilityStatus, warnings: r.warnings });
}
function publicResult(result: AiBusinessResult): AiBusinessResultDto {
  const common = { bindingId: result.source.bindingId, purpose: result.purpose, source: result.source, model: result.model, generatedAt: result.generatedAt, timeZone: result.timeZone, label: result.label, ...(result.usage ? { usage: result.usage } : {}) };
  if (result.purpose === "case-suggestion") return { ...common, purpose: result.purpose, cases: result.cases, explanations: result.explanations };
  if (result.purpose === "assertion-suggestion") return { ...common, purpose: result.purpose, assertions: result.assertions, evidence: result.evidence };
  return { ...common, purpose: result.purpose, analysis: result.analysis, evidence: result.evidence, evidenceSelection: result.evidenceSelection };
}
function choicesMetadata(context: CapturedAiSource, input: AiPrepareInput): AiContextChoices {
  return inspectAiContextChoices({ ...context.business, snapshot: context.snapshot, context: context.snapshot.context, source: context.source, bodySelection: input.bodySelection, currentDraft: context.currentDraft });
}
function catalog(metadata: AiContextChoices) {
  return { metadata: { ...metadata, evidence: metadata.evidence.slice(0, 1000), bodies: metadata.bodies.slice(0, 200) }, totals: { evidence: metadata.evidence.length, bodies: metadata.bodies.length } };
}
function publicChoices(record: ChoicesRecord): AiChoicesDto {
  const metadata = record.metadata, r = record.resolved;
  return structuredClone({ choicesId: record.id, source: metadata.source, bodySelection: record.input.bodySelection,
    destination: { baseUrl: r.connection.baseUrl, modelProfileId: r.model.id, modelId: r.model.modelId, protocol: r.model.protocol },
    budgets: r.budgets, budgetSources: r.sources, capabilityStatus: r.capabilityStatus, warnings: r.warnings,
    evidence: choicesPage(record, 'evidence', 20), bodies: choicesPage(record, 'bodies', 20) });
}
function choicesPage<S extends 'evidence' | 'bodies'>(record: ChoicesRecord, section: S, limit: number, offset = 0): Extract<AiChoicesPageDto, { section: S }> {
  const all = record.metadata[section], selectable = all.length, total = record.totals[section], items = all.slice(offset, Math.min(offset + limit, selectable));
  const next = offset + items.length < selectable ? { token: randomUUID(), offset: offset + items.length, limit } : undefined;
  if (next) record.cursors[section] = next; else delete record.cursors[section];
  return structuredClone({ choicesId: record.id, section, items, total, selectable, returned: items.length, omitted: total - selectable, complete: selectable === total,
    ...(next ? { nextCursor: next.token } : {}) }) as unknown as Extract<AiChoicesPageDto, { section: S }>;
}

export function createDesktopAiRuntime(options: { personal: DesktopAiPersonal; sources: DesktopAiSources; fetch?: typeof fetch; onProgress?: (event: import("@apicc/core").AiProgress & { operationId: string }, owner: object) => void }) {
  const owners = new WeakMap<object, OwnerState>();
  const credentials = new AsyncLocalStorage<Credentials>();
  const host = createAiInvocationHost({ fetch: options.fetch, credentials: { async resolve() {
    const current = credentials.getStore(); if (!current) throw new Error("ai-operation-unavailable"); return structuredClone(current.value);
  } } });
  const stateFor = (owner: object) => { let state = owners.get(owner); if (!state) { state = { closed: false, operations: new Map() }; owners.set(owner, state); } if (state.closed) throw new Error("ai-owner-closed"); return state; };
  let operationCount = 0;
  async function owned<T>(operationId: string, owner: object, deadline: AuxiliaryDeadline, work: (signal: AbortSignal, configure: (protection: AiResolvedInvocation["protection"]) => void) => Promise<T>): Promise<T> {
    const state = stateFor(owner);
    if (state.operations.has(operationId)) throw new Error("ai-operation-exists");
    // Before async settings are known, only the existing schema's legal ceilings
    // are authoritative. No guessed default deadline or independent quota.
    const schema = AiApplicationProtectionSchema.shape;
    if (operationCount >= schema.hostConcurrency.maxValue! + schema.hostQueueSize.maxValue!) throw new Error("ai-operation-capacity");
    const startedAt = performance.now();
    const abort = new AbortController(); state.operations.set(operationId, abort); operationCount++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (totalMs: number) => {
      clearTimeout(timer); const remaining = totalMs - (performance.now() - startedAt);
      if (remaining <= 0) abort.abort(new Error("ai-deadline"));
      else timer = setTimeout(() => abort.abort(new Error("ai-deadline")), remaining);
    };
    arm(schema[deadline].maxValue!);
    const configure = (protection: AiResolvedInvocation["protection"]) => {
      abort.signal.throwIfAborted(); arm(protection[deadline]); abort.signal.throwIfAborted();
      if (operationCount > protection.hostConcurrency + protection.hostQueueSize) throw new Error("ai-operation-capacity");
    };
    try { const result = await untilAborted(work(abort.signal, configure), abort.signal); abort.signal.throwIfAborted(); if (state.closed) throw new Error("ai-owner-closed"); return result; }
    finally { clearTimeout(timer); if (state.operations.get(operationId) === abort) state.operations.delete(operationId); operationCount--; }
  }
  async function authenticated<T>(connection: AiResolvedInvocation["connection"], signal: AbortSignal, work: (sanitizer: ReturnType<typeof createCredentialOutputSanitizer>) => Promise<T>): Promise<T> {
    const value = await options.personal.host.credentialResolver.resolve(connection); signal.throwIfAborted();
    const markers = Object.values(value.headers).flatMap(v => /^Bearer /i.test(v) ? [v, v.slice(7)] : [v]);
    const sanitizer = createCredentialOutputSanitizer(markers);
    try { return await credentials.run({ value }, () => work(sanitizer)); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "ai-request-failed";
      throw new Error(sanitizer.redactText(`AI 请求失败（${/^[a-z][a-z0-9-]{0,100}$/.test(code) ? code : "ai-request-failed"}）`));
    } finally { markers.length = 0; }
  }
  async function assertChoicesCurrent(record: ChoicesRecord, signal: AbortSignal) {
    await record.context.assertCurrent(signal);
    if ((await options.personal.repository.read()).revision !== record.revision) throw new Error('ai-configuration-changed');
    await record.context.assertCurrent(signal);
  }
  return {
    async inspectChoices(raw: AiChoicesInput, owner: object): Promise<AiChoicesDto> {
      if (raw.operation === 'bodies') {
        const state = stateFor(owner), record = state.choices;
        if (!record || record.id !== raw.choicesId) throw new Error('ai-choices-unavailable');
        await assertChoicesCurrent(record, new AbortController().signal);
        if (state.choices !== record) throw new Error('ai-choices-unavailable');
        if (raw.bodySelection.some(location => !record.metadata.bodies.slice(0, 200).some(item => item.location === location))) throw new Error('body-selection-unavailable');
        const input = { ...record.input, bodySelection: raw.bodySelection };
        const metadata = choicesMetadata(record.context, input);
        await assertChoicesCurrent(record, new AbortController().signal);
        if (state.choices !== record) throw new Error('ai-choices-unavailable');
        const changed: ChoicesRecord = { ...record, input, ...catalog(metadata), id: randomUUID(), cursors: {} };
        state.choices = changed; state.preview = undefined;
        return publicChoices(changed);
      }
      const input = AiPrepareSchema.parse({ ...raw.input, bodySelection: [] }), state = stateFor(owner);
      state.preparing?.abort(); state.preview = undefined; state.choices = undefined;
      const abort = new AbortController(); state.preparing = abort;
      try {
        const context = await options.sources.capture(input, abort.signal, owner);
        const { document } = await options.personal.host.snapshot();
        const resolved = resolveAiInvocation({ document, purpose: input.selection.business.purpose, projectKey: context.projectKey, modelProfileId: input.modelProfileId });
        const metadata = choicesMetadata(context, input);
        await context.assertCurrent(abort.signal); abort.signal.throwIfAborted();
        if (state.closed || state.preparing !== abort) throw new Error('ai-preview-replaced');
        const record: ChoicesRecord = { id: randomUUID(), input, context, resolved, revision: document.revision, ...catalog(metadata), cursors: {} };
        state.choices = record;
        return publicChoices(record);
      } finally { if (state.preparing === abort) state.preparing = undefined; }
    },
    async readChoicesPage(input: AiChoicesPageInput, owner: object): Promise<AiChoicesPageDto> {
      const state = stateFor(owner), record = state.choices;
      if (!record || record.id !== input.choicesId) throw new Error('ai-choices-unavailable');
      await assertChoicesCurrent(record, new AbortController().signal);
      if (state.choices !== record) throw new Error('ai-choices-unavailable');
      const limit = input.limit ?? 20, cursor = record.cursors[input.section];
      if (input.cursor && (!cursor || cursor.token !== input.cursor || cursor.limit !== limit)) throw new Error('ai-choices-cursor-unavailable');
      return choicesPage(record, input.section, limit, input.cursor ? cursor!.offset : 0);
    },
    async testConnection(input: { operationId: string; modelProfileId: string }, owner: object): Promise<{ ok: true }> {
      return owned(input.operationId, owner, "connectionTestTimeoutMs", async (signal, configure) => {
        const document = await options.personal.repository.read();
        signal.throwIfAborted(); configure(document.application.protection);
        const base = resolveAiInvocation({ document, purpose: "case-suggestion", modelProfileId: input.modelProfileId });
        const resolved = structuredClone(base);
        resolved.budgets = { ...resolved.budgets, deadlineMs: base.protection.connectionTestTimeoutMs, requestTimeoutMs: base.protection.connectionTestTimeoutMs,
          maxOutputTokens: Math.min(16, base.budgets.maxOutputTokens), totalOutputTokens: Math.min(16, base.budgets.maxOutputTokens), maxRequests: 1, transportRetries: 0, repairAttempts: 0 };
        return authenticated(resolved.connection, signal, () => host.run({ resolved, signal }, async session => {
          await session.invoke({ kind: "initial", messages: [{ role: "user", content: 'Return JSON {"ok":true}' }], outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
          return { ok: true as const };
        }));
      });
    },
    async discover(input: { operationId: string; connectionId: string }, owner: object): Promise<import("../../shared/ai/contract.js").AiDiscoverResultDto> {
      return owned(input.operationId, owner, "modelDiscoveryTimeoutMs", async (signal, configure) => {
        const document = await options.personal.repository.read();
        signal.throwIfAborted(); configure(document.application.protection);
        const catalog = await options.personal.catalog(); signal.throwIfAborted();
        const connection = document.connections.find(c => c.id === input.connectionId);
        if (!connection) throw new Error("ai-connection-unavailable");
        const template = catalog.catalog.find(t => t.id === connection.templateSource?.id && t.revision === connection.templateSource.revision);
        if (!template?.modelDiscovery || template.baseUrl !== connection.baseUrl || !isDeepStrictEqual(template.auth, connection.auth)) return { status: "unsupported", models: [], reason: "manual-model-configuration-required" };
        return authenticated(connection, signal, sanitizer =>
          host.runAuxiliary({ connection, protection: document.application.protection, signal, timeoutMs: document.application.protection.modelDiscoveryTimeoutMs }, async session => {
            const raw: unknown = JSON.parse(await session.request());
            if (!raw || typeof raw !== "object" || !("data" in raw) || !Array.isArray(raw.data)) throw new Error("ai-discovery-response-invalid");
            const ids = new Set<string>();
            for (const entry of raw.data) if (entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 256 && !/[\x00-\x1f\x7f]/.test(entry.id) && sanitizer.redactText(entry.id) === entry.id) ids.add(entry.id);
            return { status: "available" as const, models: [...ids].map(id => ({ id })) };
          }));
      });
    },
    async prepare(raw: AiPrepareInput, owner: object): Promise<{ previewId: string; preview: AiContextPreviewDto }> {
      const input = AiPrepareSchema.parse(raw), state = stateFor(owner);
      state.preparing?.abort(); state.preview = undefined;
      const abort = new AbortController(); state.preparing = abort;
      try {
        const choice = input.choicesId ? state.choices : undefined;
        if (input.choicesId && choice?.id !== input.choicesId) throw new Error('ai-choices-unavailable');
        if (choice) {
          await assertChoicesCurrent(choice, abort.signal);
          const { choicesId: _choices, evidenceSelection: _evidence, ...fixed } = input;
          if (!isDeepStrictEqual(fixed, choice.input)) throw new Error('ai-choices-input-changed');
          if (input.evidenceSelection?.some(id => !choice.metadata.evidence.slice(0, 1000).some(item => item.id === id))) throw new Error('evidence-selection-unavailable');
        }
        const context = choice?.context ?? await options.sources.capture(input, abort.signal, owner);
        const { document } = await options.personal.host.snapshot();
        const resolved = choice?.resolved ?? resolveAiInvocation({ document, purpose: input.selection.business.purpose, projectKey: context.projectKey, modelProfileId: input.modelProfileId });
        const preview = prepareAiContext({ ...context.business, snapshot: context.snapshot, context: context.snapshot.context, source: context.source,
          bodySelection: input.bodySelection, maxContextBytes: resolved.budgets.maxInputBytes, candidateCount: resolved.budgets.candidateCount, currentDraft: context.currentDraft,
          ...(context.business.purpose === "report-analysis" ? { evidenceSelection: input.evidenceSelection } : {}),
        });
        await context.assertCurrent(abort.signal); abort.signal.throwIfAborted();
        if (state.closed || state.preparing !== abort) throw new Error("ai-preview-replaced");
        if (choice) await assertChoicesCurrent(choice, abort.signal);
        if (choice && state.choices !== choice) throw new Error("ai-preview-replaced");
        const record: PreviewRecord = { id: randomUUID(), selection: structuredClone(input.selection), context, preview, resolved, revision: document.revision };
        state.preview = record;
        return { previewId: record.id, preview: publicPreview(record) };
      } finally { if (state.preparing === abort) state.preparing = undefined; }
    },
    async start(raw: AiStartInput, owner: object): Promise<AiBusinessResultDto> {
      const input = AiStartSchema.parse(raw), state = stateFor(owner), record = state.preview;
      if (!record || record.id !== input.previewId || !isDeepStrictEqual(record.selection, input.selection)) throw new Error("ai-preview-unavailable");
      if (state.operations.has(input.operationId)) throw new Error("ai-operation-exists");
      if (operationCount >= record.resolved.protection.hostConcurrency + record.resolved.protection.hostQueueSize) throw new Error("ai-operation-capacity");
      state.preview = undefined;
      const abort = new AbortController(); state.operations.set(input.operationId, abort); operationCount++;
      const timer = setTimeout(() => abort.abort(new Error("ai-deadline")), record.resolved.budgets.deadlineMs);
      let markers: string[] = [];
      try {
        await record.context.assertCurrent(abort.signal);
        if ((await options.personal.repository.read()).revision !== record.revision) throw new Error("ai-configuration-changed");
        const value = await options.personal.host.credentialResolver.resolve(record.resolved.connection);
        markers = Object.values(value.headers).flatMap(v => /^Bearer /i.test(v) ? [v, v.slice(7)] : [v]);
        abort.signal.throwIfAborted();
        const result = await credentials.run({ value }, () => runAiAssistance(record.preview, record.resolved, host, { signal: abort.signal,
          onProgress: event => { if (!state.closed && !abort.signal.aborted) options.onProgress?.({ operationId: input.operationId, phase: event.phase, attempt: event.attempt, ...(event.receivedBytes !== undefined ? { receivedBytes: event.receivedBytes } : {}) }, owner); },
        }));
        await record.context.assertCurrent(abort.signal);
        if (state.closed) throw new Error("ai-owner-closed");
        return createCredentialOutputSanitizer(markers).redactValue(publicResult(result));
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : "ai-operation-failed";
        throw new Error(createCredentialOutputSanitizer(markers).redactText(/^[a-z][a-z0-9-]{0,100}$/.test(code) ? `AI 辅助失败（${code}）` : "AI 辅助失败，请检查个人设置和来源后重试"));
      } finally { clearTimeout(timer); state.operations.delete(input.operationId); operationCount--; markers = []; }
    },
    cancel(operationId: string, owner: object): { cancelled: boolean } {
      const abort = owners.get(owner)?.operations.get(operationId);
      if (!abort) return { cancelled: false }; abort.abort(new Error("ai-cancelled")); return { cancelled: true };
    },
    clearOwner(owner: object): void {
      options.sources.clearOwner(owner);
      let state = owners.get(owner);
      if (!state) { state = { closed: true, operations: new Map() }; owners.set(owner, state); }
      state.closed = true; state.preparing?.abort(); state.preview = undefined; state.choices = undefined;
      for (const abort of state.operations.values()) abort.abort(new Error("ai-owner-closed"));
    },
  };
}
export type DesktopAiRuntime = ReturnType<typeof createDesktopAiRuntime>;
