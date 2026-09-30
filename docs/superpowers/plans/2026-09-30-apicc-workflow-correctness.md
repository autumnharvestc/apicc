# apicc 阶段 B：工作流正确性实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让工作流具有隔离的运行上下文、完整的数据行结果、一致的失败与跳过语义，并使 Windows 全量测试稳定可重复。

**架构：** 继续复用 CollectionRunner / executeCase，不新建执行引擎。工作流只负责 run 局部变量、节点聚合和边路由；报告适配器展开数据行，CLI 与桌面消费同一执行结论。服务端测试使用每次测试独有的构建/启动产物，消除共享 JAR 争用。

**技术栈：** TypeScript、Vitest、Vue、pnpm、PowerShell、Java 21、Maven wrapper。

**规格：** `docs/superpowers/specs/2026-09-27-apicc-core-capability-baseline-design.md`（EXEC-002/004、WF-001/002、ENG-001）；`docs/superpowers/specs/2026-09-27-apicc-api-lifecycle-platform-requirements.md`（TEST-101/109、FLOW-001/002）。本计划是核心基线阶段表中的 B，不是整个生命周期规格的完整实现。

## 全局约束

- 本地版要保证设计、调试、Mock、测试、编排、压测、报告全部可用；本阶段不得引入登录或服务端作为本地执行前提。
- Node.js 最低版本为 `22.19.0`，Java 为 `21`；本机 `JAVA_HOME` 为 `C:\Program Files\Java\jdk-21.0.12`，不是 bin 目录。
- 脚本的目的是辅助测试，不是无限制功能；不扩大脚本的文件、进程、环境变量或网络权限。
- 以 apicc 结构化契约为主；不在本阶段实施新契约迁移或旧版本兼容工程。
- 开发使用 GPT-5.6 Luna，审查使用 GPT-6.1 Sol、high；工作发生于 `codex/workflow-correctness` 独立工作树，不改 main，不合并、不推送。
- 所有入库内容保持品牌中立；使用 `node scripts/check-brand-neutral.mjs` 验证。
- 保留现有顺序调度与 OR 就绪语义；真正并行、AND/OR 配置、循环、重试、finally 和新增取消 UI 属于阶段 E，不在本计划中实现。
- 工作流 `status` 仍表示 draft/published/enabled 生命周期；执行结论另设 `verdict?: "passed" | "failed"`，不可混用。
- 每次任务先写真实行为回归测试，记录 RED/GREEN；聚焦迭代，提交前一次受影响包全测。控制者承担全分支独立验证。

## 文件职责与依赖

| 文件/目录 | 职责 | 任务 |
| --- | --- | --- |
| `packages/core/src/workflow/runner.ts` | run 局部上下文、完整节点结果、显式路由/跳过结论 | 1、2 |
| `packages/core/src/workflow/references.ts`（新建） | 本项目内递归查找 API 及其所属模块/文件夹路径，裁剪单用例执行树 | 1 |
| `packages/core/src/workflow/validate.ts` | 图结构唯一性、悬空边和环校验 | 2 |
| `packages/core/src/workflow/adapter.ts`、`src/report/{types,html,junit}.ts` | 数据行展开和跳过报告口径 | 3 |
| `packages/core/src/index.ts` | 导出消费者使用的定位函数及结果类型 | 1、2、3 |
| `packages/cli/src/main.ts` | 项目边界、strict 参数、退出码与报告入口 | 4 |
| `apps/desktop/src/{main/ipc,shared/types}.ts` | IPC 相同项目定位和严格运行默认值 | 4 |
| `apps/desktop/src/renderer/src/components/{WfDesigner,WfResultDrawer,RunView}.vue`、`src/renderer/src/stores/workflowDesign.ts` | 工作流详情显示所有数据行与跳过原因，通用报告不把 skipped 当 failed | 4 |
| `apps/desktop/src/main/session.ts`、`src/renderer/src/api/memory.ts` | 启用校验传所属项目，内存演示结果兼容可选字段 | 4 |
| `apps/desktop/tests/main/online/server-fixture.ts`（新建） | 每次调用隔离的服务端测试 JAR 和构建目录 | 5 |
| `apps/desktop/tests/main/online/e2e-server.test.ts` | 使用隔离产物，可靠结束进程后清理临时目录 | 5 |
| `scripts/test-all.ps1`（新建）、`README.md` | Windows 全量入口和工具链说明 | 5 |
| 对应 workflow/report/CLI/IPC/renderer/online 测试 | 正常、失败、异常及隔离回归 | 各任务 |

