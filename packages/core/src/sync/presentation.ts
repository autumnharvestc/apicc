import type { SyncCandidateView, SyncSummaryAttribute, SyncSummaryItem, SyncSummaryScalarValue, SyncValueSummary } from "./types.js";
export type SyncLanguage = "zh-CN" | "en";
const words: Record<string,readonly [string,string]> = {
  title:["外部规范同步候选","External specification sync candidate"],ready:["待确认全部变更","Review every change"],blocked:["来源诊断阻止应用","Source diagnostics block application"],
  add:["新增","Add"],update:["更新","Update"],remove:["删除","Remove"],added:["新增","Added"],updated:["更新","Updated"],removed:["删除","Removed"],conflicts:["冲突","Conflicts"],
  contract:["接口契约","API contract"],documentation:["文档","Documentation"],cases:["用例","Test cases"],models:["数据模型","Models"],components:["复用组件","Components"],structure:["目录结构","Structure"],
  decision:["需要明确决策","Explicit decision required"],warning:["警告","Warning"],error:["错误","Error"],info:["提示","Information"],
  "source-revision-changed":["来源配置已变化，请重新检查","Source configuration changed; check again"],"project-assets-changed":["项目资产已变化，请重新检查","Project assets changed; check again"],
  "mapping-revision-changed":["身份映射已变化，请重新检查","Identity mapping changed; check again"],"baseline-revision-changed":["确认基线已变化，请重新检查","Confirmed baseline changed; check again"],
  "authorization-changed":["授权已变化，请重新检查","Authorization changed; check again"],"core-identity-changed":["Core 版本已变化，请重新检查","Core identity changed; check again"],
  "candidate-expired":["候选已过期，请重新检查","Candidate expired; check again"],"source-disabled":["来源已停用","Source disabled"],"unresolved-conflicts":["存在待决策冲突","Conflicts need decisions"],
  "protected-reference":["存在受保护引用","Protected reference"],"missing-target":["引用目标缺失","Reference target missing"],"source-deletion":["上游删除被引用的资产","Source deletes a referenced asset"],
  absent:["不存在","Absent"],emptyText:["空文本","Empty text"],nullValue:["空值","Null"],true:["是","Yes"],false:["否","No"],array:["数组","Array"],object:["结构","Object"],itemsUnit:["项","items"],previewTruncated:["预览已截断，完整原文可查","Preview truncated; full source available"],unknownDiagnostic:["未知诊断","Unknown diagnostic"],
  api:["接口","API"],model:["模型","Model"],component:["组件","Component"],parameter:["参数","Parameter"],response:["响应","Response"],example:["示例","Example"],folder:["目录","Folder"],module:["模块","Module"],case:["用例","Case"],"schema-property":["字段","Schema property"],
  name:["名称","Name"],description:["说明","Description"],method:["方法","Method"],path:["路径","Path"],status:["状态","Status"],location:["位置","Location"],type:["类型","Type"],reference:["引用目标","Reference target"],parameters:["参数数","Parameters"],responses:["响应数","Responses"],examples:["示例数","Examples"],properties:["属性数","Properties"],property:["属性","Property"],required:["必填","Required"],value:["内容","Value"],items:["元素数","Items"],default:["默认值","Default"],tags:["标签","Tags"],version:["版本","Version"],baseUrl:["基础地址","Base URL"],protocol:["协议","Protocol"],
  query:["查询参数","Query"],header:["请求头","Header"],cookie:["Cookie 参数","Cookie"],auth:["认证","Authentication"],scalar:["标量","Scalar"],string:["文本","String"],number:["数值","Number"],integer:["整数","Integer"],boolean:["布尔值","Boolean"],null:["空值","Null"],modelRef:["模型引用","Model reference"],componentRef:["组件引用","Component reference"],inline:["内联定义","Inline definition"],allOf:["同时满足","All of"],oneOf:["唯一匹配","One of"],anyOf:["任一匹配","Any of"],
  apis:["接口数","APIs"],http:["HTTP","HTTP"],soap:["SOAP","SOAP"],websocket:["WebSocket","WebSocket"],
  draft:["草稿","Draft"],published:["已发布","Published"],deprecated:["已弃用","Deprecated"],
};
const diagnosticWords:Record<string,readonly [string,string]> = {
  SYNC_EXTERNAL_REFERENCE_UNSUPPORTED:["来源引用了不支持的外部定义","The source references an unsupported external definition"],
  SYNC_INTERNAL_REFERENCE_UNRESOLVED:["来源中的内部引用无法解析","An internal source reference cannot be resolved"],
  SYNC_SOURCE_PARSE_FAILED:["来源不是有效的受支持规范文档","The source is not a valid supported specification document"],
  SYNC_OPENAPI_VERSION_UNSUPPORTED:["来源使用了不支持的 OpenAPI 版本","The source uses an unsupported OpenAPI version"],
  SYNC_SOURCE_BYTES_EXCEEDED:["来源原文字节数超出限制","Source bytes exceed the configured limit"],
  SYNC_NORMALIZED_BYTES_EXCEEDED:["归一化内容超出比较输入限制","Normalized content exceeds the comparison input limit"],
  SYNC_NORMALIZE_DEPTH_EXCEEDED:["规范嵌套深度超出限制","Specification nesting exceeds the depth limit"],
  SYNC_NORMALIZE_NODES_EXCEEDED:["规范节点数超出限制","Specification nodes exceed the configured limit"],
  SYNC_YAML_ALIAS_CYCLE:["来源存在循环 YAML 别名","The source contains cyclic YAML aliases"],
  SYNC_OPERATION_ID_DUPLICATE:["来源操作标识重复，不能据此确认对应关系","Source operation IDs are duplicated and cannot establish correspondence"],
  SYNC_IDENTITY_MATCH_SUGGESTION:["发现可能的旧身份，请人工确认对应关系","A previous identity may match; confirm correspondence manually"],
  SYNC_IDENTITY_UNMATCHED:["来源实体没有已确认的旧身份对应","The source entity has no confirmed previous correspondence"],
  SYNC_IDENTITY_AMBIGUOUS:["身份映射存在重复或歧义","Identity mappings contain duplicates or ambiguity"],
  SYNC_IDENTITY_UNMAPPED:["来源实体缺少已确认的身份映射","The source entity lacks a confirmed identity mapping"],
  SYNC_CROSS_SOURCE_OWNERSHIP:["实体已归属其他来源，禁止接管","The entity belongs to another source and cannot be taken over"],
  SYNC_LOCAL_ID_OCCUPIED:["来源身份与项目内其他资产或保留身份冲突","The source identity collides with another local asset or reserved identity"],
  SYNC_LOCAL_MODIFIED:["本地内容与来源不同","Local content differs from the source"],
  OPENAPI_EXTERNAL_REFERENCE_UNSUPPORTED:["OpenAPI 外部引用不受支持","External OpenAPI references are unsupported"],
  OPENAPI_CALLBACKS_UNSUPPORTED:["OpenAPI 回调尚不支持同步","OpenAPI callbacks are not supported for synchronization"],
  OPENAPI_WEBHOOKS_UNSUPPORTED:["OpenAPI Webhook 尚不支持同步","OpenAPI webhooks are not supported for synchronization"],
  OPENAPI_COMPONENTS_UNSUPPORTED:["部分 OpenAPI 组件无法表示","Some OpenAPI components cannot be represented"],
  OPENAPI_EXTERNAL_DOCS_UNREPRESENTED:["外部文档链接未纳入同步资产","External documentation links are not included in synchronized assets"],
  OPENAPI_INFO_DESCRIPTION_UNREPRESENTED:["规范级说明未纳入同步资产","Specification-level descriptions are not included in synchronized assets"],
  OPENAPI_INFO_FIELD_UNSUPPORTED:["部分规范信息字段不受支持","Some specification information fields are unsupported"],
  OPENAPI_OPERATION_FIELD_UNSUPPORTED:["部分接口操作字段不受支持","Some operation fields are unsupported"],
  OPENAPI_OPERATION_UNSUPPORTED:["部分接口操作无法表示","Some operations cannot be represented"],
  OPENAPI_PATH_FIELD_UNSUPPORTED:["部分路径字段不受支持","Some path fields are unsupported"],
  OPENAPI_PATH_ITEM_UNSUPPORTED:["部分路径项无法表示","Some path items cannot be represented"],
  OPENAPI_PATH_REFERENCE_UNSUPPORTED:["路径引用无法表示","Path references cannot be represented"],
  OPENAPI_ROOT_FIELD_UNSUPPORTED:["部分规范顶层字段不受支持","Some specification root fields are unsupported"],
  OPENAPI_SCHEMES_UNREPRESENTED:["部分协议方案未纳入同步资产","Some transport schemes are not included in synchronized assets"],
  OPENAPI_SERVER_VARIABLE_UNRESOLVED:["服务地址变量无法解析","A server URL variable cannot be resolved"],
  OPENAPI_SERVERS_UNREPRESENTED:["部分服务地址未纳入同步资产","Some server URLs are not included in synchronized assets"],
  OPENAPI_TAG_METADATA_UNREPRESENTED:["标签元数据未纳入同步资产","Tag metadata is not included in synchronized assets"],
};
/** Browser-safe business DTO. Schema and raw wire rendering remain secondary
 * consumer details; no object serialization is used for primary row values. */
