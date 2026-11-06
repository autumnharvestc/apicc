import { createProjectSnapshot } from "../assets/snapshot.js";
import type { ContractProject } from "../contract/workspace.js";
import { SyncCandidateSchema, SyncPlanInputSchema, type SyncCandidate, type SyncDiagnostic, type SyncEntityKind, type SyncIdentityMap, type SyncPlanInput } from "./types.js";
import { assertBytes, canonical, hash, order, readSyncProject, sortedFiles } from "./files.js";
import { summarizeSyncValue } from "./summary.js";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const idOf = (v: unknown): string | undefined => object(v) ? typeof v.id === "string" ? v.id : object(v.contract) && typeof v.contract.id === "string" ? v.contract.id : undefined : undefined;
const equal = (a: unknown,b: unknown) => canonical(a) === canonical(b);
const pointer = (p: string,k: string) => `${p}/${k.replace(/~/g,"~0").replace(/\//g,"~1")}`;
type Description = { id: string; kind: SyncEntityKind; key: string; path: string; field: string; layer: SyncCandidate["changes"][number]["layer"]; label: string };
export type SyncEdit = { change: SyncCandidate["changes"][number]; base: unknown; local: unknown; remote: unknown; descriptor: Description; identityOnly?: boolean };
export type Selection = (edit: SyncEdit) => unknown;
export interface SyncComparison { input: SyncPlanInput; candidate: SyncCandidate; local: ContractProject; base?: ContractProject; remote?: ContractProject; edits: SyncEdit[]; compose(select: Selection): ContractProject }

export function mappingDiagnostics(mapping: SyncIdentityMap, others: SyncIdentityMap[]): SyncDiagnostic[] {
  const diagnostics: SyncDiagnostic[] = []; const keys = new Set<string>(); const ids = new Set<string>();
  const add = (code: string,id: string,message: string) => diagnostics.push({ code,severity: "error",ownerId: id,path: "mapping",message });
  for (const e of mapping.entries) {
    const id = e.entityId.toLowerCase();
    if (ids.has(id)) add("SYNC_IDENTITY_AMBIGUOUS",e.entityId,"An identity has more than one mapping.");
    ids.add(id);
    for (const key of [e.externalKey,...e.aliases.filter(a=>!a.startsWith("operationId:"))]) {
      const slot = canonical([e.entityKind,key]);
      if (keys.has(slot)) add("SYNC_IDENTITY_AMBIGUOUS",e.entityId,"An external key has ambiguous correspondence.");
      keys.add(slot);
    }
    if (e.ownership === "source" && others.some(m=>m.sourceId === mapping.sourceId || m.entries.some(o=>o.ownership === "source" && o.entityId.toLowerCase() === id))) {
      add("SYNC_CROSS_SOURCE_OWNERSHIP",e.entityId,"The identity is already owned by another source.");
    }
  }
  return diagnostics;
}

