import { reactive } from "vue";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { useEnvsStore } from "./envs.js";
import type { KeyValuePair } from "@apicc/core";
import type { ProjectGlobalSettings } from "../../../shared/types.js";
import type { WorkspaceRefreshResult } from "../../../shared/types.js";
import { diskProject, sameDiskValue, type DiskDraftConflict } from "./diskDrafts.js";
import type { LocalWorkspaceFailure } from "../../../shared/workspace-refresh.js";
import { projectSessionKey } from "./localIdentity.js";
import { workspaceEnvironmentDependencies } from "../../../shared/workspace-api-dependencies.js";

export type FailureStep = "globals" | "variables" | "baseUrls" | "interrupted";
export interface VarRow { id: string; key: string; value: string }
export interface ParamRow extends VarRow { enabled: boolean }
export interface SaveFeedback {
  pending: boolean;
  saved: boolean;
  error: { step: FailureStep; message: string } | null;
  failure?: LocalWorkspaceFailure;
  conflict?: DiskDraftConflict;
}
export interface EnvironmentDraft {
  rows: VarRow[];
  baseUrls: Record<string, string>;
  confirmedVariables: Record<string, string>;
  confirmedBaseUrls: Record<string, string>;
  name: string;
  conflictFields?: { variables: boolean; baseUrls: boolean };
  pendingBaseUrls?: boolean;
  feedback: SaveFeedback;
}
export interface ProjectDraft {
  root: string;
  locator: ProjectLocator;
  globals: ProjectGlobalSettings;
  latestGlobals: ProjectGlobalSettings;
  projectDeleted?: boolean;
  previousModules?: Array<{ id: string; name: string }>;
  variableRows: VarRow[];
  queryRows: ParamRow[];
  headerRows: ParamRow[];
  variableFeedback: SaveFeedback;
  parameterFeedback: SaveFeedback;
  environments: Map<string, EnvironmentDraft>;
}

// The local and online workbenches each keep their existing store when this
// panel unmounts. Keep drafts and pending feedback with that store instance.
const projectDrafts = new WeakMap<ReturnType<typeof useEnvsStore>, Map<string, ProjectDraft>>();
export function recordToRows(record: Record<string, string>): VarRow[] {
  return Object.entries(record).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }));
}
export function paramsToRows(list: KeyValuePair[]): ParamRow[] {
  return list.map((item) => ({ id: crypto.randomUUID(), ...item }));
}
function variableValues(entries: [string, string][]): Record<string, string> {
  return Object.fromEntries(entries.map(([key, value]) => [key.trim(), value]).filter(([key]) => key));
}
export function variablePayload(rows: VarRow[]): Record<string, string> {
  return variableValues(rows.map(({ key, value }) => [key, value]));
}
export function normalizedVariables(variables: Record<string, string>): Record<string, string> { return variableValues(Object.entries(variables)); }
export function parameterPayload(rows: KeyValuePair[]): KeyValuePair[] {
  return rows.filter((row) => row.key.trim()).map(({ key, value, enabled }) => ({ key: key.trim(), value, enabled }));
}
export function baseUrlPayload(urls: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(urls).map(([id, value]) => [id, value.trim()]).filter(([, value]) => value));
}

