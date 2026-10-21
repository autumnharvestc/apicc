import { z } from "zod";
import { JsonValueSchema, StringRecordSchema } from "../contract/schemaNode.js";

const boundedText = (bytes: number) => z.string().refine((value) => new TextEncoder().encode(value).length <= bytes, `Must be at most ${bytes} UTF-8 bytes`);
export const TestTagsSchema = z.array(z.string().max(64)).max(64);
export const ResponseSelectorFields = {
  target: z.enum(["status", "responseTime", "header", "bodyText", "bodyJson", "bodyXml", "cookie"]),
  match: z.enum(["first", "all"]).default("first"),
  path: boundedText(2048).optional(),
  headerName: z.string().optional(),
  cookieName: z.string().optional(),
  namespaces: StringRecordSchema(z.string()).optional(),
};
export function selectorKeysValid(selector: { target: string; path?: string; headerName?: string; cookieName?: string; namespaces?: Record<string, string> }): boolean {
  return (selector.path === undefined || ["bodyJson", "bodyXml"].includes(selector.target))
    && (selector.headerName === undefined || selector.target === "header")
    && (selector.cookieName === undefined || selector.target === "cookie")
    && (selector.namespaces === undefined || selector.target === "bodyXml");
}
export const ResponseSelectorSchema = z.object(ResponseSelectorFields).strict().refine(selectorKeysValid, "Selector fields do not match the target");
export type ResponseSelector = z.output<typeof ResponseSelectorSchema>;

export const NormalizedAssertionSchema = z.object({
  ...ResponseSelectorFields,
  id: z.string(),
  op: boundedText(128).refine((value) => value.trim().length > 0, "Operator must be nonempty"),
  expected: z.string().optional(),
  options: StringRecordSchema(JsonValueSchema).optional(),
}).strict().refine(selectorKeysValid, "Selector fields do not match the target");
export type NormalizedAssertion = z.output<typeof NormalizedAssertionSchema>;
export type Assertion = Omit<NormalizedAssertion, "match"> & { match?: "first" | "all" };
export const AssertionSchema: z.ZodType<Assertion, z.input<typeof NormalizedAssertionSchema>> = NormalizedAssertionSchema;

const ExtractionFields = {
  id: z.string(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/),
  selector: ResponseSelectorSchema,
  required: z.boolean().default(true),
  defaultValue: JsonValueSchema.optional(),
  sensitive: z.boolean().default(false),
};
export const ExtractionDefinitionSchema = z.discriminatedUnion("method", [
  z.object({ ...ExtractionFields, method: z.literal("value") }).strict(),
  z.object({ ...ExtractionFields, method: z.literal("regex"), pattern: boundedText(2048), flags: z.string().regex(/^(?!.*(.).*\1)[ims]*$/).optional(), group: z.number().int().nonnegative().default(0), regexMatch: z.enum(["first", "all"]).default("first") }).strict(),
]).refine((value) => value.method !== "regex" || value.selector.match === "first", "Regex extraction requires first selector match");
export type ExtractionDefinition = z.input<typeof ExtractionDefinitionSchema>;
export const ExtractionListSchema = z.array(ExtractionDefinitionSchema).max(64).superRefine((values, ctx) => {
  if (new Set(values.map((value) => value.name)).size !== values.length) ctx.addIssue({ code: "custom", message: "Duplicate extraction destination" });
});

export const DatasetAssetSchema = z.object({
  formatVersion: z.literal(1), id: z.string().uuid(), name: z.string().max(256), description: z.string().optional(),
  columns: z.array(z.string().min(1)).refine((columns) => new Set(columns).size === columns.length, "Duplicate columns"),
  rows: z.array(StringRecordSchema(JsonValueSchema)),
}).strict().superRefine((value, ctx) => {
  const columns = new Set(value.columns);
  value.rows.forEach((row, index) => {
    if (Object.keys(row).some((key) => !columns.has(key))) ctx.addIssue({ code: "custom", path: ["rows", index], message: "Row contains an undeclared column" });
  });
});
export type DatasetAsset = z.output<typeof DatasetAssetSchema>;
export const SuiteEntrySchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().uuid(), kind: z.literal("case"), collectionId: z.string().uuid(), folderIds: z.array(z.string().uuid()), apiId: z.string().uuid(), caseId: z.string() }).strict(),
  z.object({ id: z.string().uuid(), kind: z.literal("workflow"), workflowId: z.string() }).strict(),
]);
export type SuiteEntry = z.output<typeof SuiteEntrySchema>;
export const SuiteSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit"), entries: z.array(SuiteEntrySchema) }).strict(),
  z.object({ kind: z.literal("query"), collectionIds: z.array(z.string().uuid()).optional(), caseTags: TestTagsSchema.optional() }).strict(),
]).superRefine((selection, ctx) => {
  if (selection.kind !== "explicit") return;
  const keys = selection.entries.map((entry) => entry.kind === "workflow" ? JSON.stringify([entry.kind, entry.workflowId]) : JSON.stringify([entry.kind, entry.collectionId, entry.folderIds, entry.apiId, entry.caseId]));
  if (new Set(keys).size !== keys.length || new Set(selection.entries.map((entry) => entry.id)).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate suite entry" });
});
export type SuiteSelection = z.output<typeof SuiteSelectionSchema>;
export const SuiteAssetSchema = z.object({
  formatVersion: z.literal(1), id: z.string().uuid(), name: z.string().max(256), description: z.string().optional(),
  tags: TestTagsSchema.default([]), selection: SuiteSelectionSchema,
  environmentId: z.string().optional(), datasetId: z.string().uuid().optional(),
  failFast: z.boolean().default(false), reporters: z.array(z.enum(["html", "json", "junit"])).default(["html"]),
}).strict();
export type SuiteAsset = z.output<typeof SuiteAssetSchema>;
