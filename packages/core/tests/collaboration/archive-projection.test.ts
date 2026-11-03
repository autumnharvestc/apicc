import { describe, expect, it } from 'vitest';
import { projectPublication } from '../../src/collaboration/projection.js';
import { PublicationInputSchema, RunReportInputWireSchema, WorkflowReportInputWireSchema } from '../../src/collaboration/shared.js';
import type { PublicationInput } from '../../src/collaboration/types.js';
import { archiveInput, debugHistory, policy, runReport } from './fixtures.js';
import { stressReportFixture } from '../helpers/stressReport.js';
import { publicSections } from '../../src/collaboration/presentation.js';
import { PublicArtifactDtoSchema } from '../../src/collaboration/shared.js';
import { safeReport } from './fixtures.js';

const workflow = () => ({ workflowId:'fixed-flow',workflowName:'Fixed workflow',status:'enabled',nodeResults:[{nodeId:'leaf',kind:'request',state:'passed',outcomes:[runReport().cases[1]!]}],total:1,passed:1,failed:0,skipped:0,verdict:'passed',warnings:[],startedAt:'2026-11-01T00:00:00.000Z',finishedAt:'2026-11-01T00:00:01.000Z' });
function inputFor(kind:string) {
  const result=kind==='stress'?stressReportFixture():kind==='debug'?debugHistory().result:kind==='workflow'?workflow():runReport();
  const output=kind==='failure'?{kind,targetKind:'workflow',result,error:'Synthetic failed execution'}:{kind,result};
  return {...archiveInput(),report:{format:kind==='stress'?'stress':'run',body:{executionId:'synthetic-execution-2',executionFact:'started',verdict:kind==='failure'?'failed':'passed',output}}};
}
describe('actual archived envelope through the single publication entry',()=>{
  it.each(['stress','suite','workflow','debug','failure'])('projects supported %s through existing Core report projection, retaining original source identity',async kind=>{
    const input=inputFor(kind);
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    const artifact=await projectPublication(input as unknown as PublicationInput,policy);
    expect(artifact.source).toEqual({trust:'server-archive',...input.source});
    expect(artifact.report?.sourceCategory).toBe(kind==='stress'?'stress':kind==='debug'?'debug':'run');
    expect(artifact.report?.counts.length).toBeGreaterThan(0);
    if(kind==='stress')expect(artifact.report?.stress?.requests.completed).toBe(1);
    if(kind==='workflow')expect(artifact.report?.counts).toContainEqual({labelCode:'case.rows',total:1,passed:1,failed:0,skipped:0});
    if(kind==='debug')expect(artifact.kind).toBe('report');
  });
  it('keeps bare debug history semantics distinct from an agent server-report envelope',async()=>{
    const input={...archiveInput(),report:{format:'debug' as const,body:debugHistory()}};
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect((await projectPublication(input,policy)).kind).toBe('debug-history');
  });
  it('preserves a strict canonical workflow report when the producer omitted duplicate outcome aliases',async()=>{
    // evidence.ts retains report and is allowed to omit these duplicate aliases.
    const canonical={...runReport(),evidenceOmitted:true};
    const flow={...workflow(),nodeResults:[{nodeId:'leaf',kind:'request',state:'passed'}],report:canonical};
    expect(RunReportInputWireSchema.safeParse(canonical).success).toBe(true);
    expect(WorkflowReportInputWireSchema.safeParse(flow).success).toBe(true);
    const input={...inputFor('workflow'),report:{format:'run',body:{...inputFor('workflow').report.body,output:{kind:'workflow',result:flow}}}};
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    const artifact=await projectPublication(input as unknown as PublicationInput,policy);
    expect.soft(artifact.report?.counts).toContainEqual({labelCode:'logical.units',total:1,passed:1,failed:0,skipped:0});
    expect.soft(artifact.report?.counts).toContainEqual({labelCode:'case.rows',total:2,passed:1,failed:1,skipped:0});
    expect.soft(artifact.report?.counts).toContainEqual({labelCode:'request.started',total:2});
    expect.soft(artifact.report?.counts).toContainEqual({labelCode:'request.completed',total:2});
    expect.soft(artifact.report?.counts).toContainEqual({labelCode:'http.exchanges',total:2});
    expect.soft(artifact.report?.nodes).toHaveLength(2);
    expect(artifact.source).toEqual({trust:'server-archive',...input.source});
  });
  it.each(['cancelled','timed-out','interrupted','failed','rejected'])('does not publish inner passed as the outer execution conclusion %s',async verdict=>{
    const input=inputFor('stress');input.report.body.verdict=verdict;
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    const artifact=await projectPublication(input as unknown as PublicationInput,policy);
    expect(artifact.report?.stress?.requests.completed).toBe(1);
    expect.soft(artifact.report?.verdict).toBe(verdict);
    expect.soft(artifact.summary).toContainEqual({labelCode:'execution.verdict',value:verdict});
    expect.soft(artifact.summary).toContainEqual({labelCode:'report.verdict',value:'passed'});
    expect.soft(artifact.summary).toContainEqual({labelCode:'execution.fact',value:'started'});
  });
  it('marks unprojected arbitrary reason text unsupported without publishing it or changing the source digest',async()=>{
    const input=inputFor('stress');Object.assign(input.report.body,{reasonCode:'synthetic-private-reason@example.invalid'});
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    const artifact=await projectPublication(input as unknown as PublicationInput,policy);
    expect(JSON.stringify(artifact)).not.toContain('synthetic-private-reason@example.invalid');
    expect(artifact.source.digest).toBe(input.source.digest);
    expect(artifact.limitations).toContainEqual({code:'unsupported',path:'report.executionReason'});
  });
  it.each(['zh-CN','en'] as const)('renders finite outer verdict/fact separately from inner conclusion in %s',language=>{
    const dto=safeReport();dto.report!.verdict='timed-out';dto.summary=[{labelCode:'execution.verdict',value:'timed-out'},{labelCode:'report.verdict',value:'passed'},{labelCode:'execution.fact',value:'started'}];
    expect(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
    const sections=publicSections(dto,language);const text=JSON.stringify(sections);
    expect(text).toContain(language==='zh-CN'?'执行结论':'Execution verdict');
    expect(text).toContain(language==='zh-CN'?'内层报告结论':'Inner report verdict');
    expect(text).toContain(language==='zh-CN'?'执行超时':'Timed out');
    expect(text).toContain(language==='zh-CN'?'确认已开始':'Confirmed started');
    expect(text).not.toContain('execution.verdict');
  });
});
