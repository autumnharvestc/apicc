/** Presentation-only values. Core does not depend on an execution host. */
export interface StressExecutionSummary {
  location: 'local' | 'agent'; executorId: string; executorName: string;
  workerCount: number; processBudget: number;
  processObservation?:{completeness:'complete'|'partial';started:number;exited:number;peak:number};
  runtime: { coreBuildId: string; scriptApiId: string; nodeVersion: string; v8Version: string; runtimeCompatibilityId: string };
  limits?: { maxVus: number; requestConcurrency: number; maxRps?: number | null };
  reservation?: { jobs: number; processes: number; vus: number; requestConcurrency: number; maxRps: number; metricMemoryBytes: number };
  requestedReservation?: StressExecutionSummary['reservation'];
  status?: { preparation: string; execution: string; upload: string };
  contentionHints?: readonly (string|{code:'shared-agent-capacity';jobLimit:number;stressJobLimit:number;activeOtherJobs:number})[];
}
export type StressExecutionComparisonReason = 'location' | 'executor' | 'workers' | 'runtime' | 'resources' | 'metadata' | 'report-unavailable';
export interface StressExecutionComparison {
  directlyComparable: boolean;
  reasons: readonly StressExecutionComparisonReason[];
}
export interface StressHtmlPresentation {
  execution?: StressExecutionSummary;
  comparison?: StressExecutionComparison;
}
/** Safe, plain-text presentation shared by native renderer and offline HTML. Unknown business text is preserved. */
export function stressProcessObservationText(value:StressExecutionSummary['processObservation'],language:string):string {
  const en=language==='en';if(!value)return en?'Observed process count not collected; budget is not a spawned-process count':'未采集实际进程数；预算不是已启动进程数';
  return en?`Started ${value.started} · Exited ${value.exited} · Observed peak owned-live ${value.peak} · ${value.completeness==='complete'?'Topology observation coverage complete':'Observation coverage incomplete'}`:`实际启动 ${value.started} · 实际退出 ${value.exited} · 已观测同时存活峰值 ${value.peak} · ${value.completeness==='complete'?'拓扑观测覆盖完整':'观测覆盖不完整'}`;
}
export function stressContentionHintText(hint:NonNullable<StressExecutionSummary['contentionHints']>[number],language:string):string {
  if(typeof hint==='string')return hint;
  return language==='en'?`Possible contention: shared agent limits ${hint.jobLimit} jobs / ${hint.stressJobLimit} stress jobs; ${hint.activeOtherJobs} other active jobs at admission. Budgets do not isolate CPU, RSS or network.`:`可能竞争：共享节点上限 ${hint.jobLimit} 个任务 / ${hint.stressJobLimit} 个压测任务；本次准入时另有 ${hint.activeOtherJobs} 个在途任务。预算不隔离 CPU、RSS 或网络。`;
}
export function stressSafetyCodeLabels(value:string):readonly [string,string]|undefined {
  const labels:Record<string,readonly [string,string]>={'project-policy':['项目策略授权','Authorized by project policy'],trusted:['受信任','Trusted'],explicit:['本次显式确认','Explicitly confirmed'], 'explicit-limited':['显式确认并受策略限制','Explicitly confirmed with policy limits'],none:['未附加策略限制','No additional policy limits'],rejected:['已拒绝','Rejected'],target_confirmation_required:['需要确认目标','Target confirmation required'],target_denied:['目标被策略拒绝','Target denied by policy'],concurrency_exceeds_policy:['请求并发超出策略','Request concurrency exceeds policy'],rps_exceeds_policy:['请求速率超出策略','Request rate exceeds policy']};
  return Object.hasOwn(labels,value)?labels[value]:undefined;
}
export function stressSafetyCodeText(value:string,language:string):string {return stressSafetyCodeLabels(value)?.[language==='en'?1:0]??value;}
