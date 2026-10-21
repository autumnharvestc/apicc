# F4 测试与诊断中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本地当前项目内完成丰富断言/提取、集中数据、套件回归和可定位的失败报告。

**Architecture:** 复用 TestCase→executeCase→CollectionRunner/WorkflowRunner 的路径，新增纯数据测试资产和只负责选择/调度的 SuiteRunner。Node-only 数据准备和安全证据投影留在宿主；renderer 只消费纯 DTO，同快照绑定所有定义与所选数据。

**Tech Stack:** TypeScript、zod、现有 JSONPath/XPath/XML/CSV/YAML 依赖、Vue/Pinia/Ant Design Vue、Vitest；拟仅新增固定 `re2js@2.8.8`。Node 22.19.0，不升级 Electron。

**Spec:** [F4 设计与 18 项验收](../specs/2026-10-20-apicc-f4-test-diagnostics-design.md)。状态：用户已明确“确认，完成F4阶段”，书面规格与计划**集中批准，进入实施**。执行方法保留独立工作树与开发/审核子agent；不提交、合并或推送。任务编号1～8对应原A1/A2/A3/B1/B2/B3/C1/G，仅使任务提取工具可用，不改变范围。

## Global Constraints

- 基线 b5b88f68ae001a056d1c663d6861ffd728d42b77，用户报告 CI68 通过；独立工作树分支 codex/f4-test-diagnostics，保留 main、原 stash/工作树/包/证据。
- GPT-6.1 Sol high 开发、独立 GPT-6.1 Sol xhigh 审核，root 调度；单产品写入者、子 agent 不再派生，不自作 Git 集成。
- 当前项目边界；apicc 是唯一事实来源。既有 scope/环境/请求覆盖/脚本行为不悄悄降级；DEF-001 不恢复。
- 只为本规格增加 re2js@2.8.8，锁文件在 A2 一次更新。安装失败或版本不符须报告，不偷升版本/改原生引擎回退。
- 断言256、提取64、模式/路径2 KiB、选择命中1000；Schema深64/访问100000。数据10 MiB/10000行/256列/单格64 KiB；suite预计executeCase≤50000。
- 证据body64 KiB/值4 KiB/case-row256 KiB/全run16 MiB；压测最多20个失败证据样本。先脱敏后截断，缺失/截断不伪造为完整数据。
- 每 task 最小受影响 RED/GREEN；maxWorkers=2，包测试顺序执行，不调高 timeout、不 skip/删测试求绿、不重跑全量；只在需要新职责承载时新增小测试文件。
- 不承诺全部 JSON Schema、不扩工作流/压测算法/SDK/在线能力，不把 F3 四项低优先级观察或 DEF-001 静默改绿。
- TestCase/Project 新字段在公共输入类型可选，集中规范化默认空数组；不批量重写与新需求无关的fixture。跨包消费者导出指向dist，测试前按需刷新已变化的Core/CLI，源哈希未变不重复构建，不修改测试宿主绕开包导出。

### 定向验证命令

以下均在独立工作树，以已固定 Node22 的 PATH / pnpm 运行，输出/错误/退出码落到本阶段 ignored 证据目录，原文件不覆写。使用 `pnpm ... exec vitest run`，不走 CLI `test` 脚本造成重复build。每task只选其实际修改文件/用例；相关文件未变且结果绑定同源码时不重复跑。GREEN为退出0且所选测试无失败；类型检查退出0。RED必须是新行为断言失败。

