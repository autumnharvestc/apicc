import { describe, expect, it } from "vitest";
import { buildSyncCandidate } from "../../src/sync/compare.js";
import { SyncCandidateSchema, SyncChangeSchema, SyncPlanInputSchema, SyncValueSummarySchema } from "../../src/sync/types.js";
import { syncWireFixture } from "./wireFixtures.js";
import { summarizeSyncValue } from "../../src/sync/summary.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { applyResolved, normalizedReviewFixture, projectFiles, threeWayFixture } from "./fixtures.js";
import { resolveSyncCandidate } from "../../src/sync/resolve.js";
import { presentSyncCandidate } from "../../src/sync/presentation.js";

describe("real three-way source comparison", () => {
  it("establishes actual target identity, stable child identities and references", async () => {
    const f = await threeWayFixture();
    expect(f.localProject.id).not.toBe(f.remoteProject.id);
    expect(createProjectSnapshot(f.localProject).context.diagnostics).toEqual([]);
    expect(f.localProject.collections[0]!.apis[0]!.contract.responses[0]!.id).toBe(f.remoteProject.collections[0]!.apis[0]!.contract.responses[0]!.id);
    expect(f.planInput().stamp.definitionRevision).toBe(createProjectSnapshot(f.localProject).definitionRevision);
  });
  it.each([
    { name: "only local", local: "local", remote: "", changes: 0, conflicts: 0 },
    { name: "only upstream", local: "", remote: "upstream", changes: 1, conflicts: 0 },
    { name: "same concurrent value", local: "same", remote: "same", changes: 1, conflicts: 0 },
    { name: "conflicting field", local: "local", remote: "upstream", changes: 1, conflicts: 1 },
  ])("compares $name using B/L/R", async ({ local, remote, changes, conflicts }) => {
    const f = await threeWayFixture();
    f.localProject.collections[0]!.apis[0]!.contract.metadata.description = local;
    f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = remote;
    const c = await buildSyncCandidate(f.planInput());
    expect(c.changes.filter(c=>c.fieldPath.endsWith("/description"))).toHaveLength(changes);
    expect(c.conflicts).toHaveLength(conflicts);
  });
  it("separates disjoint fields and reports readable summaries without embedding objects", async () => {
    const f = await threeWayFixture();
    f.localProject.collections[0]!.apis[0]!.contract.metadata.name = "Local name";
    f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "New documentation";
    const c = await buildSyncCandidate(f.planInput());
    expect(c.conflicts).toEqual([]);
    expect(c.changes).toHaveLength(1);
    expect(c.changes[0]).toMatchObject({ path: expect.stringMatching(/\/api.yaml$/), fieldPath: "/metadata/description", layer: "contract" });
  });
  it("binds the entire immutable input and is independent of file-list order", async () => {
    const f = await threeWayFixture(); const input = f.planInput();
    const first = await buildSyncCandidate(input);
    expect(await buildSyncCandidate({ ...input, localFiles: [...input.localFiles].reverse() })).toEqual(first);
    f.localProject.name = "Different local project metadata";
    expect((await buildSyncCandidate(f.planInput())).candidateDigest).not.toBe(first.candidateDigest);
    expect(first.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps warnings and refuses destructive comparison from normalization errors", async () => {
    const f = await threeWayFixture();
    const diagnostic = { code: "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED", severity: "error" as const, ownerId: f.source.moduleId, path: "/paths", message: "External reference unsupported" };
    const c = await buildSyncCandidate({ ...f.planInput(), remoteFiles: [], normalizationDiagnostics: [diagnostic] });
    expect(c.diagnostics).toContainEqual(diagnostic); expect(c.changes).toEqual([]);
    const warning = { ...diagnostic, severity: "warning" as const };
    expect((await buildSyncCandidate({ ...f.planInput(), normalizationDiagnostics: [warning] })).diagnostics).toContainEqual(warning);
  });
  it("requires explicit diagnostics and complete other-source context in the strict wire", async () => {
    const input = (await threeWayFixture()).planInput();
    const { normalizationDiagnostics: _d, otherSourceMappings: _o, ...legacyInput } = input;
    expect(SyncPlanInputSchema.safeParse(legacyInput).success).toBe(false);
    const { normalizationDiagnostics, ...noDiagnostics } = input;
    const { otherSourceMappings, ...noOwnership } = input;
    expect(SyncPlanInputSchema.safeParse(noDiagnostics).success).toBe(false);
    expect(SyncPlanInputSchema.safeParse(noOwnership).success).toBe(false);
    expect(SyncPlanInputSchema.safeParse({ ...input, otherSourceMappings: [{ ...input.mapping, unknown: true }] }).success).toBe(false);
  });
  it("detects true inbound dependency deletion from a local case", async () => {
    const f = await threeWayFixture(); const model = f.localProject.models[0]!;
    const api = f.localProject.collections[0]!.apis[0]!;
    api.cases[0]!.assertions.push({ id: "schema-local", target: "bodyJson", match: "first", op: "schema", expected: "", options: { schema: { kind: "modelRef", modelId: model.id } } });
    f.remoteProject.models = [];
    f.remoteProject.collections[0]!.apis[0]!.contract.responses = [];
    const c = await buildSyncCandidate(f.planInput());
    expect(c.referenceImpacts).toContainEqual(expect.objectContaining({ ownerId: api.contract.id, targetId: model.id, protected: true, path: expect.stringContaining("cases") }));
  });
  it("reports cross-source ownership and ambiguous mapping instead of silently taking over IDs", async () => {
    const f = await threeWayFixture();
    f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "upstream";
    const other = { ...f.mapping, sourceId: "00000000-0000-4000-8000-000000000799" };
    const c = await buildSyncCandidate({ ...f.planInput(), otherSourceMappings: [other] });
    expect(c.diagnostics.some(d=>d.code === "SYNC_CROSS_SOURCE_OWNERSHIP" && d.severity === "error")).toBe(true);
    const mapping = { ...f.mapping, entries: [...f.mapping.entries, { ...f.mapping.entries[0]!, externalKey: "/duplicate" }] };
    expect((await buildSyncCandidate({ ...f.planInput(), mapping })).diagnostics.some(d=>d.code === "SYNC_IDENTITY_AMBIGUOUS")).toBe(true);
  });
  it.each(["stamp", "sourceRevision", "mappingRevision", "duplicate", "missing-root", "input-budget", "output-budget"])("rejects invalid %s before a usable candidate", async kind => {
    const f = await threeWayFixture(); const input = f.planInput();
    if (kind === "stamp") input.stamp.definitionRevision = "0".repeat(64);
    if (kind === "sourceRevision") input.stamp.sourceRevision = "2";
    if (kind === "mappingRevision") input.stamp.mappingRevision = "2";
    if (kind === "duplicate") input.localFiles.push(input.localFiles[0]!);
    if (kind === "missing-root") input.remoteFiles = input.remoteFiles.filter(f=>f.path !== "project.yaml");
    if (kind === "input-budget") { f.localProject.name = "x".repeat(1024*1024); input.localFiles = projectFiles(f.localProject); input.stamp.definitionRevision = createProjectSnapshot(f.localProject).definitionRevision; input.budget.maxCompareInputBytes = 1024*1024; }
    if (kind === "output-budget") { f.remoteProject.collections[0]!.apis[0]!.documentation = "x".repeat(300*1024); input.remoteFiles = projectFiles(f.remoteProject); input.normalizationDiagnostics = [{ code: "LARGE_WARNING", severity: "warning", ownerId: f.source.moduleId, path: "", message: "x".repeat(300*1024) }]; input.budget.maxCompareOutputBytes = 256*1024; }
    await expect(buildSyncCandidate(input)).rejects.toThrow(/^SYNC_/);
  });
  it("presents Chinese and English business rows with visible stale reasons and secondary full digest", async () => {
    const f = await threeWayFixture(); f.localProject.collections[0]!.apis[0]!.contract.metadata.description = "local"; f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "source";
    const candidate = await buildSyncCandidate(f.planInput());
    const view = {candidate,applicable:false,reasonCode:"project-assets-changed" as const};
    const zh = presentSyncCandidate(view); const en = presentSyncCandidate(view,"en");
    expect(zh.title).toBe("外部规范同步候选"); expect(zh.status).toBe("项目资产已变化，请重新检查");
    expect(zh.summary).toContainEqual({label:"冲突",value:1});
    expect(zh.changes[0]).toMatchObject({operation:"更新",layer:"接口契约",current:"local",source:"source",decision:"需要明确决策"});
    expect(en.status).toBe("Project assets changed; check again"); expect(en.changes[0]!.operation).toBe("Update");
    expect(zh.advanced).toMatchObject({collapsed:true,digest:candidate.candidateDigest}); expect(zh.advanced.shortDigest.length).toBeLessThan(candidate.candidateDigest.length);
  });
  it.each(["api","parameter","response","model"])("reports %s collisions with real reserved project IDs, beyond the passed source map", async kind => {
    const f = await threeWayFixture(); const api = f.remoteProject.collections[0]!.apis[0]!;
    const entity = kind === "api" ? api.contract : kind === "parameter" ? api.contract.request.pathParams[0]! : kind === "response" ? api.contract.responses[0]! : f.remoteProject.models[0]!;
    const originalId = entity.id; entity.id = f.localProject.id;
    if (kind === "model") { const response = api.contract.responses[0]!; if (response.kind === "inline") response.content["application/json"]!.schema = {kind:"modelRef",modelId:f.localProject.id}; }
    const mapping = {...f.mapping,entries:f.mapping.entries.map(e=>e.entityId === originalId ? {...e,entityId:f.localProject.id} : e)};
    const candidate = await buildSyncCandidate({...f.planInput(),mapping});
    expect(candidate.diagnostics.some(d=>d.code === "SYNC_LOCAL_ID_OCCUPIED")).toBe(true);
  });
  it.each(["source-module","mapping-source"])("rejects mismatched %s context (supplemental verification)", async kind => {
    const f = await threeWayFixture();const input = f.planInput();
    if(kind === "source-module") input.source.moduleId = "00000000-0000-4000-8000-000000000788";
    else input.mapping.sourceId = "00000000-0000-4000-8000-000000000788";
    await expect(buildSyncCandidate(input)).rejects.toThrow(kind === "source-module" ? "SYNC_SOURCE_MODULE_MISMATCH" : "SYNC_STAMP_MISMATCH");
  });
});

describe("I3/M1 strict bounded review facts contract", () => {
  const scalar = {kind:"scalar",value:"Readable business text",truncated:false};
  const attribute = {label:"name",value:"Pets",truncated:false};
  const structure = {kind:"structure",entityKind:"api",attributes:[attribute],truncated:false};
  const array = {kind:"array",count:2,items:[scalar,structure],truncated:false};
  const legal = ()=>({...syncWireFixture().change,summaries:{baseline:{kind:"absent"},current:structure,source:array}});
  it("accepts full legal facts through the existing real candidate seam before negative assertions", () => {
    const f = syncWireFixture();expect(SyncCandidateSchema.safeParse({...f.candidate,changes:[legal()]}).success).toBe(true);
    for(const value of [{kind:"absent"},scalar,{...scalar,value:null},{...scalar,value:false},{...scalar,value:0},structure,array]) expect(SyncValueSummarySchema.safeParse(value).success).toBe(true);
  });
  it.each([
    {name:"missing summaries",mutate:(v:any)=>{delete v.summaries;}},
    {name:"missing side",mutate:(v:any)=>{delete v.summaries.current;}},
    {name:"unknown envelope field",mutate:(v:any)=>{v.summaries.raw={};}},
    {name:"unknown summary kind",mutate:(v:any)=>{v.summaries.source={kind:"raw",value:"{}"};}},
    {name:"absent extra field",mutate:(v:any)=>{v.summaries.source={kind:"absent",raw:"{}"};}},
    {name:"scalar object",mutate:(v:any)=>{v.summaries.source={...scalar,value:{raw:true}};}},
    {name:"scalar nonfinite",mutate:(v:any)=>{v.summaries.source={...scalar,value:Infinity};}},
    {name:"scalar text bound",mutate:(v:any)=>{v.summaries.source={...scalar,value:"x".repeat(241)};}},
    {name:"scalar missing truncation",mutate:(v:any)=>{v.summaries.source={kind:"scalar",value:"x"};}},
    {name:"scalar extra field",mutate:(v:any)=>{v.summaries.source={...scalar,raw:"{}"};}},
    {name:"negative count",mutate:(v:any)=>{v.summaries.source={...array,count:-1};}},
    {name:"fractional count",mutate:(v:any)=>{v.summaries.source={...array,count:1.5};}},
    {name:"array preview bound",mutate:(v:any)=>{v.summaries.source={...array,items:Array(6).fill(scalar)};}},
    {name:"array extra field",mutate:(v:any)=>{v.summaries.source={...array,raw:"[]"};}},
    {name:"array missing truncation",mutate:(v:any)=>{v.summaries.source={kind:"array",count:0,items:[]};}},
    {name:"preview invalid kind",mutate:(v:any)=>{v.summaries.source={...array,items:[{kind:"raw"}]};}},
    {name:"nested array strict field",mutate:(v:any)=>{v.summaries.source={...array,items:[{kind:"array",count:2,raw:[]}]};}},
    {name:"structure missing entity kind",mutate:(v:any)=>{v.summaries.source={kind:"structure",attributes:[],truncated:false};}},
    {name:"structure unknown entity kind",mutate:(v:any)=>{v.summaries.source={...structure,entityKind:"secret"};}},
    {name:"structure extra field",mutate:(v:any)=>{v.summaries.source={...structure,raw:{}};}},
    {name:"structure missing truncation",mutate:(v:any)=>{v.summaries.source={kind:"structure",entityKind:null,attributes:[]};}},
    {name:"attributes bound",mutate:(v:any)=>{v.summaries.source={...structure,attributes:Array(9).fill(attribute)};}},
    {name:"attribute unknown label",mutate:(v:any)=>{v.summaries.source={...structure,attributes:[{...attribute,label:"raw"}]};}},
    {name:"attribute name bound",mutate:(v:any)=>{v.summaries.source={...structure,attributes:[{...attribute,name:"x".repeat(81)}]};}},
    {name:"attribute text bound",mutate:(v:any)=>{v.summaries.source={...structure,attributes:[{...attribute,value:"x".repeat(241)}]};}},
    {name:"attribute missing truncation",mutate:(v:any)=>{v.summaries.source={...structure,attributes:[{label:"name",value:"Pets"}]};}},
    {name:"attribute extra field",mutate:(v:any)=>{v.summaries.source={...structure,attributes:[{...attribute,raw:{}}]};}},
    {name:"scalar missing value",mutate:(v:any)=>{v.summaries.source={kind:"scalar",truncated:false};}},
    {name:"truncation flag type",mutate:(v:any)=>{v.summaries.source={...scalar,truncated:"false"};}},
    {name:"array missing count",mutate:(v:any)=>{v.summaries.source={kind:"array",items:[],truncated:false};}},
    {name:"array count type",mutate:(v:any)=>{v.summaries.source={...array,count:"2"};}},
    {name:"array missing items",mutate:(v:any)=>{v.summaries.source={kind:"array",count:0,truncated:false};}},
    {name:"structure missing attributes",mutate:(v:any)=>{v.summaries.source={kind:"structure",entityKind:null,truncated:false};}},
    {name:"attribute missing value",mutate:(v:any)=>{v.summaries.source={...structure,attributes:[{label:"name",truncated:false}]};}},
  ])("rejects $name after a valid summary positive control", ({mutate}) => {
    expect(SyncChangeSchema.safeParse(legal()).success).toBe(true);
    const invalid = structuredClone(legal());mutate(invalid);expect(SyncChangeSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("I3/M1 actual readable candidate review facts", () => {
  it("labels a real container API count by business meaning", async () => {
    const f = await threeWayFixture();
    expect(summarizeSyncValue(f.remoteProject.collections[0],"module")).toMatchObject({attributes:expect.arrayContaining([{label:"apis",value:1,truncated:false}])});
  });
  it("provides the actual new parameter location in its typed summary", async () => {
    const baseline = {openapi:"3.1.0",info:{title:"Pets",version:"1"},paths:{}};
    const remote = {...baseline,paths:{"/pets":{get:{parameters:[{name:"q",in:"query",schema:{type:"string"}}],responses:{"200":{description:"ok"}}}}}};
    const normalized = await normalizedReviewFixture(baseline,remote);const candidate = await buildSyncCandidate(normalized.input());
    expect(candidate.changes.find(c=>c.entityKind === "parameter")!.summaries.source).toMatchObject({attributes:expect.arrayContaining([{label:"name",value:"q",truncated:false},{label:"location",value:"query",truncated:false}])});
  });
  it("shows ordinary upstream-only field values without loading another current input", async () => {
    const f = await threeWayFixture();f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "Upstream details to review";
    const candidate = await buildSyncCandidate(f.planInput());expect(candidate.conflicts).toEqual([]);
    const change = candidate.changes[0]!;
    expect(change.summaries).toEqual({baseline:{kind:"scalar",value:"",truncated:false},current:{kind:"scalar",value:"",truncated:false},source:{kind:"scalar",value:"Upstream details to review",truncated:false}});
    const view = presentSyncCandidate({candidate,applicable:true,reasonCode:null});
    expect(view.changes[0]).toMatchObject({field:"说明",current:"空文本",source:"Upstream details to review"});
    expect(view.advanced).toMatchObject({collapsed:true,changes:[{changeId:change.changeId,path:change.path,fieldPath:"/metadata/description"}]});
  });
  it("provides named structured additions and explicit deletion absence without JSON primary strings", async () => {
    const f = await threeWayFixture();const original = f.baseProject.collections[0]!.apis[0]!;
    f.baseProject.collections[0]!.apis = [];f.localProject.collections[0]!.apis = [];
    const candidate = await buildSyncCandidate(f.planInput());const change = candidate.changes.find(c=>c.entityKind === "api")!;
    expect(change.summaries).toMatchObject({current:{kind:"absent"},source:{kind:"structure",entityKind:"api",attributes:expect.arrayContaining([{label:"name",value:original.contract.metadata.name,truncated:false},{label:"method",value:"GET",truncated:false},{label:"path",value:"/pets/{id}",truncated:false}])}});
    const row = presentSyncCandidate({candidate,applicable:true,reasonCode:null}).changes.find(c=>c.name === original.contract.metadata.name)!;
    expect(row.current).toBe("不存在");expect(row.source).toContain("GET");expect(row.source).toContain("/pets/{id}");expect(row.source).not.toContain("Asset definition");expect(row.source).not.toContain('{"');
    const removed = await threeWayFixture();removed.localProject.collections[0]!.apis[0]!.cases = [];removed.remoteProject.collections[0]!.apis = [];
    const deletion = await buildSyncCandidate(removed.planInput());expect(presentSyncCandidate({candidate:deletion,applicable:true,reasonCode:null}).changes[0]!.source).toBe("不存在");
  });
  it("bounds scalar text and ordered array previews while retaining complete source file text", async () => {
    const f = await threeWayFixture();const text = "业务原文".repeat(100);f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = text;
    const candidate = await buildSyncCandidate(f.planInput());expect(candidate.changes[0]!.summaries).toMatchObject({source:{kind:"scalar",value:text.slice(0,240),truncated:true}});expect(f.planInput().remoteFiles.some(file=>file.content.includes(text))).toBe(true);
    const tags = await threeWayFixture();tags.remoteProject.collections[0]!.apis[0]!.contract.metadata.tags = ["一","二","三","四","五","六"];
    const arrayCandidate = await buildSyncCandidate(tags.planInput());expect(arrayCandidate.changes[0]!.summaries.source).toMatchObject({kind:"array",count:6,items:[{kind:"scalar",value:"一",truncated:false},{kind:"scalar",value:"二",truncated:false},{kind:"scalar",value:"三",truncated:false},{kind:"scalar",value:"四",truncated:false},{kind:"scalar",value:"五",truncated:false}],truncated:true});
    const zh = presentSyncCandidate({candidate:arrayCandidate,applicable:true,reasonCode:null});const en = presentSyncCandidate({candidate:arrayCandidate,applicable:true,reasonCode:null},"en");expect(zh.changes[0]!.source).toContain("6 项");expect(zh.changes[0]!.source).not.toContain("items");expect(en.changes[0]!.source).toContain("6 items");
  });
  it("localizes known diagnostics while keeping unknown failure code visible and original messages inspectable", async () => {
    const f = await threeWayFixture();const diagnostics = [{code:"SYNC_EXTERNAL_REFERENCE_UNSUPPORTED",severity:"error" as const,ownerId:f.source.moduleId,path:"/paths",message:"External reference unsupported original evidence"},{code:"FUTURE_UNKNOWN_CODE",severity:"error" as const,ownerId:f.source.moduleId,path:"/future",message:"Original unknown failure reason"}];
    const candidate = await buildSyncCandidate({...f.planInput(),normalizationDiagnostics:diagnostics});const view = {candidate,applicable:true,reasonCode:null};
    const zh = presentSyncCandidate(view);const en = presentSyncCandidate(view,"en");expect(zh.diagnostics[0]!.message).toBe("来源引用了不支持的外部定义");expect(en.diagnostics[0]!.message).toBe("The source references an unsupported external definition");
    expect(zh.diagnostics[1]).toMatchObject({code:"FUTURE_UNKNOWN_CODE",message:expect.stringContaining("未知诊断")});
    expect(zh.advanced).toMatchObject({collapsed:true,diagnostics:diagnostics.map(d=>({code:d.code,message:d.message,path:d.path}))});
  });
  it.each([{path:"/metadata/status",source:"已弃用"},{path:"/schema/kind",source:"标量"},{path:"/schema/type",source:"文本"},{path:"/metadata/description",source:"deprecated"}])("localizes declared value at $path and preserves business prose", async ({path,source}) => {
    const f = await threeWayFixture();const api = f.remoteProject.collections[0]!.apis[0]!;api.contract.metadata.status = "deprecated";api.contract.metadata.description = "deprecated";
    f.remoteProject.models[0]!.schema = {kind:"scalar",type:"string"};
    const candidate = await buildSyncCandidate(f.planInput());const view = presentSyncCandidate({candidate,applicable:true,reasonCode:null});
    const row = (path:string)=>view.changes[candidate.changes.findIndex(c=>c.fieldPath === path)]!;
    expect(row(path).source).toBe(source);if(path === "/metadata/status") expect(row(path).current).toBe("草稿");
  });
});

describe("I1 ordered business JSON review regression", () => {
  it.each(["example","default"])("keeps %s arrays ordered and makes source reorder reviewable and decidable", async location => {
    const ordered = [{id:"a",n:1},{id:"b",n:2}], reversed = [...ordered].reverse();
    const doc = (value:typeof ordered)=>({openapi:"3.1.0",info:{title:"Pets",version:"1"},paths:{"/pets":{get:{responses:{"200":{description:"ok",content:{"application/json":{schema:{type:"array",items:{type:"object"},...(location === "default" ? {default:value} : {})},...(location === "example" ? {examples:{pets:{value}}} : {})}}}}}}}});
    const f = await normalizedReviewFixture(doc(ordered),doc(reversed));
    expect(f.baseline.files).not.toEqual(f.remote.files);
    const candidate = await buildSyncCandidate(f.input());
    expect(candidate.changes.length).toBeGreaterThan(0);
    expect(candidate.conflicts).toEqual([]);
    for(const decision of ["take-source","keep-current"] as const) {
      const plan = await resolveSyncCandidate({candidate,planInput:f.input(),decisions:{formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>({changeId:c.changeId,decision}))}});
      const project = await applyResolved(f.input(),plan);const response = project.collections[0]!.apis[0]!.contract.responses[0]!;
      if(response.kind !== "inline") throw new Error("Expected inline response");
      const content = response.content["application/json"]!;const actual = location === "default" ? content.schema?.default : content.examples[0]?.kind === "inline" ? content.examples[0].value : undefined;
      expect(actual).toEqual(decision === "take-source" ? reversed : ordered);
    }
  });
});

describe("M2 actual container summary producer review regression", () => {
  const document = {openapi:"3.1.0",info:{title:"Pets",version:"1"},paths:{"/pets":{get:{responses:{"200":{description:"ok"}}}}}};
  it.each([{language:"zh-CN" as const,expected:"模块：名称：Pets；接口数：1"},{language:"en" as const,expected:"Module: Name: Pets; APIs: 1"}])("presents a real first-sync module with business labels in $language", async ({language,expected}) => {
    const f = await normalizedReviewFixture(document,document,true);
    f.localProject.collections = [];
    const input = {...f.input(),baselineFiles:[]};
    const candidate = await buildSyncCandidate(input);
    expect(candidate.diagnostics.filter(d=>d.severity === "error")).toEqual([]);
    const index = candidate.changes.findIndex(change=>change.entityKind === "module" && change.operation === "add");
    expect(index).toBeGreaterThanOrEqual(0);
    const row = presentSyncCandidate({candidate,applicable:true,reasonCode:null},language).changes[index]!;
    expect(row.source).toBe(expected);
    expect(candidate.changes[index]!.summaries.source).toEqual({kind:"structure",entityKind:"module",attributes:[{label:"name",value:"Pets",truncated:false},{label:"apis",value:1,truncated:false}],truncated:false});
    for(const internal of ["preOperations","postOperations","variables","folders","属性 apis","元素数 apis"]) expect(row.source).not.toContain(internal);
  });
  it("keeps an ordinary business object resembling a container generic", async () => {
    const value = {id:"00000000-0000-4000-8000-000000000702",name:"Business object",variables:{local:"business"},preOperations:[],postOperations:[],folders:[],apis:[]};
    const withExample = (example:unknown)=>({openapi:"3.1.0",info:{title:"Pets",version:"1"},paths:{"/pets":{get:{responses:{"200":{description:"ok",content:{"application/json":{examples:{pets:{value:example}}}}}}}}}});
    const f = await normalizedReviewFixture(withExample("before"),withExample(value));
    const candidate = await buildSyncCandidate(f.input());
    const change = candidate.changes.find(c=>c.fieldPath.endsWith("/value"))!;
    expect(change.summaries.source).toMatchObject({kind:"structure",entityKind:null});
    expect(change.summaries.source).not.toMatchObject({entityKind:"module"});
    expect(presentSyncCandidate({candidate,applicable:true,reasonCode:null}).changes[candidate.changes.indexOf(change)]!.source).toContain("Business object");
  });
});
