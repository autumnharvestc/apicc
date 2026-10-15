import { z } from "zod";

import { normalizeStressPolicy } from "../stress/safety.js";
import { StringRecordSchema } from "../contract/schemaNode.js";
import { ApiRequestSchema } from "../contract/request.js";
import { RequestSettingsOverrideSchema } from "../request/settings.js";
import { HttpMethodSchema, KeyValuePairSchema, ProtocolSchema, type HttpMethod, type KeyValuePair } from "./primitives.js";

export { HttpMethodSchema, KeyValuePairSchema, ProtocolSchema } from "./primitives.js";
export type { HttpMethod, KeyValuePair, Protocol } from "./primitives.js";

export type ID = string;

export const AssertionSchema = z.object({
  id: z.string(),
  target: z.enum(["status", "header", "bodyJson", "responseTime"]),
  op: z.enum(["eq", "neq", "contains", "lt", "gt", "lte", "gte"]),
  expected: z.string().optional(),
  headerName: z.string().optional(),
  path: z.string().optional(),
}).strict();
export type Assertion = z.output<typeof AssertionSchema>;

export const DataDriverSchema = z.object({
  sourcePath: z.string(),
  format: z.enum(["csv", "json"]),
}).strict();
export type DataDriver = z.output<typeof DataDriverSchema>;

export const OperationSchema = z.object({
  id: z.string(),
  type: z.literal("script"),
  content: z.string().default(""),
}).strict();
export type Operation = z.output<typeof OperationSchema>;
export const OperationListSchema = z.array(OperationSchema).default([]);

export const TestCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string().default("base"),
  requestOverride: ApiRequestSchema.optional(),
  requestSettingsOverride: RequestSettingsOverrideSchema.optional(),
  parameters: StringRecordSchema(z.string()).default({}),
  dataDriver: DataDriverSchema.optional(),
  preOperations: OperationListSchema,
  postOperations: OperationListSchema,
  assertions: z.array(AssertionSchema).default([]),
}).strict();
export type TestCase = z.output<typeof TestCaseSchema>;

export type { RequestSettingsOverride } from "../request/settings.js";

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  extends: z.string().optional(),
  variables: StringRecordSchema(z.string()).default({}),
  baseUrls: StringRecordSchema(z.string()).default({}),
}).strict();
export type Environment = z.output<typeof EnvironmentSchema>;

export const ProjectGlobalsSchema = z.object({
  query: z.array(KeyValuePairSchema).default([]),
  headers: z.array(KeyValuePairSchema).default([]),
  cookies: z.array(KeyValuePairSchema).default([]),
  body: z.array(KeyValuePairSchema).default([]),
}).strict();
export type ProjectGlobals = z.output<typeof ProjectGlobalsSchema>;

export interface StressPolicy {
  trustedOrigins?: string[];
  deniedOrigins?: string[];
  maxConcurrency?: number;
  maxRps?: number;
}

/** Existing stress safety helpers consume the same policy shape through this type-only name. */
export type StressTargetPolicy = StressPolicy;

const RawStressPolicySchema = z.object({
  trustedOrigins: z.array(z.string()).default([]),
  deniedOrigins: z.array(z.string()).default([]),
  maxConcurrency: z.number().int().positive().optional(),
  maxRps: z.number().finite().positive().optional(),
}).strict().superRefine((policy, ctx) => {
  try {
    normalizeStressPolicy(policy);
  } catch (error) {
    ctx.addIssue({ code: "custom", path: [], message: error instanceof Error ? error.message : String(error) });
  }
});

export const StressPolicySchema = z.preprocess(
  (input) => input === undefined ? {} : input,
  RawStressPolicySchema.transform((policy) => normalizeStressPolicy(policy)),
);
