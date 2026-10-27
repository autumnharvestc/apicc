import { z } from "zod";
import { EntityIdSchema, HashSchema, ProjectRelativePathSchema } from "./task.js";

export const AssetVersionSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(value => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9223372036854775807n, "version exceeds BIGINT");
export const AssetFileSchema = z.object({ path: ProjectRelativePathSchema, content: z.string(), version: EntityIdSchema, hash: HashSchema, size: z.number().int().nonnegative().safe() }).strict();
export const ProjectAssetsSchema = z.object({
  workspaceId: EntityIdSchema, groupId: EntityIdSchema, projectId: EntityIdSchema,
  format: z.literal("contract-files-v1").nullable(), contractProjectId: z.string().uuid().nullable(),
  version: AssetVersionSchema, manifestHash: HashSchema, files: z.array(AssetFileSchema),
}).strict();
export const AssetDeltaSchema = z.object({ format: z.literal("contract-files-v1"), contractProjectId: z.string().uuid(), expectedVersion: AssetVersionSchema,
  changes: z.array(z.object({ path: ProjectRelativePathSchema, content: z.string() }).strict()), deletes: z.array(ProjectRelativePathSchema),
}).strict();
export const ExecutionSnapshotSchema = z.object({ snapshotId: EntityIdSchema, createdByUserId: EntityIdSchema, assets: ProjectAssetsSchema }).strict();
export const SnapshotRequestSchema = z.object({ expectedVersion: AssetVersionSchema }).strict();
export type ProjectAssets = z.infer<typeof ProjectAssetsSchema>;
export type AssetDelta = z.infer<typeof AssetDeltaSchema>;
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;
export type SnapshotRequest = z.infer<typeof SnapshotRequestSchema>;
