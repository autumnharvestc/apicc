# apicc M2-C 压测引擎（core + CLI）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 对单个接口用例发起并发压测：N 并发 + （迭代数或时长二选一）驱动、逐请求采样（耗时/状态码/成败）、聚合报告（RPS、延迟分位、错误分布）、CLI `apicc run-stress`。

**架构：** `packages/core/src/stress/` 纯新增模块。`StressRunner` 用 N 个异步循环共享原子计数器驱动（Node 事件轮 + 既有 undici 客户端，MVP 单进程；分布式 worker 为 M2-D）；采样为每请求一条 `{ timeMs, status, ok, error? }`；聚合为纯函数（百分位 nearest-rank）。请求构造复用既有域对象 + envChain 合并变量 + 既有 AuthProvider；**断言不参与压测采样**（ok = 2xx），MVP 明确此简化。

**技术栈：** 既有栈，无新运行时依赖。

**基线：** core 172 / cli 10 / desktop 229 全绿。**工作目录：** `D:\workspace260609\project-2\apicc-m2-stress`（分支 feature/m2-stress）。

**全局约束：** 品牌中立；中文 conventional commit；显式路径 git add；门禁 = core typecheck + core 全量 + cli 全量（cli 前 `pnpm -C packages/core build`）；desktop（apps/）不在范围，触及即 BLOCKED；禁危险操作、不推送远端。

---

## 文件结构

```
packages/core/src/stress/
  model.ts      StressSample / StressReport / StressOptions 类型 + zod（报告落盘校验）
  aggregate.ts  computeReport(samples, meta) 纯函数（nearest-rank 分位、RPS、状态分布、错误分类计数）
  build.ts      buildStressRequest(api, caseDef, resolver, authProviders) → ExecutableRequest
  runner.ts     StressRunner：并发池 + 采样 + deadline/迭代终止 + AbortSignal 透传
packages/cli/src/main.ts   run-stress 命令
packages/core/src/index.ts 导出追加
tests:
  packages/core/tests/stress/{aggregate,runner,build}.test.ts
  packages/cli/tests/e2e.test.ts 追加 run-stress 端到端
```

---

### 任务 1：模型与聚合（纯函数）

**文件：** 创建 `packages/core/src/stress/model.ts`、`packages/core/src/stress/aggregate.ts`；测试 `packages/core/tests/stress/aggregate.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import type { StressSample } from "../../src/stress/model.js";

const sample = (timeMs: number, status = 200, error?: string): StressSample =>
  ({ timeMs, status, ok: status >= 200 && status < 400 && !error, error });

describe("computeReport", () => {
  it("聚合计数/RPS/时长", () => {
    const r = computeReport(
      [sample(10), sample(20), sample(30)],
      { concurrency: 3, startedAt: 0, finishedAt: 3_000 },
    );
    expect(r.totalRequests).toBe(3);
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.durationMs).toBe(3_000);
    expect(r.rps).toBeCloseTo(1, 5);
  });

  it("nearest-rank 分位：p50/p95/p99/max", () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(i + 1));
    const r = computeReport(samples, { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    expect(r.latency.p50).toBe(50);
    expect(r.latency.p95).toBe(95);
    expect(r.latency.p99).toBe(99);
    expect(r.latency.max).toBe(100);
    expect(r.latency.min).toBe(1);
    expect(r.latency.avg).toBeCloseTo(50.5, 1);
  });

  it("失败与状态分布、错误分类计数", () => {
    const r = computeReport(
      [sample(10, 500), sample(10, 404), sample(10, 200, "ECONNREFUSED"), sample(10)],
      { concurrency: 2, startedAt: 0, finishedAt: 1_000 },
    );
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(3);
    expect(r.statusDist).toEqual({ "200": 1, "404": 1, "500": 1 });
    expect(r.errorKinds).toEqual({ ECONNREFUSED: 1, "HTTP_404": 1, "HTTP_500": 1 });
  });

  it("空样本不抛（除法防护）", () => {
    const r = computeReport([], { concurrency: 4, startedAt: 0, finishedAt: 0 });
    expect(r.totalRequests).toBe(0);
    expect(r.rps).toBe(0);
    expect(r.latency.p50).toBe(0);
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现**

`model.ts`：

```ts
import { z } from "zod";

export interface StressSample { timeMs: number; status: number; ok: boolean; error?: string }

export const StressReportSchema = z.object({
  concurrency: z.number().int().positive(),
  totalRequests: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  rps: z.number().nonnegative(),
  latency: z.object({ min: z.number(), avg: z.number(), max: z.number(), p50: z.number(), p90: z.number(), p95: z.number(), p99: z.number() }),
  statusDist: z.record(z.string(), z.number()),
  errorKinds: z.record(z.string(), z.number()),
  startedAt: z.number(), finishedAt: z.number(),
}).strict();
export type StressReport = z.infer<typeof StressReportSchema>;
```

`aggregate.ts`：nearest-rank 分位（sorted = asc；`q(sorted, p)` = `sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)]`）；空样本全 0；`errorKinds`：HTTP 非 2xx 记 `HTTP_${status}`，网络错误取 error 首个冒号前 token 或 `unknown`；`rps = totalRequests / (durationMs / 1000)`，duration 0 → 0。

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add packages/core/src/stress packages/core/tests/stress
git commit -m "feat(core): 压测采样模型与聚合报告（nearest-rank 分位）"
```