export function reconcileEnvironmentDrafts(store: ReturnType<typeof useEnvsStore>, receipt: WorkspaceRefreshResult): void {
  for (const draft of projectDrafts.get(store)?.values() ?? []) {
    if (draft.root !== receipt.root) continue;
    const previous = diskProject(receipt.previousWorkspace, draft.locator);
    const project = diskProject(receipt.workspace, draft.locator);
    if (previous) draft.previousModules = previous.collections.map(({ id, name }) => ({ id, name }));
    draft.projectDeleted = !project;
    const next = project && { ...project.globals, variables: project.variables };
    if (next) draft.latestGlobals = next;
    const vars = draft.variableFeedback, params = draft.parameterFeedback;
    const variableDirty = !sameDiskValue(variablePayload(draft.variableRows), normalizedVariables(draft.globals.variables));
    const parameters = (source: { query: KeyValuePair[]; headers: KeyValuePair[] }) => [parameterPayload(source.query), parameterPayload(source.headers)];
    const parameterDirty = !sameDiskValue(parameters({ query: draft.queryRows, headers: draft.headerRows }), parameters(draft.globals));
    const projectName = project?.name ?? previous?.name ?? "";
    const restoreVariables = () => {
      draft.variableRows = recordToRows((next ?? draft.globals).variables);
      if (next) draft.globals = { ...draft.globals, variables: next.variables };
      vars.conflict = undefined;
      vars.error = null;
      vars.failure = undefined;
    };
    const restoreParameters = () => {
      draft.queryRows = paramsToRows((next ?? draft.globals).query);
      draft.headerRows = paramsToRows((next ?? draft.globals).headers);
      if (next) draft.globals = { ...draft.globals, query: next.query, headers: next.headers };
      params.conflict = undefined;
      params.error = null;
      params.failure = undefined;
    };
    if (variableDirty && (vars.conflict || !next || !sameDiskValue(normalizedVariables(draft.globals.variables), normalizedVariables(next.variables)))) {
      vars.conflict = { reason: next ? "changed" : "deleted", name: projectName, restore: restoreVariables };
    } else if (next && !variableDirty) restoreVariables();
    if (parameterDirty && (params.conflict || !next || !sameDiskValue(parameters(draft.globals), parameters(next)))) {
      params.conflict = { reason: next ? "changed" : "deleted", name: projectName, restore: restoreParameters };
    } else if (next && !parameterDirty) restoreParameters();
    for (const [id, draftEnv] of draft.environments) {
      const disk = project?.environments.find((entry) => entry.id === id);
      const old = previous?.environments.find((entry) => entry.id === id);
      const variablesDirty = !sameDiskValue(variablePayload(draftEnv.rows), normalizedVariables(draftEnv.confirmedVariables));
      const editedUrls = baseUrlPayload(draftEnv.baseUrls);
      const urlsDirty = !sameDiskValue(editedUrls, baseUrlPayload(draftEnv.confirmedBaseUrls));
      const linkedChanged = (urls?: Record<string, string>) => !sameDiskValue(
        workspaceEnvironmentDependencies(receipt.previousWorkspace, draft.locator, id, urls),
        workspaceEnvironmentDependencies(receipt.workspace, draft.locator, id, urls),
      );
      const variablesConflict = variablesDirty && (draftEnv.conflictFields?.variables || !disk || old?.extends !== disk.extends
        || linkedChanged()
        || !sameDiskValue(normalizedVariables(draftEnv.confirmedVariables), normalizedVariables(disk.variables)));
      const urlsConflict = urlsDirty && (draftEnv.conflictFields?.baseUrls || !disk || old?.extends !== disk.extends || linkedChanged(editedUrls)
        || !sameDiskValue(baseUrlPayload(draftEnv.confirmedBaseUrls), baseUrlPayload(disk.baseUrls ?? {})));
      if (!disk && !variablesDirty && !urlsDirty) { draft.environments.delete(id); continue; }
      const restore = () => {
        if (disk) {
          if (variablesConflict) draftEnv.rows = recordToRows(disk.variables);
          if (urlsConflict) {
            draftEnv.baseUrls = { ...(disk.baseUrls ?? {}) };
            draftEnv.pendingBaseUrls = false;
          }
          draftEnv.confirmedVariables = { ...disk.variables };
          draftEnv.confirmedBaseUrls = { ...(disk.baseUrls ?? {}) };
        } else draft.environments.delete(id);
        draftEnv.feedback.conflict = undefined;
        draftEnv.conflictFields = undefined;
        draftEnv.feedback.failure = undefined;
        draftEnv.feedback.error = null;
      };
      if (variablesConflict || urlsConflict) {
        draftEnv.conflictFields = { variables: !!variablesConflict, baseUrls: !!urlsConflict };
        draftEnv.feedback.conflict = { reason: disk ? "changed" : "deleted", name: draftEnv.name, restore };
      } else if (disk) {
        draftEnv.feedback.conflict = undefined;
        draftEnv.conflictFields = undefined;
        if (!variablesDirty) draftEnv.rows = recordToRows(disk.variables);
        if (!urlsDirty) draftEnv.baseUrls = { ...(disk.baseUrls ?? {}) };
        draftEnv.confirmedVariables = { ...disk.variables };
        draftEnv.confirmedBaseUrls = { ...(disk.baseUrls ?? {}) };
        draftEnv.feedback.failure = undefined;
        draftEnv.feedback.error = null;
      }
    }
  }
}

export function environmentDraftsFor(store: ReturnType<typeof useEnvsStore>): Map<string, ProjectDraft> {
  const existing = projectDrafts.get(store);
  if (existing) return existing;
  const drafts = reactive(new Map<string, ProjectDraft>());
  projectDrafts.set(store, drafts);
  return drafts;
}

export function hasEnvironmentDrafts(store: ReturnType<typeof useEnvsStore>, root: string, locator: ProjectLocator, deletedOnly = false): boolean {
  const draft = projectDrafts.get(store)?.get(projectSessionKey(root, locator));
  if (!draft || (deletedOnly && !draft.projectDeleted)) return false;
  return !sameDiskValue(variablePayload(draft.variableRows), normalizedVariables(draft.globals.variables))
    || !sameDiskValue(parameterPayload(draft.queryRows), parameterPayload(draft.globals.query))
    || !sameDiskValue(parameterPayload(draft.headerRows), parameterPayload(draft.globals.headers))
    || [...draft.environments.values()].some((environment) =>
      !sameDiskValue(variablePayload(environment.rows), normalizedVariables(environment.confirmedVariables))
      || !sameDiskValue(baseUrlPayload(environment.baseUrls), baseUrlPayload(environment.confirmedBaseUrls)));
}

export function evictEnvironmentDrafts(store: ReturnType<typeof useEnvsStore>, root: string, locator: ProjectLocator): void {
  projectDrafts.get(store)?.delete(projectSessionKey(root, locator));
}
