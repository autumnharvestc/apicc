import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { ApiTestCaseSchema } from "../../src/contract/model.js";
import { ContractProjectSchema } from "../../src/contract/workspace.js";
import { parseContractOpenapi } from "../../src/import/contractOpenapi.js";
import { encodeContractProjectFiles } from "../../src/storage/contractFiles.js";
import { SyncIdentityMapSchema, SyncNormalizeInputSchema, SyncPlanInputSchema, SyncPolicySchema, SyncSourceSchema, SyncStampSchema } from "../../src/sync/shared.js";

export const MiB = 1024 * 1024;
export const sourceId = "00000000-0000-4000-8000-000000000701";
export const moduleId = "00000000-0000-4000-8000-000000000702";
export const projectId = "00000000-0000-4000-8000-000000000703";
export const hashA = "a".repeat(64);
export const deploymentLimits = { maxWireBytes: 80 * MiB, envelopeReserveBytes: 128 * 1024 };

const base = () => ({
  formatVersion: 1 as const, id: sourceId, revision: "1", moduleId,
  schedule: { enabled: false, rule: { kind: "cron", expression: "0 0 * * * *", timeZone: "UTC", dstOverlap: "first" } },
});
export function urlSource() {
  return SyncSourceSchema.parse({ ...base(), kind: "url", url: "https://spec.example.test/openapi.json", authRef: "http-auth-1" });
}
export function gitHttpsSource() {
  return SyncSourceSchema.parse({ ...base(), kind: "git-https", repositoryUrl: "https://git.example.test/team/pets.git", ref: "refs/heads/main", filePath: "spec/openapi.json", authRef: "git-auth-1" });
}
export function gitSshSource() {
  return SyncSourceSchema.parse({ ...base(), kind: "git-ssh", repositoryUrl: "ssh://git@git.example.test/team/pets.git", ref: "refs/heads/main", filePath: "spec/openapi.json", privateKeyRef: "ssh-key-1", knownHostsRef: "known-hosts-1" });
}

/** One shared, literal syntax oracle for Core and its generated JSON boundary. */
export const sourceAddressCases = [
  { authority: "example.test", accepted: true }, { authority: "localhost", accepted: true },
  { authority: "123.example.test", accepted: true }, { authority: "a-b.example.test", accepted: true },
  { authority: "example.test:0", accepted: true }, { authority: "example.test:1", accepted: true },
  { authority: "example.test:65535", accepted: true }, { authority: "example.test:00080", accepted: true },
  { authority: "0.0.0.0", accepted: true }, { authority: "127.0.0.1", accepted: true },
  { authority: "255.255.255.255:65535", accepted: true },
  { authority: "[::]", accepted: true }, { authority: "[::1]", accepted: true },
  { authority: "[2001:db8::1]:65535", accepted: true }, { authority: "[2001:db8:0:1:2:3:4:5]", accepted: true },
  { authority: "[1:2:3:4:5:6:7::]", accepted: true }, { authority: "[::ffff:192.0.2.128]", accepted: true },
  { authority: "[::1:2:3:4:5:6:7]", accepted: true }, { authority: "[1:2:3::4:5:6:7]", accepted: true },
  { authority: "[1:2:3:4:5::192.0.2.1]", accepted: true },
  { authority: "[1:2:3:4:5:6:192.0.2.1]", accepted: true }, { authority: "[2001:db8::192.0.2.1]", accepted: true },
  { authority: "example.test:65536", accepted: false }, { authority: "example.test:99999", accepted: false },
  { authority: "example.test:100000", accepted: false }, { authority: "example.test:-1", accepted: false },
  { authority: "example.test:1.5", accepted: false }, { authority: "example.test:", accepted: false },
  { authority: "[.]", accepted: false }, { authority: "[1:2:3:4:5:6:7]", accepted: false },
  { authority: "[1:2:3:4:5:6:7:8:9]", accepted: false }, { authority: "[1::2::3]", accepted: false },
  { authority: "[:::]", accepted: false }, { authority: "[12345::]", accepted: false },
  { authority: "[gggg::]", accepted: false }, { authority: "[::ffff:256.0.0.1]", accepted: false },
  { authority: "[1:2:3:4:5:6:7::8]", accepted: false }, { authority: "[1:2:3:4:5:192.0.2.1]", accepted: false },
  { authority: "[::ffff:192.0.2.01]", accepted: false }, { authority: "[1:2:3:4:5:6::192.0.2.1]", accepted: false },
  { authority: "256.0.0.1", accepted: false }, { authority: "1.2.3.999", accepted: false },
  { authority: "01.2.3.4", accepted: false }, { authority: "127.1", accepted: false },
  { authority: "2130706433", accepted: false }, { authority: "0x7f.0.0.1", accepted: false },
  { authority: "example..test", accepted: false }, { authority: "-bad.example", accepted: false },
  { authority: "bad-.example", accepted: false }, { authority: "example.123", accepted: false },
  { authority: "example.0x1", accepted: false }, { authority: "example.0x", accepted: false },
] as const;

