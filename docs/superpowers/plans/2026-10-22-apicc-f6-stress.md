# F6 专业开发阶段压测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development` 在当前会话逐任务执行；步骤用复选框跟踪。root 调度，一个开发写者；不得派嵌套代理。本文目前是规划归档，未获产品开工授权。

> **后续实施授权（2026-10-22）：** 用户确认“完成F6任务”，批准本计划及规格连续实施；本行取代前述开工等待。Git集成、max升级及延期专项仍未授权。

**Goal:** 在当前项目中用接口用例或完整场景执行可信本地压测，交付负载模型、VU 生命周期、有界指标、本机分片、趋势、基线与离线报告。

**Architecture:** 方案 A：在现有 StressRunner 基础上共用一个调度/聚合内核，case/workflow 为不同 VU 适配器；复用真实内核、F5 编排、F4 脱敏。CLI 本机 worker 通过 VU 代理接同一协调器，不各自复制负载曲线。桌面使用本地单进程入口，保留 CLI 本机多进程能力，不增加远程服务。

**Tech Stack:** 现有 TypeScript/Zod/Vitest、Vue/Pinia/Electron、Node 22.19.0、pnpm 11.21.0；不新增依赖或改变版本。涉及既有 Java 集成时使用 JDK 21 根目录。

**Spec:** `docs/superpowers/specs/2026-10-22-apicc-f6-stress-design.md`。用户已批准 local 设计稿方案 A；本计划及规格中的技术默认值供本轮集中审阅。规格和计划均确认后才实施；Git 集成另行授权。

**Baseline / workspace:** `af71a2d30eb97c6cfd7d312995b0287c27a01e8d`；已登记 linked worktree `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，规划分支 `codex/f6-stress-plan`。主工作区只保存 ignored local 阅读入口；旧工作树、包、stash、失败证据全部保留。规划阶段不安装依赖或重跑基线测试，基线 CI 已由用户确认通过。

## Global Constraints

- 开发 GPT-6.1 Sol high；独立审核 GPT-6.1 Sol xhigh；max 必须另批。一个开发写者、独立 worktree；不在 main 开发。
- 不纳入远程分布式 agent、在线协作/F7、脚本 Worker 池或新的脚本权限、WASM/allocator/异常来源、断点及历史内存重放。DEF-001 仍无限期延期。
- 新增场景压测先支持完整 HTTP 叶子闭包及 F5 声明式控制节点；普通 F5 工作流的协议范围不变，既有 CLI 单用例入口的协议行为保留；不以静默跳过替代兼容。
- 到达率的单位是迭代启动数/秒，不是实际 HTTP 请求数/秒；VU 数、场景内部并行上限及实际请求并发分别标识。
- HTTP 延迟仍取真实请求时间，场景迭代时延另列；场景恢复不删除真实失败请求。无有效数据、不完整、中止或 dropped 不显示普通通过。
- 每 VU 同时最多一个迭代；run/VU Cookie、变量、数据、client 所有权明确。用户停止不新发网络 cleanup；未真实收尾不显示结束。
- plan formatVersion=1、report formatVersion=2、worker protocolVersion=3；旧报告保持原语义可读，未知版本/混合 worker 明确拒绝。
- 新计划 maxVus 1..1000、阶段≤32、时长≤7天；默认 warmup/think/pacing=0、gracefulStop=30000ms。新计划 UI 上限不得擅自缩紧旧调用的正 safe integer 接口。
- 流式 log 桶 min=0.001ms/gamma=1.01/4608桶，exact 数字缓存≤256；timeline 初宽1000ms/≤120桶；节点512+other；数值聚合容器≤64MiB；失败样本≤20且沿用 F4 字节预算。
- Core shared/schema/browser 只暴露纯模型/算法，Node/磁盘/凭据装配不进入 renderer；不修改 ContractProject 存储压测偏好，不把运行确认永久化。
- 沿用最终 URL/重定向/目标策略和 F4 私有 marker 完成屏障，不改凭据策略，不恢复延期专项。
- Node 22.19.0、pnpm 11.21.0、JDK 21 根目录保持；不升级依赖、不扩 CI 范围。Core 构建→Core 类型→其他构建；包间顺序、每包2workers。
- 开发最小定向 RED/GREEN，最终一次必要完整包门禁；同 tree 不重复全量、不加 timeout/skip 求绿。阶段内不逐 task 索批准，仅实质变更、新授权/模型或真实阻塞暂停并说明用户动作。
- 本阶段不开自动24h高压实验；未有长稳证据时发布容量项明确开放。Git stage/commit/merge/push/清理不在实施默认授权内；任务完成以冻结候选和报告交接。

## Review Focus

1. 场景 recover/OR 最终通过但中间请求失败：迭代与请求判定不能混淆；D 的组合用例守住，B 计数分层。
2. 时钟跳变、预热跨测量、降载及在途 drain：分母/阶段/取消不能错；C 的可控时钟与屏障用例守住。
3. VU×场景叶子并行、重定向或多 worker：不能复制全局限额或嵌套许可死锁；C/E 的全局门禁与预算守恒用例守住。
4. 百万样本、很多节点/错误码、溢出和重复 snapshot：不能线性存原样本或重复算；B/E 的边界/合并用例守住。
5. 切项目/停止重开、旧报告和零基线：不能展示迟到运行或造0%改善；F1/F2 的比较与身份围栏用例守住。

## 文件职责与共同接口（均为新增设计，除明确标“既有”外不可当作已存在）

| 文件/单元 | 职责/接口所有者 |
| --- | --- |
| `stress/plan.ts`、`reportV2.ts` | A：纯计划/新报告 schema、版本读取、稳定元信息；model.ts保留旧字段及可选statistics兼容 |
| `stress/execution.ts` | A：host-only执行类型；不经 shared 导出原始结果/凭据 |
| `stress/histogram.ts`、`metrics.ts` | B：可合并有界数字、时间/节点维度与公开摘要 |
| `stress/loadScheduler.ts`、`plannedRunner.ts`、`requestGate.ts` | C：统一排期、预算、生命周期/取消和实际请求门禁；原runner.ts兼容适配 |
| `stress/workflowSession.ts`、`workflow/prepared.ts` | D：场景适配、预编译句柄/所有权；runner/v2Runner转发实际观察/客户端 |
| `stress/workerProtocol.ts`、`distributed.ts`、CLI transport | E：v3严格消息、远程VU代理、同机时间锚点和完成屏障 |
| `stress/compare.ts`、`stress/html.ts`、Desktop `main/stressPlans.ts` | F1：纯比较/离线模板、项目范围原子配置保存；历史严格读取 |
| Desktop stress store/Panel/ReportView、App/WfDesigner入口 | F2：计划编辑、运行状态/趋势/比较、项目和运行身份围栏 |

以下路径以 `packages/core/src/` 为根，除标 Desktop/CLI 外。主签名集中在此，后续任务不得自行换名：

```ts
// A：schema infer出的纯类型 StressPlan / StressReportV2 / ReadableStressReport
compileStressPlan(snapshot: ProjectSnapshot, plan: StressPlan): CompiledStressPlan;
bindPreparedStressExecution(compiled: CompiledStressPlan, run: ProjectExecutionRun): PreparedStressExecution;
parseStressReport(value: unknown): ReadableStressReport; // legacy | v2，按版本严格选择
// CompiledStressPlan：snapshot owner、projectId/revision、plan、targets、workflowPlans、schedule、metricPlan
// PreparedStressExecution：compiled、run:ProjectExecutionRun；只能由准备宿主建立
// StressSchedule：纯load/时间/预算/容量；StressMetricPlan：stableNodeKeys和固定容量/精度（无随机runId）
// StressIterationContext：runId、vuId、iterationId、stageId|null、phase、scheduledOffsetMs、signal
// StressIterationResult：state:passed|failed|aborted、durationMs；不携带整次workflow结果
// StressMetricEvent：kind:case|http|node|iteration，phase/stageId/atMs、数字计数/耗时、固定错误类别/稳定节点键
// StressVuSession：execute(ctx):Promise<StressIterationResult>；close({reason,signal,allowNetworkCleanup}):Promise<void>
// StressClock：now():number、wallNow():number、sleep(ms,signal?):Promise<void>
// StressExecutionDeps：runId、createVu(vuId,initialInputs)、可选runLifecycle(role,inputs,signal)、gate、clock、metrics、evidence、signal、onProgress

