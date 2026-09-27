# apicc 执行可信度与开发阶段压测基线实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 HTTP 连接模型、让压测执行真实用例语义，并以断言、性能阈值、施压端观测和精确目标确认给出可信报告与退出码。

**架构：** 把单用例执行从 `CollectionRunner` 提取为无跨 run 状态的执行内核，集合运行和压测共用它；压测以每 worker 一个虚拟用户 session 隔离变量与数据游标。HTTP 客户端改为拥有连接池生命周期的可实例化对象，压测报告新增失败分类、阈值 verdict、施压端资源/饱和度和安全发压元数据。目标安全由规范化 origin、项目目标策略和本次精确确认决定，不读取用户自定义环境名称或“生产”标签。

**技术栈：** TypeScript 5.9、Node.js ≥ 22.19、Undici 8、Zod 4、Vitest 4、Vue 3、Electron、Commander、pnpm。

**规格：**

- `docs/superpowers/specs/2026-09-27-apicc-api-lifecycle-platform-requirements.md`（覆盖 STRESS-101/102/103/104/105/110/111）。
- `docs/superpowers/specs/2026-09-27-apicc-core-capability-baseline-design.md`（覆盖 EXEC-001/002/003/004、HTTP-001/002、STRESS-001/002/009）。
- `docs/superpowers/specs/2026-09-27-apicc-plugin-api-and-script-security-design.md`（本计划不扩大脚本权限；受限脚本运行时在后续独立计划实现）。

## 全局约束

- 服务端相关验证使用 `JAVA_HOME=C:\Program Files\Java\jdk-21.0.12`，不得把 `bin` 写入 `JAVA_HOME`。
- 保持现有工作区和旧压测报告可读取；新增报告字段对旧产物使用 optional 兼容。本阶段不做旧 `ApiDefinition` 到 apicc 新契约的迁移兼容。
- 压测 `ok` 仅在传输、HTTP、脚本和断言全部成功时为 true。
- HTTP 延迟分位数使用 `requestTimeMs`，完整迭代耗时单独记录为 `iterationTimeMs`。
- 每个虚拟用户拥有独立运行时变量、持久变量和数据行游标。
- pooled 模式默认复用连接；fresh 模式显式关闭每次请求的连接。
- 阈值失败、任一业务失败、分片失败和安全保护拒绝均产生非零 CLI 退出码。
- 目标安全不使用环境名称或标签；非 loopback/首次目标必须确认规范化后的精确 origin，并把命中的目标策略写入报告。
- 施压端 CPU、RSS、事件循环延迟、调度积压和饱和原因进入报告；饱和报告不得被解释为服务端性能结论。
- 不在本计划中实现远程 agent、到达率模型、多阶段负载、工作流压测或完整 secret vault。
- 当前脚本执行继续复用现有 `ScriptEngine` 抽象，不新增 Node.js、文件系统、进程或系统环境变量权限。
- 所有行为变更先写失败测试，再写最少实现；每个任务完成后独立提交。

---

## 文件结构

### 新建

- `packages/core/src/runner/caseExecutor.ts`：共享单用例执行内核及 run-scoped 输入/输出类型。
- `packages/core/src/stress/caseSession.ts`：每虚拟用户的用例 session、数据游标和生命周期。
- `packages/core/src/stress/thresholds.ts`：阈值校验与 verdict 计算。
- `packages/core/src/stress/generatorMetrics.ts`：施压端资源采样、调度积压和饱和度判定。
- `packages/core/src/stress/safety.ts`：目标规范化、loopback 判断和精确确认策略。
- `packages/core/tests/runner/caseExecutor.test.ts`：用例语义内核测试。
- `packages/core/tests/stress/caseSession.test.ts`：虚拟用户隔离与功能/压测一致性测试。
- `packages/core/tests/stress/thresholds.test.ts`：阈值评估测试。
- `packages/core/tests/stress/generatorMetrics.test.ts`：施压端指标和饱和度测试。
- `packages/core/tests/stress/safety.test.ts`：目标确认与策略测试。
- `apps/desktop/tests/renderer/stores/stress.test.ts`：压测表单状态、输入归一和 IPC 载荷测试。

### 修改

- `packages/core/src/domain/model.ts`：项目级可信/禁用目标与压测上限策略。
- `packages/core/src/http/client.ts`：客户端工厂、连接模式、Agent 生命周期与中止信号。
- `packages/core/src/plugin/types.ts`：请求选项、执行响应和中止信号类型。
- `packages/core/src/runner/runner.ts`：移除 run 级实例字段，委托 case executor。
- `packages/core/src/report/types.ts`：为功能结果补充稳定错误分类；请求/响应仍由执行内核内部结果承载。
- `packages/core/src/stress/model.ts`：样本分类、配置、阈值和 verdict schema。
- `packages/core/src/stress/runner.ts`：虚拟用户 session 驱动、断言感知采样和资源清理。
- `packages/core/src/stress/aggregate.ts`：失败分类、两类耗时和 verdict 聚合。
- `packages/core/src/stress/distributed.ts`：worker 协议 v2 与新样本汇聚。
- `packages/core/src/index.ts`：导出新工厂、类型和阈值函数。
- `packages/cli/src/main.ts`：真实用例 session、阈值参数、安全参数和退出语义。
- `apps/desktop/src/shared/types.ts`：阈值与精确目标确认输入。
- `apps/desktop/src/main/ipc.ts`：IPC schema。
- `apps/desktop/src/main/stress.ts`：run-scoped client、case session、安全检查和清理。
- `apps/desktop/src/renderer/src/stores/stress.ts`：表单阈值字段与请求载荷。
- `apps/desktop/src/renderer/src/stores/workspace.ts`：项目目标策略的规范化更新与持久化。
- `apps/desktop/src/renderer/src/components/StressPanel.vue`：阈值输入和精确目标确认。
- `apps/desktop/src/renderer/src/components/StressReportView.vue`：verdict、失败分类与施压端饱和提示。
- `apps/desktop/src/renderer/src/i18n/zh-CN.json`：新增中文文案。
- `README.md`：能力边界、CLI 示例和“本地多进程分片”准确表述。

