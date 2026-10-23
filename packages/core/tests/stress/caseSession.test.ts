import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApiAsset, RequestBody } from "../../src/contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../../src/contract/workspace.js";
import type { Assertion, Environment, KeyValuePair, Operation, TestCase as ContractTestCase } from "../../src/domain/common.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { prepareTestData, testDataSelectionsForRequests } from "../../src/testing/data.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import { createStressCaseSession as createSnapshotStressCaseSession, type StressCaseSessionDeps, type StressCaseTarget } from "../../src/stress/caseSession.js";
import type { ManagedProtocolClient } from "../../src/http/client.js";
import type { ExecutableRequest, ExecutionResponse } from "../../src/plugin/types.js";
import { createStressCaseVuSession } from "../../src/stress/caseSession.js";
import { createStressAccumulator } from "../../src/stress/metrics.js";
import { legacyStressMetricPlan, StressRunner } from "../../src/stress/runner.js";
import { createStressRequestGate } from "../../src/stress/requestGate.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";
import type { StressClock, StressVuHostContext } from "../../src/stress/execution.js";

const response: ExecutionResponse = { status: 200, headers: {}, bodyText: '{"ok":true}', timeMs: 1 };

interface FixtureCase extends Omit<ContractTestCase, "preOperations" | "postOperations"> {
  preScript?: string;
  postScript?: string;
  preOperations?: Operation[];
  postOperations?: Operation[];
}
type TestCase = FixtureCase;
interface FixtureApi {
  id: string;
  name: string;
  version?: string;
  deprecated?: boolean;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  headers?: KeyValuePair[];
  query?: KeyValuePair[];
  body?: RequestBody;
  protocol?: "http" | "websocket" | "soap";
  message?: string;
  envelope?: string;
  soapAction?: string;
  auth?: { type: "none" } | { type: "bearer"; token: string } | { type: "basic"; username: string; password: string } | { type: "apikey"; key?: string; name?: string; value: string; placement: "header" | "query" };
  cases?: FixtureCase[];
}
interface FixtureFolder {
  id: string;
  name: string;
  apis: FixtureApi[];
  folders: FixtureFolder[];
  preOperations?: Operation[];
  postOperations?: Operation[];
}
interface FixtureCollection extends FixtureFolder {
  variables: Record<string, string>;
}
type Folder = FixtureFolder;
type Collection = FixtureCollection;
interface FixtureProject {
  id: string;
  name: string;
  variables: Record<string, string>;
  environments: Environment[];
  stressPolicy: { trustedOrigins: string[]; deniedOrigins?: string[] };
}
type Project = FixtureProject;
interface FixtureTarget {
  api: FixtureApi;
  testCase: FixtureCase;
  project: FixtureProject;
  collection: FixtureCollection;
  env?: Environment;
  collectionId?: string;
  apiId?: string;
}

const api: FixtureApi = {
  id: "api-1", name: "orders", version: "1.0.0", deprecated: false, method: "GET", url: "http://trusted.example/orders/{{row}}?vu={{counter}}&row={{row}}",
  headers: [], query: [], cases: [], protocol: "http",
};

const project: FixtureProject = {
  id: "project-1", name: "project", variables: {}, environments: [],
  stressPolicy: { trustedOrigins: ["http://trusted.example"], deniedOrigins: [] },
};
const collection: FixtureCollection = { id: "collection-1", name: "collection", variables: {}, folders: [], apis: [api] };
const target = (testCase: FixtureCase, sourcePath?: string): FixtureTarget => ({
  api, testCase: sourcePath ? { ...testCase, dataDriver: { sourcePath, format: "csv" as const } } : testCase,
  project, collection,
});

function stableId(kind: string, value: string): string {
  const hex = createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function fixtureOperations(testCase: FixtureCase, phase: "pre" | "post"): Operation[] {
  const operations = phase === "pre" ? testCase.preOperations : testCase.postOperations;
  const script = phase === "pre" ? testCase.preScript : testCase.postScript;
  if (operations) return operations;
  return script === undefined ? [] : [{ id: stableId("case-operation", `${testCase.id}:${phase}`), type: "script", content: script }];
}

function fixtureApiAsset(source: FixtureApi, credentials: Map<string, string>, selectedCase?: FixtureCase): ApiAsset {
  const contractId = stableId("api", source.id);
  const [withoutQuery, initialQuery] = source.url.split("?", 2);
  let rawQuery = initialQuery;
  let baseUrl = "{{baseUrl}}";
  let path = withoutQuery ?? source.url;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)$/.exec(path);
  if (match) {
    baseUrl = match[1]!;
    path = match[2] || "/";
  } else if (path.startsWith("{{baseUrl}}")) {
    path = path.slice("{{baseUrl}}".length) || "/";
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path.trim())) {
    try {
      const parsed = new URL(path.trim());
      baseUrl = parsed.origin;
      path = parsed.pathname;
      rawQuery ??= parsed.search.slice(1);
    } catch { /* Preserve malformed URL as a relative path for pre-I/O config validation. */ }
  } else if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const urlQuery: KeyValuePair[] = rawQuery
    ? rawQuery.split("&").filter(Boolean).map((entry) => {
      const [key, ...parts] = entry.split("=");
      return { key: decodeURIComponent(key ?? ""), value: decodeURIComponent(parts.join("=")), enabled: true };
    })
    : [];
  const query = [...(source.query ?? []), ...urlQuery].map((entry, index) => ({
    kind: "inline" as const,
    id: stableId(`parameter:query:${contractId}`, String(index)),
    name: entry.key,
    schema: { kind: "scalar" as const, type: "string" as const },
    required: false,
    enabled: entry.enabled,
    description: "",
    value: entry.value,
  }));
  const headers = (source.headers ?? []).map((entry, index) => ({
    kind: "inline" as const,
    id: stableId(`parameter:header:${contractId}`, String(index)),
    name: entry.key,
    schema: { kind: "scalar" as const, type: "string" as const },
    required: false,
    enabled: entry.enabled,
    description: "",
    value: entry.value,
  }));
  const secret = (name: string, value: string) => {
    const id = stableId("credential", `${source.id}:${name}`);
    credentials.set(id, value);
    return { id, policy: "test-auto" as const };
  };
  let auth: Record<string, unknown>;
  switch (source.auth?.type) {
    case "bearer": auth = { kind: "bearer", token: secret("bearer", source.auth.token) }; break;
    case "basic": auth = { kind: "basic", username: secret("username", source.auth.username), password: secret("password", source.auth.password) }; break;
    case "apikey": auth = { kind: "apikey", name: source.auth.name ?? source.auth.key ?? "X-API-Key", placement: source.auth.placement, value: secret("apikey", source.auth.value) }; break;
    default: auth = { kind: "none" };
  }
  const protocol = source.protocol;
  const common = { baseUrl, path, pathParams: [], query, headers, cookies: [], auth };
  const request = protocol === undefined
    ? { method: source.method, ...common, body: source.body ?? { kind: "none" } }
    : protocol === "websocket"
      ? { protocol, ...common, ...(source.message === undefined ? {} : { message: source.message }) }
      : protocol === "soap"
        ? { protocol, method: "POST" as const, ...common, envelope: source.envelope ?? "<Envelope/>", ...(source.soapAction === undefined ? {} : { soapAction: source.soapAction }) }
        : { protocol, method: source.method, ...common, body: source.body ?? { kind: "none" as const } };
  const cases = [...(source.cases ?? [])];
  if (selectedCase) {
    const index = cases.findIndex(({ id }) => id === selectedCase.id);
    if (index < 0) cases.push(selectedCase);
    else cases[index] = selectedCase;
  }
  return {
    contract: {
      formatVersion: 1,
      id: contractId,
      metadata: { name: source.name, description: "", tags: [], version: source.version ?? "1", status: source.deprecated ? "deprecated" : "draft" },
      request: request as unknown as ApiAsset["contract"]["request"],
      responses: [],
    },
    cases: cases.map((testCase) => ({
      id: testCase.id,
      name: testCase.name,
      scope: testCase.scope,
      parameters: testCase.parameters,
      preOperations: fixtureOperations(testCase, "pre"),
      postOperations: fixtureOperations(testCase, "post"),
      assertions: testCase.assertions,
      ...(testCase.extractors === undefined ? {} : { extractors: testCase.extractors }),
      ...(testCase.dataDriver === undefined ? {} : { dataDriver: testCase.dataDriver }),
    })),
    documentation: "",
  };
}

