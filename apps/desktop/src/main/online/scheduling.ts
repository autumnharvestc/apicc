import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {collectCredentialRefsForRequests,selectCredentialRequests,collectNetworkDependencies,compileWorkflowPlan,type CompiledWorkflowPlan} from '@apicc/core';
import {prepareProjectFiles,type PreparedProjectFiles} from '@apicc/execution/host';
import {readBuildIdentity} from '@apicc/execution/buildIdentity';
import {ConfigVersionSchema,EntityIdSchema,TaskTargetSchema,RunConfigSchema,AttachmentSelectionSchema,AttachmentPathsSchema,ScheduleCredentialBindingSchema,ScheduleExecutionSchema,ScheduleMaterialOptionsSchema,ExecutionSnapshotSchema,ProjectExecutionAgentsSchema,FixedNetworkInputSchema,resolveEffectiveConfig,logicalNetworkPath,type ScheduleExecution} from '@apicc/execution/contract';
import { OnlineSchedulePreparationInputSchema as InputSchema, type OnlineSchedulePreparation, type OnlineSchedulePreparationInput } from '../../shared/online/scheduling.js';
export type { OnlineSchedulePreparation, OnlineSchedulePreparationInput } from '../../shared/online/scheduling.js';
import {createExecutionRequest} from './client.js';
import {assertAssetsScope} from './projectAssets.js';
import type {OnlineSession} from './session.js';
import type { OnlineSchedulingInput } from '../../shared/online/scheduling.js';
import { createSchedulingClient, ExecutionHttpError } from '@apicc/execution/client';
import { OnlineJobSchema } from '../../shared/online/execution.js';

export async function handleOnlineScheduling(deps: { session: OnlineSession; fetch?: typeof fetch }, input: OnlineSchedulingInput) {
  if (input.operation === 'prepare') return prepareOnlineSchedule(deps, { ...input.input, context: input.context });
  const binding = deps.session.captureExecution(input.context);
  const client = createSchedulingClient({ baseUrl: binding.serverId, token: binding.token, fetch: deps.fetch ?? globalThis.fetch });
  const scope = input.context.scope; const signal = new AbortController().signal;
  const result = await (async () => {
  switch (input.operation) {
    case 'originalJob': {
      const job = await createExecutionRequest(binding, deps.fetch)('GET', `jobs/${input.jobId}`, undefined, OnlineJobSchema);
      const actual = job.task.scope;
      if (actual.workspaceId !== scope.workspaceId || actual.groupId !== scope.groupId || actual.projectId !== scope.projectId) throw new Error('online-project-scope-mismatch');
      if (job.jobId !== input.jobId || job.executionId !== input.executionId || job.task.jobId !== input.jobId || job.task.executionId !== input.executionId) throw new Error('fixed-input-mismatch');
      return { jobId: job.jobId, executionId: job.executionId, agentId: job.agentId };
    }
    case 'options': return client.options(scope, signal);
    case 'list': return client.list(scope, input, signal);
    case 'detail': return client.detail(scope, input.id, signal);
    case 'save': return client.save(scope, input.input, signal);
    case 'update': return client.update(scope, input.id, input.input, signal);
    case 'remove': await client.remove(scope, input.id, input.expectedVersion, signal); return null;
    case 'preview': return client.preview(scope, input.input, signal);
    case 'materialOptions': return client.materialOptions(scope, signal);
    case 'history': return client.history(scope, input.id, input, signal);
    case 'notificationHistory': return client.notificationHistory(scope, input.id, input, signal);
    case 'notifications': return client.notifications(scope.workspaceId, input, signal);
    case 'markNotificationRead': return client.markNotificationRead(scope.workspaceId, input.id, signal);
  }
  })().catch(error => { binding.assertCurrent(); if (error instanceof ExecutionHttpError) throw new Error(error.code ?? 'schedule-request-failed'); throw error; });
  binding.assertCurrent();
  return result;
}

type DiffValue={name?:string;ids?:string[];count?:number;version?:string;fingerprint?:string};

function canonicalScheduleValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonicalScheduleValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([,entry])=>entry!==undefined).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,entry])=>[key,canonicalScheduleValue(entry)]));
  return value;
}
function fingerprint(value:unknown):string {
  return createHash('sha256').update(JSON.stringify(canonicalScheduleValue(value))).digest('hex');
}
/** Only selected execution definitions, including Core's complete recursive call closure. */
function selectedScheduleExecutionDefinition(prepared:PreparedProjectFiles) {
  const {snapshot,workflowPlan,suitePlan}=prepared.prepared;
  const workflows=new Map<string,CompiledWorkflowPlan['workflows'][number]>();
  const include=(plan:CompiledWorkflowPlan)=>{for(const workflow of plan.workflows)workflows.set(workflow.id,workflow);};
  if(workflowPlan)include(workflowPlan);
  for(const entry of suitePlan?.entries??[]) {
    if(entry.kind==='workflow')include(compileWorkflowPlan(snapshot,entry.workflowId!,{
      environmentId:suitePlan!.environmentId,allowDraft:suitePlan!.allowDraft,
    }));
  }
  return {
    suite:suitePlan?snapshot.project.suites?.find(suite=>suite.id===suitePlan.suiteId):undefined,
    workflows:[...workflows.values()].sort((a,b)=>a.id.localeCompare(b.id)),
  };
}
function scheduleTargetFingerprint(execution:ScheduleExecution,prepared:PreparedProjectFiles):string {
  return fingerprint({
    target:execution.target,runConfig:execution.runConfig,
    executionDefinition:selectedScheduleExecutionDefinition(prepared),
    requests:selectCredentialRequests(prepared.prepared.snapshot,prepared.prepared.selections).map(selected=>selected.request),
  });
}
/** Produces declarations from saved bytes only. No SecretStore, file staging, or invocation exists here. */
export async function prepareOnlineSchedule(deps:{session:OnlineSession;fetch?:typeof fetch},raw:OnlineSchedulePreparationInput):Promise<OnlineSchedulePreparation>{
  const input=InputSchema.parse(raw);const binding=deps.session.captureExecution(input.context);
  if(input.localOnlyRefIds.length)throw new Error('local-material-required');
  if(input.target.kind!=='suite'&&input.target.kind!=='workflow'||input.runConfig.stress!==undefined)throw new Error('schedule-target-unsupported');
  if(input.materials.projectId!==input.context.scope.projectId)throw new Error('online-project-scope-mismatch');
  const request=createExecutionRequest(binding,deps.fetch);const path=`workspaces/${input.context.scope.workspaceId}/projects/${input.context.scope.projectId}`;
  const view=await request('GET',`${path}/execution-agents`,undefined,ProjectExecutionAgentsSchema);
  const agent=view.agents.find(a=>a.id===input.agentId);
  if(!agent||agent.availability!=='available'||!agent.runtime||agent.configuration.status!=='applied')throw new Error('agent-unavailable');
  const effective=resolveEffectiveConfig({policy:agent.policy,run:input.runConfig});
  const snapshot=await request('POST',`${path}/execution-snapshots`,{expectedVersion:input.expectedVersion},ExecutionSnapshotSchema);
  assertAssetsScope(snapshot.assets,input.context);
  if(snapshot.createdByUserId!==binding.userId||snapshot.assets.version!==input.expectedVersion)throw new Error('fixed-input-mismatch');
  const identity=await readBuildIdentity();binding.assertCurrent();
  const prepareInput={target:input.target,environmentId:input.environmentId,requestSettings:input.runConfig.requestSettings,scriptTimeoutMs:effective.policy.scriptTimeoutMs,maxScriptTimeoutMs:agent.policy.maxScriptTimeoutMs,evidenceLimits:{bodyBytes:agent.policy.bodyPreviewBytes,valueBytes:agent.policy.valuePreviewBytes,caseBytes:agent.policy.caseEvidenceBytes,reportBytes:agent.policy.reportBytes,workflowMetadataBytes:agent.policy.workflowMetadataBytes}};
  let prepared=await prepareProjectFiles(snapshot.assets,{...prepareInput,profile:'trusted-core-script'});
  const hasScripts=prepared.scriptRequirements.length>0;
  if(!hasScripts)prepared=await prepareProjectFiles(snapshot.assets,{...prepareInput,profile:'no-script'});
  if(identity.coreBuildId!==agent.runtime.coreBuildId||identity.scriptApiId!==agent.runtime.scriptApiId||prepared.prepared.requiredCapabilities.some(c=>!agent.runtime!.capabilities.includes(c)))throw new Error('runtime-mismatch');
  if(prepared.scriptRequirements.some(s=>!agent.scriptsAllowed||agent.scriptGrant.version==='0'||agent.scriptGrant.scope!=='project'&&!agent.scriptGrant.scripts.some(g=>g.scriptId===s.scriptId&&g.contentHash===s.contentHash)))throw new Error('script-admission-denied');
  const metadata=await request('GET',`${path}/schedules/material-options`,undefined,ScheduleMaterialOptionsSchema);
  const selections=selectCredentialRequests(prepared.prepared.snapshot,prepared.prepared.selections);
  const refs=collectCredentialRefsForRequests(prepared.prepared.snapshot.project,selections);
  const network=input.network?collectNetworkDependencies({configuration:input.network.configuration,selection:input.network.selection,environmentId:prepared.prepared.environmentId}):undefined;
  refs.push(...(network?.secretNeeds.map(n=>n.ref)??[]));
  const unique=new Map<string,{id:string;policy:string}>();for(const ref of refs){if(ref.policy!=='test-auto')throw new Error('credential-policy-unsupported');unique.set(ref.id,ref);}
  const declared=input.materials.attachmentPaths??{};
  const requirePath=(path:string)=>{const ref=declared[path];if(!ref||!input.materials.attachments.some(a=>isDeepStrictEqual(a,ref)))throw new Error('undeclared-input-file');};
  for(const {request:selected} of selections){if('body'in selected&&selected.body.kind==='binary')requirePath(selected.body.file.path);if('body'in selected&&selected.body.kind==='multipart')for(const entry of selected.body.entries)if(entry.kind==='file'&&entry.enabled)requirePath(entry.file.path);}
  for(const selected of prepared.prepared.selections){const driver=selected.testCase?.dataDriver;if(driver&&!('kind'in driver))requirePath(driver.sourcePath);}
  // All saved network paths must be logical declarations, even in an inactive profile.
  if(input.network)for(const profile of input.network.configuration.profiles){for(const tls of [...profile.targetTlsBindings.map(b=>b.tls),...(profile.kind==='proxy'&&profile.proxyTLS?[profile.proxyTLS]:[])])for(const encoded of [...tls.caCertificatePaths??[],...tls.clientCertificatePaths??[]])requirePath(logicalNetworkPath(encoded));}
  for(const a of input.materials.attachments)if(!metadata.attachments.some(m=>m.refId===a.refId&&m.version===a.version&&m.hash===a.hash))throw new Error('attachment-version-conflict');
  for(const selected of Object.values(declared))if(!input.materials.attachments.some(a=>isDeepStrictEqual(a,selected)))throw new Error('undeclared-input-file');
  const overrides=new Map(input.credentialBindings.map(b=>[b.refId,b]));if(overrides.size!==input.credentialBindings.length||[...overrides.keys()].some(id=>!unique.has(id)))throw new Error('credential-binding-outside-dependencies');
  const credentials=[...unique.keys()].sort().map(refId=>{const m=metadata.credentials.find(m=>m.refId===refId);if(!m)throw new Error('credential-missing');const selected=overrides.get(refId)??{refId,mode:'current-at-trigger' as const};if(selected.mode==='fixed-version'&&selected.version!==m.version)throw new Error('credential-version-conflict');return selected;});
  const execution=ScheduleExecutionSchema.parse({agentId:agent.id,snapshotId:snapshot.snapshotId,target:input.target,...(input.environmentId?{environmentId:input.environmentId}:{}),runConfig:input.runConfig,materials:{...input.materials,credentials},preparation:{scope:input.context.scope,manifestHash:snapshot.assets.manifestHash,scriptPlanDigest:prepared.scriptPlanDigest,...(hasScripts?{scriptGrantVersion:agent.scriptGrant.version}:{}),scriptRequirements:prepared.scriptRequirements,executionProfile:hasScripts?'trusted-core-script':'no-script',dispatchKind:'dedicated-task',requiredCoreBuildId:identity.coreBuildId,requiredCapabilities:prepared.prepared.requiredCapabilities,runtimeCompatibilityId:agent.runtime.runtimeCompatibilityId},...(input.network?{network:input.network}:{})});
  const dataDefinition=(e:ScheduleExecution,p:PreparedProjectFiles)=>{
    const datasetIds=new Set<string>();if(p.prepared.suitePlan?.datasetId)datasetIds.add(p.prepared.suitePlan.datasetId);
    const files:Record<string,unknown>={};const cases=p.prepared.selections.map(s=>{const driver=s.testCase?.dataDriver;if(driver&&'kind'in driver)datasetIds.add(driver.datasetId);else if(driver)files[driver.sourcePath]=e.materials.attachmentPaths?.[driver.sourcePath];return {apiId:s.asset.contract.id,caseId:s.testCase?.id,parameters:s.testCase?.parameters,driver};});
    return {cases,files,datasets:(p.prepared.snapshot.project.datasets??[]).filter(d=>datasetIds.has(d.id)),projectVariables:p.prepared.snapshot.project.variables,globals:p.prepared.snapshot.project.globals,...(e.target.kind==='workflow'?{inputs:e.target.inputs}:{})};
  };
  const describe=(e:ScheduleExecution,p:PreparedProjectFiles):Array<{area:OnlineSchedulePreparation['snapshotDiff']['areas'][number]['area'];value:DiffValue}>=>[
    {area:'target',value:{ids:[e.target.kind,e.target.kind==='suite'?e.target.suiteId:e.target.kind==='workflow'?e.target.workflowId:''],fingerprint:scheduleTargetFingerprint(e,p)}},
    {area:'environment',value:{ids:p.prepared.environmentId?[p.prepared.environmentId]:[],fingerprint:fingerprint(p.prepared.snapshot.project.environments.find(env=>env.id===p.prepared.environmentId)??null)}},
    {area:'scripts',value:{count:p.scriptRequirements.length,fingerprint:p.scriptPlanDigest}},
    {area:'data',value:{count:p.prepared.selections.length,fingerprint:fingerprint(dataDefinition(e,p))}},
    {area:'materials',value:{ids:[...e.materials.credentials.map(c=>`${c.refId}:${c.mode}${c.mode==='fixed-version'?':'+c.version:''}`),...e.materials.attachments.map(a=>`${a.refId}:${a.version}:${a.hash}`)].sort(),fingerprint:fingerprint(e.materials)}},
    {area:'network',value:{version:e.network?.revision,ids:e.network?[...collectNetworkDependencies({configuration:e.network.configuration,selection:e.network.selection,environmentId:e.environmentId}).secretNeeds.map(n=>n.ref.id)].sort():[],fingerprint:fingerprint(e.network??null)}},
    {area:'runtime',value:{ids:[e.agentId,e.preparation.requiredCoreBuildId,e.preparation.runtimeCompatibilityId]}},
  ];
  let previous:ReturnType<typeof describe>|undefined;
  if(input.previous){
    const old=input.previous.execution;const fixed=old.snapshotId===snapshot.snapshotId?snapshot:await request('GET',`${path}/execution-snapshots/${old.snapshotId}`,undefined,ExecutionSnapshotSchema);assertAssetsScope(fixed.assets,input.context);
    if(fixed.assets.manifestHash!==input.previous.manifestHash||fixed.assets.version!==input.previous.snapshotVersion||old.preparation.manifestHash!==fixed.assets.manifestHash)throw new Error('fixed-input-mismatch');
    const prior=await prepareProjectFiles(fixed.assets,{...prepareInput,target:old.target,environmentId:old.environmentId,requestSettings:old.runConfig.requestSettings,profile:old.preparation.executionProfile});
    previous=describe(old,prior);
  }
  const areas=describe(execution,prepared).map((a,index)=>({area:a.area,changed:!previous||!isDeepStrictEqual(previous[index]!.value,a.value),before:previous?.[index]?.value??null,after:a.value}));
  binding.assertCurrent();return {execution,snapshotVersion:snapshot.assets.version,manifestHash:snapshot.assets.manifestHash,snapshotDiff:{previousSnapshotVersion:input.previous?.snapshotVersion??null,currentSnapshotVersion:snapshot.assets.version,areas}};
}
