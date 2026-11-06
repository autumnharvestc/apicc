import type { ApiAsset, ApiRequest, ComponentAsset, JsonValue, ParameterBinding, ResponseBinding, ResponseContent, SchemaNode } from "../contract/model.js";
import { SchemaNodeSchema } from "../contract/schemaNode.js";
import type { ContractProject, ContractFolder, ContractCollection } from "../contract/workspace.js";
import { projectApis } from "./compare.js";

/** Rewrite only schema-declared IDs and reference locations. JSON example
 * values, schema annotations, scripts, text and material references stay data. */
export interface SyncChildSelection { parentId: string; value: unknown }
export function applySyncCorrespondence(project: ContractProject,current: ContractProject,ids: ReadonlyMap<string,string>,choices: ReadonlyMap<string,SyncChildSelection>): void {
  const map = (id:string)=>ids.get(id) ?? id;
  const union = <T extends {id:string}>(local:T[],source:T[]):T[]=>[...local.filter(l=>!source.some(s=>s.id === l.id)),...source];
  const contents = (local:Record<string,ResponseContent>,source:Record<string,ResponseContent>)=>{
    const out = structuredClone(source);
    for(const [media,c] of Object.entries(out)) c.examples = union(local[media]?.examples ?? [],c.examples);
    return out;
  };
  const mergeRequest = (source:ApiRequest,target:ApiRequest):ApiRequest=>{
    const out = structuredClone(source);out.auth = structuredClone(target.auth);
    for(const key of ["pathParams","query","headers","cookies"] as const) out[key] = union(target[key],out[key]);
    return out;
  };
  const containers:(ContractCollection | ContractFolder)[] = [];
  const collect = (c:ContractCollection | ContractFolder)=>{containers.push(c);c.folders.forEach(collect);};project.collections.forEach(collect);
  const originalApis = projectApis(current);
  // Install a mapped parent at the original target position. Local suite/case
  // locators therefore retain their collection and folder path as well as UUID.
  for(const [sourceId,targetId] of ids) {
    const source = projectApis(project).find(a=>a.contract.id === sourceId),target = originalApis.find(a=>a.contract.id === targetId);
    if(source && target) {
      const merged:ApiAsset = {...source,contract:{...source.contract,request:mergeRequest(source.contract.request,target.contract.request),responses:union(target.contract.responses,source.contract.responses)},cases:structuredClone(target.cases)};
      for(const c of containers) c.apis = c.apis.flatMap(a=>a.contract.id === targetId ? [merged] : a.contract.id === sourceId ? [] : [a]);
    }
  }
  for(const key of ["models","components"] as const) {
    const sourceValues = project[key];const originalValues = current[key];
    const replacements = new Map<string,typeof sourceValues[number]>();
    for(const [sourceId,targetId] of ids) {
      const source = sourceValues.find(v=>v.id === sourceId),target = originalValues.find(v=>v.id === targetId);
      if(!source || !target) continue;
      let merged = structuredClone(source);
      if(key === "components") {
        const sc = merged as ComponentAsset,tc = target as ComponentAsset;
        if(sc.kind === "auth" && tc.kind === "auth") sc.definition = structuredClone(tc.definition);
        if(sc.kind === "response" && tc.kind === "response") sc.definition.content = contents(tc.definition.content,sc.definition.content);
      }
      replacements.set(targetId,merged);
    }
    const result = sourceValues.flatMap(v=>replacements.has(v.id) ? [replacements.get(v.id)!] : ids.has(v.id) && replacements.has(ids.get(v.id)!) && ids.get(v.id) !== v.id ? [] : [v]);
    if(key === "models") project.models = result as ContractProject["models"];else project.components = result as ContractProject["components"];
  }
  const selected = <T extends {id:string}>(values:T[],kind:"parameter" | "response" | "example",parentId:string,applyChoices = true):T[]=>{
    const sourceIds = new Set(values.filter(v=>ids.has(v.id)).map(v=>v.id));
    const targets = new Set([...sourceIds].map(map));
    return values.flatMap(v=>{
      const choice = applyChoices ? choices.get(v.id) : undefined;
      const value = choice?.parentId === parentId ? choice.value : v;
      return value === undefined || !sourceIds.has(v.id) && targets.has(v.id) ? [] : [structuredClone(value) as T];
    }).map(v=>{
      const old = v.id,targetId = map(old);
      if(kind === "parameter") {
        const target = findParameter(current,targetId);const p = v as unknown as ParameterBinding;
        if(target && applyChoices) {if(target.value !== undefined) p.value = target.value;if(target.enabled !== undefined) p.enabled = target.enabled;}
      }
      if(kind === "response" && ids.has(old)) {
        const target = projectApis(current).flatMap(a=>a.contract.responses).find(r=>r.id === targetId),source = v as unknown as ResponseBinding;
        if(source.kind === "inline" && target?.kind === "inline") source.content = contents(target.content,source.content);
      }
      v.id = targetId;return v;
    });
  };
  const schema = (s:SchemaNode):void=>{
    if(s.kind === "modelRef") s.modelId = map(s.modelId);
    else if(s.kind === "object") {Object.values(s.properties).forEach(schema);if(typeof s.additionalProperties === "object") schema(s.additionalProperties);}
    else if(s.kind === "array") schema(s.items);else if(s.kind === "allOf" || s.kind === "oneOf" || s.kind === "anyOf") s.variants.forEach(schema);
  };
  const content = (values:Record<string,ResponseContent>,parentId:string)=>{for(const c of Object.values(values)) {if(c.schema) schema(c.schema);c.examples = selected(c.examples,"example",parentId);c.examples.forEach(e=>{if(e.kind === "componentRef") e.componentId = map(e.componentId);});}};
  const request = (r:ApiRequest,parentId:string,applyChoices = true)=>{
    for(const key of ["pathParams","query","headers","cookies"] as const) {r[key] = selected(r[key],"parameter",parentId,applyChoices);r[key].forEach(p=>p.kind === "componentRef" ? p.componentId = map(p.componentId) : schema(p.schema));}
    if(r.auth.kind === "componentRef") r.auth.componentId = map(r.auth.componentId);
    if(r.protocol === "http") {
      if(r.body.kind === "urlencoded") r.body.fields = selected(r.body.fields,"parameter",parentId,applyChoices);
      if(r.body.kind === "multipart") r.body.entries = selected(r.body.entries,"parameter",parentId,applyChoices);
      if("schema" in r.body && r.body.schema) schema(r.body.schema);
    }
  };
  for(const a of projectApis(project)) {
    a.contract.id = map(a.contract.id);request(a.contract.request,a.contract.id);a.contract.responses = selected(a.contract.responses,"response",a.contract.id);
    a.contract.responses.forEach(r=>r.kind === "componentRef" ? r.componentId = map(r.componentId) : content(r.content,r.id));
    a.cases.forEach(c=>{if(c.requestOverride) request(c.requestOverride,a.contract.id,false);c.assertions.forEach(assertion=>{if(assertion.op === "schema" && assertion.options?.schema) {const parsed = SchemaNodeSchema.safeParse(assertion.options.schema);if(parsed.success) {schema(parsed.data);assertion.options.schema = parsed.data as unknown as JsonValue;}}});});
  }
  project.models.forEach(m=>{m.id = map(m.id);schema(m.schema);});
  project.components.forEach(c=>{c.id = map(c.id);if(c.kind === "parameter") schema(c.definition.schema);if(c.kind === "response") content(c.definition.content,c.id);});
}
function findParameter(project:ContractProject,id:string):ParameterBinding | undefined {
  return projectApis(project).flatMap(a=>{const r = a.contract.request;return [...r.pathParams,...r.query,...r.headers,...r.cookies];}).find(p=>p.id === id);
}
