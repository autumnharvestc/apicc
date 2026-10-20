import { z } from "zod";
import { MockProjectConfigSchema } from "@apicc/core/schema";
import { ProjectLocatorSchema } from "./locations.js";

export const MockRequestLogSchema = z.object({
  requestId: z.string().min(1),
  time: z.string().datetime(),
  method: z.string().min(1),
  routeTemplate: z.string().optional(),
  contractId: z.string().optional(),
  ruleId: z.string().optional(),
  responseBindingId: z.string().optional(),
  status: z.number().int().min(100).max(599),
  durationMs: z.number().finite().nonnegative(),
  revision: z.string().min(1),
  reason: z.string().min(1),
}).strict();

export const MockDiagnosticSchema = z.object({
  severity: z.enum(["warning", "error"]),
  code: z.string().min(1),
  path: z.string(),
  message: z.string(),
  lossy: z.boolean(),
  ownerId: z.string().optional(),
}).strict();

export const MockAddressSchema = z.object({
  address: z.string().min(1),
  family: z.enum(["IPv4", "IPv6"]),
  port: z.number().int().min(1).max(65_535),
}).strict();

export const MockStatusSchema = z.object({
  locator: ProjectLocatorSchema,
  config: MockProjectConfigSchema.nullable(),
  sourceProjectRevision: z.string().min(1),
  status: z.enum(["starting", "running", "reloading", "invalid", "stopping", "stopped"]),
  address: MockAddressSchema.nullable(),
  diagnostics: z.array(MockDiagnosticSchema),
  logs: z.array(MockRequestLogSchema).max(200),
  simulated: z.boolean(),
}).strict();

export const MockConfigSaveInputSchema = z.object({
  locator: ProjectLocatorSchema,
  sourceProjectRevision: z.string().min(1),
  config: MockProjectConfigSchema,
}).strict();

export const MockControlInputSchema = z.object({
  locator: ProjectLocatorSchema,
  sourceProjectRevision: z.string().min(1),
}).strict();

export const MockStartInputSchema = MockControlInputSchema.extend({
  port: z.number().int().min(0).max(65_535).optional(),
}).strict();

export const MockProjectCloseInputSchema = z.object({
  root: z.string().min(1),
  locator: ProjectLocatorSchema,
}).strict();

export type MockRequestLog = z.infer<typeof MockRequestLogSchema>;
export type MockDiagnostic = z.infer<typeof MockDiagnosticSchema>;
export type MockAddress = z.infer<typeof MockAddressSchema>;
export type MockStatus = z.infer<typeof MockStatusSchema>;
export type MockConfigSaveInput = z.infer<typeof MockConfigSaveInputSchema>;
export type MockControlInput = z.infer<typeof MockControlInputSchema>;
export type MockStartInput = z.infer<typeof MockStartInputSchema>;
export type MockProjectCloseInput = z.infer<typeof MockProjectCloseInputSchema>;
