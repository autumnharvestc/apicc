import { z } from "zod";
import { IpcChannel } from "./channels.js";
import { ProjectLocatorSchema } from "./locations.js";

export const WorkspaceObservationInputSchema = z.object({
  root: z.string().min(1),
  workspaceId: z.string().uuid(),
}).strict();
export type WorkspaceObservationInput = z.infer<typeof WorkspaceObservationInputSchema>;
export const WorkspaceRefreshInputSchema = WorkspaceObservationInputSchema.extend({
  observedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type WorkspaceRefreshInput = z.infer<typeof WorkspaceRefreshInputSchema>;
export type WorkspaceObservedAssetChange = {
  id: string; kind: "added" | "modified" | "removed";
  asset: "project" | "module" | "folder" | "api" | "case" | "workflow" | "environment" | "dataset" | "suite" | "model" | "component";
  name: string; location?: string;
};
export interface WorkspaceObservationResult extends WorkspaceObservationInput {
  revision: string;
  changes: Array<{ project?: z.infer<typeof ProjectLocatorSchema>; name: string; groupName?: string;
    kind: WorkspaceObservedAssetChange["kind"]; changes: WorkspaceObservedAssetChange[] }>;
}

export const LocalWorkspaceFailureSchema = z.object({
  localWorkspaceFailure: z.literal(true),
  reason: z.enum([
    "revision-conflict", "busy", "read-only", "unstable", "directory-changed",
    "directory-unavailable", "workspace-unreadable", "project-missing",
    "context-changed", "workspace-replaced", "asset-changed", "asset-missing", "dependency-changed", "failed",
  ]),
  root: z.string().optional(),
  project: ProjectLocatorSchema.optional(),
}).strict();
export type LocalWorkspaceFailure = z.infer<typeof LocalWorkspaceFailureSchema>;
export type LocalWorkspaceFailureReason = LocalWorkspaceFailure["reason"];

export class LocalWorkspaceError extends Error {
  constructor(readonly failure: LocalWorkspaceFailure, message: string = failure.reason) {
    super(message);
    this.name = "LocalWorkspaceError";
  }
}

export function localWorkspaceError(reason: LocalWorkspaceFailureReason, message: string, root?: string): LocalWorkspaceError {
  return new LocalWorkspaceError({ localWorkspaceFailure: true, reason, ...(root === undefined ? {} : { root }) }, message);
}

export const localWorkspaceFailureMethodsByChannel = {
  [IpcChannel.WsOpen]: "wsOpen",
  [IpcChannel.WsResolveRoot]: "wsResolveRoot",
  [IpcChannel.WsCreate]: "wsCreate",
  [IpcChannel.WsRefresh]: "wsRefresh",
  [IpcChannel.WsObserve]: "wsObserve",
  [IpcChannel.ApiSave]: "apiSave",
  [IpcChannel.ApiRequestDraftSave]: "apiRequestDraftSave",
  [IpcChannel.ApiCreateFromRequestDraft]: "apiCreateFromRequestDraft",
  [IpcChannel.CaseSave]: "caseSave",
  [IpcChannel.CaseDraftSave]: "caseDraftSave",
  [IpcChannel.GlobalsSave]: "globalsSave",
  [IpcChannel.EnvVarsSave]: "envVarsSave",
  [IpcChannel.EnvBaseUrlsSave]: "envBaseUrlsSave",
  [IpcChannel.WfSave]: "wfSave",
  [IpcChannel.WfSetStatus]: "wfSetStatus",
  [IpcChannel.DatasetSave]: "saveDataset",
  [IpcChannel.SuiteSave]: "saveSuite",
} as const;
export type LocalWorkspaceFailureChannel = keyof typeof localWorkspaceFailureMethodsByChannel;
export const localWorkspaceFailureChannels = Object.keys(localWorkspaceFailureMethodsByChannel) as LocalWorkspaceFailureChannel[];
export const localWorkspaceFailureMethods = Object.values(localWorkspaceFailureMethodsByChannel);
