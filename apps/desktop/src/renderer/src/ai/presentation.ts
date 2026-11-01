import type { AiEvidence, AiSourceSummary } from '@apicc/core';
import type { StressNumericMetric, StressPlan } from '@apicc/core/schema';

type Translate = (key: string) => string;
export interface AiFactRow { label: string; value: string }
export const aiSafeFact = (fact: AiEvidence) => !['body', 'body-text'].includes(fact.kind) && !/\.body(?:$|\.)/.test(fact.location);
/** Program truth is independent of which evidence the model happened to cite. */
export function aiProgramFacts(evidence: readonly AiEvidence[], cited: readonly AiEvidence[]): AiEvidence[] {
  return [...new Map([...evidence, ...cited].filter(aiSafeFact).map(item => [item.id, item])).values()];
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const codeLabel = (value: string, t: Translate) => {
  if (value === 'environment-definition-not-compared') return t('stressPresentation.environmentNotice');
  if (Object.hasOwn(metricUnavailableCodes, value)) return t(`stressFinal.codes.${metricUnavailableCodes[value as keyof typeof metricUnavailableCodes]}`);
  if (stressCodes.has(value)) return t(`stressPresentation.codes.${value}`);
  if (comparisonCodes.has(value)) return t(`stressPresentation.coreReasons.${value}`);
  if (['passed', 'failed', 'incomplete', 'aborted', 'no-data'].includes(value)) return t(`stress.workbench.verdict.${value}`);
  if (['transport', 'http', 'script', 'assertion', 'extraction', 'config'].includes(value)) return t(`stress.failure.${value}`);
  return reasons[value] ? t(`ai.factReasons.${reasons[value]}`) : value;
};
type RemainingMetricReason = Exclude<Extract<StressNumericMetric, { availability: 'unavailable' }>['reason'], 'no-data' | 'incomplete' | 'not-collected'>;
const metricUnavailableCodes: Record<RemainingMetricReason, string> = {
  'budget-exhausted': 'budget-exhausted', overflow: 'overflow', unaligned: 'unaligned', legacy: 'legacy',
};
const stressCodes = new Set(['setup', 'vu-setup', 'warmup', 'measurement', 'drain', 'vu-teardown', 'teardown', 'vuSetup', 'vuTeardown', 'worker-missing', 'worker-failed', 'worker-incompatible', 'timeline-unaligned', 'phase-window-missing', 'metrics-budget-exhausted', 'histogram-overflow', 'snapshot-missing', 'snapshot-duplicate', 'snapshot-invalid', 'dropped', 'cancelled', 'drain-timeout', 'warmup-drain-timeout', 'setup-failed', 'vu-setup-failed', 'teardown-failed', 'vu-teardown-failed', 'policy-limited', 'resource-saturated', 'execution-failed', 'available', 'partial', 'unavailable', 'exact-nearest-rank', 'log-histogram']);
const comparisonCodes = new Set(['project-identity', 'target', 'environment', 'load', 'connection', 'data', 'statistics', 'report-version', 'revision-changed', 'legacy-metadata-unavailable', 'incomplete-run', 'environment-definition-not-compared']);
export function aiTime(value: string | number, t: Translate): string {
  return Number.isFinite(new Date(value).getTime()) ? `${new Date(value).toISOString()} (UTC)` : t('ai.notCollected');
}
export interface AiSourceSection { label: string; rows: AiFactRow[] }
export function aiSourceSections(source: AiSourceSummary, t: Translate): AiSourceSection[] {
  const row = (key: string, value: unknown): AiFactRow => ({ label: t(`ai.${key}`), value: value === null || value === undefined ? t('ai.notCollected') : String(value) });
  const sections: AiSourceSection[] = [{ label: t('ai.selectedSource'), rows: [row('sourceType', t(source.kind === 'online' ? 'ai.onlineSource' : 'ai.localSource')), row('project', source.projectId), row('revision', source.definitionRevision), row('editRevision', source.editRevision), row('draftState', t(source.unsaved ? 'ai.unsavedDraft' : 'ai.savedSource')),
    ...(source.projectVersion === undefined ? [] : [row('projectVersion', source.projectVersion)])] }];
  if (source.target) sections[0]!.rows.push(...Object.entries(source.target).map(([key, value]) => row(`sourceFields.${key}`, Array.isArray(value) ? value.join(' / ') : value)));
  if (source.observation) sections.push({ label: t('ai.observationSource'), rows: [row('reportId', source.observation.reportId), row('sourceFields.caseIndex', source.observation.caseIndex), row('revision', source.observation.definitionRevision)] });
  for (const [role, report] of [['selectedReport', source.report], ['baselineReport', source.comparison?.baseline], ['candidateReport', source.comparison?.candidate]] as const) if (report) {
    const summary = record(report.summary), counts: AiFactRow[] = [];
    // The safe source summary has three real populations: logical units, v2 iterations, or legacy case rows.
    if ('planned' in summary || 'totalRequests' in summary) counts.push(...stressFactRows({ purpose: 'report-analysis', id: '', location: '', state: 'collected', kind: 'planned' in summary ? 'stress-iterations' : 'stress-legacy', value: summary }, t));
    else for (const key of ['total', 'passed', 'failed', 'skipped', 'entryDiagnostics']) if (key in summary) {
      counts.push({ label: key === 'entryDiagnostics' ? t('ai.entryDiagnostics') : t(`ai.factFields.${key}`), value: String(summary[key]) });
    }
    sections.push({ label: t(`ai.${role}`), rows: [row('reportId', report.reportId), row('revision', report.definitionRevision), row('formatVersion', report.formatVersion),
      row('sourceFields.startedAt', aiTime(report.startedAt, t)), row('sourceFields.finishedAt', aiTime(report.finishedAt, t)), ...counts] });
  }
  return sections;
}
const titles: Record<string, string> = {
  'logical-summary': 'logicalFacts', 'request-summary': 'requestFacts', 'debug-failure': 'debugFailure', 'debug-warnings': 'debugWarnings',
  'stress-metrics': 'metrics', 'stress-completeness': 'completeness', 'stress-verdict': 'verdict', 'stress-statistics': 'statistics',
  'stress-load': 'load', 'stress-phases': 'phases', 'stress-timeline': 'timeline', 'stress-nodes': 'nodes', 'stress-lifecycle': 'lifecycle',
  'stress-iterations': 'iterations', 'stress-case-rows': 'caseRows', 'stress-requests': 'requestFacts', 'stress-http-exchanges': 'httpExchanges',
  'stress-plan': 'plan', 'stress-legacy': 'legacy', 'debug-completeness': 'completeness', 'debug-revisions': 'revisions',
  'debug-outcome': 'caseRows', 'debug-exchange': 'httpExchanges', 'case-outcome': 'caseRows', 'trace-summary': 'trace', 'trace-event': 'trace',
  'evidence-state': 'evidence', 'execution-identity': 'identity', request: 'request', 'response-status': 'response', 'response-headers': 'response',
  timings: 'timings', suite: 'suite', workflow: 'workflow', 'workflow-units': 'workflow', comparison: 'comparison', 'body-text': 'bodyOmitted',
};
export function aiFactTitle(evidence: AiEvidence, t: Translate): string { return titles[evidence.kind] ? t(`ai.factKinds.${titles[evidence.kind]}`) : evidence.kind; }
const identityLabels: Record<string, string> = {
  projectId: 'ai.identityFields.projectId', definitionRevision: 'ai.identityFields.definitionRevision', suiteRunId: 'ai.identityFields.suiteRunId',
  entryId: 'ai.identityFields.entryId', suiteRow: 'ai.identityFields.suiteRow', rowIndex: 'ai.identityFields.rowIndex', dataDigest: 'ai.identityFields.dataDigest', locator: 'ai.identityFields.locator',
  collectionId: 'ai.sourceFields.collectionId', folderIds: 'ai.sourceFields.folderIds', apiId: 'ai.sourceFields.apiId', caseId: 'ai.sourceFields.caseId', scope: 'ai.sourceFields.scope',
};
const labels: Record<string, string> = {
  total: 'total', passed: 'passed', failed: 'failed', skipped: 'skipped', requestStarted: 'requestStarted', requestCompleted: 'requestCompleted', httpExchanges: 'httpExchanges',
  failureKind: 'failureKind', errorName: 'errorName', error: 'error', warning: 'warning', execution: 'execution', metrics: 'metrics', load: 'load',
  complete: 'complete', reasons: 'reasons', rps: 'rps', latency: 'latency', scriptLatency: 'scriptLatency', iterationLatency: 'iterationLatency',
  availability: 'availability', reason: 'reason', value: 'value', status: 'status', verdict: 'verdict', durationMs: 'durationMs', startedAt: 'startedAt', finishedAt: 'finishedAt',
  started: 'started', completed: 'completed', eligibleCompleted: 'eligibleCompleted', aborted: 'aborted', dropped: 'dropped', planned: 'planned',
  state: 'state', truncated: 'truncated', bodyUnavailable: 'bodyUnavailable', totalEvents: 'totalEvents', type: 'type', message: 'message',
  apiName: 'apiName', caseName: 'caseName', method: 'method', url: 'url', transportState: 'transportState', failureStage: 'failureStage', failureCode: 'failureCode',
  name: 'name', phase: 'phase', stageId: 'stageId', min: 'min', max: 'max', mean: 'mean', p50: 'p50', p90: 'p90', p95: 'p95', p99: 'p99',
};
const reasons: Record<string, string> = { cancelled: 'cancelled', 'snapshot-missing': 'snapshotMissing', 'insufficient-samples': 'insufficientSamples',
  'not-collected': 'notCollected', unavailable: 'notCollected', available: 'available', passed: 'passed', failed: 'failed', skipped: 'skipped' };
/** Explicit Core stress populations; no arbitrary object/key walk or guessed units. */
function stressFactRows(evidence: AiEvidence, t: Translate): AiFactRow[] {
  const rows: AiFactRow[] = [], value = record(evidence.value);
  const label = (key: string) => key === 'avg' ? t('ai.factFields.mean') : key === 'method' ? t('ai.statisticalMethod')
    : ['startTarget', 'stageTarget'].includes(key) ? t(`stress.workbench.${key}`)
    : ['collectionId', 'apiId', 'caseId', 'scope'].includes(key) ? t(`ai.sourceFields.${key}`) : t(`ai.factFields.${key}`);
  const add = (path: string, key: string, item: unknown, unit = '') => {
    let text = item === null || item === undefined ? t('ai.notComputable') : typeof item === 'boolean' ? t(item ? 'ai.yes' : 'ai.no') : typeof item === 'string' && ['availability', 'reason', 'phase', 'role', 'state', 'status', 'failureKind', 'method'].includes(key) ? codeLabel(item, t) : String(item);
    if (typeof item === 'number') text = `${unit === '%' ? Number((item * 100).toFixed(4)) : Number(item.toFixed(4))}${unit ? ` ${unit}` : ''}`;
    rows.push({ label: [path, label(key)].filter(Boolean).join(' · '), value: text });
  };
  const fields = (data: Record<string, unknown>, path: string, keys: string[]) => { for (const key of keys) if (key in data) add(path, key, data[key], key.endsWith('Ms') ? 'ms' : key === 'rate' ? t('stressPresentation.iterationUnit') : ''); };
  const metric = (raw: unknown, path: string, unit: string) => {
    const data = record(raw);
    if (raw === null || raw === undefined) { add(path, 'availability', null); return; }
    if (data.availability !== 'available') { add(path, 'availability', data.reason ?? 'not-collected'); return; }
    if (typeof data.value === 'number') rows.push({ label: ['rps', 'targetArrivalRate', 'actualStartRate'].includes(path) ? label(path) : path, value: `${Number(data.value.toFixed(4))} ${unit}` });
    else for (const key of ['min', 'max', 'avg', 'mean', 'p50', 'p90', 'p95', 'p99']) if (key in record(data.value)) add(path, key, record(data.value)[key], 'ms');
  };
  const counts = (raw: unknown, path: string, population: 'iterations' | 'requests' | 'exchanges') => {
    const data = record(raw);
    for (const key of population === 'iterations' ? ['planned', 'started', 'completed', 'passed', 'failed', 'aborted', 'dropped'] : population === 'requests' ? ['started', 'completed', 'eligibleCompleted', 'failed'] : ['started', 'completed']) {
      if (key in data) add(path, ['started', 'completed'].includes(key) ? `${population}${key === 'started' ? 'Started' : 'Completed'}` : key, data[key]);
    }
  };
  const caseRows = (raw: unknown, path: string) => {
    const data = record(raw); fields(data, path, ['total', 'ok', 'failed']);
    for (const kind of ['transport', 'http', 'script', 'assertion', 'extraction', 'config', 'aborted']) if (kind in record(data.failures)) rows.push({ label: `${path} · ${codeLabel(kind, t)}`, value: String(record(data.failures)[kind]) });
  };
  const observations = (raw: unknown, path: string) => {
    const data = record(raw); counts(data.requests, `${path} · ${t('ai.requestFacts')}`, 'requests'); counts(data.httpExchanges, `${path} · ${t('ai.factKinds.httpExchanges')}`, 'exchanges');
    caseRows(data.caseRows, `${path} · ${t('ai.factKinds.caseRows')}`); metric(data.latency, `${path} · ${label('latency')}`, 'ms');
    if ('rps' in data) metric(data.rps, `${path} · ${label('rps')}`, t('stressPresentation.rpsUnit'));
  };
  switch (evidence.kind) {
    case 'stress-iterations': counts(value, '', 'iterations'); metric(value.latency, label('iterationLatency'), 'ms'); metric(value.startDelay, label('startDelay'), 'ms'); break;
    case 'stress-requests': counts(value, '', 'requests'); break;
    case 'stress-http-exchanges': counts(value, '', 'exchanges'); break;
    case 'stress-case-rows': caseRows(value, ''); break;
    case 'stress-statistics':
      fields(value, '', ['method', 'exact', 'minValueMs', 'gamma', 'bucketCount', 'exactLimit', 'underflow', 'overflow']); add('', 'relativeError', value.relativeError, '%'); break;
    case 'stress-metrics':
      metric(value.rps, 'rps', t('stressPresentation.rpsUnit')); for (const key of ['latency', 'scriptLatency', 'iterationLatency']) metric(value[key], label(key), 'ms'); break;
    case 'stress-completeness':
      for (const part of ['execution', 'metrics', 'load']) { const data = record(value[part]); add(label(part), 'complete', data.complete); for (const reason of list(data.reasons)) add(label(part), 'reason', reason); } break;
    case 'stress-phases':
      list(evidence.value).forEach((raw, index) => { const data = record(raw), path = `${t('ai.factKinds.phases')} ${index + 1}`;
        fields(data, path, ['phase', 'stageId', 'startOffsetMs', 'endOffsetMs', 'durationMs']); observations(data, path); }); break;
    case 'stress-timeline':
      fields(value, '', ['bucketWidthMs', 'aligned', 'uncertaintyMs']);
      list(value.buckets).forEach((raw, index) => { const data = record(raw), path = `${label('timeBucket')} ${index + 1}`;
        fields(data, path, ['startOffsetMs', 'endOffsetMs']); observations(data, path);
        list(data.sources).forEach((source, sourceIndex) => { const item = record(source), prefix = `${path} · ${label('source')} ${sourceIndex + 1}`; fields(item, prefix, ['phase', 'stageId']); counts(item.requests, prefix, 'requests'); }); }); break;
    case 'stress-load':
      fields(value, '', ['plannedDurationMs', 'measurementDurationMs', 'drainDurationMs', 'policyLimitedMs', 'saturated', 'maxVus', 'maxRequestConcurrency', 'requestedMaxRequestConcurrency']);
      for (const key of ['requestedMaxRps', 'effectiveMaxRps']) if (key in value) add('', key, value[key] === null ? t('stressPresentation.noRpsLimit') : value[key], t('stressPresentation.rpsUnit'));
      for (const key of ['targetArrivalRate', 'actualStartRate']) if (key in value) metric(value[key], key, t('stressPresentation.iterationUnit')); break;
    case 'stress-lifecycle':
      list(evidence.value).forEach((raw, index) => fields(record(raw), `${t('ai.factKinds.lifecycle')} ${index + 1}`, ['role', 'vuId', 'state', 'durationMs', 'failureKind'])); break;
    case 'stress-nodes':
      list(evidence.value).forEach((raw, index) => { const data = record(raw), path = `${t('ai.factKinds.nodes')} ${index + 1}`;
        fields(data, path, ['workflowId', 'nodeId', 'other', 'visits', 'passed', 'failed', 'aborted', 'skipped']); counts(data.requests, path, 'requests');
        metric(data.requestLatency, `${path} · ${label('latency')}`, 'ms'); metric(data.nodeLatency, `${path} · ${label('nodeLatency')}`, 'ms'); }); break;
    case 'stress-verdict':
      fields(value, '', ['status', 'passed']); list(value.violations).forEach((raw, index) => { const data = record(raw), path = `${label('thresholdViolation')} ${index + 1}`, name = String(data.metric);
        rows.push({ label: path, value: t(`stress.metric.${name}`) });
        for (const key of ['actual', 'expected']) add(path, key, data[key], name.endsWith('Rate') ? '%' : name === 'p95' ? 'ms' : name === 'rps' ? t('stressPresentation.rpsUnit') : ''); }); break;
    case 'stress-plan': {
      fields(value, '', ['name', 'connectionMode', 'maxVus', 'maxRequestConcurrency', 'warmupMs', 'thinkTimeMs', 'pacingMs', 'gracefulStopMs']);
      fields(record(value.target), label('target'), ['kind', 'workflowId', 'collectionId', 'apiId', 'caseId', 'scope']);
      const load = value.load as StressPlan['load'];
      fields(record(load), label('load'), ['kind', 'executor', 'vus', 'maxVus', 'preAllocatedVus', 'rate', 'durationMs']);
      if (load?.kind === 'stages') {
        const unit = load.executor === 'vus' ? 'VU' : t('stressPresentation.iterationUnit');
        add(label('load'), 'startTarget', load.startTarget, unit);
        load.stages.forEach((stage, index) => {
          const path = `${label('load')} · ${t('stress.workbench.stages')} ${index + 1}`;
          add(path, 'stageId', stage.id); add(path, 'durationMs', stage.durationMs, 'ms'); add(path, 'stageTarget', stage.target, unit);
        });
      }
      fields(record(value.termination), label('termination'), ['maxIterations', 'durationMs']); break;
    }
    case 'stress-legacy':
      fields(value, '', ['totalRequests', 'ok', 'failed', 'incomplete']); add('', 'rps', value.rps, t('stressPresentation.rpsUnit'));
      for (const key of ['min', 'max', 'avg', 'p50', 'p90', 'p95', 'p99']) if (key in record(value.latency)) add(label('latency'), key, record(value.latency)[key], 'ms'); break;
    case 'comparison':
      fields(value, '', ['directlyComparable']); for (const key of ['mismatches', 'notices']) for (const item of list(value[key])) add('', 'reason', item);
      for (const key of ['rps', 'p95Ms', 'errorRate', 'iterationsCompleted', 'iterationP95Ms', 'dropped']) {
        const data = record(record(value.metrics)[key]), path = t(`stressPresentation.metrics.${key}`);
        for (const field of ['base', 'candidate', 'absolute', 'relative']) add(path, field, data[field], field === 'relative' || key === 'errorRate' ? '%' : key.endsWith('Ms') ? 'ms' : key === 'rps' ? t('stressPresentation.rpsUnit') : '');
      } break;
  }
  return rows.length ? rows : [{ label: t('ai.availability'), value: t('ai.none') }];
}
export function aiFactRows(evidence: AiEvidence, t: Translate): AiFactRow[] {
  if (!aiSafeFact(evidence)) return [{ label: t('ai.factKinds.bodyOmitted'), value: t('ai.bodyOmitted') }];
  if (evidence.state !== 'collected' || evidence.value === null) return [{ label: t('ai.availability'), value: t('ai.notCollected') }];
  if (evidence.kind.startsWith('stress-') || evidence.kind === 'comparison') return stressFactRows(evidence, t);
  const rows: AiFactRow[] = [];
  const walk = (value: unknown, path: string[], key: string) => {
    const identityLabel = evidence.kind === 'execution-identity' ? identityLabels[key] : undefined;
    const label = identityLabel ? t(identityLabel) : labels[key] ? t(`ai.factFields.${labels[key]}`) : key;
    const next = label ? [...path, label] : path;
    if (Array.isArray(value)) {
      if (!value.length) rows.push({ label: next.join(' · '), value: t('ai.none') });
      else value.forEach((item, index) => walk(item, next, evidence.kind === 'debug-warnings' ? 'warning' : String(index + 1)));
    } else if (value && typeof value === 'object') {
      for (const [field, item] of Object.entries(value)) walk(item, next, field);
    } else {
      let text = value === null || value === undefined ? t('ai.notComputable') : typeof value === 'boolean' ? t(value ? 'ai.yes' : 'ai.no') : String(value);
      if (typeof value === 'string' && ['state', 'status', 'reason', 'reasons', 'phase', 'role', 'failureKind'].includes(key)) text = codeLabel(value, t);
      if (typeof value === 'number' && (key.endsWith('Ms') || ['min', 'max', 'mean', 'p50', 'p90', 'p95', 'p99'].includes(key))) text += ' ms';
      if ((key === 'startedAt' || key === 'finishedAt') && Number.isFinite(new Date(value as string | number).getTime())) text = `${new Date(value as string | number).toISOString()} (UTC)`;
      rows.push({ label: next.join(' · '), value: text });
    }
  };
  // Unknown kinds remain identifiable; values are never serialised into a primary JSON view.
  if (titles[evidence.kind]) walk(evidence.value, [], '');
  else rows.push({ label: t('ai.evidence'), value: evidence.id });
  return rows;
}