### 测试修改

- `packages/core/tests/http/client.test.ts`
- `packages/core/tests/domain/model.test.ts`
- `packages/core/tests/runner/runner.test.ts`
- `packages/core/tests/stress/runner.test.ts`
- `packages/core/tests/stress/aggregate.test.ts`
- `packages/core/tests/stress/distributed.test.ts`
- `packages/cli/tests/e2e.test.ts`
- `packages/cli/tests/stress-worker.test.ts`
- `packages/cli/tests/stress-subprocess.test.ts`
- `apps/desktop/tests/main/session.test.ts`
- `apps/desktop/tests/renderer/components/components.test.ts`
- `apps/desktop/tests/renderer/stores/workspace.test.ts`

---

### 任务 1：HTTP 客户端连接池与生命周期

**覆盖需求：** HTTP-001、HTTP-002、STRESS-102

**文件：**
- 修改：`packages/core/src/http/client.ts`
- 修改：`packages/core/src/plugin/types.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/tests/http/client.test.ts`

- [ ] **步骤 1：编写连接复用与 fresh 模式失败测试**

在测试 HTTP server 的 `connection` 事件上统计 socket，连续发送请求并断言：

```ts
it("pooled 模式复用连接，fresh 模式逐请求建连", async () => {
  let connections = 0;
  server.on("connection", () => { connections += 1; });

  const pooled = createHttpClient({ connectionMode: "pooled" });
  await pooled.execute(req, opts);
  await pooled.execute(req, opts);
  expect(connections).toBe(1);
  await pooled.close();

  connections = 0;
  const fresh = createHttpClient({ connectionMode: "fresh" });
  await fresh.execute(req, opts);
  await fresh.execute(req, opts);
  expect(connections).toBe(2);
  await fresh.close();
});
```

再增加 `close()` 后 socket 最终关闭、重复 `close()` 幂等、`AbortSignal` 能中止慢请求的测试。

- [ ] **步骤 2：运行 HTTP 测试验证失败**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/http/client.test.ts --reporter=verbose
```

预期：FAIL，`createHttpClient` 和 `signal` 尚不存在，或 pooled 连接数为 2。

- [ ] **步骤 3：实现可实例化 HTTP 客户端**

在 `plugin/types.ts` 扩展执行选项：

```ts
export interface HttpExecuteOptions {
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  signal?: AbortSignal;
}
```

在 `http/client.ts` 提供：

```ts
export interface HttpClientOptions {
  connectionMode?: "pooled" | "fresh";
}

export interface ManagedProtocolClient extends ProtocolClient {
  close(): Promise<void>;
}

export function createHttpClient(options: HttpClientOptions = {}): ManagedProtocolClient;
export const httpClient = createHttpClient();
```

pooled 模式按 `${connectTimeoutMs}:${totalTimeoutMs}` 缓存 Agent；fresh 模式只在显式选择时每请求创建并关闭 Agent。把 `opts.signal` 传给 Undici request，并删除“创建后必关”的默认路径。

- [ ] **步骤 4：运行测试与类型检查**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/http/client.test.ts tests/protocol/soap.test.ts --reporter=verbose
pnpm -C packages/core typecheck
```

预期：全部 PASS，类型检查退出码为 0。

- [ ] **步骤 5：提交任务 1**

```powershell
git add packages/core/src/http/client.ts packages/core/src/plugin/types.ts packages/core/src/index.ts packages/core/tests/http/client.test.ts
git commit -m "fix(core): 复用 HTTP 连接池并显式管理生命周期"
```

---

### 任务 2：提取无跨 run 状态的用例执行内核

**覆盖需求：** EXEC-001、EXEC-002、EXEC-003、STRESS-101、STRESS-103、STRESS-104

**文件：**
- 创建：`packages/core/src/runner/caseExecutor.ts`
- 创建：`packages/core/tests/runner/caseExecutor.test.ts`
- 修改：`packages/core/src/runner/runner.ts`
- 修改：`packages/core/src/report/types.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/tests/runner/runner.test.ts`

- [ ] **步骤 1：编写共享 executor 的失败测试**

测试必须覆盖：参数和数据行注入、前后置脚本、认证、声明式断言、脚本断言、变量持久化、响应状态与请求时间、错误分类，以及两个并发 globals 不串扰。另加 `beforeSend` 测试，证明 hook 接收到所有变量/参数/前置操作处理后的最终 `ExecutableRequest`，hook 拒绝时协议 client 调用次数为 0。

核心断言形态：

```ts
const result = await executeCase({
  api,
  testCase,
  row: { orderId: "42" },
  rowIndex: 0,
  isDataDriven: true,
  resolver,
  envVars: {},
  globals: globalsA,
  persisted: new Map(),
  persistedSnapshot: {},
}, deps);

expect(seenRequest.url).toContain("/orders/42");
expect(seenRequest.headers.Authorization).toBe("Bearer token-from-script");
expect(result.outcome.passed).toBe(true);
expect(result.response?.status).toBe(200);
expect(result.requestTimeMs).toBeGreaterThanOrEqual(0);
expect(result.failureKind).toBeUndefined();
```

并行隔离测试对同一个 executor 同时传 `globalsA` 与 `globalsB`，断言请求头不交叉。

