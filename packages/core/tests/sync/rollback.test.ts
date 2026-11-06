import { describe, expect, it } from "vitest";
import { buildSyncRollback } from "../../src/sync/rollback.js";
import { resolveSyncCandidate } from "../../src/sync/resolve.js";
import { SyncRollbackInputSchema, type SyncHistoryEntry, type SyncRollbackInput } from "../../src/sync/types.js";
import { contentReference, digestProject } from "../../src/sync/files.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { applyResolved, candidateFixture, projectFiles } from "./fixtures.js";

async function rollbackFixture() {
  const f = await candidateFixture();
  const applied = await resolveSyncCandidate({...f.resolveInput,decisions:{...f.keepCurrentDecisions,entries:f.keepCurrentDecisions.entries.map(d=>({...d,decision:"take-source" as const}))}});
  const after = await applyResolved(f.planInput,applied);
  const beforeFiles = f.planInput.localFiles, afterFiles = projectFiles(after);
  const currentStamp = {...f.planInput.stamp,definitionRevision:createProjectSnapshot(after).definitionRevision,baselineRevision:"1"};
  const history: SyncHistoryEntry = {formatVersion:1,id:"00000000-0000-4000-8000-000000000761",sourceId:f.source.id,projectId:f.localProject.id,intentId:"00000000-0000-4000-8000-000000000762",operationKind:"apply",actor:{id:"fixture-editor",name:"Fixture editor"},createdAtMs:1000,beforeStamp:f.planInput.stamp,afterStamp:currentStamp,upstream:f.planInput.upstream,before:digestProject(f.localProject,beforeFiles),after:digestProject(after,afterFiles),rollback:{beforeContent:contentReference(beforeFiles),afterContent:contentReference(afterFiles)},integritySha256:"a".repeat(64)};
  const input: SyncRollbackInput = {history,currentFiles:afterFiles,currentStamp,beforeFiles,afterFiles,mapping:f.mapping,baselineFiles:applied.baselineFiles,otherSourceMappings:[],budget:f.planInput.budget};
  return {f,after,input};
}

