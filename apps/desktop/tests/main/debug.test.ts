import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@apicc/core";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";
import { createDebugController } from "../../src/main/debugController.js";
import type { DebugCredentialHost, PreparedDesktopExecutionRun } from "../../src/main/credentialHost.js";
import { findApi, IDS, makeWorkspace, makeTempRoot, persistWorkspace, projectOne } from "./helpers/contract-assets.js";
import type { ApiLocator } from "../../src/shared/locations.js";

let server: Server;
let baseUrl = "";
let serverHits = 0;
const roots: Array<{ dispose: () => Promise<void> }> = [];

function workspaceBytes(root: string): string {
  const entries: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else entries.push([relative(root, path).replaceAll("\\", "/"), readFileSync(path).toString("base64")]);
    }
  };
  visit(root);
  return JSON.stringify(entries);
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    serverHits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await Promise.all(roots.map((root) => root.dispose()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function setup(options: { environment?: boolean; scope?: string; unreachable?: boolean; assertStatus?: boolean } = {}) {
  const root = await makeTempRoot("apicc-debug-assets-");
  roots.push(root);
  const workspace = makeWorkspace();
  const project = projectOne(workspace);
  const api = findApi(project, IDS.sharedApi)!;
  api.cases = [api.cases[0]!];
  api.contract.request = {
    protocol: "http",
    method: "GET",
    baseUrl: options.environment ? "{{baseUrl}}" : options.unreachable ? "http://127.0.0.1:1" : baseUrl,
    path: "/x",
    pathParams: [], query: [], headers: [], cookies: [],
    auth: { kind: "none" }, body: { kind: "none" },
  };
  api.contract.request.auth = { kind: "none" };
  api.cases[0]!.scope = options.scope ?? "base";
  if (options.assertStatus) api.cases[0]!.assertions.push({ id: "as1", target: "status", op: "eq", expected: "200" });
  if (options.environment) {
    const environment = project.environments[0]!;
    environment.variables.baseUrl = baseUrl;
    environment.baseUrls[IDS.collectionOne] = baseUrl;
  }
  await persistWorkspace(root.path, workspace);
  const session = createSession();
  await session.open(root.path);
  const locator: ApiLocator = {
    workspaceId: IDS.workspace,
    groupId: IDS.groupOne,
    projectId: IDS.projectOne,
    collectionId: IDS.collectionOne,
    folderIds: [],
    apiId: IDS.sharedApi,
  };
  return { session, locator, api, project };
}

async function setupProjectWithoutCollections() {
  const root = await makeTempRoot("apicc-debug-free-");
  roots.push(root);
  const workspace = makeWorkspace();
  const project = projectOne(workspace);
  project.collections = [];
  await persistWorkspace(root.path, workspace);
  const session = createSession();
  await session.open(root.path);
  const projectLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
  return { session, project, projectLocator };
}

describe("sendDebug", () => {
  it("以基座用例调试：返回单条结果且断言评估", async () => {
    const { session, locator, api } = await setup({ assertStatus: true });
    const result = await sendDebug(session, { locator, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.run.total).toBe(1);
    expect(result.outcome.passed).toBe(true);
  });

  it("环境变量在调试中生效", async () => {
    const { session, locator, api } = await setup({ environment: true });
    const result = await sendDebug(session, { locator, caseId: api.cases[0]!.id, envName: "dev" });
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.passed).toBe(true);
  });

  it("DebugOutput 携带响应快照（status/headers/bodyText/timeMs）", async () => {
    const { session, locator, api } = await setup({ environment: true });
    const result = await sendDebug(session, { locator, caseId: api.cases[0]!.id, envName: "dev" });
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(200);
    expect(result.response!.bodyText).toContain("ok");
    expect(result.response!.headers["content-type"]).toContain("application/json");
    expect(result.response!.timeMs).toBeGreaterThanOrEqual(0);
  });

  it("未知 envName 显式拒绝而非静默降级为无环境运行", async () => {
    const { session, locator, api } = await setup();
    await expect(sendDebug(session, { locator, caseId: api.cases[0]!.id, envName: "ghost" })).rejects.toThrow(/未找到环境: ghost/);
  });

  it("env-scope 用例无环境调试：可读报错而非 undefined outcome", async () => {
    const { session, locator, api } = await setup({ scope: "dev" });
    await expect(sendDebug(session, { locator, caseId: api.cases[0]!.id, envName: undefined })).rejects.toThrow(
      /不适用于当前调试环境/,
    );
  });

  it("网络错误进入 outcome.error 而非抛出", async () => {
    const { session, locator, api } = await setup({ unreachable: true });
    const result = await sendDebug(session, { locator, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.error).toContain("refused");
  });
});

describe("debug controller", () => {
  it("runs a project-owned free request without persisting or exposing its temporary asset identity", async () => {
    const { session, project, projectLocator } = await setupProjectWithoutCollections();
    const diskBefore = workspaceBytes(session.root!);
    const projectBefore = JSON.stringify(session.locateProject(projectLocator)?.project);
    let preparedScope: unknown;
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async (scope, snapshot) => {
        preparedScope = scope;
        return {
          run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
          refs: [],
          markers: [],
        };
      },
    };
    const persisted: unknown[] = [];
    const controller = createDebugController(session, () => createDefaultRegistry(), credentials, {
      append: async (result: unknown) => { persisted.push(result); },
    } as never);
    const owner = {};
    serverHits = 0;
    const started = controller.start(owner, {
      mode: "free",
      project: projectLocator,
      draftId: "10000000-0000-4000-8000-000000000079",
      request: {
        protocol: "http", method: "GET", baseUrl, path: "/free-project", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "none" },
      },
      parameters: {},
      fields: [],
    });

    const result = await controller.wait(owner, started.runId);

    expect(preparedScope).toEqual(projectLocator);
    expect(result.mode).toBe("free");
    expect(result.source).toMatchObject({ sourceKind: "free", project: projectLocator, draftId: "10000000-0000-4000-8000-000000000079" });
    expect(JSON.stringify(result)).not.toMatch(/collectionId|apiId|caseId|__debug/);
    expect(serverHits).toBe(1);
    expect(persisted).toEqual([result]);
    expect(project.collections).toEqual([]);
    expect(JSON.stringify(session.locateProject(projectLocator)?.project)).toBe(projectBefore);
    expect(workspaceBytes(session.root!)).toBe(diskBefore);
  });

  it("rejects a free request for an unknown project or environment in the opened workspace", async () => {
    const { session, project } = await setupProjectWithoutCollections();
    let appends = 0;
    const controller = createDebugController(session, () => createDefaultRegistry(), {
      prepareRunForRequests: async (_scope, snapshot) => ({
        run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
        refs: [],
        markers: [],
      }),
    }, { append: async () => { appends += 1; } } as never);
    serverHits = 0;

    expect(() => controller.start({}, {
      mode: "free",
      project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: "10000000-0000-4000-8000-000000000079" },
      draftId: "10000000-0000-4000-8000-000000000080",
      request: {
        protocol: "http", method: "GET", baseUrl, path: "/must-not-send", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "none" },
      },
      parameters: {},
      fields: [],
    })).toThrow(/未找到项目/);

    expect(() => controller.start({}, {
      mode: "free",
      project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne },
      draftId: "10000000-0000-4000-8000-000000000081",
      environmentId: "10000000-0000-4000-8000-000000000082",
      request: {
        protocol: "http", method: "GET", baseUrl, path: "/must-not-send", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "none" },
      },
      parameters: {},
      fields: [],
    })).toThrow();

    expect(serverHits).toBe(0);
    expect(appends).toBe(0);
    expect(project.collections).toEqual([]);
  });

  it("persists one record from the shared completion even when wait is repeated", async () => {
    const { session, locator } = await setup();
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async (_scope, snapshot) => ({
        run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
        refs: [],
        markers: [],
      }),
    };
    const persisted: unknown[] = [];
    const history = {
      append: async (result: unknown) => { persisted.push(result); },
    };
    const controller = createDebugController(session, () => createDefaultRegistry(), credentials, history as never);
    const owner = {};
    const started = controller.start(owner, {
      mode: "request",
      locator,
      request: {
        protocol: "http", method: "GET", baseUrl, path: "/history-once", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "none" },
      },
      parameters: {},
      fields: [],
    });

    const result = await controller.wait(owner, started.runId);
    const repeated = await controller.wait(owner, started.runId);

    expect(result.failureKind).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(result);
    expect(repeated).toBe(result);
  });

  it("keeps the completed network result when private history writing fails", async () => {
    const { session, locator } = await setup();
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async (_scope, snapshot) => ({
        run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
        refs: [],
        markers: [],
      }),
    };
    const controller = createDebugController(session, () => createDefaultRegistry(), credentials, {
      append: async () => { throw new Error("synthetic private path detail"); },
    });
    const owner = {};
    serverHits = 0;
    const started = controller.start(owner, {
      mode: "request",
      locator,
      request: {
        protocol: "http", method: "GET", baseUrl, path: "/history-write-warning", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "none" },
      },
      parameters: {},
      fields: [],
    });

    const result = await controller.wait(owner, started.runId);

    expect(serverHits).toBe(1);
    expect(result.failureKind).toBeUndefined();
    expect(result.run).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(result.warnings).toContain("调试结果已完成，但本机历史写入或清理未完整成功。");
    expect(JSON.stringify(result)).not.toContain("synthetic private path detail");
  });

  it("rejects a request with an unfilled consumed field before runId or async preparation", async () => {
    const { session, locator } = await setup();
    const sessionState = () => JSON.stringify({ root: session.root, workspace: session.workspace, readOnly: session.readOnly, revision: session.revision });
    const before = sessionState();
    const diskBefore = workspaceBytes(session.root!);
    let preparationCalls = 0;
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async (_scope, snapshot) => {
        preparationCalls += 1;
        return {
          run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
          refs: [],
          markers: [],
        };
      },
    };
    const controller = createDebugController(session, () => createDefaultRegistry(), credentials);
    const owner = {};
    serverHits = 0;
    let caught: unknown;
    let started: ReturnType<typeof controller.start> | undefined;
    try {
      started = controller.start(owner, {
        mode: "request",
        locator,
        request: {
          protocol: "http",
          method: "GET",
          baseUrl,
          path: "/needs-input-must-not-send",
          pathParams: [], query: [], headers: [], cookies: [],
          auth: { kind: "none" }, body: { kind: "none" },
        },
        parameters: {},
        fields: [{ path: "request.body.content", status: "redacted", needsInput: true }],
      });
    } catch (error) {
      caught = error;
    }
    if (started) {
      controller.cancel(owner, started.runId);
      await controller.wait(owner, started.runId);
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(started).toBeUndefined();
    expect(preparationCalls).toBe(0);
    expect(serverHits).toBe(0);
    expect(sessionState()).toBe(before);
    expect(workspaceBytes(session.root!)).toBe(diskBefore);
  });

  it("returns a safe terminal result when credential preparation fails after start", async () => {
    const { session, locator } = await setup();
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async () => { throw new Error("synthetic credential setup failure"); },
    };
    const controller = createDebugController(session, () => createDefaultRegistry(), credentials);
    const owner = {};
    const started = controller.start(owner, {
      mode: "request", locator,
      request: {
        protocol: "http", method: "POST", baseUrl, path: "/must-not-send", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "text", content: "synthetic-unprepared-secret" },
      },
      parameters: {}, fields: [],
    });

    let result: Awaited<ReturnType<typeof controller.wait>> | undefined;
    try {
      result = await controller.wait(owner, started.runId);
    } catch {
      // The assertion below distinguishes a rejected completion from the required terminal result.
    }

    expect(result?.failureKind).toBe("config");
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("synthetic-unprepared-secret");
    if (result) expect(await controller.wait(owner, started.runId)).toBe(result);
  });

  it("returns runId synchronously and cancel before credential preparation settles makes no request", async () => {
    const { session, locator } = await setup();
    const sessionState = () => JSON.stringify({ root: session.root, workspace: session.workspace, readOnly: session.readOnly, revision: session.revision });
    const before = sessionState();
    const diskBefore = workspaceBytes(session.root!);
    let releasePreparation: (() => void) | undefined;
    let markPreparationStarted: () => void = () => {};
    const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async (_scope, snapshot) => {
        markPreparationStarted();
        return new Promise<PreparedDesktopExecutionRun>((resolve) => {
          releasePreparation = () => resolve({
            run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
            refs: [],
            markers: [],
          });
        });
      },
    };
    const controller = createDebugController(session, () => createDefaultRegistry(), credentials);
    const owner = {};
    const otherOwner = {};
    serverHits = 0;
    const started = controller.start(owner, {
      mode: "request",
      locator,
      request: {
        protocol: "http",
        method: "GET",
        baseUrl,
        path: "/cancel-before-network",
        pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "text", content: "synthetic-before-prep-secret" },
      },
      parameters: {},
      fields: [],
    });

    expect(started.runId).toBeTruthy();
    await preparationStarted;
    expect(controller.cancel(otherOwner, started.runId)).toEqual({ status: "no-active" });
    expect(controller.cancel(owner, started.runId)).toEqual({ status: "cancelled" });
    if (!releasePreparation) throw new Error("credential preparation was not entered");
    const result = await controller.wait(owner, started.runId);
    releasePreparation();

    expect(serverHits).toBe(0);
    expect(result.failureKind).toBe("aborted");
    expect(JSON.stringify(result).includes("synthetic-before-prep-secret")).toBe(false);
    expect(result.replay.available).toBe(false);
    expect(result.replay.fields).toContainEqual({ path: "request", status: "redacted", needsInput: true });
    expect(sessionState()).toBe(before);
    expect(workspaceBytes(session.root!)).toBe(diskBefore);
    expect(await controller.wait(owner, started.runId)).toBe(result);
  });

  it("uses prepared credential markers when cancellation wins during registry loading", async () => {
    const { session, locator } = await setup();
    const marker = "synthetic-cancel-marker";
    let markRegistryLoadStarted: () => void = () => {};
    const registryLoadStarted = new Promise<void>((resolve) => { markRegistryLoadStarted = resolve; });
    const credentials: DebugCredentialHost = {
      prepareRunForRequests: async (_scope, snapshot) => ({
        run: { snapshot, credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} } },
        refs: [],
        markers: [marker],
      }),
    };
    const controller = createDebugController(session, () => {
      markRegistryLoadStarted();
      return new Promise<ReturnType<typeof createDefaultRegistry>>(() => {});
    }, credentials);
    const owner = {};
    serverHits = 0;
    const started = controller.start(owner, {
      mode: "request",
      locator,
      request: {
        protocol: "http", method: "POST", baseUrl, path: "/cancel-during-registry", pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" }, body: { kind: "text", content: marker },
      },
      parameters: {},
      fields: [],
    });

    await registryLoadStarted;
    expect(controller.cancel(owner, started.runId)).toEqual({ status: "cancelled" });
    const result = await controller.wait(owner, started.runId);

    expect(serverHits).toBe(0);
    expect(result.failureKind).toBe("aborted");
    expect(JSON.stringify(result).includes(marker)).toBe(false);
    expect(result.replay.available).toBe(false);
    expect(result.replay.fields).toContainEqual({ path: "request.body.content", status: "redacted", needsInput: true });
    expect(await controller.wait(owner, started.runId)).toBe(result);
  });
});
