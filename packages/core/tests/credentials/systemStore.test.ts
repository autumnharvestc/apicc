import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsHooks = vi.hoisted(() => ({ failNextRename: false }));
const nativeHooks = vi.hoisted(() => ({
  rejectGetPassword: false,
  getPasswordResult: null as unknown,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (source: Parameters<typeof actual.rename>[0], destination: Parameters<typeof actual.rename>[1]) => {
      if (fsHooks.failNextRename) {
        fsHooks.failNextRename = false;
        throw new Error("synthetic index commit failure");
      }
      return actual.rename(source, destination);
    },
  };
});

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    async getPassword() {
      if (nativeHooks.rejectGetPassword) throw new Error("synthetic native read rejection");
      return nativeHooks.getPasswordResult;
    }
    async setPassword() {}
    async deleteCredential() { return true; }
  },
}));

interface CredentialScope {
  workspaceId: string;
  groupId: string;
  projectId: string;
}

interface SecretRef {
  id: string;
  policy: string;
}

interface CredentialBackend {
  getPassword(service: string, account: string): Promise<unknown>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deleteCredential(service: string, account: string): Promise<boolean>;
}

interface SecretStore {
  put(scope: CredentialScope, ref: SecretRef, value: string): Promise<void>;
  resolve(scope: CredentialScope, ref: SecretRef, expectedVersion?: string): Promise<string>;
  version(scope: CredentialScope, ref: SecretRef): Promise<string>;
  remove(scope: CredentialScope, ref: SecretRef): Promise<void>;
  status(scope: CredentialScope, ref: SecretRef): Promise<"available" | "missing" | "unavailable">;
}

interface SystemStoreModule {
  createSystemSecretStore(options: {
    privateRoot: string;
    loadBackend?: () => Promise<CredentialBackend>;
  }): SecretStore;
}

interface PrivateIndexLockModule {
  credentialIndexPath(privateRoot: string, scope: CredentialScope, refId: string): string;
  withCredentialLock<T>(
    privateRoot: string,
    scope: CredentialScope,
    refId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

interface CredentialBindingsModule {
  prepareCredentialBindings(
    scope: CredentialScope,
    refs: readonly SecretRef[],
    store: SecretStore,
    expectedVersions?: Readonly<Record<string, string>>,
  ): Promise<{ resolve(ref: SecretRef): string; readonly versions: Readonly<Record<string, string>> }>;
}

const scope: CredentialScope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  groupId: "55555555-5555-4555-8555-555555555555",
  projectId: "22222222-2222-4222-8222-222222222222",
};
const otherGroupScope: CredentialScope = { ...scope, groupId: "66666666-6666-4666-8666-666666666666" };
const ref: SecretRef = { id: "33333333-3333-4333-8333-333333333333", policy: "test-auto" };
const systemStoreModuleUrl = new URL("../../src/credentials/systemStore.ts", import.meta.url).href;
const privateIndexModuleUrl = new URL("../../src/credentials/privateIndex.ts", import.meta.url).href;
const credentialBindingsModuleUrl = new URL("../../src/credentials/bindings.ts", import.meta.url).href;
let privateRoot = "";

async function loadSystemStoreModule(): Promise<SystemStoreModule> {
  const loaded = await import(systemStoreModuleUrl).catch(() => null);
  expect(loaded, "system credential store should be implemented before the behavior tests run").not.toBeNull();
  return loaded as SystemStoreModule;
}

async function loadPrivateIndexLockModule(): Promise<PrivateIndexLockModule> {
  const loaded = await import(privateIndexModuleUrl).catch(() => null);
  expect(loaded, "private credential index should export its lock before lock behavior tests run").not.toBeNull();
  return loaded as PrivateIndexLockModule;
}

async function loadCredentialBindingsModule(): Promise<CredentialBindingsModule> {
  const loaded = await import(credentialBindingsModuleUrl).catch(() => null);
  expect(loaded, "credential bindings should be implemented before the behavior tests run").not.toBeNull();
  return loaded as CredentialBindingsModule;
}

function makeBackend() {
  const values = new Map<string, unknown>();
  const key = (service: string, account: string) => `${service}\n${account}`;
  const backend: CredentialBackend = {
    async getPassword(service, account) { return values.get(key(service, account)) ?? null; },
    async setPassword(service, account, password) { values.set(key(service, account), password); },
    async deleteCredential(service, account) { return values.delete(key(service, account)); },
  };
  return { backend, values, key };
}

async function indexContents(root: string): Promise<string[]> {
  const contents: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) contents.push(await readFile(path, "utf8"));
    }
  }
  await visit(root);
  return contents;
}