---

### 任务 2：请求构造（build.ts）

**文件：** 创建 `packages/core/src/stress/build.ts`；测试 `packages/core/tests/stress/build.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { buildStressRequest } from "../../src/stress/build.js";
import { createDefaultRegistry, createVariableResolver } from "../../src/index.js";

const api = {
  id: "a", name: "下单", version: "1", deprecated: false, method: "POST" as const,
  url: "{{baseUrl}}/orders", headers: [{ key: "X-K", value: "{{hid}}", enabled: true }],
  query: [{ key: "page", value: "1", enabled: true }],
  body: { kind: "json", content: '{"n":{{n}}}' },
  auth: { type: "bearer", token: "{{tok}}" } as never,
  cases: [],
};

describe("buildStressRequest", () => {
  it("解析变量并应用认证（provider 注入）", () => {
    const resolver = createVariableResolver({ layers: [{ baseUrl: "http://s", hid: "h1", n: "7", tok: "t" }] });
    const applied: string[] = [];
    const auths = [{ type: "bearer", apply: (req: { headers: Record<string, string> }) => { applied.push("bearer"); req.headers["Authorization"] = "Bearer t"; } }] as never;
    const req = buildStressRequest(api, resolver, auths as never);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://s/orders");
    expect(req.headers["X-K"]).toBe("h1");
    expect(req.headers["Authorization"]).toBe("Bearer t");
    expect(req.body?.content).toBe('{"n":7}');
    expect(applied).toEqual(["bearer"]);
  });
});
```

实现更正指令（照做）：`buildStressRequest(api: ApiDefinition, resolver: VariableResolver, authProviders: AuthProvider[])`——返回 `ExecutableRequest`（method/url 已解析/query 已过滤启用项/body 内容已解析/auth 已应用）。auth 类型断言改用 core `AuthProvider`/`AuthSpec` 真实类型，禁 `as never`。

- [ ] **步骤 2：运行验证失败 → 实现 → 通过**

实现要点：url/headers.value/query.value/body.content 逐项 `resolver.resolve`；auth 遍历 providers 找 `type` 匹配者 `apply(req, api.auth!, resolver.get)`；query 拼接沿用 http/client.ts 的 buildUrl 语义（此处只产 ExecutableRequest，拼接留给 client）。

- [ ] **步骤 3：Commit**

```bash
git add packages/core/src/stress/build.ts packages/core/tests/stress/build.test.ts
git commit -m "feat(core): 压测请求构造——变量解析与认证应用"
```

---

### 任务 3：并发池执行器（StressRunner）

**文件：** 创建 `packages/core/src/stress/runner.ts`；测试 `packages/core/tests/stress/runner.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StressRunner } from "../../src/stress/runner.js";
import { httpClient } from "../../src/http/client.js";

let server: Server; let hit = 0; let baseUrl = "";
beforeAll(async () => {
  server = createServer((_q, res) => { hit += 1; res.end("ok"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const makeRunner = (request: never) => new StressRunner({ client: httpClient, request, concurrency: 4 });

describe("StressRunner", () => {
  it("迭代模式：恰好 N 次请求、样本数一致、无失败", async () => {
    hit = 0;
    const runner = makeRunner({ method: "GET", url: () => baseUrl, headers: {}, query: [] } as never);
    const report = await runner.run({ concurrency: 4, maxIterations: 20 });
    expect(hit).toBe(20);
    expect(report.totalRequests).toBe(20);
    expect(report.failed).toBe(0);
    expect(report.concurrency).toBe(4);
  });

  it("时长模式：deadline 后停止且至少完成一次采样", async () => {
    hit = 0;
    const runner = makeRunner({ method: "GET", url: () => baseUrl, headers: {}, query: [] } as never);
    const report = await runner.run({ concurrency: 2, durationMs: 300 });
    expect(report.totalRequests).toBeGreaterThanOrEqual(1);
    expect(report.durationMs).toBeLessThan(5_000);
  });

  it("对拒连目标的错误计入 failed 且有错误分类", async () => {
    const runner = makeRunner({ method: "GET", url: () => "http://127.0.0.1:1/", headers: {}, query: [] } as never);
    const report = await runner.run({ concurrency: 2, maxIterations: 4 });
    expect(report.failed).toBe(4);
    expect(Object.keys(report.errorKinds).length).toBeGreaterThan(0);
  });
});
```

实现更正指令（照做）：`StressRunner` 构造参数 `{ client: ProtocolClient; request: { method; url(): string; headers; query; body?; auth? } | (() => ExecutableRequest) }`——**简化裁定：构造参数直接给一个 `buildRequest: () => ExecutableRequest` 工厂函数**（每次采样调用产出新请求对象，调用方闭包内做变量解析），去掉测试草稿里的对象形态。测试相应改为 `makeRunner(() => ({ method: "GET", url: `${baseUrl}/x`, headers: {}, query: [] }))`。`run(opts: { concurrency; maxIterations?; durationMs?; signal? })`：maxIterations 与 durationMs 必须给其一（都给时先到先停；都不给抛错）。