export function presentSyncCandidate(view: SyncCandidateView, language: SyncLanguage = "zh-CN") {
  const t = (key:string) => words[key]?.[language === "en" ? 1 : 0] ?? key;
  const join = language === "en" ? "; " : "；";
  const colon = language === "en" ? ": " : "：";
  const value = (v:SyncSummaryScalarValue):string=>v === null ? t("nullValue") : typeof v === "boolean" ? t(String(v)) : v === "" ? t("emptyText") : String(v);
  const attribute = (a:SyncSummaryAttribute)=>`${t(a.label)}${a.name === undefined ? "" : " " + a.name}${colon}${(a.label === "type" || a.label === "location") && typeof a.value === "string" ? t(a.value) : value(a.value)}${a.truncated ? "…" : ""}`;
  const format = (s:SyncValueSummary | SyncSummaryItem):string=>{
    if(s.kind === "absent") return t("absent");
    if(s.kind === "scalar") return value(s.value)+(s.truncated ? `… (${t("previewTruncated")})` : "");
    if(s.kind === "array") return `${t("array")}${colon}${s.count} ${t("itemsUnit")}${"items" in s && s.items.length ? colon+s.items.map(format).join(join) : ""}${"truncated" in s && s.truncated ? ` (${t("previewTruncated")})` : ""}`;
    return `${t(s.entityKind ?? "object")}${s.attributes.length ? colon+s.attributes.map(attribute).join(join) : ""}${s.truncated ? ` (${t("previewTruncated")})` : ""}`;
  };
  const schemaType = (path:string)=>!/(?:^|\/)(?:value|default|enum)(?:\/|$)/.test(path) && /\/schema(?:\/(?:properties\/[^/]+|items|variants\/\d+|additionalProperties))*\/(?:kind|type)$/.test(path);
  const changeValue = (summary:SyncValueSummary,path:string)=>summary.kind === "scalar" && typeof summary.value === "string" && (path === "/metadata/status" || schemaType(path)) ? t(summary.value) : format(summary);
  const field = (change:SyncCandidateView["candidate"]["changes"][number])=>{
    if(change.fieldPath === "") return t(change.layer === "documentation" ? "documentation" : change.entityKind);
    const path = change.fieldPath;
    if(schemaType(path)) return t("type");
    if(/^\/metadata\/(?:name|description|tags|version|status)$/.test(path) || /^\/request\/(?:method|path|baseUrl|protocol)$/.test(path)) return t(path.slice(path.lastIndexOf("/")+1));
    if(/\/(?:description|name|required|status)$/.test(path) && !/\/(?:value|default|properties)\//.test(path)) return t(path.slice(path.lastIndexOf("/")+1));
    if(path.endsWith("/value") && path.includes("/examples/")) return t("value");
    if(path.endsWith("/default")) return t("default");
    return path;
  };
  const {candidate} = view;
  return {title:t("title"),status:!view.applicable && view.reasonCode ? t(view.reasonCode) : candidate.diagnostics.some(d=>d.severity === "error") ? t("blocked") : t("ready"),
    summary:(["added","updated","removed","conflicts"] as const).map(key=>({label:t(key),value:candidate.summary[key]})),
    changes:candidate.changes.map(change=>({name:change.label,operation:t(change.operation),layer:t(change.layer),field:field(change),decision:t("decision"),baseline:changeValue(change.summaries.baseline,change.fieldPath),current:changeValue(change.summaries.current,change.fieldPath),source:changeValue(change.summaries.source,change.fieldPath)})),
    diagnostics:candidate.diagnostics.map(d=>({severity:t(d.severity),message:diagnosticWords[d.code]?.[language === "en" ? 1 : 0] ?? `${t("unknownDiagnostic")} (${d.code})${colon}${d.message.slice(0,240)}`,code:d.code,path:d.path})),
    references:candidate.referenceImpacts.map(r=>({ownerId:r.ownerId,targetId:r.targetId,path:r.path,reason:t(r.reasonCode)})),
    advanced:{collapsed:true,digest:candidate.candidateDigest,shortDigest:candidate.candidateDigest.slice(0,12),
      changes:candidate.changes.map(c=>({changeId:c.changeId,path:c.path,fieldPath:c.fieldPath,entityId:c.entityId,entityKind:c.entityKind,layer:c.layer,sides:["baseline","current","source"] as const,lookup:"fixed-candidate-typed-entity" as const})),
      diagnostics:candidate.diagnostics.map(d=>({code:d.code,message:d.message,path:d.path})),
      conflicts:candidate.conflicts}};
}