按 1 → 2 → 3 → 4 → 5 顺序实施，每项有独立审查；任务 5 的工程行为不依赖业务接口但串行实施以保持审查基线清晰。文件清单是职责边界，不要求没有实际变更理由时修改文件。

### 任务 1：运行隔离与完整的数据行节点结果

**文件：** 修改 `packages/core/src/workflow/runner.ts`、`packages/core/src/index.ts`；新建 `packages/core/src/workflow/references.ts`；测试 `packages/core/tests/workflow/runner.test.ts`、新建 `packages/core/tests/workflow/references.test.ts`，必要时扩展 `packages/core/tests/runner/runner.test.ts`。

**交付：** 同一 WorkflowRunner 顺序复用/并发调用互不污染；同一次工作流保留跨节点提取值；节点保存全部已执行数据行，任一行失败即节点失败；来自项目的请求保留原模块上下文。

- [x] **步骤 1：写失败测试。** 复用 runner.test.ts 中真实 HTTP 服务和 `apiOf`/`wf` 夹具。让 n1 的 post 脚本执行 `pm.variables.set("token", pm.variables.get("seed"))`，n2 用 `pm.assert(pm.variables.get("token") === pm.variables.get("seed"), "run isolation")` 检查。同一 runner 用 seed=A/B 的不同 project 同时运行；再运行无提取节点的工作流检查旧 token 不存在。并发测试用受控 HTTP 屏障交错运行，而非睡眠碰概率。

  数据行测试创建临时 JSON `[ {"expected":"200"}, {"expected":"500"}, {"expected":"200"} ]`，用例断言 status eq `{{expected}}`，failFast=false；检查：

  ```ts
  expect(result.nodeResults[0]?.state).toBe("failed");
  expect(result.nodeResults[0]?.outcomes?.map(o => o.passed)).toEqual([true, false, true]);
  expect(result.nodeResults[0]?.outcomes?.map(o => o.row)).toEqual([0, 1, 2]);
  expect(result.nodeResults[0]?.outcome?.passed).toBe(false);
  ```

  row 沿用现有 executeCase 的零基口径。再覆盖全通过、首行失败、dataDriver 配置错误与 scope 不匹配。failFast=true 允许仅保留实际执行行，但不得宣称其余行通过。

  定位函数测试建立嵌套两层文件夹，仅目标 API 被执行；原模块 id / variables / preOperations / postOperations、目标文件夹祖先操作和 `env.baseUrls[module.id]` 均保留。上下文命中 project 时不能采用外部同 ID 对象；project 无此 API 时保留 resolve 注入接缝。

- [x] **步骤 2：验证 RED。** `pnpm -C packages/core exec vitest run tests/workflow/runner.test.ts tests/workflow/references.test.ts`；记录变量泄漏、缺少 outcomes 或模块上下文缺失的实际失败，不能用语法错误充当 RED。

- [x] **步骤 3：最小实现。** 删除实例 carried，将桥闭包和 carried 移至 run 内。新增可选 outcomes，兼容旧 outcome 读者：代表结果优先第一条失败，否则第一条通过。node.state 必须由全部行决定，条件 `prev.passed` 使用节点聚合结论而非首行；`prev` 可额外只读提供 outcomes，不改变脚本权限。

  ```ts
  // NodeResult 新字段
  outcomes?: CaseOutcome[];
  // run 内
  const carried: Record<string, string> = {};
  const state: NodeState = outcomes.every(o => o.passed) ? "passed" : "failed";
  const outcome = outcomes.find(o => !o.passed) ?? outcomes[0];
  ```

  递归 helper 导出以下接口，裁剪为唯一 API/用例且保留祖先树与容器操作，不原地修改源模型。找到本项目 API 时优先它，未命中时沿用 opts.resolve 的合成集合接缝。把 CollectionRunner warnings 合并到工作流 warnings。

  ```ts
  export interface ProjectApiLocation { api: ApiDefinition; collection: Collection; folders: Folder[] }
  export function findProjectApi(project: Project, apiId: string): ProjectApiLocation | undefined;
  export function selectWorkflowCollection(location: ProjectApiLocation, testCase: TestCase): Collection;
  ```

