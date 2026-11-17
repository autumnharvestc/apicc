import { createHash } from "node:crypto";
import { decodeContractProjectFiles, encodeContractProjectFiles, type ContractProject } from "@apicc/core";
import { applyProjectSave } from "@apicc/core/collaboration/project-save";
import { createMemberExecutionRequest, ExecutionHttpError } from "@apicc/execution/client";
import { ProjectAssetsSchema, type AssetDelta, type ProjectAssets } from "@apicc/execution/contract";
import { projectAssetsManifestHash } from "@apicc/execution/host";
import type { OnlineAssetEditResult, OnlineAssetEditWrite, OnlineAssetSaveRejection, OnlineProjectView } from "../../shared/online/execution.js";
import { readOnlineProject } from "./projectAssets.js";
import type { OnlineSession } from "./session.js";

type Binding = ReturnType<OnlineSession["captureExecution"]>;
type Rejected = Extract<OnlineAssetEditResult, { status: "rejected" }>;
const reject = (reason: OnlineAssetSaveRejection): Rejected => ({ status: "rejected", reason });
const unknown: OnlineAssetEditResult = { status: "unknown" };
class IncompatibleProject extends Error {
  constructor(readonly reason: "identity" | "scope") { super(reason); }
}

function rejection(error: unknown): Rejected | undefined {
  if (error instanceof IncompatibleProject) return reject(error.reason);
  if (!(error instanceof ExecutionHttpError) || error.status < 400 || error.status >= 500 || error.status === 408) return;
  if (error.status === 401 || error.status === 403) return reject("authorization");
  if (error.status === 404 || error.status === 410) return reject("removed");
  if (error.code === "project_scope_conflict") return reject("scope");
  if (error.code === "contract_identity_conflict") return reject("identity");
  if (error.code === "legacy_project_layout" || error.code === "validation_failed") return reject("unsupported");
  if (error.status === 413 || error.status === 429 || error.code === "asset_change_limit" || error.code?.includes("quota")) return reject("quota");
  return reject("invalid");
}

async function verifiedProject(assets: ProjectAssets, input: OnlineAssetEditWrite): Promise<OnlineProjectView> {
  const scope = input.context.scope;
  if (assets.workspaceId !== scope.workspaceId || assets.groupId !== scope.groupId || assets.projectId !== scope.projectId) {
    throw new IncompatibleProject("scope");
  }
  if (assets.format === "contract-files-v1" && assets.contractProjectId !== input.contractProjectId
      || BigInt(assets.version) < BigInt(input.baseVersion)) throw new IncompatibleProject("identity");
  const seen = new Set<string>();
  for (const file of assets.files) {
    if (seen.has(file.path) || createHash("sha256").update(file.content).digest("hex") !== file.hash
        || Buffer.byteLength(file.content) !== file.size
        || assets.format === "contract-files-v1" && BigInt(file.version) > BigInt(assets.version)) {
      throw new Error("online-invalid-project-receipt");
    }
    seen.add(file.path);
  }
  if (projectAssetsManifestHash(assets.files) !== assets.manifestHash) throw new Error("online-invalid-project-receipt");
  return readOnlineProject(assets, input.context);
}

async function deltaFor(before: OnlineProjectView & { project: ContractProject }, next: ContractProject): Promise<AssetDelta | undefined> {
  const reference = encodeContractProjectFiles(before.project).files;
  const encoded = encodeContractProjectFiles(next).files;
  const changes = [...encoded].filter(([path, content]) => reference.get(path) !== content).map(([path, content]) => ({ path, content }));
  const deletes = [...reference.keys()].filter(path => !encoded.has(path));
  const files = new Map(before.assets.files.map(file => [file.path, file.content]));
  for (const path of deletes) files.delete(path);
  for (const file of changes) files.set(file.path, file.content);
  const validated = await decodeContractProjectFiles(files);
  if (!validated.project || validated.project.id !== next.id || validated.readOnly || validated.problems.length) return;
  return { format: "contract-files-v1", contractProjectId: next.id, expectedVersion: before.assets.version,
    expectedGroupId: before.assets.groupId, changes, deletes };
}

type Intent = { fingerprint: string; phase: "ready" | "unknown" | "saved" | "finished"; active?: Promise<OnlineAssetEditResult> };

