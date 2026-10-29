import { compareStressReports, isStressReportV2 } from '@apicc/core/stress/compare';
import type { ReadableStressReport, StressExecutionSummary, StressExecutionComparison } from '@apicc/core';
import type { StressExecutionMetadata } from '../contract/runtime.js';
export interface StressPresentationInput { report?: ReadableStressReport; agent?: StressExecutionMetadata; local?: { workerCount: number; processBudget: number; runtime: StressExecutionSummary['runtime'];processObservation?:StressExecutionSummary['processObservation'] } }
/** Only Core load proves compiled numeric limits; reservations describe a different population. */
export function summarizeStressExecution(input: StressPresentationInput): StressExecutionSummary | undefined {
  const limits=input.report && isStressReportV2(input.report) ? {maxVus:input.report.load.maxVus,requestConcurrency:input.report.load.maxRequestConcurrency,maxRps:input.report.load.effectiveMaxRps}:undefined;
  if(input.agent){const m=input.agent;return {location:m.location.kind,executorId:m.executor.id,executorName:m.executor.name,workerCount:m.workerCount,processBudget:m.processes,runtime:{...m.runtime},limits,reservation:{...m.resources.effective},requestedReservation:{...m.resources.requested},status:{...m.status},contentionHints:[...m.contentionHints],...(m.processObservation?{processObservation:{...m.processObservation}}:{})};}
  if(input.local)return {location:'local',executorId:'local',executorName:'',workerCount:input.local.workerCount,processBudget:input.local.processBudget,runtime:{...input.local.runtime},limits,...(input.local.processObservation?{processObservation:{...input.local.processObservation}}:{})};
  return undefined;
}

export function compareStressExecutions(base: { report?: ReadableStressReport; execution?: StressExecutionSummary }, candidate: { report?: ReadableStressReport; execution?: StressExecutionSummary }): StressExecutionComparison & { core?: ReturnType<typeof compareStressReports>; metrics?: ReturnType<typeof compareStressReports>['metrics'] } {
  const core = base.report && candidate.report ? compareStressReports(base.report, candidate.report) : undefined;
  const reasons:StressExecutionComparison['reasons'][number][]=[];
  if(!core)reasons.push('report-unavailable');
  const a=base.execution,b=candidate.execution;
  if(!a||!b)reasons.push('metadata');
  else {
    if(a.location!==b.location)reasons.push('location');
    if(a.executorId!==b.executorId)reasons.push('executor');
    if(a.workerCount!==b.workerCount||a.processBudget!==b.processBudget)reasons.push('workers');
    if((Object.keys(a.runtime) as (keyof typeof a.runtime)[]).some(key=>a.runtime[key]!==b.runtime[key]))reasons.push('runtime');
    const vector=(value:StressExecutionSummary)=>[value.limits?.maxVus,value.limits?.requestConcurrency,value.limits?.maxRps,...[value.requestedReservation,value.reservation].flatMap(v=>v?[v.jobs,v.processes,v.vus,v.requestConcurrency,v.maxRps,v.metricMemoryBytes]:[null])];
    if(!a.limits||!b.limits||a.limits.maxRps===undefined||b.limits.maxRps===undefined||JSON.stringify(vector(a))!==JSON.stringify(vector(b)))reasons.push('resources');
  }
  return { directlyComparable: !!core?.directlyComparable && reasons.length===0, reasons, metrics: core?.metrics, core };
}