- [x] **步骤 4：验证 GREEN。** 聚焦上述测试；提交前 `pnpm -C packages/core test` 与 `pnpm -C packages/core build`。验证真正的 CollectionRunner 同一实例并发在阶段 A 已隔离；若现有测试缺少不同 globals 并发例，补真实 echo 断言而非重复执行器重构。
- [x] **步骤 5：提交。** `git add` 本任务文件；`git commit -m "fix(workflow): isolate runs and retain every data row"`。自审并写任务报告，注明 row 口径。

### 任务 2：严格引用与可诊断的剪枝/异常语义

**文件：** 修改 `packages/core/src/workflow/runner.ts`、`packages/core/src/workflow/validate.ts`、必要的导出；测试 `packages/core/tests/workflow/runner.test.ts`、`packages/core/tests/workflow/validate.test.ts`。

**交付：** 条件 false 是预期跳过；表达式错误、缺引擎、缺引用和执行异常不伪装成功；strict 默认 true。

- [x] **步骤 1：写失败测试。** 对现有 false 边、两级 false 级联、双败 fan-in、failFast 和 OR 成功路径断言明确原因。新增 missing API/case（包含被 false 边遮住的 missing）、坏条件 `prev.missing.deep`、缺引擎、容器脚本抛错、重复 node/edge id、悬空端点、环；错误引用严格运行在任何 HTTP 发送前失败。strict=false 允许其他独立节点继续诊断，但缺引用节点仍 failed/config + warning，不能成为 passed。已有 missing-as-skipped 与 expression-error-as-false 测试更新为新规格或显式非严格模式。

  ```ts
  expect(falseBranch.verdict).toBe("passed");
  expect(falseBranch.nodeResults.find(n => n.nodeId === "n2")?.skipReason).toBe("condition-pruned");
  expect(missingReference.verdict).toBe("failed");
  expect(badCondition.failed).toBeGreaterThan(0);
  ```

- [x] **步骤 2：验证 RED。** `pnpm -C packages/core exec vitest run tests/workflow/runner.test.ts tests/workflow/validate.test.ts`。
- [x] **步骤 3：实现类型化结论。** 新增 `WorkflowRunnerOptions.strict?: boolean`（默认 true）、`WorkflowRunResult.verdict?: "passed" | "failed"`；新增 NodeResult `skipReason?` 和 `failureKind?: CaseOutcome["failureKind"]`。原因集合：`condition-pruned | upstream-failed | fail-fast | reference-missing | reference-invalid | unreachable`。条件计算返回 discriminated union，不捕获后按 false：

  ```ts
  type ConditionVerdict = { kind: "matched" } | { kind: "pruned" }
    | { kind: "error"; message: string };
  ```

  strict 引用预检查以本项目定位/resolve 为准，缺失节点记 failed/config，其他节点 skipped/reference-invalid，不发请求且返回完整失败结果。非严格模式不预先阻断全部节点，运行到缺引用时 failed/config，其他独立节点可继续；缺引用仍使整轮失败。结构性 error（重复 id、悬空端点、环）执行前拒绝；不能以 warning 忽略。条件求值错误将源节点标记 failed/script 并保存边 id 和可读错误，不运行任何经该失败源才可到达的下游。请求/容器异常转成 failed 节点，其他独立分支可继续，failFast 开启则遗留节点明确 fail-fast。正常 false 剪枝不是 warning 级异常；可以保留信息但要有 skipReason。多层剪枝传播原因，混合失败与剪枝优先 upstream-failed。无法解释的 unreachable 不能让严格 verdict 为 passed。run verdict 与 failed 节点一致；保留生命周期 status。

  启用校验复用递归定位，增加可选第三参 `project?: Project`；显式 project 时不得跨项目查找，未传时优先定位持有工作流的项目，只在没有所属项目的独立验证接缝里保持 workspace 查找。测试嵌套引用和跨项目相同 ID，保证启用与运行不是两套引用规则。

