import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StressReportSchema,
  type ApiAsset,
  type GeneratorMetricsCollector,
  type ProtocolClient,
} from "@apicc/core";
import { createSession, sameName } from "../../src/main/session.js";
import { createStressController } from "../../src/main/stress.js";
import {
  findApi,
  IDS,
  makeTempRoot,
  makeWorkspace,
  persistWorkspace,
  projectOne,
  uuid,
} from "./helpers/contract-assets.js";
import type { ApiLocator } from "../../src/shared/locations.js";

const temporaryRoots: Array<() => Promise<void>> = [];

async function tempRoot(): Promise<{ path: string; dispose: () => Promise<void> }> {
  const temporary = await makeTempRoot("apicc-session-");
  temporaryRoots.push(temporary.dispose);
  return temporary;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((dispose) => dispose()));
});

const projectLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const apiLocator: ApiLocator = {
  ...projectLocator,
  collectionId: IDS.collectionOne,
  folderIds: [],
  apiId: IDS.sharedApi,
};

type TestStressApi = ApiAsset & { id: string; locator: ApiLocator };

function apiWithLocator(session: ReturnType<typeof createSession>, locator: ApiLocator): TestStressApi {
  const located = session.locateApi(locator);
  if (!located) throw new Error(`Stress fixture API not found: ${locator.apiId}`);
  return Object.assign(located.api, { id: located.api.contract.id, locator });
}

async function setupStress() {
  const temporary = await tempRoot();
  const workspace = makeWorkspace();
  const project = projectOne(workspace);
  const api = findApi(project, IDS.sharedApi)!;
  api.contract.request.baseUrl = "http://127.0.0.1:1";
  api.contract.request.auth = { kind: "none" };
  api.cases = [{
    id: IDS.sharedCase,
    name: "smoke",
    scope: "base",
    parameters: {},
    preOperations: [],
    postOperations: [],
    assertions: [],
  }];
  project.environments[0]!.baseUrls[IDS.collectionOne] = "http://127.0.0.1:1";
  await persistWorkspace(temporary.path, workspace);
  const session = createSession();
  await session.open(temporary.path);
  return { s: session, dir: temporary.path, api: apiWithLocator(session, apiLocator) };
}