export function sourceAddressInput(kind: "url" | "git-https" | "git-ssh", authority: string) {
  if (kind === "url") return { ...urlSource(), url: `https://${authority}/openapi.json` };
  if (kind === "git-https") return { ...gitHttpsSource(), repositoryUrl: `https://${authority}/team/pets.git` };
  return { ...gitSshSource(), repositoryUrl: `ssh://git@${authority}/team/pets.git` };
}
export function defaultSyncPolicy() {
  return SyncPolicySchema.parse({
    formatVersion: 1, revision: "0", scope: "project", connectTimeoutMs: 10000, urlDeadlineMs: 60000, gitDeadlineMs: 120000,
    maxAttempts: 1, maxSourceBytes: 5 * MiB, maxCompareInputBytes: 16 * MiB, maxCompareOutputBytes: 8 * MiB,
    maxNormalizeDepth: 128, maxNormalizeNodes: 100000,
    gitDiskThresholdBytes: 256 * MiB, projectConcurrency: 1, hostConcurrency: 4,
    candidateTtlMs: 86400000, historyRetentionDays: 30, historyMaxEntries: 100,
  });
}

export function syncFixture() {
  const document = {
    openapi: "3.1.0", info: { title: "Pet API", version: "1.0.0" },
    servers: [{ url: "https://api.example.test" }],
    paths: { "/pets/{id}": { get: { operationId: "getPet", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Pet found", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } } } } },
    components: { schemas: { Pet: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] } } },
  };
  const imported = parseContractOpenapi(document);
  const localProject = imported.project;
  localProject.id = projectId;
  const collection = localProject.collections[0]!;
  collection.id = moduleId;
  const api = collection.apis[0]!;
  api.cases.push(ApiTestCaseSchema.parse({
    id: "00000000-0000-4000-8000-000000000704", name: "returns a Pet", parameters: { id: "pet-7" },
    assertions: [{ id: "pet-status", target: "status", op: "eq", expected: "200" }],
  }));
  ContractProjectSchema.parse(localProject);
  const stamp = SyncStampSchema.parse({ formatVersion: 1, kind: "local", projectId,
    definitionRevision: createProjectSnapshot(localProject).definitionRevision,
    sourceRevision: "1", mappingRevision: "0", baselineRevision: "0", authorizationGeneration: "1", coreBuildId: hashA });
  const source = urlSource();
  const rawText = JSON.stringify(document);
  const upstream = { kind: "url" as const, finalUrl: "https://spec.example.test/openapi.json", rawSha256: createHash("sha256").update(rawText).digest("hex") };
  const mapping = SyncIdentityMapSchema.parse({ formatVersion: 1, sourceId, namespace: sourceId, revision: "0", algorithm: "apicc-sync-id-v1", entries: [] });
  const files = () => [...encodeContractProjectFiles(localProject).files].map(([path, content]) => ({ path, content }));
  const baselineFiles = files();
  return {
    source, stamp, localProject, rawText, upstream,
    normalizeInput: SyncNormalizeInputSchema.parse({ rawText, source, mapping, allocationSeed: "apicc-sync-id-v1", budget: { maxSourceBytes: 5 * MiB, maxCompareInputBytes: 16 * MiB, maxNormalizeDepth: 128, maxNormalizeNodes: 100000 } }),
    planInput: () => SyncPlanInputSchema.parse({ source, stamp: { ...stamp, definitionRevision: createProjectSnapshot(localProject).definitionRevision }, upstream, mapping, baselineFiles, localFiles: files(), remoteFiles: baselineFiles, normalizationDiagnostics: [], otherSourceMappings: [], budget: { maxCompareInputBytes: 16 * MiB, maxCompareOutputBytes: 8 * MiB } }),
  };
}
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { cloneProjectDefinition } from "../../src/assets/clone.js";

import { decodeContractProjectFiles } from "../../src/storage/contractFiles.js";
import { normalizeSyncSource } from "../../src/sync/normalize.js";
import type { ContractProject } from "../../src/contract/workspace.js";

export function projectFiles(project: ContractProject) {
  return [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content })).sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function readProject(files: { path: string; content: string }[]) {
  const decoded = await decodeContractProjectFiles(new Map(files.map(f=>[f.path,f.content])));
  if (!decoded.project || decoded.problems.length) throw new Error(`Invalid fixture: ${JSON.stringify(decoded.problems)}`);
  return decoded.project;
}
/** Real source-only B/R containers and a separately identified complete target L. */
export async function threeWayFixture() {
  const legacy = syncFixture();
  const normalized = normalizeSyncSource(legacy.normalizeInput);
  if (normalized.diagnostics.some(d=>d.severity === "error")) throw new Error("Normalization fixture failed");
  const baseProject = await readProject(normalized.files);
  const remoteProject = structuredClone(baseProject);
  const localProject = structuredClone(baseProject);
  localProject.id = projectId;
  localProject.name = "Actual local target";
  localProject.variables = { local: "keep" };
  const api = localProject.collections[0]!.apis[0]!;
  api.cases = structuredClone(legacy.localProject.collections[0]!.apis[0]!.cases);
  const mapping = normalized.mapping;
  const planInput = (): SyncPlanInput => ({ source: legacy.source, stamp: { ...legacy.stamp, mappingRevision: mapping.revision,
    definitionRevision: createProjectSnapshot(localProject).definitionRevision }, upstream: legacy.upstream, mapping,
    baselineFiles: projectFiles(baseProject), localFiles: projectFiles(localProject), remoteFiles: projectFiles(remoteProject),
    normalizationDiagnostics: normalized.diagnostics, otherSourceMappings: [],
    budget: { maxCompareInputBytes: 16 * MiB, maxCompareOutputBytes: 8 * MiB } });
  return { baseProject, localProject, remoteProject, mapping, source: legacy.source, planInput };
}