引用同一逻辑用例时须保留其所有同 ID 环境版本，交由 CollectionRunner 的现有环境继承/覆盖规则挑选（runner.test.ts 已有环境版本覆盖测试）。不能 `.find` 后仅传首个 base 版本。`selectWorkflowCollection` 与 resolve 合成接缝都筛选 `api.cases.filter(c => c.id === caseDef.id)`，不复制 scopeRank 逻辑。工作流增加真实请求测试：base → dev → sit 同 ID，sit extends dev 时只执行 sit、dev 时只执行 dev、无环境只执行 base；没有适用版本仍 config 失败。本项允许必要的小范围修改 `workflow/references.ts`，不迁移用例模型。

  容器操作异常须保留已累积的全部执行行。本项允许最小修改 `runner/runner.ts`：增加 `CollectionRunError extends Error`，携带 `partialResult: RunResult` 和 `failureKind: CaseOutcome["failureKind"]`。容器脚本抛错时使用已累积 outcomes 构造 partialResult 并携带 script 分类抛出；不复制执行引擎，不吞错、不将后置异常改成 warning。工作流 catch 保留 partialResult.cases/warnings，再追加一个独立失败诊断 outcome。普通 CollectionRunner 的原抛错控制流仍保留，额外携带已完成事实。测试模块/祖先文件夹前后置错误，后置错误含多数据行；未执行行不能伪装通过。

  不新增取消按钮或停止协议；现有 executeCase 的 aborted 失败分类原样保留，不能改成条件跳过。bridge 错误不能吞成成功。

- [x] **步骤 4：验证 GREEN。** 覆盖多入混合真假边、条件错误、请求失败三种情形，保证节点只执行一次；提交前 core 全测与 build。
- [x] **步骤 5：提交。** `git commit -m "fix(workflow): distinguish pruning from execution errors"`，写 RED/GREEN、严格引用预检和状态表证据。

### 任务 3：数据行完整报告与 skipped 独立计数

**文件：** 修改 `packages/core/src/workflow/adapter.ts`、`packages/core/src/report/types.ts`、`packages/core/src/report/html.ts`、`packages/core/src/report/junit.ts`；测试 `packages/core/tests/workflow/adapter.test.ts`、`packages/core/tests/report/reporters.test.ts`。

**交付：** raw workflow 保存节点级计数，适配报告是数据行/合成诊断级计数；两者结论一致，跳过既可见也不算失败。

- [x] **步骤 1：写失败测试。** 单节点三行 pass/fail/pass 全部展开；noop 一条通过，预期跳过一条 skipped；条件源请求通过但路由失败须额外输出失败诊断，不能因 outcome.passed 忽略失败状态。相同 API 被不同节点引用时保留 nodeId，数据行名称/row 不丢失。旧结果只有 outcome 仍可读。

  ```ts
  expect(report.total).toBe(report.passed + report.failed + (report.skipped ?? 0));
  expect(report.cases.filter(c => c.skipped)).toHaveLength(1);
  expect(xml).toContain('skipped="1"');
  expect(xml).toContain("<skipped");
  ```

  HTML 给 skipped 独立样式、原因及计数；恶意名称/skipReason 文本转义不破坏 HTML/XML。普通 collection 旧报告不含 skipped 时按零处理。

