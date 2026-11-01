/**
 * Desktop AI contracts. Legacy shapes remain for the old renderer's readable
 * failure path; trusted settings/preview/operation DTOs below are the live API.
 */

/** @deprecated Main rejects legacy writes; use personal settings / native migration. */
export interface AiSaveConfigInput { baseUrl: string; model: string; apiKey?: string }

/** @deprecated Legacy get returns hasKey:false without reading the old secret. */
export interface AiKeyStatus { hasKey: boolean }

/**
 * @deprecated Main rejects this unbound endpoint+secret compatibility route.
 */
import type { ApiLocator } from "../locations.js";
export interface AiSuggestInput { locator: ApiLocator; baseUrl: string; model: string }

/** @deprecated Main rejects legacy probes; new probes select a bound model profile. */
export interface AiTestConfigInput { baseUrl: string; model: string }

/** ai:test-config 出口：resolve 即连通/鉴权/响应面可用（失败以可读错误抛出）。 */
export interface AiTestConfigResult { ok: true }

import { z } from "zod";
import { AiConnectionSchema, AiConfigDocumentSchema, ApiContractSchema, DebugHistoryOwnerIdentitySchema } from "@apicc/core/schema";
import type { AiBusinessResult, AiContextPreview, AiResolvedInvocation, AiProgress } from "@apicc/core";
import { ProjectLocatorSchema } from "../locations.js";
import { OnlineExecutionContextSchema, ExecutionLocationSchema } from "../online/execution.js";

