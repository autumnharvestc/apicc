# apicc M2-D1 分布式压测（core + CLI）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 多 shard 并行施压并汇聚为单份压测报告：`apicc run-stress --shards 2` 产出含 `distributed` 段的报告，跨 shard 分位精确；协议 schema 入 core，传输层可替换（MVP 本地子进程 stdio）。

**架构：** core 新增 `src/stress/distributed.ts`——`planShards` 纯函数（D3 分配）、判别联合消息 schema（`StressWorkerSpec`/`ShardResult`/`ShardFailure`，protocolVersion 1）、`DistributedStressCoordinator`（注入 `spawnWorker`，超时 kill，成功 shard 样本合并 → `computeReport` + optional `distributed` 段）。CLI 增 `stress-worker` 子命令（结果 JSON 打 stdout 末行、日志走 stderr）与 `run-stress --shards`（>1 时 spawn `process.execPath + [dist/bin.js, "stress-worker", …]`）。

**技术栈：** 既有栈（zod ^4 strict、vitest、commander、node:child_process）。无新依赖。

**工作目录：** `D:\workspace260609\project-2\apicc-m2-dist`（worktree，分支 `feature/m2-dist`）。**基线：core 188 / cli 11 全绿。**

**全局约束：** 品牌中立（竞品工具名不入库；`swagger: "2.0"` 是 OpenAPI 2.0 规范字段键，允许）；中文 conventional commit；显式路径 git add；Node ≥ 22.19；门禁 = core 全量 + cli 全量（cli test 脚本本计划改为 `pnpm -C ../core build && pnpm build && vitest run`）；所有新增导出核对 `packages/core/src/index.ts`。

---

## 文件结构

```
packages/core/src/stress/distributed.ts   ← 新：schema + planShards + coordinator + mergeStressReport
packages/core/src/stress/model.ts         ← 改：StressReportSchema 增 optional distributed 段
packages/core/src/index.ts                ← 改：导出 distributed 公共面
packages/core/tests/stress/distributed.test.ts ← 新
packages/cli/src/main.ts                  ← 改：stress-worker 子命令 + run-stress --shards
packages/cli/tests/stress-worker.test.ts  ← 新（或并入既有 stress e2e 文件，随现有组织）
packages/cli/package.json                 ← 改：test 脚本前置 pnpm build
```

---

### 任务 1：core 分布式协议与协调器

- [ ] **步骤 1：失败的测试**（`packages/core/tests/stress/distributed.test.ts`）

覆盖清单（每条独立断言）：
1. `planShards`：iterations=12/shards=3 → [4,4,4]；iterations=13 → [5,4,4]（余数给前 r）；concurrency=4/shards=3 → [2,1,1]（`max(1,floor)` + 余数给前 r）；concurrency=2/shards=4 → [1,1,1,1]（每 shard 至少 1）；duration 模式各 shard durationMs 相同、iterations 均为 undefined。
2. `planShards` 非法入参：iterations 与 durationMs 均缺 → 抛错（与 StressRunner 口径同文案）。
3. 协调器（注入进程内替身 spawnWorker）：2 shard 成功 → 报告 totalRequests = 两 shard 样本数之和，`distributed.perShard` 各自计数、rps 正确；分位数等于「合并样本直接 computeReport」的结果（同一组固定样本，钉精确值）。
4. 部分失败：1 成功 1 失败 → 报告含成功样本，`distributed.shardErrors` 有 1 条；`coordinator.run` 不抛。
5. 全部失败 → 空样本报告落盘形状（totalRequests=0、shardErrors=2 条），不抛。
6. 超时：替身 spawnWorker 永不 resolve → `shardTimeoutMs` 到期判失败（用假计时器或极短 timeout，禁真实长等）。
7. 坏输出：替身返回无法通过 `ShardOutcomeSchema` 的载荷 → 判 shard 失败，error 含 "协议"。
8. 旧报告兼容：M2-C 形态报告对象通过 `StressReportSchema.parse` 成功，`distributed` 为 undefined。

- [ ] **步骤 2：实现**

- `model.ts`：`StressReportSchema` 增 `distributed: z.optional(z.object({ shards: z.number().int().positive(), perShard: z.array(z.object({ shardId: z.string(), totalRequests: z.number().int().nonnegative(), ok: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), rps: z.number().nonnegative() })), shardErrors: z.array(z.object({ shardId: z.string(), error: z.string() })).optional() }).strict())`。
- `distributed.ts`：
  - `StressWorkerSpecSchema = z.object({ protocolVersion: z.literal(1), shardId: z.string(), apiPath: z.string(), caseId: z.string(), envName: z.string().optional(), concurrency: z.number().int().positive(), maxIterations: z.number().int().positive().optional(), durationMs: z.number().positive().optional(), workspaceRoot: z.string() }).strict()`；
  - `ShardResultSchema = z.object({ protocolVersion: z.literal(1), ok: z.literal(true), shardId: z.string(), samples: z.array(z.object({ timeMs: z.number().nonnegative(), status: z.number(), ok: z.boolean(), error: z.string().optional() })) }).strict()`；`ShardFailureSchema = z.object({ protocolVersion: z.literal(1), ok: z.literal(false), shardId: z.string(), error: z.string() }).strict()`；`ShardOutcomeSchema = z.discriminatedUnion("ok", [ShardResultSchema, ShardFailureSchema])`。
  - `DistributedStressCoordinator.run(specBase, { shards, shardTimeoutMs = 300_000, spawnWorker })`：planShards → 并发 spawn 全部 → `Promise.allSettled` + 单 shard 超时包裹（`Promise.race` + 定时 reject；替身场景不泄漏真实计时器以外的副作用即可）→ 成功样本合并、失败进 shardErrors → `computeReport(merged, { concurrency: 分得之和, startedAt, finishedAt })` + 挂 `distributed` 段返回；同时返回 `shardFailureCount` 供 CLI 决定 exit 码（报告对象不携带退出语义）。