- [x] **步骤 2：验证 RED。** `pnpm -C packages/core exec vitest run tests/workflow/adapter.test.ts tests/report`。
- [x] **步骤 3：实现。** CaseOutcome 新增可选 `skipped?: boolean`、`skipReason?: string`、`nodeId?: string`；RunResult 新增可选 `skipped?: number`。adapter 先展开 node.outcomes，回退 outcome；有真实行且 node.state=failed、行没有任何失败时追加一条节点级失败诊断。无行时生成 noop/failed/skipped 合成记录；skip 记录 passed=false、skipped=true，不生成失败断言。计数公式如下：

  ```ts
  const skipped = cases.filter(c => c.skipped).length;
  const passed = cases.filter(c => !c.skipped && c.passed).length;
  const failed = cases.filter(c => !c.skipped && !c.passed).length;
  ```

  JUnit `<testsuite tests="…" failures="…" skipped="…">` 与 testcase `<skipped message="…"/>`；外层 testsuites 计数同源。JUnit 名称在有 nodeId 时加入节点识别前缀，避免不同节点引用同一 API/用例/数据行时名称碰撞；无 nodeId 的普通集合报告保留既有名称。HTML 三态显示，并使节点归属可识别。删除 adapter 原“skipped 计 failed、退出码仍零”的旧裁定注释，说明新规格取代它。无真实失败的条件剪枝报告必须 failed=0。

- [x] **步骤 4：验证 GREEN。** 聚焦报告测试；提交前 core 全测与 build。
- [x] **步骤 5：提交。** `git commit -m "fix(report): preserve workflow rows and skipped verdicts"`，报告说明节点计数与数据行计数区别。

### 任务 4：CLI 与桌面工作流消费一致的执行结论

结果展示实际由 WfDesigner 委托既有 `apps/desktop/src/renderer/src/components/WfResultDrawer.vue`；本项允许修改该组件，不要求无实际理由修改 WfDesigner 本体。

共享的 run.summary 文案也由既有 `RunsHistory.vue` 消费。本项同步该消费者及必要的可选摘要 skipped 字段，真实值从结果读取，只有旧报告缺字段回退零；不新增历史模型。

“第二行失败”必须是同一用例 dataDriver 的第二条零基数据行，不是第二个请求节点。多格式验收须检查实际 testcase/数据行与精确计数，不以恒有的 failure/skipped 摘要字段充当证据。同毫秒回归须锁定 CLI 子进程/IPC 的落盘时钟，并读取两份同 workflowId、不同结果标识的 JSON 核对归属；测试预加载可冻结子进程 Date.now，不在产品引入 clock 注入。

JSON 在本阶段沿用 CLI 实际落盘的原始 WorkflowRunResult（节点计数/完整 outcomes）；当前内置 Reporter 只有 HTML/JUnit，不新增 `json` Reporter。多格式验证读取该真实 JSON，核对其完整事实、节点 verdict/计数，并用既有 workflowToRunResult 的行级投影与实际 HTML/JUnit 精确对照。测试中的序列化投影不称为 CLI 已输出的适配 JSON 报告。

**文件：** 修改 `packages/cli/src/main.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/main/session.ts`、`apps/desktop/src/shared/types.ts`、`apps/desktop/src/renderer/src/components/WfDesigner.vue`、`apps/desktop/src/renderer/src/components/RunView.vue`；有形状调整需求时修改 `apps/desktop/src/renderer/src/stores/workflowDesign.ts` 与 `apps/desktop/src/renderer/src/api/memory.ts`。测试 `packages/cli/tests/e2e.test.ts`、`apps/desktop/tests/main/ipc.test.ts`、`apps/desktop/tests/renderer/components/wfDesigner.test.ts`、`apps/desktop/tests/renderer/components/RunView.test.ts`、`apps/desktop/tests/renderer/stores/workflowDesign.test.ts`。

**交付：** 默认严格运行、报告与退出码一致、本项目递归引用，桌面能看全数据行和跳过原因；并发/同毫秒运行的原始结果不覆盖。

