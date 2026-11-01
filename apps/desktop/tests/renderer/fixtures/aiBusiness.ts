import { resolveAiInvocation } from '@apicc/core/ai/config';
import type { AiConfigDocument, AiBusinessResult } from '@apicc/core';
import type { AiContextPreviewDto, AiPrepareInput, AiStartInput, AiChoicesDto, AiChoicesPageDto } from '../../../src/shared/ai/contract.js';
import { AiPrepareSchema, AiStartSchema } from '../../../src/shared/ai/contract.js';
import { AI_FIXTURE_SUGGESTIONS } from '../../../src/renderer/src/api/memory.js';
import { createSafeAiSettingsFixture } from './aiSettings.js';
import { useWorkspaceStore } from '../../../src/renderer/src/stores/workspace.js';
import { useEditorStore } from '../../../src/renderer/src/stores/editor.js';
import { createAiStore } from '../../../src/renderer/src/stores/ai.js';
import type { LocalTreeNodeDTO } from '../../../src/shared/tree-dto.js';

export const assertionCandidate = { assertion: { id: 'native-ai-assertion', target: 'bodyJson' as const, path: '$.customer.region', op: 'eq', expected: 'north' },
  basis: 'contract' as const, reason: 'Region is required by the API contract', evidenceIds: ['contract:e1'], requiresUserJudgment: false };
export const analysisEvidence = [
  { purpose: 'report-analysis' as const, id: 'logic:e1', kind: 'logical-summary', location: 'reportingUnits', state: 'collected' as const, value: { total: 1, passed: 1, failed: 0, skipped: 0 } },
  { purpose: 'report-analysis' as const, id: 'request:e1', kind: 'request-summary', location: 'requestFacts', state: 'not-collected' as const, value: null },
  { purpose: 'report-analysis' as const, id: 'debug:e1', kind: 'debug-failure', location: 'failure', state: 'collected' as const, value: { failureKind: 'network', error: 'Synthetic transport refused', errorName: 'TransportError' } },
];
export const analysisDraft = { conclusion: 'Review the transport failure separately from logical success', observedFacts: analysisEvidence,
  possibleCauses: [{ text: 'The isolated test endpoint may be unavailable', confidence: 'possible' as const, evidenceIds: ['debug:e1'] }],
  checks: [{ text: 'Inspect the existing transport evidence', evidenceIds: ['debug:e1'] }], limitations: ['Request facts were not collected'] };

