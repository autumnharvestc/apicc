import { createProjectSnapshot } from "../assets/snapshot.js";
import { mappedDefinitions, mappingDiagnostics, transitionReferences } from "./compare.js";
import { assertBytes, canonical, contentReference, digestProject, fileWrites, hash, readSyncProject, sortedFiles } from "./files.js";
import { SyncRollbackInputSchema, SyncResolvedPlanSchema, type SyncRollbackInput, type SyncResolvedPlan } from "./types.js";

/** Undo committed project-asset changes as a new local overlay on the current
 * confirmed source baseline. Storage authentication and new revisions belong to
 * the committing coordinator; no history version, baseline or map is rewound. */
export async function buildSyncRollback(value: SyncRollbackInput): Promise<SyncResolvedPlan> {
  const input = SyncRollbackInputSchema.parse(value);
  for (const key of ["currentFiles","beforeFiles","afterFiles","baselineFiles"] as const) input[key] = sortedFiles(input[key]);
  assertBytes(input,input.budget.maxCompareInputBytes,"SYNC_COMPARE_INPUT_BYTES_EXCEEDED");
  const {history,currentStamp} = input;
  if (canonical(contentReference(input.beforeFiles)) !== canonical(history.rollback.beforeContent)
    || canonical(contentReference(input.afterFiles)) !== canonical(history.rollback.afterContent)) throw new Error("SYNC_ROLLBACK_CONTENT_MISMATCH");
  if (history.projectId !== currentStamp.projectId || history.projectId !== history.beforeStamp.projectId || history.projectId !== history.afterStamp.projectId
    || history.sourceId !== input.mapping.sourceId || input.mapping.revision !== currentStamp.mappingRevision) throw new Error("SYNC_ROLLBACK_STAMP_MISMATCH");
  if (mappingDiagnostics(input.mapping,input.otherSourceMappings).length) throw new Error("SYNC_CROSS_SOURCE_OWNERSHIP");
  const before = await readSyncProject(input.beforeFiles), after = await readSyncProject(input.afterFiles), current = await readSyncProject(input.currentFiles);
  // Current baseline is also typed, bounded real contract content, never a
  // caller-supplied object silently treated as a validated source snapshot.
  await readSyncProject(input.baselineFiles);
  if (before.id !== history.projectId || after.id !== history.projectId || current.id !== history.projectId) throw new Error("SYNC_ROLLBACK_STAMP_MISMATCH");
  const beforeDigest = digestProject(before,input.beforeFiles), afterDigest = digestProject(after,input.afterFiles), currentDigest = digestProject(current,input.currentFiles);
  if (canonical(beforeDigest) !== canonical(history.before) || canonical(afterDigest) !== canonical(history.after)
    || history.beforeStamp.definitionRevision !== beforeDigest.definitionRevision || history.afterStamp.definitionRevision !== afterDigest.definitionRevision) throw new Error("SYNC_ROLLBACK_HISTORY_MISMATCH");
  if (canonical(currentDigest) !== canonical(afterDigest) || currentStamp.definitionRevision !== currentDigest.definitionRevision) throw new Error("SYNC_ROLLBACK_CURRENT_CHANGED");
  for (const other of input.otherSourceMappings) for (const entry of other.entries.filter(e=>e.ownership === "source")) {
    if (canonical(mappedDefinitions(current,entry.entityId)) !== canonical(mappedDefinitions(before,entry.entityId))) throw new Error("SYNC_CROSS_SOURCE_OWNERSHIP");
  }
  if (transitionReferences(current,before,[],history.integritySha256).length || createProjectSnapshot(before).context.diagnostics.length) throw new Error("SYNC_PROTECTED_REFERENCE");
  const plan = SyncResolvedPlanSchema.parse({formatVersion:1,candidateDigest:hash(["apicc-sync-rollback-v1",input]),decisionsDigest:hash(["apicc-sync-rollback-decision-v1",history.id,history.integritySha256]),stamp:currentStamp,
    ...fileWrites(input.currentFiles,input.beforeFiles),baselineFiles:input.baselineFiles,mapping:input.mapping,before:currentDigest,after:beforeDigest});
  assertBytes(plan,input.budget.maxCompareOutputBytes,"SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED");
  return plan;
}