import { buildSyncCandidate } from "../../src/sync/compare.js";
import type { SyncDecisions, SyncPlanInput, SyncResolvedPlan } from "../../src/sync/types.js";
export async function candidateFixture() {
  const f = await threeWayFixture();
  f.localProject.collections[0]!.apis[0]!.contract.metadata.description = "local";
  f.remoteProject.collections[0]!.apis[0]!.contract.metadata.description = "source";
  const planInput = f.planInput();
  const candidate = await buildSyncCandidate(planInput);
  if (!candidate.conflicts.some(c=>c.reasonCode === "both-modified")) throw new Error("candidateFixture requires a real unresolved conflict");
  const keepCurrentDecisions: SyncDecisions = {formatVersion:1,candidateDigest:candidate.candidateDigest,entries:candidate.changes.map(c=>({changeId:c.changeId,decision:"keep-current"}))};
  return {...f,planInput,candidate,keepCurrentDecisions,resolveInput:{candidate,planInput,decisions:keepCurrentDecisions}};
}
export async function applyResolved(input: SyncPlanInput,plan: SyncResolvedPlan) {
  const files = new Map(input.localFiles.map(f=>[f.path,f.content]));
  plan.deletions.forEach(p=>files.delete(p)); plan.writes.forEach(f=>files.set(f.path,f.content));
  return readProject([...files].map(([path,content])=>({path,content})));
}

