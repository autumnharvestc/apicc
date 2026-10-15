import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, type CredentialScope, type SecretRef, type SecretStore } from "@apicc/core";
import { createDesktopCredentialHost } from "../../src/main/credentials.js";
import { runCollection, sendDebug } from "../../src/main/debug.js";
import { createStressController } from "../../src/main/stress.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IDS, findApi, makeTempRoot, makeWorkspace, persistWorkspace, projectOne, uuid } from "./helpers/contract-assets.js";

const SECRET_REF: SecretRef = { id: "desktop-run-secret", policy: "test-auto" };
const SECRET = "desktop-execution-secret-8fe2";
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

async function setup() {
  const temp = await makeTempRoot("apicc-execution-credentials-");
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
  const credentials = createDesktopCredentialHost(session, { secretStore: secretStore.store });
  return { temp, session, secretStore, credentials };
}

function waitForNextRequest(): Promise<ObservedRequest> {
  return new Promise((resolve) => { nextRequest = resolve; });
}

describe("desktop execution credential wiring", () => {
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
    const { session, secretStore, temp } = await setup();
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
      credentials: { secretStore: secretStore.store },
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
    const { session, secretStore, temp } = await setup();
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
      credentials: { secretStore: secretStore.store },
    });
    const result = await ipc.handle("wf:run", {}, { locator: workflowLocator, strict: true });

    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(received).toHaveLength(0);
    expect(secretStore.calls).toHaveLength(0);
    await temp.dispose();
  });
});