async function makeTemporaryRootAtLeast(minimumLength: number): Promise<string> {
  const prefixLength = Math.max(1, minimumLength - tmpdir().length - 7);
  return mkdtemp(join(tmpdir(), "r".repeat(prefixLength)));
}

describe("createSystemSecretStore", () => {
  beforeEach(async () => {
    fsHooks.failNextRename = false;
    nativeHooks.rejectGetPassword = false;
    nativeHooks.getPasswordResult = null;
    privateRoot = await mkdtemp(join(tmpdir(), "apicc-credentials-test-"));
  });

  afterEach(async () => {
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
    privateRoot = "";
  });

  it("stores a verified generation and resolves it after reopening without putting the value in the index", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const loadBackend = vi.fn(async () => fake.backend);
    const store = createSystemSecretStore({ privateRoot, loadBackend });
    const syntheticValue = "synthetic-value-never-in-index";

    expect(loadBackend).not.toHaveBeenCalled();
    await store.put(scope, ref, syntheticValue);
    const generation = await store.version(scope, ref);
    expect(generation).toMatch(/^[0-9a-f-]{36}$/i);
    expect(generation).not.toContain(syntheticValue);
    expect(await store.status(scope, ref)).toBe("available");

    const storedIndex = (await indexContents(privateRoot)).join("\n");
    expect(storedIndex).not.toContain(syntheticValue);
    expect(storedIndex).toContain(generation);

    const reopened = createSystemSecretStore({ privateRoot, loadBackend });
    await expect(reopened.resolve(scope, ref, generation)).resolves.toBe(syntheticValue);
    expect(await reopened.version(scope, ref)).toBe(generation);

    await reopened.put(scope, ref, "replacement-synthetic-value");
    const replacementGeneration = await reopened.version(scope, ref);
    expect(replacementGeneration).not.toBe(generation);
    await expect(reopened.resolve(scope, ref, generation))
      .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: ref.id });
    await expect(reopened.resolve(scope, ref)).resolves.toBe("replacement-synthetic-value");
  });

  it("isolates the same project and ref across groups, workspaces, and projects", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    const otherWorkspaceScope = { ...scope, workspaceId: "77777777-7777-4777-8777-777777777777" };
    const otherProjectScope = { ...scope, projectId: "88888888-8888-4888-8888-888888888888" };
    const independentScopes = [otherGroupScope, otherWorkspaceScope, otherProjectScope] as const;
    const values = ["group-b-synthetic", "workspace-b-synthetic", "project-b-synthetic"] as const;

    await store.put(scope, ref, "group-a-synthetic");
    const originalVersion = await store.version(scope, ref);
    for (const [index, independentScope] of independentScopes.entries()) {
      await store.put(independentScope, ref, values[index]!);
    }

    const reopened = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    expect(await reopened.resolve(scope, ref)).toBe("group-a-synthetic");
    expect(await reopened.version(scope, ref)).toBe(originalVersion);
    for (const [index, independentScope] of independentScopes.entries()) {
      expect(await reopened.resolve(independentScope, ref)).toBe(values[index]);
      expect(await reopened.status(independentScope, ref)).toBe("available");
    }
    const otherGroupVersion = await reopened.version(otherGroupScope, ref);

    await reopened.put(scope, ref, "group-a-replacement-synthetic");
    expect(await reopened.resolve(scope, ref)).toBe("group-a-replacement-synthetic");
    await expect(reopened.resolve(scope, ref, originalVersion))
      .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: ref.id });
    expect(await reopened.resolve(otherGroupScope, ref)).toBe("group-b-synthetic");
    expect(await reopened.version(otherGroupScope, ref)).toBe(otherGroupVersion);
    await reopened.remove(scope, ref);
    expect(await reopened.status(scope, ref)).toBe("missing");
    expect(await reopened.status(otherGroupScope, ref)).toBe("available");
    expect(await reopened.resolve(otherGroupScope, ref)).toBe("group-b-synthetic");
    expect(await reopened.version(otherGroupScope, ref)).toBe(otherGroupVersion);
    await reopened.remove(otherGroupScope, ref);
    expect(await reopened.status(otherGroupScope, ref)).toBe("missing");
    expect(await reopened.status(independentScopes[1], ref)).toBe("available");
    expect(await reopened.status(independentScopes[2], ref)).toBe("available");
  });

  it("keeps case-distinct UUID text independent in every scope field", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    const lowerScope: CredentialScope = {
      workspaceId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      groupId: "fedcbafe-dcba-4fed-8cba-fedcbafedcba",
      projectId: "faceb00c-face-4ace-8ace-faceb00cface",
    };
    const logicalRef = { id: "case-preservation", policy: "test-auto" };

    for (const field of ["workspaceId", "groupId", "projectId"] as const) {
      const upperScope = { ...lowerScope, [field]: lowerScope[field].toUpperCase() };
      const lowerValue = `${field}-lower-synthetic`;
      const upperValue = `${field}-upper-synthetic`;
      const upperReplacement = `${field}-upper-replacement-synthetic`;

      await store.put(lowerScope, logicalRef, lowerValue);
      const lowerVersion = await store.version(lowerScope, logicalRef);
      await store.put(upperScope, logicalRef, upperValue);
      const upperVersion = await store.version(upperScope, logicalRef);

      expect(await store.resolve(lowerScope, logicalRef)).toBe(lowerValue);
      expect(await store.resolve(upperScope, logicalRef)).toBe(upperValue);
      expect(await store.version(lowerScope, logicalRef)).toBe(lowerVersion);
      expect(upperVersion).not.toBe(lowerVersion);

      await store.put(upperScope, logicalRef, upperReplacement);
      expect(await store.resolve(lowerScope, logicalRef)).toBe(lowerValue);
      expect(await store.resolve(upperScope, logicalRef)).toBe(upperReplacement);

      await store.remove(lowerScope, logicalRef);
      expect(await store.status(lowerScope, logicalRef)).toBe("missing");
      expect(await store.resolve(upperScope, logicalRef)).toBe(upperReplacement);
      await store.remove(upperScope, logicalRef);
      expect(await store.status(upperScope, logicalRef)).toBe("missing");
    }
  });

  it.each([
    ["UUID control", "33333333-3333-4333-8333-333333333333", undefined],
    ["ordinary ASCII identifier", "api-production-backend-authentication-token", undefined],
    ["ordinary Chinese identifier", "开发环境接口自动认证凭据测试引用标识", undefined],
    ["fresh OAuth client-secret smoke ref", "f2b-smoke-client-secret-00000000-0000-4000-8000-000000000000", 67],
  ] as const)("round-trips %s through the shared-root-length index", async (_kind, id, minimumPrivateRootLength) => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const { credentialIndexPath } = await loadPrivateIndexLockModule();
    const fake = makeBackend();
    const minimumRootLength = minimumPrivateRootLength
      ?? join(homedir(), ".apicc", "private", "test-credentials", "v1").length;
    const longRoot = await makeTemporaryRootAtLeast(minimumRootLength);
    const logicalRef = { id, policy: "test-auto" };

    try {
      expect(longRoot.length).toBeGreaterThanOrEqual(minimumRootLength);
      if (minimumPrivateRootLength !== undefined) {
        const lockDbPath = `${credentialIndexPath(longRoot, scope, id)}.lock.sqlite`;
        expect(lockDbPath.length).toBeGreaterThanOrEqual(252);
        expect(`${lockDbPath}-journal`.length).toBeGreaterThanOrEqual(260);
      }
      const store = createSystemSecretStore({ privateRoot: longRoot, loadBackend: async () => fake.backend });
      const firstValue = `${_kind}-initial-synthetic`;
      await store.put(scope, logicalRef, firstValue);
      const firstVersion = await store.version(scope, logicalRef);
      expect(await store.resolve(scope, logicalRef)).toBe(firstValue);
      expect(await store.status(scope, logicalRef)).toBe("available");

      const replacementValue = `${_kind}-replacement-synthetic`;
      await store.put(scope, logicalRef, replacementValue);
      const replacementVersion = await store.version(scope, logicalRef);
      expect(replacementVersion).not.toBe(firstVersion);

      const reopened = createSystemSecretStore({ privateRoot: longRoot, loadBackend: async () => fake.backend });
      expect(await reopened.resolve(scope, logicalRef)).toBe(replacementValue);
      expect(await reopened.version(scope, logicalRef)).toBe(replacementVersion);
      expect(await reopened.status(scope, logicalRef)).toBe("available");
      await reopened.remove(scope, logicalRef);
      expect(await reopened.status(scope, logicalRef)).toBe("missing");
      const reopenedAfterRemove = createSystemSecretStore({ privateRoot: longRoot, loadBackend: async () => fake.backend });
      expect(await reopenedAfterRemove.status(scope, logicalRef)).toBe("missing");
    } finally {
      await rm(longRoot, { recursive: true, force: true });
    }
  });

  it("keeps prepared bindings fixed across group writes and rejects stale own-group expectations", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const { prepareCredentialBindings } = await loadCredentialBindingsModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });

    await store.put(scope, ref, "group-a-before-synthetic");
    const beforeVersion = await store.version(scope, ref);
    const oldBindings = await prepareCredentialBindings(scope, [ref], store, { [ref.id]: beforeVersion });
    await store.put(otherGroupScope, ref, "group-b-synthetic");

    expect(oldBindings.resolve(ref)).toBe("group-a-before-synthetic");
    expect(oldBindings.versions).toEqual({ [ref.id]: beforeVersion });
    expect(await store.resolve(otherGroupScope, ref)).toBe("group-b-synthetic");
    expect(await store.version(scope, ref)).toBe(beforeVersion);

    await store.put(scope, ref, "group-a-after-synthetic");
    expect(oldBindings.resolve(ref)).toBe("group-a-before-synthetic");
    await expect(prepareCredentialBindings(scope, [ref], store, { [ref.id]: beforeVersion }))
      .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: ref.id });
    const currentVersion = await store.version(scope, ref);
    const currentBindings = await prepareCredentialBindings(scope, [ref], store, { [ref.id]: currentVersion });
    expect(currentBindings.resolve(ref)).toBe("group-a-after-synthetic");
    expect(currentBindings.versions).toEqual({ [ref.id]: currentVersion });
    expect(await store.resolve(otherGroupScope, ref)).toBe("group-b-synthetic");
  });

  it("round-trips exact logical ref strings without using them as paths or account delimiters", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    const refIds = ["", "Case", "case", ".", "..", "a/b", "a\\b", "a:b", "../outside", "\0", "é", "😃", "\ud800", "\ufffd"];

    for (const [index, id] of refIds.entries()) {
      const logicalRef = { id, policy: "test-auto" };
      await store.put(scope, logicalRef, `logical-value-${index}`);
    }

    for (const [index, id] of refIds.entries()) {
      const logicalRef = { id, policy: "test-auto" };
      expect(await store.resolve(scope, logicalRef)).toBe(`logical-value-${index}`);
      expect(await store.status(scope, logicalRef)).toBe("available");
    }

    const accountNames = [...fake.values.keys()].map((key) => key.slice(key.indexOf("\n") + 1));
    expect(new Set(accountNames).size).toBe(refIds.length);
    expect(accountNames.every((account) => account.startsWith("ref:r"))).toBe(true);
    const caseGeneration = await store.version(scope, { id: "Case", policy: "test-auto" });
    expect(fake.values.has(fake.key(
      "apicc:credentials:v2:ag%bwvi{h2%'e@!m77%=%ok'f(3p:a7vg_;+)#1x[+'9b,68&4;24m5&~:anuc+(r^o~vo3s9_weydiia$v`r&",
      `ref:r$ase:generation:${caseGeneration}`,
    ))).toBe(true);
  });

  it("accepts NIL, MAX, and uppercase hexadecimal UUID scope values", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    const permissiveScope: CredentialScope = {
      workspaceId: "00000000-0000-0000-0000-000000000000",
      groupId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      projectId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
    };
    const logicalRef = { id: "scope-domain", policy: "test-auto" };

    await store.put(permissiveScope, logicalRef, "uuid-domain-synthetic");

    await expect(store.resolve(permissiveScope, logicalRef)).resolves.toBe("uuid-domain-synthetic");
    expect(await store.status(permissiveScope, logicalRef)).toBe("available");
  });

  it("does not load the native backend for absent credentials or idempotent removal", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const { prepareCredentialBindings } = await loadCredentialBindingsModule();
    const loadBackend = vi.fn(async () => { throw new Error("native backend must remain lazy"); });
    const store = createSystemSecretStore({ privateRoot, loadBackend });

    const emptyBindings = await prepareCredentialBindings(scope, [], store);
    expect(emptyBindings.versions).toEqual({});
    await expect(store.status(scope, ref)).resolves.toBe("missing");
    await expect(store.remove(scope, ref)).resolves.toBeUndefined();
    await expect(store.resolve(scope, ref)).rejects.toMatchObject({ code: "CREDENTIAL_MISSING", refId: ref.id });
    expect(loadBackend).not.toHaveBeenCalled();
  });

  it("rejects unknown policies and malformed three-field scopes before loading the provider", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const loadBackend = vi.fn(async () => { throw new Error("unsupported input reached backend"); });
    const store = createSystemSecretStore({ privateRoot, loadBackend });

    await expect(store.put(scope, { ...ref, policy: "strict-future-policy" }, "synthetic-value"))
      .rejects.toMatchObject({ code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: ref.id });
    await expect(store.status({ ...scope, groupId: "not-a-uuid" }, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_FORMAT_UNSUPPORTED", refId: ref.id });
    const missingGroup = { workspaceId: scope.workspaceId, projectId: scope.projectId } as CredentialScope;
    await expect(store.status(missingGroup, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_FORMAT_UNSUPPORTED", refId: ref.id });
    await expect(store.status(null as unknown as CredentialScope, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_FORMAT_UNSUPPORTED" });
    await expect(store.status(scope, null as unknown as SecretRef))
      .rejects.toMatchObject({ code: "CREDENTIAL_FORMAT_UNSUPPORTED" });
    expect(loadBackend).not.toHaveBeenCalled();
  });

  it("does not inspect, adopt, or delete legacy v1 index pointers", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const legacyPath = join(privateRoot, "apicc", "credentials-v1", scope.workspaceId, scope.projectId, `${ref.id}.json`);
    await mkdir(dirname(legacyPath), { recursive: true });
    const legacyPointer = JSON.stringify({
      formatVersion: 1,
      refId: ref.id,
      generation: "33333333-3333-4333-8333-333333333333",
      policy: "test-auto",
      version: "33333333-3333-4333-8333-333333333333",
    });
    await writeFile(legacyPath, legacyPointer, "utf8");
    const loadBackend = vi.fn(async () => { throw new Error("legacy pointers must remain untouched"); });
    const store = createSystemSecretStore({ privateRoot, loadBackend });

    await expect(store.status(scope, ref)).resolves.toBe("missing");
    await expect(store.resolve(scope, ref)).rejects.toMatchObject({ code: "CREDENTIAL_MISSING", refId: ref.id });
    expect(loadBackend).not.toHaveBeenCalled();
    await expect(readFile(legacyPath, "utf8")).resolves.toBe(legacyPointer);
  });

  it("keeps the old active generation when native save or candidate read-back validation fails", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await store.put(scope, ref, "old-synthetic");
    const oldGeneration = await store.version(scope, ref);

    vi.spyOn(fake.backend, "setPassword").mockRejectedValueOnce(new Error("native save failed"));
    await expect(store.put(scope, ref, "failed-save-synthetic"))
      .rejects.toMatchObject({ code: "CREDENTIAL_SAVE_FAILED", refId: ref.id });
    expect(await store.version(scope, ref)).toBe(oldGeneration);
    await expect(store.resolve(scope, ref)).resolves.toBe("old-synthetic");

    vi.spyOn(fake.backend, "getPassword").mockResolvedValueOnce(JSON.stringify({
      formatVersion: 1,
      policy: "test-auto",
      value: "not-the-candidate",
    }));
    await expect(store.put(scope, ref, "failed-validation-synthetic"))
      .rejects.toMatchObject({ code: "CREDENTIAL_SAVE_FAILED", refId: ref.id });
    expect(await store.version(scope, ref)).toBe(oldGeneration);
    await expect(store.resolve(scope, ref)).resolves.toBe("old-synthetic");

    vi.spyOn(fake.backend, "getPassword").mockResolvedValueOnce(JSON.stringify({
      formatVersion: 99,
      policy: "test-auto",
      value: "malformed-read-back-synthetic",
    }));
    await expect(store.put(scope, ref, "failed-format-validation-synthetic"))
      .rejects.toMatchObject({ code: "CREDENTIAL_SAVE_FAILED", refId: ref.id });
    expect(await store.version(scope, ref)).toBe(oldGeneration);
    await expect(store.resolve(scope, ref)).resolves.toBe("old-synthetic");
  });

  it("keeps the previous active entry when the atomic index pointer commit fails", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await store.put(scope, ref, "old-synthetic");
    const oldGeneration = await store.version(scope, ref);

    fsHooks.failNextRename = true;
    await expect(store.put(scope, ref, "uncommitted-synthetic"))
      .rejects.toMatchObject({ code: "CREDENTIAL_SAVE_FAILED", refId: ref.id });
    expect(await store.version(scope, ref)).toBe(oldGeneration);
    await expect(store.resolve(scope, ref)).resolves.toBe("old-synthetic");
  });

  it("keeps the active binding when system deletion fails", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await store.put(scope, ref, "active-synthetic");
    const activeGeneration = await store.version(scope, ref);

    vi.spyOn(fake.backend, "deleteCredential").mockRejectedValueOnce(new Error("native delete failed"));
    await expect(store.remove(scope, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_REMOVE_FAILED", refId: ref.id });
    expect(await store.version(scope, ref)).toBe(activeGeneration);
    await expect(store.resolve(scope, ref)).resolves.toBe("active-synthetic");

    vi.spyOn(fake.backend, "deleteCredential").mockResolvedValueOnce("invalid" as unknown as boolean);
    await expect(store.remove(scope, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_REMOVE_FAILED", refId: ref.id });
    expect(await store.version(scope, ref)).toBe(activeGeneration);
    await expect(store.resolve(scope, ref)).resolves.toBe("active-synthetic");
  });

  it("reports an unavailable backend for an indexed credential without exposing backend errors", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    await createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend })
      .put(scope, ref, "unavailable-synthetic");
    const unavailable = createSystemSecretStore({
      privateRoot,
      loadBackend: async () => { throw new Error("backend error must not escape"); },
    });

    await expect(unavailable.status(scope, ref)).resolves.toBe("unavailable");
    await expect(unavailable.resolve(scope, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE", refId: ref.id });
  });

  it("normalizes default native read rejection as unavailable but keeps malformed values as READ_FAILED", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    await createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend })
      .put(scope, ref, "native-boundary-synthetic");

    nativeHooks.rejectGetPassword = true;
    const nativeUnavailable = createSystemSecretStore({ privateRoot });
    await expect(nativeUnavailable.status(scope, ref)).resolves.toBe("unavailable");
    const nativeError = await nativeUnavailable.resolve(scope, ref).catch((error: unknown) => error);
    expect(nativeError).toMatchObject({ code: "CREDENTIAL_UNAVAILABLE", refId: ref.id });
    expect(String(nativeError)).not.toContain("synthetic native read rejection");

    nativeHooks.rejectGetPassword = false;
    nativeHooks.getPasswordResult = 17;
    const malformedNativeResult = createSystemSecretStore({ privateRoot });
    await expect(malformedNativeResult.status(scope, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_READ_FAILED", refId: ref.id });
    await expect(malformedNativeResult.resolve(scope, ref))
      .rejects.toMatchObject({ code: "CREDENTIAL_READ_FAILED", refId: ref.id });
    nativeHooks.getPasswordResult = null;
  });

  it("treats only null and undefined as missing, and reports other non-string backend values as READ_FAILED", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await store.put(scope, ref, "read-boundary-synthetic");

    vi.spyOn(fake.backend, "getPassword").mockResolvedValueOnce(null);
    await expect(store.status(scope, ref)).resolves.toBe("missing");
    vi.spyOn(fake.backend, "getPassword").mockResolvedValueOnce(undefined);
    await expect(store.status(scope, ref)).resolves.toBe("missing");
    vi.spyOn(fake.backend, "getPassword").mockResolvedValueOnce(17);
    await expect(store.resolve(scope, ref)).rejects.toMatchObject({ code: "CREDENTIAL_READ_FAILED", refId: ref.id });
  });

  it("distinguishes unsupported stored envelopes from a missing entry", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await store.put(scope, ref, "format-check-synthetic");

    vi.spyOn(fake.backend, "getPassword").mockResolvedValueOnce(JSON.stringify({
      formatVersion: 99,
      policy: "test-auto",
      value: "format-check-synthetic",
    }));
    await expect(store.resolve(scope, ref)).rejects.toMatchObject({ code: "CREDENTIAL_FORMAT_UNSUPPORTED", refId: ref.id });
  });

  it("commits removal only after deleting the active system entry and remains missing after reopening", async () => {
    const { createSystemSecretStore } = await loadSystemStoreModule();
    const fake = makeBackend();
    const store = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await store.put(scope, ref, "remove-synthetic");
    const oldGeneration = await store.version(scope, ref);

    await expect(store.remove(scope, ref)).resolves.toBeUndefined();
    const reopened = createSystemSecretStore({ privateRoot, loadBackend: async () => fake.backend });
    await expect(reopened.status(scope, ref)).resolves.toBe("missing");
    await expect(reopened.resolve(scope, ref, oldGeneration))
      .rejects.toMatchObject({ code: "CREDENTIAL_MISSING", refId: ref.id });
    await expect(reopened.remove(scope, ref)).resolves.toBeUndefined();
  });

  it("waits for a live child process SQLite writer on a smoke-length path and re-enters after it exits", async () => {
    const { credentialIndexPath, withCredentialLock } = await loadPrivateIndexLockModule();
    const previousPrivateRoot = privateRoot;
    privateRoot = await makeTemporaryRootAtLeast(67);
    await rm(previousPrivateRoot, { recursive: true, force: true });
    const longRef = { id: "f2b-smoke-client-secret-00000000-0000-4000-8000-000000000000", policy: "test-auto" };
    const lockDbPath = `${credentialIndexPath(privateRoot, scope, longRef.id)}.lock.sqlite`;
    expect(lockDbPath.length).toBeGreaterThanOrEqual(252);
    expect(`${lockDbPath}-journal`.length).toBeGreaterThanOrEqual(260);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(lockDbPath), { recursive: true }));

    const childSource = [
      "import { DatabaseSync } from 'node:sqlite';",
      "import path from 'node:path';",
      "const db = new DatabaseSync(path.toNamespacedPath(process.argv[1]));",
      "db.exec('PRAGMA busy_timeout=0');",
      "db.exec('BEGIN IMMEDIATE');",
      "process.stdout.write('LOCK_HELD\\n');",
      "process.stdin.resume();",
      "process.stdin.once('data', () => process.exit(0));",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, lockDbPath], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let childStdout = "";
    let childStderr = "";
    let signalReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const childReady = new Promise<void>((resolveReady, rejectReadyPromise) => {
      signalReady = resolveReady;
      rejectReady = rejectReadyPromise;
    });
    let signalExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      signalExit = resolveExit;
    });
    let childHasExited = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      childStdout += chunk;
      if (childStdout.includes("LOCK_HELD")) signalReady();
    });
    child.stderr.on("data", (chunk: string) => { childStderr += chunk; });
    child.once("error", (error) => rejectReady(error));
    child.once("exit", (code, signal) => {
      childHasExited = true;
      signalExit({ code, signal });
    });

    let contender: Promise<string> | undefined;
    try {
      await Promise.race([
        childReady,
        delay(5_000).then(() => { throw new Error("child did not acquire the SQLite test lock"); }),
      ]);
      let entered = false;
      contender = withCredentialLock(privateRoot, scope, longRef.id, async () => {
        entered = true;
        return "contender-entered";
      });
      await delay(100);
      expect(entered).toBe(false);

      child.stdin.write("release\n");
      const exit = await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error("owned SQLite child did not exit"); }),
      ]);
      expect(exit).toEqual({ code: 0, signal: null });
      await expect(contender).resolves.toBe("contender-entered");
      expect(entered).toBe(true);
      if (process.versions.node.startsWith("22.")) expect(childStderr).toContain("ExperimentalWarning");
      else expect(childStderr).toBe("");
    } finally {
      if (!childHasExited) {
        child.stdin.write("release\n");
        const exit = await Promise.race([childExit, delay(5_000).then(() => null)]);
        if (exit === null && child.exitCode === null && child.signalCode === null) child.kill();
      }
      if (contender) await contender.catch(() => undefined);
    }
  });

  it("retries after SQLite lock initialization fails and releases after an operation failure", async () => {
    const { credentialIndexPath, withCredentialLock } = await loadPrivateIndexLockModule();
    const lockDbPath = `${credentialIndexPath(privateRoot, scope, ref.id)}.lock.sqlite`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dirname(lockDbPath), { recursive: true });
    await writeFile(lockDbPath, "not-a-sqlite-database", "utf8");

    await expect(withCredentialLock(privateRoot, scope, ref.id, async () => "should-not-run"))
      .rejects.toBeInstanceOf(Error);
    await rm(lockDbPath, { force: true });
    await expect(withCredentialLock(privateRoot, scope, ref.id, async () => "reentered"))
      .resolves.toBe("reentered");

    await expect(withCredentialLock(privateRoot, scope, ref.id, async () => {
      throw new Error("synthetic operation failure");
    })).rejects.toThrow("synthetic operation failure");
    await expect(withCredentialLock(privateRoot, scope, ref.id, async () => "released"))
      .resolves.toBe("released");
  });
});
