import { z } from "zod";
import { ExecutionHttpError, type HttpClientOptions } from "./http.js";
import { EntityIdSchema, MaterialRefSchema, AssetVersionSchema, MaterialSelectionSchema, ProjectRunMaterialsSchema, CredentialWriteSchema, CredentialMetadataSchema, AttachmentWriteSchema, AttachmentMetadataSchema, type MaterialSelection, type ServerProjectScope } from "../contract/index.js";

type ProjectRoute = Pick<ServerProjectScope, "workspaceId" | "projectId">;
function projectPath(scope: ProjectRoute): string { return `workspaces/${EntityIdSchema.parse(scope.workspaceId)}/projects/${EntityIdSchema.parse(scope.projectId)}`; }
/** Data requests have their own timeout and never follow a redirect with a control token. */
function dataRequest(options: HttpClientOptions) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Materials require a control HTTPS URL without embedded credentials");
  const timeoutMs = z.number().int().positive().max(2147483647).parse(options.timeoutMs ?? 120000);
  return async <T>(method: string, path: string, body: unknown, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    const token = await options.token();
    if (!token || /[\r\n]/.test(token)) throw new Error("Missing or invalid control identity");
    const controller = new AbortController(); const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("Materials transfer timeout")), timeoutMs);
    try {
      const response = await options.fetch(`${base.href.replace(/\/$/, "")}/${path}`, { method, redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        // Do not forward a server error body/message: it can contain request values or deployment paths.
        let code: string | undefined;
        try { const error = await response.json(); if (typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)) code = error.code; } catch { /* HTTP status still explains the failure. */ }
        throw new ExecutionHttpError(response.status, code);
      }
      return schema.parse(response.status === 204 ? undefined : await response.json());
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  };
}

/** Member identity. Returned values are only for the caller's authorized local run. */
export function createMemberMaterialsClient(options: HttpClientOptions) {
  const request = dataRequest(options);
  return {
    async loadLocal(snapshotId: string, input: MaterialSelection, signal: AbortSignal) {
      const selection = MaterialSelectionSchema.parse(input);
      const fixed = EntityIdSchema.parse(snapshotId);
      const material = await request("POST", `execution-snapshots/${fixed}/local-materials`, selection, ProjectRunMaterialsSchema, signal);
      if (material.snapshotId !== fixed || material.scope.projectId !== selection.projectId) throw new Error("Material snapshot/project identity mismatch");
      return material;
    },
    listCredentials(scope: ProjectRoute, signal: AbortSignal) { return request("GET", `${projectPath(scope)}/credentials`, undefined, z.array(CredentialMetadataSchema), signal); },
    putCredential(scope: ProjectRoute, refId: string, input: z.input<typeof CredentialWriteSchema>, signal: AbortSignal) { return request("PUT", `${projectPath(scope)}/credentials/${MaterialRefSchema.parse(refId)}`, CredentialWriteSchema.parse(input), CredentialMetadataSchema, signal); },
    removeCredential(scope: ProjectRoute, refId: string, expectedVersion: string, signal: AbortSignal) { return request("DELETE", `${projectPath(scope)}/credentials/${MaterialRefSchema.parse(refId)}?expectedVersion=${AssetVersionSchema.parse(expectedVersion)}`, undefined, z.void(), signal); },
    listAttachments(scope: ProjectRoute, signal: AbortSignal) { return request("GET", `${projectPath(scope)}/attachments`, undefined, z.array(AttachmentMetadataSchema), signal); },
    putAttachment(scope: ProjectRoute, input: z.input<typeof AttachmentWriteSchema>, signal: AbortSignal) { return request("POST", `${projectPath(scope)}/attachments`, AttachmentWriteSchema.parse(input), AttachmentMetadataSchema, signal); },
    removeAttachment(scope: ProjectRoute, refId: string, expectedVersion: string, signal: AbortSignal) { return request("DELETE", `${projectPath(scope)}/attachments/${MaterialRefSchema.parse(refId)}?expectedVersion=${AssetVersionSchema.parse(expectedVersion)}`, undefined, z.void(), signal); },
  };
}

/** Agent identity has only a job/execution selector. Required refs come from the server assignment. */
export function createAgentMaterialsClient(options: HttpClientOptions) {
  const request = dataRequest(options);
  return { loadAssigned(jobId: string, executionId: string, signal: AbortSignal) {
    return request("POST", `runner/jobs/${EntityIdSchema.parse(jobId)}/materials`, { executionId: EntityIdSchema.parse(executionId) }, ProjectRunMaterialsSchema, signal);
  } };
}