export function createOnlineAssetEditor(fetcher?: typeof fetch) {
  const intents = new Map<string, Intent>();
  return function save(input: OnlineAssetEditWrite, binding: Binding, projectPath: string): Promise<OnlineAssetEditResult> {
    const key = JSON.stringify([input.context.serverId, input.context.ownerId, input.context.scope.workspaceId,
      input.context.scope.groupId, input.context.scope.projectId, input.contractProjectId, input.intentId]);
    const fingerprint = createHash("sha256").update(JSON.stringify([input.baseVersion, input.change])).digest("hex");
    let intent = intents.get(key);
    if (intent && intent.fingerprint !== fingerprint) return Promise.resolve(reject("intent"));
    if (intent?.active) return intent.active;
    if (input.verifyOnly && (!intent || intent.phase === "finished")) return Promise.resolve(reject("intent"));
    if (intent?.phase === "finished") return Promise.resolve(reject("intent"));
    if (intent?.phase === "unknown" && !input.verifyOnly) return Promise.resolve(unknown);
    if (!intent) {
      intent = { fingerprint, phase: "ready" };
      intents.set(key, intent);
    }
    const savedIntent = intent;
    const request = createMemberExecutionRequest(binding, fetcher);
    const path = `${projectPath}/assets`;
    const latest = async () => {
      const view = await verifiedProject(await request("GET", path, undefined, ProjectAssetsSchema), input);
      binding.assertCurrent();
      return view;
    };
    const proves = (view: OnlineProjectView) => {
      if (!view.project) return false;
      const result = applyProjectSave(view.project, input.change);
      return result.status === "ready" && !result.changed;
    };
    async function verify(): Promise<OnlineAssetEditResult> {
      try {
        const view = await latest();
        if (!proves(view)) return { status: "unknown", view };
        binding.assertCurrent();
        binding.invalidateTree();
        return { status: "saved", view, disposition: "recovered" };
      } catch (error) {
        const refusal = rejection(error);
        return refusal && ["authorization", "removed", "scope", "identity"].includes(refusal.reason)
          ? { status: "unknown", reason: refusal.reason } : unknown;
      }
    }
    async function submit(): Promise<OnlineAssetEditResult> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let before: OnlineProjectView;
        try { before = await latest(); }
        catch (error) { return rejection(error) ?? reject("unavailable"); }
        if (!before.project) return { status: "read-only", view: before };
        const decision = applyProjectSave(before.project, input.change);
        if (decision.status === "conflict") return { ...decision, view: before };
        if (!decision.changed) return { status: "saved", view: before, disposition: "converged" };
        const delta = await deltaFor({ ...before, project: before.project }, decision.project);
        if (!delta) return reject("invalid");
        try { binding.assertCurrent(); } catch { return reject("authorization"); }
        try {
          const receipt = await verifiedProject(await request("PUT", path, delta, ProjectAssetsSchema), input);
          if (BigInt(receipt.assets.version) <= BigInt(before.assets.version) || !proves(receipt)) throw new Error("online-unconfirmed-write");
          binding.assertCurrent();
          binding.invalidateTree();
          return { status: "saved", view: receipt, disposition: "written" };
        } catch (error) {
          if (error instanceof ExecutionHttpError && error.status === 409 && error.code === "version_conflict") {
            if (attempt === 0) continue;
            try { return { status: "busy", view: await latest() }; }
            catch (readError) { return rejection(readError) ?? { status: "busy" }; }
          }
          if (error instanceof ExecutionHttpError) {
            const refusal = rejection(error);
            if (refusal) return refusal;
          }
          savedIntent.phase = "unknown";
          return verify();
        }
      }
      return { status: "busy" };
    }
    const operation = input.verifyOnly || savedIntent.phase === "saved" ? verify : submit;
    savedIntent.active = operation().then(result => {
      if (result.status === "saved") savedIntent.phase = "saved";
      else if (result.status === "unknown" || savedIntent.phase === "unknown" || input.verifyOnly) savedIntent.phase = "unknown";
      else savedIntent.phase = "finished";
      return result;
    }).finally(() => { delete savedIntent.active; });
    return savedIntent.active;
  };
}
