import { PublicArtifactDtoSchema } from '@apicc/core/collaboration/shared';
import { safeDocument, safeReport } from '../../../packages/core/tests/collaboration/fixtures.js';
export const xss = '<script>globalThis.pwned=1</script><img src="https://remote.invalid/x" onerror="alert(1)">';
export function reportFixture(points = 1) {
  const artifact = safeReport(); artifact.title = '公开结果 ' + xss; artifact.source.digest = 'abcdef0123456789'.repeat(4);
  artifact.limitations = [{ code: 'evidence-not-collected' }, { code: 'future-unknown-reason' }];
  const report = artifact.report!;
  report.startedAt = '2026-11-03T01:02:03.123Z'; report.finishedAt = '2026-11-03T01:02:04.456Z';
  report.counts = [{ labelCode: 'logical.units', total: 4, passed: 4, failed: 0 }, { labelCode: 'case.rows', total: 10, passed: 4, failed: 6 }, { labelCode: 'request.completed', total: 10 }];
  report.failures = [{ category: 'transport', count: 6 }];
  report.nodes = [{ id: 'node-1', name: '很长的节点名称'.repeat(12), state: 'passed', durationMs: 12.3456789, message: '重试后通过 ' + xss }];
  report.trace = [{ nodeId: 'node-1', type: 'recovered', delayMs: 2.3456, attempt: 2, message: '保留最初失败' }];
  report.evidence = [{ nodeId: 'node-1', status: 'not-collected' }];
  const stress = report.stress!;
  stress.requests = { started: 10, completed: 10, eligibleCompleted: 10, failed: 6 };
  stress.timeline.buckets = Array.from({length:points}, (_, i) => ({ startOffsetMs: i*1000, endOffsetMs: (i+1)*1000, rps: { availability: 'available' as const, value: 10.123456 }, caseRows: stress.caseRows, requests: stress.requests, httpExchanges: stress.httpExchanges, latency: stress.latency, sources: [] }));
  stress.completeness.metrics = { complete: false, reasons: ['metrics-budget-exhausted'] };
  return PublicArtifactDtoSchema.parse(artifact);
}
export function documentFixture() {
  const artifact = safeDocument(); artifact.document!.apis[0]!.documentation = '说明 ' + xss;
  artifact.document!.apis[0]!.request.body!.content = '{"example":"literal"}';
  return PublicArtifactDtoSchema.parse(artifact);
}
