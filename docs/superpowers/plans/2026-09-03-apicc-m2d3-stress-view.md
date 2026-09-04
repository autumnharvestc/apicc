# apicc M2-D3 桌面端压测视图实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 桌面用户可在接口级发起/停止压测并查看报告：表单（用例/环境/并发/迭代或时长）→ main 进程 StressRunner 执行（可中止）→ 报告落盘 `.apicc/runs/stress-*.json` → 面板展示摘要/分位/分布 → 运行历史按 kind 区分两类报告。

**架构：** IPC 增 `stress:run`（返回最终报告 + 落盘文件名）与 `stress:stop`（abort 活动运行，返回部分报告）；main 侧新 `main/stress.ts`（仿 `debug.ts`：定位接口/用例 → 环境解析 → 变量 resolver（与 CLI run-stress 同构，用 core 导出组装）→ `StressRunner` + AbortController 单活动 run）；`runs.ts` 摘要判别 `kind: "collection" | "stress"`（修复 2B 账本「listRuns 对非运行 JSON 产出 undefined 摘要」缺口）；渲染层 `stressStore`（pinia 工厂）+ `StressPanel.vue` + `StressReportView.vue`（报告展示，历史详情复用）+ `RunsHistory.vue` kind 区分 + `App.vue` 视图切换增「压测」。

**技术栈：** 既有栈（ant-design-vue ^4、pinia、vue-i18n、zod）。无新依赖。

**工作目录：** `D:\workspace260609\project-2\apicc-m2-stress-ui`（worktree，分支 `feature/m2-stress-ui`）。**基线：core 188 / cli 11 / desktop 247 全绿。**

**全局约束：** 品牌中立；中文 conventional commit；显式路径 git add；门禁 = desktop typecheck（双 tsconfig）+ desktop 全量 + core 全量；组件内零工厂调用（store 实例 props/provide 下传）；IPC 载荷深拷贝（DataCloneError 防御）；channels 单源 + zod Record 全通道校验；data-testid 契约保留。

---

## 文件结构

```
apps/desktop/src/shared/channels.ts        ← 增 StressRun: "stress:run"、StressStop: "stress:stop"
apps/desktop/src/shared/types.ts           ← ApiccApi 增 stressRun/stressStop；RunSummaryDTO 增 kind；
                                             StressRunSummaryDTO、StressReportDTO、run:get 返回联合
apps/desktop/src/main/stress.ts            ← 新：stressRun/stressStop（单活动 run + AbortController）
apps/desktop/src/main/runs.ts              ← 改：listRuns/readRun kind 判别（collection|stress）
apps/desktop/src/main/ipc.ts、preload/preload.ts、renderer/src/api/memory.ts ← 同步
apps/desktop/src/renderer/src/stores/stress.ts ← 新：store 工厂
apps/desktop/src/renderer/src/components/StressPanel.vue       ← 新：表单 + 运行态
apps/desktop/src/renderer/src/components/StressReportView.vue  ← 新：报告展示（面板/历史复用）
apps/desktop/src/renderer/src/components/RunsHistory.vue       ← 改：kind 区分
apps/desktop/src/renderer/src/App.vue      ← 改：View 增 "stress"，视图切换与装配
apps/desktop/src/renderer/src/i18n/*       ← 补 zh/en 键
tests: session.test.ts / ipc.test.ts / components.test.ts / runs 相关既有文件追加
```

---

### 任务 1：main 进程压测执行与 runs 判别

- [ ] **步骤 1：编写失败的测试**（session.test.ts + ipc.test.ts 追加；memory 替身同构）

1. `stressRun({apiId, caseId, concurrency: 2, maxIterations: 4})` → 返回 `{report, file}`：report 通过 core `StressReportSchema`、totalRequests===4；`file` 匹配 `stress-` 前缀；文件落在 `.apicc/runs/`。
2. 并发拒绝：活动运行未结束再调 `stressRun` → 抛「已有压测进行中」（替身 client 挂起制造活动窗口）。
3. `stressStop`：运行中调用 → 报告返回且 totalRequests ≤ maxIterations（部分报告口径）；无活动运行时调用 → 抛「没有进行中的压测」。
4. `stressRun` 未找到接口/用例 → 错误文案与 debug 频道同款（`未找到接口: <id>`）；`--env` 提供但未命中 → `未找到环境: <name>`（与 resolveEnv 契约对齐）。
5. 迭代与时长都缺 → 抛「压测终止条件缺失」（沿用 core 文案）。
6. runs 判别：目录放入集合运行 JSON + stress 报告 JSON + 形状不对的 JSON → listRuns 返回 [kind=collection, kind=stress] 两行、坏文件跳过（不产 undefined 字段行——2B 缺口回归）；readRun 对 stress 文件返回 StressReportDTO、对集合文件返回既有形状。
7. ipc.test：`stress:run` 载荷 zod 校验（负并发/both 缺失拒绝；空值兼容既有 nullish 口径）。

- [ ] **步骤 2：实现**

