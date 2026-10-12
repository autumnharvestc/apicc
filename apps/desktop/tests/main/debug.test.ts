import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";
import { findApi, IDS, makeWorkspace, makeTempRoot, persistWorkspace, projectOne } from "./helpers/contract-assets.js";
import type { ApiLocator } from "../../src/shared/locations.js";

let server: Server;
let baseUrl = "";
const roots: Array<{ dispose: () => Promise<void> }> = [];

beforeAll(async () => {
  server = createServer((_req, res) => {
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
