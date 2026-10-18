import {
  OAuthProfileSchema,
  OAuthProfileSummarySchema,
  OAuthPublicResultSchema,
  type OAuthProfile,
  type OAuthProfileSummary,
  type OAuthPublicResult,
} from "@apicc/core/schema";
import { z } from "zod";
import { ProjectLocatorSchema, type ProjectLocator } from "./locations.js";

export const OAuthProfilesGetInputSchema = z.object({
  locator: ProjectLocatorSchema,
  environmentId: z.string().min(1).optional(),
}).strict();
export type OAuthProfilesGetInput = z.infer<typeof OAuthProfilesGetInputSchema>;

export const OAuthProfileSaveInputSchema = z.object({
  locator: ProjectLocatorSchema,
  environmentId: z.string().min(1).optional(),
  profile: OAuthProfileSchema,
  expectedRevision: z.string().min(1).optional(),
}).strict();
export type OAuthProfileSaveInput = z.infer<typeof OAuthProfileSaveInputSchema>;

export const OAuthProfileUnlinkInputSchema = z.object({
  locator: ProjectLocatorSchema,
  environmentId: z.string().min(1).optional(),
  profileId: z.string().min(1),
  expectedRevision: z.string().min(1).optional(),
}).strict();
export type OAuthProfileUnlinkInput = z.infer<typeof OAuthProfileUnlinkInputSchema>;

export const OAuthProfileActionInputSchema = z.object({
  locator: ProjectLocatorSchema,
  environmentId: z.string().min(1).optional(),
  profileId: z.string().min(1),
}).strict();
export type OAuthProfileActionInput = z.infer<typeof OAuthProfileActionInputSchema>;

export const OAuthAuthorizationBeginInputSchema = z.object({
  locator: ProjectLocatorSchema,
  environmentId: z.string().min(1).optional(),
  profileId: z.string().min(1),
  listenPort: z.number().int().min(0).max(65_535).optional(),
  listenHost: z.enum(["127.0.0.1", "::1"]).optional(),
}).strict();
export type OAuthAuthorizationBeginInput = z.infer<typeof OAuthAuthorizationBeginInputSchema>;

export const OAuthAuthorizationSessionIdSchema = z.object({ sessionId: z.string().uuid() }).strict();
export type OAuthAuthorizationSessionId = z.infer<typeof OAuthAuthorizationSessionIdSchema>;

export const OAuthAuthorizationSessionViewSchema = z.object({
  sessionId: z.string().uuid(),
  profileId: z.string().min(1),
  status: z.enum(["pending", "success", "failed", "cancelled"]),
  sessionExpiresAt: z.number().finite().nonnegative(),
  errorCode: z.string().optional(),
  operationResult: OAuthPublicResultSchema.optional(),
}).strict();
export type OAuthAuthorizationSessionView = z.infer<typeof OAuthAuthorizationSessionViewSchema>;

export const OAuthProfilesResultSchema = z.object({
  revision: z.string(),
  profiles: z.array(OAuthProfileSummarySchema),
}).strict();
export type OAuthProfilesResult = { revision: string; profiles: OAuthProfileSummary[] };

export const OAuthProfileMutationResultSchema = z.object({
  result: OAuthPublicResultSchema,
  profileSnapshot: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("available"),
      revision: z.string(),
      profiles: z.array(OAuthProfileSummarySchema),
    }).strict(),
    z.object({ status: z.literal("unavailable") }).strict(),
  ]),
}).strict();
export type OAuthProfileMutationResult = z.infer<typeof OAuthProfileMutationResultSchema>;

export type { OAuthProfile, OAuthProfileSummary, OAuthPublicResult, ProjectLocator };