| 任务 | 定向命令（必要跨包build在该次命令前完成） |
| --- | --- |
| A1 | `pnpm -C packages/core exec vitest run tests/domain/model.test.ts tests/storage/contractFiles.test.ts tests/assets/snapshot.test.ts tests/assets/clone.test.ts --maxWorkers=2`；桌面被改保存/转移分支用 `pnpm -C apps/desktop exec vitest run tests/main/contract-assets.test.ts tests/main/asset-transfer.test.ts --maxWorkers=2` |
| A2 | `pnpm -C packages/core exec vitest run tests/assert/operators.test.ts tests/assert/xpath.test.ts tests/assert/schemaValue.test.ts --maxWorkers=2`（schemaValue文件仅在实际新建时列入） |
| A3 | `pnpm -C packages/core exec vitest run tests/runner/caseExecutor.test.ts tests/workflow/runner.test.ts tests/stress/aggregate.test.ts --maxWorkers=2`；隔离复用 `tests/stress/caseSession.test.ts` 对应测试 |
| B1 | `pnpm -C packages/core exec vitest run tests/testing/data.test.ts tests/runner/runner.test.ts tests/stress/caseSession.test.ts --maxWorkers=2`；桌面准备入口的 `tests/main/debug.test.ts` 单独运行 |
| B2 | `pnpm -C packages/core exec vitest run tests/testing/suite.test.ts --maxWorkers=2`；`pnpm -C packages/cli exec vitest run tests/contract-assets.test.ts --maxWorkers=2` |
| B3 | `pnpm -C apps/desktop exec vitest run tests/renderer/components/CasePanel.test.ts tests/renderer/components/testingCenter.test.ts tests/renderer/stores/cases.test.ts --maxWorkers=2`；IPC/storage文件仅在本task改动时复跑 |
| C1 | `pnpm -C packages/core exec vitest run tests/report/reporters.test.ts tests/credentials/output.test.ts --maxWorkers=2`；`pnpm -C apps/desktop exec vitest run tests/main/execution-credentials.test.ts tests/main/runs.test.ts tests/renderer/components/RunView.test.ts --maxWorkers=2` |

类型门为 `pnpm -C packages/core typecheck`、`pnpm -C packages/cli exec tsc --noEmit`、`pnpm -C apps/desktop typecheck` / `typecheck:vue`；仅执行消费者受影响的门。必要producer构建为 `pnpm -C packages/core build`、`pnpm -C packages/cli build`，最终Desktop为 `pnpm -C apps/desktop build`。Java/服务端无本阶段代码变更，不为客户端任务重复跑Java全量；后续Git CI仍执行既有流程。

## Review Focus

1. null/false/0/空串与 absent 混同会使反向断言误通过；A2 在既有 operators 夹具内参数化，A3 验证 caseExecutor 接入。
2. 单数据行/空集/运行中换文件会让不同入口读到不同请求；B1 用 runner 与现有 stress case 夹具验证一次快照及游标。
3. suite 环境scope/同名跨项目/数据叠加会扩大请求范围；B2 的 selection/runner 测试固定零请求预检和精确身份。
4. required 提取失败与残留变量会污染后续场景/VU；A3 用现有 caseExecutor/workflow 夹具固定原子发布和 run/VU 隔离。
5. 新 actual/expected/提取值绕过旧输出边界会写出真实值；C1 以既有 execution-credentials/reporters 夹具核对全部输出及晚出现标记。

## 文件职责及共享接口

新增 `packages/core/src/testing/model.ts`：DatasetAsset/SuiteAsset/ExtractionDefinition/ResolvedSuitePlan/PreparedTestData 等纯模型与 schema；不依赖 fs/keyring。`testing/references.ts`：新资产引用/删除影响/跨项目 ID 重映射，接入既有入口，不另建并行存储。

新增 `assert/selection.ts`、`assert/evaluate.ts`、`assert/schemaValue.ts`、`assert/regex.ts`：响应选择、断言适配、SchemaNode 验证、固定正则引擎；`testing/extraction.ts`：提取事务；`testing/data.ts`：宿主数据准备；`testing/selection.ts` 与 `testing/suiteRunner.ts`：套件选择/调度；`report/evidence.ts`：安全有界证据；`report/suiteAdapter.ts`：旧报告兼容映射。只有职责需要才拆文件，避免空壳转发层。

全阶段共享命名（实现者不得另造同义接口）：