- [ ] **步骤 2：运行 executor 测试验证失败**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/runner/caseExecutor.test.ts --reporter=verbose
```

预期：FAIL，模块与类型尚不存在。

- [ ] **步骤 3：定义输入输出与错误分类**

在 `caseExecutor.ts` 定义：

```ts
export type CaseFailureKind = "transport" | "http" | "script" | "assertion" | "config" | "aborted";

export interface CaseExecutionResult {
  outcome: CaseOutcome;
  request: ExecutableRequest;
  response?: ExecutionResponse;
  requestTimeMs: number;
  scriptTimeMs: number;
  iterationTimeMs: number;
  failureKind?: CaseFailureKind;
}

export async function executeCase(
  input: CaseExecutionInput,
  deps: CaseExecutionDeps,
): Promise<CaseExecutionResult>;
```

`CaseExecutionInput` 必须显式携带 globals、resolver、envVars、persisted、snapshot 和数据行；不得引用 `CollectionRunner` 实例字段。

`CaseExecutionDeps` 使用 `resolveProtocol(request)`、`resolveAuth(type)`、`resolveAssert(op)`、`scriptEngine` 和可选 `beforeSend(finalRequest)` 等窄接口，而不是在内部创建默认 registry。`beforeSend` 必须位于变量/参数/认证/前置操作完成之后、`ProtocolClient.execute` 之前，拒绝时不得发包。集合运行用现有 registry 适配且默认不注入该 hook；压测 session 用它执行目标策略检查，对 HTTP 返回自身 managed client，对 WS/SOAP 和插件协议委托调用方 registry，保证既有多协议入口不回退。

- [ ] **步骤 4：把现有 runCase 逻辑移入 executor**

迁移请求构建、global 合并、cookie 注入、脚本上下文、协议选择和断言逻辑。保持集合运行现有顺序与错误文案；`CollectionRunner.runCase` 改为薄委托或删除，由 `runApi` 直接调用 `executeCase`。用 monotonic clock 分别包围协议请求、脚本阶段和完整迭代，确保 `requestTimeMs` 不含脚本时间，`scriptTimeMs` 为前后置脚本时间之和，`iterationTimeMs` 包含完整用例语义。

同时删除 `CollectionRunner` 的 `globalQuery/globalHeaders/globalCookies/globalBody` 字段，globals 作为 run-scoped 参数向下传递。

- [ ] **步骤 5：运行 runner 回归与并发隔离测试**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/runner/caseExecutor.test.ts tests/runner/runner.test.ts tests/protocol/cross-protocol.test.ts --reporter=verbose
pnpm -C packages/core typecheck
```

预期：全部 PASS；原集合运行测试数量不减少。

- [ ] **步骤 6：提交任务 2**

```powershell
git add packages/core/src/runner/caseExecutor.ts packages/core/src/runner/runner.ts packages/core/src/report/types.ts packages/core/src/index.ts packages/core/tests/runner/caseExecutor.test.ts packages/core/tests/runner/runner.test.ts
git commit -m "refactor(core): 提取共享用例执行内核并隔离运行状态"
```

---

### 任务 3：虚拟用户用例 session 与数据隔离

**覆盖需求：** EXEC-001、EXEC-002、STRESS-001、STRESS-101

**文件：**
- 创建：`packages/core/src/stress/caseSession.ts`
- 创建：`packages/core/tests/stress/caseSession.test.ts`
- 修改：`packages/core/src/stress/runner.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/tests/stress/runner.test.ts`

- [ ] **步骤 1：编写虚拟用户 session 失败测试**

测试两个 session 各执行两次，前置脚本递增各自的变量，断言每个 session 看到 `1, 2`，而不是共享的 `1, 2, 3, 4`。数据驱动夹具使用两行数据，断言每个虚拟用户按自身游标循环 `A, B`。

```ts
const vu1 = createStressCaseSession(target, deps, { workerId: 0 });
const vu2 = createStressCaseSession(target, deps, { workerId: 1 });

expect((await vu1.execute()).request.url).toContain("row=A");
expect((await vu1.execute()).request.url).toContain("row=B");
expect((await vu2.execute()).request.url).toContain("row=A");
await Promise.all([vu1.close(), vu2.close()]);
```

增加 case parameters、pre/post operations、声明式断言和脚本断言均参与的用例。

- [ ] **步骤 2：运行 session 测试验证失败**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress/caseSession.test.ts --reporter=verbose
```

预期：FAIL，`createStressCaseSession` 尚不存在。

- [ ] **步骤 3：实现 session 接口**

```ts
export interface StressWorkerSession {
  execute(signal?: AbortSignal): Promise<CaseExecutionResult>;
  close(): Promise<void>;
}

export interface StressCaseTarget {
  api: ApiDefinition;
  testCase: TestCase;
  env?: Environment;
  project: Project;
  collection: Collection;
  workspace: Workspace;
}

export function createStressCaseSession(
  target: StressCaseTarget,
  deps: StressCaseSessionDeps,
  options: {
    workerId: number;
    authorizeRequest?(request: ExecutableRequest): void | Promise<void>;
  },
): StressWorkerSession;
```

session 创建自己的 resolver、persisted、snapshot 和数据游标。数据文件在 session 创建时读取并校验；空数据按单行 undefined。每次迭代把 `authorizeRequest` 接到 executor 的 `beforeSend`，因此数据行、变量或脚本改变 origin 后仍需按最终 URL 授权。`close()` 幂等并关闭 session 持有的 managed client。

- [ ] **步骤 4：把 StressRunner 改为 session 工厂驱动**

将构造参数改为：

```ts
export interface StressRunnerOptions {
  createWorker(workerId: number): Promise<StressWorkerSession> | StressWorkerSession;
}
```

每个并发 worker 只创建一个 session，在循环中调用 `execute(signal)`，并在 `finally` 关闭。样本使用 executor 返回的 `requestTimeMs`、`scriptTimeMs`、`iterationTimeMs`、status、failureKind 和 outcome。

- [ ] **步骤 5：迁移 StressRunner 既有测试**

把 `client + buildRequest` 测试夹具替换为 fake session factory，保留迭代数、持续时间、先到先停、abort 和错误分类覆盖。增加 `close()` 在成功、异常和中止路径都恰好调用一次的断言。

- [ ] **步骤 6：运行 core stress 回归**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress/caseSession.test.ts tests/stress/runner.test.ts --reporter=verbose
pnpm -C packages/core typecheck
```

