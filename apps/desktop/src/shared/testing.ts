import { z } from "zod";
import { DatasetAssetSchema, SuiteAssetSchema } from "@apicc/core/schema";
import type { AssertOperatorDescriptor, DatasetAsset, SuiteAsset, SuitePreview, SuiteRunOverrides, RunResult } from "@apicc/core";
import { DatasetLocatorSchema, ProjectLocatorSchema, SuiteLocatorSchema } from "./locations.js";
import type { ApiLocator } from "./locations.js";

export type TestingPane = "api-cases" | "scenario" | "datasets" | "suites";
export const TestingReadInputSchema = z.object({ root: z.string().min(1), project: ProjectLocatorSchema }).strict();
export const TestingContextSchema = TestingReadInputSchema.extend({ revision: z.string().min(1) }).strict();
export type TestingContext = z.infer<typeof TestingContextSchema>;
export const DatasetSaveInputSchema = z.object({ context: TestingContextSchema, locator: DatasetLocatorSchema, asset: DatasetAssetSchema, create: z.boolean().optional() }).strict();
export const SuiteSaveInputSchema = z.object({ context: TestingContextSchema, locator: SuiteLocatorSchema, asset: SuiteAssetSchema, create: z.boolean().optional() }).strict();
export type DatasetSaveInput = z.infer<typeof DatasetSaveInputSchema>;
export type SuiteSaveInput = z.infer<typeof SuiteSaveInputSchema>;
export const TestingDeleteInputSchema = z.object({ context: TestingContextSchema, target: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dataset"), locator: DatasetLocatorSchema }).strict(),
  z.object({ kind: z.literal("suite"), locator: SuiteLocatorSchema }).strict(),
]) }).strict();
export type TestingDeleteInput = z.infer<typeof TestingDeleteInputSchema>;
const OverridesSchema = z.object({ environmentId: z.string().optional(), datasetId: z.string().uuid().optional(), failFast: z.boolean().optional(), allowDraft: z.boolean().optional(), reporters: z.array(z.enum(["json", "html", "junit"])).optional() }).strict();
export const SuiteInvocationSchema = z.object({ context: TestingContextSchema, locator: SuiteLocatorSchema, overrides: OverridesSchema.optional(), evidenceMode: z.enum(["none", "failures", "all"]).optional(), invocationId: z.string().uuid() }).strict();
export type SuiteInvocation = z.infer<typeof SuiteInvocationSchema>;
export const EvidenceIdentitySchema = z.object({ projectId: z.string(), definitionRevision: z.string(), locator: z.object({ collectionId: z.string().uuid(), folderIds: z.array(z.string().uuid()), apiId: z.string().uuid(), caseId: z.string(), scope: z.string() }).strict().optional(),
  invocationId: z.string().optional(), parentInvocationId: z.string().optional(), nodeVisitId: z.string().optional(), attempt: z.number().int().min(1).max(5).optional(),
  invocationPath: z.array(z.object({ workflowId: z.string(), nodeId: z.string().optional(), branchId: z.string().optional(), iteration: z.number().int().nonnegative().optional(), handler: z.enum(["onError", "finally"]).optional() }).strict()).optional(),
  suiteRunId: z.string().optional(), entryId: z.string().optional(), suiteRow: z.number().int().nonnegative().optional(), rowIndex: z.number().int().nonnegative().optional(), nodeId: z.string().optional(), workflowId: z.string().optional(), environmentId: z.string().optional(), dataDigest: z.string().optional(), datasetId: z.string().uuid().optional() }).strict();
export const EvidenceInvocationSchema = z.object({ context: TestingContextSchema, identity: EvidenceIdentitySchema, invocationId: z.string().uuid() }).strict();
export type EvidenceInvocation = Omit<z.infer<typeof EvidenceInvocationSchema>, "identity"> & { identity: import("@apicc/core").EvidenceIdentity };
export interface EvidenceTarget { available: boolean; changed: boolean; definitionRevision: string; reason?: string }
export const DatasetExchangeInputSchema = z.object({ context: TestingContextSchema, format: z.enum(["csv", "json"]), content: z.string().max(10 * 1024 * 1024) }).strict();
export const DatasetExportInputSchema = z.object({ context: TestingContextSchema, locator: DatasetLocatorSchema, format: z.enum(["csv", "json"]) }).strict();
export interface TestingAssets {
  context: TestingContext;
  readOnly: boolean;
  datasets: DatasetAsset[];
  suites: SuiteAsset[];
  environments: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
  cases: Array<{ locator: ApiLocator; caseId: string; name: string; scopes: string[]; tags: string[] }>;
  workflows: Array<{ id: string; name: string; status: string }>;
}
export interface AssertionOperatorDTO { op: string; descriptor?: AssertOperatorDescriptor }
export interface SuiteOutput { invocationId: string; context: TestingContext; result: RunResult }
export interface TestingApi {
  inspectEvidence(input: EvidenceInvocation): Promise<EvidenceTarget>;
  rerunEvidence(input: EvidenceInvocation): Promise<RunResult>;
  cancelEvidence(input: EvidenceInvocation): Promise<boolean>;
  listTestingAssets(input: z.infer<typeof TestingReadInputSchema>): Promise<TestingAssets>;
  assertionOperators(): Promise<AssertionOperatorDTO[]>;
  saveDataset(input: DatasetSaveInput): Promise<TestingAssets>;
  saveSuite(input: SuiteSaveInput): Promise<TestingAssets>;
  deleteTestingAsset(input: TestingDeleteInput): Promise<TestingAssets>;
  importDataset(input: z.infer<typeof DatasetExchangeInputSchema>): Promise<Pick<DatasetAsset, "columns" | "rows">>;
  exportDataset(input: z.infer<typeof DatasetExportInputSchema>): Promise<string>;
  previewSuite(input: SuiteInvocation): Promise<SuitePreview>;
  runSuite(input: SuiteInvocation): Promise<SuiteOutput>;
  cancelSuite(input: SuiteInvocation): Promise<boolean>;
}
export type { SuiteRunOverrides };