export async function compareSyncInput(value: SyncPlanInput): Promise<SyncComparison> {
  const input = SyncPlanInputSchema.parse(value);
  input.baselineFiles = sortedFiles(input.baselineFiles); input.localFiles = sortedFiles(input.localFiles); input.remoteFiles = sortedFiles(input.remoteFiles);
  assertBytes(input,input.budget.maxCompareInputBytes,"SYNC_COMPARE_INPUT_BYTES_EXCEEDED");
  if (input.source.id !== input.mapping.sourceId || input.stamp.sourceRevision !== input.source.revision || input.stamp.mappingRevision !== input.mapping.revision) throw new Error("SYNC_STAMP_MISMATCH");
  const local = await readSyncProject(input.localFiles);
  if (local.id !== input.stamp.projectId || createProjectSnapshot(local).definitionRevision !== input.stamp.definitionRevision) throw new Error("SYNC_STAMP_MISMATCH");
  const diagnostics = [...input.normalizationDiagnostics,...mappingDiagnostics(input.mapping,input.otherSourceMappings)];
  const errored = diagnostics.some(d=>d.severity === "error");
  const base = input.baselineFiles.length ? await readSyncProject(input.baselineFiles) : undefined;
  const remote = errored ? undefined : await readSyncProject(input.remoteFiles);
  const entries = new Map(input.mapping.entries.map(e=>[e.entityId.toLowerCase(),e]));
  if (remote) {
    const localIdentities = projectIdentities(local);
    for (const identity of projectIdentities(remote)) {
      const mapped = entries.get(identity.id.toLowerCase());
      if (!mapped || mapped.ownership !== "source") continue;
      if (localIdentities.some(l=>l.id.toLowerCase() === identity.id.toLowerCase() && l.kind !== identity.kind)) {
        diagnostics.push({code:"SYNC_LOCAL_ID_OCCUPIED",severity:"error",ownerId:identity.id,path:identity.path,message:"A source identity occupies a different local entity or reserved project identity."});
      }
    }
  }
  if (remote && (remote.collections.length !== 1 || remote.collections[0]?.id !== input.source.moduleId)) throw new Error("SYNC_SOURCE_MODULE_MISMATCH");
  const edits: SyncEdit[] = [];
  const conflicts: SyncCandidate["conflicts"] = [];
  const typedNodes = [base,local,remote].flatMap(project=>project ? syncEntityNodes(project) : []);
  const entityLocations = new Set(typedNodes.map(node=>`${node.path}\0${node.field}`));
  const entityCollections = new Set(typedNodes.filter(node=>["parameter","response","example"].includes(node.kind)).map(node=>`${node.path}\0${node.field.slice(0,node.field.lastIndexOf("/"))}`));
  function describe(id: string,kind: SyncEntityKind,path: string,label: string): Description {
    const entry = entries.get(id.toLowerCase());
    if (!entry) diagnostics.push({ code: "SYNC_IDENTITY_UNMAPPED",severity: "error",ownerId: id,path,message: "Source entity has no confirmed identity mapping." });
    return {id,kind,key: entry?.externalKey ?? id,path,field: "",layer: kind === "model" ? "models" : kind === "component" ? "components" : kind === "api" ? "contract" : "structure",label};
  }
  function changed(b: unknown,l: unknown,r: unknown,d: Description,select?: Selection): unknown {
    if (equal(b,r)) return structuredClone(l);
    const containerAsset = d.field === "" && (d.kind === "module" || d.kind === "folder");
    const summaryKind = containerAsset || entityLocations.has(`${d.path}\0${d.field}`) ? d.kind : null;
    const itemKind = typedNodes.find(n=>n.path === d.path && n.field.slice(0,n.field.lastIndexOf("/")) === d.field && ["parameter","response","example"].includes(n.kind))?.kind ?? null;
    const parameterGroup = d.field.match(/^\/request\/(pathParams|query|headers|cookies)(?:\/|$)/)?.[1];
    const location = parameterGroup === "pathParams" ? "path" : parameterGroup === "headers" ? "header" : parameterGroup === "cookies" ? "cookie" : parameterGroup;
    const change: SyncEdit["change"] = { changeId: hash(["apicc-sync-change-v1",input.source.id,d.id,d.path,d.field,b ?? null,l ?? null,r ?? null]), entityKind: d.kind,externalKey: d.key,entityId: d.id,layer: d.layer,
      operation: b === undefined ? "add" : r === undefined ? "remove" : "update",path: d.path,fieldPath: d.field,label: d.label,beforeDigest: b === undefined ? null : hash(b),afterDigest: r === undefined ? null : hash(r),
      summaries:{baseline:summarizeSyncValue(b,summaryKind,itemKind,location),current:summarizeSyncValue(l,summaryKind,itemKind,location),source:summarizeSyncValue(r,summaryKind,itemKind,location)} };
    const edit = {change,base:b,local:l,remote:r,descriptor:d};
    if (!select) {
      edits.push(edit);
      if (!equal(b,l) && !equal(l,r)) conflicts.push({ changeId: change.changeId,reasonCode: r === undefined ? "source-deleted-local-modified" : b === undefined && l !== undefined ? "identity-ambiguous" : "both-modified",message: "Current and source values require an explicit decision.",currentSummary: valueSummary(l),sourceSummary: valueSummary(r) });
      return structuredClone(l);
    }
    return structuredClone(select(edit));
  }
  function walk(b: unknown,l: unknown,r: unknown,d: Description,select?: Selection): unknown {
    if (equal(b,r)) return structuredClone(l);
    const id = entityLocations.has(`${d.path}\0${d.field}`) ? idOf(r) ?? idOf(b) : undefined;
    if (id && entries.get(id.toLowerCase())?.ownership === "local") return structuredClone(l);
    const child = id ? entries.get(id.toLowerCase()) : undefined;
    if (child && ["parameter","response","example"].includes(child.entityKind)) d = {...d,id:child.entityId,kind:child.entityKind,key:child.externalKey};
    if (object(b) && object(l) && object(r)) {
      const out: Obj = {};
      for (const key of [...new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])].sort(order)) {
        // Request credentials and local parameter values are execution bindings.
        const binding = (d.kind === "api" || d.kind === "parameter") && (d.field === "/request" && key === "auth" || /\/(?:pathParams|query|headers|cookies)\/\d+$/.test(d.field) && (key === "value" || key === "enabled"));
        const localHook = (d.kind === "folder" || d.kind === "module") && d.field === "" && ["preOperations","postOperations","variables"].includes(key);
        const localCredential = d.kind === "component" && d.field === "" && l.kind === "auth" && key === "definition";
        const result = binding || localHook || localCredential ? structuredClone(l[key]) : walk(b[key],l[key],r[key],{...d,field:pointer(d.field,key)},select);
        if (result !== undefined) Object.defineProperty(out,key,{value:result,enumerable:true,writable:true,configurable:true});
      }
      return out;
    }
    if (entityCollections.has(`${d.path}\0${d.field}`) && Array.isArray(b) && Array.isArray(l) && Array.isArray(r)) {
      const all = [...new Set([...l,...r,...b].map(v=>idOf(v)!))];
      return all.flatMap(id=>{
        const bv = b.find(v=>idOf(v) === id), lv = l.find(v=>idOf(v) === id), rv = r.find(v=>idOf(v) === id);
        const index = Math.max(0,l.findIndex(v=>idOf(v) === id) < 0 ? r.findIndex(v=>idOf(v) === id) : l.findIndex(v=>idOf(v) === id));
        const next = walk(bv,lv,rv,{...d,field:pointer(d.field,String(index))},select);
        return next === undefined ? [] : [next];
      });
    }
    return changed(b,l,r,d,select);
  }
  function containers(b: unknown[],l: unknown[],r: unknown[],parent: string,kind: "module" | "folder",select?: Selection): unknown[] {
    return entityArray(b,l,r,(bv,lv,rv,id)=>{
      if (!bv && !rv) return structuredClone(lv);
      const path = `${parent}/${id}`; const exemplar = (rv ?? bv ?? lv) as Obj;
      const d = describe(id,kind,`${path}/${kind === "module" ? "collection" : "folder"}.yaml`,String(exemplar.name));
      if (!lv || !rv) return changed(bv,lv,rv,d,select);
      const bo = (bv ?? {apis:[],folders:[]}) as Obj,lo = lv as Obj,ro = rv as Obj;
      const sourceOwned = entries.get(id.toLowerCase())?.ownership === "source";
      const metadata = (v: Obj) => Object.fromEntries(Object.entries(v).filter(([k])=>!["apis","folders"].includes(k)));
      const merged = sourceOwned ? walk(metadata(bo),metadata(lo),metadata(ro),d,select) as Obj : structuredClone(metadata(lo));
      merged.apis = apis(bo.apis as unknown[],lo.apis as unknown[],ro.apis as unknown[],`${path}/apis`,select);
      merged.folders = containers(bo.folders as unknown[],lo.folders as unknown[],ro.folders as unknown[],`${path}/folders`,"folder",select);
      return merged;
    });
  }
  function apis(b: unknown[],l: unknown[],r: unknown[],parent: string,select?: Selection): unknown[] {
    return entityArray(b,l,r,(bv,lv,rv,id)=>{
      if (!bv && !rv) return structuredClone(lv);
      const d = describe(id,"api",`${parent}/${id}/api.yaml`,String(((rv ?? bv ?? lv) as {contract:{metadata:{name:string}}}).contract.metadata.name));
      if (entries.get(id.toLowerCase())?.ownership === "local") return structuredClone(lv);
      if (!bv || !lv || !rv) return changed(bv,lv,rv,d,select);
      const bo = bv as Obj,lo = lv as Obj,ro = rv as Obj;
      return { contract: walk(bo.contract,lo.contract,ro.contract,d,select), cases: structuredClone(lo.cases),
        documentation: walk(bo.documentation,lo.documentation,ro.documentation,{...d,path:d.path.replace(/api.yaml$/,"design.md"),layer:"documentation"},select) };
    });
  }
  function compose(select?: Selection): ContractProject {
    if (!remote) return structuredClone(local);
    const out = structuredClone(local);
    out.collections = containers(base?.collections ?? [],local.collections,remote.collections,"collections","module",select) as ContractProject["collections"];
    for (const type of ["models","components"] as const) {
      const merged = entityArray(base?.[type] ?? [],local[type],remote[type],(b,l,r,id)=>{
        if (entries.get(id.toLowerCase())?.ownership === "local" || !b && !r) return structuredClone(l);
        const v = (r ?? b ?? l) as {name:string;kind?:string};
        return walk(b,l,r,describe(id,type === "models" ? "model" : "component",type === "models" ? `models/${id}.yaml` : `components/${v.kind}/${id}.yaml`,v.name),select);
      });
      if (type === "models") out.models = merged as ContractProject["models"];
      else out.components = merged as ContractProject["components"];
    }
    return out;
  }
  compose();
  // A new parent is one asset change, but its referenceable children still need
  // independent identity decisions before manual correspondence can be complete.
  if (remote) for (const node of syncEntityNodes(remote).filter(n=>["parameter","response","example"].includes(n.kind))) {
    if (edits.some(e=>e.change.entityId === node.id) || base && syncEntityNodes(base).some(n=>n.id === node.id)) continue;
    const ancestor = edits.find(e=>e.change.operation === "add" && e.change.path === node.path && e.change.fieldPath === "");
    if (!ancestor) continue;
    const entry = entries.get(node.id.toLowerCase());if(!entry || entry.ownership !== "source") continue;
    const localNode = syncEntityNodes(local).find(n=>n.id === node.id);
    changed(undefined,localNode?.value,node.value,{id:node.id,kind:node.kind,key:entry.externalKey,path:node.path,field:node.field,layer:ancestor.change.layer,label:entry.externalKey});
    edits[edits.length-1]!.identityOnly = true;
  }
  const referenceImpacts = transitionReferences(local,compose(e=>e.remote),edits);
  const changes = edits.map(e=>e.change).sort((a,b)=>order(a.changeId,b.changeId));
  const candidateDigest = hash(["apicc-sync-candidate-v1",input]);
  const idHex = `${candidateDigest.slice(0,12)}8${candidateDigest.slice(13,16)}a${candidateDigest.slice(17,32)}`;
  const candidate = SyncCandidateSchema.parse({ formatVersion:1,id:`${idHex.slice(0,8)}-${idHex.slice(8,12)}-${idHex.slice(12,16)}-${idHex.slice(16,20)}-${idHex.slice(20)}`,sourceId:input.source.id,stamp:input.stamp,upstream:input.upstream,candidateDigest,
    summary:{added:changes.filter(c=>c.operation === "add").length,updated:changes.filter(c=>c.operation === "update").length,removed:changes.filter(c=>c.operation === "remove").length,conflicts:conflicts.length},diagnostics,changes,conflicts:conflicts.sort((a,b)=>order(a.changeId,b.changeId)),referenceImpacts });
  assertBytes(candidate,input.budget.maxCompareOutputBytes,"SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED");
  return {input,candidate,local,base,remote,edits,compose: select=>compose(select)};
}
function entityArray(b: unknown[],l: unknown[],r: unknown[],map: (b:unknown,l:unknown,r:unknown,id:string)=>unknown): unknown[] {
  const ids = [...new Set([...l,...r,...b].map(v=>idOf(v)!))];
  return ids.flatMap(id=>{
    const next = map(b.find(v=>idOf(v) === id),l.find(v=>idOf(v) === id),r.find(v=>idOf(v) === id),id);
    return next === undefined ? [] : [next];
  });
}
function valueSummary(v: unknown): string {
  if (v === undefined) return "Absent";
  if (typeof v === "string") return v.length > 160 ? `${v.slice(0,157)}…` : v;
  if (Array.isArray(v)) return `${v.length} items`;
  if (v && typeof v === "object") return "Asset definition";
  return String(v);
}
export async function buildSyncCandidate(input: SyncPlanInput): Promise<SyncCandidate> { return (await compareSyncInput(input)).candidate; }

