import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialError,
  ContractWorkspaceSchema,
  createProjectSnapshot,
  fileStorage,
  listContractWorkspaceDefinitionFiles,
  type CredentialScope,
  type SecretRef,
  type SecretStore,
  type StorageAdapter,
} from "@apicc/core";
import type { ApiAsset, ContractWorkspace, DeepReadonly, ProjectSnapshot } from "@apicc/core";
import { createDesktopCredentialHost } from "../../src/main/credentials.js";
import { createSession } from "../../src/main/session.js";
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace, projectOne } from "./helpers/contract-assets.js";

const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const apiLocator = { ...locator, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi };
const supportedRef: SecretRef = { id: "new-ref:密钥", policy: "test-auto" };
const scope: CredentialScope = locator;

function createMemoryStore() {
  const values = new Map<string, { value: string; version: string }>();
  const generations = new Map<string, number>();
  const calls: Array<{ method: string; scope: CredentialScope; ref: SecretRef; value?: string }> = [];
  const failures = new Map<string, unknown>();
  const key = (address: CredentialScope, ref: SecretRef) => JSON.stringify([address.workspaceId, address.groupId, address.projectId, ref.id]);
  const failIfRequested = (method: string): void => {
    if (!failures.has(method)) return;
    const error = failures.get(method);
    failures.delete(method);
    throw error;
  };
  const store: SecretStore = {
    async put(address, ref, value) {
      calls.push({ method: "put", scope: { ...address }, ref: { ...ref }, value });
      failIfRequested("put");
      const addressKey = key(address, ref);
      const generation = (generations.get(addressKey) ?? 0) + 1;
      generations.set(addressKey, generation);
      values.set(addressKey, { value, version: `generation-${generation}` });
    },
    async resolve(address, ref, expectedVersion) {
      calls.push({ method: "resolve", scope: { ...address }, ref: { ...ref } });
      failIfRequested("resolve");
      const current = values.get(key(address, ref));
      if (!current) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      if (expectedVersion !== current.version) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
      return current.value;
    },
    async version(address, ref) {
      calls.push({ method: "version", scope: { ...address }, ref: { ...ref } });
      failIfRequested("version");
      const current = values.get(key(address, ref));
      if (!current) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return current.version;
    },
    async remove(address, ref) {
      calls.push({ method: "remove", scope: { ...address }, ref: { ...ref } });
      failIfRequested("remove");
      if (!values.delete(key(address, ref))) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
    },
    async status(address, ref) {
      calls.push({ method: "status", scope: { ...address }, ref: { ...ref } });
      failIfRequested("status");
      return values.has(key(address, ref)) ? "available" : "missing";
    },
  };
  return {
    store,
    calls,
    values,
    failNext(method: "put" | "resolve" | "version" | "remove" | "status", error: unknown) {
      failures.set(method, error);
    },
  };
}

async function persistedDefinitionBytes(root: string, workspace: ContractWorkspace): Promise<Array<[string, string]>> {
  return Promise.all(listContractWorkspaceDefinitionFiles(workspace).map(async (path) => [
    path,
    (await readFile(join(root, ...path.split("/")))).toString("base64"),
  ]));
}

function errorWithSyntheticDisclosure(code: CredentialError["code"], secret: string): CredentialError {
  const error = new CredentialError(code, "attacker-chosen-ref");
  Object.defineProperties(error, {
    message: { value: secret, configurable: true, writable: true },
    cause: { value: new Error(`cause:${secret}`), configurable: true, enumerable: true },
    stack: { value: `CredentialError: ${secret}\n    at synthetic store`, configurable: true, writable: true },
  });
  return error;
}

function ordinaryErrorWithSyntheticDisclosure(secret: string): Error {
  const error = new Error(secret, { cause: new Error(`cause:${secret}`) });
  error.stack = `Error: ${secret}\n    at synthetic store`;
  return error;
}

function diagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}\n${value.message}\n${value.stack ?? ""}\n${diagnosticText(value.cause)}`;
  }
  if (Array.isArray(value)) return value.map(diagnosticText).join("\n");
  if (typeof value === "object" && value !== null) return Object.values(value).map(diagnosticText).join("\n");
  return String(value);
}

describe("desktop credential host", () => {
  it("stores an unreferenced secret through the active complete project scope without changing workspace files", async () => {
    const temporary = await makeTempRoot("apicc-9b3b1-");
    try {
      const workspace = makeWorkspace();
      workspace.groups[1]!.projects[0]!.id = IDS.projectOne;
      await persistWorkspace(temporary.path, ContractWorkspaceSchema.parse(workspace));
      const session = createSession();
      await session.open(temporary.path);
      const before = { workspace: session.workspace, revision: session.revision };
      const synthetic = createMemoryStore();
      const host = createDesktopCredentialHost(session, { secretStore: synthetic.store });

      await expect(host.put({ locator, ref: supportedRef, value: "first synthetic value" })).resolves.toEqual({ ok: true });
      await expect(host.status({ locator, ref: supportedRef })).resolves.toEqual({ ok: true, status: "available" });
      expect(await host.remove({ locator, ref: supportedRef })).toEqual({ ok: true });
      await expect(host.status({ locator, ref: supportedRef })).resolves.toEqual({ ok: true, status: "missing" });
      expect(session.workspace).toEqual(before.workspace);
      expect(session.revision).toBe(before.revision);
      expect(synthetic.calls.map(({ method }) => method)).toEqual(["put", "status", "remove", "status"]);
      expect(synthetic.calls[0]).toMatchObject({ method: "put", scope: locator, ref: supportedRef, value: "first synthetic value" });

      const secondGroupLocator = { ...locator, groupId: IDS.groupTwo };
      await expect(host.put({ locator: secondGroupLocator, ref: supportedRef, value: "other group value" })).resolves.toEqual({ ok: true });
      await expect(host.status({ locator: secondGroupLocator, ref: supportedRef })).resolves.toEqual({ ok: true, status: "available" });
      await expect(host.status({ locator, ref: supportedRef })).resolves.toEqual({ ok: true, status: "missing" });
      expect(synthetic.calls.slice(-3).map((call) => call.scope)).toEqual([secondGroupLocator, secondGroupLocator, locator]);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects unsupported policy and unknown or read-only contexts before touching the store", async () => {
    const temporary = await makeTempRoot("apicc-9b3b1-");
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const synthetic = createMemoryStore();
      const session = createSession();
      await session.open(temporary.path);
      const host = createDesktopCredentialHost(session, { secretStore: synthetic.store });

      await expect(host.put({ locator, ref: { id: "later-policy", policy: "confirm-each-time" }, value: "never stored" }))
        .resolves.toEqual({ ok: false, error: { code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: "later-policy", message: "Credential policy is not supported." } });
      for (const invalidLocator of [
        { ...locator, workspaceId: "00000000-0000-4000-8000-000000000099" },
        { ...locator, groupId: "00000000-0000-4000-8000-000000000099" },
        { ...locator, projectId: "00000000-0000-4000-8000-000000000099" },
      ]) {
        await expect(host.status({ locator: invalidLocator, ref: supportedRef }))
          .resolves.toMatchObject({ ok: false, error: { code: "CREDENTIAL_CONTEXT_INVALID", refId: supportedRef.id } });
      }
      expect(synthetic.calls).toHaveLength(0);

      const readOnlyStorage: StorageAdapter = {
        async load(root) { return { ...await fileStorage.load(root), readOnly: true }; },
        save(root, workspace, options) { return fileStorage.save(root, workspace, options); },
      };
      const readOnlySession = createSession({ storage: readOnlyStorage });
      await readOnlySession.open(temporary.path);
      const readOnlyHost = createDesktopCredentialHost(readOnlySession, { secretStore: synthetic.store });
      await expect(readOnlyHost.put({ locator, ref: supportedRef, value: "blocked" })).resolves.toMatchObject({
        ok: false, error: { code: "CREDENTIAL_READ_ONLY", refId: supportedRef.id },
      });
      await expect(readOnlyHost.remove({ locator, ref: supportedRef })).resolves.toMatchObject({
        ok: false, error: { code: "CREDENTIAL_READ_ONLY", refId: supportedRef.id },
      });
      await expect(readOnlyHost.status({ locator, ref: supportedRef })).resolves.toEqual({ ok: true, status: "missing" });
      expect(synthetic.calls).toHaveLength(1);
      expect(synthetic.calls[0]?.method).toBe("status");
      const unavailableStore: SecretStore = { ...synthetic.store, async status() { return "unavailable"; } };
      await expect(createDesktopCredentialHost(session, { secretStore: unavailableStore }).status({ locator, ref: supportedRef }))
        .resolves.toEqual({ ok: true, status: "unavailable" });
    } finally {
      await temporary.dispose();
    }
  });

  it("keeps real Session file commits and secret-store commits independent on failure", async () => {
    const temporary = await makeTempRoot("apicc-9b3b1-");
    try {
      const workspace = makeWorkspace();
      const initialApi = projectOne(workspace).collections[0]!.apis[0]!;
      initialApi.contract.request.auth = { kind: "bearer", token: { id: "commit-domain-ref", policy: "test-auto" } };
      const initialRevision = await persistWorkspace(temporary.path, workspace);
      const fileFailure = "synthetic file commit failure";
      let failNextFileCommit = false;
      const storage: StorageAdapter = {
        load(root) { return fileStorage.load(root); },
        async save(root, candidate, options) {
          if (failNextFileCommit) {
            failNextFileCommit = false;
            throw new Error(fileFailure);
          }
          return fileStorage.save(root, candidate, options);
        },
      };
      const session = createSession({ storage });
      await session.open(temporary.path);
      const initialDefinition = structuredClone(session.workspace!);
      const initialBytes = await persistedDefinitionBytes(temporary.path, initialDefinition);
      const initialSessionRevision = session.revision;
      const synthetic = createMemoryStore();
      const host = createDesktopCredentialHost(session, { secretStore: synthetic.store });
      const committedRef: SecretRef = { id: "commit-domain-ref", policy: "test-auto" };
      const priorValue = "prior synthetic binding";
      await expect(host.put({ locator, ref: committedRef, value: priorValue })).resolves.toEqual({ ok: true });

      synthetic.failNext("put", new CredentialError("CREDENTIAL_SAVE_FAILED", "attacker-chosen-ref"));
      await expect(host.put({ locator, ref: committedRef, value: "failed replacement" })).resolves.toMatchObject({
        ok: false,
        error: { code: "CREDENTIAL_SAVE_FAILED", refId: committedRef.id },
      });
      const priorVersion = await synthetic.store.version(scope, committedRef);
      await expect(synthetic.store.resolve(scope, committedRef, priorVersion)).resolves.toBe(priorValue);

      const committedValue = "committed before file failure";
      await expect(host.put({ locator, ref: committedRef, value: committedValue })).resolves.toEqual({ ok: true });
      const pathChange = structuredClone(initialApi);
      pathChange.contract.request.path = "/file-save-fails-after-put";
      failNextFileCommit = true;
      await expect(session.saveApi(apiLocator, pathChange)).rejects.toThrow(fileFailure);
      await expect(host.status({ locator, ref: committedRef })).resolves.toEqual({ ok: true, status: "available" });
      const committedVersion = await synthetic.store.version(scope, committedRef);
      await expect(synthetic.store.resolve(scope, committedRef, committedVersion)).resolves.toBe(committedValue);
      expect(session.workspace).toEqual(initialDefinition);
      expect(session.revision).toBe(initialSessionRevision);
      expect(await persistedDefinitionBytes(temporary.path, initialDefinition)).toEqual(initialBytes);
      const reopenedAfterPutFailure = createSession();
      await reopenedAfterPutFailure.open(temporary.path);
      expect(reopenedAfterPutFailure.revision).toBe(initialRevision);
      expect(reopenedAfterPutFailure.workspace).toEqual(initialDefinition);

      synthetic.failNext("remove", new CredentialError("CREDENTIAL_REMOVE_FAILED", "attacker-chosen-ref"));
      await expect(host.remove({ locator, ref: committedRef })).resolves.toMatchObject({
        ok: false,
        error: { code: "CREDENTIAL_REMOVE_FAILED", refId: committedRef.id },
      });
      await expect(host.status({ locator, ref: committedRef })).resolves.toEqual({ ok: true, status: "available" });

      await expect(host.remove({ locator, ref: committedRef })).resolves.toEqual({ ok: true });
      await expect(host.status({ locator, ref: committedRef })).resolves.toEqual({ ok: true, status: "missing" });
      const authRemoval = structuredClone(initialApi);
      authRemoval.contract.request.auth = { kind: "none" };
      failNextFileCommit = true;
      await expect(session.saveApi(apiLocator, authRemoval)).rejects.toThrow(fileFailure);
      expect(session.workspace).toEqual(initialDefinition);
      expect(session.revision).toBe(initialSessionRevision);
      expect(await persistedDefinitionBytes(temporary.path, initialDefinition)).toEqual(initialBytes);
      const reopenedAfterRemoveFailure = createSession();
      await reopenedAfterRemoveFailure.open(temporary.path);
      expect(reopenedAfterRemoveFailure.workspace).toEqual(initialDefinition);
      expect(reopenedAfterRemoveFailure.locateApi(apiLocator)?.api.contract.request.auth).toEqual({
        kind: "bearer",
        token: { id: committedRef.id, policy: committedRef.policy },
      });

      const fileOnlyRef: SecretRef = { id: "file-only-ref", policy: "test-auto" };
      const fileOnlyApi = structuredClone(initialApi);
      fileOnlyApi.contract.request.auth = { kind: "bearer", token: fileOnlyRef };
      await expect(session.saveApi(apiLocator, fileOnlyApi)).resolves.toMatchObject({
        api: { contract: { request: { auth: { kind: "bearer", token: fileOnlyRef } } } },
      });
      await expect(host.status({ locator, ref: fileOnlyRef })).resolves.toEqual({ ok: true, status: "missing" });
    } finally {
      await temporary.dispose();
    }
  });

  it("sanitizes every Core credential error and ordinary store errors across host operations and run preparation", async () => {
    const temporary = await makeTempRoot("apicc-9b3b1-");
    const logSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const secrets: string[] = [];
    try {
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      project.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: supportedRef };
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      const snapshot = createProjectSnapshot(project);
      const selectedAsset = snapshot.project.collections[0]!.apis[0]!;
      const synthetic = createMemoryStore();
      const host = createDesktopCredentialHost(session, { secretStore: synthetic.store });
      await expect(host.put({ locator, ref: supportedRef, value: "initial synthetic value" })).resolves.toEqual({ ok: true });

      const stableMessages: Record<CredentialError["code"], string> = {
        CREDENTIAL_MISSING: "Credential is not available.",
        CREDENTIAL_UNAVAILABLE: "Credential store is unavailable.",
        CREDENTIAL_FORMAT_UNSUPPORTED: "Credential format is not supported.",
        CREDENTIAL_POLICY_UNSUPPORTED: "Credential policy is not supported.",
        CREDENTIAL_READ_FAILED: "Credential could not be read.",
        CREDENTIAL_SAVE_FAILED: "Credential could not be saved.",
        CREDENTIAL_REMOVE_FAILED: "Credential could not be removed.",
        CREDENTIAL_VERSION_CONFLICT: "Credential changed while it was being prepared.",
      };
      const knownFailures = [
        { method: "status", code: "CREDENTIAL_MISSING" },
        { method: "status", code: "CREDENTIAL_UNAVAILABLE" },
        { method: "put", code: "CREDENTIAL_FORMAT_UNSUPPORTED" },
        { method: "remove", code: "CREDENTIAL_POLICY_UNSUPPORTED" },
        { method: "put", code: "CREDENTIAL_READ_FAILED" },
        { method: "put", code: "CREDENTIAL_SAVE_FAILED" },
        { method: "remove", code: "CREDENTIAL_REMOVE_FAILED" },
        { method: "status", code: "CREDENTIAL_VERSION_CONFLICT" },
      ] as const;
      for (const { method, code } of knownFailures) {
        const secret = `synthetic-known-${code}`;
        const submittedValue = `request-value-${code}`;
        secrets.push(secret);
        secrets.push(submittedValue);
        synthetic.failNext(method, errorWithSyntheticDisclosure(code, secret));
        const result = method === "put"
          ? await host.put({ locator, ref: supportedRef, value: submittedValue })
          : method === "remove"
            ? await host.remove({ locator, ref: supportedRef })
            : await host.status({ locator, ref: supportedRef });
        expect(result).toMatchObject({
          ok: false,
          error: { code, refId: supportedRef.id, message: stableMessages[code] },
        });
        if (method === "put") expect(JSON.stringify(result)).not.toContain(submittedValue);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain("attacker-chosen-ref");
        expect(JSON.stringify(result)).not.toMatch(/cause|stack/i);
      }

      const ordinaryFailures = [
        { method: "put", code: "CREDENTIAL_SAVE_FAILED" },
        { method: "remove", code: "CREDENTIAL_REMOVE_FAILED" },
        { method: "status", code: "CREDENTIAL_UNAVAILABLE" },
      ] as const;
      for (const { method, code } of ordinaryFailures) {
        const secret = `synthetic-ordinary-${method}`;
        const submittedValue = `request-value-${method}`;
        secrets.push(secret);
        if (method === "put") secrets.push(submittedValue);
        synthetic.failNext(method, ordinaryErrorWithSyntheticDisclosure(secret));
        const result = method === "put"
          ? await host.put({ locator, ref: supportedRef, value: submittedValue })
          : method === "remove"
            ? await host.remove({ locator, ref: supportedRef })
            : await host.status({ locator, ref: supportedRef });
        expect(result).toMatchObject({ ok: false, error: { code, refId: supportedRef.id } });
        if (method === "put") expect(JSON.stringify(result)).not.toContain(submittedValue);
        expect(diagnosticText(result)).not.toContain(secret);
        expect(diagnosticText(result)).not.toContain("cause:");
        expect(diagnosticText(result)).not.toContain("attacker-chosen-ref");
      }

      for (const stage of ["version", "resolve"] as const) {
        const secret = `synthetic-prepare-${stage}`;
        secrets.push(secret);
        const injected = stage === "version"
          ? ordinaryErrorWithSyntheticDisclosure(secret)
          : errorWithSyntheticDisclosure("CREDENTIAL_READ_FAILED", secret);
        synthetic.failNext(stage, injected);
        const callsBefore = synthetic.calls.length;
        const failure = await host.prepareRun(scope, snapshot, [selectedAsset]).then(() => undefined, (error: unknown) => error);
        const expectedCode = stage === "version" ? "CREDENTIAL_UNAVAILABLE" : "CREDENTIAL_READ_FAILED";
        expect(failure).toBeInstanceOf(CredentialError);
        expect(failure).toMatchObject({ code: expectedCode, refId: supportedRef.id });
        expect(diagnosticText(failure)).not.toContain(secret);
        expect(diagnosticText(failure)).not.toContain("attacker-chosen-ref");
        expect(synthetic.calls.slice(callsBefore).map(({ method }) => method)).toEqual(
          stage === "version" ? ["version"] : ["version", "resolve"],
        );
      }

      const capturedLogs = logSpies.flatMap((spy) => spy.mock.calls).map((args) => diagnosticText(args)).join("\n");
      for (const secret of secrets) expect(capturedLogs).not.toContain(secret);
    } finally {
      logSpies.forEach((spy) => spy.mockRestore());
      await temporary.dispose();
    }
  });

  it("prepares unique refs from the supplied snapshot and keeps earlier bindings fixed", async () => {
    const temporary = await makeTempRoot("apicc-9b3b1-");
    const otherTemporary = await makeTempRoot("apicc-9b3b1-other-");
    try {
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      const asset = project.collections[0]!.apis[0]!;
      asset.contract.request.auth = { kind: "bearer", token: { id: "fixed-ref", policy: "test-auto" } };
      project.collections[1]!.apis[0]!.contract.request.auth = { kind: "componentRef", componentId: IDS.auth, expectedKind: "auth" };
      project.components.find((item) => item.id === IDS.auth)!.definition = { kind: "bearer", token: { id: "fixed-ref", policy: "test-auto" } };
      await persistWorkspace(temporary.path, workspace);
      const otherWorkspace = makeWorkspace();
      otherWorkspace.id = "00000000-0000-4000-8000-000000000099";
      await persistWorkspace(otherTemporary.path, otherWorkspace);
      const session = createSession();
      await session.open(temporary.path);
      const snapshot = createProjectSnapshot(project);
      const selectedAsset = snapshot.project.collections[0]!.apis[0]!;
      const componentAuthAsset = snapshot.project.collections[1]!.apis[0]!;
      const synthetic = createMemoryStore();
      const host = createDesktopCredentialHost(session, { secretStore: synthetic.store });
      await host.put({ locator, ref: { id: "fixed-ref", policy: "test-auto" }, value: "first fixed value" });

      const first = await host.prepareRun(scope, snapshot, [selectedAsset, componentAuthAsset]);
      const addressKey = JSON.stringify([scope.workspaceId, scope.groupId, scope.projectId, "fixed-ref"]);
      expect(first.run.snapshot).toBe(snapshot);
      expect(first.refs).toEqual([{ id: "fixed-ref", policy: "test-auto" }]);
      const firstVersion = synthetic.values.get(addressKey)?.version;
      expect(first.run.credentialBindings.versions["fixed-ref"]).toBe(firstVersion);
      expect(first.run.credentialBindings.resolve({ id: "fixed-ref", policy: "test-auto" })).toBe("first fixed value");
      expect(first.markers).toContain("Bearer first fixed value");
      expect(synthetic.calls.filter((call) => call.method === "resolve" && call.ref.id === "fixed-ref")).toHaveLength(1);

      await host.put({ locator, ref: { id: "fixed-ref", policy: "test-auto" }, value: "second fixed value" });
      await host.remove({ locator, ref: { id: "fixed-ref", policy: "test-auto" } });
      expect(first.run.credentialBindings.resolve({ id: "fixed-ref", policy: "test-auto" })).toBe("first fixed value");
      await host.put({ locator, ref: { id: "fixed-ref", policy: "test-auto" }, value: "third fixed value" });
      const thirdVersion = synthetic.values.get(addressKey)?.version;
      await session.open(otherTemporary.path);
      expect(first.run.credentialBindings.versions["fixed-ref"]).toBe(firstVersion);
      expect(first.run.credentialBindings.resolve({ id: "fixed-ref", policy: "test-auto" })).toBe("first fixed value");
      const second = await host.prepareRun(scope, snapshot, [selectedAsset, componentAuthAsset]);
      expect(second.run.snapshot).toBe(snapshot);
      expect(second.run.credentialBindings.versions["fixed-ref"]).toBe(thirdVersion);
      expect(second.run.credentialBindings.resolve({ id: "fixed-ref", policy: "test-auto" })).toBe("third fixed value");
    } finally {
      await Promise.all([temporary.dispose(), otherTemporary.dispose()]);
    }
  });

  it("leaves the store uninitialized for empty refs and rejects assets outside the supplied snapshot", async () => {
    const workspace = makeWorkspace();
    const project = projectOne(workspace);
    project.collections[0]!.apis[0]!.contract.request.auth = { kind: "none" };
    const snapshot: ProjectSnapshot = createProjectSnapshot(project);
    const session = createSession();
    const synthetic = createMemoryStore();
    const host = createDesktopCredentialHost(session, { secretStore: synthetic.store });
    const selected = snapshot.project.collections[0]!.apis[0]!;

    const prepared = await host.prepareRun(scope, snapshot, [selected]);
    expect(prepared.run.snapshot).toBe(snapshot);
    expect(prepared.refs).toEqual([]);
    expect(prepared.markers).toEqual([]);
    expect(synthetic.calls).toEqual([]);

    const unsupportedProject = projectOne(makeWorkspace());
    unsupportedProject.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: { id: "later-policy", policy: "confirm-each-time" } };
    const unsupportedSnapshot = createProjectSnapshot(unsupportedProject);
    await expect(host.prepareRun(scope, unsupportedSnapshot, [unsupportedSnapshot.project.collections[0]!.apis[0]!]))
      .rejects.toMatchObject({ code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: "later-policy" });
    expect(synthetic.calls).toEqual([]);

    const foreignAsset = createProjectSnapshot(projectOne(makeWorkspace())).project.collections[0]!.apis[0]!;
    await expect(host.prepareRun(scope, snapshot, [foreignAsset as DeepReadonly<ApiAsset>])).rejects.toThrow(TypeError);
    await expect(host.prepareRun({ ...scope, projectId: "00000000-0000-4000-8000-000000000099" }, snapshot, [selected]))
      .rejects.toThrow(TypeError);
    expect(synthetic.calls).toEqual([]);
  });

  it("rejects each selected asset's unsupported policy before deduplicating the same ref id", async () => {
    const workspace = makeWorkspace();
    const project = projectOne(workspace);
    const inlineAsset = project.collections[0]!.apis[0]!;
    const componentAsset = project.collections[1]!.apis[0]!;
    const sharedRef = { id: "policy-collision-ref", policy: "test-auto" };
    inlineAsset.contract.request.auth = {
      kind: "bearer",
      token: { id: sharedRef.id, policy: "confirm-each-time" },
    };
    project.components.find((component) => component.id === IDS.auth)!.definition = {
      kind: "bearer",
      token: sharedRef,
    };
    componentAsset.contract.request.auth = {
      kind: "componentRef",
      componentId: IDS.auth,
      expectedKind: "auth",
    };

    const snapshot = createProjectSnapshot(project);
    const inline = snapshot.project.collections[0]!.apis[0]!;
    const componentRef = snapshot.project.collections[1]!.apis[0]!;
    const orders = [
      [inline, componentRef],
      [componentRef, inline],
    ] as const;

    for (const selectedAssets of orders) {
      const synthetic = createMemoryStore();
      const host = createDesktopCredentialHost(createSession(), { secretStore: synthetic.store });

      await expect(host.prepareRun(scope, snapshot, selectedAssets)).rejects.toMatchObject({
        code: "CREDENTIAL_POLICY_UNSUPPORTED",
        refId: sharedRef.id,
      });
      expect(synthetic.calls).toEqual([]);
    }
  });
});