describe("formal Session transactions", () => {
  it("creates a formal workspace with one default group and a committed revision", async () => {
    const temporary = await tempRoot();
    const unopened = createSession();
    expect(() => unopened.locateApi(apiLocator)).toThrow(/尚未打开工作区/);
    const session = createSession();

    const created = await session.create(temporary.path, "演示");
    const reopened = await session.open(temporary.path);

    expect(created.workspace.name).toBe("演示");
    expect(reopened.workspace.groups).toHaveLength(1);
    expect(reopened.workspace.groups[0]).toMatchObject({ name: "默认分组", default: true });
    expect(reopened.root).toBe(temporary.path);
    expect(reopened.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a smoke case through full locators and explicitly deletes only that API asset", async () => {
    const temporary = await tempRoot();
    const session = createSession();
    const opened = await session.create(temporary.path, "delete API");
    const workspaceLocator = { workspaceId: opened.workspace.id };
    const group = opened.workspace.groups[0]!;
    const project = await session.createProject({ ...workspaceLocator, groupId: group.id }, "project");
    const projectRef = { ...workspaceLocator, groupId: group.id, projectId: project.id };
    const collection = await session.createCollection(projectRef, "collection");
    const collectionRef = { ...projectRef, collectionId: collection.id };
    const api = await session.createApi(collectionRef, { name: "ping", baseUrl: "https://example.test", path: "/x" });
    const locator: ApiLocator = { ...collectionRef, folderIds: [], apiId: api.contract.id };
    const apiDir = join(temporary.path, "groups", group.id, "projects", project.id, "collections", collection.id, "apis", api.contract.id);

    expect(api.cases).toHaveLength(1);
    expect(api.cases[0]!.scope).toBe("base");
    expect(session.locateApi(locator)?.api).toEqual(api);
    expect(existsSync(apiDir)).toBe(true);
    await session.deleteNode({ kind: "api", locator });

    expect(session.locateApi(locator)).toBeUndefined();
    expect(existsSync(join(apiDir, "api.yaml"))).toBe(false);
    const reopened = createSession();
    await reopened.open(temporary.path);
    expect(reopened.locateApi(locator)).toBeUndefined();
  });

  it("saves the complete ApiAsset and observes it after reopening", async () => {
    const temporary = await tempRoot();
    await persistWorkspace(temporary.path, makeWorkspace());
    const session = createSession();
    await session.open(temporary.path);
    const edited = session.locateApi(apiLocator)!.api;
    edited.contract.request.path = "/changed";
    edited.documentation = "# saved design";

    await session.saveApi(apiLocator, edited);
    const reopened = createSession();
    await reopened.open(temporary.path);

    expect(reopened.locateApi(apiLocator)?.api).toMatchObject({
      contract: { request: { path: "/changed" } },
      documentation: "# saved design",
    });
  });

  it("rejects deletion of an unknown group through the asynchronous transaction API", async () => {
    const temporary = await tempRoot();
    await persistWorkspace(temporary.path, makeWorkspace());
    const session = createSession();
    await session.open(temporary.path);

    await expect(session.deleteNode({
      kind: "group",
      locator: { workspaceId: IDS.workspace, groupId: uuid(9999) },
    })).rejects.toThrow(/not found|未找到/i);
  });

  it("inherits environment variables and persists environment, collection base URLs, and project globals", async () => {
    const temporary = await tempRoot();
    await persistWorkspace(temporary.path, makeWorkspace());
    const session = createSession();
    await session.open(temporary.path);
    const environment = await session.createEnvironment(projectLocator, { name: "sit", extends: "dev" });
    const environmentRef = { ...projectLocator, environmentId: environment.id };

    await session.setEnvironmentVariables(environmentRef, { baseUrl: "https://sit.example.test", token: "t" });
    await session.setEnvironmentBaseUrls(environmentRef, { [IDS.collectionOne]: "https://sit.example.test" });
    await expect(session.setEnvironmentBaseUrls({ ...environmentRef, environmentId: uuid(9997) }, {}))
      .rejects.toThrow(/Environment not found/);
    const globals = {
      variables: { region: "qa" },
      query: [{ key: "region", value: "qa", enabled: true }],
      headers: [{ key: "x-project", value: "qa", enabled: false }],
      cookies: [],
      body: [{ key: "mode", value: "test", enabled: true }],
    };
    await session.setProjectGlobals(projectLocator, globals);
    const reopened = createSession();
    await reopened.open(temporary.path);

    expect(reopened.locateEnvironment(environmentRef)?.environment).toMatchObject({
      name: "sit",
      extends: "dev",
      variables: { baseUrl: "https://sit.example.test", token: "t" },
      baseUrls: { [IDS.collectionOne]: "https://sit.example.test" },
    });
    expect(reopened.getProjectGlobals(projectLocator)).toEqual(globals);
  });

  it("rejects an invalid stress policy without committing a revision", async () => {
    const temporary = await tempRoot();
    await persistWorkspace(temporary.path, makeWorkspace());
    const session = createSession();
    await session.open(temporary.path);
    const before = session.workspace;
    const revision = session.revision;

    await expect(session.setStressPolicy(projectLocator, { maxRps: 0 })).rejects.toThrow(/maxRps|positive|正数/i);

    expect(session.workspace).toEqual(before);
    expect(session.revision).toBe(revision);
  });

  it("renames a workflow without changing its identity, then explicitly deletes it", async () => {
    const temporary = await tempRoot();
    await persistWorkspace(temporary.path, makeWorkspace());
    const session = createSession();
    await session.open(temporary.path);
    const workflow = await session.createWorkflow(projectLocator, "旧名");
    const workflowRef = { ...projectLocator, workflowId: workflow.id };
    await session.renameWorkflow(workflowRef, "新名");
    expect(session.locateWorkflow(workflowRef)?.workflow.id).toBe(workflow.id);
    const reopened = createSession();
    await reopened.open(temporary.path);
    expect(reopened.locateWorkflow(workflowRef)?.workflow.name).toBe("新名");

    await reopened.deleteWorkflow(workflowRef);
    expect(reopened.locateWorkflow(workflowRef)).toBeUndefined();
  });

  it("sanitizes node names while allowing same-name siblings with distinct identities", async () => {
    const temporary = await tempRoot();
    const created = await createSession().create(temporary.path, "name workspace");
    const session = createSession();
    await session.open(temporary.path);
    const workspaceRef = { workspaceId: created.workspace.id };
    const group = await session.createGroup(workspaceRef, "  ");
    const duplicateGroup = await session.createGroup(workspaceRef, "  ");
    expect(group.id).not.toBe(duplicateGroup.id);
    expect(group.name).toBe("未命名");
    const workspace = session.workspace;
    if (!workspace) throw new Error("Created workspace is not open");
    expect(workspace.groups.filter((item) => item.name === group.name)).toHaveLength(2);

    const project = await session.createProject({ ...workspaceRef, groupId: group.id }, "pr:oj");
    const duplicateProject = await session.createProject({ ...workspaceRef, groupId: group.id }, "pr:oj");
    expect(duplicateProject.id).not.toBe(project.id);
    expect(project.name).not.toContain(":");
    expect(duplicateProject.name).toBe(project.name);
    const projectRef = { ...workspaceRef, groupId: group.id, projectId: project.id };
    const collection = await session.createCollection(projectRef, "dir.");
    const duplicateCollection = await session.createCollection(projectRef, "dir.");
    expect(duplicateCollection.id).not.toBe(collection.id);
    expect(collection.name).toBe("dir");
    const collectionRef = { ...projectRef, collectionId: collection.id };
    const api = await session.createApi(collectionRef, { name: "http://localhost:8080/api/health" });
    const duplicateApi = await session.createApi(collectionRef, { name: "http://localhost:8080/api/health" });
    expect(duplicateApi.contract.id).not.toBe(api.contract.id);
    expect(duplicateApi.contract.metadata.name).toBe(api.contract.metadata.name);
    expect(api.contract.metadata.name).not.toMatch(/[\\/:*]/);
    expect(api.contract.metadata.name).toContain("http");
    const apiRef: ApiLocator = { ...collectionRef, folderIds: [], apiId: api.contract.id };
    await session.renameNode({ kind: "api", locator: apiRef }, "y/z:*");
    const renamedApi = session.locateApi(apiRef)!.api;

    expect(renamedApi.contract.metadata.name).not.toMatch(/[\\/:*]/);
    expect(session.locateApi(apiRef)?.api.contract.metadata.name).toBe(renamedApi.contract.metadata.name);
  });

  it("keeps sameName platform semantics and renames a collection without moving its ID directory", async () => {
    expect(sameName("Flow", "flow", "win32")).toBe(true);
    expect(sameName("Flow", "flow", "linux")).toBe(false);
    expect(sameName("Flow", "Flow", "darwin")).toBe(true);

    const temporary = await tempRoot();
    await persistWorkspace(temporary.path, makeWorkspace());
    const session = createSession();
    await session.open(temporary.path);
    const collectionRef = { ...projectLocator, collectionId: IDS.collectionOne };
    const collectionDir = join(temporary.path, "groups", IDS.groupOne, "projects", IDS.projectOne, "collections", IDS.collectionOne);
    await session.renameNode({ kind: "collection", locator: collectionRef }, "renamed collection");

    expect(existsSync(collectionDir)).toBe(true);
    expect(session.locateCollection(collectionRef)?.collection.name).toBe("renamed collection");
    const reopened = createSession();
    await reopened.open(temporary.path);
    expect(reopened.locateCollection(collectionRef)?.collection.name).toBe("renamed collection");
  });
});

// Stress lifecycle tests deliberately use a persisted formal asset and a complete API locator.
function hangingClient() {
  let entered = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client: ProtocolClient & { close(): Promise<void> } = {
    name: "hanging",
    canHandle: () => true,
    execute: async () => {
      entered += 1;
      await gate;
      return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
    },
    close: async () => {},
  };
  return {
    client,
    waitEntered: async () => { while (entered === 0) await new Promise((resolve) => setTimeout(resolve, 1)); },
    release: () => release(),
  };
}

describe("createStressController with formal session assets", () => {
  const confirmed = ["http://127.0.0.1:1"];

  it.each(["pooled", "fresh"] as const)("%s connection mode creates and closes one managed client per worker", async (connectionMode) => {
    const { s, api } = await setupStress();
    const modes: string[] = [];
    const closed: number[] = [];
    const controller = createStressController(s, {
      createManagedClient: (workerId, mode) => {
        modes.push(mode);
        return {
          name: `${mode}-${workerId}`,
          canHandle: () => true,
          execute: async () => ({ status: 200, headers: {}, bodyText: "{\"ok\":true}", timeMs: 1 }),
          close: async () => { closed.push(workerId); },
        };
      },
    });

    const output = await controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 2, maxIterations: 2, connectionMode, confirmedTargetOrigins: confirmed });
    expect(output.report.totalRequests).toBe(2);
    expect(modes).toEqual([connectionMode, connectionMode]);
    expect(closed).toHaveLength(2);
  });

  it("preserves generator saturation metrics and reasons in the report", async () => {
    const { s, api } = await setupStress();
    const controller = createStressController(s, {
      createManagedClient: () => ({
        name: "generator-fixture", canHandle: () => true,
        execute: async () => ({ status: 200, headers: {}, bodyText: "{\"ok\":true}", timeMs: 1 }),
        close: async () => {},
      }),
      createGeneratorCollector: () => ({
        recordSchedulerBacklog: () => {},
        stop: () => ({
          cpuUserMs: 1, cpuSystemMs: 1, cpuPercent: 99, rssStartBytes: 10, rssPeakBytes: 20,
          eventLoopDelayP95Ms: 120, schedulerBacklogMax: 3, saturated: true,
          reasons: ["cpu", "event-loop-delay", "scheduler-backlog"],
          limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
        }),
      }),
    });

    const output = await controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 1, confirmedTargetOrigins: confirmed });
    expect(output.report.generator).toMatchObject({ saturated: true, reasons: ["cpu", "event-loop-delay", "scheduler-backlog"] });
  });

  it("validates and persists the report under the workspace runs directory", async () => {
    const { s, dir, api } = await setupStress();
    const controller = createStressController(s);
    const output = await controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 2, maxIterations: 4, confirmedTargetOrigins: confirmed });

    expect(() => StressReportSchema.parse(output.report)).not.toThrow();
    expect(output.report.totalRequests).toBe(4);
    expect(output.file).toMatch(/^stress-.*\.json$/);
    expect(existsSync(join(dir, ".apicc", "runs", output.file!))).toBe(true);
  });

  it("canonicalizes a confirmed target origin before allowing requests", async () => {
    const { s, api } = await setupStress();
    let calls = 0;
    const controller = createStressController(s, { createManagedClient: () => ({
      name: "counting", canHandle: () => true,
      execute: async () => { calls += 1; return { status: 200, headers: {}, bodyText: "", timeMs: 1 }; },
      close: async () => {},
    }) });

    const output = await controller.run({
      locator: api.locator,
      caseId: api.cases[0]!.id,
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: ["HTTP://127.0.0.1:1/"],
    });
    expect(calls).toBe(1);
    expect(output.report.safety?.targetOrigins[0]?.origin).toBe("http://127.0.0.1:1");
  });

  it("closes each client and collector exactly once for completion, abort, body failure, and safety refusal", async () => {
    const { s, api } = await setupStress();
    const makeMetrics = () => {
      let stopped = 0;
      const collector: GeneratorMetricsCollector = {
        recordSchedulerBacklog: () => {},
        stop: () => {
          stopped += 1;
          return {
            cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 1, rssPeakBytes: 1,
            eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [],
            limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
          };
        },
      };
      return { collector, stopped: () => stopped };
    };
    const makeClient = (execute: ProtocolClient["execute"]) => {
      let closed = 0;
      const client: ProtocolClient & { close(): Promise<void> } = { name: "observed", canHandle: () => true, execute, close: async () => { closed += 1; } };
      return { client, closed: () => closed };
    };
    const runOnce = (execute: ProtocolClient["execute"], extra: { confirmedTargetOrigins?: string[]; maxIterations?: number } = { confirmedTargetOrigins: confirmed, maxIterations: 1 }) => {
      const client = makeClient(execute);
      const metrics = makeMetrics();
      const controller = createStressController(s, {
        createManagedClient: () => client.client,
        createGeneratorCollector: () => metrics.collector,
      });
      const result = controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, ...extra });
      return { controller, result, client, metrics };
    };

    const completed = runOnce(async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 1 }));
    await completed.result;
    expect(completed.client.closed()).toBe(1);
    expect(completed.metrics.stopped()).toBe(1);

    let release: () => void = () => {};
    let markEntered: () => void = () => {};
    const enteredRequest = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const aborted = runOnce(async () => { markEntered(); await gate; return { status: 200, headers: {}, bodyText: "", timeMs: 1 }; }, { confirmedTargetOrigins: confirmed, maxIterations: 100 });
    await enteredRequest;
    const stopping = aborted.controller.stop();
    release();
    await stopping;
    await aborted.result;
    expect(aborted.client.closed()).toBe(1);
    expect(aborted.metrics.stopped()).toBe(1);

    const bodyFailure = runOnce(async () => { throw new Error("body failure"); });
    expect((await bodyFailure.result).report.failed).toBe(1);
    expect(bodyFailure.client.closed()).toBe(1);
    expect(bodyFailure.metrics.stopped()).toBe(1);

    const refused = runOnce(async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 1 }), { maxIterations: 1 });
    await expect(refused.result).rejects.toMatchObject({ code: "target_confirmation_required", targetOrigin: "http://127.0.0.1:1" });
    expect(refused.client.closed()).toBe(1);
    expect(refused.metrics.stopped()).toBe(1);
  });

  it.each([
    { name: "origin mismatch", policy: undefined, origins: ["http://127.0.0.1:2"], concurrency: 1, code: "target_confirmation_required" },
    { name: "denied origin", policy: { deniedOrigins: ["http://127.0.0.1:1"] }, origins: confirmed, concurrency: 1, code: "target_denied" },
    { name: "maxConcurrency", policy: { maxConcurrency: 1 }, origins: confirmed, concurrency: 2, code: "concurrency_policy_exceeded" },
  ])("fails the $name safety gate before I/O and closes managed clients", async ({ policy, origins, concurrency, code }) => {
    const { s, api } = await setupStress();
    if (policy) await s.setStressPolicy(projectLocator, policy);
    let calls = 0;
    let closes = 0;
    const controller = createStressController(s, {
      createManagedClient: () => ({
        name: "policy-guard", canHandle: () => true,
        execute: async () => { calls += 1; return { status: 200, headers: {}, bodyText: "", timeMs: 1 }; },
        close: async () => { closes += 1; },
      }),
    });

    await expect(controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency, maxIterations: 1, confirmedTargetOrigins: origins }))
      .rejects.toMatchObject({ code });
    expect(calls).toBe(0);
    expect(closes).toBe(concurrency);
  });

  it("enforces one active run until its request settles", async () => {
    const { s, api } = await setupStress();
    const hanging = hangingClient();
    const controller = createStressController(s, { createManagedClient: () => hanging.client });
    const input = { locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 2, confirmedTargetOrigins: confirmed };
    const first = controller.run(input);
    try {
      await hanging.waitEntered();
      await expect(controller.run(input)).rejects.toThrow(/已有压测进行中/);
    } finally {
      hanging.release();
    }
    expect((await first).report.totalRequests).toBe(2);
  });

  it("stop returns and persists a partial report, then clears the active run", async () => {
    const { s, dir, api } = await setupStress();
    const hanging = hangingClient();
    const controller = createStressController(s, { createManagedClient: () => hanging.client });
    await expect(controller.stop()).rejects.toThrow(/没有进行中的压测/);
    const first = controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 100, confirmedTargetOrigins: confirmed });
    try {
      await hanging.waitEntered();
      const stopping = controller.stop();
      hanging.release();
      const stopped = await stopping;
      expect(stopped.report.totalRequests).toBeGreaterThanOrEqual(1);
      expect(stopped.report.totalRequests).toBeLessThanOrEqual(100);
      expect(existsSync(join(dir, ".apicc", "runs", stopped.file!))).toBe(true);
      await first;
    } finally {
      hanging.release();
    }
    await expect(controller.stop()).rejects.toThrow(/没有进行中的压测/);
  });

  it("reports complete-locator, case, and environment lookup errors before execution", async () => {
    const { s, api } = await setupStress();
    const controller = createStressController(s);
    await expect(() => controller.run({ locator: { ...api.locator, apiId: uuid(9998) }, caseId: "x", concurrency: 1, maxIterations: 1 }))
      .toThrow(/未找到接口/);
    await expect(() => controller.run({ locator: api.locator, caseId: "ghost", concurrency: 1, maxIterations: 1 }))
      .toThrow(/用例不存在: ghost/);
    await expect(() => controller.run({ locator: api.locator, caseId: api.cases[0]!.id, envName: "ghost", concurrency: 1, maxIterations: 1 }))
      .toThrow(/未找到环境: ghost/);
  });

  it("validates termination options and finite safe-integer iteration counts before clients exist", async () => {
    const { s, api } = await setupStress();
    const controller = createStressController(s);
    const base = { locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1 };
    await expect(controller.run(base)).rejects.toThrow(/压测终止条件缺失/);
    expect(() => controller.run({ ...base, maxIterations: Number.NaN })).toThrow(/maxIterations 必须为正 safe integer/);
    expect(() => controller.run({ ...base, maxIterations: 1.5 })).toThrow(/maxIterations 必须为正 safe integer/);
    expect(() => controller.run({ ...base, maxIterations: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/maxIterations 必须为正 safe integer/);
    expect(() => controller.run({ ...base, durationMs: Number.NaN })).toThrow(/durationMs 必须为有限正数/);
    expect(() => controller.run({ ...base, durationMs: Number.POSITIVE_INFINITY })).toThrow(/durationMs 必须为有限正数/);
  });

  it("does not create or close a managed client when Core rejects data-row configuration", async () => {
    const { s, dir, api } = await setupStress();
    const invalid = structuredClone(s.locateApi(api.locator)!.api);
    invalid.cases[0]!.dataDriver = { sourcePath: join(dir, "missing-rows.json"), format: "json" };
    await s.saveApi(api.locator, invalid);
    let created = 0;
    let closed = 0;
    const controller = createStressController(s, {
      createManagedClient: () => {
        created += 1;
        return {
          name: "must-not-exist",
          canHandle: () => true,
          execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }),
          close: async () => { closed += 1; },
        };
      },
    });

    await expect(controller.run({
      locator: api.locator,
      caseId: api.cases[0]!.id,
      concurrency: 1,
      maxIterations: 1,
      confirmedTargetOrigins: confirmed,
    })).rejects.toThrow(/数据源 file:1: 无法读取所选本地文件/);
    expect(created).toBe(0);
    expect(closed).toBe(0);
  });

  it("returns a report with no file when persistence fails and warns with useful context", async () => {
    const { s, api } = await setupStress();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const controller = createStressController(s, { writeReport: () => { throw new Error("disk full"); } });
      const output = await controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 1, confirmedTargetOrigins: confirmed });
      expect(output.report.totalRequests).toBe(1);
      expect(output.file).toBeUndefined();
      expect("file" in output).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("落盘失败");
      expect(warn.mock.calls[0]![0]).toContain("stress-");
      expect(warn.mock.calls[0]![0]).toContain("disk full");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not let callers mutate the persisted stress report", async () => {
    const { s, dir, api } = await setupStress();
    const output = await createStressController(s).run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 2, confirmedTargetOrigins: confirmed });
    output.report.totalRequests = 999;
    const saved = JSON.parse(readFileSync(join(dir, ".apicc", "runs", output.file!), "utf8")) as { totalRequests: number };
    expect(saved.totalRequests).toBe(2);
  });

  it("rejects non-HTTP APIs before creating clients while HTTP remains runnable", async () => {
    const { s, api } = await setupStress();
    const collection = { ...projectLocator, collectionId: IDS.collectionOne };
    const soap = await s.createApi(collection, { name: "soap-op", protocol: "soap", baseUrl: "http://127.0.0.1:1", path: "/soap" });
    const websocket = await s.createApi(collection, { name: "ws-op", protocol: "websocket", baseUrl: "ws://127.0.0.1:1", path: "/echo" });
    let calls = 0;
    const controller = createStressController(s, { createManagedClient: () => ({
      name: "counting", canHandle: () => true,
      execute: async () => { calls += 1; return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; },
      close: async () => {},
    }) });
    const soapRef: ApiLocator = { ...collection, folderIds: [], apiId: soap.contract.id };
    const websocketRef: ApiLocator = { ...collection, folderIds: [], apiId: websocket.contract.id };

    expect(() => controller.run({ locator: soapRef, caseId: soap.cases[0]!.id, concurrency: 1, maxIterations: 1 }))
      .toThrow(/桌面压测面板当前仅支持 HTTP/);
    expect(() => controller.run({ locator: websocketRef, caseId: websocket.cases[0]!.id, concurrency: 1, maxIterations: 1 }))
      .toThrow(/桌面压测面板当前仅支持 HTTP/);
    expect(calls).toBe(0);
    expect(existsSync(join(s.root!, ".apicc", "runs"))).toBe(false);

    const output = await controller.run({ locator: api.locator, caseId: api.cases[0]!.id, concurrency: 1, maxIterations: 1, confirmedTargetOrigins: confirmed });
    expect(output.report.totalRequests).toBe(1);
    expect(calls).toBe(1);
  });
});
