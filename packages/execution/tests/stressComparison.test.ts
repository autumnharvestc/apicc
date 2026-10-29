import { describe,expect,it } from 'vitest';
import { compareStressExecutions, summarizeStressExecution } from '../src/client/stressComparison.js';
import { stressReportFixture as stressV2Report } from '../../core/tests/helpers/stressReport.js';
import type { StressExecutionSummary } from '../../core/src/stress/presentation.js';
const execution:StressExecutionSummary={location:'local',executorId:'local',executorName:'Local',workerCount:1,processBudget:1,runtime:{coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'},limits:{maxVus:1,requestConcurrency:1,maxRps:null}};
describe('outer stress comparison',()=>{
  it('T7 distinguishes a known null RPS cap from an uncollected optional historical field',()=>{
    const report=stressV2Report();delete report.load.effectiveMaxRps;
    const summary=summarizeStressExecution({report,local:{workerCount:1,processBudget:1,runtime:execution.runtime}});
    expect.soft(summary?.limits?.maxRps).toBeUndefined();
    expect.soft(compareStressExecutions({report,execution:summary},{report,execution:summary}).directlyComparable).toBe(false);
  });
  it('preserves direct comparison and all six real deltas when recorded execution metadata matches',()=>{
    const report=stressV2Report();expect(compareStressExecutions({report,execution},{report,execution})).toMatchObject({directlyComparable:true,reasons:[],metrics:{rps:{absolute:0},dropped:{relative:null}}});
  });
  it('T7 derives local limits from the true Core report and never borrows a finite agent reservation',()=>{
    const report=stressV2Report();
    expect(summarizeStressExecution({report,local:{workerCount:1,processBudget:1,runtime:execution.runtime}})).toMatchObject({location:'local',workerCount:1,processBudget:1,limits:{maxVus:1,requestConcurrency:1,maxRps:null}});
    expect(summarizeStressExecution({local:{workerCount:2,processBudget:3,runtime:execution.runtime}})?.limits).toBeUndefined();
  });
  it.each(['location','executor','workers','runtime','resources','metadata'] as const)('T7 refuses direct comparison for %s while preserving true deltas',reason=>{
    const report=stressV2Report();report.plan.maxVus=2;report.plan.load={kind:'constant-vus',vus:2};report.load.maxVus=2;
    const baseExecution={...execution,limits:{...execution.limits!,maxVus:2}},candidate=structuredClone(baseExecution);
    if(reason==='location'){candidate.location='agent';candidate.executorId='7';}if(reason==='executor')candidate.executorId='7';if(reason==='workers'){candidate.workerCount=2;candidate.processBudget=3;}if(reason==='runtime')candidate.runtime.coreBuildId='c'.repeat(64);if(reason==='resources')candidate.limits!.maxRps=2;
    const comparison=compareStressExecutions({report,execution:baseExecution},{report,execution:reason==='metadata'?undefined:candidate});
    expect.soft(comparison.directlyComparable).toBe(false);expect.soft(comparison.reasons).toContain(reason);
    expect(comparison.metrics?.rps.absolute).toBe(0);expect(comparison.metrics?.dropped.relative).toBeNull();
  });
  it('T7 reports an unavailable report instead of manufacturing six metrics',()=>{
    const value=compareStressExecutions({report:stressV2Report(),execution},{execution});
    expect(value.metrics).toBeUndefined();expect(value.reasons).toContain('report-unavailable');
  });
});