- `selectResponseValue(selector: ResponseSelector, response: ExecutionResponse): SelectedResponseValue`，结果 `{found:boolean,value?:JsonValue,sourcePath?:string}`；缓存属于该 response 的一次 execution。
- `CaseExecutionLocator` 为 Core 统一物理用例定位：`{collectionId,folderIds,apiId,caseId,scope}`；扩展既有 CaseReferenceLocator，项目/revision 由外层 run/snapshot 绑定，不复制桌面 workspaceId（R10）。
- `compileCaseAssertions(testCase: TestCase, context: ProjectAssetContextReadView, registry: PluginRegistry, owner?: {contractId:string}): CompiledCaseAssertions`；预检、编译同快照，`evaluateCaseAssertions(compiled, response, resolver): AssertionOutcome[]`。owner 绑定所属接口，useContractResponse 未提供 owner 则配置失败，生产调用方显式传入快照内所属 contractId（R6，不能由局部 caseId 猜接口）。AssertionOutcome 扩展既有 pass/message 并携带 id/op/selector/code/actual/expected/差异路径。
- `evaluateExtractions(definitions: readonly ExtractionDefinition[], response: ExecutionResponse, state: ExtractionRuntimeState): ExtractionBatchResult`；state 拥有者为 run/VU，返回原子 changes、诊断与敏感标记，不接收文件/网络/脚本回调。实际响应选择失败在提取阶段归 extraction，定义/表达式/引用配置失败仍 config；保留 code 和先前主失败（R9）。
- `resolveSuitePlan(snapshot: ProjectSnapshot, suiteId: string, overrides?: SuiteRunOverrides): ResolvedSuitePlan`；纯函数，具体 scope、物理 locator 和执行顺序明确；不读文件/凭据、不发请求。外部文件行数及实际规模由 prepareTestData→validateSuiteData 阶段完成，不在此猜测。
- `prepareTestData(snapshot: ProjectSnapshot, selections: readonly PreparedCaseSelection[], options: {workspaceRoot:string}): Promise<PreparedTestData>`；返回只读、可序列化的行表与内容摘要。case lookup key 由规范 CaseExecutionLocator 序列化产生，不拼接有碰撞的 id 字符串。
- `PreparedCaseSelection` 为 `{locator:CaseExecutionLocator,datasetId?:string}`；datasetId 仅表示显式外层数据源，不重复用例自身 driver。两者同时存在即配置冲突；B2 先整套预检，再用最小 runner 单行注入端口执行外层行，不能切片/改写准备表伪造摘要或再次展开子表（R11）。
- `validateSuiteData(plan: ResolvedSuitePlan, data: PreparedTestData): SuitePreview`；在纯选择后据实际准备行数计算执行规模/冲突，返回可显示的行数与规模，不读凭据、不发请求。
- `SuiteRunner.run(run: ProjectExecutionRun, plan: ResolvedSuitePlan, options: SuiteRunnerOptions): Promise<SuiteRunResult>`；run 增加 preparedTestData（可选，运行用到数据时必须匹配 snapshot/selection），runner 在任何协议调用前再次调用 validateSuiteData；SuiteRunnerOptions 含 signal 和现有会话/报告策略端口，不另持有全局变量。
- `suiteToRunResult(result: SuiteRunResult): RunResult`；`projectExecutionEvidence(input: ExecutionEvidenceInput, boundary: EvidenceOutputBoundary, budget: EvidenceBudget): SafeExecutionEvidence`。raw evidence 只存在于宿主，RunResult/IPC/报告只携带 SafeExecutionEvidence。

CLI 新命令放独立 `packages/cli/src/testing.ts`，main.ts 仅装配；桌面新增 `shared/testing.ts`、`main/testing.ts`、renderer `stores/testing.ts`，保持类型/preload/API/内存实现/i18n 同步。新增 UI 为 DatasetPanel/SuitePanel/ExtractionEditor/AssertionEditor/CaseEvidencePanel，CasePanel/RunView 负责组合，不继续膨胀已有大组件。

## Task 1: A1 测试资产、保存与引用闭包（F4-01/02）

