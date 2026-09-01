import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { createEventBus } from "../../src/events/bus.js";
import { CollectionRunner } from "../../src/runner/runner.js";
import { httpClient } from "../../src/http/client.js";
import { builtinAuthProviders } from "../../src/http/auth.js";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";
import type { Collection, Environment, Project, Workspace } from "../../src/domain/model.js";

let server: Server;
let baseUrl = "";
let env: Environment;
let project: Project;
let workspace: Workspace;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, n: 42 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // 夹具须在 baseUrl 就绪后构造：模块顶层求值会把空串快照进 env.variables。
  env = { id: "e1", name: "dev", variables: { baseUrl, who: "dev" } };
  project = { id: "p1", name: "p", variables: {}, environments: [env], collections: [] };
  workspace = { id: "w1", name: "ws", variables: { who: "global" }, groups: [] };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function buildDeps(failFast = false) {
  const registry = createPluginRegistry();
  registry.registerProtocol(httpClient);
  for (const p of builtinAuthProviders) registry.registerAuth(p);
  for (const o of builtinAssertOperators) registry.registerAssert(o);
  registry.registerScriptEngine(jsScriptEngine);
  return new CollectionRunner({
    registry, bus: createEventBus(),
    timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 },
    failFast,
  });
}

function collectionWith(cases: Collection["apis"][number]["cases"]): Collection {
  return {
    id: "c1", name: "c", variables: {}, folders: [],
    apis: [{ id: "a1", name: "get-ok", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/x", headers: [], query: [], cases }],
  };
}

describe("CollectionRunner", () => {
  it("基座用例：断言通过计入 passed", async () => {
    const col = collectionWith([
      { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [
        { id: "as1", target: "status", op: "eq", expected: "200" },
        { id: "as2", target: "bodyJson", op: "eq", path: "$.n", expected: "42" },
      ] },
    ]);
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("失败断言计入 failed 且不中断后续", async () => {
    const col = collectionWith([
      { id: "t1", name: "bad", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "500" }] },
      { id: "t2", name: "good", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
    ]);
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("环境继承链上 scope=父环境 的用例也执行", async () => {
    const sitEnv: Environment = { id: "e2", name: "sit", extends: "dev", variables: { baseUrl, who: "sit" } };
    const col = collectionWith([{ id: "t1", name: "dev-only", scope: "dev", parameters: {}, assertions: [] }]);
    const result = await buildDeps().run(col, sitEnv, project, workspace, {});
    expect(result.total).toBe(1);
  });

  it("数据驱动：CSV 每行执行一次并注入运行时变量", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-run-"));
    writeFileSync(join(dir, "data.csv"), "sku\nA1\nB2");
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "dd", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [{
          id: "t1", name: "row", scope: "base", parameters: {},
          dataDriver: { sourcePath: join(dir, "data.csv"), format: "csv" },
          postScript: "if (pm.variables.get('sku') === undefined) throw new Error('sku 未注入');",
          assertions: [],
        }],
      }],
    };
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
  });

  it("前置脚本可改写请求路径", async () => {
    const seen: string[] = [];
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "rewrite", version: "1", deprecated: false,
        method: "GET", url: `${baseUrl}/wrong`, headers: [], query: [],
        cases: [{
          id: "t1", name: "rw", scope: "base", parameters: {}, assertions: [],
          preScript: "pm.request.url = pm.request.url.replace('/wrong', '/right');",
        }],
      }],
    };
    const bus = createEventBus();
    bus.on("beforeRequest", ({ request }) => { seen.push((request as { url: string }).url); });
    const runner = new CollectionRunner({
      registry: (() => { const r = createPluginRegistry(); r.registerProtocol(httpClient); for (const p of builtinAuthProviders) r.registerAuth(p); for (const o of builtinAssertOperators) r.registerAssert(o); r.registerScriptEngine(jsScriptEngine); return r; })(),
      bus, timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 }, failFast: false,
    });
    const result = await runner.run(col, env, project, workspace, {});
    expect(seen[0]).toContain("/right");
    expect(result.passed).toBe(1);
  });

  it("failFast=true 时首个失败后停止", async () => {
    const col = collectionWith([
      { id: "t1", name: "bad", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "500" }] },
      { id: "t2", name: "never", scope: "base", parameters: {}, assertions: [] },
    ]);
    const result = await buildDeps(true).run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
  });

  it("runsDir 提供时原始结果 JSON 先行落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runs-"));
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }]);
    await buildDeps().run(col, env, project, workspace, { runsDir: dir });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
  });
});
