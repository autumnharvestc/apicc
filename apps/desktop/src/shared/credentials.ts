import type { CredentialErrorCode } from "@apicc/core";
import { SecretRefSchema } from "@apicc/core/schema";
import { z } from "zod";
import { ProjectLocatorSchema } from "./locations.js";

export const CredentialPutInputSchema = z.object({
  locator: ProjectLocatorSchema,
  ref: SecretRefSchema,
  value: z.string(),
}).strict();

export const CredentialRefInputSchema = z.object({
  locator: ProjectLocatorSchema,
  ref: SecretRefSchema,
}).strict();

const DesktopCredentialErrorCodeSchema = z.enum([
  "CREDENTIAL_MISSING",
  "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_FORMAT_UNSUPPORTED",
  "CREDENTIAL_POLICY_UNSUPPORTED",
  "CREDENTIAL_READ_FAILED",
  "CREDENTIAL_SAVE_FAILED",
  "CREDENTIAL_REMOVE_FAILED",
  "CREDENTIAL_VERSION_CONFLICT",
  "CREDENTIAL_CONTEXT_INVALID",
  "CREDENTIAL_READ_ONLY",
]);

const CredentialFailureSchema = z.object({
  code: DesktopCredentialErrorCodeSchema,
  refId: z.string(),
  message: z.string(),
}).strict();

export const CredentialMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: CredentialFailureSchema }).strict(),
]);

export const CredentialStatusResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: z.enum(["available", "missing", "unavailable"]) }).strict(),
  z.object({ ok: z.literal(false), error: CredentialFailureSchema }).strict(),
]);

export type CredentialPutInput = z.infer<typeof CredentialPutInputSchema>;
export type CredentialRefInput = z.infer<typeof CredentialRefInputSchema>;
export type DesktopCredentialErrorCode = CredentialErrorCode | "CREDENTIAL_CONTEXT_INVALID" | "CREDENTIAL_READ_ONLY";
export type CredentialFailure = z.infer<typeof CredentialFailureSchema>;
export type CredentialMutationResult = z.infer<typeof CredentialMutationResultSchema>;
export type CredentialStatusResult = z.infer<typeof CredentialStatusResultSchema>;