function fixtureCollection(source: FixtureCollection, targetApi: FixtureApi, selectedCase: FixtureCase, credentials: Map<string, string>): ContractCollection {
  const transformFolder = (folder: FixtureFolder, parentPath: string): ContractFolder => {
    const path = `${parentPath}/${folder.id}`;
    return {
      id: stableId(`folder:${path}`, folder.id),
      name: folder.name,
      preOperations: folder.preOperations ?? [],
      postOperations: folder.postOperations ?? [],
      folders: folder.folders.map((nested) => transformFolder(nested, path)),
      apis: folder.apis.map((asset) => fixtureApiAsset(asset.id === targetApi.id ? targetApi : asset, credentials, asset.id === targetApi.id ? selectedCase : undefined)),
    };
  };
  const collectionId = stableId("collection", source.id);
  return {
    id: collectionId,
    name: source.name,
    variables: source.variables,
    preOperations: source.preOperations ?? [],
    postOperations: source.postOperations ?? [],
    folders: source.folders.map((folder) => transformFolder(folder, source.id)),
    apis: source.apis.map((asset) => fixtureApiAsset(asset.id === targetApi.id ? targetApi : asset, credentials, asset.id === targetApi.id ? selectedCase : undefined)),
  };
}

function createProjectExecutionTarget(target: FixtureTarget): StressCaseTarget {
  const credentials = new Map<string, string>();
  const collectionAsset = fixtureCollection(target.collection, target.api, target.testCase, credentials);
  const environments = new Map<string, Environment>();
  for (const environment of target.project.environments) environments.set(environment.id, environment);
  if (target.env) environments.set(target.env.id, target.env);
  const environmentDefinitions = [...environments.values()].map((environment) => {
    const configuredBaseUrl = environment.baseUrls[target.collection.id];
    return {
      ...environment,
      id: stableId("environment", environment.id),
      baseUrls: configuredBaseUrl === undefined ? {} : { [collectionAsset.id]: configuredBaseUrl },
    };
  });
  const projectDefinition: ContractProject = {
    id: stableId("project", target.project.id),
    name: target.project.name,
    variables: target.project.variables,
    globals: { query: [], headers: [], cookies: [], body: [] },
    environments: environmentDefinitions,
    collections: [collectionAsset],
    workflows: [],
    stressPolicy: target.project.stressPolicy,
    models: [],
    components: [],
  };
  const snapshot = createProjectSnapshot(projectDefinition);
  const bindingVersions = Object.fromEntries([...credentials.keys()].map((id) => [id, "fixture-v1"]));
  const execution: ProjectExecutionRun = {
    snapshot,
    credentialBindings: {
      resolve: (ref) => {
        const value = credentials.get(ref.id);
        if (value === undefined) throw new Error(`Missing fixture credential ${ref.id}`);
        return value;
      },
      versions: bindingVersions,
    },
  };
  return {
    run: execution,
    collectionId: target.collectionId ?? collectionAsset.id,
    apiId: target.apiId ?? stableId("api", target.api.id),
    caseId: target.testCase.id,
    ...(target.env === undefined ? {} : { environmentId: stableId("environment", target.env.id) }),
  };
}

function createStressCaseSession(target: FixtureTarget, deps: StressCaseSessionDeps, options: Parameters<typeof createSnapshotStressCaseSession>[2]) {
  return createSnapshotStressCaseSession(createProjectExecutionTarget(target), deps, options);
}