// B：accept不保存CaseExecutionResult，只保存数字；snapshot为host-only可合并状态
createStressAccumulator(plan: StressMetricPlan, runId: string, options?: {sourceId:string;scope?:"all"|"observations"}): StressAccumulator;
// StressAccumulator.observe(event:StressMetricEvent):void；snapshot():StressAggregateSnapshot
// merge(snapshot:StressAggregateSnapshot):void；finish(ctx:StressFinishContext):StressMetricsSummary
// summary为纯数字和完整性；reportV2装配由runStressPlan完成，旧适配器只投影兼容报告

// C：clock为单调now/sleep可注入；window/stop原因在finish上下文中
runStressSchedule(schedule: StressSchedule, deps: StressExecutionDeps): Promise<StressMetricsSummary>;
runStressPlan(prepared: PreparedStressExecution, deps: StressExecutionDeps): Promise<StressReportV2>;
createStressRequestGate(options: StressRequestGateOptions): StressRequestGate;
// GateOptions：maxConcurrency、maxRps?、clock、authorizeRequest(finalRequest)
// gate.enter(request,signal):Promise<()=>void>取得协议并发+初始hop速率，返回幂等release
// gate.beforeRedirect(request,signal):Promise<void>只取得下一hop速率；不重复占并发

// D：复用真实 CompiledWorkflowPlan 与同对象snapshot，不序列化句柄
prepareWorkflowExecution(run: ProjectExecutionRun, workflowId: string, options?: WorkflowPlanOptions): PreparedWorkflowExecution;
WorkflowRunner.runPrepared(prepared: PreparedWorkflowExecution, options?: WorkflowRunOptions): Promise<WorkflowRunResult>;
createStressWorkflowSession(target: PreparedWorkflowExecution, deps: StressWorkflowSessionDeps, options: StressWorkflowSessionOptions): StressVuSession;

