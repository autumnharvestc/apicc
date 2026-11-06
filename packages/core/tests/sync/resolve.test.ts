import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ApiTestCaseSchema } from "../../src/contract/model.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { buildSyncCandidate } from "../../src/sync/compare.js";
import { resolveSyncCandidate } from "../../src/sync/resolve.js";
import { contentReference, manifestDigest } from "../../src/sync/files.js";
import { applyResolved, candidateFixture, mappingFixture, projectFiles, threeWayFixture } from "./fixtures.js";
import { compileProjectMock } from "../../src/mock/compile.js";
import { normalizeSyncSource } from "../../src/sync/normalize.js";
import { normalizedReviewFixture, readProject, syncFixture } from "./fixtures.js";
import type { SyncDecisions, SyncPlanInput } from "../../src/sync/types.js";

const decide = (candidate: Awaited<ReturnType<typeof buildSyncCandidate>>, decision: "take-source" | "keep-current"): SyncDecisions => ({formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>({changeId:c.changeId,decision}))});
async function resolveAll(input: SyncPlanInput,decision: "take-source" | "keep-current" = "take-source") {
  const candidate = await buildSyncCandidate(input);
  return resolveSyncCandidate({candidate,decisions:decide(candidate,decision),planInput:input});
}
describe("complete fixed candidate decisions", () => {
  it("uses a genuine unresolved conflict fixture", async () => {
    const f = await candidateFixture(); expect(f.candidate.conflicts).toHaveLength(1); expect(f.keepCurrentDecisions.entries).toHaveLength(1);
  });
  it("takes source while retaining actual target root, local cases, credentials and disjoint edits", async () => {
    const f = await threeWayFixture(); const api = f.localProject.collections[0]!.apis[0]!;
    api.contract.metadata.name = "Local name";
    api.contract.request.auth = {kind:"bearer",token:{id:"local-secret-ref",policy:"local"}};
    f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "Upstream description";
    const input = f.planInput(); const before = structuredClone(input);
    const plan = await resolveAll(input); const project = await applyResolved(input,plan);
    expect(project.id).toBe(f.localProject.id); expect(project.name).toBe("Actual local target"); expect(project.variables).toEqual({local:"keep"});
    const actual = project.collections[0]!.apis[0]!;
    expect(actual.contract.metadata).toMatchObject({name:"Local name",description:"Upstream description"});
    expect(actual.cases).toEqual(api.cases); expect(actual.contract.request.auth).toEqual(api.contract.request.auth);
    expect(actual.contract.responses.map(r=>r.id)).toEqual(api.contract.responses.map(r=>r.id));
    expect(actual.contract.request.pathParams.map(r=>r.id)).toEqual(api.contract.request.pathParams.map(r=>r.id));
    expect(project.models).toEqual(f.localProject.models);
    expect(plan.before.manifestDigest).toBe(manifestDigest(input.localFiles));
    expect(plan.after.definitionRevision).toBe(createProjectSnapshot(project).definitionRevision);
    expect(plan.baselineFiles).toEqual(input.remoteFiles); expect(input).toEqual(before);
  });
  it("explicitly keeps current and advances only the confirmed source baseline", async () => {
    const f = await candidateFixture(); const plan = await resolveSyncCandidate(f.resolveInput);
    expect(plan.writes).toEqual([]); expect(plan.deletions).toEqual([]);
    expect(plan.baselineFiles).toEqual(f.planInput.remoteFiles);
    expect(plan.before).toEqual(plan.after); expect(plan.decisionsDigest).not.toBe("0".repeat(64));
  });
  it.each(["missing","duplicate","unknown","wrong-envelope","candidate-tamper","candidate-stamp","input-changed"])("rejects %s decisions or immutable candidate mismatch", async kind => {
    const f = await candidateFixture(); const input = structuredClone(f.resolveInput);
    if (kind === "missing") input.decisions.entries = [];
    if (kind === "duplicate") input.decisions.entries.push(input.decisions.entries[0]!);
    if (kind === "unknown") input.decisions.entries[0]!.changeId = "f".repeat(64);
    if (kind === "wrong-envelope") input.decisions.candidateDigest = "f".repeat(64);
    if (kind === "candidate-tamper") input.candidate.changes[0]!.label = "tampered";
    if (kind === "candidate-stamp") input.candidate.stamp.authorizationGeneration = "2";
    if (kind === "input-changed") input.planInput.stamp.authorizationGeneration = "2";
    await expect(resolveSyncCandidate(input)).rejects.toThrow(kind === "missing" ? "SYNC_DECISION_REQUIRED" : /^SYNC_/);
  });
  it("rejects semantic diagnostics even if no change remains to decide", async () => {
    const f = await threeWayFixture();
    const input = {...f.planInput(),remoteFiles:[],normalizationDiagnostics:[{code:"SYNC_BAD_REFERENCE",severity:"error" as const,ownerId:f.source.moduleId,path:"/paths",message:"Invalid upstream"}]};
    await expect(resolveAll(input)).rejects.toThrow("SYNC_DIAGNOSTICS_BLOCKED");
  });
  it("protects a local case reference and permits keeping the source-deleted model", async () => {
    const f = await threeWayFixture(); const model = f.localProject.models[0]!;
    f.localProject.collections[0]!.apis[0]!.cases[0]!.assertions.push({id:"local-schema",target:"bodyJson",match:"first",op:"schema",options:{schema:{kind:"modelRef",modelId:model.id}}});
    f.remoteProject.models = []; f.remoteProject.collections[0]!.apis[0]!.contract.responses = [];
    await expect(resolveAll(f.planInput())).rejects.toThrow("SYNC_PROTECTED_REFERENCE");
    const candidate = await buildSyncCandidate(f.planInput()); const decisions = decide(candidate,"take-source");
    decisions.entries = decisions.entries.map(d=>candidate.changes.find(c=>c.changeId === d.changeId)?.entityId === model.id ? {...d,decision:"keep-current"} : d);
    const plan = await resolveSyncCandidate({candidate,decisions,planInput:f.planInput()});
    expect((await applyResolved(f.planInput(),plan)).models[0]!.id).toBe(model.id);
  });
  it("protects a real Mock response subentity rather than checking only API IDs", async () => {
    const f = await threeWayFixture(); const api = f.localProject.collections[0]!.apis[0]!;
    f.localProject.mock = {formatVersion:1,seed:"fixture",enabledContractIds:[api.contract.id],rules:[{id:"00000000-0000-4000-8000-000000000751",enabled:true,contractId:api.contract.id,conditions:[],responseBindingId:api.contract.responses[0]!.id,mediaType:"application/json",source:{kind:"literal",text:"{}"},delayMs:0}]};
    f.remoteProject.collections[0]!.apis[0]!.contract.responses = [];
    const candidate = await buildSyncCandidate(f.planInput());
    expect(candidate.referenceImpacts.some(r=>r.path.includes("responseBindingId") && r.targetId === api.contract.responses[0]!.id)).toBe(true);
    await expect(resolveAll(f.planInput())).rejects.toThrow("SYNC_PROTECTED_REFERENCE");
  });
  it("preserves unrelated local assets and rejects deleting the owner of local cases", async () => {
    const f = await threeWayFixture();
    const local = structuredClone(f.localProject.collections[0]!.apis[0]!); local.contract.id = "00000000-0000-4000-8000-000000000752"; local.contract.request.path = "/local"; local.cases = [];
    f.localProject.collections[0]!.apis.push(local);
    f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "remote";
    const plan = await resolveAll(f.planInput()); const result = await applyResolved(f.planInput(),plan);
    expect(result.collections[0]!.apis.find(a=>a.contract.id === local.contract.id)).toEqual(local);
    f.remoteProject.collections[0]!.apis = [];
    await expect(resolveAll(f.planInput())).rejects.toThrow("SYNC_PROTECTED_LOCAL_ASSET");
  });
  it("rejects cross-source writes even when every change is explicitly accepted", async () => {
    const f = await threeWayFixture(); f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "source";
    await expect(resolveAll({...f.planInput(),otherSourceMappings:[{...f.mapping,sourceId:"00000000-0000-4000-8000-000000000753"}]})).rejects.toThrow("SYNC_DIAGNOSTICS_BLOCKED");
  });
  it("maps an explicit new source API to one unowned local API and records its mapping", async () => {
    const f = await threeWayFixture(); const api = f.localProject.collections[0]!.apis[0]!;
    const oldId = api.contract.id; api.contract.id = "00000000-0000-4000-8000-000000000754";
    f.baseProject.collections[0]!.apis = [];
    const input = f.planInput(); const candidate = await buildSyncCandidate(input);
    const change = candidate.changes.find(c=>c.entityId === oldId && c.operation === "add"); expect(change).toBeDefined();
    const decisions = decide(candidate,"take-source"); decisions.entries = decisions.entries.map(d=>d.changeId === change!.changeId ? {changeId:d.changeId,decision:"map-existing",existingEntityId:api.contract.id} : d);
    const plan = await resolveSyncCandidate({candidate,decisions,planInput:input}); const result = await applyResolved(input,plan);
    expect(result.collections[0]!.apis).toHaveLength(1); expect(result.collections[0]!.apis[0]!.contract.id).toBe(api.contract.id);
    expect(result.collections[0]!.apis[0]!.cases).toEqual(api.cases);
    expect(plan.mapping.entries.find(e=>e.entityKind === "api")?.entityId).toBe(api.contract.id);
    expect(plan.mapping.entries.find(e=>e.entityKind === "api")?.correspondence).toBe("manual");
  });
  it("rejects map-existing on an ordinary field conflict", async () => {
    const f = await candidateFixture();
    await expect(resolveSyncCandidate({...f.resolveInput,decisions:{...f.keepCurrentDecisions,entries:[{changeId:f.candidate.changes[0]!.changeId,decision:"map-existing",existingEntityId:f.localProject.collections[0]!.apis[0]!.contract.id}]}})).rejects.toThrow("SYNC_MAPPING_DECISION_INVALID");
  });
  it("produces deterministic decisions digests regardless of entry order", async () => {
    const f = await threeWayFixture(); const remote = f.remoteProject.collections[0]!.apis[0]!;
    remote.contract.metadata.description = "source"; remote.documentation = "Doc source";
    const candidate = await buildSyncCandidate(f.planInput()); const decisions = decide(candidate,"take-source");
    const a = await resolveSyncCandidate({candidate,decisions,planInput:f.planInput()});
    const b = await resolveSyncCandidate({candidate,decisions:{...decisions,entries:[...decisions.entries].reverse()},planInput:f.planInput()});
    expect(a).toEqual(b); expect(a.writes).toHaveLength(2); expect(contentReference(a.baselineFiles).bytes).toBeGreaterThan(0);
  });
  it("requires an explicit correspondence before taking over an occupied source API ID", async () => {
    const f = await threeWayFixture();
    await expect(resolveAll({...f.planInput(),baselineFiles:[]})).rejects.toThrow("SYNC_MAPPING_DECISION_REQUIRED");
  });
  it("retains local container script hooks even when incoming files carry different hooks", async () => {
    const f = await threeWayFixture(); const folderId = "00000000-0000-4000-8000-000000000755";
    const folder = {id:folderId,name:"source folder",preOperations:[{id:"hook-local",type:"script" as const,content:"console.log('local')"}],postOperations:[],folders:[],apis:[]};
    f.baseProject.collections[0]!.folders = [{...folder,preOperations:[]}];
    f.localProject.collections[0]!.folders = [structuredClone(folder)];
    f.remoteProject.collections[0]!.folders = [{...folder,preOperations:[{...folder.preOperations[0]!,content:"console.log('source')"}]}];
    f.mapping.entries.push({entityKind:"folder",externalKey:"/folder",entityId:folderId,ownerExternalKey:"/module",aliases:[],ownership:"source",correspondence:"confirmed"});
    const input = f.planInput(); const plan = await resolveAll(input); const result = await applyResolved(input,plan);
    expect(result.collections[0]!.folders[0]!.preOperations).toEqual(folder.preOperations);
  });
  it.each(["missing","other-source","wrong-kind"])("refuses a %s mapping target", async kind => {
    const f = await threeWayFixture(); const original = f.localProject.collections[0]!.apis[0]!;
    original.contract.id = "00000000-0000-4000-8000-000000000756";
    const input = {...f.planInput(),baselineFiles:[]}; const candidate = await buildSyncCandidate(input);
    const apiChange = candidate.changes.find(c=>c.entityKind === "api")!;
    const target = kind === "missing" ? "00000000-0000-4000-8000-000000000757" : kind === "wrong-kind" ? f.localProject.models[0]!.id : original.contract.id;
    if (kind === "other-source") input.otherSourceMappings = [{...f.mapping,sourceId:"00000000-0000-4000-8000-000000000758",entries:[{...f.mapping.entries.find(e=>e.entityKind === "api")!,entityId:target}]}];
    const fixed = await buildSyncCandidate(input); const decisions = decide(fixed,"take-source"); decisions.entries = decisions.entries.map(d=>d.changeId === apiChange.changeId ? {changeId:d.changeId,decision:"map-existing",existingEntityId:target} : d);
    await expect(resolveSyncCandidate({candidate:fixed,decisions,planInput:input})).rejects.toThrow(kind === "wrong-kind" ? "SYNC_MAPPING_KIND_MISMATCH" : "SYNC_MAPPING_TARGET_UNAVAILABLE");
  });
  it("permits deletion of an entire unreferenced source dependency closure", async () => {
    const f = await threeWayFixture();f.localProject.collections[0]!.apis[0]!.cases = [];
    f.remoteProject.collections[0]!.apis = [];f.remoteProject.models = [];
    const plan = await resolveAll(f.planInput());const project = await applyResolved(f.planInput(),plan);
    expect(project.collections[0]!.apis).toEqual([]);expect(project.models).toEqual([]);
  });
  it("does not rewrite unrelated or kept-current file formatting", async () => {
    const f = await threeWayFixture();const input = f.planInput();input.localFiles = input.localFiles.map(file=>file.path === "project.yaml" ? {...file,content:file.content+"\n"} : file);
    const plan = await resolveAll(input,"keep-current");expect(plan.writes).toEqual([]);expect(plan.after).toEqual(plan.before);
  });
});

