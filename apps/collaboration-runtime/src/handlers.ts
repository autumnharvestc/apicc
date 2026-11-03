import { classifyAssetMutation, compileProjectMock, createProjectSnapshot, decodeContractProjectFiles, evaluateMock,
  projectPublication, validateSharedMock } from "@apicc/core/collaboration";
import { digestJson, operations, parsePayload, type Operation } from "./protocol.js";
import type { PlanCache } from "./cache.js";
import type { PublicationInput } from "@apicc/core/collaboration";

function uniqueFiles(files: readonly { path: string; content: string }[]) {
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("RPC_DUPLICATE_PATH");
  return new Map(files.map(file => [file.path, file.content]));
}
export async function handleOperation(operation: string, value: unknown, context?: { cache: PlanCache }): Promise<unknown> {
  if (!operations.includes(operation as Operation)) throw new Error("RPC_INVALID_REQUEST");
  switch (operation) {
    case "health": parsePayload("health", value); return { ready: true };
    case "project-document": { const { input, policy } = parsePayload("project-document", value); return projectPublication(input, policy); }
    case "project-report": {
      const { input, policy } = parsePayload("project-report", value);
      // The exported wire trace labels are strings; the existing model uses a
      // narrower union. Core still performs its own full source/report parsing.
      return projectPublication(input as PublicationInput, policy);
    }
    case "classify-asset-mutation": { const { beforeFiles, afterFiles } = parsePayload("classify-asset-mutation", value); return classifyAssetMutation(uniqueFiles(beforeFiles), uniqueFiles(afterFiles)); }
    case "compile-mock": {
      const { input, policy } = parsePayload("compile-mock", value);
      if (input.maxResponseBytes !== undefined && input.maxResponseBytes !== policy.maxResponseBytes) throw new Error("RPC_POLICY_MISMATCH");
      const files = uniqueFiles(input.files);
      const loaded = await decodeContractProjectFiles(files);
      if (!loaded.project || loaded.readOnly || loaded.problems.length) throw new Error("PUBLICATION_SOURCE_INVALID");
      const result = compileProjectMock(createProjectSnapshot(loaded.project), { maxResponseBytes: policy.maxResponseBytes });
      if (!result.ok) return result;
      const diagnostics = validateSharedMock(result.plan, policy);
      if (diagnostics.length) return { ok: false, diagnostics };
      context?.cache.put(digestJson(result.plan), result.plan);
      return result;
    }
    case "respond-mock": {
      const payload = parsePayload("respond-mock", value);
      const plan = "plan" in payload ? payload.plan : context?.cache.get(payload.planDigest);
      if (!plan) throw new Error("RPC_PLAN_UNAVAILABLE");
      const planDigest = digestJson(plan);
      if (payload.planDigest !== undefined && payload.planDigest !== planDigest) throw new Error("RPC_PLAN_DIGEST_MISMATCH");
      if (validateSharedMock(plan, payload.policy).length) throw new Error("RPC_PLAN_UNSAFE");
      context?.cache.put(planDigest, plan);
      const response = evaluateMock(plan, { ...payload.input, body: Uint8Array.from(payload.input.body) });
      return { ...response, body: Array.from(response.body) };
    }
  }
}