// E：在同一runStressPlan下提供远程VU代理，不是另一套负载调度器
runLocalStressWorkers(prepared: PreparedStressExecution, options: LocalStressWorkerOptions): Promise<StressReportV2>;
// F1：对纯、安全报告比较；Node磁盘由host处理
compareStressReports(base: ReadableStressReport, candidate: ReadableStressReport): StressComparison;
renderStressHtml(report: ReadableStressReport, comparison?: StressComparison): string;
```

A 在 execution.ts 固定以上结构的 readonly/判别联合；原始 CaseExecutionResult 只在适配器→现有 evidence collector 的内部同步边界使用，不能塞入可序列化 MetricEvent。MetricEvent共同字段为phase、stageId:string|null、atMs（run单调offset）、可选vuId/iterationId；case带ok/status/requestStarted/requestCompleted/failureKind及三种时间、locator/nodeKey；http带started/completed；node带nodeKey/state/durationMs；iteration带started/passed/failed/aborted/dropped、durationMs/startDelayMs。当前结果必须显式给资格位，不用缺字段猜测。iteration/load由协调器唯一计数，worker snapshot仅合并case/http/node。阶段/节点/失败身份、可选不可用指标在reportV2.ts明确，不用宽松any或默认0吞掉差异。

实施接口校准（2026-10-22，供所有后续消费者使用）：

- `lifecycle`的setup/vuSetup/vuTeardown/teardown均用 `{workflowId,inputs?,outputs?}`；outputs只允许setup/vuSetup，方向sourceOutput→主目标initialInput。主目标初值按target.inputs→setup映射→vuSetup映射合并，同名后者覆盖；生命周期自身仅接该步显式inputs。case值须string，workflow按声明输入验证，不隐式转换或传播全局值。
- `StressPhase`统一为 `setup|vu-setup|warmup|measurement|drain|vu-teardown|teardown`。预热排空仍属warmup，preparing/stopping/finished属于宿主状态。
- metricPlan以histogram/timeline/node/error/evidence/memory分组固定容量，stableNodeKeys为 `{workflowId,nodeId,key}[]`，key采用无碰撞稳定元组编码。schedule含load、durationMs/null、maxIterations/null、maxVus、metricPlan、节奏和requested/effective请求限额；Compiled.targets带主目标/生命周期role及固定request selections。
- 新指标availability明确available/unavailable（无数据附有限reason、不造0），generator沿用已有partial兼容；完整性execution/metrics/load均为 `{complete,reasons}`。requests固定started/completed/eligibleCompleted/failed，failed只统计合格已完成请求中的失败；httpExchanges固定started/completed。预I/O失败仍保留caseRows和分类。
- host evidence沿用已有collector，snapshot为readonly有界数值状态及merge身份/版本，具体B实现。compile/bind可放host-only execution.ts，仅index导出；schema/shared不依赖Node或未来实现。
- B实装交接：snapshot用`sourceId`标身份，formatVersion/histogramVersion均1并携带纯metricPlan；同源累计final只合并一次，observations scope禁止iteration。进度只能替换，不能累加。`eligibleFailureCounts`为transport/http/script/assertion/extraction/config/aborted的固定7项向量，aborted槽0。
- 正式顶层仅measurement/drain，其他阶段保留phase/timeline；跨phase的hop允许局部completed大于started。C用`StressFinishContext.phaseWindows`给真实覆盖（含空闲/排空，≤69项），不能用观察首末当分母；缺覆盖时间字段成组null/RPS未采集并标不完整。E传`timelineUncertaintyMs`真实最大RTT/2；单进程默认0。`StressMetricsError.code`由C在数字旁路捕获并终止运行，不冒充业务断言失败。
- 全局statistics为所有公开分布的保守精度，underflow/overflow为“单一统计序列最大超界数”，不是请求数或并集；legacy violation新增`incomplete`。F1/F2须消费这些事实，不把未知填0。numericBytes只约束有界数值容器，不是进程内存承诺。
- C实装host接线：createVu可选第三`StressVuHostContext`，runLifecycle可选第四无VU的`StressLifecycleHostContext`，原二/三参兼容。VU host闭包保留`reportLifecycle(vuSetup|vuTeardown,result)`，消费真实outputs后仅返回显式映射inputs；工厂失败先回报并释放已有资源。runLifecycle只由scheduler调用setup/teardown。`deps.execution`为prepared权威装配的targetInputs/lifecycle/thresholds/validateTargetInputs，不进纯schedule。
- iteration的可选observation()/observe以观察当刻phase/单调offset采样，并保持源VU/iteration/stage身份；ctx.phase仅表示启动phase。E须显式传远程时钟/phase，不能序列化本地函数。每次迭代末次readyAt跨warmup保留，formal时钟独立起算；首次外部abort统一截断正式统计窗口，finished状态仍等待真实execute/close。
- C的createStressCaseVuSession即时桥接case/hop数字和evidence；受控gateManaged路径只在真实内核取许可，旧opaque只纯admission，两者共享底层额度，不伪造URL。仅旧适配内部自然排空无额外上限（Infinity等待change/abort）；新保存计划默认30秒/最多300秒原样。gate.recordTarget/audit最多256 origin及既有字节预算，D/E必须接真实授权详情，不补造确认。
- D实装：prepareWorkflowExecution options可复用compiledPlan，compiler私有WeakMap与prepared WeakSet均验证同一snapshot，绑定/数据校验在句柄建立时完成。WorkflowRunner/CollectionRunner.runPrepared不重新capture/compile。新增beforeSend/requestGate/resolveProtocol、真实单调node观察和host私有observeOutputs沿v1/v2/child/handler转发，旧trace不变。
- `createPreparedStressHost(prepared,deps,options)`一次建立全部workflow句柄，返回createVu/runLifecycle/closeRun。VU主case/workflow及VU两步骤共用VU owner，run setup/teardown另共用run owner；借用Cookie/client子session不close父资源。scheduler最终await可选deps.closeRun再finished，所有失败/取消出口同样本地释放。E沿用三个钩子、maxSamples20的现有evidence collector、真实workspaceRoot和授权/本次确认，不另拼生命周期。
- E实装交接：`createLocalStressWorkerDeps(schedule,options)`返回同调度器deps及richOutputComplete/generator/failureEvidence/distributed/close，`runLocalStressWorkers`供新plan直接装配；旧CLI数值接口接同remote调度，不套新计划上限。v3 channel.send可返回Promise，完整frame串行、逐块flush；实际OS shutdown ACK及code0/signal=null后才finish。worker state只留四计数，pending1MiB从同64MiB预留；私有生命周期只传必要映射值，root晚marker仍全体UNION。
- E错误数字：`errorCounts/errorKinds`为128+other有界机器键分布，真实http失败在观察时记`HTTP_<status>`联合键（status0仍http），不是从statusDist猜；固定failures/eligibleFailureCounts七分类不变。Desktop plan输入/输出判别、root/完整project/runId/generation及progress disposer已实现；runs v2读取和工作台仍分别归F1/F2。历史一次正常CLI code1原因缺失仍交G观察，非已定位。
- F1实装：pure `compareStressReports/renderStressHtml/isStressReportV2`由shared/index导出；preload运行时`StressComparisonSchema`只从`@apicc/core/schema`取。Comparison含directlyComparable/mismatches/notices及6个固定metric差，relative为比例、缺/零基线null。legacy资格按顶层→measurementWindow→零总样本判空，未知资格保留旧数值，HTML不补造F6完整性。
- Desktop保持`runs:get {kind:'stress',report}`，report按formatVersion判别legacy/v2；summary.rps为number|null、v2另带verdict/target/completeness/rpsMetric。六方法为stressPlansList/Get/Save/Remove、stressCompare、stressExport，完整ProjectLocator入参；export返回`{saved,file}`，取消为`{saved:false,file:''}`。配置save显式id必须已属此scope。
- F1 host归属旁证：新Desktop stress报告最终安全字节写成功后生成`<file>.scope`，绑定实际root/完整locator/SHA256；两件均成功才回file。无旁证/变字节/其他scope拒Desktop比较导出，旧报告仍可读；CLI显式baseline文件不套此围栏。复制/移动root后的旁证不静默认领，后续显式导入另议，不增加共享模型字段。

## Task 1（A）：纯契约、固定闭包与预检

**Files:** Create `packages/core/src/stress/{plan,reportV2,execution}.ts`；Modify `stress/model.ts`、`report/types.ts`、`shared.ts`、`schema.ts`、`index.ts`；Test 新 `packages/core/tests/stress/plan.test.ts` 及既有 `aggregate.test.ts` 的历史解析用例。

**Interfaces:** 消费既有ProjectSnapshot、CompiledWorkflowPlan/compileWorkflowPlan/workflowPlanRequests；产出上节A的schema、types、编译/绑定和版本读取。CompiledStressPlan所有权绑定输入snapshot；bindPreparedStressExecution要求run.snapshot为同一对象并验证准备数据，宿主不得编译后再用capture替换snapshot。带入的生命周期同样编译闭包/收集数据与凭据选择。A在execution.ts声明完整接口，不能import B/C尚未创建的实现文件导致阶段构建失败。

- [x] RED：小文件验证有效 case/workflow/生命周期计划与非法零/NaN/阶段ID/越界/跨项目/递归；report v2必须有iterations/完整性，legacy缺新字段仍可读，未知版本拒绝。行为断言失败，不把Vite导入/类型报错当实现缺口的验收。
- [x] 实现计划严格schema、SavedStressPlan信封、默认值、阶段总时长唯一来源及目标/协议预检；禁止把旧运行确认写进可保存计划。新报告保留原汇总字段的含义：旧totalRequests/ok/failed对应case样本行，v2通过caseRows明确展示；requests为实际协议尝试，httpExchanges为hop事实。增加规格§6.3字段；旧legacy shape允许可选statistics说明近似精度。
- [x] 明确区分历史读取 schema 与新 producer schema：旧 `StressReportSchema` 不失去历史数据；新输出必须通过 `StressReportV2Schema`。命名为 `ReadableStressReportSchema` 的版本分派从 schema/shared 暴露；Node准备句柄和运行器只从 index 暴露。
- [x] EvidenceIdentity及严格SafeExecutionEvidenceSchema增加可选stressRunId/vuId/iterationId/stageId，保留旧数据；runId由宿主分配，纯compile不生成随机值。节点/统计接口声明保持A可独立编译，不以any/占位实现依赖未来任务。
- [x] GREEN：`pnpm -C packages/core exec vitest run tests/stress/plan.test.ts tests/stress/aggregate.test.ts --maxWorkers=2`；Core build/typecheck。未改CLI/Desktop不启动宽集，报告公共consumer迁移由E/F2负责。
- [x] 自审后停止写入，冻结A候选、列出下游接口与实际命令/退出码，root安排一次独立任务审核；不提交。

A验收记录：最终plan27/27、未变aggregate17/17、Core build/typecheck exit0；独立Sol xhigh首审3项报告误通过问题，经fix1全部关闭，spec/quality Approved。冻结task-1-fix1及原始证据见本阶段ignored账本。此处不代表B–G或12AC整体完成。

## Task 2（B）：流式指标、精度与有界维度

**Files:** Create `packages/core/src/stress/{histogram,metrics}.ts`；Modify `stress/{aggregate,thresholds,model}.ts`、`report/evidence.ts`（仅新形状投影）；Test 新 `packages/core/tests/stress/metrics.test.ts`，扩展既有 `aggregate.test.ts`，不为每个指标新建文件。

**Interfaces:** 消费A的MetricPlan/MetricEvent/报告结构；产出accumulator/snapshot/数字summary，公开报告装配不依赖聚合器去读取快照。旧 `computeReport(samples,opts)` 保持小数组兼容并可经同一数字统计工具，不再成为生产samples仓库。Snapshot具有runId、sourceId、sequence、histogramVersion和时间桶分辨率，merge检查配置/身份，不静默揉合不兼容桶。

- [x] RED：用已知分布验证exact≤256与超过后≤1%保守桶、0/underflow/overflow；合并前后计数/分位一致。一个百万**合成数字**流验证count与容器容量，不保存百万结果、不发网络；120→121桶合并、512→other节点、128→other错误键并表测试，失败计数不能丢。
- [x] 实现全局三时延、caseRows/requests/iterations/httpExchanges独立计数；节点request/node时延、时间桶request时延，按稳定闭包预选节点键。数字事件不加入origin/URL/safety对象；origin审计由C实际gate/宿主装配保留≤256及既有字符串预算，E沿用，溢出显式标不完整，不建无界Map。
- [x] warmup/lifecycle/measure/drain独立聚合；请求合格规则沿用旧函数。新workflow默认逻辑失败与显式请求阈值分开；无数据/采集失败/dropped/中止产生准确非成功原因。指标内部错误记录并停止该运行，不通过回调异常篡改单个业务断言结果。
- [x] snapshot保存有界数字供内部合并，公开finish只输出摘要/桶摘要，不携带原始bins或原始outcome；保留F4 marker收集/先脱敏再截断及20失败样本。
- [x] evidence的身份投影/匹配同时保留新增VU/iteration字段，重复相同case/row不覆盖另一迭代样本；F5既有invocation/visit/attempt/row身份仍准确。旧无VU身份的报告不虚构新身份。
- [x] GREEN：Core `metrics.test.ts aggregate.test.ts`，涉及投影时复用 `tests/credentials/output.test.ts` / `tests/stress/runner.test.ts` 中实际受影响证据用例，build/typecheck；新增测试只在这个小文件。报告内存容器容量而非假称整个Electron堆上限。
- [x] 冻结B→独立任务审核→停止；交C/E accumulator接口和合并配置，不提交。

B验收记录：task-2-fix1冻结807文件verify PASS；最终metrics/aggregate37项、投影5项、Core build/typecheck均exit0，未变schema沿用既有plan27项。独立Sol xhigh首审4项经fix1全部ADDRESSED，无新增C/I/M。正式执行接线、origin审计、IPC及UI/新包仍属C–G，百万数字不证明全堆/千连接/24h容量。

## Task 3（C）：统一负载调度、case VU 与取消

**Files:** Create `packages/core/src/stress/{loadScheduler,plannedRunner,requestGate}.ts`；Modify `stress/{runner,caseSession}.ts`、`runner/caseExecutor.ts`；Test 新 `packages/core/tests/stress/loadScheduler.test.ts`，复用 `stress/{runner,caseSession}.test.ts`、`runner/caseExecutor.test.ts`；必要纯类型在execution.ts，由C保持A接口。

**Interfaces:** 消费A/B，产出runStressSchedule/runStressPlan与gate。runStressSchedule只接纯schedule、session工厂和metricPlan；新runStressPlan装配prepared资产并生成v2，旧StressRunner.run用原createWorker回调接同一schedule内核并投影兼容报告，不制造假snapshot、不保留旧并发循环。原onSample按次回调但不保存全量。CaseExecutionDeps新增可选requestGate，enter在requestStarted/计时前执行，取得初始并发/速率；finally release。现有runtime.beforeRedirect在认证/原beforeSend之后再调用gate.beforeRedirect，不改变普通httpClient的默认行为。

- [x] RED：可控时钟下20迭代/秒、1000ms得到20个半步槽；只有一个忙VU时dropped增加而非排队补发；线性升/降与总预算守恒。屏障验证并发、同VU不重入、降载在途不被当完成。
- [x] 同组验证warmup不扣正式预算，think=30ms/pacing=100ms/执行=80ms时至少等30ms；wallclock跳变不改测量；提前停止无新执行、自然排空超时标incomplete；close异常/取消等待者都释放许可。只等门禁就中止时requestStarted=false，无合格延迟/RPS样本。用事件/虚拟时钟断言，不调大timeout。
- [x] 实现一个状态机；arrival积分反求下一槽，不物化全计划队列；请求许可等待者≤32000。区分iteration并发与实际请求并发，重定向取得新的速率许可但持有原并发许可，防止上限=1时死锁。
- [x] 实际请求gate/宿主装配保留有界origin审计≤256及既有字符串预算；溢出显式记录容量/完整性，E多worker沿用；不将原始URL/safety对象塞入B数字流。
- [x] 适配原createStressCaseSession：原始execution先经evidence/数字采样后释放；case容器pre/post、数据游标、变量/提取不回退。VU持有Cookie和client并分别close；run setup/teardown由共用生命周期接口调用，不把caseSession再实现一遍。
- [x] GREEN：Core `loadScheduler.test.ts runner.test.ts caseSession.test.ts` 及内核gate相关 `tests/runner/caseExecutor.test.ts`，build/typecheck；不真实长时间发压，不改原HTTP计时/失败分类断言。
- [x] 冻结C→独立任务审核→停止；交D createVu/生命周期契约，交E远程VU替换点，不提交。

C验收记录：直接受影响的既有generator20项纳入同一最小组，虚拟驱动改setImmediate屏障但不改原断言/timeout。首审3项（混合额度、drain中停止窗口、跨warmup冷却）经fix1关闭；最终5组156项、Core build/typecheck均exit0，原独立Sol xhigh复审通过。task-3-fix1冻结811文件verify PASS。D/E真实workflow生命周期、远程协议和授权审计接线仍待其责任门禁，不用C的受控callback冒充集成。

## Task 4（D）：完整 workflow VU 与固定准备

**Files:** Create `packages/core/src/{stress/workflowSession,workflow/prepared}.ts`；Modify `runner/runner.ts`、`workflow/{runner,v2Runner,plan,trace}.ts`、`stress/execution.ts`、`index.ts`；Test 新 `packages/core/tests/stress/workflowSession.test.ts`，复用 `workflow/{runner,references,adapter}.test.ts`、`runner/caseExecutor.test.ts`。

**Interfaces:** 消费C控制器、既有WorkflowRunResult/WorkflowCaseObserver、CompiledWorkflowPlan。新增WorkflowRunOptions中的beforeSend、requestGate、resolveProtocol、observeNodeExecution与prepared入口；CollectionRunner相应转发最终request钩子/门禁和该VU的协议选择。WorkflowNodeObservation在trace.ts声明workflowId/nodeId、可选visit/attempt身份、state、durationMs，host-only回调不改旧trace格式。普通调用不传新项时保留行为。

- [x] RED：一份F5组合夹具跑两个VU，两次迭代；Cookie/显式初始化输入不串，编译/数据/凭据准备不是每迭代执行。不同snapshot对象即使revision相同也不能借用prepared句柄。
- [x] 复用同夹具的 retry/OR/recover：逻辑迭代通过、真实失败请求保留，caseRows与requestFacts及httpExchanges计数核对；mixed数据节点长度不同不强塞统一rowIndex。v1 root/v1 child最终目标hook同样生效。
- [x] 实现 prepareWorkflowExecution/Runner.runPrepared，避免run内部再次capture产生新snapshot后使WeakMap归属失效；普通run走原捕获/校验路径。一次压测预编译target及全部生命周期闭包，worker独立按固定版本重建句柄。
- [x] 注入VU managed client而非默认全局registry池；Cookie和连接分别复用/释放。setup/vuSetup/vuTeardown/teardown各按规格执行，输入映射严格，停止不发网络收尾；不扩旧child输入能力或跨root隐式全局状态。
- [x] 节点trace现无duration：增加可选host-only节点完成观察，携带identity/单调duration而不修改旧trace解释；case用真实观察，节点结果仅处理一次逻辑汇总，沿用workflowCaseRows去重语义。每迭代结束丢弃完整trace/result，只留有界摘要/失败样本。
- [x] GREEN：上述新小文件及实际变动的workflow/runner受影响文件，Core build/typecheck；沿F5已有fixture，不新增全节点×全策略矩阵。
- [x] 冻结D→独立任务审核→停止，报告生命周期真实HTTP计数/钩子覆盖路径；不提交。

D验收记录：最终6文件161项、Core build/typecheck exit0，task-4-v1冻结814文件verify PASS。独立Sol xhigh Spec/Quality Approved，C0/I0/M1；唯一Minor为报告IPC措辞，root按E-00澄清，不改产品。E所需必要受控私有控制值不能混同数字进度/公开输出；多worker/marker/锚点、新包与长稳仍待E/G，不外推D局部通过。

## Task 5（E）：CLI/桌面宿主、本机 v3 worker 与进度

**Files:** Create `packages/core/src/stress/workerProtocol.ts`、`packages/cli/src/stressPlanCommand.ts`（从main拆出新增装配，不搬无关命令）；Modify Core `stress/distributed.ts`/`index.ts`；CLI `main.ts`/`stressWorkerTransport.ts`；Desktop `shared/{types,channels,ipc-contract}.ts`、`preload/{stressBridge,preload}.ts`、`main/{stressController,stress,ipc,executionContext,runs}.ts`、`renderer/src/api/memory.ts`。

**Tests:** 复用Core `tests/stress/distributed.test.ts`；CLI `tests/{e2e,stress-worker,stress-subprocess}.test.ts`；Desktop `tests/main/{ipc,preload-contract,runs}.test.ts`、`tests/renderer/api/memory.test.ts`。只运行实际受影响组，跨包测试在producer先更新之后执行。

**Interfaces:** 消费A–D。新增 `run-stress-plan <projectPath> --plan <planFile> --shards --allow-target --runs-dir`，projectPath沿用工作区UUID项目路径，planFile严格接受原始StressPlan或SavedStressPlan信封；沿用原认证/环境/网络准备链。保留 `run-stress <apiPath>` 为兼容适配。Desktop `StressRunInput` 增加严格plan分支，后续F2实际为 `{kind:"plan",root,invocationId,projectLocator,plan,confirmedTargetOrigins?}`；旧locator+case分支保留适配，规范化后只运行同一个controller。root/调用关联不写入SavedStressPlan，不改变CLI raw plan。

- [x] RED：CLI旧case选项/新plan产生同等case语义；SIGINT取消单进程并非零。两worker固定总预算与phase/iteration身份守恒；重复final/错误worker/run/version/缺失snapshot不补零；原F4marker UNION前富输出拒绝仍成立。
- [x] 实现v3 prepare→run-ready→start、execute/result、request-permit/release、stop/drained；marker READY/UNION与起跑屏障独立分派。协调器唯一排期和许可，workers作为VU代理，不能把完整maxRps复制给每个worker。
- [x] 沿用shards≤可用VU容量的校验，不为保证每worker有任务而增加真实总VU；协调器只采iteration/load，worker只采case/http/node，统一snapshot不会重复加总。worker退出时撤销其所有许可租约，迟到release/result按run/worker/lease身份拒绝，不能释放另一运行的资源。
- [x] 每次迭代独立归属，进度最多4Hz、累计可替换且不参与最终累加；只公开身份/状态/数字/固定机器码，不预先广播业务文本或证据。final数字snapshot序号/身份校验后合并，单份内部snapshot≤64MiB并分块。stdout只接最终公开结果；受控IPC传内部数字/marker，不回显原始stderr。
- [x] 完成顺序为worker drained→协调器teardown/close→全worker＋协调器（含晚marker）UNION→富输出；复用原私有屏障测试补协调器晚marker边界，不能在根teardown前提前发UNION。
- [x] 同机时钟锚点取IPC往返中点并记录RTT/2不确定性；时序不可靠时报告partial，不影响本地真实duration。启动/结束/取消有界，worker未drained不得提前返回“已停止”。原shard-timeout参数保留；不为解决测试加大默认超时。
- [x] Desktop绑定实际root＋完整项目定位＋runId，start时固定全闭包；补充 `stress:progress` 事件（只含安全摘要），preload订阅可注销；stop可指定runId，旧无runId适配仅当前owner，迟到旧stop不能取消新run。项目不存在/跨项目入口立即拒绝。
- [x] GREEN：先Core build/typecheck，再CLI/Desktop consumer build/types，再相关Core/CLI/Desktop最小组；两进程代表验证足够，不扩workers数量/负载矩阵。旧协议错误断言迁移到v3等价边界，不删除测试。
- [x] 冻结E→独立任务审核→停止；明确主命令名是run-stress，不存在旧stress-distributed命令；不提交。

E验收补记：两轮集中修复后原独审Spec/Quality Approved，C0/I0/M1。最终fix2 Core104/CLI真实4及producer检查通过，其他未变输入按任务报告继承；不是所有CLI组合/全阶段门禁已通过。历史正常8次code1未定位及两类warning交G保留，F1/F2/G未完成。

## Task 6（F1）：项目配置、报告导出和基线比较

**Files:** Create Core `stress/{compare,html}.ts`；Desktop `main/stressPlans.ts`；Modify Core `shared.ts`/`index.ts`、Desktop `shared/{types,channels,ipc-contract}.ts`、`preload/stressBridge.ts`、`main/{ipc,runs}.ts`，CLI `stressPlanCommand.ts`。

**Tests:** 新 `packages/core/tests/stress/report.test.ts`（比较/模板同一小文件）、`apps/desktop/tests/main/stressPlans.test.ts`；扩现有runs/strict IPC/preload契约用例，不新建通用资源管理框架。

**Interfaces:** `compareStressReports`/`renderStressHtml`为纯函数。配置仓库 `createStressPlanRepository(root):{list(scope),get(scope,id),save(scope,{id?,name,plan}),remove(scope,id)}`，返回SavedStressPlan/其列表或null，scope使用完整ProjectLocator，host生成ID/哈希root key、严格JSON/原子写入；配置不进入ContractProject。preload对应stressPlansList/Get/Save/Remove，比较为stressCompare(scope,{baseFile,candidateFile})，导出为stressExport(scope,{file,baselineFile?,format:"html"|"json"})；均严格输入/输出。

- [x] RED：同目标/负载比较给绝对/相对差；定义revision变化仅提示，不一律拒绝；不同项目拒绝、环境/连接/模型/数据/统计口径不匹配标不可直接比较。base=0或缺指标相对差为null，旧报告不造新指标。
- [x] 配置用例覆盖保存重开、实际root和完整project隔离、非法ID与中断写入保留旧文件；只保存引用/非敏感配置，不保存运行确认、setup结果或解密值。预览/分享由既有安全边界投影，不新造凭据策略。
- [x] 新增IPC `stress-plans:list/get/save/remove` 与 `stress:compare/export`；输入scope围栏，比较/导出仅接已保存的同项目报告文件ID，不能接受renderer任意路径读取。CLI支持 `--html <file>`、`--baseline <reportFile>`；沿用CLI明确文件访问语义。
- [x] 压测HTML自包含、无远程资源、转义所有用户文本；主结论、负载未达/完整性、曲线/阶段/节点与失败证据一致；目录/筛选固定区域、长内容局部滚动，不重复已修过的页级滚动问题。
- [x] GREEN：新两个小文件与实际触及的runs/IPC测试，Core/CLI/Desktop受影响producer/consumer检查；不为纯模板变更重复三包宽集。
- [x] 冻结F1→独立任务审核→停止；配置与历史落盘失败仍保留安全内存结果，不能伪造保存成功；不提交。

F1验收补记：fix1后原独审Spec/Quality Approved，新增C/I/M=0/0/0；55个不同定向用例及最后Core report4/producer检查按未变输入继承，不重复相加。HTML缺字段分支静态审核正确，但新增fixture实为显式false，不声称缺字段已动态覆盖。原生HTML几何/滚动及F2工作台、G新包/完整门禁仍待，局部通过不是F6完成。

## Task 7（F2）：压测工作台、趋势和基线交互

**Files:** Modify Desktop `renderer/src/stores/{stress,run}.ts`、`renderer/src/components/{StressPanel,StressReportView,RunsHistory,WfDesigner}.vue`、`renderer/src/App.vue`、`renderer/src/i18n/{zh-CN,en}.json`；Create `renderer/src/components/StressLoadEditor.vue` 和 `StressTrendView.vue`（纯props/SVG，不引入图表库）。

**Tests:** 复用 `renderer/stores/{stress,run}.test.ts`；新 `renderer/components/stressWorkbench.test.ts`只覆盖新增计划/趋势/比较；仅调整既有components/testingCenter受影响用例的DTO，不重建相同旧测试。

**Interfaces:** 消费E实际项目/target/runId进度和F1配置/比较API；目标来自当前项目，不增加主页发送或跨项目选择。case入口和workflow入口均能打开同一工作台；report组件同时接受legacy/v2，不能强制把历史转v2。

- [x] RED：配置保存重开、阶段升/降编辑、到达率/HTTP RPS单位、初始化引用校验；仅一个项目时主页切回、场景未打开接口也可进入压测。切项目后迟到progress/result/stop不污染当前状态。
- [x] 圈定旧stop→新start的ABA：绑定root/project/target/runId及generation；运行中不可编辑已捕获计划；显示preparing/warmup/running/draining/stopping/finished，未真实收尾不显示终结。
- [x] 显示逻辑迭代/原请求失败/请求RPS、生成器饱和/漏发、实际桶宽/phase/drain、节点other与精度提示；legacy缺指标显示未采集。无结果和零基线不产生假绿。
- [x] 顶栏稳定；左侧计划/结果导航、右侧配置/报告各有有界滚动，长名字单行省略、图标动作hover不换行不改变尺寸。基线选择/清空与已有报告筛选互不覆盖。（实现/定向行为通过；原生几何仍由G验收）
- [x] GREEN：相关store与新增workbench文件一次，必要的既有入口组件文件；Desktop build覆盖TS/Vue和真实browser bundle，不用jsdom通过冒充原生布局验收。
- [x] 冻结F2→独立任务审核→停止，集中列G所需手验，不逐控件打断用户；不提交。

F2实际接口补记：plan调用必填捕获root和每次新UUID invocationId；host准备前realpath核根并立即发真实preparing，progress的root为canonical，sourceRoot为已核输入原串，target只含纯身份。UI完整核sourceRoot/项目/target/nonce/runId/generation，stop用匹配canonical根；memory仅adapter按本次捕获logical root映射临时实际根，不放宽生产host。新增`stressRunsList(scope)`/`stressRunsGet(scope,file)`只读经既有旁证/fullscope/hash核验的项目报告，返回既有summary/StressReportDTO；全局旧reader仍可读未证明legacy，工作台明示该边界。

F2验收补记（2026-10-23）：首候选44个不同定向用例按未变输入继承；首审I1–I3集中修复后最终6文件11项及Desktop真实build通过，原独审scoped复审Spec/Quality Approved，新增C0/I0/M0。44和11不累加为同次门禁；I1 RED首先仅乱序断言触发，运行中迟到由GREEN/静态保护核明。原M1 jsdom继承噪声留G，原生布局/HTML、动态别名、完整包门禁/新包及组合联验未验，不把F2任务验收当F6完成。

## Task 8（G）：最终审核、受控门禁和交付

**Files:** 本计划完成状态、`local/F6阶段验收与交付记录-<实际日期>.md`及本阶段ignored审计。必要修正由原开发集中处理，root不直接修产品。保留F5/F3/DEF-001和24h容量开放项。

- [x] root汇总12AC、所有任务审核/未覆盖边界，冻结包含tracked/untracked的精确最终增量；独立Sol xhigh做一次全阶段审核。发现统一交一个Sol high修复，随后只复审fix差异，不第二次重开宽审；真实未解承重项如实报告。
- [x] 受控门禁：品牌词表自检+全树；Core build→Core typecheck→CLI build→Desktop build；然后Core/CLI/Desktop完整测试**包间顺序、每包maxWorkers=2**。同输入已由任务跑绿的构建/单元组不在门禁外再重复一遍；失败后只复验实际修改影响，不叠加两套全量。
- [x] 真实组合夹具只用隔离合成项目和loopback：一个case、一份含分支/重试/recover的workflow，覆盖闭环、短arrival/stages、两VU、两worker、一次取消和基线比较。合并共享setup，不对每种控件/协议排列重复端到端；记录真实请求/迭代及停止后计数。
- [x] 新Windows dir包构建一次，核对producer/renderer/preload装配，运行现有smoke:dir；新增压力功能由新包实际入口验证，既有包不能当新实现证据。仅本阶段自有实例/回环服务可结束，真实项目不碰。
- [x] 用户一次集中手验：①计划保存重开和case/workflow入口；②运行/停止状态、趋势/阶段及分区滚动；③基线选择和HTML新增展示。工具能覆盖的先验；本地HTML工具限制如仍存在，明确请用户只验新增项，不重复旧搜索/复制全套。
- [x] 归档AC证据/确切命令与退出码/源码和包身份/未覆盖范围、24h长稳是否实际完成。只有12AC闭合才标F6功能阶段验收完成，不能写全部原需求/安全/发布门槛完成；提交、合并、推送等待新授权。

G最终验收（2026-10-23）：AC01–12按正式规格功能范围闭合，证据见阶段ignored账本acceptance及M/local/F6阶段验收与交付记录-2026-10-23.md。最终产品task-8-timeline-v1/838文件，经G-05/HTML/G-08/G-09定向与原独审后装配final-g09-838新包；用户批准显示隔离窗口后，真实原生run edc84ec2…在运行中观察到3/3→7/7→11/11，完成20/20/drop0，恢复开始/禁用停止、scope/hash与落盘相符。正式41请求/21原失败+6生命周期=47服务请求全部完成，自有服务已关闭。native-visible-proof退出码0；包/asar身份未变。Core/CLI原完整失败及test-only定向修复如实继承，Desktop1097全量、新候选品牌0命中及最终producer/原smoke均有原件，不改称一次全量全绿。用户HTML新增展示全部手验通过。动态别名/hover矩阵及legacy缺字段fixture动态覆盖未验的边界、旧O1/warnings保留；1000机器容量/整个Electron堆/24h发布证据未完成，B低优先级未实现、延期专项不恢复。此为F6功能阶段完成，不是全部原需求/安全/发布能力完成；未提交、合并或推送。

### G-08：按策略边界接入到达率方案A（2026-10-23用户批准）

此项是在G真实联验发现过期丢弃后的集中修正，不重做A–F2或全阶段宽审。B进入[低优先级需求池](../../backlog.md)的STRESS-LOW-001，当前不实现。

**Files:** Create `packages/core/src/stress/arrivalPolicy.ts`（有界槽决策/内部策略）；Modify `packages/core/src/stress/loadScheduler.ts`；内部每次运行策略依赖若需类型接线，仅修改 `packages/core/src/stress/execution.ts`；复用 `packages/core/tests/stress/loadScheduler.test.ts`。不扩公开schema/UI/CLI flags、通用插件注册器或B等待线程。

- [x] 先在原scheduler测试补最少真实行为RED：4次/秒的125ms槽在130ms唤醒仍启动且延迟5ms；跨多个槽只接当前槽/旧槽丢弃、同槽不重入；阶段/结束边界和无可用VU不补发。复用已有取消/限速/预热/预算断言，不做排列矩阵。
- [x] 内部策略按规格4.1的半开窗口给出消费游标/当前有效槽/下次唤醒边界；scheduler真实使用该策略，默认A，每次运行可装配，等待仍通过已有clock/sleep。保留单协调器/half-step积分/预算/门禁/真实startDelay，不改closed-VU语义、统计分母或5%资格规则。
- [x] GREEN只跑受影响原scheduler组及必要Core build/type；旧预期若明确绑定1ms规则，只按新批准语义更正，不删测试/加timeout。冻结精确新diff，原Sol xhigh独审，不重开全F6宽审。
- [x] 独审通过后，仅一次隔离loopback真实CLI arrival复验（沿原4次/秒、5秒、20计划槽、2VU/2worker组合），确认实际默认装配/启动延迟/丢弃与完整性。保留真实非零与原件，不反复重跑求绿；新fixture与旧证据隔离，单次低负载，不扩大压力。此后STOP交root安排其余G开放项/最终新包；不提交。

G-08结果：原15项保留，新增有界反例/守卫共5项，最终20/20及Core build/type通过；首审G08-I1小数段末根误差经fix1关闭，原Sol xhigh定向复审Spec/Quality Approved，新C0/I0/M0。产品冻结task-8-arrival-a-fix1/838文件审后verify PASS。唯一真实双worker运行fc12788b-84ec-460f-a4c6-c3973709fabe，4/s×5000ms，planned/started/completed/passed各20、drop0；实际启动率4/s、误差0%，启动延迟2.7882–10.8594ms按实保留。CLI exit0，三完整性与timeAligned/dataComplete均true。正式41请求/21原始HTTP失败仍在，另6生命周期请求，独立服务0→47全部完成/无overflow并已关闭。此为该低负载场景通过，不是所有负载/容量/24h或closed历史partial已修；F6其余G/12AC与最终新包仍开放。B仅STRESS-LOW-001，未实现，无Git集成。

### 统一命令口径

所有命令使用当前worktree已有固定Node22及pnpm，先将Node目录前置子进程PATH；JDK使用 `C:\Program Files\Java\jdk-21.0.12`。记录每次cwd/argv/stdout/stderr/exit，证据前缀唯一；不打印完整环境/凭据。

开发命令形式：`pnpm -C <package> exec vitest run <实际相关文件> --maxWorkers=2`。类型/构建按producer依赖做，不启动受旧dist影响的consumer测试。最终命令如下，顺序执行，遇错停止后定位：

开发阶段的文件参数固定如下；它们不是要求每个task额外跑一轮前后相同的测试。新增source行为后跑其组，已绿未变输入按源码指纹继承；`credentials/output`、旧入口组件等仅在对应实际接口/投影变化时加入。

| 任务 | `-C` 包路径 | `vitest run` 后的文件参数 |
| --- | --- | --- |
| A | packages/core | tests/stress/plan.test.ts tests/stress/aggregate.test.ts |
| B | packages/core | tests/stress/metrics.test.ts tests/stress/aggregate.test.ts；涉及投影时 tests/credentials/output.test.ts tests/stress/runner.test.ts |
| C | packages/core | tests/stress/loadScheduler.test.ts tests/stress/runner.test.ts tests/stress/caseSession.test.ts tests/runner/caseExecutor.test.ts |
| D | packages/core | tests/stress/workflowSession.test.ts tests/workflow/runner.test.ts tests/workflow/references.test.ts tests/workflow/adapter.test.ts；内核有diff时 tests/runner/caseExecutor.test.ts |
| E | packages/core | tests/stress/distributed.test.ts |
| E | packages/cli | tests/e2e.test.ts tests/stress-worker.test.ts tests/stress-subprocess.test.ts |
| E | apps/desktop | tests/main/ipc.test.ts tests/main/preload-contract.test.ts tests/main/runs.test.ts tests/renderer/api/memory.test.ts |
| F1 | packages/core | tests/stress/report.test.ts |
| F1 | apps/desktop | tests/main/stressPlans.test.ts tests/main/runs.test.ts tests/main/preload-contract.test.ts；IPC实际变化时 tests/main/ipc.test.ts |
| F2 | apps/desktop | tests/renderer/stores/stress.test.ts tests/renderer/stores/run.test.ts tests/renderer/components/stressWorkbench.test.ts；App入口变化时 tests/renderer/components/testingCenter.test.ts |

```powershell
node scripts/check-brand-neutral.mjs --self-check
node scripts/check-brand-neutral.mjs
pnpm -C packages/core build
pnpm -C packages/core typecheck
pnpm -C packages/cli build
pnpm -C apps/desktop build
pnpm -C packages/core test --maxWorkers=2
pnpm -C packages/cli test --maxWorkers=2
pnpm -C apps/desktop test --maxWorkers=2
```

未改admin/Java沿用已通过CI基线，不另起独立整套；Desktop原服务端集成仍保留且用JDK21。打包/冒烟只在最终交付候选执行；原根级full gate在确有跨域变更时再取代上述入口，不能两套全跑。

## 自查与执行交接

- [x] AC01–12分别映射C/D/B/C-E/C-D/C-E/B/B-F2/E/F1/F2/G；无把远程分布式或延期脚本项塞回计划。
- [x] 真实既有API名、快照对象归属、Cookie/client分离、无节点duration观察、原worker完成屏障均有责任任务；没有把虚构既有函数当消费前置。
- [x] case/workflow共用调度，v3由协调器分配总预算/门禁，旧报告分派与新producer严格校验、marker通路及失败事实不混淆。
- [x] 五个Review Focus各落到对应最小行为回归；仅为新职责新建小文件，不逐控件/排列加矩阵。
- [x] 新默认/上限和报告精度明示；24h实测与1000配置表达区别保留。规划不运行产品测试或压测、不装依赖、不做Git集成。
- [x] 用户审阅并确认本规格/整阶段计划，root按A→B→C→D→E→F1→F2→G连续调度开工。

开工前检查：核实当前baseline与实际worktree；若源码自规划后有变化，先对差异做小范围接口校准，不能照抄旧行号。memory装配已核实为 `apps/desktop/src/renderer/src/api/memory.ts`，不另建第二套实现。