**Files:** 新建 testing/model.ts、testing/references.ts；修改 domain/common.ts、contract/workspace.ts、assets/snapshot.ts、assets/context.ts、assets/graph.ts、assets/clone.ts、storage/paths.ts、contractFiles.ts、fileStorage.ts、shared.ts、index.ts、schema.ts、apps/desktop/src/main/session.ts 的保存/克隆/删除入口。

**Tests:** 扩展 core tests/domain/model.test.ts、storage/contractFiles.test.ts、assets/snapshot.test.ts、assets/clone.test.ts 和桌面现有 contract-assets/asset-transfer 测试中对应夹具；不做全入口排列组合。

**Interfaces:** 产出共享类型/schema；TestCase.tags/extractors 及 Project.datasets/suites 在输入类型可选、集中规范化默认空，op 为 bounded string；Dataset/Suite 分文件格式、顺序、引用扫描/重映射和事务写盘。消费既有 journal/snapshot/CaseLocator。

- [ ] 在既有保存重开测试加入一份数据集、一份含 case/workflow 引用的 suite、一个 xpath/自定义字符串 op，断言语义往返、revision 变化、0/false/null 保留。
- [ ] 跑上述受影响用例，记录新字段不受支持导致的预期 RED；不把依赖未构建或宿主加载错误当行为 RED。
- [ ] 实现纯模型、新目录/顺序和引用校验；删除有引用资产应拒绝，跨项目副本映射 dataset/model/api/case/workflow/suite 内部引用；源外引用保留明确诊断不补同名目标。
- [ ] 扩展原 journal 失败夹具一次验证新资产整批回滚；运行 GREEN 和 Core typecheck。自审 unknown op 能保存、未执行时不被删除；运行拒绝由后续任务负责。
- [ ] 写 task 报告、停止产品写入；root 冻结增量并独立审核。未获 Git 授权，不自行 commit。

## Task 2: A2 选择器、丰富断言与契约值校验（F4-03/04/05）

**Files:** 新建 assert/selection.ts、evaluate.ts、schemaValue.ts、regex.ts；修改 operators.ts、plugin/types.ts、shared.ts/schema.ts 的纯导出、packages/core/package.json、pnpm-lock.yaml。

**Tests:** 复用 tests/assert/operators.test.ts、xpath.test.ts，在这些文件直接调用新选择/编译/求值接口；可新增一个 schemaValue.test.ts 承载组合/模型语义，不新增框架。此任务不提前要求旧 caseExecutor 执行新路径，接入验证由 A3 负责。

**Interfaces:** 产出 selectResponseValue、compileCaseAssertions/evaluateCaseAssertions 与 descriptor；旧两参数 evaluate 保持有效。仅新增 optional context，首版不重构插件注册/SDK。

- [ ] 在上述既有 operators/xpath 测试文件参数化断言 missing/null/false/0/空串、first/all、header大小写、Cookie最终响应来源；添加 config/assertion 区分，运行 RED。
- [ ] 安装固定 re2js@2.8.8 并更新已有锁文件，不运行升级；实现明确的 i/m/s 映射和捕获组适配，不启用其它扩展/原生回退。
- [ ] 实现表列 op、无脚本 JSONPath/XPath 选择、同响应解析缓存。actual/expected 在完整数据上判定，诊断仅准备宿主内部结果，尚不直接发 IPC。
- [ ] Schema 用已有模型夹具覆盖 oneOf 匹配0/1/2分支、required/additionalProperties、modelRef和实际状态/Content-Type选择；断言首个差异路径，边界超限明确非通过。
- [ ] 跑受影响文件 GREEN、Core typecheck；自审源文件/browser导出无 Node-only 依赖、旧 operator 合同未断、格式错误不被当 missing。报告→冻结→独立审核，不自动提交。

## Task 3: A3 提取、统一执行结果与跨入口语义（F4-06/07/17）

**Files:** 新建 testing/extraction.ts；修改 runner/caseExecutor.ts、runner.ts、variables/resolver.ts（仅必要的运行层删除/发布端口）、workflow/runner.ts/adapter.ts、stress/caseSession.ts、stress/model.ts/thresholds.ts、report/types.ts，以及实际引用 CaseFailureKind 的消费者。