/** Only the external trusted-host boundary is replaced; editor/store/components stay real. */
export function createAiBusinessFixture() {
  const settings = createSafeAiSettingsFixture();
  const prepared: AiPrepareInput[] = [], started: AiStartInput[] = [];
  let preview: AiContextPreviewDto | null = null;
  let choices: AiChoicesDto | null = null;
  settings.api.aiInspectChoices = async input => {
    if (input.operation === 'bodies') {
      if (!choices) throw new Error('fixture-choices-required');
      choices = { ...choices, choicesId: crypto.randomUUID(), bodySelection: [...input.bodySelection] };
      return structuredClone(choices);
    }
    const view = settings.read(), document: AiConfigDocument = { formatVersion: 1, revision: view.revision, application: view.application,
      connections: view.connections.map(({ credentialState: _state, ...connection }) => connection), models: view.models, bindings: view.bindings, projectOverrides: view.projectOverrides };
    const resolved = resolveAiInvocation({ document, purpose: input.input.selection.business.purpose, modelProfileId: input.input.modelProfileId ?? 'model-a' });
    const source = input.input.selection.source, id = crypto.randomUUID();
    const evidence = input.input.selection.business.purpose === 'report-analysis' ? analysisEvidence.map(({ id, kind, location, state }) => ({ id, kind, location, state }))
      : [{ id: `contract:${input.input.selection.business.target.apiId}`, kind: 'contract', location: 'contract', state: 'collected' as const }];
    const body = input.input.selection.business.purpose === 'report-analysis' ? 'cases[0].evidence.response.body' : 'contract:request-body';
    choices = { choicesId: id, source: { bindingId: 'fixture-binding', kind: source.kind, projectId: source.kind === 'local' ? source.project.projectId : source.context.scope.projectId,
      definitionRevision: 'fixture-definition', editRevision: input.input.selection.editGeneration, unsaved: !!input.input.currentDraft }, bodySelection: [],
      destination: { baseUrl: resolved.connection.baseUrl, modelProfileId: resolved.model.id, modelId: resolved.model.modelId, protocol: resolved.model.protocol },
      budgets: resolved.budgets, budgetSources: resolved.sources, capabilityStatus: resolved.capabilityStatus, warnings: [],
      evidence: { choicesId: id, section: 'evidence', items: evidence, total: evidence.length, selectable: evidence.length, returned: evidence.length, omitted: 0, complete: true },
      bodies: { choicesId: id, section: 'bodies', items: [{ location: body, kind: body === 'contract:request-body' ? 'contract-request' : 'response', available: true }], total: 1, selectable: 1, returned: 1, omitted: 0, complete: true } };
    return structuredClone(choices);
  };
  settings.api.aiReadChoicesPage = async input => {
    if (!choices) throw new Error('fixture-choices-required');
    return structuredClone(choices[input.section]) as AiChoicesPageDto;
  };
  settings.api.aiPrepareAssistance = async raw => {
    const input = AiPrepareSchema.parse(raw); prepared.push(input);
    const view = settings.read();
    const document: AiConfigDocument = { formatVersion: 1, revision: view.revision, application: view.application,
      connections: view.connections.map(({ credentialState: _state, ...connection }) => connection),
      models: view.models, bindings: view.bindings, projectOverrides: view.projectOverrides };
    const resolved = resolveAiInvocation({ document, purpose: input.selection.business.purpose, modelProfileId: input.modelProfileId ?? 'model-a' });
    const source = input.selection.source;
    preview = {
      purpose: input.selection.business.purpose, bytes: 1234,
      source: { bindingId: 'fixture-binding', kind: source.kind,
        projectId: source.kind === 'local' ? source.project.projectId : source.context.scope.projectId,
        definitionRevision: 'fixture-definition', editRevision: input.selection.editGeneration, unsaved: !!input.currentDraft,
        ...(input.selection.business.purpose !== 'report-analysis' ? { target: input.selection.business.target } : {}) },
      evidence: input.selection.business.purpose === 'report-analysis' ? analysisEvidence : [], included: ['contract'], omitted: [{ item: 'scripts', reason: 'default-omitted' }],
      redaction: { strategy: 'heuristic', limitations: ['review-before-send'] }, limit: 5,
      destination: { baseUrl: resolved.connection.baseUrl, modelProfileId: resolved.model.id, modelId: resolved.model.modelId, protocol: resolved.model.protocol },
      budgets: resolved.budgets, budgetSources: resolved.sources, capabilityStatus: resolved.capabilityStatus, warnings: [],
    };
    return { previewId: '00000000-0000-4000-8000-000000000011', preview };
  };
  settings.api.aiStart = async raw => {
    const input = AiStartSchema.parse(raw); started.push(input);
    if (!preview) throw new Error('fixture-preview-required');
    const metadata = { bindingId: preview.source.bindingId, source: preview.source,
      model: { profileId: 'model-a', modelId: 'manual-model-A', connectionId: 'personal-primary' },
      generatedAt: '2026-10-31T01:02:03.004Z', timeZone: 'UTC' as const, label: 'AI 辅助' as const };
    if (input.selection.business.purpose === 'assertion-suggestion') return { ...metadata, purpose: 'assertion-suggestion', assertions: [structuredClone(assertionCandidate)], evidence: [] };
    if (input.selection.business.purpose === 'report-analysis') return { ...metadata, purpose: 'report-analysis', analysis: structuredClone(analysisDraft), evidence: structuredClone(analysisEvidence), evidenceSelection: { selected: 3, total: 3, omitted: 0 } };
    return { ...metadata, purpose: 'case-suggestion', cases: structuredClone([...AI_FIXTURE_SUGGESTIONS]), explanations: [] };
  };
  return { ...settings, prepared, started };
}

export async function seedAiBusinessFixture() {
  const fixture = createAiBusinessFixture(); fixture.api.seedWorkspace();
  const workspace = useWorkspaceStore(fixture.api); await workspace.open('/tmp/ws');
  const firstApi = (node: LocalTreeNodeDTO): Extract<LocalTreeNodeDTO, { kind: 'api' }> | undefined => {
    if (node.kind === 'api') return node;
    if ('children' in node) for (const child of node.children ?? []) { const found = firstApi(child); if (found) return found; }
  };
  const node = firstApi(workspace.tree!); if (!node) throw new Error('missing seeded API');
  const editor = useEditorStore(fixture.api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
  await editor.load(node.locator);
  const ai = createAiStore({ api: fixture.api, editor, getContext: () => ({ root: workspace.root, readOnly: workspace.readOnly }) });
  await ai.init();
  return { ...fixture, workspace, editor, ai };
}

export function fixtureBusinessResult(purpose: 'assertion-suggestion' | 'report-analysis'): AiBusinessResult & { bindingId: string } {
  const common = { bindingId: 'fixture-binding', source: { bindingId: 'fixture-binding', kind: 'local' as const, projectId: 'fixture-project', definitionRevision: 'fixture-definition', editRevision: 1, unsaved: false },
    model: { profileId: 'model-a', modelId: 'manual-model-A', connectionId: 'personal-primary' }, generatedAt: '2026-10-31T01:02:03.004Z', timeZone: 'UTC' as const, label: 'AI 辅助' as const };
  return purpose === 'assertion-suggestion' ? { ...common, purpose, assertions: [structuredClone(assertionCandidate)], evidence: [] }
    : { ...common, purpose, analysis: structuredClone(analysisDraft), evidence: structuredClone(analysisEvidence), evidenceSelection: { selected: 3, total: 3, omitted: 0 } };
}