预期：全部 PASS。

- [ ] **步骤 7：提交任务 3**

```powershell
git add packages/core/src/stress/caseSession.ts packages/core/src/stress/runner.ts packages/core/src/index.ts packages/core/tests/stress/caseSession.test.ts packages/core/tests/stress/runner.test.ts
git commit -m "feat(core): 压测按虚拟用户执行真实用例语义"
```

---

### 任务 4：断言感知样本、失败分类与性能阈值

**覆盖需求：** EXEC-003、EXEC-004、STRESS-001、STRESS-002、STRESS-103、STRESS-104、STRESS-105

**文件：**
- 创建：`packages/core/src/stress/thresholds.ts`
- 创建：`packages/core/tests/stress/thresholds.test.ts`
- 修改：`packages/core/src/stress/model.ts`
- 修改：`packages/core/src/stress/aggregate.ts`
- 修改：`packages/core/src/stress/runner.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/tests/stress/aggregate.test.ts`
- 测试：`packages/core/tests/stress/runner.test.ts`

- [ ] **步骤 1：编写 schema、分类和阈值失败测试**

覆盖以下情形：HTTP 200 + 断言失败、HTTP 500、脚本异常、连接异常、p95 超限、错误率超限、最低 RPS 未达，以及无阈值时 verdict 仍因业务失败为 false。

```ts
const verdict = evaluateStressThresholds(report, {
  maxErrorRate: 0.01,
  maxAssertionFailureRate: 0,
  maxP95Ms: 500,
  minRps: 100,
});
expect(verdict.passed).toBe(false);
expect(verdict.violations.map((v) => v.metric)).toContain("p95");
```

旧报告对象仍应通过 `StressReportSchema.parse`，其 `verdict` 为 undefined 并在 UI 显示未评估。

- [ ] **步骤 2：运行聚合与阈值测试验证失败**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress/aggregate.test.ts tests/stress/thresholds.test.ts --reporter=verbose
```

预期：FAIL，新字段与函数尚不存在。

- [ ] **步骤 3：扩展样本与报告模型**

```ts
export type StressFailureKind = "transport" | "http" | "script" | "assertion" | "config" | "aborted";

export interface StressSample {
  requestTimeMs: number;
  scriptTimeMs: number;
  iterationTimeMs: number;
  status: number;
  ok: boolean;
  failureKind?: StressFailureKind;
  error?: string;
}

export interface StressThresholds {
  maxErrorRate?: number;
  maxAssertionFailureRate?: number;
  maxP95Ms?: number;
  minRps?: number;
}
```

报告新增 `failures` 分类计数、`scriptLatency`、`iterationLatency`、`thresholds`、`verdict`、`generator` 和 `safety`。`safety.targetOrigins` 按规范化 origin 去重，分别记录确认方式和命中策略；旧字段 `latency` 保留，含义固定为请求延迟。前置与后置脚本分别计时后汇总为 `scriptTimeMs`，避免脚本耗时污染 HTTP 请求延迟分位数。`generator`、`safety` 对旧报告保持 optional，新运行必须写入。

- [ ] **步骤 4：实现聚合与 verdict**

`computeReport` 汇总稳定失败分类；`evaluateStressThresholds` 返回机器可读 violation：

```ts
export interface StressViolation {
  metric: "errorRate" | "assertionFailureRate" | "p95" | "rps" | "businessFailures";
  actual: number;
  expected: number;
  message: string;
}
```

未提供阈值但存在任何非 aborted 失败时加入 `businessFailures` violation。用户主动停止导致的未发请求不计失败；已中止请求按 aborted 分类并在报告标记 incomplete。

- [ ] **步骤 5：运行所有 core stress 测试**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress --reporter=verbose
pnpm -C packages/core typecheck
```

预期：全部 PASS。

- [ ] **步骤 6：提交任务 4**

```powershell
git add packages/core/src/stress/model.ts packages/core/src/stress/thresholds.ts packages/core/src/stress/aggregate.ts packages/core/src/stress/runner.ts packages/core/src/index.ts packages/core/tests/stress/aggregate.test.ts packages/core/tests/stress/thresholds.test.ts packages/core/tests/stress/runner.test.ts
git commit -m "feat(core): 压测按业务结果分类并评估性能阈值"
```

---

### 任务 5：施压端资源、积压与饱和度观测

**覆盖需求：** STRESS-105、STRESS-110、STRESS-111

**文件：**
- 创建：`packages/core/src/stress/generatorMetrics.ts`
- 创建：`packages/core/tests/stress/generatorMetrics.test.ts`
- 修改：`packages/core/src/stress/model.ts`
- 修改：`packages/core/src/stress/runner.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/tests/stress/runner.test.ts`

- [ ] **步骤 1：用可注入探针编写确定性失败测试**

不用真实烧 CPU 或依赖操作系统瞬时值。给 collector 注入时钟、CPU、RSS 和事件循环延迟探针，覆盖：