**Tests:** 复用 tests/runner/caseExecutor.test.ts、workflow/runner.test.ts、stress/runner.test.ts 与 aggregate.test.ts 的最小相关夹具，保持每任务只跑其修改分支。

**Interfaces:** 产出 evaluateExtractions、ExtractionRuntimeState、结构化 AssertionOutcome/ExtractionOutcome；failureKind 增加 extraction，历史计数可缺省0，当前 producer 不得缺计数。变量层遵守规格，不改已有脚本宿主API。

- [ ] 在同一现有回环夹具：响应 id=0，提取后当次断言可用、下一 case/节点可用；第二轮 required missing 失败不发布任何目标且不读上轮残值。跑 RED。
- [ ] 在后置操作后、断言前接入提取；先计算再发布，按规格处理 required/default/optional 和新旧变量层优先级。提取标记只供运行输出，不落项目定义。
- [ ] 让集合/已有场景/压测共享此路径和真实 CaseExecutionLocator/scope/行身份；分类与聚合接上 extraction，中止仍 aborted，配置仍 config，计时边界/连接池/成功定义不改。
- [ ] 用现有两个run/VU隔离测试增加同名提取值断言，复用现有并发同步器，不加墙钟timeout。GREEN 后只做受影响类型检查；报告→冻结→独立审核。

## Task 4: B1 项目数据、统一准备与迭代（F4-07/08/09）

**Files:** 新建 testing/data.ts；修改 runner/runner.ts、stress/caseSession.ts、runner 的 ProjectExecutionRun、workflow/runner.ts、debug 执行入口、桌面 main/executionContext.ts 和 CLI 实际准备入口。数据字段/schema/存储消费 A1，避免第二次定义。

**Tests:** 复用 runner/runner.test.ts、stress/caseSession.test.ts、desktop main/debug.test.ts；新增一个 testing/data.test.ts 只验证新集中 loader，旧重复 reader 测试改为共享行为验证。

**Interfaces:** 产出 prepareTestData；PreparedTestData 为可序列化只读数据，不含文件句柄/绝对宿主对象。相同 run 的所有入口共享绑定，CLI worker 接收相同数据快照/摘要而非自行重读。

- [ ] 在原CSV夹具加入BOM/quoted换行和一行数据身份；JSON集中资产包含number/boolean/null，断言进入模板是明确文本；空新集拒绝，旧空文件保留提示。运行 RED。
- [ ] 实现统一有界parser/校验与准备，外部文件只按所选case集合读取一次；读文件错误含安全来源/行列，不输出单元原文。数据源错误保留已有集合逐case失败语义，suite全量预检由B2要求。
- JSON 位置仅采用真实原生元数据或准确 EOF，不能把源内容摘录中的数字当坐标；原生无坐标的 JSON/UTF-8 错误明确“位置不可用”，不捏造1/1、不另造解析器（R12）。
- [ ] 移除 runner/stress 的重复解析入口，消费准备表；显式缺少准备数据时拒绝有数据用例，不悄悄读取CWD或退化无数据。更新对应调用点/fixture。
- [ ] 用同一既有场景固定“准备→替换源文件→执行仍旧值；下次准备读新值”，单 VU 行0/1/0顺序，单行row仍可定位；GREEN+Core/CLI/Desktop必要类型门。报告→冻结→独立审核。

## Task 5: B2 套件计划、执行和 CLI（F4-10/11/12）

**Files:** 新建 testing/selection.ts、suiteRunner.ts、report/suiteAdapter.ts、packages/cli/src/testing.ts；修改 CLI main.ts（装配）、Core导出，以及 CollectionRunner/WorkflowRunner 的最小 signal/session/行注入端口。

**Tests:** 新建 core tests/testing/suite.test.ts（选择+调度同一小文件），扩展 cli tests/contract-assets.test.ts；适配既有 runner/workflow 夹具，不复制完整引擎测试。

