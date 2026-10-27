import { prepareCredentialBindings, collectCredentialRefsForRequests, selectCredentialRequests, CredentialError, type CredentialBindings, type CredentialScope, type SecretStore } from "@apicc/core";
import { EntityIdSchema, ServerProjectScopeSchema, ProjectRunMaterialsSchema, ProjectRelativePathSchema, MaterialRefSchema, type MaterialSelection, type ProjectRunMaterials, type ServerProjectScope } from "../contract/index.js";
import { assertPreparedExecution, type PreparedExecution } from "./prepare.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface OnlineMaterialBinding {
  serverId: string; userId: string; scope: ServerProjectScope; contractScope: CredentialScope; snapshotId: string;
}
export type MaterialLoader = (binding: OnlineMaterialBinding, selection: MaterialSelection) => Promise<ProjectRunMaterials>;
export interface PreparedRunCredentials {
  readonly versions: Readonly<Record<string, string>>;
  start(): Promise<CredentialBindings>;
  dispose(): void;
}
export interface OnlineProjectSecretStore extends SecretStore { readonly onlineBinding: OnlineMaterialBinding }
function sameScope(left: CredentialScope, right: CredentialScope): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}
function fixedBinding(input: OnlineMaterialBinding): OnlineMaterialBinding {
  const server = new URL(input.serverId);
  if (server.protocol !== "https:" || server.username || server.password || server.search || server.hash) throw new Error("Online material scope requires a control HTTPS identity");
  const scope = Object.freeze(ServerProjectScopeSchema.parse(input.scope));
  const contractScope = Object.freeze({ workspaceId: input.contractScope.workspaceId, groupId: input.contractScope.groupId, projectId: input.contractScope.projectId });
  if (Object.values(contractScope).some(value => typeof value !== "string" || !value)) throw new Error("Missing contract credential scope");
  return Object.freeze({ serverId: server.href.replace(/\/$/, ""), userId: EntityIdSchema.parse(input.userId), snapshotId: EntityIdSchema.parse(input.snapshotId), scope, contractScope });
}
function materialError(error: unknown, ref: string): CredentialError {
  if (error instanceof CredentialError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new CredentialError(code === "credential_version_conflict" ? "CREDENTIAL_VERSION_CONFLICT" : code === "credential_missing" ? "CREDENTIAL_MISSING" : "CREDENTIAL_UNAVAILABLE", ref);
}
/** A remote-only, read-only SecretStore. It has no access to a desktop fallback. */
export function createOnlineProjectSecretStore(input: OnlineMaterialBinding, load: MaterialLoader): OnlineProjectSecretStore {
  const binding = fixedBinding(input);
  const get = async (scope: CredentialScope, ref: import("@apicc/core").SecretRef, expectedVersion?: string) => {
    if (!sameScope(scope, binding.contractScope)) throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
    if (ref.policy !== "test-auto") throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
    try {
      MaterialRefSchema.parse(ref.id);
      const batch = ProjectRunMaterialsSchema.parse(await load(binding, { projectId: binding.scope.projectId, credentials: [{ refId: ref.id, ...(expectedVersion === undefined ? {} : { version: expectedVersion }) }], attachments: [] }));
      if (batch.snapshotId !== binding.snapshotId || !sameScope(batch.scope, binding.scope)) throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
      // Agent loaders return the authoritative task bundle. Bind only this requested ref from it.
      const matches = batch.credentials.filter(value => value.refId === ref.id);
      if (!matches.length) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      if (matches.length !== 1) throw new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
      const value = matches[0]!;
      if (expectedVersion !== undefined && value.version !== expectedVersion) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      return value;
    } catch (error) { throw materialError(error, ref.id); }
  };
  return Object.freeze({ onlineBinding: binding,
    async put(_scope: CredentialScope, ref: import("@apicc/core").SecretRef) { throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id); },
    async remove(_scope: CredentialScope, ref: import("@apicc/core").SecretRef) { throw new CredentialError("CREDENTIAL_REMOVE_FAILED", ref.id); },
    async resolve(scope: CredentialScope, ref: import("@apicc/core").SecretRef, expected?: string) { return (await get(scope, ref, expected)).value; },
    async version(scope: CredentialScope, ref: import("@apicc/core").SecretRef) { return (await get(scope, ref)).version; },
    async status(scope: CredentialScope, ref: import("@apicc/core").SecretRef) { try { await get(scope, ref); return "available" as const; } catch (error) { return error instanceof CredentialError && error.code === "CREDENTIAL_MISSING" ? "missing" as const : "unavailable" as const; } },
  });
}
export async function prepareRunCredentials(prepared: PreparedExecution, binding: OnlineMaterialBinding, store: SecretStore): Promise<PreparedRunCredentials> {
  assertPreparedExecution(prepared);
  const fixed = fixedBinding(binding);
  const owned = (store as Partial<OnlineProjectSecretStore>).onlineBinding;
  if (!owned || owned.serverId !== fixed.serverId || owned.userId !== fixed.userId || owned.snapshotId !== fixed.snapshotId || !sameScope(owned.scope, fixed.scope) || !sameScope(owned.contractScope, fixed.contractScope) || prepared.snapshot.project.id !== fixed.contractScope.projectId) throw new CredentialError("CREDENTIAL_UNAVAILABLE", "");
  const refs = collectCredentialRefsForRequests(prepared.snapshot.project, selectCredentialRequests(prepared.snapshot, prepared.selections));
  // Only versions survive preparation. Start performs the final authorized resolution.
  const versions = (await prepareCredentialBindings(fixed.contractScope, refs, store)).versions;
  let disposed = false; let started = false; const values = new Map<string, string>();
  return Object.freeze({ versions,
    async start() {
      if (disposed || started) throw new CredentialError("CREDENTIAL_UNAVAILABLE", "");
      started = true;
      const resolved = await prepareCredentialBindings(fixed.contractScope, refs, store, versions);
      if (disposed) throw new CredentialError("CREDENTIAL_UNAVAILABLE", "");
      for (const ref of refs) values.set(ref.id, resolved.resolve(ref));
      return Object.freeze({ versions, resolve(ref: import("@apicc/core").SecretRef) {
        if (disposed || !values.has(ref.id)) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
        if (ref.policy !== "test-auto") throw new CredentialError("CREDENTIAL_POLICY_UNSUPPORTED", ref.id);
        return values.get(ref.id)!;
      } });
    },
    dispose() { disposed = true; values.clear(); },
  });
}
/** Put the entire Core invocation inside this lifetime; cleanup also covers start/invocation failures. */
export async function withRunCredentials<T>(materials: PreparedRunCredentials, action: (bindings: CredentialBindings) => Promise<T>): Promise<T> {
  try { return await action(await materials.start()); } finally { materials.dispose(); }
}
/** Core file-loader seam. Paths can resolve only through the fixed task declaration. No filesystem fallback. */
export function createDeclaredAttachmentReader(input: ProjectRunMaterials, declared: Readonly<Record<string, { refId: string; version: string; hash: string }>>) {
  const materials = ProjectRunMaterialsSchema.parse(input); const mapping = structuredClone(declared);
  return async (path: string): Promise<Uint8Array> => {
    ProjectRelativePathSchema.parse(path);
    const selected = Object.hasOwn(mapping, path) ? mapping[path] : undefined;
    const matching = selected && materials.attachments.filter(item => item.refId === selected.refId);
    if (!matching || matching.length !== 1) throw new Error("Undeclared or duplicate attachment");
    const attachment = matching[0]!;
    if (attachment.version !== selected!.version || attachment.hash !== selected!.hash) throw new Error("Attachment version/hash changed; prepare again");
    const bytes = Buffer.from(attachment.contentBase64, "base64");
    if (bytes.toString("base64") !== attachment.contentBase64 || bytes.length !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.hash) throw new Error("Attachment digest/bytes mismatch");
    return bytes;
  };
}