async function prepareTargetData(target: StressCaseTarget): Promise<StressCaseTarget> {
  const snapshot = target.run.snapshot;
  const requests: import("../../src/credentials/output.js").CredentialRequestSelection[] = [];
  const visit = (container: typeof snapshot.project.collections[number] | typeof snapshot.project.collections[number]["folders"][number]): void => {
    for (const asset of container.apis) requests.push({ asset });
    for (const folder of container.folders) visit(folder);
  };
  for (const collection of snapshot.project.collections) visit(collection);
  const preparedTestData = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, requests, target.environmentId), { workspaceRoot: tmpdir() });
  return { ...target, run: { ...target.run, preparedTestData } };
}

function deps(seen: string[], close: () => Promise<void>, created: (workerId: number) => ManagedProtocolClient): StressCaseSessionDeps {
  const client: ManagedProtocolClient = {
    name: "fake", canHandle: () => true,
    execute: vi.fn(async (request: ExecutableRequest) => {
      const enabledQuery = request.query.filter(({ enabled }) => enabled);
      const query = enabledQuery.map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
      seen.push(`${request.url}${query ? `?${query}` : ""}`);
      return response;
    }),
    close,
  };
  return {
    createManagedClient: (workerId) => { created(workerId); return client; },
    resolveProtocol: () => client,
    resolveAuth: () => undefined,
    resolveAssert: (op) => op === "eq" ? { op, evaluate: (actual, expected) => ({ pass: String(actual) === expected, message: "status" }) } : undefined,
    scriptEngine: {
      language: "javascript",
      run(code, ctx) {
        if (code === "increment") {
          const next = Number(ctx.pm.variables.get("counter") ?? "0") + 1;
          ctx.pm.variables.set("counter", String(next));
          const counter = ctx.pm.request.query.find(({ key }) => key === "vu");
          if (counter) counter.value = String(next);
        }
        if (code === "assert-row") ctx.pm.assert(ctx.pm.request.query.some(({ key }) => key === "row"), "row present");
      },
    },
    timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
  };
}