export function projectApis(project: ContractProject) {
  const result: ContractProject["collections"][number]["apis"] = [];
  const visit = (container: {apis:typeof result;folders:ContractProject["collections"][number]["folders"]}) => {result.push(...container.apis);container.folders.forEach(visit);};
  project.collections.forEach(visit); return result;
}
export function transitionReferences(before: ContractProject,after: ContractProject,edits: SyncEdit[],fallbackChangeId?: string): SyncCandidate["referenceImpacts"] {
  const impacts: SyncCandidate["referenceImpacts"] = [];
  const snapshot = createProjectSnapshot(before); const afterSnapshot = createProjectSnapshot(after);
  const afterIds = new Set([...projectApis(after).map(a=>a.contract.id),...after.models.map(a=>a.id),...after.components.map(a=>a.id)]);
  const removed = [...projectApis(before).map(a=>a.contract.id),...before.models.map(a=>a.id),...before.components.map(a=>a.id)].filter(id=>!afterIds.has(id));
  const add = (ownerId:string,targetId:string,path:string) => {
    const edit = edits.find(e=>e.change.entityId === targetId || idOf(e.local) === targetId) ?? edits.find(e=>e.change.entityId === ownerId) ?? edits[0];
    if (edit || fallbackChangeId) impacts.push({changeId:edit?.change.changeId ?? fallbackChangeId!,ownerId,targetId,path,reasonCode:"protected-reference",protected:true});
  };
  for (const id of removed) for (const ref of snapshot.context.referencesTo(id)) if (!removed.includes(ref.ownerId)) add(ref.ownerId,id,ref.path);
  for (const ref of afterSnapshot.context.diagnostics.filter(d=>d.targetId)) add(ref.ownerId,ref.targetId!,ref.path);
  const apis = projectApis(after);
  for (const [index,id] of (before.mock?.enabledContractIds ?? []).entries()) if (!apis.some(a=>a.contract.id === id)) add(before.id,id,`mock.enabledContractIds[${index}]`);
  for (const [index,rule] of (before.mock?.rules ?? []).entries()) {
    const api = apis.find(a=>a.contract.id === rule.contractId);
    if (!api) {add(rule.id,rule.contractId,`mock.rules[${index}].contractId`);continue;}
    const binding = api.contract.responses.find(r=>r.id === rule.responseBindingId);
    if (!binding) {add(rule.id,rule.responseBindingId,`mock.rules[${index}].responseBindingId`);continue;}
    const component = binding.kind === "componentRef" ? after.components.find(c=>c.id === binding.componentId && c.kind === "response") : undefined;
    const response = binding.kind === "inline" ? binding : component?.kind === "response" ? component.definition : undefined;
    if (rule.source.kind === "example" && !Object.values(response?.content ?? {}).some(c=>c.examples.some(e=>e.id === (rule.source as {exampleBindingId:string}).exampleBindingId))) add(rule.id,rule.source.exampleBindingId,`mock.rules[${index}].source.exampleBindingId`);
  }
  return impacts;
}

