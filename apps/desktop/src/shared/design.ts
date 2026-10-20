import { z } from "zod";
import {
  DocumentDiagnosticSchema,
  DocumentProjectionSchema,
  JsonValueSchema,
} from "@apicc/core/schema";
import { DocumentScopeSchema } from "@apicc/core/schema";
import { ApiLocatorSchema } from "./locations.js";

export const DesignPreviewInputSchema = z.object({
  sourceRoot: z.string().min(1),
  locator: ApiLocatorSchema,
  sourceProjectRevision: z.string().min(1),
  assetDraft: JsonValueSchema,
}).strict();
export type DesignPreviewInput = z.infer<typeof DesignPreviewInputSchema>;

export const DesignExportInputSchema = z.object({
  sourceRoot: z.string().min(1),
  locator: ApiLocatorSchema,
  format: z.enum(["markdown", "html", "openapi-3.0", "openapi-3.1"]),
  encoding: z.enum(["json", "yaml"]).optional(),
  infoVersion: z.string().optional(),
  scope: DocumentScopeSchema,
}).strict();
export type DesignExportInput = z.infer<typeof DesignExportInputSchema>;
export type DesignExportFormat = DesignExportInput["format"];

const DesignPreviewConflictCodeSchema = z.enum([
  "workspace-unavailable",
  "root-mismatch",
  "locator-mismatch",
  "api-not-found",
  "project-revision-changed",
]);

const DesignPreviewReadySchema = z.object({
  status: z.literal("ready"),
  source: z.literal("draft"),
  sourceRoot: z.string().min(1),
  locator: ApiLocatorSchema,
  sourceProjectRevision: z.string().min(1),
  sourceApiRevision: z.string().min(1),
  projection: DocumentProjectionSchema,
  diagnostics: z.array(DocumentDiagnosticSchema),
}).strict();

const DesignPreviewConflictSchema = z.object({
  status: z.literal("conflict"),
  source: z.literal("draft"),
  sourceRoot: z.string().min(1).optional(),
  locator: ApiLocatorSchema,
  sourceProjectRevision: z.string().min(1),
  currentSourceProjectRevision: z.string().min(1).optional(),
  code: DesignPreviewConflictCodeSchema,
  diagnostics: z.array(DocumentDiagnosticSchema),
}).strict();

const DesignPreviewInvalidSchema = z.object({
  status: z.literal("invalid"),
  source: z.literal("draft"),
  sourceRoot: z.string().min(1),
  locator: ApiLocatorSchema,
  sourceProjectRevision: z.string().min(1),
  diagnostics: z.array(DocumentDiagnosticSchema),
}).strict();

export const DesignPreviewResultSchema = z.discriminatedUnion("status", [
  DesignPreviewReadySchema,
  DesignPreviewConflictSchema,
  DesignPreviewInvalidSchema,
]);
export type DesignPreviewResult = z.infer<typeof DesignPreviewResultSchema>;
