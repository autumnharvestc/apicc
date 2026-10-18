import type { NetworkConfiguration, SecretRef } from "@apicc/core/schema";
import { NetworkConfigurationSchema, SecretRefSchema } from "@apicc/core/schema";
import { z } from "zod";
import { ProjectLocatorSchema } from "./locations.js";

const SecretStatusSchema = z.enum(["available", "missing", "unavailable"]);

export const NetworkProfilesGetInputSchema = ProjectLocatorSchema;
export const NetworkProfilesSaveInputSchema = z.object({
  locator: ProjectLocatorSchema,
  revision: z.string().min(1),
  configuration: NetworkConfigurationSchema,
}).strict();
export const NetworkSecretImportInputSchema = z.object({
  locator: ProjectLocatorSchema,
  ref: SecretRefSchema,
  locale: z.enum(["zh-CN", "en"]).optional(),
}).strict();

export const NetworkProfilesResultSchema = z.object({
  revision: z.string().min(1),
  configuration: NetworkConfigurationSchema,
  environments: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
  secretStatuses: z.array(z.object({ ref: SecretRefSchema, status: SecretStatusSchema }).strict()),
}).strict();
export const NetworkProfilesSaveResultSchema = z.object({ revision: z.string().min(1) }).strict();
export const NetworkSecretImportResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), status: SecretStatusSchema }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
  z.object({ outcome: z.literal("failed"), message: z.string().min(1) }).strict(),
]);

export type NetworkProfilesGetInput = z.infer<typeof NetworkProfilesGetInputSchema>;
export type NetworkProfilesSaveInput = z.infer<typeof NetworkProfilesSaveInputSchema>;
export type NetworkSecretImportInput = z.infer<typeof NetworkSecretImportInputSchema>;
export type NetworkProfilesResult = z.infer<typeof NetworkProfilesResultSchema>;
export type NetworkProfilesSaveResult = z.infer<typeof NetworkProfilesSaveResultSchema>;
export type NetworkSecretImportResult = z.infer<typeof NetworkSecretImportResultSchema>;
export type { NetworkConfiguration, SecretRef };