- `index.ts` 导出：schema 三件 + `ShardOutcome` 类型、`planShards`、`DistributedStressCoordinator`、相关 options 类型。
- [ ] **步骤 3：全量回归 + Commit** `feat(core): 分布式压测协议与协调器——shard 分配/样本汇聚/报告 distributed 段`

### 任务 2：CLI stress-worker 与 run-stress --shards

- [ ] **步骤 1：失败的测试**（cli 测试，复用既有 e2e 的本地 server 夹具）

1. `runCli(["stress-worker", apiPath, "--case", id, "--concurrency", "2", "--iterations", "4", "--shard-id", "s0", "--workspace", root])` → exit 0；捕获 stdout 末行 `JSON.parse` 后通过 `ShardResultSchema`；totalRequests===4（从 samples.length 验证）。
2. worker 找不到用例 → 末行 `ShardFailureSchema` 且 exit 1，错误信息走 stderr。
3. `run-stress --shards 1` 行为与既有用例完全一致（回归：不 spawn 子进程——可断言进程内路径未创建子进程，或仅靠既有用例回归）。
4. （端到端，真实子进程，放任务 3 前置条件满足后跑）本任务先以注入替身覆盖协调器分支：`--shards 2` 在 runCli 进程内通过可注入 spawnWorker 完成合并（main.ts 将 spawn 实现提取为可注入默认参数，测试注入进程内实现）。

- [ ] **步骤 2：实现**

- `stress-worker`：参数解析 → 与 run-stress 同源的定位/env/resolver 逻辑（提取共享 helper，避免复制）→ `new StressRunner({...}).run({ concurrency, maxIterations/durationMs })` → stdout 末行写 `ShardResult` JSON（`JSON.stringify` 单行）→ exit 0；任何失败路径 stderr 记日志 + stdout 末行 `ShardFailure` + exit 1。**worker 模式所有人类可读日志必须走 stderr**（stdout 只许末行 JSON——协调器按行解析的契约）。
- `run-stress` 增 `--shards <n>`（默认 1，正整数校验）：n=1 走既有进程内路径零行为变化；n>1 构造 `StressWorkerSpec` 数组（workspaceRoot = findWorkspaceRoot 结果），`spawnWorker` 默认实现 = `spawn(process.execPath, [cliEntry, "stress-worker", ...])`（cliEntry 由 `fileURLToPath(import.meta.url)` 解析；子进程 stdio 管道，按行收集 stdout，末行 ShardOutcome 解析；stderr 透传父进程 stderr）→ coordinator 汇总 → 落盘同名 `stress-*.json`（含 distributed 段）→ 摘要日志含各 shard 行。
- exit 码：任一 shard 失败 → 1（打「shard 失败」摘要）；否则沿用「全部请求失败且 total>0 → 1」；`--shard-timeout <s>` 选项（默认 300）。
- [ ] **步骤 3：全量回归 + Commit** `feat(cli): run-stress 多 shard 协调与 stress-worker 子命令`

### 任务 3：真实子进程端到端 + 测试脚本管线

- [ ] **步骤 1：失败的测试**

1. e2e：spawn `process.execPath + [dist/bin.js, "run-stress", apiPath, "--case", id, "--concurrency", "2", "--iterations", "8", "--shards", "2", "--runs-dir", tmp]` 打本地 server → exit 0；报告 `totalRequests===8`、`distributed.shards===2`、perShard 各 4；分位数与合并样本手工 computeReport 一致（读回样本不可得时以 p50 落在 [min,max] 与 total 校验代替）。
2. e2e 失败传播：server 返回 500 且 iterations=4/shards=2 → exit 1（全部失败口径）。
3. （可选）shard 崩溃传播：以不存在的 caseId 触发 worker 失败 → run-stress exit 1 且报告 shardErrors 有条目。

- [ ] **步骤 2：实现**

- `packages/cli/package.json` test 脚本 → `"pnpm -C ../core build && pnpm build && vitest run"`（e2e 依赖 dist/bin.js 先于测试存在）。
- e2e 测试用 `beforeAll` 确保 dist 存在（存在性断言失败时给出「先 pnpm build」的可读错误）。
- [ ] **步骤 3：全量回归（core+cli）+ Commit** `test(cli): 多 shard 真实子进程端到端与测试脚本构建前置`

---

## 规格覆盖对照

| 规格（m2d spec §3 轨 1） | 任务 |
|---|---|
| D1/D2/D5 schema + 协调器 + 合并 | 1 |
| D3 planShards 分配 | 1 |
| D4 失败语义/超时 | 1、2 |
| D6 报告 optional distributed 兼容 | 1 |
| CLI worker/协调/exit 码 | 2 |
| 真实子进程 e2e + 管线 | 3 |

**明确推迟**：跨机传输（HTTP transport）、ramp-up、断言参与采样、worker 断点续跑/心跳。
