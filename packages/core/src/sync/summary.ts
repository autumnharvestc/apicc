import type { SyncEntityKind, SyncSummaryAttribute, SyncSummaryItem, SyncSummaryScalar, SyncSummaryScalarValue, SyncSummaryStructure, SyncValueSummary } from "./types.js";

type RecordValue = Record<string,unknown>;
const record = (value:unknown):value is RecordValue=>value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value:unknown):value is SyncSummaryScalarValue=>value === null || ["string","number","boolean"].includes(typeof value);
function clipped(value:string,maximum:number):string {
  let result = value.slice(0,maximum);
  if(/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0,-1);
  return result;
}
function scalarSummary(value:SyncSummaryScalarValue):SyncSummaryScalar {
  return {kind:"scalar",value:typeof value === "string" ? clipped(value,240) : value,truncated:typeof value === "string" && value.length > 240};
}
export function summarizeSyncValue(value:unknown,entityKind:SyncEntityKind | null = null,itemKind:SyncEntityKind | null = null,location?:string):SyncValueSummary {
  if(value === undefined) return {kind:"absent"};
  if(scalar(value)) return scalarSummary(value);
  if(Array.isArray(value)) return {kind:"array",count:value.length,items:value.slice(0,5).map((item):SyncSummaryItem=>scalar(item) ? scalarSummary(item) : Array.isArray(item) ? {kind:"array",count:item.length} : structureSummary(item as RecordValue,itemKind,location)),truncated:value.length > 5};
  return structureSummary(value as RecordValue,entityKind,location);
}
function structureSummary(value:RecordValue,entityKind:SyncEntityKind | null,location?:string):SyncSummaryStructure {
  const attributes:SyncSummaryAttribute[] = [];
  const add = (label:SyncSummaryAttribute["label"],value:unknown,name?:string)=>{
    if(!scalar(value)) return;
    const preview = scalarSummary(value);
    attributes.push({label,...(name === undefined ? {} : {name:clipped(name,80)}),value:preview.value,truncated:preview.truncated || name !== undefined && name.length > 80});
  };
  const business = (data:unknown,prefix = "")=>{
    if(scalar(data)) {add("value",data);return;}
    if(Array.isArray(data)) {
      add("items",data.length);
      data.slice(0,5).forEach((item,index)=>{
        if(scalar(item)) add("property",item,`${prefix}[${index}]`);
        else if(record(item)) for(const [key,v] of Object.entries(item)) add("property",v,`${prefix}[${index}].${key}`);
      });
      return;
    }
    if(record(data)) for(const [key,v] of Object.entries(data)) {
      if(scalar(v)) add("property",v,prefix+key);
      else if(Array.isArray(v)) add("items",v.length,prefix+key);
      else if(record(v)) add("properties",Object.keys(v).length,prefix+key);
    }
  };
  const schema = (schema:unknown)=>{
    if(!record(schema)) return;
    add("type",schema.kind === "scalar" ? schema.type : schema.kind);
    if(record(schema.properties)) {add("properties",Object.keys(schema.properties).length);for(const [name,node] of Object.entries(schema.properties)) if(record(node)) add("type",node.kind === "scalar" ? node.type : node.kind,name);}
    if(schema.kind === "modelRef") add("reference",schema.modelId);
  };
  const content = (content:unknown)=>{
    if(!record(content)) return;
    add("location",Object.keys(content).join(", "));
    add("examples",Object.values(content).reduce<number>((sum,v)=>sum+(record(v) && Array.isArray(v.examples) ? v.examples.length : 0),0));
  };
  if(entityKind === "api") {
    const contract = record(value.contract) ? value.contract : value;
    const metadata = record(contract.metadata) ? contract.metadata : {};
    const request = record(contract.request) ? contract.request : {};
    add("name",metadata.name);add("method",request.method);add("path",request.path);add("description",metadata.description);
    add("parameters",[request.pathParams,request.query,request.headers,request.cookies].reduce<number>((sum,v)=>sum+(Array.isArray(v) ? v.length : 0),0));
    if(Array.isArray(contract.responses)) add("responses",contract.responses.length);
    add("type",request.protocol);
  } else if(entityKind === "model") {
    add("name",value.name);add("description",value.description);schema(value.schema);
  } else if(entityKind === "component") {
    add("name",value.name);add("type",value.kind);add("description",value.description);
    const definition = record(value.definition) ? value.definition : {};
    if(value.kind === "parameter") {add("name",definition.name);add("location",definition.location);add("required",definition.required);schema(definition.schema);}
    if(value.kind === "response") {add("status",definition.status);add("description",definition.description);content(definition.content);}
    if(value.kind === "example") business(definition.value);
    // An auth component exposes its kind and metadata, never its credential refs.
  } else if(entityKind === "parameter") {
    add("name",value.name);add("location",location);add("description",value.description);add("required",value.required);add("reference",value.componentId);schema(value.schema);
  } else if(entityKind === "response") {
    add("status",value.status);add("description",value.description);add("reference",value.componentId);content(value.content);
  } else if(entityKind === "example") {
    add("name",value.name);add("reference",value.componentId);if(value.kind === "inline") business(value.value);
  } else if(entityKind === "module" || entityKind === "folder") {
    add("name",value.name);if(Array.isArray(value.apis)) add("apis",value.apis.length);
  } else business(value);
  return {kind:"structure",entityKind,attributes:attributes.slice(0,8),truncated:attributes.length > 8};
}
