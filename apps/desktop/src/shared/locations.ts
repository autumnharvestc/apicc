import { z } from "zod";

const IdSchema = z.string().uuid();

export const WorkspaceLocatorSchema = z.object({ workspaceId: IdSchema }).strict();
export const GroupLocatorSchema = WorkspaceLocatorSchema.extend({ groupId: IdSchema }).strict();
export const ProjectLocatorSchema = GroupLocatorSchema.extend({ projectId: IdSchema }).strict();
export const CollectionLocatorSchema = ProjectLocatorSchema.extend({ collectionId: IdSchema }).strict();
export const FolderLocatorSchema = CollectionLocatorSchema.extend({ folderIds: z.array(IdSchema).min(1) }).strict();
export const ApiLocatorSchema = CollectionLocatorSchema.extend({ folderIds: z.array(IdSchema), apiId: IdSchema }).strict();
export const EnvironmentLocatorSchema = ProjectLocatorSchema.extend({ environmentId: IdSchema }).strict();
export const ModelLocatorSchema = ProjectLocatorSchema.extend({ modelId: IdSchema }).strict();
export const ComponentLocatorSchema = ProjectLocatorSchema.extend({
  componentKind: z.enum(["parameter", "auth", "response", "example"]),
  componentId: IdSchema,
}).strict();
export const WorkflowLocatorSchema = ProjectLocatorSchema.extend({ workflowId: IdSchema }).strict();
export const DatasetLocatorSchema = ProjectLocatorSchema.extend({ datasetId: IdSchema }).strict();
export const SuiteLocatorSchema = ProjectLocatorSchema.extend({ suiteId: IdSchema }).strict();
export const CaseLocatorSchema = ApiLocatorSchema.extend({ caseId: z.string(), scope: z.string() }).strict();
export const WorkflowImpactLocatorSchema = ApiLocatorSchema.extend({ caseId: z.string().optional() }).strict();

export const ApiParentLocatorSchema = z.union([CollectionLocatorSchema, FolderLocatorSchema]);

export const NodeLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), locator: GroupLocatorSchema }).strict(),
  z.object({ kind: z.literal("project"), locator: ProjectLocatorSchema }).strict(),
  z.object({ kind: z.literal("collection"), locator: CollectionLocatorSchema }).strict(),
  z.object({ kind: z.literal("folder"), locator: FolderLocatorSchema }).strict(),
  z.object({ kind: z.literal("api"), locator: ApiLocatorSchema }).strict(),
  z.object({ kind: z.literal("environment"), locator: EnvironmentLocatorSchema }).strict(),
  z.object({ kind: z.literal("model"), locator: ModelLocatorSchema }).strict(),
  z.object({ kind: z.literal("component"), locator: ComponentLocatorSchema }).strict(),
  z.object({ kind: z.literal("workflow"), locator: WorkflowLocatorSchema }).strict(),
]);

export type WorkspaceLocator = z.infer<typeof WorkspaceLocatorSchema>;
export type GroupLocator = z.infer<typeof GroupLocatorSchema>;
export type ProjectLocator = z.infer<typeof ProjectLocatorSchema>;
export type CollectionLocator = z.infer<typeof CollectionLocatorSchema>;
export type FolderLocator = z.infer<typeof FolderLocatorSchema>;
export type ApiLocator = z.infer<typeof ApiLocatorSchema>;
export type EnvironmentLocator = z.infer<typeof EnvironmentLocatorSchema>;
export type ModelLocator = z.infer<typeof ModelLocatorSchema>;
export type ComponentLocator = z.infer<typeof ComponentLocatorSchema>;
export type WorkflowLocator = z.infer<typeof WorkflowLocatorSchema>;
export type DatasetLocator = z.infer<typeof DatasetLocatorSchema>;
export type SuiteLocator = z.infer<typeof SuiteLocatorSchema>;
export type CaseLocator = z.infer<typeof CaseLocatorSchema>;
export type WorkflowImpactLocator = z.infer<typeof WorkflowImpactLocatorSchema>;
export type ApiParentLocator = z.infer<typeof ApiParentLocatorSchema>;
export type NodeLocator = z.infer<typeof NodeLocatorSchema>;