describe("I2 actual identityOnly child decisions review regression", () => {
  const empty = {openapi:"3.1.0",info:{title:"Pets",version:"1"},paths:{}};
  const populated = {
    ...empty,
    paths: { "/pets": { get: {
      parameters: [{in:"query",name:"q",schema:{type:"string"},description:"source description"}],
      responses: { "200": { description:"source response", content: {
        "application/json": { examples: { pets: {value:{message:"source example"}} } },
      } } },
    } } },
  };
  it.each(["parameter","response","example"].flatMap(kind=>(["take-source","keep-current"] as const).map(decision=>({kind,decision}))))("honors $decision for existing $kind under an explicitly mapped parent", async ({kind,decision}) => {
      const f = await normalizedReviewFixture(empty,populated,true);const api = f.localProject.collections[0]!.apis[0]!;
      const parameter = api.contract.request.query[0]!;if(parameter.kind !== "inline") throw new Error("Expected inline parameter");parameter.description = "local description";parameter.value = "local binding";parameter.enabled = false;
      const response = api.contract.responses[0]!;if(response.kind !== "inline") throw new Error("Expected response");response.description = "local response";
      const example = response.content["application/json"]!.examples[0]!;if(example.kind !== "inline") throw new Error("Expected example");example.value = {message:"local example"};
      f.localProject.mock = {formatVersion:1,seed:"review",enabledContractIds:[api.contract.id],rules:[{id:randomUUID(),enabled:true,contractId:api.contract.id,conditions:[],responseBindingId:response.id,mediaType:"application/json",source:{kind:"example",exampleBindingId:example.id},delayMs:0}]};
      api.contract.request.auth = {kind:"bearer",token:{id:"local-review-auth",policy:"local"}};
      expect(compileProjectMock(createProjectSnapshot(f.localProject)).ok).toBe(true);
      const candidate = await buildSyncCandidate(f.input());const parent = candidate.changes.find(c=>c.entityKind === "api")!;
      const entries:SyncDecisions["entries"] = candidate.changes.map(c=>c.changeId === parent.changeId ? {changeId:c.changeId,decision:"map-existing",existingEntityId:api.contract.id} : {changeId:c.changeId,decision:c.entityKind === kind ? decision : c.entityKind === "response" && kind === "example" ? "take-source" : "keep-current"});
      const plan = await resolveSyncCandidate({candidate,planInput:f.input(),decisions:{formatVersion:1,candidateDigest:candidate.candidateDigest,entries}});
      const project = await applyResolved(f.input(),plan);const actualApi = project.collections[0]!.apis[0]!,actualParameter = actualApi.contract.request.query[0]!,actualResponse = actualApi.contract.responses[0]!;
      if(actualParameter.kind !== "inline" || actualResponse.kind !== "inline") throw new Error("Expected retained declared kinds");
      const actualExample = actualResponse.content["application/json"]!.examples[0]!;
      if(kind === "parameter") expect(actualParameter.description).toBe(decision === "keep-current" ? "local description" : "source description");
      if(kind === "response") expect(actualResponse.description).toBe(decision === "keep-current" ? "local response" : "source response");
      if(kind === "example") expect(actualExample).toMatchObject({value:{message:decision === "keep-current" ? "local example" : "source example"}});
      expect(actualParameter.value).toBe("local binding");expect(actualParameter.enabled).toBe(false);expect(actualApi.contract.request.auth).toEqual(api.contract.request.auth);expect(compileProjectMock(createProjectSnapshot(project)).ok).toBe(true);
  });
  it("omits a source-only child kept current and retains typed parent dependency rejection", async () => {
    const f = await normalizedReviewFixture(empty,populated,true);const api = f.localProject.collections[0]!.apis[0]!;api.contract.request.query = [];
    const candidate = await buildSyncCandidate(f.input());const parent = candidate.changes.find(c=>c.entityKind === "api")!,parameter = candidate.changes.find(c=>c.entityKind === "parameter")!;
    const entries:SyncDecisions["entries"] = candidate.changes.map(c=>c.changeId === parent.changeId ? {changeId:c.changeId,decision:"map-existing",existingEntityId:api.contract.id} : {changeId:c.changeId,decision:"keep-current"});
    const plan = await resolveSyncCandidate({candidate,planInput:f.input(),decisions:{formatVersion:1,candidateDigest:candidate.candidateDigest,entries}});expect((await applyResolved(f.input(),plan)).collections[0]!.apis[0]!.contract.request.query).toEqual([]);
    const inconsistent = entries.map(d=>d.changeId === parent.changeId ? {changeId:d.changeId,decision:"keep-current" as const} : d.changeId === parameter.changeId ? {changeId:d.changeId,decision:"take-source" as const} : d);
    await expect(resolveSyncCandidate({candidate,planInput:f.input(),decisions:{formatVersion:1,candidateDigest:candidate.candidateDigest,entries:inconsistent}})).rejects.toThrow("SYNC_MAPPING_PARENT_NOT_SELECTED");
  });
  it("preserves an existing local case request override binding independently of the API binding", async () => {
    const f = await normalizedReviewFixture(empty,populated,true);const api = f.localProject.collections[0]!.apis[0]!;
    api.contract.request.query[0]!.value = "API binding";
    const requestOverride = structuredClone(api.contract.request);requestOverride.query[0]!.value = "case binding";
    api.cases.push(ApiTestCaseSchema.parse({id:randomUUID(),name:"Local override",parameters:{},assertions:[],requestOverride}));
    const candidate = await buildSyncCandidate(f.input());const parent = candidate.changes.find(c=>c.entityKind === "api")!;
    const entries:SyncDecisions["entries"] = candidate.changes.map(c=>c.changeId === parent.changeId ? {changeId:c.changeId,decision:"map-existing",existingEntityId:api.contract.id} : {changeId:c.changeId,decision:"keep-current"});
    const plan = await resolveSyncCandidate({candidate,planInput:f.input(),decisions:{formatVersion:1,candidateDigest:candidate.candidateDigest,entries}});const project = await applyResolved(f.input(),plan);
    expect(project.collections[0]!.apis[0]!.cases[0]!.requestOverride!.query[0]!.value).toBe("case binding");
    expect(project.collections[0]!.apis[0]!.contract.request.query[0]!.value).toBe("API binding");
  });
});

