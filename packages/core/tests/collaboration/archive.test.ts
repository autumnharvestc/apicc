import { describe, expect, it } from 'vitest';
import { normalizeArchivedExecution } from '../../src/collaboration/archive.js';
import { RunReportInputWireSchema } from '../../src/collaboration/shared.js';
import { DebugResultSchema } from '../../src/debug/model.js';
import { StressReportV2Schema } from '../../src/stress/reportV2.js';
import { WorkflowStatusSchema } from '../../src/workflow/model.js';
import { stressReportFixture } from '../helpers/stressReport.js';
import { debugHistory, runReport } from './fixtures.js';

const envelope = (kind: string, result: unknown, verdict = 'passed') => ({ executionId: 'synthetic-execution-2', verdict, executionFact: 'started',
  output: { kind, result }, pid: 123, processObservation: { completeness: 'complete', started: 1, exited: 1, peak: 1 } });
const stress = () => stressReportFixture();
const workflow = () => ({ workflowId: 'fixed-flow', workflowName: 'Fixed workflow', status: 'enabled', nodeResults: [{ nodeId: 'leaf', kind: 'request', state: 'passed', outcomes: [runReport().cases[1]!] }], total: 1, passed: 1, failed: 0, skipped: 0, verdict: 'passed', warnings: [], startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:00:01.000Z' });

describe('finite actual agent archive normalization', () => {
  it('keeps valid bare run/stress compatibility as positive controls', () => {
    for (const report of [{ format: 'run', body: runReport() }, { format: 'stress', body: stress() }]) expect(normalizeArchivedExecution(report).report).toEqual(report);
  });
  it('normalizes a valid actual stress producer envelope without altering real statistics or source times', () => {
    const inner=stress();expect(StressReportV2Schema.safeParse(inner).success).toBe(true);
    const result=normalizeArchivedExecution({format:'stress',body:envelope('stress',inner)});
    expect(result.report).toEqual({format:'stress',body:inner});expect(result.executionVerdict).toBe('passed');expect(result.executionFact).toBe('started');
  });
  it.each(['cancelled','timed-out','interrupted'])('retains outer %s when the valid inner report passed', verdict => {
    const inner=stress();expect(inner.verdict.status).toBe('passed');expect(StressReportV2Schema.safeParse(inner).success).toBe(true);
    const result=normalizeArchivedExecution({format:'stress',body:envelope('stress',inner,verdict)});
    expect(result.executionVerdict).toBe(verdict);expect(result.report).toEqual({format:'stress',body:inner});
  });
  it('normalizes the current suite/run envelope through its existing strict report schema', () => {
    const body=runReport();expect(RunReportInputWireSchema.safeParse(body).success).toBe(true);
    const result=normalizeArchivedExecution({format:'run',body:envelope('suite',body)});
    expect(result.report).toEqual({format:'run',body});expect(result.executionVerdict).toBe('passed');
  });
  it('keeps a supported failure output RunResult without converting its outer failed conclusion to success', () => {
    const inner=runReport();expect(RunReportInputWireSchema.safeParse(inner).success).toBe(true);
    const body={...envelope('failure',inner,'failed'),output:{kind:'failure',targetKind:'workflow',result:inner,error:'Synthetic execution failed'}};
    const result=normalizeArchivedExecution({format:'run',body});
    expect(result.report).toEqual({format:'run',body:inner});expect(result.executionVerdict).toBe('failed');
  });
  it('normalizes the current debug result without inventing a local history ID or timestamp', () => {
    const body=debugHistory().result;expect(DebugResultSchema.safeParse(body).success).toBe(true);
    const result=normalizeArchivedExecution({format:'run',body:envelope('debug',body)});
    expect(result.report).toEqual({format:'debug',body});expect(result.executionVerdict).toBe('passed');
  });
  it('reuses the existing workflow row adapter and preserves separate node versus physical case populations', () => {
    const result=normalizeArchivedExecution({format:'run',body:envelope('workflow',workflow())});
    expect(result.report).toMatchObject({format:'run',body:{kind:'workflow',collectionId:'fixed-flow',total:1,passed:1,failed:0,workflow:{total:1,passed:1,failed:0},startedAt:'2026-11-01T00:00:00.000Z',finishedAt:'2026-11-01T00:00:01.000Z'}});
  });
  it('accepts the existing published workflow status, not an invented disabled variant',()=>{
    expect(WorkflowStatusSchema.safeParse('published').success).toBe(true);
    const result=normalizeArchivedExecution({format:'run',body:envelope('workflow',{...workflow(),status:'published'})});
    expect(result.report).toMatchObject({format:'run',body:{collectionId:'fixed-flow',total:1}});
  });
  it('rejects disabled outside the existing workflow status domain',()=>{
    expect(WorkflowStatusSchema.safeParse('disabled').success).toBe(false);
    expect(()=>normalizeArchivedExecution({format:'run',body:envelope('workflow',{...workflow(),status:'disabled'})})).toThrow('PUBLICATION_SOURCE_INVALID');
  });
  it.each(['outer-extra','output-extra','inner-extra','wrong-type','unknown-kind','missing-output','unsupported-stress-failure'])('rejects reached malformed or unsupported envelope branch %s', branch => {
    const body=envelope('stress',stress());
    if(branch==='outer-extra')Object.assign(body,{rawProject:{private:'never copy'}});
    if(branch==='output-extra')Object.assign(body.output,{privateContext:{private:'never copy'}});
    if(branch==='inner-extra')Object.assign(body.output.result as object,{privateContext:'never copy'});
    if(branch==='wrong-type')body.output.kind='suite';
    if(branch==='unknown-kind')body.output.kind='new-report-algorithm';
    if(branch==='missing-output')delete (body as Partial<typeof body>).output;
    if(branch==='unsupported-stress-failure')Object.assign(body,{output:{kind:'stress-failure',error:'synthetic',started:true,requests:{started:1,completed:0}}});
    expect(()=>normalizeArchivedExecution({format:'stress',body})).toThrow('PUBLICATION_SOURCE_INVALID');
  });
  it.each([
    ['execution-id-type',{executionId:17}], ['verdict-enum',{verdict:'invented'}], ['fact-enum',{executionFact:'invented'}],
    ['pid-positive-integer',{pid:0}], ['reason-code-type',{reasonCode:{raw:'private'}}],
    ['process-observation-number',{processObservation:{completeness:'complete',started:-1,exited:0,peak:0}}],
  ])('rejects the reached existing outer shape constraint %s', (_branch, patch) => {
    expect(()=>normalizeArchivedExecution({format:'stress',body:{...envelope('stress',stress()),...patch}})).toThrow('PUBLICATION_SOURCE_INVALID');
  });
  it.each(['run-extra','debug-extra','workflow-extra','workflow-negative-count','failure-target'])('rejects the reached existing output shape constraint %s', branch => {
    let body:unknown;
    if(branch==='run-extra')body=envelope('suite',{...runReport(),rawPrivate:'never copy'});
    if(branch==='debug-extra')body=envelope('debug',{...debugHistory().result,rawPrivate:'never copy'});
    if(branch==='workflow-extra')body=envelope('workflow',{...workflow(),rawPrivate:'never copy'});
    if(branch==='workflow-negative-count')body=envelope('workflow',{...workflow(),total:-1});
    if(branch==='failure-target')body={...envelope('failure',runReport(),'failed'),output:{kind:'failure',targetKind:'invented',result:runReport(),error:'synthetic'}};
    expect(()=>normalizeArchivedExecution({format:'run',body})).toThrow('PUBLICATION_SOURCE_INVALID');
  });
});