const revision = z.number().int().positive();
const identifier = z.string().min(1).max(256);
const aiProgressPhases = { queued: true, request: true, receiving: true, retrying: true, completed: true } satisfies Record<AiProgress['phase'], true>;
/** Public progress contains only runtime observations; no owner, event, prompt or response content. */
export const AiProgressDtoSchema = z.object({
  operationId: z.string().uuid(),
  phase: z.custom<AiProgress['phase']>(value => typeof value === 'string' && Object.hasOwn(aiProgressPhases, value)),
  attempt: z.number().int().nonnegative(), receivedBytes: z.number().int().nonnegative().optional(),
}).strict();
export type AiProgressDto = z.infer<typeof AiProgressDtoSchema>;
const { credentialRef: _privateRef, ...publicConnectionFields } = AiConnectionSchema.shape;
export const AiPublicConnectionSchema = z.object(publicConnectionFields).strict().superRefine((value, ctx) => {
  const result = AiConnectionSchema.safeParse(value);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export const AiSettingsWriteSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("connection"), expectedRevision: revision, connection: AiPublicConnectionSchema }).strict(),
  z.object({ operation: z.literal("credential"), expectedRevision: revision, connectionId: identifier, value: z.string().min(1).max(16384), mode: z.enum(["persistent", "session-only"]) }).strict(),
  z.object({ operation: z.literal("preferences"), expectedRevision: revision,
    application: AiConfigDocumentSchema.shape.application.optional(), models: AiConfigDocumentSchema.shape.models.optional(),
    bindings: AiConfigDocumentSchema.shape.bindings.optional(), projectOverrides: AiConfigDocumentSchema.shape.projectOverrides.optional(),
  }).strict(),
  z.object({ operation: z.literal("migrate-legacy") }).strict(),
]);
export type AiSettingsWriteInput = z.infer<typeof AiSettingsWriteSchema>;
export type AiCredentialState = "available" | "missing" | "unavailable" | "session-only";
export interface AiSettingsView {
  scope: "desktop-device-personal"; revision: number;
  application: import("@apicc/core").AiConfigDocument["application"];
  connections: (z.infer<typeof AiPublicConnectionSchema> & { credentialState: AiCredentialState })[];
  models: import("@apicc/core").AiModelProfile[];
  bindings: import("@apicc/core").AiPurposeBinding[];
  projectOverrides: import("@apicc/core").AiConfigDocument["projectOverrides"];
  backend: "available" | "unavailable"; legacyAvailable: boolean;
}
export interface AiMigrationResultDto {
  status: "migrated" | "already-migrated" | "confirmation-required" | "needs-configuration";
  credentialState: AiCredentialState; connectionId?: string; modelProfileId?: string;
}
export interface AiCatalogDto {
  catalog: readonly import("@apicc/core").AiProviderTemplate[];
  errors: { file: string; field: string; message: string }[];
  diff: { added: string[]; updated: string[]; removed: string[] }; conflicts?: string[];
}
export const AiCatalogImportSchema = z.object({ file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/), document: z.unknown(), apply: z.boolean().optional(), confirmConflicts: z.boolean().optional() }).strict();
export type AiCatalogImportInput = z.infer<typeof AiCatalogImportSchema>;
export const AiSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), project: ProjectLocatorSchema }).strict(),
  z.object({ kind: z.literal("online"), context: OnlineExecutionContextSchema }).strict(),
]);
export const AiReportRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), file: z.string().regex(/^[^/\\]+\.json$/) }).strict(),
  z.object({ kind: z.literal("stress"), file: z.string().regex(/^[^/\\]+\.json$/) }).strict(),
  z.object({ kind: z.literal("debug"), historyId: z.string().uuid(), owner: DebugHistoryOwnerIdentitySchema }).strict(),
  z.object({ kind: z.literal("current"), expectedReportDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("online"), runId: identifier, location: ExecutionLocationSchema }).strict(),
]);
const apiTarget = z.object({ collectionId: z.string().uuid(), folderIds: z.array(z.string().uuid()), apiId: z.string().uuid(), caseId: z.string().optional(), scope: z.string().optional() }).strict();
export const AiSelectionSchema = z.object({
  source: AiSourceRefSchema, editGeneration: z.number().int().nonnegative(),
  business: z.discriminatedUnion("purpose", [
    z.object({ purpose: z.literal("case-suggestion"), target: apiTarget }).strict(),
    z.object({ purpose: z.literal("assertion-suggestion"), target: apiTarget.required({ caseId: true, scope: true }),
      basis: z.discriminatedUnion("kind", [z.object({ kind: z.literal("contract") }).strict(), z.object({ kind: z.literal("observation"), report: AiReportRefSchema, caseIndex: z.number().int().nonnegative() }).strict()]),
    }).strict(),
    z.object({ purpose: z.literal("report-analysis"), report: AiReportRefSchema, baseline: AiReportRefSchema.optional() }).strict(),
  ]),
}).strict();
export type AiSelection = z.infer<typeof AiSelectionSchema>;
export type AiSourceRef = z.infer<typeof AiSourceRefSchema>;
export type AiReportRef = z.infer<typeof AiReportRefSchema>;
export const AiPrepareSchema = z.object({ selection: AiSelectionSchema, bodySelection: z.array(identifier).max(200), instruction: z.string().max(65536).optional(), limit: z.number().int().min(1).max(50).optional(),
  choicesId: z.string().uuid().optional(),
  evidenceSelection: z.array(identifier).max(200).optional(), modelProfileId: identifier.optional(),
  currentDraft: z.object({ sourceApiRevision: identifier, contract: ApiContractSchema, documentation: z.string().max(4 * 1024 * 1024).optional() }).strict().optional(),
}).strict();
export type AiPrepareInput = z.infer<typeof AiPrepareSchema>;
// B interface/load calibration only: declarations do not implement inspection.
export const AiChoicesInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('capture'), input: AiPrepareSchema.omit({ bodySelection: true, evidenceSelection: true, choicesId: true }) }).strict(),
  z.object({ operation: z.literal('bodies'), choicesId: z.string().uuid(), bodySelection: z.array(identifier).max(200) }).strict(),
]);
export type AiChoicesInput = z.infer<typeof AiChoicesInputSchema>;
export const AiChoicesPageInputSchema = z.object({ choicesId: z.string().uuid(), section: z.enum(['evidence', 'bodies']), cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
export type AiChoicesPageInput = z.infer<typeof AiChoicesPageInputSchema>;
interface AiChoicesPageBase { choicesId: string; total: number; selectable: number; returned: number; omitted: number; complete: boolean; nextCursor?: string }
export type AiChoicesPageDto = AiChoicesPageBase & (
  | { section: 'evidence'; items: readonly import('@apicc/core').AiSafeChoice[] }
  | { section: 'bodies'; items: readonly import('@apicc/core').AiBodyChoice[] }
);
export interface AiChoicesDto {
  choicesId: string; source: AiContextPreviewDto['source']; bodySelection: readonly string[];
  destination: AiContextPreviewDto['destination']; budgets: AiContextPreviewDto['budgets']; budgetSources: AiContextPreviewDto['budgetSources'];
  capabilityStatus: AiContextPreviewDto['capabilityStatus']; warnings: readonly string[];
  evidence: Extract<AiChoicesPageDto, { section: 'evidence' }>; bodies: Extract<AiChoicesPageDto, { section: 'bodies' }>;
}
export const AiStartSchema = z.object({ previewId: z.string().uuid(), operationId: z.string().uuid(), selection: AiSelectionSchema }).strict();
export type AiStartInput = z.infer<typeof AiStartSchema>;
export const AiCancelSchema = z.object({ operationId: z.string().uuid() }).strict();
export const AiProbeSchema = z.object({ operationId: z.string().uuid(), modelProfileId: identifier }).strict();
export const AiDiscoverSchema = z.object({ operationId: z.string().uuid(), connectionId: identifier }).strict();
export interface AiContextPreviewDto {
  purpose: AiContextPreview["purpose"]; bytes: number; source: AiContextPreview["source"];
  evidence: AiContextPreview["evidence"]; included: readonly string[]; omitted: AiContextPreview["omitted"]; redaction: AiContextPreview["redaction"];
  limit?: number; evidenceSelection?: AiContextPreview["evidenceSelection"];
  destination: { baseUrl: string; modelProfileId: string; modelId: string; protocol: import("@apicc/core").AiProtocol };
  budgets: AiResolvedInvocation["budgets"]; budgetSources: AiResolvedInvocation["sources"];
  capabilityStatus: AiResolvedInvocation["capabilityStatus"]; warnings: string[];
}
export type AiBusinessResultDto = AiBusinessResult & { bindingId: string };
export interface AiDiscoverResultDto { status: "available" | "unsupported"; models: { id: string }[]; reason?: string }