describe("typed parent and referenced-child correspondence", () => {
  async function mappedInput() {
    const f = await mappingFixture(); const candidate = await buildSyncCandidate(f.input);
    const decisions: SyncDecisions = {formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>({changeId:c.changeId,decision:"map-existing",existingEntityId:f.targetFor(c.entityId)!}))};
    return {...f,candidate,decisions};
  }
  it("establishes a valid local Mock graph and source-generated component/model identities", async () => {
    const f = await mappingFixture(); expect(createProjectSnapshot(f.localProject).context.diagnostics).toEqual([]); const mock = compileProjectMock(createProjectSnapshot(f.localProject));expect(mock.ok,JSON.stringify(mock)).toBe(true);
    expect(f.input.normalizationDiagnostics.filter(d=>d.severity === "error")).toEqual([]);
    expect(f.input.mapping.entries.some(e=>e.entityKind === "example")).toBe(true);
  });
  it("exposes parent and every referenced child as explicit stable decisions", async () => {
    const f = await mappedInput();
    for (const kind of ["api","model","component","parameter","response","example"]) expect(f.candidate.changes.some(c=>c.entityKind === kind),kind).toBe(true);
    expect(f.candidate.changes.filter(c=>c.entityKind === "response")[0]!.fieldPath).toBe("/responses/0");
  });
  it("maps models, components, parameters, responses and examples while retaining true Mock and local bindings", async () => {
    const f = await mappedInput(); const plan = await resolveSyncCandidate({candidate:f.candidate,decisions:f.decisions,planInput:f.input});
    const result = await applyResolved(f.input,plan);
    expect(result.collections[0]!.apis).toHaveLength(1);expect(result.models).toHaveLength(1);expect(result.components).toHaveLength(3);
    expect(result.collections[0]!.apis[0]!.contract.id).toBe(f.localProject.collections[0]!.apis[0]!.contract.id);
    expect(result.collections[0]!.apis[0]!.contract.responses).toEqual(f.localProject.collections[0]!.apis[0]!.contract.responses);
    expect(result.collections[0]!.apis[0]!.contract.request).toEqual(f.localProject.collections[0]!.apis[0]!.contract.request);
    expect(result.collections[0]!.apis[0]!.cases).toEqual(f.localProject.collections[0]!.apis[0]!.cases);
    expect(result.collections[0]!.preOperations).toEqual(f.localProject.collections[0]!.preOperations);
    expect(result.mock).toEqual(f.localProject.mock);expect(compileProjectMock(createProjectSnapshot(result)).ok).toBe(true);
    expect(result.components.find(c=>c.kind === "auth")).toEqual(f.localProject.components.find(c=>c.kind === "auth"));
    expect(plan.mapping.entries.filter(e=>["api","model","component","parameter","response","example"].includes(e.entityKind)).every(e=>e.correspondence === "manual")).toBe(true);
  });
  it.each(["wrong-parent","declared-parent","duplicate-target","wrong-component-kind","child-other-source","parent-kept","unsupported-kind"])("refuses %s correspondence before producing writes", async kind => {
    const f = await mappedInput();
    // Assert the actual source and target graph before each rejected decision.
    expect(compileProjectMock(createProjectSnapshot(f.localProject)).ok).toBe(true);
    const parameter = f.candidate.changes.find(c=>c.entityKind === "parameter");
    expect(parameter,"a real parameter addition decision is required").toBeDefined();
    if (kind === "wrong-parent") {
      const extra = structuredClone(f.localProject.collections[0]!.apis[0]!);extra.contract.id = "00000000-0000-4000-8000-000000000771";extra.contract.request.pathParams[0]!.id = "00000000-0000-4000-8000-000000000772";extra.contract.request.path = "/other/{id}";extra.cases = [];
      [...extra.contract.request.query,...extra.contract.request.headers,...extra.contract.request.cookies,...extra.contract.responses].forEach(binding=>binding.id = randomUUID());
      f.localProject.collections[0]!.apis.push(extra);f.input.localFiles = projectFiles(f.localProject);f.input.stamp.definitionRevision = createProjectSnapshot(f.localProject).definitionRevision;
      f.candidate = await buildSyncCandidate(f.input);f.decisions.candidateDigest = f.candidate.candidateDigest;
      f.decisions.entries = f.candidate.changes.map(c=>({changeId:c.changeId,decision:"map-existing",existingEntityId:c.entityId === parameter!.entityId ? extra.contract.request.pathParams[0]!.id : f.targetFor(c.entityId)!}));
    }
    if (kind === "duplicate-target") {
      const parameters = f.candidate.changes.filter(c=>c.entityKind === "parameter");expect(parameters).toHaveLength(2);
      const target = f.targetFor(parameters[0]!.entityId)!;f.decisions.entries = f.decisions.entries.map(d=>parameters.some(c=>c.changeId === d.changeId) ? {...d,decision:"map-existing",existingEntityId:target} : d);
    }
    if (kind === "declared-parent") {f.input.mapping.entries.find(e=>e.entityId === parameter!.entityId)!.ownerExternalKey = "/wrong-parent";f.candidate = await buildSyncCandidate(f.input);f.decisions.candidateDigest = f.candidate.candidateDigest;}
    if (kind === "wrong-component-kind") {const c = f.candidate.changes.find(c=>c.entityKind === "component")!;const source = f.remoteProject.components.find(v=>v.id === c.entityId)!;const wrong = f.localProject.components.find(v=>v.kind !== source.kind)!;f.decisions.entries = f.decisions.entries.map(d=>d.changeId === c.changeId ? {...d,decision:"map-existing",existingEntityId:wrong.id} : d);}
    if (kind === "child-other-source") {const e = f.input.mapping.entries.find(e=>e.entityId === parameter!.entityId)!;f.input.otherSourceMappings = [{...f.input.mapping,sourceId:"00000000-0000-4000-8000-000000000773",entries:[{...e,entityId:f.targetFor(e.entityId)!}]}];f.candidate = await buildSyncCandidate(f.input);f.decisions.candidateDigest = f.candidate.candidateDigest;}
    if (kind === "parent-kept") {const api = f.candidate.changes.find(c=>c.entityKind === "api")!;f.decisions.entries = f.decisions.entries.map(d=>d.changeId === api.changeId ? {changeId:d.changeId,decision:"keep-current"} : d);}
    if (kind === "unsupported-kind") {const change = f.candidate.changes.find(c=>c.entityKind === "api")!;f.candidate.changes.find(c=>c.changeId === change.changeId)!.entityKind = "schema-property";}
    await expect(resolveSyncCandidate({candidate:f.candidate,decisions:f.decisions,planInput:f.input})).rejects.toThrow(kind === "wrong-parent" || kind === "declared-parent" ? "SYNC_MAPPING_PARENT_MISMATCH" : kind === "duplicate-target" ? "SYNC_MAPPING_TARGET_DUPLICATE" : kind === "parent-kept" ? "SYNC_MAPPING_PARENT_NOT_SELECTED" : kind === "wrong-component-kind" ? "SYNC_MAPPING_KIND_MISMATCH" : kind === "child-other-source" ? "SYNC_MAPPING_TARGET_UNAVAILABLE" : /^SYNC_/);
  });
  it("leaves arbitrary business strings intact when rewriting a real model reference", async () => {
    const f = await mappingFixture(); const component = f.remoteProject.components.find(c=>c.kind === "response")!;
    if(component.kind !== "response") throw new Error("Expected response");
    const example = component.definition.content["application/json"]!.examples[0]!;
    if(example.kind !== "inline") throw new Error("Expected example");
    example.value = {literal:f.remoteProject.models[0]!.id}; f.input.remoteFiles = projectFiles(f.remoteProject);
    const candidate = await buildSyncCandidate(f.input);const decisions:SyncDecisions = {formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>({changeId:c.changeId,decision:"map-existing",existingEntityId:f.targetFor(c.entityId)!}))};
    const plan = await resolveSyncCandidate({candidate,decisions,planInput:f.input});const result = await applyResolved(f.input,plan);
    const response = result.components.find(c=>c.kind === "response")!;if(response.kind !== "response") throw new Error("Expected response");
    expect(response.definition.content["application/json"]!.schema).toEqual({kind:"modelRef",modelId:f.localProject.models[0]!.id});
    expect(response.definition.content["application/json"]!.examples[0]).toMatchObject({value:{literal:f.remoteProject.models[0]!.id}});
  });
  it("confirms a route rename against the same source's previous API and child IDs with safe aliases", async () => {
    const f = await threeWayFixture();const initial = syncFixture();const document = JSON.parse(initial.rawText);
    document.paths["/animals/{id}"] = document.paths["/pets/{id}"];delete document.paths["/pets/{id}"];document.paths["/animals/{id}"].get.operationId = "renamedPet";
    const normalized = normalizeSyncSource({...initial.normalizeInput,mapping:f.mapping,rawText:JSON.stringify(document)});
    const remote = await readProject(normalized.files);const input = {...f.planInput(),mapping:normalized.mapping,remoteFiles:normalized.files,normalizationDiagnostics:normalized.diagnostics};
    const candidate = await buildSyncCandidate(input);const sourceApi = remote.collections[0]!.apis[0]!,targetApi = f.localProject.collections[0]!.apis[0]!;
    const targets = new Map([[sourceApi.contract.id,targetApi.contract.id],[sourceApi.contract.request.pathParams[0]!.id,targetApi.contract.request.pathParams[0]!.id],[sourceApi.contract.responses[0]!.id,targetApi.contract.responses[0]!.id]]);
    const decisions:SyncDecisions = {formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>c.operation === "add" && targets.has(c.entityId) ? {changeId:c.changeId,decision:"map-existing",existingEntityId:targets.get(c.entityId)!} : {changeId:c.changeId,decision:"keep-current"})};
    const plan = await resolveSyncCandidate({candidate,decisions,planInput:input});const project = await applyResolved(input,plan);
    expect(project.collections[0]!.apis).toHaveLength(1);expect(project.collections[0]!.apis[0]!.contract.id).toBe(targetApi.contract.id);expect(project.collections[0]!.apis[0]!.contract.request.path).toBe("/animals/{id}");
    expect(project.collections[0]!.apis[0]!.contract.responses[0]!.id).toBe(targetApi.contract.responses[0]!.id);expect(project.collections[0]!.apis[0]!.cases).toEqual(targetApi.cases);
    const oldEntry = f.mapping.entries.find(e=>e.entityId === targetApi.contract.id)!;const entry = plan.mapping.entries.find(e=>e.entityId === targetApi.contract.id)!;
    expect(entry.externalKey).toBe(normalized.mapping.entries.find(e=>e.entityId === sourceApi.contract.id)!.externalKey);expect(entry.aliases).toContain(oldEntry.externalKey);
    expect(new Set(plan.mapping.entries.map(e=>e.entityId)).size).toBe(plan.mapping.entries.length);
  });
  it("refuses mapping onto an entity still active under another key in the same source", async () => {
    const f = await threeWayFixture();const initial = syncFixture();const document = JSON.parse(initial.rawText);
    document.paths["/second/{id}"] = structuredClone(document.paths["/pets/{id}"]);document.paths["/second/{id}"].get.operationId = "secondPet";
    const normalized = normalizeSyncSource({...initial.normalizeInput,mapping:f.mapping,rawText:JSON.stringify(document)});
    const input = {...f.planInput(),mapping:normalized.mapping,remoteFiles:normalized.files,normalizationDiagnostics:normalized.diagnostics};const candidate = await buildSyncCandidate(input);
    const addedApi = candidate.changes.find(c=>c.entityKind === "api" && c.operation === "add")!;expect(addedApi).toBeDefined();
    const decisions = decide(candidate,"take-source");decisions.entries = decisions.entries.map(d=>d.changeId === addedApi.changeId ? {changeId:d.changeId,decision:"map-existing",existingEntityId:f.localProject.collections[0]!.apis[0]!.contract.id} : d);
    await expect(resolveSyncCandidate({candidate,decisions,planInput:input})).rejects.toThrow("SYNC_MAPPING_TARGET_ACTIVE");
  });
  it("stores the confirmed remapped source baseline so an identical source replay has no new changes", async () => {
    const f = await mappedInput();const plan = await resolveSyncCandidate({candidate:f.candidate,decisions:f.decisions,planInput:f.input});
    const normalized = normalizeSyncSource({...f.normalizeInput,mapping:plan.mapping});
    expect(plan.baselineFiles).toEqual(normalized.files);
    const project = await applyResolved(f.input,plan);const replay:SyncPlanInput = {...f.input,mapping:normalized.mapping,baselineFiles:plan.baselineFiles,remoteFiles:normalized.files,normalizationDiagnostics:normalized.diagnostics,localFiles:projectFiles(project),stamp:{...f.input.stamp,definitionRevision:createProjectSnapshot(project).definitionRevision}};
    expect((await buildSyncCandidate(replay)).changes).toEqual([]);
  });
  it("rejects ambiguous existing child IDs rather than dropping a local parameter", async () => {
    const f = await mappedInput();const api = f.localProject.collections[0]!.apis[0]!;
    api.contract.request.pathParams.push({...api.contract.request.pathParams[0]!,kind:"inline",name:"second",schema:{kind:"scalar",type:"string"},required:true,enabled:true,description:""});
    expect(createProjectSnapshot(f.localProject).context.diagnostics).toEqual([]);
    f.input.localFiles = projectFiles(f.localProject);f.input.stamp.definitionRevision = createProjectSnapshot(f.localProject).definitionRevision;
    const candidate = await buildSyncCandidate(f.input);const decisions:SyncDecisions = {formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>({changeId:c.changeId,decision:"map-existing",existingEntityId:f.targetFor(c.entityId)!}))};
    await expect(resolveSyncCandidate({candidate,decisions,planInput:f.input})).rejects.toThrow("SYNC_MAPPING_TARGET_AMBIGUOUS");
  });
  it("preserves a current auth component credential definition across source scheme changes", async () => {
    const f = await mappingFixture();const baseline = structuredClone(f.remoteProject),local = structuredClone(baseline),remote = structuredClone(baseline);
    local.id = f.input.stamp.projectId;const localAuth = local.components.find(c=>c.kind === "auth")!,remoteAuth = remote.components.find(c=>c.kind === "auth")!;
    if(localAuth.kind !== "auth" || remoteAuth.kind !== "auth") throw new Error("Expected auth components");
    localAuth.definition = {kind:"bearer",token:{id:"preserved-local-credential",policy:"local"}};
    remoteAuth.definition = {kind:"basic",username:"source",password:{id:"source-placeholder",policy:"test-auto"}};
    const input:SyncPlanInput = {...f.input,baselineFiles:projectFiles(baseline),localFiles:projectFiles(local),remoteFiles:projectFiles(remote),stamp:{...f.input.stamp,definitionRevision:createProjectSnapshot(local).definitionRevision}};
    const plan = await resolveAll(input);const result = await applyResolved(input,plan);expect(result.components.find(c=>c.id === localAuth.id)).toEqual(localAuth);
  });
});
