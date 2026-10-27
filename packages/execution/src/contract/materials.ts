import { z } from "zod";
import { EntityIdSchema, HashSchema, ServerProjectScopeSchema, ProjectRelativePathSchema } from "./task.js";
import { AssetVersionSchema } from "./assets.js";

export const MaterialRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
export const CredentialSelectionSchema = z.object({ refId: MaterialRefSchema, version: EntityIdSchema.optional() }).strict();
export const AttachmentSelectionSchema = z.object({ refId: MaterialRefSchema, version: EntityIdSchema, hash: HashSchema }).strict();
export const AttachmentPathsSchema = z.record(ProjectRelativePathSchema, AttachmentSelectionSchema);
export const MaterialSelectionSchema = z.object({ projectId: EntityIdSchema, credentials: z.array(CredentialSelectionSchema), attachments: z.array(AttachmentSelectionSchema), attachmentPaths: AttachmentPathsSchema.optional() }).strict();
export const CredentialMetadataSchema = z.object({ refId: MaterialRefSchema, version: EntityIdSchema, status: z.enum(["available", "missing", "unavailable"]) }).strict();
export const CredentialWriteSchema = z.object({ expectedVersion: AssetVersionSchema, value: z.string() }).strict();
export const AttachmentWriteSchema = z.object({ refId: MaterialRefSchema, expectedVersion: AssetVersionSchema, kind: z.enum(["file", "network-public"]), contentBase64: z.string() }).strict();
export const AttachmentMetadataSchema = z.object({ refId: MaterialRefSchema, version: EntityIdSchema, hash: HashSchema, size: z.number().int().nonnegative().safe(), kind: z.enum(["file", "network-public"]) }).strict();
export const ProjectRunMaterialsSchema = z.object({
  snapshotId: EntityIdSchema, scope: ServerProjectScopeSchema,
  credentials: z.array(z.object({ refId: MaterialRefSchema, version: EntityIdSchema, value: z.string() }).strict()),
  attachments: z.array(AttachmentMetadataSchema.extend({ contentBase64: z.string() }).strict()),
}).strict();
export type MaterialSelection = z.infer<typeof MaterialSelectionSchema>;
export type ProjectRunMaterials = z.infer<typeof ProjectRunMaterialsSchema>;
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;