export interface DeclaredInputFiles { readonly workspaceRoot: string; pathFor(path: string): string }
/** Keep this callback alive until every Core consumer has finished with its ordinary files. */
export async function withDeclaredInputFiles<T>(materials: ProjectRunMaterials, declared: Readonly<Record<string, { refId: string; version: string; hash: string }>>, limits: { totalInputBytes: number; minFreeDiskBytes: number }, action: (files: DeclaredInputFiles) => Promise<T>): Promise<T> {
  if (![limits.totalInputBytes, limits.minFreeDiskBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid input material byte limits");
  const read = createDeclaredAttachmentReader(materials, declared);
  const checked: Array<{ path: string; bytes: Uint8Array }> = []; let total = 0;
  for (const path of Object.keys(declared)) {
    const bytes = await read(path);
    if (bytes.length > limits.totalInputBytes - total) throw new Error("Declared input materials exceed total input bytes");
    total += bytes.length; checked.push({ path, bytes });
  }
  // A fresh directory owns all staged paths; no developer-machine root or path is read.
  const workspaceRoot = await mkdtemp(join(tmpdir(), "apicc-run-materials-"));
  const paths = new Map<string, string>(); let active = true;
  const checkSpace = async (remaining: number) => {
    const disk = await statfs(workspaceRoot, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(limits.minFreeDiskBytes) + BigInt(remaining)) throw new Error("Insufficient free disk for declared input materials");
  };
  try {
    let remaining = total;
    for (const file of checked) {
      const target = resolve(workspaceRoot, file.path);
      const inside = relative(workspaceRoot, target);
      if (!inside || inside.startsWith("..") || /^[A-Za-z]:/.test(inside)) throw new Error("Invalid declared input path");
      await checkSpace(remaining);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 });
      remaining -= file.bytes.length; paths.set(file.path, target);
    }
    if (!checked.length) await checkSpace(0);
    return await action(Object.freeze({ workspaceRoot, pathFor(path: string) {
      ProjectRelativePathSchema.parse(path);
      const target = paths.get(path);
      if (!active || !target) throw new Error("Declared input file is unavailable");
      return target;
    } }));
  } finally {
    active = false;
    // Only this invocation's freshly created directory is removed, after its consumers settle.
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