**Interfaces:** 消费 resolveSuitePlan 的模型及 PreparedTestData/执行内核；产出 resolveSuitePlan、validateSuiteData、SuiteRunner、SuiteRunResult、suiteToRunResult，CLI test list/preview/run。配置失败与正常case失败都非零，preview零协议调用、零凭据读取/认证刷新。

- [ ] 参数化显式顺序/query标签与模块AND、scope继承、重复引用、空选择、跨项目同名、外层dataset+子dataDriver冲突；用协议调用计数断言非法计划为0请求，运行 RED。
- [ ] 实现纯选择冻结→所选数据准备→实际行数规模验证；preview到此返回，run才准备所选凭据。所有预检完成才执行。不同条目/外层轮次拥有独立变量和Cookie session，工作流条目内部沿用原共享规则。
- [ ] 接入现有 runners，串行/failFast/取消/部分结果/资源关闭按规格；条目skipped与实际case-row独立汇总，不捏造未发请求的通过case。CLI 明确 --project 与本次override，不保存用户文件。
- [ ] 同一用例+workflow+两行dataset合成套件证明顺序/统计/隔离；中途失败与取消复用一份fixture。CLI preview/run与core计划逐项相同，渲染参数交C1。GREEN+Core/CLI类型门，报告→冻结→独立审核。

## Task 6: B3 桌面结构化编辑、数据和套件入口（F4-12/13）

**Files:** 新建 apps/desktop/src/shared/testing.ts、main/testing.ts、renderer/src/stores/testing.ts 及 AssertionEditor/ExtractionEditor/DatasetPanel/SuitePanel；修改 session.ts/ipc.ts/preload、shared/types.ts/channels.ts、renderer API真实/内存实现、App.vue/TestSidebar.vue/TestView.vue/CasePanel.vue、i18n zh-CN/en。

**Tests:** 扩展现有 main/contract-assets.test.ts、renderer/components/CasePanel.test.ts、renderer/stores/cases.test.ts；新增一份 renderer/components/testingCenter.test.ts 覆盖新面板主流程，不为每输入控件另开文件。

**Interfaces:** 宿主方法接受显式 root/project locator/revision，仅返回纯DTO；previewSuite/runSuite/cancelSuite、saveDataset/saveSuite 端口复用B2与既有事务。renderer无文件系统、native凭据或runner导入。

- [ ] 在现有项目切换/dirty fixture 中固定“只有一个项目也能切回；测试新面板不能选择别项目；旧dirty确认保留”；新增面板保存重开/只读/未知插件op可见失败说明，运行 RED。
- [ ] 实现固定侧栏导航与搜索、分区滚动；断言按descriptor展示、regex兼容提示、提取默认/敏感选项，数据分页100行、导入导出预览，套件选择/规模/scope预览与取消。
- [ ] 跨IPC序列化/root和project身份/revision检查、只读、后到响应防串项目；沿用现有编辑会话，不全局重写标签/草稿系统，不借机修范围外F3观察项。
- [ ] GREEN+Desktop两种类型检查；一次真实renderer build留G合并执行，不每task重复完整构建。报告→冻结→独立审核。

## Task 7: C1 有界安全证据、报告与历史定位（F4-14/15/16/17）

**Files:** 新建 report/evidence.ts、CaseEvidencePanel.vue；修改 report/types.ts/html.ts/junit.ts、debug/projection.ts（仅提取复用纯helper）、执行输出/报告宿主接线、desktop main/runs.ts、RunView/RunsHistory/ResponseViewer、CLI testing.ts/main.ts 的报告输出、必要CaseLocator DTO。

**Tests:** 扩展 core tests/report/reporters.test.ts、credentials/output.test.ts、desktop main/execution-credentials.test.ts/runs.test.ts、renderer/components/RunView.test.ts；仅受影响样本，不重复凭据提供方专项。

**Interfaces:** SafeExecutionEvidence/EvidenceBudget 与 projectExecutionEvidence 只接受宿主input；输出为纯安全DTO。suite reporter依旧消费suiteToRunResult产物，历史按kind/project区分；元数据可缺以读取旧文件。

