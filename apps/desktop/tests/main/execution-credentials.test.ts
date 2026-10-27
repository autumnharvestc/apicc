import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDefaultRegistry, createNetworkProfileHost, createOAuthProfileHost, createProjectSnapshot, fileStorage, NetworkProfileError, type CredentialScope, type SecretRef, type SecretStore, type StorageAdapter } from "@apicc/core";
import * as Core from "@apicc/core";
import { createDesktopCredentialHost } from "../../src/main/credentials.js";
import { createOnlineLocalCredentialStore } from "../../src/main/online/projectCredentials.js";
import { runCollection, sendDebug, workspaceRunsDir } from "../../src/main/debug.js";
import { createStressController } from "../../src/main/stress.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IpcChannel } from "../../src/shared/channels.js";
import { createTestingController } from "../../src/main/testing.js";
import { IDS, findApi, makeTempRoot, makeWorkspace, persistWorkspace, projectOne, uuid } from "./helpers/contract-assets.js";

const SECRET_REF: SecretRef = { id: "desktop-run-secret", policy: "test-auto" };
const SECRET = "desktop-execution-secret-8fe2";
const OAUTH_BEARER_REF: SecretRef = { id: "desktop-run-oauth-bearer", policy: "test-auto" };
const OAUTH_CLIENT_SECRET_REF: SecretRef = { id: "desktop-run-oauth-client-secret", policy: "test-auto" };
const LOCATOR = {
  workspaceId: IDS.workspace,
  groupId: IDS.groupOne,
  projectId: IDS.projectOne,
  collectionId: IDS.collectionOne,
  folderIds: [IDS.folderOne, IDS.folderTwo],
  apiId: IDS.deepApi,
};

interface ObservedRequest { path: string; authorization: string | undefined }
let server: Server;
let baseUrl = "";
const received: ObservedRequest[] = [];
let nextRequest: ((request: ObservedRequest) => void) | undefined;

function readBody(request: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    request.on("data", () => {});
    request.on("end", resolve);
    request.on("error", reject);
  });
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    await readBody(request);
    const observed = {
      path: request.url ?? "",
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
    };
    received.push(observed);
    nextRequest?.(observed);
    nextRequest = undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ authorization: observed.authorization }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function createMemoryStore(initialValue: string) {
  let currentValue = initialValue;
  let currentVersion = "generation-1";
  const calls: Array<{ method: string; scope: CredentialScope; ref: SecretRef; generation: string }> = [];
  const store: SecretStore = {
    async put() { throw new Error("unexpected put"); },
    async resolve(scope, ref) {
      calls.push({ method: "resolve", scope: { ...scope }, ref: { ...ref }, generation: currentVersion });
      return currentValue;
    },
    async version(scope, ref) {
      calls.push({ method: "version", scope: { ...scope }, ref: { ...ref }, generation: currentVersion });
      return currentVersion;
    },
    async remove() { throw new Error("unexpected remove"); },
    async status(scope, ref) {
      calls.push({ method: "status", scope: { ...scope }, ref: { ...ref }, generation: currentVersion });
      return "available";
    },
  };
  return {
    store,
    calls,
    replace(value: string, version: string) { currentValue = value; currentVersion = version; },
  };
}

describe("online project credential routing", () => {
  it("uses explicit local-only selection and does not upload the personal value", async () => {
    const project = createMemoryStore("online-project-value"); const local = createMemoryStore("personal-local-value");
    const scope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const store = createOnlineLocalCredentialStore({ contractScope: scope, projectStore: project.store, localStore: local.store, localOnlyRefIds: [SECRET_REF.id] });
    expect(await store.resolve(scope, SECRET_REF)).toBe("personal-local-value");
    expect(project.calls).toHaveLength(0);
  });
  it("never fills a missing project credential from a same-name personal credential", async () => {
    const local = createMemoryStore("personal-local-value");
    const project = createMemoryStore("unused").store;
    project.resolve = async () => { throw new Core.CredentialError("CREDENTIAL_MISSING", SECRET_REF.id); };
    const scope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const store = createOnlineLocalCredentialStore({ contractScope: scope, projectStore: project, localStore: local.store });
    await expect(store.resolve(scope, SECRET_REF)).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
    expect(local.calls).toHaveLength(0);
  });
});

async function setup() {
  const temp = await makeTempRoot("apicc-execution-credentials-");
  const networkTemp = await makeTempRoot("apicc-network-private-");
  const workspace = makeWorkspace();
  const project = projectOne(workspace);
  const target = findApi(project, IDS.deepApi)!;
  target.contract.request.baseUrl = baseUrl;
  target.contract.request.auth = { kind: "bearer", token: { ...SECRET_REF } };
  project.environments![0]!.baseUrls[IDS.collectionOne] = baseUrl;
  project.collections[0]!.apis[0]!.contract.request.auth = { kind: "none" };
  await persistWorkspace(temp.path, workspace);

  const session = createSession();
  await session.open(temp.path);
  const secretStore = createMemoryStore(SECRET);
  const credentials = createDesktopCredentialHost(session, { secretStore: secretStore.store, networkPrivateRoot: networkTemp.path });
  return {
    temp: { path: temp.path, dispose: async () => { await Promise.all([temp.dispose(), networkTemp.dispose()]); } },
    networkPrivateRoot: networkTemp.path,
    session,
    secretStore,
    credentials,
  };
}

function waitForNextRequest(): Promise<ObservedRequest> {
  return new Promise((resolve) => { nextRequest = resolve; });
}