/** Traverse declared identity locations only. Example bodies, defaults, dataset
 * cells and arbitrary business JSON are never interpreted as project entities. */
export function projectIdentities(project: ContractProject): {id:string;kind:string;path:string}[] {
  const result: {id:string;kind:string;path:string}[] = [];
  const add = (id:string,kind:string,path:string)=>result.push({id,kind,path});
  add(project.id,"project","project.yaml");
  const examples = (content: Record<string,{examples:{id:string}[]}>,path:string) => {
    for (const [media,c] of Object.entries(content)) c.examples.forEach((e,i)=>add(e.id,"example",`${path}.content[${JSON.stringify(media)}].examples[${i}]`));
  };
  const request = (r: ReturnType<typeof projectApis>[number]["contract"]["request"],path:string) => {
    for (const key of ["pathParams","query","headers","cookies"] as const) r[key].forEach((p,i)=>add(p.id,"parameter",`${path}.${key}[${i}]`));
    if (r.auth.kind === "bearer") add(r.auth.token.id,"credential",`${path}.auth.token`);
    if (r.auth.kind === "basic") add(r.auth.password.id,"credential",`${path}.auth.password`);
    if (r.auth.kind === "apikey") add(r.auth.value.id,"credential",`${path}.auth.value`);
    if (r.protocol === "http" && r.body.kind === "urlencoded") r.body.fields.forEach((f,i)=>add(f.id,"request-entry",`${path}.body.fields[${i}]`));
    if (r.protocol === "http" && r.body.kind === "multipart") r.body.entries.forEach((e,i)=>add(e.id,"request-entry",`${path}.body.entries[${i}]`));
  };
  const visit = (c: ContractProject["collections"][number] | ContractProject["collections"][number]["folders"][number],kind:string,path:string) => {
    add(c.id,kind,path);
    [...c.preOperations,...c.postOperations].forEach(o=>add(o.id,"operation",path));
    c.apis.forEach(api=>{
      const ap = `${path}/apis/${api.contract.id}`; add(api.contract.id,"api",ap);request(api.contract.request,ap+"/request");
      api.contract.responses.forEach((r,i)=>{add(r.id,"response",ap+`/responses/${i}`);if(r.kind === "inline") examples(r.content,ap+`/responses/${i}`);});
      api.cases.forEach(test=>{add(test.id,"case",ap+"/cases");[...test.preOperations,...test.postOperations].forEach(o=>add(o.id,"operation",ap+"/cases"));if(test.requestOverride) request(test.requestOverride,ap+"/cases/requestOverride");});
    });
    c.folders.forEach(f=>visit(f,"folder",`${path}/folders/${f.id}`));
  };
  project.collections.forEach(c=>visit(c,"module",`collections/${c.id}`));
  project.models.forEach(m=>add(m.id,"model",`models/${m.id}`));
  project.components.forEach(c=>{add(c.id,"component",`components/${c.id}`);if(c.kind === "response") examples(c.definition.content,`components/${c.id}`);});
  project.environments.forEach(e=>add(e.id,"environment","environments"));
  project.workflows.forEach(w=>{add(w.id,"workflow","workflows");w.nodes.forEach(n=>add(n.id,"workflow-node","workflows/nodes"));w.edges.forEach(e=>add(e.id,"workflow-edge","workflows/edges"));});
  project.datasets?.forEach(d=>add(d.id,"dataset","datasets"));project.suites?.forEach(s=>add(s.id,"suite","suites"));
  project.mock?.rules.forEach(r=>add(r.id,"mock-rule","mock/rules"));project.stressPlans?.forEach(p=>add(p.id,"stress-plan","stressPlans"));
  return result;
}

