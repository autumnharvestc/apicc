import { createProjectSnapshot } from "../assets/snapshot.js";
import { ContractProjectSchema, type ContractProject } from "../contract/workspace.js";
import { compareSyncInput, projectApis, syncEntityNodes, transitionReferences } from "./compare.js";
import { applySyncCorrespondence, type SyncChildSelection } from "./mapping.js";
import { assertBytes, canonical, digestProject, encodeSyncProject, fileWrites, hash, order } from "./files.js";
import { SyncResolvedPlanSchema, SyncResolveInputSchema, type SyncResolveInput, type SyncResolvedPlan } from "./types.js";

export async function resolveSyncCandidate(value: SyncResolveInput): Promise<SyncResolvedPlan> {
  const input = SyncResolveInputSchema.parse(value);
  const comparison = await compareSyncInput(input.planInput);
  const {candidate} = comparison;
  if (canonical(candidate) !== canonical(input.candidate) || input.decisions.candidateDigest !== candidate.candidateDigest) throw new Error("SYNC_CANDIDATE_MISMATCH");
  if (candidate.diagnostics.some(d=>d.severity === "error")) throw new Error("SYNC_DIAGNOSTICS_BLOCKED");
  const decisions = new Map<string,typeof input.decisions.entries[number]>();
  for (const decision of input.decisions.entries) {
    if (decisions.has(decision.changeId)) throw new Error("SYNC_DECISION_DUPLICATE");
    if (!candidate.changes.some(c=>c.changeId === decision.changeId)) throw new Error("SYNC_DECISION_UNKNOWN");
    decisions.set(decision.changeId,decision);
  }
  for (const change of candidate.changes) if (!decisions.has(change.changeId)) throw new Error("SYNC_DECISION_REQUIRED");
  const mapping = structuredClone(input.planInput.mapping);
  const transfers = new Map<string,string>();
  const sourceNodes = comparison.remote ? syncEntityNodes(comparison.remote) : [];
  const localNodes = syncEntityNodes(comparison.local);
  for (const edit of comparison.edits) {
    const decision = decisions.get(edit.change.changeId)!;
    if (!edit.identityOnly && edit.change.fieldPath === "" && edit.base === undefined && edit.local !== undefined && decision.decision === "take-source") throw new Error("SYNC_MAPPING_DECISION_REQUIRED");
    if (decision.decision === "map-existing") {
      const source = sourceNodes.find(n=>n.id === edit.change.entityId);
      if (!source || !["api","model","component","parameter","response","example"].includes(edit.change.entityKind) || edit.change.operation !== "add" || edit.change.fieldPath !== source.field) throw new Error("SYNC_MAPPING_DECISION_INVALID");
      const targets = localNodes.filter(n=>n.id.toLowerCase() === decision.existingEntityId.toLowerCase());
      if (targets.length > 1) throw new Error("SYNC_MAPPING_TARGET_AMBIGUOUS");
      const target = targets[0];
      if (!target || input.planInput.otherSourceMappings.some(m=>m.entries.some(e=>e.ownership === "source" && e.entityId.toLowerCase() === decision.existingEntityId.toLowerCase()))) throw new Error("SYNC_MAPPING_TARGET_UNAVAILABLE");
      if (source.kind !== target.kind || source.componentKind !== target.componentKind) throw new Error("SYNC_MAPPING_KIND_MISMATCH");
      if ([...transfers.values()].includes(target.id)) throw new Error("SYNC_MAPPING_TARGET_DUPLICATE");
      if (source.id !== target.id && sourceNodes.some(n=>n.id === target.id)) throw new Error("SYNC_MAPPING_TARGET_ACTIVE");
      transfers.set(edit.change.entityId,target.id);
    }
    if (decision.decision !== "keep-current" && edit.remote === undefined && protectedLocal(edit.local,input.planInput.mapping.entries.filter(e=>e.ownership === "source").map(e=>e.entityId))) throw new Error("SYNC_PROTECTED_LOCAL_ASSET");
  }
  for (const edit of comparison.edits) {
    const decision = decisions.get(edit.change.changeId)!;if(decision.decision === "keep-current") continue;
    const source = sourceNodes.find(n=>n.id === edit.change.entityId);if(!source?.parentId) continue;
    const parent = sourceNodes.find(n=>n.id === source.parentId);
    const parentEdit = comparison.edits.find(e=>e.change.entityId === source.parentId && e.change.operation === "add");
    if (parentEdit && decisions.get(parentEdit.change.changeId)!.decision === "keep-current") throw new Error("SYNC_MAPPING_PARENT_NOT_SELECTED");
    if (parent) {
      const entry = input.planInput.mapping.entries.find(e=>e.entityId === source.id)!;
      const parentEntry = input.planInput.mapping.entries.find(e=>e.entityId === parent.id)!;
      if (entry.ownerExternalKey !== parentEntry.externalKey) throw new Error("SYNC_MAPPING_PARENT_MISMATCH");
    }
    if (decision.decision === "map-existing") {
      const target = localNodes.find(n=>n.id === transfers.get(source.id))!;
      if (target.parentId !== (transfers.get(source.parentId) ?? source.parentId)) throw new Error("SYNC_MAPPING_PARENT_MISMATCH");
    }
  }
  for (const [sourceId,targetId] of transfers) {
    const entry = mapping.entries.find(e=>e.entityId === sourceId)!;
    const prior = mapping.entries.find(e=>e.entityId === targetId && e !== entry);
    if (prior) {entry.aliases = [...new Set([...entry.aliases,prior.externalKey,...prior.aliases])].sort(order);mapping.entries = mapping.entries.filter(e=>e !== prior);}
    entry.entityId = targetId;entry.correspondence = "manual";entry.ownership = "source";
  }
  const composed = comparison.compose(edit=>{
    const decision = decisions.get(edit.change.changeId)!;
    if (decision.decision === "keep-current") return edit.local;
    return edit.remote;
  });
  const childChoices = new Map<string,SyncChildSelection>();
  for(const edit of comparison.edits.filter(e=>e.identityOnly && decisions.get(e.change.changeId)!.decision === "keep-current")) {
    const source = sourceNodes.find(n=>n.id === edit.change.entityId)!;
    const parentId = transfers.get(source.parentId!) ?? source.parentId!;
    const current = localNodes.find(n=>n.id === source.id && n.parentId === parentId);
    childChoices.set(source.id,{parentId,value:current?.value});
  }
  applySyncCorrespondence(composed,comparison.local,transfers,childChoices);
  const project = ContractProjectSchema.parse(composed);
  if (transitionReferences(comparison.local,project,comparison.edits).length || createProjectSnapshot(project).context.diagnostics.length) throw new Error("SYNC_PROTECTED_REFERENCE");
  const canonicalLocal = new Map(encodeSyncProject(comparison.local).map(f=>[f.path,f.content]));
  const localBytes = new Map(input.planInput.localFiles.map(f=>[f.path,f]));
  const afterFiles = encodeSyncProject(project).flatMap(f=>canonicalLocal.get(f.path) === f.content ? localBytes.has(f.path) ? [localBytes.get(f.path)!] : [] : [f]);
  let baselineFiles = input.planInput.remoteFiles;
  if (transfers.size) {
    const baseline = structuredClone(comparison.remote!);
    applySyncCorrespondence(baseline,comparison.remote!,transfers,new Map());
    baselineFiles = encodeSyncProject(baseline);
  }
  const plan = SyncResolvedPlanSchema.parse({formatVersion:1,candidateDigest:candidate.candidateDigest,
    decisionsDigest:hash(["apicc-sync-decisions-v1",{...input.decisions,entries:[...input.decisions.entries].sort((a,b)=>order(a.changeId,b.changeId))}]),stamp:input.planInput.stamp,
    ...fileWrites(input.planInput.localFiles,afterFiles),baselineFiles,mapping,
    before:digestProject(comparison.local,input.planInput.localFiles),after:digestProject(project,afterFiles)});
  assertBytes(plan,input.planInput.budget.maxCompareOutputBytes,"SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED");
  return plan;
}
function protectedLocal(value: unknown,owned: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string,unknown>;
  if (Array.isArray(v.cases) && v.cases.length || Array.isArray(v.preOperations) && v.preOperations.length || Array.isArray(v.postOperations) && v.postOperations.length) return true;
  if (v.contract && typeof v.contract === "object") {
    const request = (v.contract as {request:{auth:{kind:string}}}).request;
    if (request.auth.kind !== "none") return true;
  }
  for (const key of ["apis","folders"] as const) if (Array.isArray(v[key])) for (const child of v[key]) {
    const item = child as {id?:string;contract?:{id:string}}; const id = item.id ?? item.contract?.id;
    if (id && !owned.includes(id) || protectedLocal(child,owned)) return true;
  }
  return false;
}