- CPU 百分比按 `cpuTimeMs / wallTimeMs * 100` 计算并允许超过 100，报告原始 user/system CPU 时间；
- 运行期间保留 peak RSS，而不是只记录结束瞬间；
- `eventLoopDelayP95Ms > 100`、`cpuPercent >= 90` 或 `schedulerBacklogMax > 0` 分别产生稳定 reason；
- 任一 reason 存在时 `saturated=true`，同时写入用于判定的 limits；
- 可注入时钟下 `maxRps=5` 时任意相邻一秒窗口最多启动 5 次迭代；等待安全限速的 worker 不计为生成器饱和或调度积压；
- `stop()` 幂等并清理采样 timer；runner 正常、主动中止和异常路径都只停止一次 collector。

```ts
expect(metrics).toMatchObject({
  saturated: true,
  reasons: ["event-loop-delay", "scheduler-backlog"],
  limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
});
```

- [ ] **步骤 2：运行指标测试验证失败**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress/generatorMetrics.test.ts tests/stress/runner.test.ts --reporter=verbose
```

预期：FAIL，collector 和报告字段尚不存在。

- [ ] **步骤 3：定义稳定报告模型和默认采样器**

```ts
export interface StressGeneratorMetrics {
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuPercent: number;
  rssStartBytes: number;
  rssPeakBytes: number;
  eventLoopDelayP95Ms: number;
  schedulerBacklogMax: number;
  saturated: boolean;
  reasons: Array<"cpu" | "event-loop-delay" | "scheduler-backlog">;
  limits: {
    cpuPercent: number;
    eventLoopDelayP95Ms: number;
    schedulerBacklog: number;
  };
}
```

默认实现使用 `process.cpuUsage()`、`process.memoryUsage().rss` 与 `node:perf_hooks` 的 `monitorEventLoopDelay({ resolution: 20 })`，每 250 ms 采样 RSS，timer 调用 `unref()`。collector 接受依赖注入，使测试不依赖机器负载。恒定并发模型没有排队时 `schedulerBacklogMax=0`；调度器发现已到执行时点但无 worker 容量时递增 backlog，后续到达率模型沿用同一字段。

`StressRunner.run()` 增加可选 `maxRps` 安全上限，以共享、可中止的启动许可器限制全部 worker 的迭代开始频率。它只是目标保护上限，不是恒定到达率负载模型，不承诺到达率误差；等待许可不算 scheduler backlog。`maxRps` 必须为正数。

- [ ] **步骤 4：接入 StressRunner 生命周期**

每次 `StressRunner.run()` 创建一个 collector；在 `finally` 中停止并将结果写入 `StressReport.generator`。collector 与 HTTP client 生命周期分开，任一初始化失败都不得遗留 timer、histogram 或许可等待器。`generator.saturated` 不混入目标服务的业务失败数；CLI/UI 单独提示“施压端已饱和，本次结果不能单独用于判断服务端上限”。

- [ ] **步骤 5：运行 core stress 回归**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress --reporter=verbose
pnpm -C packages/core typecheck
```

预期：全部 PASS，无存活采样 timer 警告。

- [ ] **步骤 6：提交任务 5**

```powershell
git add packages/core/src/stress/generatorMetrics.ts packages/core/src/stress/model.ts packages/core/src/stress/runner.ts packages/core/src/index.ts packages/core/tests/stress/generatorMetrics.test.ts packages/core/tests/stress/runner.test.ts
git commit -m "feat(core): 记录施压端资源与饱和状态"
```

---

### 任务 6：升级本地分片协议并保持统计一致

**覆盖需求：** EXEC-004、STRESS-001、STRESS-002、STRESS-103、STRESS-105、STRESS-111

**文件：**
- 修改：`packages/core/src/stress/distributed.ts`
- 修改：`packages/core/src/stress/model.ts`
- 修改：`packages/cli/src/main.ts`
- 测试：`packages/core/tests/stress/distributed.test.ts`
- 测试：`packages/cli/tests/stress-worker.test.ts`
- 测试：`packages/cli/tests/stress-subprocess.test.ts`

- [ ] **步骤 1：编写 v2 协议与跨分片 verdict 失败测试**

把 worker 协议版本升级为 2，样本使用任务 4 的新结构。测试：

- v1 worker 输出被明确拒绝并记录版本不兼容；
- 两个 shard 的 assertionFailed 合并后计数正确；
- 合并报告重新计算全局 p95、错误率和 verdict；
- coordinator 将全局 `maxRps` 按 shard 数拆分，全部 shard 的配置上限之和不超过全局值；
- 每个 shard 保留独立 generator 指标，顶层取峰值/最大延迟并在任一 shard 饱和时标记饱和；
- 任一 shard 失败时 verdict 失败且 `dataComplete=false`。

