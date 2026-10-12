import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ApiAsset } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import { createEventBus } from "../../src/events/bus.js";
import { createHttpClient } from "../../src/http/client.js";
import { createDefaultRegistry, CollectionRunner, WorkflowRunner } from "../../src/index.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import { createStressCaseSession, type StressCaseSessionDeps } from "../../src/stress/caseSession.js";
import type { ExecutableRequest, ScriptContext } from "../../src/plugin/types.js";
import { contractExecutionIds, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";

interface ReceivedRequest {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  globalHeader: string | undefined;
  caseHeader: string | undefined;
  baseTemplateHeader: string | undefined;
  baseVariableHeader: string | undefined;
  baseEnvironmentHeader: string | undefined;
  body: string;
}

const received: ReceivedRequest[] = [];
let server: Server;
let baseUrl = "";
let run: ProjectExecutionRun;
const authorizedStressRequests: ExecutableRequest[] = [];
let afterNextRequest: (() => void) | undefined;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = await readBody(request);
    received.push({
      method: request.method,
      path: request.url,
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      globalHeader: typeof request.headers["x-global"] === "string" ? request.headers["x-global"] : undefined,
      caseHeader: typeof request.headers["x-case"] === "string" ? request.headers["x-case"] : undefined,
      baseTemplateHeader: typeof request.headers["x-base-template"] === "string" ? request.headers["x-base-template"] : undefined,
      baseVariableHeader: typeof request.headers["x-base-variable"] === "string" ? request.headers["x-base-variable"] : undefined,
      baseEnvironmentHeader: typeof request.headers["x-base-environment"] === "string" ? request.headers["x-base-environment"] : undefined,
      body,
    });
    const callback = afterNextRequest;
    afterNextRequest = undefined;
    callback?.();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
  const project = createContractExecutionProject(baseUrl);
  const snapshot = createProjectSnapshot(project);
  const values = Object.freeze({ [contractExecutionIds.credential]: "credential-generation-1" });
  run = {
    snapshot,
    credentialBindings: {
      resolve(ref) {
        if (ref.id !== contractExecutionIds.credential) throw new Error("unexpected credential reference");
        return values[ref.id]!;
      },
      versions: values,
    },
  };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

afterEach(() => {
  afterNextRequest = undefined;
  received.length = 0;
  authorizedStressRequests.length = 0;
});

function executionWithReplaceableWrapper(project: ContractProject) {
  const snapshot = createProjectSnapshot(project);
  const changedProject = structuredClone(project);
  changedProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request.path = "/wrapper-edited/{{folderPath}}/items";
  const changedSnapshot = createProjectSnapshot(changedProject);
  const originalBindings = run.credentialBindings;
  const changedBindings: ProjectExecutionRun["credentialBindings"] = {
    resolve(ref) {
      if (ref.id !== contractExecutionIds.credential) throw new Error("unexpected credential reference");
      return "credential-generation-2";
    },
    versions: { [contractExecutionIds.credential]: "generation-2" },
  };
  const wrapper: ProjectExecutionRun = { snapshot, credentialBindings: originalBindings };
  return {
    wrapper,
    replace() {
      Reflect.set(wrapper, "snapshot", changedSnapshot);
      Reflect.set(wrapper, "credentialBindings", changedBindings);
    },
  };
}

function requestExpectations(receivedRequest: ReceivedRequest) {
  expect(receivedRequest).toMatchObject({
    method: "POST",
    authorization: "Bearer credential-generation-1",
    globalHeader: "global-header",
    caseHeader: "folder",
    baseTemplateHeader: baseUrl,
    baseVariableHeader: baseUrl,
    baseEnvironmentHeader: baseUrl,
    body: `{"region":"environment","ancestor":"folder","baseUrl":"${baseUrl}"}`,
  });
  const requestUrl = new URL(receivedRequest.path ?? "", baseUrl);
  expect(requestUrl.pathname).toBe("/nested/items");
  expect(requestUrl.searchParams.get("global")).toBe("global-value");
  expect(requestUrl.searchParams.get("region")).toBe("environment");
  expect(requestUrl.searchParams.get("baseUrl")).toBe(baseUrl);
}

function replacementRequestExpectations(receivedRequest: ReceivedRequest) {
  expect(receivedRequest.authorization).toBe("Bearer credential-generation-2");
  expect(new URL(receivedRequest.path ?? "", baseUrl).pathname).toBe("/wrapper-edited/nested/items");
  expect(receivedRequest.baseTemplateHeader).toBe(baseUrl);
  expect(receivedRequest.baseVariableHeader).toBe(baseUrl);
  expect(receivedRequest.baseEnvironmentHeader).toBe(baseUrl);
  expect(receivedRequest.body).toBe(`{"region":"environment","ancestor":"folder","baseUrl":"${baseUrl}"}`);
}

interface StressSideEffects {
  scriptRuns: number;
  managedClients: number;
  protocolResolutions: number;
}

function createTrackedStressDeps(registry: ReturnType<typeof createDefaultRegistry>, effects: StressSideEffects): StressCaseSessionDeps {
  const engine = registry.getScriptEngine("javascript")!;
  return {
    resolveProtocol(request) {
      effects.protocolResolutions += 1;
      return registry.getProtocol(request);
    },
    resolveAuth: (kind) => registry.getAuth(kind),
    resolveAssert: (operation) => registry.getAssert(operation),
    scriptEngine: {
      language: engine.language,
      run(code: string, context: ScriptContext) {
        effects.scriptRuns += 1;
        engine.run(code, context);
      },
    },
    createManagedClient() {
      effects.managedClients += 1;
      return createHttpClient({ connectionMode: "fresh" });
    },
  };
}

describe("project snapshot execution consumers", () => {
  it("uses the nearest effective case version for collection, workflow, and stress", async () => {
    received.length = 0;
    authorizedStressRequests.length = 0;
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.baseUrl = baseUrl;
    const environmentOrigin = "http://127.0.0.1:9";
    asset.cases = [
      { id: contractExecutionIds.case, name: "base-version", scope: "base", parameters: { region: "base-parameter" }, preOperations: [{ id: "base-marker", type: "script", content: 'pm.request.headers["X-Case"] = "base";' }], postOperations: [], assertions: [] },
      { id: contractExecutionIds.case, name: "parent-version", scope: "parent", parameters: { region: "parent-parameter" }, preOperations: [{ id: "parent-marker", type: "script", content: 'pm.request.headers["X-Case"] = "parent";' }], postOperations: [], assertions: [] },
      { id: contractExecutionIds.case, name: "child-version", scope: "child", parameters: { region: "child-parameter" }, preOperations: [{ id: "child-marker", type: "script", content: 'pm.request.headers["X-Case"] = "child";' }], postOperations: [], assertions: [] },
    ];
    project.environments = [
      { id: "env-parent", name: "parent", variables: {}, baseUrls: { [contractExecutionIds.collection]: environmentOrigin } },
      { id: "env-child", name: "child", extends: "parent", variables: {}, baseUrls: {} },
    ];
    const selectedRun: ProjectExecutionRun = {
      snapshot: createProjectSnapshot(project),
      credentialBindings: run.credentialBindings,
    };
    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry, bus: createEventBus(), timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 }, failFast: false,
    });

    const collectionResult = await collectionRunner.run(selectedRun, contractExecutionIds.collection, { environmentId: "env-child" });
    const workflowResult = await new WorkflowRunner({ registry, environmentId: "env-child" }).run(selectedRun, contractExecutionIds.workflow);
    const stressSession = createStressCaseSession({
      run: selectedRun,
      collectionId: contractExecutionIds.collection,
      apiId: contractExecutionIds.contract,
      caseId: contractExecutionIds.case,
      environmentId: "env-child",
    }, {
      resolveProtocol: (request) => registry.getProtocol(request),
      resolveAuth: (kind) => registry.getAuth(kind),
      resolveAssert: (op) => registry.getAssert(op),
      scriptEngine: registry.getScriptEngine("javascript")!,
      createManagedClient: () => createHttpClient({ connectionMode: "fresh" }),
    }, {
      workerId: 3, concurrency: 1, confirmedTargetOrigins: [baseUrl],
      authorizeRequest(request) {
        authorizedStressRequests.push({
          ...request,
          headers: { ...request.headers },
          query: request.query.map((entry) => ({ ...entry })),
          auth: { ...request.auth },
        });
      },
    });
    let stressResult;
    try {
      stressResult = await stressSession.execute();
    } finally {
      await stressSession.close();
    }

    expect(collectionResult.cases.map((outcome) => outcome.caseName)).toEqual(["child-version"]);
    expect(workflowResult.failed).toBe(0);
    expect(stressResult.outcome.caseName).toBe("child-version");
    expect(received).toHaveLength(3);
    expect(received.map((request) => request.caseHeader)).toEqual(["child", "child", "child"]);
    expect(authorizedStressRequests.map((request) => new URL(request.url).origin)).toEqual([baseUrl]);
    expect(received.map((request) => new URL(request.path ?? "", baseUrl).searchParams.get("region")))
      .toEqual(["child-parameter", "child-parameter", "child-parameter"]);
  });

  it("runs only the ordered folder path selected for one API when another path reuses a folder id", async () => {
    received.length = 0;
    const project = createContractExecutionProject(baseUrl);
    const collection = project.collections[0]!;
    const selectedFolder = collection.folders[0]!.folders[0]!;
    const rootApi = structuredClone(selectedFolder.apis[0]!);
    rootApi.contract.id = "10000000-0000-4000-8000-000000000009";
    rootApi.contract.request.baseUrl = baseUrl;
    rootApi.contract.request.path = "/root-api";
    rootApi.cases[0]!.id = "root-case";
    collection.apis.push(rootApi);
    selectedFolder.preOperations.push({
      id: "selected-path-marker",
      type: "script",
      content: 'pm.variables.set("selectedPath", "visited");',
    });
    collection.folders.push({
      id: contractExecutionIds.innerFolder,
      name: "unrelated top-level folder",
      preOperations: [{ id: "wrong-path-pre", type: "script", content: 'pm.variables.set("wrongPath", "visited");' }],
      postOperations: [{ id: "wrong-path-post", type: "script", content: 'pm.variables.set("wrongPathPost", "visited");' }],
      folders: [],
      apis: [],
    });
    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry,
      bus: createEventBus(),
      timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 },
      failFast: false,
    });
    const selectedRun: ProjectExecutionRun = {
      snapshot: createProjectSnapshot(project),
      credentialBindings: run.credentialBindings,
    };
    const bridged: Record<string, string> = {};
    const result = await collectionRunner.run(selectedRun, contractExecutionIds.collection, {
      environmentId: contractExecutionIds.environment,
      caseSelection: {
        apiId: contractExecutionIds.contract,
        caseId: contractExecutionIds.case,
        folderIds: [contractExecutionIds.outerFolder, contractExecutionIds.innerFolder],
      },
      runtimeBridge: { get: () => ({}), set: (values) => Object.assign(bridged, values) },
    });

    expect(result.cases.map((outcome) => outcome.caseId)).toEqual([contractExecutionIds.case]);
    expect(received).toHaveLength(1);
    expect(bridged).toMatchObject({ selectedPath: "visited" });
    expect(bridged).not.toHaveProperty("wrongPath");
    expect(bridged).not.toHaveProperty("wrongPathPost");

    received.length = 0;
    const rootSelectionBridge: Record<string, string> = {};
    const rootResult = await collectionRunner.run(selectedRun, contractExecutionIds.collection, {
      environmentId: contractExecutionIds.environment,
      caseSelection: { apiId: rootApi.contract.id, caseId: "root-case", folderIds: [] },
      runtimeBridge: { get: () => ({}), set: (values) => Object.assign(rootSelectionBridge, values) },
    });

    expect(rootResult.cases.map((outcome) => outcome.caseId)).toEqual(["root-case"]);
    expect(received).toHaveLength(1);
    expect(new URL(received[0]!.path ?? "", baseUrl).pathname).toBe("/root-api");
    expect(rootSelectionBridge).not.toHaveProperty("selectedPath");
    expect(rootSelectionBridge).not.toHaveProperty("wrongPath");

    received.length = 0;
    const unselectedBridge: Record<string, string> = {};
    const unselectedResult = await collectionRunner.run(selectedRun, contractExecutionIds.collection, {
      environmentId: contractExecutionIds.environment,
      runtimeBridge: { get: () => ({}), set: (values) => Object.assign(unselectedBridge, values) },
    });

    expect(unselectedResult.cases.map((outcome) => outcome.caseId)).toEqual(["root-case", contractExecutionIds.case]);
    expect(received).toHaveLength(2);
    expect(unselectedBridge).toMatchObject({ selectedPath: "visited", wrongPath: "visited" });
    expect(unselectedBridge).toHaveProperty("wrongPathPost", "visited");
  });

  it("executes a parent-only case through collection, workflow, and stress from the child environment", async () => {
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.baseUrl = baseUrl;
    asset.cases = [{
      ...asset.cases[0]!,
      name: "parent-ancestor-only",
      scope: "parent",
      parameters: { region: "parent-ancestor-parameter" },
      preOperations: [{ id: "parent-only-marker", type: "script", content: 'pm.request.headers["X-Case"] = "parent-ancestor-only";' }],
    }];
    project.environments = [
      { id: "ancestor-parent", name: "parent", variables: {}, baseUrls: { [contractExecutionIds.collection]: baseUrl } },
      { id: "ancestor-child", name: "child", extends: "parent", variables: {}, baseUrls: {} },
    ];
    const selectedRun: ProjectExecutionRun = {
      snapshot: createProjectSnapshot(project),
      credentialBindings: run.credentialBindings,
    };
    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry, bus: createEventBus(), timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 }, failFast: false,
    });

    const collectionResult = await collectionRunner.run(selectedRun, contractExecutionIds.collection, { environmentId: "ancestor-child" });
    const workflowResult = await new WorkflowRunner({ registry, environmentId: "ancestor-child" }).run(selectedRun, contractExecutionIds.workflow);
    const stressSession = createStressCaseSession({
      run: selectedRun,
      collectionId: contractExecutionIds.collection,
      apiId: contractExecutionIds.contract,
      caseId: contractExecutionIds.case,
      environmentId: "ancestor-child",
    }, {
      resolveProtocol: (request) => registry.getProtocol(request),
      resolveAuth: (kind) => registry.getAuth(kind),
      resolveAssert: (op) => registry.getAssert(op),
      scriptEngine: registry.getScriptEngine("javascript")!,
      createManagedClient: () => createHttpClient({ connectionMode: "fresh" }),
    }, {
      workerId: 33, concurrency: 1, confirmedTargetOrigins: [baseUrl],
      authorizeRequest(request) {
        authorizedStressRequests.push({
          ...request,
          headers: { ...request.headers },
          query: request.query.map((entry) => ({ ...entry })),
          auth: { ...request.auth },
        });
      },
    });
    let stressResult;
    try {
      stressResult = await stressSession.execute();
    } finally {
      await stressSession.close();
    }

    expect(collectionResult.cases.map((outcome) => outcome.caseName)).toEqual(["parent-ancestor-only"]);
    expect(workflowResult.nodeResults.map((node) => node.outcome?.caseName)).toEqual(["parent-ancestor-only"]);
    expect(stressResult.outcome.caseName).toBe("parent-ancestor-only");
    expect(received).toHaveLength(3);
    expect(received.map((request) => request.caseHeader)).toEqual([
      "parent-ancestor-only", "parent-ancestor-only", "parent-ancestor-only",
    ]);
    expect(received.map((request) => new URL(request.path ?? "", baseUrl).searchParams.get("region")))
      .toEqual(["parent-ancestor-parameter", "parent-ancestor-parameter", "parent-ancestor-parameter"]);
    expect(authorizedStressRequests.map((request) => new URL(request.url).origin)).toEqual([baseUrl]);
  });

  it("rejects a stress case outside the selected environment before data, containers, client, or transport", () => {
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.cases = [{
      ...asset.cases[0]!,
      scope: "unrelated-environment",
      dataDriver: { sourcePath: "C:/definitely-missing-apicc-effective-case-data.json", format: "json" },
    }];
    project.environments = [
      { id: "env-parent", name: "parent", variables: {}, baseUrls: { [contractExecutionIds.collection]: baseUrl } },
      { id: "env-child", name: "child", extends: "parent", variables: {}, baseUrls: {} },
    ];
    const selectedRun: ProjectExecutionRun = { snapshot: createProjectSnapshot(project), credentialBindings: run.credentialBindings };
    const registry = createDefaultRegistry();
    const effects: StressSideEffects = { scriptRuns: 0, managedClients: 0, protocolResolutions: 0 };

    expect(() => createStressCaseSession({
      run: selectedRun,
      collectionId: contractExecutionIds.collection,
      apiId: contractExecutionIds.contract,
      caseId: contractExecutionIds.case,
      environmentId: "env-child",
    }, createTrackedStressDeps(registry, effects), { workerId: 31, concurrency: 1, confirmedTargetOrigins: [baseUrl] }))
      .toThrow(/不适用于当前环境/);

    expect(effects).toEqual({ scriptRuns: 0, managedClients: 0, protocolResolutions: 0 });
    expect(received).toHaveLength(0);
    expect(authorizedStressRequests).toHaveLength(0);
  });

  it("rejects an unknown stress environment before data, containers, client, or transport", () => {
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.cases[0]!.dataDriver = { sourcePath: "C:/definitely-missing-apicc-effective-case-data.json", format: "json" };
    const selectedRun: ProjectExecutionRun = { snapshot: createProjectSnapshot(project), credentialBindings: run.credentialBindings };
    const registry = createDefaultRegistry();
    const effects: StressSideEffects = { scriptRuns: 0, managedClients: 0, protocolResolutions: 0 };

    expect(() => createStressCaseSession({
      run: selectedRun,
      collectionId: contractExecutionIds.collection,
      apiId: contractExecutionIds.contract,
      caseId: contractExecutionIds.case,
      environmentId: "missing-environment",
    }, createTrackedStressDeps(registry, effects), { workerId: 32, concurrency: 1, confirmedTargetOrigins: [baseUrl] }))
      .toThrow(/不存在环境 missing-environment/);

    expect(effects).toEqual({ scriptRuns: 0, managedClients: 0, protocolResolutions: 0 });
    expect(received).toHaveLength(0);
    expect(authorizedStressRequests).toHaveLength(0);
  });

  it("keeps old effective scope and environment values in a frozen run while a new run sees edits", async () => {
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.baseUrl = "";
    asset.contract.request.query.push({
      kind: "inline", id: "10000000-0000-4000-8000-000000000009", name: "envMarker",
      schema: { kind: "scalar", type: "string" }, required: false, enabled: true,
      description: "inherited environment marker", value: "{{envMarker}}",
    });
    asset.cases = [
      { ...asset.cases[0]!, name: "base-version", scope: "base", parameters: { region: "base-value" }, preOperations: [{ id: "base-marker", type: "script", content: 'pm.request.headers["X-Case"] = "base";' }] },
      { ...asset.cases[0]!, name: "parent-version", scope: "parent", parameters: { region: "parent-old" }, preOperations: [{ id: "parent-marker", type: "script", content: 'pm.request.headers["X-Case"] = "parent";' }] },
      { ...asset.cases[0]!, name: "child-version", scope: "child", parameters: { region: "child-old" }, preOperations: [{ id: "child-marker", type: "script", content: 'pm.request.headers["X-Case"] = "child";' }] },
    ];
    project.environments = [
      { id: "env-parent", name: "parent", variables: { envMarker: "old-environment" }, baseUrls: { [contractExecutionIds.collection]: baseUrl } },
      { id: "env-child", name: "child", extends: "parent", variables: {}, baseUrls: {} },
    ];
    const oldRun: ProjectExecutionRun = { snapshot: createProjectSnapshot(project), credentialBindings: run.credentialBindings };
    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry, bus: createEventBus(), timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 }, failFast: false,
    });
    const oldResult = await collectionRunner.run(oldRun, contractExecutionIds.collection, { environmentId: "env-child" });

    const updatedRequests: ReceivedRequest[] = [];
    const updatedServer = createServer(async (request, response) => {
      const body = await readBody(request);
      updatedRequests.push({
        method: request.method,
        path: request.url,
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        globalHeader: typeof request.headers["x-global"] === "string" ? request.headers["x-global"] : undefined,
        caseHeader: typeof request.headers["x-case"] === "string" ? request.headers["x-case"] : undefined,
        baseTemplateHeader: typeof request.headers["x-base-template"] === "string" ? request.headers["x-base-template"] : undefined,
        baseVariableHeader: typeof request.headers["x-base-variable"] === "string" ? request.headers["x-base-variable"] : undefined,
        baseEnvironmentHeader: typeof request.headers["x-base-environment"] === "string" ? request.headers["x-base-environment"] : undefined,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => updatedServer.listen(0, "127.0.0.1", resolve));
    const updatedBaseUrl = `http://127.0.0.1:${(updatedServer.address() as { port: number }).port}`;
    asset.cases[1]!.parameters = { region: "parent-new" };
    asset.cases[2]!.scope = "unrelated-environment";
    project.environments[0]!.variables.envMarker = "new-environment";
    project.environments[0]!.baseUrls[contractExecutionIds.collection] = updatedBaseUrl;
    let newResult: Awaited<ReturnType<typeof collectionRunner.run>>;
    let oldSnapshotAgainResult: Awaited<ReturnType<typeof collectionRunner.run>>;
    try {
      const newRun: ProjectExecutionRun = { snapshot: createProjectSnapshot(project), credentialBindings: run.credentialBindings };
      newResult = await collectionRunner.run(newRun, contractExecutionIds.collection, { environmentId: "env-child" });
      oldSnapshotAgainResult = await collectionRunner.run(oldRun, contractExecutionIds.collection, { environmentId: "env-child" });
    } finally {
      await new Promise<void>((resolve, reject) => updatedServer.close((error) => error ? reject(error) : resolve()));
    }

    expect(oldResult.cases.map((outcome) => outcome.caseName)).toEqual(["child-version"]);
    expect(newResult.cases.map((outcome) => outcome.caseName)).toEqual(["parent-version"]);
    expect(oldSnapshotAgainResult.cases.map((outcome) => outcome.caseName)).toEqual(["child-version"]);
    const requestsInRunOrder = [received[0]!, updatedRequests[0]!, received[1]!];
    expect(requestsInRunOrder.map((request) => request.caseHeader)).toEqual(["child", "parent", "child"]);
    const queryValues = requestsInRunOrder.map((request) => {
      const query = new URL(request.path ?? "", baseUrl).searchParams;
      return [query.get("region"), query.get("envMarker"), query.get("baseUrl")];
    });
    expect(queryValues).toEqual([
      ["child-old", "old-environment", baseUrl],
      ["parent-new", "new-environment", updatedBaseUrl],
      ["child-old", "old-environment", baseUrl],
    ]);
  });

  it("uses one frozen contract, environment, ancestor operations, globals, and bindings through collection, workflow, and stress", async () => {
    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry,
      bus: createEventBus(),
      timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 },
      failFast: false,
    });
    const collectionResult = await collectionRunner.run(run, contractExecutionIds.collection, { environmentId: contractExecutionIds.environment });
    expect(collectionResult).toMatchObject({ total: 1, failed: 0 });

    const workflowRunner = new WorkflowRunner({ registry, environmentId: contractExecutionIds.environment });
    const workflowResult = await workflowRunner.run(run, contractExecutionIds.workflow);
    expect(workflowResult).toMatchObject({ failed: 0 });

    const project = run.snapshot.project;
    const collection = project.collections[0]!;
    const asset = collection.folders[0]!.folders[0]!.apis[0]!;
    const session = createStressCaseSession({
        run,
        collectionId: contractExecutionIds.collection,
        apiId: asset.contract.id,
        caseId: contractExecutionIds.case,
        environmentId: contractExecutionIds.environment,
    }, {
        resolveProtocol: (request) => registry.getProtocol(request),
        resolveAuth: (kind) => registry.getAuth(kind),
        resolveAssert: (op) => registry.getAssert(op),
        scriptEngine: registry.getScriptEngine("javascript")!,
        createManagedClient: () => createHttpClient({ connectionMode: "fresh" }),
    }, {
        workerId: 0,
        concurrency: 1,
        confirmedTargetOrigins: [baseUrl],
      authorizeRequest(request) {
        authorizedStressRequests.push({
          ...request,
          headers: { ...request.headers },
          query: request.query.map((entry) => ({ ...entry })),
          auth: { ...request.auth },
        });
      },
      });
    const stressResult = await session.execute();
    await session.close();
    expect(stressResult.outcome.passed).toBe(true);

    const authorized = authorizedStressRequests.at(-1)!;
    expect(authorized.url).toBe(`${baseUrl}/nested/items`);
    expect(authorized.headers).toMatchObject({ Authorization: "Bearer credential-generation-1", "X-Global": "global-header", "X-Case": "folder" });
    expect(authorized.query.map(({ key, value }) => [key, value])).toEqual([["global", "global-value"], ["region", "environment"], ["baseUrl", baseUrl]]);

    expect(received).toHaveLength(3);
    for (const receivedRequest of received) requestExpectations(receivedRequest);
  });

  it("pins the chosen snapshot and bindings across every case in an active collection run", async () => {
    received.length = 0;
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.cases.push({ ...asset.cases[0]!, id: "case-two", name: "second-case" });
    const execution = executionWithReplaceableWrapper(project);
    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry, bus: createEventBus(), timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 }, failFast: false,
    });
    afterNextRequest = execution.replace;

    const result = await collectionRunner.run(execution.wrapper, contractExecutionIds.collection, { environmentId: contractExecutionIds.environment });

    expect(result).toMatchObject({ total: 2, failed: 0 });
    expect(received).toHaveLength(2);
    for (const request of received) requestExpectations(request);

    const newRunResult = await collectionRunner.run(execution.wrapper, contractExecutionIds.collection, { environmentId: contractExecutionIds.environment });
    expect(newRunResult).toMatchObject({ total: 2, failed: 0 });
    expect(received).toHaveLength(4);
    for (const request of received.slice(2)) replacementRequestExpectations(request);
  });

  it("pins the chosen snapshot and bindings across request nodes in an active workflow run", async () => {
    received.length = 0;
    const project = createContractExecutionProject(baseUrl);
    project.workflows[0]!.nodes = [
      { id: "first", kind: "request", apiId: contractExecutionIds.contract, caseId: contractExecutionIds.case },
      { id: "second", kind: "request", apiId: contractExecutionIds.contract, caseId: contractExecutionIds.case },
    ];
    project.workflows[0]!.edges = [{ id: "first-to-second", from: "first", to: "second", condition: "prev.passed" }];
    const execution = executionWithReplaceableWrapper(project);
    const registry = createDefaultRegistry();
    const workflowRunner = new WorkflowRunner({ registry, environmentId: contractExecutionIds.environment });
    afterNextRequest = execution.replace;

    const result = await workflowRunner.run(execution.wrapper, contractExecutionIds.workflow);

    expect(result).toMatchObject({ total: 2, failed: 0 });
    expect(received).toHaveLength(2);
    for (const request of received) requestExpectations(request);

    const newRunResult = await workflowRunner.run(execution.wrapper, contractExecutionIds.workflow);
    expect(newRunResult).toMatchObject({ total: 2, failed: 0 });
    expect(received).toHaveLength(4);
    for (const request of received.slice(2)) replacementRequestExpectations(request);
  });

  it("pins the chosen snapshot and bindings for the lifetime of an active stress session", async () => {
    received.length = 0;
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const execution = executionWithReplaceableWrapper(project);
    const registry = createDefaultRegistry();
    const session = createStressCaseSession({
      run: execution.wrapper,
      collectionId: contractExecutionIds.collection,
      apiId: asset.contract.id,
      caseId: contractExecutionIds.case,
      environmentId: contractExecutionIds.environment,
    }, {
      resolveProtocol: (request) => registry.getProtocol(request),
      resolveAuth: (kind) => registry.getAuth(kind),
      resolveAssert: (op) => registry.getAssert(op),
      scriptEngine: registry.getScriptEngine("javascript")!,
      createManagedClient: () => createHttpClient({ connectionMode: "fresh" }),
    }, { workerId: 1, concurrency: 1, confirmedTargetOrigins: [baseUrl] });
    afterNextRequest = execution.replace;

    expect((await session.execute()).outcome.passed).toBe(true);
    expect((await session.execute()).outcome.passed).toBe(true);
    await session.close();

    expect(received).toHaveLength(2);
    for (const request of received) requestExpectations(request);

    const newSession = createStressCaseSession({
      run: execution.wrapper,
      collectionId: contractExecutionIds.collection,
      apiId: asset.contract.id,
      caseId: contractExecutionIds.case,
      environmentId: contractExecutionIds.environment,
    }, {
      resolveProtocol: (request) => registry.getProtocol(request),
      resolveAuth: (kind) => registry.getAuth(kind),
      resolveAssert: (op) => registry.getAssert(op),
      scriptEngine: registry.getScriptEngine("javascript")!,
      createManagedClient: () => createHttpClient({ connectionMode: "fresh" }),
    }, { workerId: 2, concurrency: 1, confirmedTargetOrigins: [baseUrl] });
    expect((await newSession.execute()).outcome.passed).toBe(true);
    await newSession.close();
    expect(received).toHaveLength(3);
    replacementRequestExpectations(received[2]!);
  });

  it("keeps an existing run on its frozen definition revision while a later run sees the edit", async () => {
    received.length = 0;
    const source = createContractExecutionProject(baseUrl);
    const oldSnapshot = createProjectSnapshot(source);
    const oldRevision = oldSnapshot.definitionRevision;
    const makeRun = (snapshot: ProjectExecutionRun["snapshot"]): ProjectExecutionRun => ({
      snapshot,
      credentialBindings: run.credentialBindings,
    });
    const oldRun = makeRun(oldSnapshot);
    const mutableAsset = source.collections[0]!.folders[0]!.folders[0]!.apis[0]! as ApiAsset;
    mutableAsset.contract.request.path = "/edited/{{folderPath}}/items";
    const newSnapshot = createProjectSnapshot(source);
    const newRun = makeRun(newSnapshot);
    expect(newSnapshot.definitionRevision).not.toBe(oldRevision);
    expect(oldSnapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request.path).toBe("/{{folderPath}}/items");
    expect(newSnapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request.path).toBe("/edited/{{folderPath}}/items");

    const registry = createDefaultRegistry();
    const collectionRunner = new CollectionRunner({
      registry,
      bus: createEventBus(),
      timeouts: { connectTimeoutMs: 2_000, totalTimeoutMs: 3_000 },
      failFast: false,
    });
    expect(await collectionRunner.run(oldRun, contractExecutionIds.collection, { environmentId: contractExecutionIds.environment })).toMatchObject({ total: 1, failed: 0 });
    expect(await collectionRunner.run(newRun, contractExecutionIds.collection, { environmentId: contractExecutionIds.environment })).toMatchObject({ total: 1, failed: 0 });
    expect(received.map(({ path }) => new URL(path ?? "", baseUrl).pathname)).toEqual([
      "/nested/items",
      "/edited/nested/items",
    ]);
    expect(received.map(({ path }) => new URL(path ?? "", baseUrl).searchParams.get("baseUrl"))).toEqual([baseUrl, baseUrl]);
  });
});
