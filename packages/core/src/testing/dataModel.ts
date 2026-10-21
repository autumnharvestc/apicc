import { z } from "zod";
import { StringRecordSchema } from "../contract/schemaNode.js";
import type { DeepReadonly } from "../assets/snapshot.js";
import type { CaseExecutionLocator } from "../runner/caseExecutor.js";

/** datasetId is an explicit outer source; a case's own driver stays in the snapshot. */
export interface PreparedCaseSelection {
  readonly locator: CaseExecutionLocator;
  readonly datasetId?: string;
}

export const TestDataDiagnosticSchema = z.object({
  code: z.string(), source: z.string(), row: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(), message: z.string(),
}).strict();
export const PreparedDataSourceSchema = z.object({
  key: z.string(), kind: z.enum(["file", "dataset"]), label: z.string(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  columns: z.array(z.string()).max(256),
  rows: z.array(z.object({ index: z.number().int().nonnegative(), values: StringRecordSchema(z.string()) }).strict()).max(10000),
  legacyEmptyFallback: z.boolean(), diagnostics: z.array(TestDataDiagnosticSchema),
}).strict();
const locatorSchema = z.object({ collectionId: z.string(), folderIds: z.array(z.string()), apiId: z.string(), caseId: z.string(), scope: z.string() }).strict();
export const PreparedTestDataSchema = z.object({
  formatVersion: z.literal(1), projectId: z.string(), definitionRevision: z.string(),
  selections: z.array(z.object({ key: z.string(), locator: locatorSchema, datasetId: z.string().optional(), sourceKey: z.string().optional() }).strict()),
  sources: z.array(PreparedDataSourceSchema), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type TestDataDiagnostic = z.output<typeof TestDataDiagnosticSchema>;
export type PreparedDataSource = DeepReadonly<z.output<typeof PreparedDataSourceSchema>>;
export type PreparedTestData = DeepReadonly<z.output<typeof PreparedTestDataSchema>>;