- [ ] **步骤 2：运行分片测试验证失败**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress/distributed.test.ts --reporter=verbose
pnpm -C packages/cli exec vitest run tests/stress-worker.test.ts --reporter=verbose
```

预期：FAIL，协议仍要求 `protocolVersion: 1`。

- [ ] **步骤 3：实现 v2 schema 与汇聚**

将 `StressWorkerSpecSchema`、`ShardResultSchema`、`ShardFailureSchema` 的版本固定为 2。worker 返回新 `StressSample`；协调器合并后只在全局窗口上调用一次 `computeReport` 和 `evaluateStressThresholds`。全局 `maxRps` 以浮点配额平均拆给 shard，worker 接受正数配额；这是安全上限而非到达率目标。`perShard` 保留原始 generator 指标；顶层 generator 聚合 CPU 时间总和、RSS 峰值最大值、事件循环延迟最大值、积压最大值，并合并去重 saturation reasons。

`distributed` 增加：

```ts
dataComplete: boolean;
protocolVersion: 2;
```

分片失败、超时或协议错误时 `dataComplete=false`。

- [ ] **步骤 4：更新真实子进程测试**

真实子进程夹具增加一个 HTTP 200 但断言失败的用例，断言多 shard 报告 `assertionFailed > 0`、verdict 失败、CLI exit 1。保留成功、坏 caseId、超时和全部 shard 失败覆盖。

- [ ] **步骤 5：运行 core/CLI 分片回归**

运行：

```powershell
pnpm -C packages/core exec vitest run tests/stress/distributed.test.ts --reporter=verbose
pnpm -C packages/cli exec vitest run tests/stress-worker.test.ts tests/stress-subprocess.test.ts --reporter=verbose
pnpm -C packages/cli build
```

预期：全部 PASS，构建退出码为 0。

- [ ] **步骤 6：提交任务 6**

```powershell
git add packages/core/src/stress/distributed.ts packages/core/src/stress/model.ts packages/cli/src/main.ts packages/core/tests/stress/distributed.test.ts packages/cli/tests/stress-worker.test.ts packages/cli/tests/stress-subprocess.test.ts
git commit -m "feat(core,cli): 升级本地分片协议并统一业务失败统计"
```

---

### 任务 7：CLI 真实用例、阈值、目标确认与退出码

**覆盖需求：** EXEC-001、EXEC-004、STRESS-002、STRESS-009、STRESS-101、STRESS-105、STRESS-110、STRESS-111

**文件：**
- 修改：`packages/cli/src/main.ts`
- 修改：`packages/core/src/domain/model.ts`
- 创建：`packages/core/src/stress/safety.ts`
- 修改：`packages/core/src/stress/caseSession.ts`
- 修改：`packages/core/src/stress/model.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/cli/tests/e2e.test.ts`
- 测试：`packages/cli/tests/stress-worker.test.ts`
- 测试：`packages/core/tests/domain/model.test.ts`
- 创建：`packages/core/tests/stress/safety.test.ts`

- [ ] **步骤 1：编写 CLI 行为失败测试**

在临时工作区中增加：

- 用例参数改变 URL/请求体；
- 前置脚本设置请求头；
- 后置断言故意失败；
- loopback、非 loopback、大小写/默认端口等价和 origin 不匹配目标；
- 未确认目标、被项目策略禁用目标，以及超过项目目标速率上限。

断言项目尚未信任的首次目标（包括 loopback）不带 `--allow-target <origin>` 时，在发请求前拒绝并打印规范化 origin；非 loopback 目标同样默认拒绝。参数可重复，只有与最终请求 origin 精确匹配才允许运行，项目 `trustedOrigins` 可免除重复确认，`deniedOrigins` 始终优先。报告按 origin 去重记录命中的项目策略、确认方式和是否 loopback。HTTP 200 + 断言失败 exit 1，生成器饱和时摘要显示独立警告。

- [ ] **步骤 2：运行 CLI e2e 验证失败**

运行：

```powershell
pnpm -C packages/cli exec vitest run tests/e2e.test.ts --reporter=verbose
```

预期：FAIL，现有 CLI 忽略用例语义且无阈值/精确目标确认参数。

- [ ] **步骤 3：实现目标规范化与项目目标策略**

在 core 中集中实现，CLI 和桌面端不得各写一套判断：

```ts
export interface StressTargetPolicy {
  trustedOrigins?: string[];
  deniedOrigins?: string[];
  maxConcurrency?: number;
  maxRps?: number;
}

export interface StressSafetyDecision {
  targetOrigin: string;
  loopback: boolean;
  confirmation: "explicit" | "project-policy";
  appliedPolicy?: StressTargetPolicy;
}