- [ ] 在既有报告fixture加入同名不同scope、同case不同entry/row/node、转义字符、已知凭据与sensitive提取，断言JSON/HTML/JUnit/IPC/复制均没有原值、定位不碰撞；运行 RED。
- [ ] 实现完整运行值上判断、输出前重新脱敏和统一预算；旧记录标未采集、未知正文标不可用，不读当前契约补历史。压力入口限制20失败样本，不留全请求正文。
- [ ] JSON先落盘、reporter后执行，renderer显示actual/expected/差异/提取阶段和当前版本差异；case可按当前精确locator重跑，workflow整条重跑。渲染失败仍保留安全JSON并明确警告/非零，不抹掉原执行失败。
- R13 报告计数澄清：保留真实 case-row 与 suite-entry 各自计数。某 failed/aborted entry+outer-row 没有真实失败行代表时，输出且仅输出一个显式标为“非 HTTP 条目诊断”的 reporting unit，JUnit 用 testcase+failure/system-out 承载；已有真实失败行时不重复补单元，仍保留条目错误，skipped 条目仅作独立元数据。不制造 CaseOutcome、请求或压测计数，不改成功 HTTP 行。JSON/HTML/JUnit 同时给出一致且有标签的 reporting-unit 汇总和不变的真实行/条目汇总；例如真实请求1通过、工作流条目1失败，则真实行1/通过1/失败0，条目失败1，报告单元2/失败1。代价是 JUnit 消费者遇到条目诊断时不能把 tests 数直接视为 HTTP 次数，应读明确提供的真实行数；不宣称所有外部消费者兼容。
- R14 同一规则适用于新生成的直接工作流报告：旧 adapter 曾把 noop、未发送的 skipped 节点及容器诊断合成为 CaseOutcome；新输出改用真实执行行、保留原节点身份/标签/状态/跳过原因/错误/节点计数的可选元数据，再复用同一非 HTTP 诊断格式器。旧历史仍兼容读取、不回写，实际 runner/请求/压测统计不改；旧 adapter 四例保留并迁移为真实行与独立节点/条目语义断言。代价是依赖旧合成用例数的消费者需改读明确的节点/报告单元计数，不新增执行引擎。
- R15 输出投影澄清：固定 DTO 字段名、协议枚举/状态、布尔数值判定及精确不透明定位/版本 ID 不被敏感文本匹配改写；业务内容值及动态字典键仍使用现有边界脱敏，显式 sensitive JSON 子树的字符串键和值均纳入保护。敏感业务字符串恰与公开元数据（例如 `passed`）同文时，验收检查业务来源值已遮蔽且协议形状/判定/定位不变，独特敏感标记仍检查全输出无原值；不以同文碰撞破坏协议或假报执行失败。代价是新增 DTO 字段需维护严格的来源分类/allowlist，不能把业务内容泛归为协议元数据。这仅修正输出投影，不恢复延期的运行时安全专项。
- R16（2026-10-21 用户选择）：本阶段补齐跨进程统一脱敏，保留多进程汇总的丰富证据，不采用常态下仅留定位/状态/耗时的降级方案。相关 worker 的新增敏感标记通过明确隔离的内部通路形成并集，最终公开输出仍先脱敏后截断；标记不能进入公开 DTO、报告、日志或参数，固定协议/真实计数/精确身份及现有样本和大小上限不变。代价是本阶段增加有限的内部交接与集成验证工作；不扩展压测调度/算法、凭据策略或 DEF-001 延期专项。具体增量和证据归入 C1 Fix2。
- R17（G 最终审核修正）：重复 Set-Cookie 优先按可靠 rawHeaders 逐条学习敏感值并投影，不按逗号猜分 Expires。仅在缺少可靠原始头、无法判定合并 Cookie 边界时，保守省略不可靠的普通业务文本并明确标 omitted/unavailable；固定协议、判定、计数和精确 ID 不变。私有 worker 若因此无法形成完整 marker 集则明确失败，不输出部分并集的丰富结果。正常 HTTP 原始头路径仍保留完整安全详情。代价是旧/自定义 adapter 未提供可靠原始头时详情会降级，私有汇总可能明确失败；以后可补准确适配，不为此引入另一套 Cookie parser 或恢复延期专项。
- R17 出口补充：普通 worker 的最终结果及错误出口复用同一宿主 typed EvidenceOutputBoundary，不以旧或部分 markers 重新构造“完整”边界。无法判定 Cookie 边界时，业务错误文本也明确 omitted/unavailable；原 primary/cleanup 失败优先级、typed 统计、精确身份及普通/私有 stop 与投影时序均保持。此处需要一条宿主回调接线和相应 Core/CLI 纠正性构建，不新增私有协议或另一套解析器。
- [ ] 复用预算夹具覆盖后出现敏感标记及跨截断边界、预算耗尽元数据保留；从旧无evidence报告读取到新suite汇总一致。GREEN+相关类型门；报告→冻结→独立审核。