- [ ] **步骤 2：运行验证失败 → 实现**

实现要点：
- N 个异步 worker 共享状态：`remaining`（迭代模式原子递减用简单同步计数——JS 单线程安全）、`deadline`（时长模式每轮开始检查 `Date.now() < deadline`）
- 每采样：`performance.now()` 起止、`client.execute(request, { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 })`；异常捕获 → `ok:false, error: message`（status 记 0）
- `signal?: AbortSignal` 透传：aborted → 停止发起新采样
- 全 worker Promise.all 结束后 `computeReport(samples, meta)`
- 样本数组可能很大（时长模式）——内存可接受（10 万条 × ~64B ≈ 6MB），记录为已知边界

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add packages/core/src/stress/runner.ts packages/core/tests/stress/runner.test.ts
git commit -m "feat(core): 压测并发池执行器——迭代/时长双模式与采样"
```

---

### 任务 4：CLI run-stress + 端到端

**文件：** 修改 `packages/cli/src/main.ts`、`packages/core/src/index.ts`（导出追加：StressRunner/StressReport/computeReport/buildStressRequest 及类型）；测试 `packages/cli/tests/e2e.test.ts`（追加）

- [ ] **步骤 1：编写失败的 e2e**

```ts
it("run-stress 对接口用例并发压测并落盘 JSON", async () => {
  // 夹具：既有临时工作区 + 本地 server（复用文件内既有 beforeAll 资源）
  // 执行 runCli(["run-stress", "groups/demo/projects/svc/collections/api/apis/one",
  //   "--case", "<one 的用例 id>", "--env", "dev", "--concurrency", "4", "--iterations", "12",
  //   "--runs-dir", runsDir], ...)
  // 断言：exit 0；runsDir 出现 stress-*.json；JSON 中 totalRequests===12、concurrency===4
}, 30000);
```

- [ ] **步骤 2：运行验证失败 → 实现 run-stress**

命令定义（仿 run/run-workflow 模式）：

```ts
program
  .command("run-stress")
  .argument("<apiPath>", "接口目录（相对工作区根）")
  .requiredOption("--case <caseId>", "用例 ID")
  .option("--env <name>", "环境名称")
  .requiredOption("--concurrency <n>", "并发数", Number)
  .option("--iterations <n>", "总迭代数", Number)
  .option("--duration <s>", "持续秒数", Number)
  .option("--runs-dir <dir>", "报告输出目录")
  .action(async (apiPath: string, opts: { case: string; env?: string; concurrency: number; iterations?: number; duration?: number; runsDir?: string }) => {
    // 1. findWorkspaceRoot + storage.load（同 run 命令）；2. 定位接口（全树查找，同 run-workflow 的 findApi + 路径匹配）；
    // 3. 找 caseDef（未找到抛「未找到用例」）；4. env 解析（未指定 undefined；未命中抛「未找到环境」）；
    // 5. envChain 合并变量建 resolver（mergedEnvVars + workspace/project 变量层）；
    // 6. maxIterations/duration 二选一校验（都缺抛「需要 --iterations 或 --duration」）；
    // 7. new StressRunner({ client: httpClient, buildRequest: () => buildStressRequest(api, resolver, builtinAuthProviders) }).run(...)
    //    —— 注意：每次采样重跑 buildStressRequest 以便动态变量（如 {{$uuid}}）每请求变化
    // 8. 落盘 runsDir/stress-<apiId>-<Date.now()>.json（StressReport）；log 摘要（RPS/分位/失败）；exit：failed===total && total>0 → 1
  });
```

依赖导入：`httpClient`（core 已导出）、`buildStressRequest`（任务 2 新导出）、`StressRunner`（任务 3 新导出）、内置认证器（core 已导出）。`index.ts` 导出核对随本任务。

- [ ] **步骤 3：运行验证通过 + 全量回归 + Commit**

```bash
git add packages/core packages/cli
git commit -m "feat(cli): run-stress 命令与压测端到端"
```

---

## 规格覆盖对照

| 内容 | 任务 |
|------|------|
| 采样模型/聚合报告/分位 | 1 |
| 请求构造（变量/认证） | 2 |
| 并发池/迭代/时长/错误分类 | 3 |
| CLI + 端到端 + 落盘 | 4 |

**明确推迟（M2-D 或后续）**：断言参与采样、ramp-up、多目标场景压测、分布式 worker（M2-D）、desktop 压测视图、压测报告 HTML 化。

## 自检结果

1. 覆盖度：M2-C MVP 全条目映射；分布式/UI 显式排除。
2. 占位符扫描：无 TODO；测试草稿的 URL 缺陷已在更正指令中修正。
3. 类型一致性：`StressSample/StressReport` 任务 1 定义、3/4 消费；`buildStressRequest` 任务 2 定义、4 消费；`ExecutableRequest/ProtocolClient/AuthProvider` 为 M2-A 既有契约。