export function assertStressTargetAllowed(input: {
  url: string;
  confirmedTargetOrigins?: string[];
  policy?: StressTargetPolicy;
  concurrency: number;
  maxRps?: number;
}): StressSafetyDecision;
```

在 `ProjectSchema` 增加可选 `stressPolicy`，内部为 `trustedOrigins`、`deniedOrigins`、`maxConcurrency`、`maxRps`，origin 在解析时规范化并去重；未配置时默认为空策略，现有项目文件可直接读取。这是当前 apicc 契约的一部分，不引入旧 `ApiDefinition` 迁移层。

使用 `new URL(url).origin` 规范化协议、host、IPv6 和默认端口。`localhost`、`127.0.0.0/8`、`::1` 只用于报告标记，不作为绕过首次目标确认的隐式权限。目标只有精确确认或项目 `trustedOrigins` 命中时放行，`deniedOrigins` 优先。不得读取环境名称、环境标签或新增 `production` 字段。拒绝时抛出带 `code: "target_confirmation_required"`、`targetOrigin` 的结构化错误。

- [ ] **步骤 4：扩展 CLI 参数并执行真实用例**

`run-stress` 增加：

```text
--max-error-rate <ratio>
--max-assertion-failure-rate <ratio>
--max-p95-ms <ms>
--min-rps <n>
--max-rps <n>
--connection-mode <pooled|fresh>
--allow-target <origin>  # 可重复
```

比例范围固定为 0 到 1；毫秒与 RPS 必须为正数；每个 `--allow-target` 必须是 HTTP(S) origin，不能包含路径、查询或 fragment。CLI `--max-rps` 可设置比项目策略更低的安全上限，不得覆盖项目 `maxRps`；有效上限取两者最小值。并发数不得超过项目 `maxConcurrency`。非法输入使用中文错误并在发请求前拒绝。

`resolveStressTarget` 必须返回选中的 `testCase`、api、collection、project、workspace 和 env，并创建 `StressCaseSession`。删除“case 参数/断言不参与采样”的旧注释与执行路径；`buildStressRequest` 作为兼容导出保留，但 CLI 不再使用它执行用例压测。

- [ ] **步骤 5：统一退出码、报告安全元数据和摘要**

退出码规则固定为：

```ts
process.exitCode = shardFailureCount > 0 || report.verdict?.passed === false ? 1 : 0;
```

摘要打印 verdict、失败分类、每条 threshold violation、全部 target origins 和 generator saturation。目标拒绝、项目策略拒绝、阈值失败、业务失败或分片失败均为 exit 1；参数/schema 错误继续使用现有 CLI 参数错误码。旧报告无 verdict 不影响当前新运行，因为新 runner 必须产出 verdict。

- [ ] **步骤 6：运行 CLI 全量测试与构建**

运行：

```powershell
pnpm -C packages/cli test
pnpm -C packages/cli build
```

预期：全部 PASS，构建退出码为 0。

- [ ] **步骤 7：提交任务 7**

```powershell
git add packages/core/src/domain/model.ts packages/core/src/stress/safety.ts packages/core/src/stress/caseSession.ts packages/core/src/stress/model.ts packages/core/src/index.ts packages/cli/src/main.ts packages/core/tests/domain/model.test.ts packages/core/tests/stress/safety.test.ts packages/cli/tests/e2e.test.ts packages/cli/tests/stress-worker.test.ts
git commit -m "feat(cli): 压测执行真实用例并实施精确目标确认"
```

---

### 任务 8：桌面端阈值、目标确认与可信报告

**覆盖需求：** EXEC-001、EXEC-002、EXEC-004、STRESS-002、STRESS-009、STRESS-101、STRESS-105、STRESS-110、STRESS-111

**文件：**
- 修改：`apps/desktop/src/shared/types.ts`
- 修改：`apps/desktop/src/main/ipc.ts`
- 修改：`apps/desktop/src/main/stress.ts`
- 修改：`apps/desktop/src/renderer/src/stores/stress.ts`
- 修改：`apps/desktop/src/renderer/src/stores/workspace.ts`
- 修改：`apps/desktop/src/renderer/src/components/StressPanel.vue`
- 修改：`apps/desktop/src/renderer/src/components/StressReportView.vue`
- 修改：`apps/desktop/src/renderer/src/i18n/zh-CN.json`
- 测试：`apps/desktop/tests/main/session.test.ts`
- 创建：`apps/desktop/tests/renderer/stores/stress.test.ts`
- 测试：`apps/desktop/tests/renderer/stores/workspace.test.ts`
- 测试：`apps/desktop/tests/renderer/components/components.test.ts`

- [ ] **步骤 1：编写 main 与 IPC 失败测试**

断言桌面端把 api/case/env 解析成真实 case session；非 loopback 或项目内首次出现的目标返回结构化确认错误且请求数为 0；确认对话框展示规范化后的精确 origin，用户确认后只携带该 origin 重试；origin 不匹配、禁用策略或速率上限超出仍拒绝。完成、中止、异常均关闭 managed client 和 generator collector。

- [ ] **步骤 2：编写 store 与组件失败测试**

表单增加四个可选阈值、连接模式和折叠的项目“目标策略”区域，可编辑可信 origin、禁用 origin、并发上限和 RPS 上限。测试输入归一、IPC 载荷、策略持久化、目标确认、verdict 成败 Tag、失败分类表、generator 指标/饱和警告和 violation 中文列表。确认对话框提供“仅本次运行”和风险提示清晰的“信任此项目目标”；仅后者通过 workspace store 把精确 origin 写入 `project.stressPolicy.trustedOrigins`。旧报告 `verdict` 缺失时显示“未评估”，不得显示“通过”；旧报告无 generator 时显示“未采集”，不得推断未饱和。

- [ ] **步骤 3：运行桌面目标测试验证失败**

运行：

```powershell
pnpm -C apps/desktop exec vitest run tests/main/session.test.ts tests/renderer/stores/stress.test.ts tests/renderer/stores/workspace.test.ts tests/renderer/components/components.test.ts --reporter=verbose
```

预期：FAIL，新字段、确认路径和展示尚不存在。

- [ ] **步骤 4：扩展共享输入与 IPC schema**

`StressRunInput` 增加：

```ts
thresholds?: StressThresholds;
connectionMode?: "pooled" | "fresh";
confirmedTargetOrigins?: string[];
```

IPC 用 Zod 校验比例 0..1、正数阈值、连接模式枚举和纯 HTTP(S) origin 数组，拒绝 unknown 字段。确认值不得使用布尔量，避免页面状态变化后误放行另一个目标。

- [ ] **步骤 5：接入 main 真实 session 与资源清理**

桌面 HTTP 压测使用 `createHttpClient` 和 `createStressCaseSession`。保留当前桌面仅支持 HTTP 的协议守卫。session 在最终请求发包前复用 core 的 `assertStressTargetAllowed`；main 返回 `code: "target_confirmation_required"` 和本次缺少的 `targetOrigin`，渲染层展示 origin、加入本次运行的 `confirmedTargetOrigins` 集合后重试。选择项目信任时，先由 workspace store 规范化、去重并持久化 origin，再重试；只允许更新当前项目，不把信任扩散到工作区其他项目。项目已信任的 origin 可由项目策略放行；禁用策略始终优先且不能由本次确认覆盖。不得读取环境名称或标签。

- [ ] **步骤 6：实现表单和报告展示**

StressPanel 增加折叠的“通过标准”和“目标策略”区域；阈值空值表示不设置自定义阈值，策略 origin 保存前统一规范化并阻止同一 origin 同时出现在可信/禁用列表。StressReportView 顶部显示通过/失败/未评估，随后显示失败分类、阈值实际值与期望值、目标安全元数据、CPU/RSS/事件循环延迟/调度积压。`generator.saturated=true` 时用醒目但独立的警告说明结果边界。原延迟、状态码和错误表继续保留。

- [ ] **步骤 7：运行桌面测试、类型检查和构建**

运行：

```powershell
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop build
```

预期：全部 PASS，类型检查和构建退出码为 0。

- [ ] **步骤 8：提交任务 8**

```powershell
git add apps/desktop/src/shared/types.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/stress.ts apps/desktop/src/renderer/src/stores/stress.ts apps/desktop/src/renderer/src/stores/workspace.ts apps/desktop/src/renderer/src/components/StressPanel.vue apps/desktop/src/renderer/src/components/StressReportView.vue apps/desktop/src/renderer/src/i18n/zh-CN.json apps/desktop/tests/main/session.test.ts apps/desktop/tests/renderer/stores/stress.test.ts apps/desktop/tests/renderer/stores/workspace.test.ts apps/desktop/tests/renderer/components/components.test.ts
git commit -m "feat(desktop): 展示可信压测结论并确认精确目标"
```

---

### 任务 9：端到端一致性、文档与阶段门禁

**覆盖需求：** 阶段 A 全部需求

**文件：**
- 修改：`packages/cli/tests/e2e.test.ts`
- 修改：`apps/desktop/tests/main/session.test.ts`
- 修改：`README.md`
- 修改：`docs/superpowers/specs/2026-09-27-apicc-core-capability-baseline-design.md`（仅在实现发现已批准规格需要精确勘误时修改）

- [ ] **步骤 1：增加功能运行与压测一致性端到端测试**

同一个夹具用例包含参数、数据行、前置脚本、后置脚本、声明式断言和脚本断言。先通过集合运行记录请求与结果，再以 `concurrency=1, iterations=1` 压测，断言：

```ts
expect(stressObservedRequest).toEqual(functionalObservedRequest);
expect(stressReport.ok).toBe(functionalResult.passed ? 1 : 0);
expect(stressReport.verdict?.passed).toBe(functionalResult.passed);
```

另加 HTTP 200 + 断言失败、pooled/fresh 连接数、精确目标确认、项目目标策略、generator 饱和提示和阈值失败场景。目标确认测试必须证明改变 path 不需要重复确认、改变 scheme/host/port 必须重新确认，且环境名称或标签变化不影响结论。

- [ ] **步骤 2：更新 README 能力边界与示例**

把“分布式压测”改为“本地多进程分片压测”，明确远程 agent 尚未提供。更新 CLI 示例，展示阈值和 `--allow-target <origin>`，说明该参数只确认精确 origin、不能覆盖项目 denylist；同时说明压测会执行所选用例的参数、脚本和断言，以及 generator 饱和时报告的解释边界。

- [ ] **步骤 3：执行 core/CLI/desktop 完整验证**

运行：

```powershell
pnpm -C packages/core test
pnpm -C packages/core typecheck
pnpm -C packages/core build
pnpm -C packages/cli test
pnpm -C packages/cli build
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop build
```

预期：所有命令退出码为 0，无失败测试。

- [ ] **步骤 4：执行服务端与 Windows 集成回归**

运行：

```powershell
$env:JAVA_HOME='C:\Program Files\Java\jdk-21.0.12'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
pnpm -C apps/admin-web test
pnpm -C apps/admin-web build
Push-Location server
./mvnw.cmd test
Pop-Location
```

预期：admin-web 测试/构建与 Maven 测试全部退出码为 0。若根级并行命令仍有共享 JAR 竞争，记录到阶段 B 的 ENG-001 独立计划，不在本任务混入无关重构。

- [ ] **步骤 5：检查规格覆盖、兼容与工作区状态**

运行：

```powershell
rg -n "EXEC-001|EXEC-003|EXEC-004|HTTP-001|HTTP-002|STRESS-001|STRESS-002|STRESS-009" docs/superpowers/specs/2026-09-27-apicc-core-capability-baseline-design.md docs/superpowers/plans/2026-09-27-apicc-stress-execution-credibility.md
rg -n "STRESS-101|STRESS-102|STRESS-103|STRESS-104|STRESS-105|STRESS-110|STRESS-111" docs/superpowers/specs/2026-09-27-apicc-api-lifecycle-platform-requirements.md docs/superpowers/plans/2026-09-27-apicc-stress-execution-credibility.md
$legacyStressTerms = @('allow-' + 'production', 'allow' + 'Production', 'production_' + 'confirmation_required', 'production' + 'Override', 'production:' + ' true')
if (Select-String -Path docs/superpowers/plans/2026-09-27-apicc-stress-execution-credibility.md -Pattern $legacyStressTerms) { throw '计划仍包含基于环境标签的旧安全设计' }
git status --short
git diff --check
```

预期：所有需求 ID 在规格与计划中可追踪；`git diff --check` 无输出；状态中没有意外文件。

- [ ] **步骤 6：提交任务 9**

```powershell
git add README.md packages/cli/tests/e2e.test.ts apps/desktop/tests/main/session.test.ts docs/superpowers/specs/2026-09-27-apicc-core-capability-baseline-design.md
git commit -m "docs(test): 收口压测可信度验收与能力边界"
```

---

## 完成定义

只有以下条件全部满足，本计划才能标记完成：

- 任务 1 至任务 9 的测试先失败后通过，并各自形成独立提交；
- 规格发布门槛 1 至 9 全部有自动化或可重复命令证据；
- 新压测报告始终带 verdict，旧报告明确显示未评估；
- 单机与本地多分片对同一失败样本给出一致分类和退出码；
- 新报告包含施压端资源与饱和状态；饱和时 CLI 和桌面端都给出明确的数据解释边界；
- 目标安全只基于规范化 origin、首次目标记录和项目目标策略，代码及文档不存在基于环境名称或“生产”标签的分支；
- README 不再把本地多进程分片描述成跨机器分布式压测；
- 没有顺带实现非目标能力，也没有改动协作服务端业务接口。
