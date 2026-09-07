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
import type { Collection, Environment, Operation, Project, Workspace } from "../../src/domain/model.js";
import type { RunResult } from "../../src/report/types.js";

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
  env = { id: "e1", name: "dev", variables: { baseUrl, who: "dev" }, baseUrls: {} };
  project = { id: "p1", name: "p", variables: {}, environments: [env], collections: [], workflows: [] };
  workspace = { id: "w1", name: "ws", variables: { who: "global" }, globals: { variables: {}, query: [], headers: [] }, groups: [] };
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

/** 用自定义 bus 构造 Runner（钩子极性/事件契约测试用），其余插件与 buildDeps 相同。 */
function buildRunnerWith(bus: ReturnType<typeof createEventBus>, failFast = false) {
  const registry = createPluginRegistry();
  registry.registerProtocol(httpClient);
  for (const p of builtinAuthProviders) registry.registerAuth(p);
  for (const o of builtinAssertOperators) registry.registerAssert(o);
  registry.registerScriptEngine(jsScriptEngine);
  return new CollectionRunner({
    registry, bus, timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 }, failFast,
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
    const sitEnv: Environment = { id: "e2", name: "sit", extends: "dev", variables: { baseUrl, who: "sit" }, baseUrls: {} };
    const col = collectionWith([{ id: "t1", name: "dev-only", scope: "dev", parameters: {}, assertions: [] }]);
    const result = await buildDeps().run(col, sitEnv, project, workspace, {});
    expect(result.total).toBe(1);
  });

  it("同 ID 环境用例覆盖基座：仅执行环境版本而非重复执行（规格 §6）", async () => {
    const sitEnv: Environment = { id: "e2", name: "sit", extends: "dev", variables: { baseUrl, who: "sit" }, baseUrls: {} };
    const sitProject: Project = { id: "p1", name: "p", variables: {}, environments: [env, sitEnv], collections: [], workflows: [] };
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "override", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [
          // 基座版：断言会通过——若它被执行，error 必为 undefined，即可据此区分执行的是哪个版本
          { id: "t1", name: "base-version", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
          // 环境版：同 ID，postScript 抛出特征 error 作为执行痕迹
          { id: "t1", name: "sit-version", scope: "sit", parameters: {}, assertions: [], postScript: "throw new Error('sit 环境版特征标记');" },
        ],
      }],
    };
    const result = await buildDeps().run(col, sitEnv, sitProject, workspace, {});
    expect(result.total).toBe(1);
    expect(result.cases[0]!.caseName).toBe("sit-version");
    expect(result.cases[0]!.error).toContain("sit 环境版特征标记");
  });

  it("运行未覆盖该 ID 的环境时仍执行基座版本（防过度去重）", async () => {
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "base-fallback", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [
          { id: "t1", name: "base-version", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
          { id: "t1", name: "sit-version", scope: "sit", parameters: {}, assertions: [], postScript: "throw new Error('sit 环境版特征标记');" },
        ],
      }],
    };
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
    expect(result.cases[0]!.caseName).toBe("base-version");
    expect(result.cases[0]!.passed).toBe(true);
  });

  it("同 ID 出现两个环境版本时继承链更近者优先（规格 §6）", async () => {
    const pressEnv: Environment = { id: "e3", name: "press", extends: "sit", variables: { baseUrl }, baseUrls: {} };
    const sitEnv: Environment = { id: "e2", name: "sit", extends: "dev", variables: { baseUrl }, baseUrls: {} };
    const chainProject: Project = { id: "p1", name: "p", variables: {}, environments: [env, sitEnv, pressEnv], collections: [], workflows: [] };
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "nearest", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [
          { id: "t1", name: "base-version", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
          { id: "t1", name: "sit-version", scope: "sit", parameters: {}, assertions: [], postScript: "throw new Error('sit 版被执行');" },
          { id: "t1", name: "press-version", scope: "press", parameters: {}, assertions: [], postScript: "throw new Error('press 版被执行');" },
        ],
      }],
    };
    const result = await buildDeps().run(col, pressEnv, chainProject, workspace, {});
    expect(result.total).toBe(1);
    expect(result.cases[0]!.caseName).toBe("press-version");
    expect(result.cases[0]!.error).toContain("press 版被执行");
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

  it("postScript 提取的变量跨用例持久，且可被本用例 parameters 遮蔽", async () => {
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "flow", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [
          { id: "t1", name: "login", scope: "base", parameters: {}, assertions: [], postScript: "pm.variables.set('token', 'abc');" },
          {
            id: "t2", name: "shadow", scope: "base", parameters: { token: "local" },
            assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }],
            preScript: "if (pm.variables.get('token') !== 'local') throw new Error('本用例 parameters 未遮蔽持久变量: ' + pm.variables.get('token'));",
          },
          {
            id: "t3", name: "carry", scope: "base", parameters: {},
            assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }],
            preScript: "if (pm.variables.get('token') !== 'abc') throw new Error('持久变量丢失: ' + pm.variables.get('token'));",
          },
        ],
      }],
    };
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
  });

  it("脚本异常/超时只失败当用例，后续用例与落盘不受影响", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-iso-"));
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "iso", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [
          { id: "t1", name: "bare-throw", scope: "base", parameters: {}, assertions: [], postScript: "throw 'boom';" },
          { id: "t2", name: "timeout", scope: "base", parameters: {}, assertions: [], preScript: "while(true){}" },
          { id: "t3", name: "after", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
        ],
      }],
    };
    const result = await buildDeps().run(col, env, project, workspace, { runsDir: dir });
    expect(result.total).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.cases[0].passed).toBe(false);
    expect(result.cases[0].error).toBe("boom");
    expect(result.cases[1].passed).toBe(false);
    expect(result.cases[1].error).toContain("脚本超时");
    expect(result.cases[2].passed).toBe(true);
    const { readdirSync, readFileSync } = await import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const saved = JSON.parse(readFileSync(join(dir, files[0]), "utf8")) as RunResult;
    expect(saved.total).toBe(3);
    expect(saved.passed).toBe(1);
  });

  it("runsDir 落盘失败降级：不中断 run 返回", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-rfail-"));
    writeFileSync(join(dir, "occupied"), "x");
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }]);
    const result = await buildDeps().run(col, env, project, workspace, { runsDir: join(dir, "occupied") });
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("runsDir 提供时原始结果 JSON 先行落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runs-"));
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }]);
    await buildDeps().run(col, env, project, workspace, { runsDir: dir });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("环境派生继承：sit extends dev 继承 baseUrl，子环境变量覆盖同名（回归 C3）", async () => {
    // dev 有 baseUrl 而 sit 没有——URL 能解析即证明继承生效；who 由 sit 覆盖 dev。
    const sitEnv: Environment = { id: "e2", name: "sit", extends: "dev", variables: { who: "sit" }, baseUrls: {} };
    const sitProject: Project = { id: "p1", name: "p", variables: {}, environments: [env, sitEnv], collections: [], workflows: [] };
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "inherit", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/x", headers: [], query: [],
        cases: [{
          id: "t1", name: "ok", scope: "base", parameters: {},
          preScript: "if (pm.environment.get('who') !== 'sit') throw new Error('pm.environment.get(who)=' + pm.environment.get('who'));",
          assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }],
        }],
      }],
    };
    const result = await buildDeps().run(col, sitEnv, sitProject, workspace, {});
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
    expect(result.cases[0]!.error).toBeUndefined();
  });

  it("form 请求体逐项变量解析并以 urlencoded 形态发出（回归 C4 Runner 侧）", async () => {
    let seenBody = "";
    let seenContentType = "";
    const echo = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seenBody = b;
        seenContentType = req.headers["content-type"] ?? "";
        res.end("{}");
      });
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    try {
      const echoUrl = `http://127.0.0.1:${(echo.address() as { port: number }).port}/login`;
      const col: Collection = {
        id: "c1", name: "c", variables: {}, folders: [],
        apis: [{
          id: "a1", name: "login", version: "1", deprecated: false, method: "POST", url: echoUrl, headers: [], query: [],
          body: {
            kind: "form",
            content: "",
            form: [
              { key: "user", value: "{{who}}", enabled: true },
              { key: "pw", value: "static", enabled: true },
              { key: "off", value: "no", enabled: false },
            ],
          },
          cases: [{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] }],
        }],
      };
      const result = await buildDeps().run(col, env, project, workspace, {});
      expect(result.passed).toBe(1);
      expect(seenBody).toBe("user=dev&pw=static");
      expect(seenContentType).toBe("application/x-www-form-urlencoded");
    } finally {
      await new Promise<void>((r) => echo.close(() => r()));
    }
  });

  it("数据源读取失败折进当用例 outcome，运行不中断（回归 I3）", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "apicc-data-")), "nope.csv");
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "dd", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [{
          id: "t1", name: "missing-source", scope: "base", parameters: {},
          dataDriver: { sourcePath: missing, format: "csv" },
          assertions: [],
        }],
      }],
    };
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.cases[0]!.passed).toBe(false);
    expect(result.cases[0]!.error).toContain("数据源读取失败");
  });

  it("事件载荷契约增量：beforeCase/afterCase 带 apiId/caseId，afterCase 带耗时，afterRun 带结果引用（I4）", async () => {
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] }]);
    const bus = createEventBus();
    const beforePayloads: unknown[] = [];
    const afterPayloads: unknown[] = [];
    let afterRunPayload: unknown;
    bus.on("beforeCase", (p) => { beforePayloads.push({ ...p }); });
    bus.on("afterCase", (p) => { afterPayloads.push({ ...p }); });
    bus.on("afterRun", (p) => { afterRunPayload = { ...p }; });
    const result = await buildRunnerWith(bus).run(col, env, project, workspace, {});
    expect(beforePayloads[0]).toMatchObject({ apiId: "a1", caseId: "t1", apiName: "get-ok", caseName: "ok" });
    expect(afterPayloads[0]).toMatchObject({
      apiId: "a1", caseId: "t1", apiName: "get-ok", caseName: "ok",
      passed: true, durationMs: expect.any(Number),
    });
    expect((afterRunPayload as { result?: { total: number } }).result?.total).toBe(1);
    expect(result.total).toBe(1);
  });

  it("afterResponse 载荷携带响应快照：headers/bodyText 可选增量（debug 响应视图用）", async () => {
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }]);
    const bus = createEventBus();
    let payload: unknown;
    bus.on("afterResponse", (p) => { payload = { ...p }; });
    await buildRunnerWith(bus).run(col, env, project, workspace, {});
    expect(payload).toMatchObject({
      status: 200,
      timeMs: expect.any(Number),
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ ok: true, n: 42 }),
    });
  });

  it("beforeRun 钩子失败记入 warnings，运行与用例结果不受影响（钩子极性）", async () => {
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] }]);
    const bus = createEventBus();
    bus.on("beforeRun", () => { throw new Error("beforeRun 钩子炸了"); });
    const result = await buildRunnerWith(bus).run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("beforeRun");
    expect(result.cases[0]!.passed).toBe(true);
  });

  it("afterRun 钩子失败同样记入 warnings，不向调用方抛错（钩子极性）", async () => {
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }]);
    const bus = createEventBus();
    bus.on("afterRun", () => { throw new Error("afterRun 钩子炸了"); });
    const result = await buildRunnerWith(bus).run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
    expect(result.warnings?.join("\n")).toContain("afterRun");
  });

  it("beforeCase 钩子失败归当用例且请求不发送，后续用例继续（钩子极性）", async () => {
    let hits = 0;
    const counting = createServer((_req, res) => { hits += 1; res.end("{}"); });
    await new Promise<void>((r) => counting.listen(0, "127.0.0.1", r));
    try {
      const col: Collection = {
        id: "c1", name: "c", variables: {}, folders: [],
        apis: [{
          id: "a1", name: "hookfail", version: "1", deprecated: false,
          method: "GET", url: `http://127.0.0.1:${(counting.address() as { port: number }).port}/x`, headers: [], query: [],
          cases: [
            { id: "t1", name: "first", scope: "base", parameters: {}, assertions: [] },
            { id: "t2", name: "second", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
          ],
        }],
      };
      const bus = createEventBus();
      bus.on("beforeCase", (p) => { if (p.caseName === "first") throw new Error("beforeCase 钩子失败"); });
      const result = await buildRunnerWith(bus).run(col, env, project, workspace, {});
      expect(result.total).toBe(2);
      expect(result.cases[0]!.passed).toBe(false);
      expect(result.cases[0]!.error).toContain("beforeCase");
      expect(result.cases[1]!.passed).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((r) => counting.close(() => r()));
    }
  });

  it("runtimeBridge：跨 run 携带运行时变量（工作流节点间传值基座）", async () => {
    const carried: Record<string, string> = {};
    const bridge = {
      get: () => ({ ...carried }),
      set: (vars: Record<string, string>) => { Object.assign(carried, vars); },
    };
    const runner = buildDeps();
    // 简报原稿 URL 为 http://127.0.0.1:1/（必然 ECONNREFUSED）：请求失败时 postScript 不会执行，
    // 变量可读性断言无从评估，故改用本文件顶层夹具 server（对位既有夹具，语义不变）。
    const col = (pre: string, post: string): Collection => ({
      id: "c", name: "c", variables: {}, folders: [],
      apis: [{ id: "a", name: "a", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [{ id: "t", name: "t", scope: "base", parameters: {}, preScript: pre, postScript: post, assertions: [] }] }],
    });
    const opts = { runtimeBridge: bridge };
    // run1: 提取 token
    await runner.run(col("pm.variables.set('token','abc');", ""), env, project, workspace, opts);
    expect(carried.token).toBe("abc");
    // run2: 读取 token（网络错误不影响变量断言——用后置脚本抛错检测可读性）
    const r2 = await runner.run(col("", "if (pm.variables.get('token') !== 'abc') throw new Error('token 丢失');"), env, project, workspace, opts);
    expect(r2.cases[0]!.error).toBeUndefined();
  });

  it("afterCase 钩子失败使当用例失败且不中断集合（钩子极性）", async () => {
    const col = collectionWith([
      { id: "t1", name: "hooked", scope: "base", parameters: {}, assertions: [] },
      { id: "t2", name: "next", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
    ]);
    const bus = createEventBus();
    bus.on("afterCase", (p) => { if (p.caseName === "hooked") throw new Error("afterCase 钩子失败"); });
    const result = await buildRunnerWith(bus).run(col, env, project, workspace, {});
    expect(result.total).toBe(2);
    expect(result.cases[0]!.passed).toBe(false);
    expect(result.cases[0]!.error).toContain("afterCase");
    expect(result.cases[1]!.passed).toBe(true);
    expect(result.passed).toBe(1);
  });
});