export function mappedDefinitions(project: ContractProject,id: string): unknown[] {
  const values: unknown[] = [];
  const match = (v: {id:string})=>{if(v.id.toLowerCase() === id.toLowerCase()) values.push(v);};
  const examples = (content: Record<string,{examples:{id:string}[]}>)=>Object.values(content).forEach(c=>c.examples.forEach(match));
  const request = (r: ReturnType<typeof projectApis>[number]["contract"]["request"])=>[...r.pathParams,...r.query,...r.headers,...r.cookies].forEach(match);
  const visit = (c: ContractProject["collections"][number] | ContractProject["collections"][number]["folders"][number])=>{match(c);c.folders.forEach(visit);};
  project.collections.forEach(visit); project.models.forEach(match);
  project.components.forEach(c=>{match(c);if(c.kind === "response") examples(c.definition.content);});
  projectApis(project).forEach(a=>{if(a.contract.id.toLowerCase() === id.toLowerCase()) values.push(a);request(a.contract.request);a.cases.forEach(c=>{match(c);if(c.requestOverride) request(c.requestOverride);});a.contract.responses.forEach(r=>{match(r);if(r.kind === "inline") examples(r.content);});});
  return values;
}

export interface SyncEntityNode {id:string;kind:SyncEntityKind;parentId?:string;path:string;field:string;value:unknown;componentKind?:string}
export function syncEntityNodes(project: ContractProject): SyncEntityNode[] {
  const nodes:SyncEntityNode[] = [];
  const esc = (v:string)=>v.replace(/~/g,"~0").replace(/\//g,"~1");
  const addExamples = (content:Record<string,{examples:{id:string}[]}>,owner:string,path:string,field:string)=>{
    for(const [media,c] of Object.entries(content)) c.examples.forEach((e,i)=>nodes.push({id:e.id,kind:"example",parentId:owner,path,field:`${field}/content/${esc(media)}/examples/${i}`,value:e}));
  };
  const visit = (c:ContractProject["collections"][number] | ContractProject["collections"][number]["folders"][number],parent:string)=>{
    for(const api of c.apis) {
      const path = `${parent}/apis/${api.contract.id}/api.yaml`;nodes.push({id:api.contract.id,kind:"api",parentId:c.id,path,field:"",value:api});
      const r = api.contract.request;
      for(const key of ["pathParams","query","headers","cookies"] as const) r[key].forEach((p,i)=>nodes.push({id:p.id,kind:"parameter",parentId:api.contract.id,path,field:`/request/${key}/${i}`,value:p}));
      if(r.protocol === "http" && r.body.kind === "urlencoded") r.body.fields.forEach((p,i)=>nodes.push({id:p.id,kind:"parameter",parentId:api.contract.id,path,field:`/request/body/fields/${i}`,value:p}));
      if(r.protocol === "http" && r.body.kind === "multipart") r.body.entries.forEach((p,i)=>nodes.push({id:p.id,kind:"parameter",parentId:api.contract.id,path,field:`/request/body/entries/${i}`,value:p}));
      api.contract.responses.forEach((r,i)=>{nodes.push({id:r.id,kind:"response",parentId:api.contract.id,path,field:`/responses/${i}`,value:r});if(r.kind === "inline") addExamples(r.content,r.id,path,`/responses/${i}`);});
    }
    c.folders.forEach(f=>visit(f,`${parent}/folders/${f.id}`));
  };
  project.collections.forEach(c=>visit(c,`collections/${c.id}`));
  project.models.forEach(m=>nodes.push({id:m.id,kind:"model",path:`models/${m.id}.yaml`,field:"",value:m}));
  project.components.forEach(c=>{const path = `components/${c.kind}/${c.id}.yaml`;nodes.push({id:c.id,kind:"component",path,field:"",value:c,componentKind:c.kind});if(c.kind === "response") addExamples(c.definition.content,c.id,path,"/definition");});
  return nodes;
}