- [x] **步骤 1：写失败测试。** CLI 实际进程：false→exit 0、第二行失败→exit 1、缺引用→exit 1、坏条件→exit 1、`--no-strict` 缺引用→exit 1 且其他独立节点继续诊断；`--force-draft` 不绕过 strict。JSON/HTML/JUnit 均显示相同失败/跳过。跨项目同 ID、两层文件夹、原模块 baseUrl 的引用指向所属项目。IPC 同一组行为；桌面显示两/三行含 row、failureKind、error，跳过原因可见；请求行通过但路由失败时展示独立节点错误。同毫秒两次运行原始文件均存在且内容不串。
- [x] **步骤 2：验证 RED。** CLI `pnpm -C packages/cli exec vitest run tests/e2e.test.ts`，桌面 `pnpm -C apps/desktop exec vitest run tests/main/ipc.test.ts tests/renderer/components/wfDesigner.test.ts tests/renderer/components/RunView.test.ts tests/renderer/stores/workflowDesign.test.ts`。记录真实失败。
- [x] **步骤 3：实现消费者。** CLI run-workflow 添加 `.option("--no-strict", "缺失引用不中断独立节点诊断（本次结果仍失败）")`，把 commander 的 `strict` 传入；默认 strict=true。IPC `WfRunInput.strict?: boolean`，调用默认 true，不必新增放宽 UI。findProjectApi 只用定位工作流所属 project，不扫描所有 workspace。CLI exit 采用 `wfr.verdict === "failed" || wfr.failed > 0 ? 1 : 0`，输出明确“节点统计”；report 数据行独立统计。renderer 使用 outcomes 回退 outcome，按每行显示状态及 skipped 原因；通用 RunView 优先 skipped、再 passed/failed。旧报告可选字段安全回退，不新增执行编排能力。

  ```ts
  const rows = node.outcomes ?? (node.outcome ? [node.outcome] : []);
  const state = row.skipped ? "skipped" : row.passed ? "passed" : "failed";
  ```

  session.ts 和 memory.ts 的启用校验传入定位工作流所得 project，防止嵌套引用运行能通过却不能启用。

  CLI 与 IPC 原始工作流 JSON 文件名改为 `workflow-${workflowId}-${randomUUID()}.json`，使用 `node:crypto` 的 randomUUID，无新增依赖，消除仅 Date.now 的同毫秒覆盖。不添加新的任务/历史模型。条件错误显示 node.error / node.failureKind 与节点失败状态，不把已通过的 HTTP 行改写为失败。

- [x] **步骤 4：验证 GREEN。** core build 后 CLI 全测/build，desktop 全测/typecheck/build；本任务不要反复重跑整桌面套件。若真实服务端测试暴露已知共享 JAR 争用，记录并交任务 5，不能改成跳过 E2E。
- [x] **步骤 5：提交。** `git commit -m "fix(app): align workflow execution and report verdicts"`；报告给出新增字段消费者清单与运行证据。

### 任务 5：Windows 全量验证入口与服务端产物隔离

**文件：** 新建 `scripts/test-all.ps1`、`apps/desktop/tests/main/online/server-fixture.ts` 与对应聚焦测试；修改 `apps/desktop/tests/main/online/e2e-server.test.ts`、`README.md`；如需 Maven 输出目录配置，限制在 `server/pom.xml` 一个可覆盖的 build.directory 属性，不改产品服务端逻辑。

**交付：** Windows 根入口严格检查 JDK21、顺序构建与测试；E2E 自建/启动 JAR 不占共享 server/target，三个连续全量入口运行无争用。