describe("desktop execution credential wiring", () => {
  it("prepares nested workflow credentials once for ordinary IPC and evidence reruns", async () => {
    const { session, credentials, secretStore, temp, networkPrivateRoot } = await setup();
    try {
      const workspace = session.workspace!; const project = projectOne(workspace); const asset = findApi(project, IDS.deepApi)!;
      const childId = uuid(94); const parentId = uuid(95);
      project.workflows.push({ id: childId, name: "child", status: "enabled", nodes: [{ id: "request", kind: "request", apiId: IDS.deepApi, caseId: asset.cases[0]!.id }], edges: [] });
      project.workflows.push(Core.WorkflowSchema.parse({ id: parentId, name: "parent", status: "enabled", executionVersion: 2, nodes: [{ id: "twice", kind: "loop", workflowId: childId, count: 2, inputs: {}, outputs: {} }], edges: [] }));
      await fileStorage.save(temp.path, Core.ContractWorkspaceSchema.parse(workspace), { expectedRevision: session.revision!, deletions: [] }); await session.open(temp.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "", credentials: { secretStore: secretStore.store, networkPrivateRoot } });
      const locator = { workspaceId: LOCATOR.workspaceId, groupId: LOCATOR.groupId, projectId: LOCATOR.projectId, workflowId: parentId };
      const ordinary = await deps.handle(IpcChannel.WfRun, null, { locator, envName: "dev", strict: true }) as Core.WorkflowRunResult;
      expect(ordinary.verdict).toBe("passed");
      expect(secretStore.calls.filter((call) => call.method === "resolve")).toHaveLength(1);
      const testing = createTestingController(session, async () => createDefaultRegistry(), credentials, { render: false, persist: (_path, value) => ({ value }) });
      const identity = { projectId: IDS.projectOne, definitionRevision: "old", workflowId: parentId, entryId: "twice", rowIndex: 0 };
      const rerun = await testing.rerunEvidence({ invocationId: crypto.randomUUID(), context: { root: temp.path, project: { workspaceId: LOCATOR.workspaceId, groupId: LOCATOR.groupId, projectId: LOCATOR.projectId }, revision: session.revision! }, identity });
      expect(rerun.cases).toHaveLength(2);
      expect(secretStore.calls.filter((call) => call.method === "resolve")).toHaveLength(2);
      expect(JSON.stringify([ordinary, rerun])).not.toContain(SECRET);
    } finally { await temp.dispose(); }
  });
  it("G reruns a suite data row and its string-ID workflow with current evidence and visible persistence warnings", async () => {
    const { session, credentials, temp } = await setup();
    try {
      const workspace = session.workspace!; const project = projectOne(workspace); const asset = findApi(project, IDS.deepApi)!;
      asset.contract.request.path = "/{{value}}";
      if (asset.contract.request.protocol !== "http") throw new Error("Expected HTTP fixture");
      asset.contract.request.method = "POST"; asset.contract.request.body = { kind: "text", content: "request {{value}}" };
      asset.cases[0]!.assertions = [{ id: "failure", target: "status", op: "eq", expected: "500" }];
      const datasetId = uuid(90); const entryId = uuid(91); const workflowId = "original-dependent-workflow";
      project.datasets = [{ formatVersion: 1, id: datasetId, name: "rows", columns: ["value"], rows: [{ value: "one" }, { value: "two" }] }];
      project.workflows.push({ id: workflowId, name: "original workflow", status: "enabled", nodes: [{ id: "node", kind: "request", apiId: IDS.deepApi, caseId: asset.cases[0]!.id }], edges: [] });
      await fileStorage.save(temp.path, Core.ContractWorkspaceSchema.parse(workspace), { expectedRevision: session.revision!, deletions: [] }); await session.open(temp.path);
      const context = { root: temp.path, project: { workspaceId: LOCATOR.workspaceId, groupId: LOCATOR.groupId, projectId: LOCATOR.projectId }, revision: session.revision! };
      const testing = createTestingController(session, async () => createDefaultRegistry(), credentials, { render: false, persist: (_path, value) => ({ value, warning: "安全 JSON 报告保存失败" }) });
      const identity = { projectId: IDS.projectOne, definitionRevision: "old-definition", dataDigest: "old-digest", entryId, suiteRow: 1, rowIndex: 1, datasetId, locator: { collectionId: IDS.collectionOne, folderIds: [...LOCATOR.folderIds], apiId: IDS.deepApi, caseId: asset.cases[0]!.id, scope: asset.cases[0]!.scope } };
      const input = { context, identity, invocationId: crypto.randomUUID() };
      const workflowInput = { ...input, identity: { ...identity, workflowId }, invocationId: crypto.randomUUID() };
      expect(await testing.inspectEvidence(workflowInput)).toMatchObject({ available: true, changed: true });
      expect(await testing.cancelEvidence(workflowInput)).toBe(false);
      const single = await testing.rerunEvidence(input);
      expect(single.cases).toHaveLength(1);
      expect(single.cases[0]!.evidence).toMatchObject({ state: "collected", identity: { entryId, suiteRow: 1, rowIndex: 1, datasetId }, request: { body: { text: "request two" } }, response: { status: 200, body: { text: expect.stringContaining("[REDACTED]") } } });
      expect(single.cases[0]!.evidence!.identity.definitionRevision).not.toBe("old-definition");
      expect(single.cases[0]!.evidence!.identity.dataDigest).not.toBe("old-digest");
      expect(single.reportFailure).toBe(true); expect(single.warnings).toContain("安全 JSON 报告保存失败");
      const workflow = await testing.rerunEvidence(workflowInput);
      expect(workflow.cases).toHaveLength(1);
      expect(workflow.cases[0]!.evidence).toMatchObject({ state: "collected", identity: { workflowId, suiteRow: 1, rowIndex: 1, datasetId, nodeId: "node", entryId: "node", dataDigest: single.cases[0]!.evidence!.identity.dataDigest }, request: { body: { text: "request two" } }, response: { status: 200, body: { text: expect.stringContaining("[REDACTED]") } } });
      expect(workflow.reportFailure).toBe(true); expect(workflow.warnings).toContain("安全 JSON 报告保存失败");
      expect(received.slice(-2).map(item => item.path)).toEqual(["/two", "/two"]);
      expect(JSON.stringify([single, workflow])).not.toContain(SECRET);
    } finally { await temp.dispose(); }
  });
  it("C1 compares definition revision in the same project and reruns the exact current case with fresh credential preparation", async () => {
    const { session, credentials, secretStore, temp } = await setup();
    try {
      // Exercise the actual persistence/rerun boundary with a marker colliding with protocol metadata.
      secretStore.replace("passed", "generation-1");
      const result = await runCollection(session, { locator: { workspaceId: LOCATOR.workspaceId, groupId: LOCATOR.groupId, projectId: LOCATOR.projectId, collectionId: LOCATOR.collectionId }, envName: "dev" }, createDefaultRegistry(), credentials);
      expect(typeof result.passed).toBe("number"); expect(typeof result.cases[0]?.passed).toBe("boolean");
      const saved = JSON.parse(readFileSync(join(workspaceRunsDir(temp.path), readdirSync(workspaceRunsDir(temp.path))[0]!), "utf8"));
      expect(saved.passed).toBe(result.passed); expect(saved.cases[0].passed).toBe(result.cases[0]!.passed);
      expect(saved.cases[0].evidence.identity).toEqual(result.cases[0]!.evidence!.identity);
      expect(JSON.stringify(saved)).not.toContain("Bearer passed");
      const identity = result.cases[0]!.evidence!.identity;
      const testing = createTestingController(session, async () => createDefaultRegistry(), credentials);
      const context = { root: temp.path, project: { workspaceId: LOCATOR.workspaceId, groupId: LOCATOR.groupId, projectId: LOCATOR.projectId }, revision: session.revision! };
      const input = { context, identity, invocationId: crypto.randomUUID() };
      expect(await testing.inspectEvidence(input)).toMatchObject({ available: true, changed: false });
      expect(await testing.inspectEvidence({ ...input, identity: { ...identity, definitionRevision: "old-definition" } })).toMatchObject({ available: true, changed: true });
      expect(await testing.inspectEvidence({ ...input, identity: { ...identity, locator: { ...identity.locator!, scope: "missing" } } })).toMatchObject({ available: false });
      const rerun = await testing.rerunEvidence({ ...input, identity: { ...identity, definitionRevision: "old-definition" } });
      expect(rerun.cases).toHaveLength(1); expect(rerun.cases[0]?.locator).toEqual(identity.locator);
      expect(typeof rerun.passed).toBe("number"); expect(typeof rerun.cases[0]?.passed).toBe("boolean");
      expect(rerun.warnings?.join(" ")).toContain("资源定义已变化");
      expect(secretStore.calls.filter((call) => call.method === "resolve")).toHaveLength(2);
      expect(JSON.stringify(rerun)).not.toContain(SECRET);
    } finally { await temp.dispose(); }
  });
  it("rejects explicit OAuth writes from a read-only session before network, browser, or secret effects", async () => {
    const temp = await makeTempRoot("apicc-readonly-oauth-");
    const oauthPrivateRoot = await makeTempRoot("apicc-readonly-oauth-private-");
    const networkPrivateRoot = await makeTempRoot("apicc-readonly-oauth-network-");
    const values = new Map<string, string>();
    const versions = new Map<string, number>();
    const storeCalls: string[] = [];
    let generation = 0;
    const secretStore: SecretStore = {
      async put(_scope, ref, value) { storeCalls.push("put"); values.set(ref.id, value); versions.set(ref.id, ++generation); },
      async resolve(_scope, ref, expectedVersion) {
        storeCalls.push("resolve");
        if (expectedVersion !== undefined && expectedVersion !== String(versions.get(ref.id))) throw new Error("version mismatch");
        const value = values.get(ref.id);
        if (value === undefined) throw new Error("missing secret");
        return value;
      },
      async version(_scope, ref) { storeCalls.push("version"); const value = versions.get(ref.id); if (value === undefined) throw new Error("missing secret"); return String(value); },
      async remove(_scope, ref) { storeCalls.push("remove"); values.delete(ref.id); versions.delete(ref.id); },
      async status(_scope, ref) { storeCalls.push("status"); return values.has(ref.id) ? "available" : "missing"; },
    };
    let tokenRequests = 0;
    const tokenServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      tokenRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "synthetic-readonly-access", token_type: "Bearer", expires_in: 300 }));
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const tokenEndpoint = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`;
    const workspace = makeWorkspace();
    await persistWorkspace(temp.path, workspace);
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const environment = projectOne(workspace).environments![0]!;
    const writableSession = createSession();
    await writableSession.open(temp.path);
    const profileHost = await createOAuthProfileHost({
      workspaceRoot: temp.path,
      project: locator,
      environmentId: environment.id,
      privateRoot: oauthPrivateRoot.path,
      secretStore,
    });
    const profiles = [
      {
        profileId: "readonly-client-credentials",
        environmentId: environment.id,
        flow: "client_credentials" as const,
        tokenEndpoint,
        clientId: "synthetic-readonly-client",
        clientAuthentication: "client_secret_post" as const,
        bearerRef: { id: "readonly-client-bearer", policy: "test-auto" as const },
        clientSecretRef: { id: "readonly-client-secret", policy: "test-auto" as const },
      },
      {
        profileId: "readonly-refresh-token",
        environmentId: environment.id,
        flow: "refresh_token" as const,
        tokenEndpoint,
        clientId: "synthetic-readonly-refresh-client",
        clientAuthentication: "none" as const,
        bearerRef: { id: "readonly-refresh-bearer", policy: "test-auto" as const },
        refreshTokenRef: { id: "readonly-refresh-token-ref", policy: "test-auto" as const },
      },
      {
        profileId: "readonly-authorization-code",
        environmentId: environment.id,
        flow: "authorization_code" as const,
        authorizationEndpoint: "http://127.0.0.1:1/authorize",
        tokenEndpoint,
        clientId: "synthetic-readonly-auth-client",
        clientAuthentication: "none" as const,
        bearerRef: { id: "readonly-auth-bearer", policy: "test-auto" as const },
      },
    ];
    for (const [index, profile] of profiles.entries()) {
      const options = index === 0 ? { clientSecret: "synthetic-readonly-client-secret" }
        : index === 1 ? { refreshToken: "synthetic-readonly-refresh-token" } : undefined;
      expect((await profileHost.saveProfile(profile, options)).status).toBe("success");
    }
    const readOnlyStorage: StorageAdapter = {
      async load(root) { return { ...await fileStorage.load(root), readOnly: true }; },
      save(root, candidate, options) { return fileStorage.save(root, candidate, options); },
    };
    const readOnlySession = createSession({ storage: readOnlyStorage });
    await readOnlySession.open(temp.path);
    let opened = false;
    const readOnlyHost = createDesktopCredentialHost(readOnlySession, {
      secretStore,
      oauthPrivateRoot: oauthPrivateRoot.path,
      networkPrivateRoot: networkPrivateRoot.path,
      openExternal: async () => { opened = true; },
    });
    const owner = {};
    const beforeCalls = storeCalls.length;
    try {
      await expect(readOnlyHost.oauthProfileAcquire({ locator, environmentId: environment.id, profileId: "readonly-client-credentials" }))
        .rejects.toMatchObject({ code: "OAUTH_PROFILE_INVALID" });
      await expect(readOnlyHost.oauthProfileRefresh({ locator, environmentId: environment.id, profileId: "readonly-refresh-token" }))
        .rejects.toMatchObject({ code: "OAUTH_PROFILE_INVALID" });
      await expect(readOnlyHost.oauthAuthorizationBegin(owner, { locator, environmentId: environment.id, profileId: "readonly-authorization-code" }))
        .rejects.toMatchObject({ code: "OAUTH_PROFILE_INVALID" });
      expect(tokenRequests).toBe(0);
      expect(opened).toBe(false);
      expect(values.has("readonly-client-bearer")).toBe(false);
      expect(values.has("readonly-refresh-bearer")).toBe(false);
      expect(values.has("readonly-auth-bearer")).toBe(false);
      expect(storeCalls).toHaveLength(beforeCalls);
    } finally {
      readOnlyHost.closeOAuthOwner(owner);
      await Promise.all([
        new Promise<void>((resolve, reject) => tokenServer.close((error) => error ? reject(error) : resolve())),
        temp.dispose(),
        oauthPrivateRoot.dispose(),
        networkPrivateRoot.dispose(),
      ]);
    }
  });

  it("automatically acquires an OAuth bearer before the ordinary business request is bound", async () => {
    received.length = 0;
    const temp = await makeTempRoot("apicc-desktop-oauth-run-");
    const oauthPrivateRoot = await makeTempRoot("apicc-desktop-oauth-private-");
    const networkPrivateRoot = await makeTempRoot("apicc-desktop-oauth-network-");
    const tokenRequests: string[] = [];
    let tokenResponseGate: { entered: () => void; wait: Promise<void> } | undefined;
    const tokenServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      tokenRequests.push(Buffer.concat(chunks).toString("utf8"));
      const gate = tokenResponseGate;
      if (gate !== undefined) {
        gate.entered();
        await gate.wait;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "synthetic-refreshed-access-token", token_type: "Bearer", expires_in: 300 }));
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const tokenEndpoint = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`;
    const values = new Map<string, string>();
    const versions = new Map<string, number>();
    let nextVersion = 0;
    const secretStore: SecretStore = {
      async put(_scope, ref, value) {
        values.set(ref.id, value);
        versions.set(ref.id, ++nextVersion);
      },
      async resolve(_scope, ref, expectedVersion) {
        if (expectedVersion !== undefined && expectedVersion !== String(versions.get(ref.id))) throw new Error("version mismatch");
        const value = values.get(ref.id);
        if (value === undefined) throw new Error("missing secret");
        return value;
      },
      async version(_scope, ref) {
        const version = versions.get(ref.id);
        if (version === undefined) throw new Error("missing secret");
        return String(version);
      },
      async remove(_scope, ref) { values.delete(ref.id); versions.delete(ref.id); },
      async status(_scope, ref) { return values.has(ref.id) ? "available" : "missing"; },
    };
    const workspace = makeWorkspace();
    const project = projectOne(workspace);
    const target = findApi(project, IDS.deepApi)!;
    target.contract.request.baseUrl = baseUrl;
    target.contract.request.auth = { kind: "bearer", token: { ...OAUTH_BEARER_REF } };
    project.environments![0]!.baseUrls[IDS.collectionOne] = baseUrl;
    await persistWorkspace(temp.path, workspace);
    const session = createSession();
    await session.open(temp.path);
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const environment = project.environments![0]!;
    const profileHost = await createOAuthProfileHost({
      workspaceRoot: temp.path,
      project: locator,
      environmentId: environment.id,
      privateRoot: oauthPrivateRoot.path,
      secretStore,
    });
    const saved = await profileHost.saveProfile({
      profileId: "desktop-run-oauth-profile",
      environmentId: environment.id,
      flow: "client_credentials",
      tokenEndpoint,
      clientId: "synthetic-desktop-client",
      clientAuthentication: "client_secret_post",
      bearerRef: { ...OAUTH_BEARER_REF },
      clientSecretRef: { ...OAUTH_CLIENT_SECRET_REF },
    }, { clientSecret: "synthetic-desktop-client-secret" });
    const credentials = createDesktopCredentialHost(session, {
      secretStore,
      oauthPrivateRoot: oauthPrivateRoot.path,
      networkPrivateRoot: networkPrivateRoot.path,
    });

    try {
      expect(saved).toEqual({ status: "success" });
      const result = await sendDebug(session, {
        locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
        caseId: IDS.sharedCase,
        envName: environment.name,
      }, async () => createDefaultRegistry(), credentials);
      const oauthIpc = createIpcDeps({
        session,
        pickDirectory: async () => temp.path,
        saveFile: async () => "",
        credentials: {
          secretStore,
          oauthPrivateRoot: oauthPrivateRoot.path,
          networkPrivateRoot: networkPrivateRoot.path,
        },
      });
      const acquireChannel = IpcChannel.OAuthProfileAcquire;
      let enterTokenResponse!: () => void;
      let releaseTokenResponse!: () => void;
      const tokenEntered = new Promise<void>((resolve) => { enterTokenResponse = resolve; });
      const tokenGate = new Promise<void>((resolve) => { releaseTokenResponse = resolve; });
      tokenResponseGate = { entered: enterTokenResponse, wait: tokenGate };
      let coordinatorSpy: { mockRestore(): void } | undefined;
      let signalSecondJoin!: () => void;
      const secondJoinedFlight = new Promise<void>((resolve) => { signalSecondJoin = resolve; });
      let explicitExchangeCalls = 0;
      const acquireInput = {
        locator,
        environmentId: environment.id,
        profileId: "desktop-run-oauth-profile",
      };
      const acquireCountBefore = tokenRequests.length;
      const originalCoordinatorFactory = Core.createOAuthProfileCoordinator;
      coordinatorSpy = vi.spyOn(Core, "createOAuthProfileCoordinator").mockImplementation((options) => {
        const coordinator = originalCoordinatorFactory(options);
        return Object.freeze({
          async prepareOAuthBearerRefs(input: Parameters<typeof coordinator.prepareOAuthBearerRefs>[0]) {
            await coordinator.prepareOAuthBearerRefs(input);
          },
          async exchangeOAuthProfile(input: Parameters<typeof coordinator.exchangeOAuthProfile>[0]) {
            // Ensure this instance's host Promise has resolved before entering its real exchange method.
            await coordinator.prepareOAuthBearerRefs({ scope: locator, environmentId: environment.id, refs: [] });
            const exchange = coordinator.exchangeOAuthProfile(input);
            explicitExchangeCalls += 1;
            if (explicitExchangeCalls === 2) {
              // The real async method has resumed from its resolved host Promise and registered the waiter.
              await Promise.resolve();
              signalSecondJoin();
            }
            return await exchange;
          },
        });
      });
      let acquired: Awaited<ReturnType<typeof oauthIpc.handle>>;
      let acquiredAgain: Awaited<ReturnType<typeof oauthIpc.handle>>;
      try {
        const firstAcquire = oauthIpc.handle(acquireChannel, {}, acquireInput);
        await tokenEntered;
        const secondAcquire = oauthIpc.handle(acquireChannel, {}, acquireInput);
        await secondJoinedFlight;
        releaseTokenResponse();
        [acquired, acquiredAgain] = await Promise.all([firstAcquire, secondAcquire]);
      } finally {
        coordinatorSpy.mockRestore();
        tokenResponseGate = undefined;
      }
      const refreshChannel = IpcChannel.OAuthProfileRefresh;
      const refreshBearerRef = { id: "desktop-run-oauth-refresh-bearer", policy: "test-auto" as const };
      const refreshTokenRef = { id: "desktop-run-oauth-refresh-token", policy: "test-auto" as const };
      const refreshProfileSaved = await profileHost.saveProfile({
        profileId: "desktop-run-oauth-refresh-profile",
        environmentId: environment.id,
        flow: "refresh_token",
        tokenEndpoint,
        clientId: "synthetic-desktop-refresh-client",
        clientAuthentication: "none",
        bearerRef: refreshBearerRef,
        refreshTokenRef,
      }, { refreshToken: "synthetic-desktop-refresh-token" });
      expect(refreshProfileSaved.status).toBe("success");
      const refreshed = await oauthIpc.handle(refreshChannel, {}, {
        locator,
        environmentId: environment.id,
        profileId: "desktop-run-oauth-refresh-profile",
      });
      await expect(oauthIpc.handle(refreshChannel, {}, {
        locator,
        environmentId: environment.id,
        profileId: "desktop-run-oauth-profile",
      })).rejects.toMatchObject({ code: "OAUTH_PROFILE_INVALID" });
      await expect(oauthIpc.handle(acquireChannel, {}, {
        locator,
        environmentId: environment.id,
        profileId: "desktop-run-oauth-profile",
        grant: { type: "refresh_token" },
      } as never)).rejects.toThrow(/入参校验失败/);
      const profiles = await profileHost.listProfiles();

      expect(result.outcome.passed).toBe(true);
      expect(acquired.result.status).toBe("success");
      expect(acquired.result).toEqual(acquiredAgain.result);
      expect(acquired.profileSnapshot.status).toBe("available");
      expect(refreshed.result.status).toBe("success");
      expect(refreshed.profileSnapshot.status).toBe("available");
      expect(tokenRequests).toHaveLength(3);
      expect(tokenRequests.slice(acquireCountBefore, acquireCountBefore + 1)).toHaveLength(1);
      expect(new URLSearchParams(tokenRequests[0]).get("grant_type")).toBe("client_credentials");
      expect(new URLSearchParams(tokenRequests[0]).get("client_secret")).toBe("synthetic-desktop-client-secret");
      expect(new URLSearchParams(tokenRequests[2]).get("grant_type")).toBe("refresh_token");
      expect(new URLSearchParams(tokenRequests[2]).get("refresh_token")).toBe("synthetic-desktop-refresh-token");
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe("Bearer synthetic-refreshed-access-token");
      expect(profiles.find((profile) => profile.profile.profileId === "desktop-run-oauth-profile"))
        .toMatchObject({ status: "connected", expiresAt: expect.any(Number) });
      expect(JSON.stringify(result)).not.toContain("synthetic-refreshed-access-token");
    } finally {
      await new Promise<void>((resolve, reject) => tokenServer.close((error) => error ? reject(error) : resolve()));
      await Promise.all([temp.dispose(), oauthPrivateRoot.dispose(), networkPrivateRoot.dispose()]);
    }
  });

  it("runs a fully located debug case with one prepared credential and redacts echoed secrets", async () => {
    received.length = 0;
    const { session, secretStore, credentials, temp } = await setup();
    const request = waitForNextRequest();
    const result = await sendDebug(session, {
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      caseId: IDS.sharedCase,
      envName: "dev",
    }, async () => createDefaultRegistry(), credentials);

    const observed = await request;
    expect(result.outcome.passed).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(observed.path).toBe("/items");
    expect(observed.authorization).toBe(`Bearer ${SECRET}`);
    expect(secretStore.calls.map((call) => call.method)).toEqual(["version", "resolve", "version", "status"]);
    expect(secretStore.calls.every((call) => call.scope.workspaceId === IDS.workspace
      && call.scope.groupId === IDS.groupOne && call.scope.projectId === IDS.projectOne)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.response?.bodyText).toContain("[REDACTED]");
    expect(result.run.cases).toHaveLength(1);
    await temp.dispose();
  });

  it("runs one complete collection snapshot and persists only the sanitized result", async () => {
    received.length = 0;
    const { session, secretStore, credentials, temp } = await setup();
    const result = await runCollection(session, {
      locator: {
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
      },
      envName: "dev",
    }, async () => createDefaultRegistry(), credentials);

    const files = readdirSync(join(temp.path, ".apicc", "runs")).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
    expect(result.total).toBe(1);
    expect(result.cases[0]?.apiId).toBe(IDS.deepApi);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(secretStore.calls.map((call) => call.method)).toEqual(["version", "resolve", "version", "status"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(temp.path, ".apicc", "runs", files[0]!), "utf8")).not.toContain(SECRET);
    await temp.dispose();
  });

  it("routes a desktop collection through its captured project/environment proxy profile", async () => {
    received.length = 0;
    const { session, credentials, secretStore, temp, networkPrivateRoot } = await setup();
    const proxyRequests: string[] = [];
    const proxy = createServer((request, response) => {
      const target = new URL(request.url ?? "", baseUrl);
      proxyRequests.push(`${request.method ?? "GET"} ${target.href}`);
      const headers = { ...request.headers, host: target.host };
      delete headers["proxy-authorization"];
      const upstream = httpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      request.pipe(upstream);
      upstream.on("error", () => { response.writeHead(502); response.end(); });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const environment = session.locateProject({ workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne })!.project.environments[0]!;
    const profileHost = await createNetworkProfileHost({
      workspaceRoot: temp.path,
      project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne },
      environmentId: environment.id,
      privateRoot: networkPrivateRoot,
      secretStore: secretStore.store,
    });
    const current = await profileHost.store.load(profileHost.scope);
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const proxyPasswordRef = { id: "desktop-network-proxy-password", policy: "test-auto" as const };
    await profileHost.store.save(profileHost.scope, {
      formatVersion: 1,
      profiles: [{ id: "desktop-proxy", name: "Desktop proxy", kind: "proxy", proxyUrl, username: "proxy-user", passwordRef: proxyPasswordRef, targetTlsBindings: [] }],
      projectSelection: { kind: "direct" },
      environmentSelections: [{ environmentId: environment.id, selection: { kind: "profile", profileId: "desktop-proxy" } }],
    }, current.revision);

    try {
      secretStore.calls.length = 0;
      const proxyPreparationCount = () => secretStore.calls.filter((call) => call.method === "resolve" && call.ref.id === proxyPasswordRef.id).length;
      const atCapturedStartup = async <T>(run: () => Promise<T>, expectedRequests = 1): Promise<T> => {
        const preparationsBefore = proxyPreparationCount();
        const proxyRequestsBefore = proxyRequests.length;
        const targetRequestsBefore = received.length;
        const result = await run();
        expect(proxyPreparationCount() - preparationsBefore).toBe(1);
        expect(proxyRequests).toHaveLength(proxyRequestsBefore + expectedRequests);
        expect(received).toHaveLength(targetRequestsBefore + expectedRequests);
        return result;
      };

      const single = await atCapturedStartup(() => sendDebug(session, {
        locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
        caseId: IDS.sharedCase,
        envName: environment.name,
      }, async () => createDefaultRegistry(), credentials));
      expect(single.outcome.passed).toBe(true);

      const collection = await atCapturedStartup(() => runCollection(session, {
        locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne },
        envName: environment.name,
      }, async () => createDefaultRegistry(), credentials));
      expect(collection.total).toBe(1);

      const workflowLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, workflowId: IDS.workflow };
      const workflow = session.locateWorkflow(workflowLocator)!.workflow;
      await session.saveWorkflow(workflowLocator, {
        ...workflow,
        nodes: [{ id: IDS.workflowNode, kind: "request", apiId: IDS.deepApi, caseId: IDS.sharedCase }],
        edges: [],
      });
      await session.setWorkflowStatus(workflowLocator, "published");
      await session.setWorkflowStatus(workflowLocator, "enabled");
      const ipc = createIpcDeps({
        session,
        pickDirectory: async () => temp.path,
        saveFile: async () => "",
        credentials: { secretStore: secretStore.store, networkPrivateRoot },
      });
      const workflowResult = await atCapturedStartup(() => ipc.handle("wf:run", {}, { locator: workflowLocator, envName: environment.name, strict: true }));
      expect(workflowResult.verdict).toBe("passed");

      const stress = createStressController(session, {}, credentials);
      const stressResult = await atCapturedStartup(() => stress.run({
        locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
        caseId: IDS.sharedCase,
        envName: environment.name,
        concurrency: 1,
        maxIterations: 2,
        confirmedTargetOrigins: [new URL(baseUrl).origin],
      }), 2);
      expect(stressResult.report.totalRequests).toBe(2);

      expect(proxyRequests).toEqual(Array.from({ length: 5 }, () => `GET ${baseUrl}/items`));
      expect(received.map((request) => request.path)).toEqual(Array.from({ length: 5 }, () => "/items"));
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      await temp.dispose();
    }
  });

  it("persists project network settings separately from main-process secret file import", async () => {
    const { session, temp, networkPrivateRoot } = await setup();
    const importedSecret = "synthetic-private-key-not-for-ipc";
    const secretFile = join(networkPrivateRoot, "synthetic-key.pem");
    writeFileSync(secretFile, importedSecret, "utf8");
    let storedSecret = "";
    const scopedStore: SecretStore = {
      async put(_scope, _ref, value) { storedSecret = value; },
      async resolve() { return storedSecret; },
      async version() { return "synthetic-version"; },
      async remove() { storedSecret = ""; },
      async status() { return storedSecret ? "available" : "missing"; },
    };
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const ipc = createIpcDeps({
      session,
      pickDirectory: async () => temp.path,
      saveFile: async () => "",
      pickNetworkSecretFile: async () => secretFile,
      credentials: { secretStore: scopedStore, networkPrivateRoot },
    });
    const initial = await ipc.handle(IpcChannel.NetworkProfilesGet, {}, locator);
    const configuration = {
      formatVersion: 1 as const,
      profiles: [{ id: "saved-proxy", name: "Saved proxy", kind: "proxy" as const, proxyUrl: "http://127.0.0.1:8080", username: "synthetic-user", passwordRef: SECRET_REF, targetTlsBindings: [] }],
      projectSelection: { kind: "profile" as const, profileId: "saved-proxy" },
      environmentSelections: [],
    };
    const saved = await ipc.handle(IpcChannel.NetworkProfilesSave, {}, { locator, revision: initial.revision, configuration });
    const reloaded = await ipc.handle(IpcChannel.NetworkProfilesGet, {}, locator);
    expect(reloaded.revision).toBe(saved.revision);
    expect(reloaded.configuration).toEqual(configuration);
    expect(reloaded.secretStatuses).toEqual([{ ref: SECRET_REF, status: "missing" }]);

    const imported = await ipc.handle(IpcChannel.NetworkSecretImport, {}, { locator, ref: SECRET_REF });
    expect(imported).toEqual({ outcome: "saved", status: "available" });
    expect(storedSecret).toBe(importedSecret);
    expect(JSON.stringify(imported)).not.toContain(importedSecret);
    expect(JSON.stringify(imported)).not.toContain(secretFile);
    const afterImport = await ipc.handle(IpcChannel.NetworkProfilesGet, {}, locator);
    expect(afterImport.secretStatuses).toEqual([{ ref: SECRET_REF, status: "available" }]);

    const missingPath = join(networkPrivateRoot, "synthetic-missing-private-key.pem");
    const rejectedPickerIpc = createIpcDeps({
      session,
      pickDirectory: async () => temp.path,
      saveFile: async () => "",
      pickNetworkSecretFile: async () => { throw new Error(`ENOENT: no such file, open '${missingPath}'`); },
      credentials: { secretStore: scopedStore, networkPrivateRoot },
    });
    const failedImport = await rejectedPickerIpc.handle(IpcChannel.NetworkSecretImport, {}, { locator, ref: SECRET_REF });
    expect(failedImport).toEqual({ outcome: "failed", message: "The selected secret file could not be saved." });
    expect(JSON.stringify(failedImport)).not.toContain(missingPath);

    const cancelledPickerIpc = createIpcDeps({
      session,
      pickDirectory: async () => temp.path,
      saveFile: async () => "",
      pickNetworkSecretFile: async () => null,
      credentials: { secretStore: scopedStore, networkPrivateRoot },
    });
    expect(await cancelledPickerIpc.handle(IpcChannel.NetworkSecretImport, {}, { locator, ref: SECRET_REF })).toEqual({ outcome: "cancelled" });
    await temp.dispose();
  });

  it("preserves typed network preparation failures instead of reporting credential-store failure", async () => {
    const { session, credentials, temp, networkPrivateRoot } = await setup();
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    const location = session.locateProject(locator)!;
    const profileHost = await createNetworkProfileHost({
      workspaceRoot: temp.path,
      project: locator,
      privateRoot: networkPrivateRoot,
      secretStore: createMemoryStore(SECRET).store,
    });
    const current = await profileHost.store.load(profileHost.scope);
    await profileHost.store.save(profileHost.scope, {
      formatVersion: 1,
      profiles: [{
        id: "missing-ca-profile",
        name: "Missing CA",
        kind: "direct",
        targetTlsBindings: [{ origin: "https://network-fixture.invalid", tls: { caCertificatePaths: [join(networkPrivateRoot, "missing-ca.pem")] } }],
      }],
      projectSelection: { kind: "profile", profileId: "missing-ca-profile" },
      environmentSelections: [],
    }, current.revision);

    await expect(credentials.prepareRunForRequests(
      locator,
      createProjectSnapshot(location.project),
      [],
      { workspaceRoot: temp.path },
    )).rejects.toMatchObject({ name: "NetworkProfileError", code: "NETWORK_CERTIFICATE_MISSING" });
    await temp.dispose();
  });

  it("runs a fully located stress target from one prepared snapshot and persists a sanitized report", async () => {
    received.length = 0;
    const { session, secretStore, credentials, temp } = await setup();
    const controller = createStressController(session, {}, credentials);
    const result = await controller.run({
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      caseId: IDS.sharedCase,
      envName: "dev",
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: [new URL(baseUrl).origin],
    });

    expect(result.report.totalRequests).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(secretStore.calls.map((call) => call.method)).toEqual(["version", "resolve", "version", "status"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.file).toBeTruthy();
    expect(readFileSync(join(temp.path, ".apicc", "runs", result.file!), "utf8")).not.toContain(SECRET);
    await temp.dispose();
  });

  it("redacts a credential marker in a StressSafetyError targetOrigin", async () => {
    received.length = 0;
    const { session, credentials, temp } = await setup();
    const api = session.locateApi(LOCATOR)!.api;
    api.contract.request.baseUrl = `http://${SECRET}.example.test`;
    await session.saveApi(LOCATOR, api);
    let requests = 0;
    let closes = 0;
    const controller = createStressController(session, {
      createManagedClient: () => ({
        name: "safety-boundary",
        canHandle: () => true,
        execute: async () => { requests += 1; return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; },
        close: async () => { closes += 1; },
      }),
    }, credentials);

    const failure = await controller.run({
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      caseId: IDS.sharedCase,
      concurrency: 1,
      maxIterations: 1,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "target_confirmation_required", targetOrigin: `http://[REDACTED].example.test` });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(requests).toBe(0);
    expect(closes).toBe(1);
    expect(received).toHaveLength(0);
    await temp.dispose();
  });

  it("rejects an unknown case or environment before reading credentials, creating clients, or sending requests", async () => {
    received.length = 0;
    const { session, credentials, secretStore, temp } = await setup();
    let clients = 0;
    const controller = createStressController(session, {
      createManagedClient: () => {
        clients += 1;
        return { name: "must-not-start", canHandle: () => true, execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }), close: async () => {} };
      },
    }, credentials);
    const base = {
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: [new URL(baseUrl).origin],
    };

    expect(() => controller.run({ ...base, caseId: "missing-case" })).toThrow(/用例不存在/);
    expect(() => controller.run({ ...base, caseId: IDS.sharedCase, envName: "missing-environment" })).toThrow(/未找到环境/);
    expect(secretStore.calls).toHaveLength(0);
    expect(clients).toBe(0);
    expect(received).toHaveLength(0);
    await temp.dispose();
  });

  it("clears failed preparation and registry loads so a subsequent run succeeds", async () => {
    received.length = 0;
    const { session, credentials, temp } = await setup();
    let failPreparation = true;
    const retryCredentials = {
      prepareRunForRequests: async (...args: Parameters<typeof credentials.prepareRunForRequests>) => {
        if (failPreparation) {
          failPreparation = false;
          throw new Error("temporary preparation failure");
        }
        return credentials.prepareRunForRequests(...args);
      },
    };
    const controller = createStressController(session, {}, retryCredentials);
    const stressInput = {
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      caseId: IDS.sharedCase,
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: [new URL(baseUrl).origin],
    };
    const preparationFailure = await controller.run(stressInput).catch((error: unknown) => error);
    expect(preparationFailure).toMatchObject({ name: "Error", message: "temporary preparation failure" });
    expect(received).toHaveLength(0);
    expect((await controller.run(stressInput)).report.totalRequests).toBe(1);
    expect(received).toHaveLength(1);

    received.length = 0;
    let failRegistry = true;
    const registrySource = async () => {
      if (failRegistry) {
        failRegistry = false;
        throw new Error(SECRET);
      }
      return createDefaultRegistry();
    };
    const debugInput = { locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] }, caseId: IDS.sharedCase, envName: "dev" };
    const registryFailure = await sendDebug(session, debugInput, registrySource, credentials).catch((error: unknown) => error);
    expect(registryFailure).toMatchObject({ name: "Error", message: "[REDACTED]" });
    expect(JSON.stringify(registryFailure)).not.toContain(SECRET);
    expect(received).toHaveLength(0);
    expect((await sendDebug(session, debugInput, registrySource, credentials)).outcome.passed).toBe(true);
    expect(received).toHaveLength(1);
    await temp.dispose();
  });

  it("keeps preparation active and cancellation creates no worker or report", async () => {
    const { session, credentials, temp } = await setup();
    let markPreparing: () => void = () => {};
    const preparing = new Promise<void>((resolve) => { markPreparing = resolve; });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let clients = 0;
    const gatedCredentials = {
      prepareRunForRequests: async (...args: Parameters<typeof credentials.prepareRunForRequests>) => {
        const prepared = await credentials.prepareRunForRequests(...args);
        markPreparing();
        await gate;
        return prepared;
      },
    };
    const controller = createStressController(session, {
      createManagedClient: () => {
        clients += 1;
        return { name: "must-not-start", canHandle: () => true, execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }), close: async () => {} };
      },
    }, gatedCredentials);
    const run = controller.run({
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      caseId: IDS.sharedCase,
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: [new URL(baseUrl).origin],
    });
    let stopping: Promise<Awaited<ReturnType<typeof controller.run>>> | undefined;
    try {
      await preparing;
      stopping = controller.stop();
      await expect(controller.run({
        locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
        caseId: IDS.sharedCase,
        concurrency: 1,
        maxIterations: 1,
        confirmedTargetOrigins: [new URL(baseUrl).origin],
      })).rejects.toThrow(/已有压测进行中/);
      release();
      await expect(run).rejects.toThrow(/压测准备已取消/);
      await expect(stopping).rejects.toThrow(/压测准备已取消/);
    } finally {
      release();
      await run.catch(() => undefined);
      await stopping?.catch(() => undefined);
    }
    expect(clients).toBe(0);
    expect(existsSync(join(temp.path, ".apicc", "runs"))).toBe(false);
    await temp.dispose();
  });

  it("keeps a prepared stress run on its captured input, snapshot, root, scope, and credential generation", async () => {
    received.length = 0;
    const { session, secretStore, credentials, temp: originalTemp } = await setup();
    const nextTemp = await makeTempRoot("apicc-execution-credentials-next-");
    const nextWorkspace = makeWorkspace();
    nextWorkspace.id = uuid(3000);
    const nextProject = projectOne(nextWorkspace);
    const nextApi = findApi(nextProject, IDS.deepApi)!;
    nextApi.contract.request.baseUrl = baseUrl;
    nextApi.contract.request.path = "/new-items";
    nextApi.contract.request.auth = { kind: "bearer", token: { ...SECRET_REF } };
    nextProject.environments![0]!.baseUrls[IDS.collectionOne] = baseUrl;
    await persistWorkspace(nextTemp.path, nextWorkspace);

    let markPrepared: () => void = () => {};
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedCredentials = {
      prepareRunForRequests: async (...args: Parameters<typeof credentials.prepareRunForRequests>) => {
        const run = await credentials.prepareRunForRequests(...args);
        markPrepared();
        await gate;
        return run;
      },
    };
    const controller = createStressController(session, {}, gatedCredentials);
    const firstInput = {
      locator: { ...LOCATOR, folderIds: [...LOCATOR.folderIds] },
      caseId: IDS.sharedCase,
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: [new URL(baseUrl).origin],
    };
    const firstRun = controller.run(firstInput);
    try {
      await prepared;
      firstInput.locator.folderIds[0] = uuid(3001);
      const edited = structuredClone(session.locateApi(LOCATOR)!.api);
      edited.contract.request.path = "/edited-during-prepare";
      await session.saveApi(LOCATOR, edited);
      await session.open(nextTemp.path);
      secretStore.replace("desktop-execution-secret-generation-2", "generation-2");
      release();
      const first = await firstRun;
      expect(first.report.totalRequests).toBe(1);
      expect(received[0]).toMatchObject({ path: "/items", authorization: `Bearer ${SECRET}` });
      expect(existsSync(join(originalTemp.path, ".apicc", "runs", first.file!))).toBe(true);
      expect(existsSync(join(nextTemp.path, ".apicc", "runs", first.file!))).toBe(false);

      const second = await controller.run({
        locator: { ...LOCATOR, workspaceId: nextWorkspace.id, folderIds: [...LOCATOR.folderIds] },
        caseId: IDS.sharedCase,
        concurrency: 1,
        maxIterations: 1,
        confirmedTargetOrigins: [new URL(baseUrl).origin],
      });
      expect(second.report.totalRequests).toBe(1);
      expect(received[1]).toMatchObject({ path: "/new-items", authorization: "Bearer desktop-execution-secret-generation-2" });
      expect(existsSync(join(nextTemp.path, ".apicc", "runs", second.file!))).toBe(true);
      expect(secretStore.calls.map((call) => call.generation)).toEqual([
        "generation-1", "generation-1", "generation-1", "generation-1",
        "generation-2", "generation-2", "generation-2", "generation-2",
      ]);
      expect(secretStore.calls.map((call) => call.scope.workspaceId)).toEqual([
        IDS.workspace, IDS.workspace, IDS.workspace, IDS.workspace,
        nextWorkspace.id, nextWorkspace.id, nextWorkspace.id, nextWorkspace.id,
      ]);
    } finally {
      release();
      await firstRun.catch(() => undefined);
      await Promise.all([originalTemp.dispose(), nextTemp.dispose()]);
    }
  });

  it("runs a fully located workflow with the project snapshot credential context", async () => {
    received.length = 0;
    const { session, secretStore, temp, networkPrivateRoot } = await setup();
    const workflowLocator = {
      workspaceId: IDS.workspace,
      groupId: IDS.groupOne,
      projectId: IDS.projectOne,
      workflowId: IDS.workflow,
    };
    const current = session.locateWorkflow(workflowLocator)!.workflow;
    await session.saveWorkflow(workflowLocator, {
      ...current,
      nodes: [{ id: IDS.workflowNode, kind: "request", apiId: IDS.deepApi, caseId: IDS.sharedCase }],
      edges: [],
    });
    await session.setWorkflowStatus(workflowLocator, "published");
    await session.setWorkflowStatus(workflowLocator, "enabled");
    const ipc = createIpcDeps({
      session,
      pickDirectory: async () => temp.path,
      saveFile: async () => "",
      credentials: { secretStore: secretStore.store, networkPrivateRoot },
    });
    const result = await ipc.handle("wf:run", {}, { locator: workflowLocator, envName: "dev", strict: true });

    expect(result.verdict).toBe("passed");
    expect(result.passed).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(secretStore.calls.map((call) => call.method)).toEqual(["version", "resolve", "version", "status"]);
    const files = readdirSync(join(temp.path, ".apicc", "runs")).filter((file) => file.startsWith(`workflow-${IDS.workflow}-`));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(temp.path, ".apicc", "runs", files[0]!), "utf8")).not.toContain(SECRET);
    await temp.dispose();
  });

  it("strict workflow missing references suppress credentials for otherwise valid request nodes", async () => {
    received.length = 0;
    const { session, secretStore, temp, networkPrivateRoot } = await setup();
    const workflowLocator = {
      workspaceId: IDS.workspace,
      groupId: IDS.groupOne,
      projectId: IDS.projectOne,
      workflowId: IDS.workflow,
    };
    const current = session.locateWorkflow(workflowLocator)!.workflow;
    await session.saveWorkflow(workflowLocator, {
      ...current,
      nodes: [
        { id: IDS.workflowNode, kind: "request", apiId: IDS.deepApi, caseId: IDS.sharedCase },
        { id: "missing-request", kind: "request", apiId: "missing-api", caseId: "missing-case" },
      ],
      edges: [],
    });
    await session.setWorkflowStatus(workflowLocator, "published");
    const ipc = createIpcDeps({
      session,
      pickDirectory: async () => temp.path,
      saveFile: async () => "",
      credentials: { secretStore: secretStore.store, networkPrivateRoot },
    });
    const result = await ipc.handle("wf:run", {}, { locator: workflowLocator, strict: true });

    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(received).toHaveLength(0);
    expect(secretStore.calls).toHaveLength(0);
    await temp.dispose();
  });
});
