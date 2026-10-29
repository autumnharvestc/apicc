import { z } from "zod";

import {
  EnvironmentSchema,
  OperationListSchema,
  ProjectGlobalsSchema,
  StressPolicySchema,
  type Environment,
  type Operation,
  type ProjectGlobals,
  type StressPolicy,
} from "../domain/common.js";
import { WorkflowSchema } from "../workflow/model.js";
import { ApiAssetSchema, ComponentAssetSchema, ModelAssetSchema, type ApiAsset, type ComponentAsset, type ModelAsset } from "./model.js";
import { StringRecordSchema } from "./schemaNode.js";
import { MockProjectConfigSchema, type MockProjectConfig } from "../mock/config.js";
import { DatasetAssetSchema, SuiteAssetSchema, type DatasetAsset, type SuiteAsset } from "../testing/model.js";
import { SavedStressPlanSchema, type SavedStressPlan } from "../stress/plan.js";

export const ContractEnvironmentSchema = EnvironmentSchema;

type Workflow = z.output<typeof WorkflowSchema>;

const ContainerIdSchema = z.string().uuid();

export interface ContractWorkspace {
  formatVersion: 1;
  id: string;
  name: string;
  variables: Record<string, string>;
  groups: ContractGroup[];
}

export interface ContractGroup {
  id: string;
  name: string;
  default?: boolean;
  projects: ContractProject[];
}

export interface ContractProject {
  id: string;
  name: string;
  variables: Record<string, string>;
  globals: ProjectGlobals;
  environments: Environment[];
  collections: ContractCollection[];
  workflows: Workflow[];
  stressPolicy: StressPolicy;
  models: ModelAsset[];
  components: ComponentAsset[];
  datasets?: DatasetAsset[];
  suites?: SuiteAsset[];
  stressPlans?: SavedStressPlan[];
  mock?: MockProjectConfig;
}

export interface ContractCollection {
  id: string;
  name: string;
  variables: Record<string, string>;
  preOperations: Operation[];
  postOperations: Operation[];
  folders: ContractFolder[];
  apis: ApiAsset[];
}

export interface ContractFolder {
  id: string;
  name: string;
  preOperations: Operation[];
  postOperations: Operation[];
  folders: ContractFolder[];
  apis: ApiAsset[];
}

export const ContractFolderSchema: z.ZodType<ContractFolder> = z.lazy(() => z.object({
  id: ContainerIdSchema,
  name: z.string(),
  preOperations: OperationListSchema,
  postOperations: OperationListSchema,
  folders: z.array(ContractFolderSchema).default([]),
  apis: z.array(ApiAssetSchema).default([]),
}).strict());

export const ContractCollectionSchema: z.ZodType<ContractCollection> = z.object({
  id: ContainerIdSchema,
  name: z.string(),
  variables: StringRecordSchema(z.string()).default({}),
  preOperations: OperationListSchema,
  postOperations: OperationListSchema,
  folders: z.array(ContractFolderSchema).default([]),
  apis: z.array(ApiAssetSchema).default([]),
}).strict();

export const ContractProjectSchema: z.ZodType<ContractProject> = z.object({
  id: ContainerIdSchema,
  name: z.string(),
  variables: StringRecordSchema(z.string()).default({}),
  globals: ProjectGlobalsSchema,
  environments: z.array(ContractEnvironmentSchema).default([]),
  collections: z.array(ContractCollectionSchema).default([]),
  workflows: z.array(WorkflowSchema).default([]),
  stressPolicy: StressPolicySchema,
  models: z.array(ModelAssetSchema).default([]),
  components: z.array(ComponentAssetSchema).default([]),
  datasets: z.array(DatasetAssetSchema).default([]),
  suites: z.array(SuiteAssetSchema).default([]),
  stressPlans: z.array(SavedStressPlanSchema).refine(plans => new Set(plans.map(plan => plan.id)).size === plans.length, "duplicate stress plan id").optional(),
  mock: MockProjectConfigSchema.optional(),
}).strict();

export const ContractGroupSchema: z.ZodType<ContractGroup> = z.object({
  id: ContainerIdSchema,
  name: z.string(),
  default: z.boolean().optional(),
  projects: z.array(ContractProjectSchema).default([]),
}).strict();

export const ContractWorkspaceSchema: z.ZodType<ContractWorkspace> = z.object({
  formatVersion: z.literal(1),
  id: ContainerIdSchema,
  name: z.string(),
  variables: StringRecordSchema(z.string()).default({}),
  groups: z.array(ContractGroupSchema).default([]),
}).strict();