- `main/stress.ts`：`createStressController(session)` 返回 `{run, stop}`；run 内 locateApi → 用例过滤（同 sendDebug 断言口径）→ env 解析（复用 debug.ts 的 resolveEnv——导出复用，不复制）→ 变量 resolver 组装（对照 `packages/cli/src/main.ts` run-stress action 的 core 导出用法，环境继承层序一致）→ `new StressRunner({client: httpClient, buildRequest: () => buildStressRequest(api, resolver, builtinAuthProviders)})`（每次采样重跑 build——动态变量口径与 CLI 一致）→ 完成后落盘 `stress-<apiId>-<Date.now()>.json` 并返回。AbortController 存控制器闭包；stop → `abort()`（StressRunner 既有 signal 语义：停止发起新采样、等在途请求完成）。**报告对象返回前深拷贝**。
- `main/runs.ts`：`listRuns` 逐文件先按既有 RunResult 最小形状校验（命中 → kind collection，摘要字段同既有），失败则 `StressReportSchema.safeParse`（命中 → kind stress，摘要 `{file, kind, startedAt: ISO(由 report.startedAt ms), totalRequests, ok, failed, rps}`），均失败 → 跳过；`readRun` 同序判别返回联合。
- channels/types/ipc/preload/memory 同步；`RunSummaryDTO` 增 `kind: "collection"`（现有消费方一并更新）。
- [ ] **步骤 3：全量回归 + Commit** `feat(desktop): main 进程压测执行/停止与运行历史 kind 判别`

### 任务 2：压测面板与报告展示

- [ ] **步骤 1：编写失败的测试**（components.test.ts 追加，plugins 用既有装配先例）

1. `stressStore` 工厂隔离：两实例互不可见（先例：既有 store 测试）。
2. StressPanel 挂载：用例下拉列出 api.cases 名称、环境下拉列出 envs；迭代/时长模式单选切换（a-radio-group）；并发默认 1。
3. 点「开始」→ api.stressRun 以表单值调用；运行中「开始」禁用 +「停止」可用；resolve 后展示报告（data-testid="stress-report" 可见，totalRequests 文本断言）；reject → reportError 通道收到消息且旧报告保留（沿用 debug 错误语义）。
4. 点「停止」→ api.stressStop 调用且返回的部分报告上屏。
5. StressReportView 纯展示：传入报告 → 摘要（total/ok/failed/rps/时长）、分位表（min/avg/p50/p90/p95/p99）、状态分布、错误分布各区块 data-testid 可断言；空报告（totalRequests=0）不渲染 NaN。

- [ ] **步骤 2：实现**

- `stores/stress.ts`：工厂 `createStressStore(deps: {api})`——state `{running, report, file, error, form}`；actions `start/stop/clear`；form 默认值集中定义。
- `StressPanel.vue`：a-form 布局（用例/环境 a-select、并发 a-input-number、模式 a-radio-group + 迭代数/秒数输入）；按钮区（开始/停止，a-button）；运行态用 a-spin 或按钮 loading；错误经 props `report-error` 上抛（App 级通道）。**零工厂调用**，store 由 App 传入。
- `StressReportView.vue`：纯 props 展示组件（报告对象）；a-statistic/摘要行 + a-table 分位 + 分布两列小表；数字格式化 helper 内联（毫秒/整数，禁 NaN）。
- i18n zh/en 补键（`stress.title/case/env/concurrency/mode/iterations/duration/start/stop/running/summary/latency/statusDist/errorKinds` 等）。
- [ ] **步骤 3：全量回归 + Commit** `feat(desktop): 压测面板与报告展示组件`

### 任务 3：装配与运行历史 kind 区分

- [ ] **步骤 1：编写失败的测试**

1. App 装配：选中接口时视图切换含「压测」项；点击切到 stress 视图渲染 StressPanel（props 为选中接口的 apiId 与 store 实例）。
2. RunsHistory：listRuns 返回混合 kind → 集合行渲染既有列 + kind 标签；stress 行显示 totalRequests/failed/rps 摘要；点击 stress 行 → StressReportView 展示其报告（readRun 联合分支）。
3. 视图切换回归：既有 6 视图全部仍可达（切换控件增项不破坏既有断言；radio 33% 宽样式允许 7 项换行，不要求像素级）。

- [ ] **步骤 2：实现**

- `App.vue`：`View` 类型增 `"stress"`；视图切换控件加项；`<StressPanel v-else-if="view === 'stress'" ...>`（apiId 取当前选中接口，未选中接口时该项禁用或不显示——沿用「cases/envs 视图对接口选中」的既有口径）。
- `RunsHistory.vue`：kind 判别渲染（a-tag 区分集合/压测）；stress 行点击 → api.runsGet → StressReportView 抽屉或内嵌区（选实现成本低者）。
- 门禁：`pnpm typecheck && pnpm typecheck:vue` 零错误。
- [ ] **步骤 3：全量回归 + 打包冒烟（gen:icon → dist:dir → smoke:dir）+ Commit** `feat(desktop): 压测视图装配与运行历史压测行`

---

## 规格覆盖对照

| 规格（m2d spec §3 轨 3 / §2） | 任务 |
|---|---|
| D10 main 执行/单活动 run/stop | 1 |
| D11 落盘 stress- 前缀/kind 判别（2B 缺口修复） | 1 |
| D12 接口级压测视图 | 2、3 |
| IPC 校验/memory 替身同构 | 1 |
| 历史区分与报告展示 | 2、3 |

**明确推迟**：压测进度推送（事件流）、报告图表化、分布式触发入 UI（轨 1 协议稳定后另立）、全局环境/集合级压测。