describe("content-bound conditional rollback", () => {
  it("has an actual committed source change and correctly dereferenced content", async () => {
    const {f,after,input} = await rollbackFixture();
    expect(after.collections[0]!.apis[0]!.contract.metadata.description).toBe("source");
    expect(f.localProject.collections[0]!.apis[0]!.contract.metadata.description).toBe("local");
    expect(input.history.after.manifestDigest).not.toBe(input.history.before.manifestDigest);
  });
  it("reverses only changed project assets and retains current source baseline and mapping", async () => {
    const {f,input} = await rollbackFixture(); const original = structuredClone(input);
    const plan = await buildSyncRollback(input);
    expect(plan.writes).toHaveLength(1); expect(plan.writes[0]!.path).toMatch(/\/api.yaml$/); expect(plan.deletions).toEqual([]);
    const restored = await applyResolved({...f.planInput,localFiles:input.currentFiles},plan);
    expect(restored).toEqual(f.localProject); expect(plan.after).toEqual(input.history.before);
    expect(plan.before).toEqual(input.history.after); expect(plan.stamp).toEqual(input.currentStamp);
    expect(plan.baselineFiles).toEqual(input.baselineFiles); expect(plan.mapping).toEqual(input.mapping); expect(input).toEqual(original);
    expect(plan.candidateDigest).not.toBe("0".repeat(64));
  });
  it("requires strict resolved rollback bodies and current baseline, ownership and budgets", async () => {
    const {input} = await rollbackFixture();
    const bare = {history:input.history,currentFiles:input.currentFiles,currentStamp:input.currentStamp};
    expect(SyncRollbackInputSchema.safeParse(bare).success).toBe(false);
    for (const field of ["beforeFiles","afterFiles","mapping","baselineFiles","otherSourceMappings","budget"] as const) {
      const value: Record<string,unknown> = {...input}; delete value[field];
      expect(SyncRollbackInputSchema.safeParse(value).success,field).toBe(false);
    }
  });
  it.each(["before-content","after-content","before-bytes","after-type","before-manifest","after-definition","history-project","history-source","before-stamp-project","after-stamp-definition","current-stamp","mapping-revision","later-edit","duplicate-body","cross-source","input-budget","output-budget"])("refuses %s without producing rollback writes", async kind => {
    const {f,input} = await rollbackFixture();
    if (kind === "before-content") input.beforeFiles[0]!.content += "\n";
    if (kind === "after-content") input.afterFiles[0]!.content += "\n";
    if (kind === "before-bytes") input.history.rollback.beforeContent.bytes++;
    if (kind === "after-type") (input.history.rollback.afterContent as {contentType:string}).contentType = "application/json";
    if (kind === "before-manifest") input.history.before.manifestDigest = "f".repeat(64);
    if (kind === "after-definition") input.history.after.definitionRevision = "f".repeat(64);
    if (kind === "history-project") input.history.projectId = "00000000-0000-4000-8000-000000000763";
    if (kind === "history-source") input.history.sourceId = "00000000-0000-4000-8000-000000000763";
    if (kind === "before-stamp-project") input.history.beforeStamp.projectId = "00000000-0000-4000-8000-000000000763";
    if (kind === "after-stamp-definition") input.history.afterStamp.definitionRevision = "f".repeat(64);
    if (kind === "current-stamp") input.currentStamp.definitionRevision = "f".repeat(64);
    if (kind === "mapping-revision") input.mapping.revision = "2";
    if (kind === "later-edit") { f.localProject.name = "Later local edit"; input.currentFiles = projectFiles(f.localProject); input.currentStamp.definitionRevision = createProjectSnapshot(f.localProject).definitionRevision; }
    if (kind === "duplicate-body") input.beforeFiles.push(input.beforeFiles[0]!);
    if (kind === "cross-source") input.otherSourceMappings.push({...input.mapping,sourceId:"00000000-0000-4000-8000-000000000764"});
    if (kind === "input-budget") { input.baselineFiles[0]!.content += "x".repeat(1024*1024); input.budget.maxCompareInputBytes = 1024*1024; }
    if (kind === "output-budget") { f.localProject.collections[0]!.apis[0]!.documentation = "x".repeat(300*1024); input.beforeFiles = projectFiles(f.localProject); input.history.before = digestProject(f.localProject,input.beforeFiles); input.history.beforeStamp = {...input.history.beforeStamp,definitionRevision:input.history.before.definitionRevision}; input.history.rollback.beforeContent = contentReference(input.beforeFiles); input.budget.maxCompareOutputBytes = 256*1024; }
    await expect(buildSyncRollback(input)).rejects.toThrow();
  });
  it("rejects restoring a broken true model reference even when the historical content hashes match", async () => {
    const {f,input} = await rollbackFixture(); f.localProject.models = [];
    input.beforeFiles = projectFiles(f.localProject); input.history.before = digestProject(f.localProject,input.beforeFiles);
    input.history.beforeStamp.definitionRevision = input.history.before.definitionRevision; input.history.rollback.beforeContent = contentReference(input.beforeFiles);
    await expect(buildSyncRollback(input)).rejects.toThrow("SYNC_PROTECTED_REFERENCE");
  });
  it("refuses changing an asset now owned by another source even if omitted from the current source map", async () => {
    const {input,f} = await rollbackFixture(); const apiId = f.localProject.collections[0]!.apis[0]!.contract.id;
    const apiEntry = input.mapping.entries.find(e=>e.entityId === apiId)!;
    input.mapping = {...input.mapping,entries:input.mapping.entries.filter(e=>e.entityId !== apiId)};
    input.otherSourceMappings = [{...input.mapping,sourceId:"00000000-0000-4000-8000-000000000765",entries:[apiEntry]}];
    await expect(buildSyncRollback(input)).rejects.toThrow("SYNC_CROSS_SOURCE_OWNERSHIP");
  });
});