describe("createStressCaseSession", () => {
  it("F6 fix I-1 shares the global rate between a real managed case session and an opaque callback", async () => {
    // Two independent limiters would grant both paths their first permit at time zero.
    const prepared = await prepareTargetData(createProjectExecutionTarget(target({ id: "case-1", name: "case", scope: "base", parameters: { row: "A", counter: "0" }, assertions: [] })));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      const starts: number[] = [];
      const selected = deps([], async () => {}, () => ({ name: "unused", canHandle: () => true, execute: async () => response, close: async () => {} }));
      selected.createManagedClient = () => ({ name: "controlled", canHandle: () => true,
        async execute() { starts.push(performance.now()); return response; }, async close() {} });
      const runner = new StressRunner({ createWorker(workerId, context) {
        if (workerId === 0) return createSnapshotStressCaseSession(prepared, { ...selected, requestGate: context!.requestGate }, { workerId });
        return { async execute() {
          starts.push(performance.now());
          return { request: { protocol: "http", method: "GET", url: "http://trusted.example/opaque", headers: {}, query: [], auth: { kind: "none" } }, response,
            requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: true, requestCompleted: true,
            outcome: { apiId: "opaque-api", apiName: "opaque", caseId: "opaque-case", caseName: "opaque", passed: true, durationMs: 1, assertions: [] } };
        }, async close() {} };
      } });
      const run = runner.run({ concurrency: 2, maxIterations: 2, maxRps: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      const report = await run;
      expect(starts).toEqual([0, 1000]);
      expect(report.totalRequests).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it("F6 planned case VU observes real case/hop facts and preserves initial runtime variables", async () => {
    // Returning only the logical iteration result would lose every real case and hop.
    const prepared = await prepareTargetData(createProjectExecutionTarget(target({ id: "case-1", name: "case", scope: "base", parameters: {}, preScript: "increment", assertions: [] })));
    const metrics = createStressAccumulator(legacyStressMetricPlan, "planned-case");
    const clock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep: async () => {} };
    const gate = createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} });
    const host: StressVuHostContext = { runId: "planned-case", vuId: "vu-1", clock, gate, signal: new AbortController().signal, lifecycle: undefined,
      observation: () => ({ phase: "measurement", atMs: 2 }), observe: metrics.observe, reportLifecycle: () => ({}) };
    const seen: string[] = []; let closes = 0;
    const selected = deps(seen, async () => { closes++; }, () => ({ name: "unused", canHandle: () => true, execute: async () => response, close: async () => {} }));
    selected.createManagedClient = () => ({ name: "observable", canHandle: () => true, async execute(request, opts) {
      if (request.protocol !== "http") throw new Error("Fixture only supports HTTP");
      seen.push(`${request.url}?${request.query.map((entry) => `${entry.key}=${entry.value}`).join("&")}`);
      await opts.runtime?.observe?.({ type: "request", hopIndex: 0, request, url: request.url, method: request.method });
      await opts.runtime?.observe?.({ type: "response", hopIndex: 0, url: request.url, status: 200, headers: {}, rawHeaders: [], encodedBytes: 11, decodedBytes: 11,
        bodyComplete: true, bodyBytes: new TextEncoder().encode('{"ok":true}'), textAvailable: true, jsonAvailable: true, bodyText: '{"ok":true}',
        requestBody: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true }, requestBodyChain: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true } });
      return response;
    }, async close() { closes++; } });
    const session = createStressCaseVuSession(prepared, selected, { workerId: 0, host, evidence: createExecutionEvidenceCollector({ projectId: prepared.run.snapshot.project.id, definitionRevision: prepared.run.snapshot.definitionRevision }, []), initialInputs: { counter: "41", row: "A" } });
    const result = await session.execute({ runId: "planned-case", vuId: "vu-1", iterationId: "1", stageId: null, phase: "measurement", scheduledOffsetMs: 0, signal: host.signal, observation: host.observation, observe: host.observe });
    await session.close({ reason: "iteration-budget", signal: host.signal, allowNetworkCleanup: true });
    expect(result.state).toBe("passed");
    expect(seen[0]).toContain("vu=42");
    expect(metrics.snapshot().observations).toMatchObject({ caseRows: { total: 1, ok: 1 }, requests: { started: 1, completed: 1, eligibleCompleted: 1 }, httpExchanges: { started: 1, completed: 1 } });
    expect(closes).toBe(1);
  });
  it("B1 固定准备快照并隔离每个 session 的变量和 0/1/0 数据游标", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-session-"));
    const dataPath = join(dir, "rows.csv");
    writeFileSync(dataPath, "row\nA\nB\n");
    const testCase: TestCase = {
      id: "case-1", name: "case", scope: "base", parameters: {},
      preOperations: [{ id: "increment", type: "script", content: "increment" }],
      postOperations: [{ id: "assert-row", type: "script", content: "assert-row" }],
      assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }],
    };
    const seen: string[] = [];
    const close = vi.fn(async (): Promise<void> => {});
    const created = vi.fn((_: number): ManagedProtocolClient => ({ name: "fake", canHandle: () => true, execute: async () => response, close }));
    const sharedTarget = await prepareTargetData(createProjectExecutionTarget(target(testCase, dataPath)));
    writeFileSync(dataPath, "row\nNEW\n");
    const sharedRevision = sharedTarget.run.snapshot.definitionRevision;
    const sessionA = createSnapshotStressCaseSession(sharedTarget, deps(seen, close, created), { workerId: 0 });
    const sessionB = createSnapshotStressCaseSession(sharedTarget, deps(seen, close, created), { workerId: 1 });

    expect((await sessionA.execute()).outcome.row).toBe(0);
    expect((await sessionA.execute()).outcome.row).toBe(1);
    expect((await sessionA.execute()).outcome.row).toBe(0);
    expect((await sessionB.execute()).outcome.passed).toBe(true);
    expect((await sessionB.execute()).outcome.passed).toBe(true);
    expect(seen).toEqual([
      "http://trusted.example/orders/A?vu=1&row=A", "http://trusted.example/orders/B?vu=2&row=B",
      "http://trusted.example/orders/A?vu=3&row=A",
      "http://trusted.example/orders/A?vu=1&row=A", "http://trusted.example/orders/B?vu=2&row=B",
    ]);
    expect(created).toHaveBeenCalledTimes(2);
    expect(sharedTarget.run.snapshot.definitionRevision).toBe(sharedRevision);
    await Promise.all([sessionA.close(), sessionA.close(), sessionB.close()]);
    expect(close).toHaveBeenCalledTimes(2);
    const nextTarget = await prepareTargetData(createProjectExecutionTarget(target(testCase, dataPath)));
    expect(nextTarget.run.preparedTestData!.digest).not.toBe(sharedTarget.run.preparedTestData!.digest);
    const next = createSnapshotStressCaseSession(nextTarget, deps(seen, close, created), { workerId: 2 });
    const result = await next.execute();
    expect(result.outcome.row).toBe(0);
    expect(seen.at(-1)).toBe("http://trusted.example/orders/NEW?vu=1&row=NEW");
    await next.close();
  });

  it("在发包前对最终请求执行授权，拒绝时不触发协议 I/O", async () => {
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "fake", canHandle: () => true, execute, close: async () => {} };
    const baseDeps: StressCaseSessionDeps = {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    };
    const session = createStressCaseSession(target(testCase), baseDeps, {
      workerId: 0,
      authorizeRequest(request) {
        expect(request.url).toBe("http://trusted.example/orders/{{row}}");
        expect(request.query.map(({ key }) => key)).toEqual(["vu", "row"]);
        throw new Error("target rejected");
      },
    });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(false);
    expect(result.failureKind).toBe("config");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "/relative/orders"],
    ["http", "ftp://example.com/orders"],
    [undefined, "/relative/orders"],
    [undefined, "ftp://example.com/orders"],
  ] as const)("缺失 protocol 在快照配置阶段拒绝；无效 HTTP(S) URL 在 dispatch 前 config 拒绝：%s %s", async (protocol, url) => {
    const execute = vi.fn(async () => response);
    const resolveProtocol = vi.fn((): ManagedProtocolClient => ({ name: "registry", canHandle: () => true, execute, close: async () => {} }));
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const invalidApi = { ...api, protocol, url };
    const source = {
      ...target(testCase), api: invalidApi, collection: { ...collection, apis: [invalidApi] },
    };
    const sessionDeps = {
      createManagedClient: () => managed,
      resolveProtocol,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    };
    if (protocol === undefined) {
      expect(() => createStressCaseSession(source, sessionDeps, { workerId: 0 })).toThrow(/valid contract project definition/);
      expect(resolveProtocol).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    const session = createStressCaseSession(source, sessionDeps, { workerId: 0 });
    const result = await session.execute();
    expect(result.failureKind).toBe("config");
    expect(result.outcome.passed).toBe(false);
    expect(resolveProtocol).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("显式 WebSocket 协议使用 WSS 并直达 registry，不套 HTTP allow-target", async () => {
    const managedExecute = vi.fn(async () => response);
    const pluginExecute = vi.fn(async (request: ExecutableRequest) => {
      expect(request.url).toBe("wss://plugin.example/orders");
      return response;
    });
    const plugin: ManagedProtocolClient = { name: "plugin", canHandle: () => true, execute: pluginExecute, close: async () => {} };
    const resolveProtocol = vi.fn(() => plugin);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute: managedExecute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const pluginApi = { ...api, protocol: "websocket" as const, url: "WSS://Plugin.Example/orders" };
    const session = createStressCaseSession({
      ...target(testCase), api: pluginApi, collection: { ...collection, apis: [pluginApi] },
    }, {
      createManagedClient: () => managed,
      resolveProtocol,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(true);
    expect(resolveProtocol).toHaveBeenCalledTimes(1);
    expect(pluginExecute).toHaveBeenCalledTimes(1);
    expect(managedExecute).not.toHaveBeenCalled();
    expect(result.safety).toBeUndefined();
  });

  it("数据、脚本和认证改写最终 origin 后仍由 authorizeRequest 拒绝且不发包", async () => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const sourcePath = join(mkdtempSync(join(tmpdir(), "apicc-origin-")), "rows.csv");
    const testCase: TestCase = {
      id: "case-1", name: "case", scope: "base", parameters: {},
      dataDriver: { sourcePath, format: "csv" }, assertions: [],
      preScript: "rewrite-origin",
    };
    writeFileSync(sourcePath, "host\nforbidden.example\n");
    const originApi = { ...api, url: "https://allowed.example/{{host}}", auth: { type: "bearer" as const, token: "{{token}}", placement: "header" as const } };
    const preparedTarget = await prepareTargetData(createProjectExecutionTarget({ ...target(testCase), api: originApi, collection: { ...collection, apis: [originApi] } }));
    const session = createSnapshotStressCaseSession(preparedTarget, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => ({ type: "bearer", apply(request) { request.headers.Authorization = "Bearer final-token"; } }),
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code, ctx) { if (code === "rewrite-origin") ctx.pm.request.url = "https://forbidden.example/final"; } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, {
      workerId: 0,
      authorizeRequest(request) {
        expect(request.url).toBe("https://forbidden.example/final");
        expect(request.headers.Authorization).toBe("Bearer final-token");
        throw new Error("target rejected");
      },
    });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("每次执行都在最终请求前进行安全裁定，脚本改 origin 被拒绝且不触发 I/O", async () => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, preScript: "rewrite", assertions: [] };
    const safeApi = { ...api, url: "https://trusted.example/orders" };
    const session = createStressCaseSession({
      ...target(testCase), api: safeApi, collection: { ...collection, apis: [safeApi] },
      project: { ...project, stressPolicy: { trustedOrigins: ["https://trusted.example"] } },
    }, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code, ctx) { if (code === "rewrite") ctx.pm.request.url = "https://untrusted.example/final"; } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, concurrency: 1 });
    const result = await session.execute();
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("目标需要确认");
    expect(execute).not.toHaveBeenCalled();
  });

  it("HTTP session client 不处理 WS，协议 registry fallback 仍可执行", async () => {
    let managedCalls = 0;
    let registryCalls = 0;
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute: async () => { managedCalls += 1; return { ...response, status: 201 }; }, close: async () => {} };
    const plugin: ManagedProtocolClient = { name: "ws-plugin", canHandle: () => true, execute: async () => { registryCalls += 1; return response; }, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const wsApi = { ...api, url: "wss://plugin.example/orders", protocol: "websocket" as const, message: "hello" };
    const session = createStressCaseSession({ ...target(testCase), api: wsApi, collection: { ...collection, apis: [wsApi] } }, {
      createManagedClient: () => managed,
      resolveProtocol: () => plugin,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins: ["https://plugin.example"] });
    expect((await session.execute()).outcome.passed).toBe(true);
    expect(managedCalls).toBe(0);
    expect(registryCalls).toBe(1);
    await session.close();
  });

  it("显式 SOAP/HTTPS 委托 registry，不误用 session HTTP client", async () => {
    let managedCalls = 0;
    let registryCalls = 0;
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute: async () => { managedCalls += 1; return { ...response, status: 201 }; }, close: async () => {} };
    const soap: ManagedProtocolClient = { name: "soap", canHandle: () => true, execute: async () => { registryCalls += 1; return response; }, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const soapApi = { ...api, protocol: "soap" as const, method: "POST" as const, url: "https://soap.example", envelope: "<Envelope/>" };
    const session = createStressCaseSession({ ...target(testCase), api: soapApi, collection: { ...collection, apis: [soapApi] } }, {
      createManagedClient: () => managed,
      resolveProtocol: () => soap,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins: ["https://soap.example"] });
    expect((await session.execute()).outcome.passed).toBe(true);
    expect(managedCalls).toBe(0);
    expect(registryCalls).toBe(1);
    await session.close();
  });

  it("SOAP 的 HTTPS 最终目标同样在协议 I/O 前执行安全裁定", async () => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "session-http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const soapApi = {
      ...api, protocol: "soap" as const, method: "POST" as const,
      url: "https://soap-untrusted.example/orders", envelope: "<Envelope/>",
    };
    const session = createStressCaseSession({
      ...target(testCase), api: soapApi, collection: { ...collection, apis: [soapApi] },
    }, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    const result = await session.execute();
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("target_confirmation_required");
    expect(result.safety).toMatchObject({ origin: "https://soap-untrusted.example", confirmation: "rejected" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["http:127.0.0.1:18080/orders", "http://127.0.0.1:18080"],
    ["https:example.com/orders", "https://example.com"],
  ])("特殊 HTTP(S) URL 仍按 WHATWG origin 安全裁定（%s）", async (url, origin) => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const specialApi = { ...api, url };
    const session = createStressCaseSession({
      ...target(testCase), api: specialApi, collection: { ...collection, apis: [specialApi] },
    }, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    const result = await session.execute();
    expect(result.failureKind).toBe("config");
    expect(result.safety).toMatchObject({ origin, confirmation: "rejected", policy: "target_confirmation_required" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("特殊 HTTP(S) URL 精确确认规范化 origin 后可执行，确认不匹配仍拒绝", async () => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const specialApi = { ...api, url: "https:example.com/orders" };
    const make = (confirmedTargetOrigins: string[]) => createStressCaseSession({
      ...target(testCase), api: specialApi, collection: { ...collection, apis: [specialApi] },
    }, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins });
    const denied = await make(["https://other.example"]).execute();
    expect(denied.failureKind).toBe("config");
    expect(denied.safety).toMatchObject({ origin: "https://example.com", confirmation: "rejected" });
    expect(execute).not.toHaveBeenCalled();
    const allowed = await make(["HTTPS://EXAMPLE.COM:443/"]).execute();
    expect(allowed.outcome.passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("特殊 SOAP URL 在静态/脚本动态改写时都先安全裁定，denied 优先且 I/O 为零", async () => {
    const execute = vi.fn(async () => response);
    const resolveProtocol = vi.fn((): ManagedProtocolClient => ({
      name: "soap", canHandle: () => true, execute, close: async () => {},
    }));
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, preScript: "rewrite", assertions: [] };
    const soapApi = {
      ...api, protocol: "soap" as const, method: "POST" as const,
      url: "https:example.com/orders", envelope: "<Envelope/>",
    };
    const session = createStressCaseSession({
      ...target(testCase), api: soapApi, collection: { ...collection, apis: [soapApi] },
      project: { ...project, stressPolicy: { trustedOrigins: ["https://example.com"], deniedOrigins: ["https://example.com"] } },
    }, {
      createManagedClient: () => ({ name: "session-http", canHandle: () => true, execute, close: async () => {} }),
      resolveProtocol,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code, ctx) { if (code === "rewrite") ctx.pm.request.url = "https:example.com/rewritten"; } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins: ["https://example.com"] });
    const result = await session.execute();
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toContain("target_denied");
    expect(result.safety).toMatchObject({ origin: "https://example.com", confirmation: "rejected", policy: "target_denied" });
    expect(resolveProtocol).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("特殊 SOAP URL 精确确认规范化 origin 后执行协议客户端", async () => {
    const execute = vi.fn(async () => response);
    const soap: ManagedProtocolClient = { name: "soap", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const soapApi = {
      ...api, protocol: "soap" as const, method: "POST" as const,
      url: "https:example.com/orders", envelope: "<Envelope/>",
    };
    const session = createStressCaseSession({
      ...target(testCase), api: soapApi, collection: { ...collection, apis: [soapApi] },
    }, {
      createManagedClient: () => ({ name: "session-http", canHandle: () => true, execute: async () => response, close: async () => {} }),
      resolveProtocol: () => soap,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins: ["HTTPS://EXAMPLE.COM:443/"] });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["http", "https:example.com/orders", "https://example.com/orders", "https://example.com"],
    ["http", "\thttps:example.com/orders \n", "https://example.com/orders", "https://example.com"],
    ["http", String.raw`https:\example.com\orders`, "https://example.com/orders", "https://example.com"],
    ["soap", "https:example.com/orders", "https://example.com/orders", "https://example.com"],
    ["soap", "\thttps:example.com/orders \n", "https://example.com/orders", "https://example.com"],
    ["soap", String.raw`https:\example.com\orders`, "https://example.com/orders", "https://example.com"],
  ] as const)("WHATWG special %s URL %s canonicalization retains safety decisions", async (protocol, url, canonicalUrl, origin) => {
    const execute = vi.fn(async () => response);
    const resolveProtocol = vi.fn((): ManagedProtocolClient => ({ name: protocol, canHandle: () => true, execute, close: async () => {} }));
    const managed: ManagedProtocolClient = { name: "session-http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const specialApi = {
      ...api,
      protocol,
      method: protocol === "soap" ? "POST" as const : api.method,
      url,
      ...(protocol === "soap" ? { envelope: "<Envelope/>" } : {}),
    };
      const specialCollection = { ...collection, apis: [specialApi] };
    const make = (stressPolicy: Project["stressPolicy"], confirmedTargetOrigins?: string[]) => createStressCaseSession({
      ...target(testCase), api: specialApi, collection: specialCollection,
      project: { ...project, stressPolicy },
    }, {
      createManagedClient: () => managed,
      resolveProtocol,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins });

    const unconfirmed = await make({ trustedOrigins: [], deniedOrigins: [] }).execute();
    expect(unconfirmed.failureKind).toBe("config");
    expect(unconfirmed.safety).toMatchObject({ origin, confirmation: "rejected", policy: "target_confirmation_required" });
    expect(execute).not.toHaveBeenCalled();
    expect(resolveProtocol).not.toHaveBeenCalled();

    const denied = await make({ trustedOrigins: [], deniedOrigins: [origin] }, [origin]).execute();
    expect(denied.failureKind).toBe("config");
    expect(denied.safety).toMatchObject({ origin, confirmation: "rejected", policy: "target_denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(resolveProtocol).not.toHaveBeenCalled();

    const allowed = await make({ trustedOrigins: [], deniedOrigins: [] }, [origin]).execute();
    expect(allowed.outcome.passed).toBe(true);
    expect(allowed.safety).toMatchObject({ origin, confirmation: "explicit" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ url: canonicalUrl }), expect.anything());
    if (protocol === "soap") expect(resolveProtocol).toHaveBeenCalledTimes(1);
    else expect(resolveProtocol).not.toHaveBeenCalled();
  });

  it("collection/env baseUrl 存在时普通 relative URL 通过 WHATWG new URL 按 base 解析", async () => {
    const execute = vi.fn(async () => response);
    const managed: ManagedProtocolClient = { name: "http", canHandle: () => true, execute, close: async () => {} };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const relativeApi = { ...api, url: "orders" };
    const env: Environment = {
      id: "env-1", name: "dev", variables: {},
      baseUrls: { [collection.id]: "https://base.example/api/v1" },
    };
    const session = createStressCaseSession({
      ...target(testCase), api: relativeApi, collection: { ...collection, apis: [relativeApi] }, env,
      project: { ...project, stressPolicy: { trustedOrigins: [], deniedOrigins: [] } },
    }, {
      createManagedClient: () => managed,
      resolveProtocol: () => managed,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0, confirmedTargetOrigins: ["https://base.example"] });
    const result = await session.execute();
    expect(result.outcome.passed).toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ url: "https://base.example/api/v1/orders" }), expect.anything());
  });

  it("内置 SOAP 非绝对 HTTP(S) URL 在 I/O 前 config 失败，不调用 registry", async () => {
    const resolveProtocol = vi.fn((): ManagedProtocolClient => ({ name: "soap", canHandle: () => true, execute: async () => response, close: async () => {} }));
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const soapApi = { ...api, protocol: "soap" as const, method: "POST" as const, url: "not-an-absolute-url", envelope: "<Envelope/>" };
    const session = createStressCaseSession({
      ...target(testCase), api: soapApi, collection: { ...collection, apis: [soapApi] },
    }, {
      createManagedClient: () => ({ name: "session-http", canHandle: () => true, execute: async () => response, close: async () => {} }),
      resolveProtocol,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run() {} },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    const result = await session.execute();
    expect(result.failureKind).toBe("config");
    expect(result.outcome.error).toMatch(/invalid|URL/i);
    expect(resolveProtocol).not.toHaveBeenCalled();
  });

  it("B1 旧空数据源提示 fallback，缺少准备或来源错误拒绝", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-session-empty-"));
    const dataPath = join(dir, "empty.csv");
    writeFileSync(dataPath, "row\n");
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const seen: string[] = [];
    const close = vi.fn(async () => {});
    const created = vi.fn();
    const preparedTarget = await prepareTargetData(createProjectExecutionTarget(target(testCase, dataPath)));
    expect(preparedTarget.run.preparedTestData!.sources[0]!.diagnostics[0]!.code).toBe("legacy-empty-fallback");
    const session = createSnapshotStressCaseSession(preparedTarget, deps(seen, close, created), { workerId: 0 });
    await session.execute();
    await session.execute();
    expect(seen).toHaveLength(2);
    expect(() => createStressCaseSession(target(testCase, join(dir, "missing.csv")), deps([], close, created), { workerId: 1 })).toThrow();
    const failed = await prepareTargetData(createProjectExecutionTarget(target(testCase, join(dir, "missing.csv"))));
    expect(() => createSnapshotStressCaseSession(failed, deps([], close, created), { workerId: 1 })).toThrow(/无法读取/);
    await session.close();
  });

  it("按 collection 到 folder 的外到内执行容器前置，并在 close 内到外执行后置", async () => {
    const events: string[] = [];
    const outer: Folder = {
      id: "outer", name: "outer", apis: [], folders: [],
      preOperations: [{ id: "outer-pre", type: "script", content: "outer-pre" }],
      postOperations: [{ id: "outer-post", type: "script", content: "outer-post" }],
    };
    const inner: Folder = {
      id: "inner", name: "inner", apis: [api], folders: [],
      preOperations: [{ id: "inner-pre", type: "script", content: "inner-pre" }],
      postOperations: [{ id: "inner-post", type: "script", content: "inner-post" }],
    };
    outer.folders = [inner];
    const containerCollection: Collection = {
      ...collection, apis: [], folders: [outer],
      preOperations: [{ id: "collection-pre", type: "script", content: "collection-pre" }],
      postOperations: [{ id: "collection-post", type: "script", content: "collection-post" }],
    };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const seen: string[] = [];
    const close = vi.fn(async (): Promise<void> => {});
    const created = vi.fn((_: number): ManagedProtocolClient => ({ name: "fake", canHandle: () => true, execute: async (request) => { seen.push(request.url); return response; }, close }));
    const session = createStressCaseSession({ ...target(testCase), collection: containerCollection }, {
      ...deps(seen, close, created),
      scriptEngine: { language: "javascript", run(code, ctx) { events.push(code); ctx.pm.variables.set("scope", code); } },
    }, { workerId: 0 });
    await session.execute();
    await session.close();
    expect(events).toEqual(["collection-pre", "outer-pre", "inner-pre", "inner-post", "outer-post", "collection-post"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it("严格区分直属、唯一 folder、未找到和多重匹配 API", async () => {
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const base = deps([], async () => {}, vi.fn());
    const direct = createStressCaseSession(target(testCase), base, { workerId: 0 });
    await direct.close();
    const nestedApi = { ...api, id: "nested-api" };
    const nested: Folder = { id: "nested", name: "nested", apis: [nestedApi], folders: [] };
    const nestedSession = createStressCaseSession({ ...target(testCase), api: nestedApi, collection: { ...collection, apis: [], folders: [nested] } }, base, { workerId: 1 });
    await nestedSession.close();
    const missingApi = { ...api, id: "missing-api" };
    expect(() => createStressCaseSession({ ...target(testCase), api: missingApi, collection: { ...collection, apis: [], folders: [] } }, base, { workerId: 2 })).toThrow(/未找到/);
    const duplicateA = { ...api, id: "duplicate-api" };
    expect(() => createStressCaseSession({ ...target(testCase), api: duplicateA, collection: { ...collection, apis: [], folders: [
      { id: "a", name: "a", apis: [duplicateA], folders: [] }, { id: "b", name: "b", apis: [duplicateA], folders: [] },
    ] } }, base, { workerId: 3 })).toThrow(/多个/);
    const directAndNested = { ...api, id: "direct-and-nested" };
    expect(() => createStressCaseSession({ ...target(testCase), api: directAndNested, collection: { ...collection, apis: [directAndNested], folders: [
      { id: "nested-match", name: "nested-match", apis: [directAndNested], folders: [] },
    ] } }, base, { workerId: 4 })).toThrow(/多个/);
  });

  it("直属 API 的 collection hooks 只执行一次且不重复容器链", async () => {
    const events: string[] = [];
    const directCollection: Collection = {
      ...collection,
      preOperations: [
        { id: "collection-script-pre", type: "script", content: "collection-script-pre" },
        { id: "collection-pre", type: "script", content: "collection-pre" },
      ],
      postOperations: [
        { id: "collection-post", type: "script", content: "collection-post" },
        { id: "collection-script-post", type: "script", content: "collection-script-post" },
      ],
    };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const client: ManagedProtocolClient = {
      name: "http",
      canHandle: () => true,
      execute: async () => { events.push("request"); return response; },
      close: async () => {},
    };
    const session = createStressCaseSession({ ...target(testCase), collection: directCollection }, {
      createManagedClient: () => client,
      resolveProtocol: () => client,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code) { events.push(code); } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });

    await session.execute();
    await session.close();

    expect(events).toEqual([
      "collection-script-pre", "collection-pre", "request",
      "collection-post", "collection-script-post",
    ]);
  });

  it("stress target 只能按快照 collectionId/apiId 定位真实祖先路径", async () => {
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const folder: Folder = { id: "folder", name: "folder", apis: [api], folders: [] };
    const base = deps([], async () => {}, vi.fn());
    const nestedCollection: Collection = { ...collection, apis: [], folders: [folder] };
    const nestedSession = createStressCaseSession({ ...target(testCase), collection: nestedCollection }, base, { workerId: 0 });
    await nestedSession.close();
    expect(() => createStressCaseSession({ ...target(testCase), collectionId: stableId("collection", "missing") }, base, { workerId: 1 })).toThrow(/不存在集合/);
    expect(() => createStressCaseSession({ ...target(testCase), apiId: stableId("api", "missing") }, base, { workerId: 2 })).toThrow(/未找到/);
    const noApiFolder: Folder = { ...folder, id: "no-api", apis: [] };
    const linkedCollection: Collection = { ...collection, apis: [], folders: [noApiFolder] };
    expect(() => createStressCaseSession({ ...target(testCase), collection: linkedCollection }, base, { workerId: 3 })).toThrow(/未找到/);
  });

  it("teardown best-effort：inner/outer/client 均失败时仍完整清理并抛首错", async () => {
    const events: string[] = [];
    const inner: Folder = { id: "inner", name: "inner", apis: [api], folders: [], postOperations: [{ id: "inner-post", type: "script", content: "inner" }] };
    const outer: Folder = { id: "outer", name: "outer", apis: [], folders: [inner], postOperations: [{ id: "outer-post", type: "script", content: "outer" }] };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const client: ManagedProtocolClient = { name: "http", canHandle: () => true, execute: async () => response, close: async () => { events.push("client"); throw new Error("client error"); } };
    const session = createStressCaseSession({ ...target(testCase), collection: { ...collection, apis: [], folders: [outer] } }, {
      createManagedClient: () => client,
      resolveProtocol: () => client,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code) { events.push(code); if (code === "inner") throw new Error("inner error"); if (code === "outer") throw new Error("outer error"); } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    await expect(session.close()).rejects.toThrow("inner error");
    expect(events).toEqual(["inner", "outer", "client"]);
  });

  it("同一容器每个 post operation 与 scripts.post 都尝试，falsy 首错仍保留", async () => {
    const events: string[] = [];
    const inner: Folder = { id: "inner-falsy", name: "inner-falsy", apis: [api], folders: [],
      postOperations: [
        { id: "first", type: "script", content: "first" },
        { id: "second", type: "script", content: "second" },
      ] };
    const collectionWithHooks: Collection = {
      ...collection, apis: [], folders: [inner],
      postOperations: [
        { id: "collection-post", type: "script", content: "collection-post" },
        { id: "collection-script", type: "script", content: "collection-script" },
      ],
    };
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const client: ManagedProtocolClient = { name: "http", canHandle: () => true, execute: async () => response, close: async () => { events.push("client"); throw "client-error"; } };
    const session = createStressCaseSession({ ...target(testCase), collection: collectionWithHooks }, {
      createManagedClient: () => client,
      resolveProtocol: () => client,
      resolveAuth: () => undefined,
      resolveAssert: () => undefined,
      scriptEngine: { language: "javascript", run(code) { events.push(code); if (code === "first") throw undefined; } },
      timeouts: { connectTimeoutMs: 100, totalTimeoutMs: 100 },
    }, { workerId: 0 });
    await expect(session.close()).rejects.toBeUndefined();
    expect(events).toEqual(["first", "second", "collection-post", "collection-script", "client"]);
  });

  it("每个 session 通过 factory 获取不同 managed client，HTTP 不回退共享 client", async () => {
    const clients: ManagedProtocolClient[] = [];
    const closeCounts: number[] = [];
    const factory = vi.fn((workerId: number): ManagedProtocolClient => {
      const client: ManagedProtocolClient = {
        name: `client-${workerId}`, canHandle: () => true,
        execute: async () => ({ ...response, headers: { "x-vu": String(workerId) } }),
        close: async () => { closeCounts[workerId] = (closeCounts[workerId] ?? 0) + 1; },
      };
      clients.push(client);
      return client;
    });
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [
      { id: "vu", target: "header", headerName: "x-vu", op: "eq", expected: "{{extractedVU}}" },
    ], extractors: [{ id: "vu", name: "extractedVU", method: "value", selector: { target: "header", headerName: "x-vu" } }],
    preOperations: [{ id: "prior", type: "script", content: "prior-vu" }] };
    const previous: Array<string | undefined> = [];
    const base = { ...deps([], async () => {}, vi.fn()), scriptEngine: { language: "javascript", run(_code: string, ctx: { pm: import("../../src/plugin/types.js").PmApi }) { previous.push(ctx.pm.variables.get("extractedVU")); } } };
    const sessionA = createStressCaseSession(target(testCase), { ...base, createManagedClient: factory }, { workerId: 0 });
    const sessionB = createStressCaseSession(target(testCase), { ...base, createManagedClient: factory }, { workerId: 1 });
    const first = await Promise.all([sessionA.execute(), sessionB.execute()]);
    expect(first.map((result) => result.outcome.passed)).toEqual([true, true]);
    const second = await Promise.all([sessionA.execute(), sessionB.execute()]);
    expect(second.map((result) => result.outcome.passed)).toEqual([true, true]);
    expect(previous).toEqual([undefined, undefined, "0", "1"]);
    expect(clients[0]).not.toBe(clients[1]);
    await Promise.all([sessionA.close(), sessionA.close(), sessionB.close(), sessionB.close()]);
    expect(closeCounts).toEqual([1, 1]);
  });

  it("从快照推导真实嵌套路径，不依赖调用方传入的容器链", async () => {
    const testCase: TestCase = { id: "case-1", name: "case", scope: "base", parameters: {}, assertions: [] };
    const sameIdInner: Folder = { id: "same-id", name: "inner", apis: [api], folders: [] };
    const sameIdOuter: Folder = { id: "same-id", name: "outer", apis: [], folders: [sameIdInner] };
    const linkedCollection: Collection = { ...collection, apis: [], folders: [sameIdOuter] };
    const base = deps([], async () => {}, vi.fn());
    const session = createStressCaseSession({ ...target(testCase), collection: linkedCollection }, base, { workerId: 0 });
    await session.close();
    const duplicateApi = { ...api, id: "duplicate-snapshot-api" };
    const duplicateCollection: Collection = { ...collection, apis: [], folders: [
      { id: "first", name: "first", apis: [duplicateApi], folders: [] },
      { id: "second", name: "second", apis: [duplicateApi], folders: [] },
    ] };
    expect(() => createStressCaseSession({ ...target(testCase), api: duplicateApi, collection: duplicateCollection }, base, { workerId: 1 })).toThrow(/多个容器路径/);
  });
});