export async function mappingFixture() {
  const initial = syncFixture(); const document = JSON.parse(initial.rawText);
  document.components.parameters = {Filter:{name:"filter",in:"query",schema:{type:"string"}}};
  document.components.securitySchemes = {LocalAuth:{type:"http",scheme:"bearer"}};
  document.components.responses = {PetResponse:{description:"Pet response",content:{"application/json":{schema:{$ref:"#/components/schemas/Pet"},examples:{pet:{value:{literal:"source-business-value"}}}}}}};
  document.paths["/pets/{id}"].get.parameters.push({$ref:"#/components/parameters/Filter"});
  document.paths["/pets/{id}"].get.responses = {"200":{$ref:"#/components/responses/PetResponse"}};
  const normalized = normalizeSyncSource({...initial.normalizeInput,rawText:JSON.stringify(document)});
  const remoteProject = await readProject(normalized.files);
  const cloned = cloneProjectDefinition(remoteProject,{newId:()=>randomUUID()});
  const localProject = cloned.project; localProject.id = projectId;localProject.collections[0]!.id = moduleId;localProject.name = "Mapped local target";
  const localApi = localProject.collections[0]!.apis[0]!;
  localApi.cases = structuredClone(initial.localProject.collections[0]!.apis[0]!.cases);
  localApi.contract.request.auth = {kind:"bearer",token:{id:"local-material-ref",policy:"local"}};
  const localAuth = localProject.components.find(c=>c.kind === "auth")!;if(localAuth.kind === "auth") localAuth.definition = {kind:"bearer",token:{id:"local-component-credential",policy:"local"}};
  localProject.collections[0]!.preOperations = [{id:"local-hook",type:"script",content:"console.log('retain')"}];
  const response = localProject.components.find(c=>c.kind === "response")!;
  if (response.kind !== "response") throw new Error("Expected response fixture");
  const localExample = response.definition.content["application/json"]!.examples[0]!;
  localProject.mock = {formatVersion:1,seed:"mapped",enabledContractIds:[localApi.contract.id],rules:[{id:randomUUID(),enabled:true,contractId:localApi.contract.id,conditions:[],responseBindingId:localApi.contract.responses[0]!.id,status:200,mediaType:"application/json",source:{kind:"example",exampleBindingId:localExample.id},delayMs:0}]};
  const baseProject = structuredClone(remoteProject);baseProject.collections[0]!.apis = [];baseProject.models = [];baseProject.components = [];
  const targetFor = (sourceId:string)=>cloned.idMap.find(e=>e.sourceId === sourceId)?.targetId;
  const input: SyncPlanInput = {source:initial.source,stamp:{...initial.stamp,definitionRevision:createProjectSnapshot(localProject).definitionRevision,mappingRevision:normalized.mapping.revision},upstream:{...initial.upstream,rawSha256:createHash("sha256").update(JSON.stringify(document)).digest("hex")},mapping:normalized.mapping,
    baselineFiles:projectFiles(baseProject),localFiles:projectFiles(localProject),remoteFiles:projectFiles(remoteProject),normalizationDiagnostics:normalized.diagnostics,otherSourceMappings:[],budget:{maxCompareInputBytes:16*MiB,maxCompareOutputBytes:8*MiB}};
  return {input,localProject,remoteProject,targetFor,normalizeInput:{...initial.normalizeInput,rawText:JSON.stringify(document),mapping:normalized.mapping}};
}

/** Review reproductions use independently normalized B/R and the exact R raw
 * digest; L is a complete decoded target with a separately bound project ID. */
export async function normalizedReviewFixture(baseDocument: unknown, remoteDocument: unknown, localFromRemote = false) {
  const initial = syncFixture();
  const baseline = normalizeSyncSource({...initial.normalizeInput,rawText:JSON.stringify(baseDocument)});
  const remoteText = JSON.stringify(remoteDocument);
  const remote = normalizeSyncSource({...initial.normalizeInput,mapping:baseline.mapping,rawText:remoteText});
  if([...baseline.diagnostics,...remote.diagnostics].some(d=>d.severity === "error")) throw new Error("Review fixture normalization must be valid");
  const localProject = await readProject(localFromRemote ? remote.files : baseline.files);localProject.id = projectId;localProject.name = "Review target";
  const input = ():SyncPlanInput=>({...initial.planInput(),mapping:remote.mapping,baselineFiles:baseline.files,remoteFiles:remote.files,localFiles:projectFiles(localProject),normalizationDiagnostics:remote.diagnostics,
    stamp:{...initial.stamp,definitionRevision:createProjectSnapshot(localProject).definitionRevision,mappingRevision:remote.mapping.revision},upstream:{kind:"url",finalUrl:initial.upstream.finalUrl,rawSha256:createHash("sha256").update(remoteText).digest("hex")}});
  return {baseline,remote,localProject,input};
}