- [x] **步骤 1：写失败测试。** helper 两次/并发准备产物目录不同，启动 JAR 不位于共享 target；失败构建不启动服务、返回可读错误；仅清理自己创建的临时目录，进程结束后再删；Java20/22 拒绝，Java21 通过。使用注入构建调用验证不同 Maven build.directory 和生命周期，不能以两个相同 mock 成功代替真实 E2E 证据。
- [x] **步骤 2：验证 RED。** 聚焦 helper 测试。检查当前 E2E ensureJar 启动共享 target 的失败证据，不故意制造会损坏产物的争用。
- [x] **步骤 3：实现隔离。** helper 用 mkdtemp 创建专属输出根，Maven 输出指定到该根（pom 如需则定义 `<apicc.build.directory>${project.basedir}/target</apicc.build.directory>`、`<build><directory>${apicc.build.directory}</directory>`，调用传 `-Dapicc.build.directory=<唯一绝对目录>`）；不依赖 `-Dproject.build.directory` 覆盖模型。每次 E2E 自建或可信复制到自己的 JAR 路径后启动，不启动共享 target。保留 wrapper 优先、版本实测、超时和真实 online 场景，不降低测试覆盖。临时根清理有边界检查，异常路径也回收，后台窗口隐藏。真实启动使用 Java major ===21。

  PowerShell 根入口设置 `$ErrorActionPreference = 'Stop'`，用 `&` 传命令参数，每个外部调用检查 `$LASTEXITCODE` 非零立即退出；JAVA_HOME 合法根与 Java21 校验，Node >=22.19.0 校验。从脚本路径定位仓库根而非依赖调用 cwd；不改全局用户环境。不进行依赖安装，缺依赖时明确失败。

  标准启动器是 Windows PowerShell 5 的 `powershell`。本机已复现：Stop 下直接捕获 `java -version 2>&1` 会将正常版本 stderr 当作异常，即使 Java 本身成功。版本探测须可靠捕获 stdout/stderr 并检查真实退出码（例如 Process，或局部调整后恢复错误偏好）；不能因此误拒绝 Java21，也不能全局放宽失败检查。

  命令顺序：brand self-check + gate → `pnpm -C packages/core typecheck`（包含测试文件，保持 CI 门禁一致）→ `pnpm -r build` → `pnpm -r test` → Maven wrapper `-s server/.mvn/settings.xml -f server/pom.xml test`。Maven 的测试产物用专属临时 build.directory，结束清理，确保该入口本身也不争用共享 target。README 写标准调用：

  ```powershell
  $env:JAVA_HOME = 'C:\Program Files\Java\jdk-21.0.12'
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-all.ps1
  ```

- [x] **步骤 4：验证 GREEN。** 聚焦 helper + 真实 e2e-server；提交前 desktop 全测/typecheck。测试入口有一次失败工具链/失败外部命令的非零退出验证。控制者在所有任务审查后运行上述标准入口连续三次，记录每次完整摘要、耗时和退出码，不能将三次聚焦 E2E 替代 ENG-001 验收。
- [x] **步骤 5：提交。** `git commit -m "test: isolate server artifacts and stabilize Windows gates"`；报告目录隔离、进程清理及根入口验证证据。

## 分支验收与交付

### 2026-09-30 最终复审状态

五项子任务已通过各自规格/质量审核。整分支总审完成，一次集中修复 `25cd441` 关闭了隐藏缺失引用误报成功、可变条件环境、JUnit 回归断言和末尾空行四项问题。

定向复审发现该修复新增一项 Important：非严格模式预记录缺引用根节点后，出队提前跳过，绕过 fail-fast，后续独立节点仍可能执行；另有 Minor：只有缺引用根时下游误标 `unreachable` 而非 `upstream-failed`。用户批准追加一轮后，`11ed703` 修复这两项，定向复审确认原发现已关闭。

用户已回复“是”，批准追加一次定向修复/复审，覆盖 fail-fast 与下游跳过原因两个残留；三个标准完整门禁在复审通过后针对同一版本连续验证。不把报告中的 core 508 / CLI 96 聚焦或包级成功当作 ENG-001 的三轮完整验收；本授权不包含合并、推送或打包。

追加复审仍发现新 Important：先经活动边入队的缺引用节点，在来源节点随后因另一条边条件脚本失败后，被出队终审改成 `skipped/upstream-failed`；最终聚合仅补无结果节点，已知配置错误因此从节点事实和 adapter 报告中丢失。另有 Minor：false 边隐藏缺引用节点的两层后代在末尾补诊断后未重新级联，仍是 `unreachable`。控制者确认前者真实且影响引用完整性，不静默放行、不继续额外派修。暂停三轮门禁，保留当前分支和证据，等待用户进一步方向。

- [ ] 全部五项任务规格/质量审查通过，完成一次 d9c77b7..HEAD 宽范围审查。
- [ ] 全分支 Node/Java 工具链正确，core/CLI/desktop/admin-web 构建和测试、desktop typecheck、brand gate、服务端测试通过；以标准入口三次连续验证覆盖 ENG-001，避免另外反复全套重跑。
- [ ] 更新计划复选框；在 `local/阶段B工作流正确性验收-2026-09-30.md` 保存任务提交、审查结论、测试数量、三次稳定性证据与实际限制（local 不入库），不得参考该目录旧文档。
- [ ] 汇报分支/工作树、完成内容和集成选项；合并、推送、打包需另有用户授权。