## Task 8: G 一次阶段集成、审核与 Windows 交付（F4-18）

**Files:** 新增 ignored `.superpowers/sdd/2026-10-20-apicc-f4-test-diagnostics/` 的任务证据/最终审核；交付记录放主工作区local，不修改旧冻结样本/包。

R18（2026-10-21 用户明确授权）：原最终集中修复及唯一 scoped 复审后，原 13 项全部关闭，但真实包白屏 G-RC1、Cookie fallback 误遮蔽精确规则 ID/op/code G-RI1 仍承重。用户批准额外一次仅处理两项的定向补修，再重新打包并接续原生验收；仍由 GPT-6.1 Sol high 开发、独立 GPT-6.1 Sol xhigh 复审。这是对默认最终单波上限的明确例外，不授权重开宽审或无限循环。若 Sol high 确实无法解决，须说明证据并另行申请临时 Sol max，未同意前不自行升级。代价是增加这两项的最小回归、受影响 producer 刷新及新包/原生验证；不改变产品承诺、已有 18AC、版本/依赖、Git 禁区或 DEF-001 延期。

- [ ] root核对18AC和未闭合项；一位独立Sol xhigh做一次全增量集成审核，问题交原开发者批修、只定向复审。
- [ ] 基于最终候选跑一遍受影响测试集（各task已绿且源码未变的结果可复用，不拼成未跑的全量PASS）；Core→CLI→Desktop顺序，文件workers≤2；品牌/空白检查。确有跨模块风险才补最小集成断言，不复跑整个仓库。
- [ ] 按最终候选源哈希确认Core/CLI构建是当前产物，未变复用、已变才重建，再Desktop完整build一次（含renderer/electron/preload）；直接electron-builder目录打包到全新local/packages/f4-<candidate>/，不调用dist:dir重复build；包内构建对应核验。
- [ ] 一个合成项目/本地回环服务验证：保存断言提取→数据导入→套件preview→运行含故意失败→定位具体行→修正重跑→JSON/HTML/JUnit。检查当前项目边界、正常/短窗口内部滚动和只读。不操作用户真实项目或凭据；人工未验不冒充通过。
- [ ] 归档实际命令/退出码、AC映射、继承4项Minor/DEF-001、新包路径和仍待人工项，交用户验看。未有新明确Git授权，不提交/合并/推送/删分支/清工作树。

## 自审与批准后执行

规格18AC均有任务；五个Review Focus已落到上述对应fixture，不追加第二套矩阵。类型/函数命名由共享接口唯一规定，后续任务只能扩必要可选参数，不各自建立相同概念。新scope/资产引用/分类对全部既有入口的同步是必要接线，不是恢复延期专项。

用户已集中确认，从A1连续调度至G，常规修复不逐task询问。重大产品取舍、超出唯一新依赖/既有模型授权、不可安全推进或真实平台拒绝才暂停并明确用户要做什么。实际运行状态以本计划独占的 ignored progress.md 为准，规划时的未开始状态不作为当前事实。