// —— M9-B 环境模型：前置 URL（按集合）双通道 + 工作区全局变量/全局参数 ——
describe("CollectionRunner 环境模型（M9-B）", () => {
  let server: Server;
  let base = "";
  const seen: Array<{ path: string; headerG: string; query: string; cookie: string; bodyG: string; bodyApiK: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          headerG: (req.headers["x-g"] as string | undefined) ?? "",
          query: new URL(req.url ?? "", base).search,
          cookie: (req.headers.cookie as string | undefined) ?? "",
          bodyG: /(?:^|&)gk=([^&]*)/.exec(raw)?.[1] ?? "",
          bodyApiK: /(?:^|&)api-k=([^&]*)/.exec(raw)?.[1] ?? "",
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function deps() {
    const registry = createPluginRegistry();
    registry.registerProtocol(httpClient);
    for (const p of builtinAuthProviders) registry.registerAuth(p);
    for (const o of builtinAssertOperators) registry.registerAssert(o);
    registry.registerScriptEngine(jsScriptEngine);
    return new CollectionRunner({ registry, bus: createEventBus(), timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 }, failFast: false });
  }

  function apiWith(url: string, extra: Partial<Collection["apis"][number]> = {}): Collection["apis"][number] {
    return {
      id: "a1", name: "a", version: "1", deprecated: false, method: "GET", url,
      headers: [], query: [],
      cases: [{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
      ...extra,
    };
  }

  it("操作执行：模块/文件夹前置自上而下、后置自下而上，用例级操作夹请求（M10）", async () => {
    seen.length = 0;
    const ap = (id: string) => `pm.variables.set('trace', (pm.variables.get('trace') ?? '') + '${id}')`;
    const op = (id: string): Operation => ({ id, type: "script", content: ap(id) });
    const env: Environment = { id: "e", name: "dev", variables: {}, baseUrls: {} };
    const project: Project = {
      id: "p", name: "p", variables: {},
      globals: { query: [], headers: [], cookies: [], body: [] },
      environments: [env], collections: [], workflows: [],
    };
    const ws: Workspace = { id: "w", name: "ws", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
    // 用例前置操作改写 pm.request（与 legacy preScript 同能力口径）；trace 变量跨用例经 persisted 流转
    const mkCase = (id: string, path: string) => ({
      id, name: id, scope: "base", parameters: {},
      preOperations: [{ id: `${id}-pre`, type: "script" as const, content: `${ap(`${id}-pre`)}; pm.request.url = pm.request.url + '-' + (pm.variables.get('trace') ?? '')` }],
      postOperations: [op(`${id}-post`)],
      assertions: [{ id: `as-${id}`, target: "status" as const, op: "eq" as const, expected: "200" }],
    });
    const apiIn = (id: string): Collection["apis"][number] => ({
      id, name: id, version: "1", deprecated: false, method: "GET", url: `${base}/${id}`,
      headers: [], query: [], cases: [mkCase(id, `/${id}`)],
    });
    const col: Collection = {
      id: "c1", name: "c", variables: {},
      preOperations: [op("m1"), op("m2")],
      postOperations: [op("M")],
      folders: [
        {
          id: "f1", name: "f1", preOperations: [op("f1")], postOperations: [op("F1")],
          apis: [],
          folders: [{
            id: "f2", name: "f2", preOperations: [op("f2")], postOperations: [op("F2")],
            apis: [apiIn("b")], folders: [],
          }],
        },
        { id: "f3", name: "f3", preOperations: [op("f3")], postOperations: [], apis: [apiIn("c")], folders: [] },
      ],
      apis: [],
    };
    // 前置链：m1 m2 → f1 → f2 →（b 用例 pre→请求）→ F2 → F1 → f3 →（c 用例 pre→请求）
    // 请求 b 的 trace = m1m2f1f2b-pre；请求 c 的 trace 再加上 b-post F2 F1（后置自下而上）+ f3
    const result = await deps().run(col, env, project, ws, {});
    expect(result.failed, result.cases.map((c) => c.error ?? "ok").join(" | ")).toBe(0);
    expect(seen[0]!.path).toBe("/b-m1m2f1f2b-pre");
    expect(seen[1]!.path).toBe("/c-m1m2f1f2b-preb-postF2F1f3c-pre");
  });

  it("前置 URL：相对 URL 自动拼接 + {{baseUrl}} 模板（环境按集合设置）", async () => {
    seen.length = 0;
    const env: Environment = { id: "e", name: "dev", variables: { who: "dev" }, baseUrls: { c1: `${base}/prefix` } };
    const project: Project = { id: "p", name: "p", variables: {}, environments: [env], collections: [], workflows: [] };
    const ws: Workspace = { id: "w", name: "ws", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
    const col: Collection = { id: "c1", name: "c", variables: {}, folders: [], apis: [apiWith("/rel/{{who}}"), apiWith("{{baseUrl}}/tpl")] };
    const result = await deps().run(col, env, project, ws, {});
    expect(result.failed).toBe(0);
    expect(seen[0]!.path).toBe("/prefix/rel/dev");
    expect(seen[1]!.path).toBe("/prefix/tpl");
  });

  it("全局变量=项目变量（链：环境>模块>全局）+ 全局参数 query/header/cookie/body 合并（M10）", async () => {
    seen.length = 0;
    const env: Environment = { id: "e", name: "dev", variables: {}, baseUrls: { c1: base } };
    // 全局变量即 project.variables（M10 合一）：gvar 在变量链最低层可被 {{gvar}} 引用
    const project: Project = {
      id: "p", name: "p", variables: { gvar: "G" },
      globals: {
        query: [{ key: "gq", value: "from-global", enabled: true }, { key: "api-q", value: "gone", enabled: true }],
        headers: [{ key: "x-g", value: "from-global", enabled: true }],
        cookies: [{ key: "sid", value: "from-cookie", enabled: true }],
        body: [{ key: "gk", value: "from-global", enabled: true }, { key: "api-k", value: "gone", enabled: true }],
      },
      environments: [env], collections: [], workflows: [],
    };
    const ws: Workspace = { id: "w", name: "ws", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "a", version: "1", deprecated: false, method: "POST",
        url: "/g/{{gvar}}",
        headers: [{ key: "x-g", value: "from-api", enabled: true }],
        query: [{ key: "api-q", value: "from-api", enabled: true }],
        body: { kind: "form", content: "", form: [{ key: "api-k", value: "from-api", enabled: true }] },
        cases: [{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
      }],
    };
    const result = await deps().run(col, env, project, ws, {});
    expect(result.failed).toBe(0);
    expect(seen[0]!.path).toBe("/g/G?gq=from-global&api-q=from-api"); // 全局 query 追加 + 请求同名优先
    expect(seen[0]!.headerG).toBe("from-api"); // 请求同名头优先
    expect(seen[0]!.cookie).toBe("sid=from-cookie"); // 全局 cookie 序列化
    expect(seen[0]!.bodyG).toBe("from-global"); // 全局 body 追加进 form
    expect(seen[0]!.bodyApiK).toBe("from-api"); // form 同名 key 优先
  });
});
