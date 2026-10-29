# F7c 单代理开发阶段压测整阶段实施计划

> **面向 AI 代理的工作者：** 开工后使用 subagent-driven-development（原协作配置）或经用户选择的 executing-plans 逐任务实现；步骤使用复选框记录实际证据。开发 GPT-6.1 Sol high、独立审核 GPT-6.1 Sol xhigh，临时 Sol max 另申请。本次只制定并归档，不启动执行代理或业务开发。

> **开工更新（2026-10-28）：** 用户目标为“完成 F7c”，现按本设计与 T1–T8 连续实施，采用已列建议默认值并保留配置入口；上文及下文“仅准备/未开工”是归档时的历史状态，不覆盖本更新。Git 提交、合并、推送及真实高负载运行未因此获准。实际完成以本计划 SDD 账本和逐项证据为准；F7b 三项遗留仍排在 F7g 后。

**目标：** 将现有 Core 的 HTTP 用例/工作流压测接入在线项目的本机与指定单代理执行，交付受控资源、真实统计、可读报告和可部署产物。

**架构：** 复用 F7b 快照、材料、权限、长轮询、启动许可、账本及归档。每个代理压测独占任务执行进程，内部直接运行 Core 或派生有界本机 worker；Java 不承担请求调度或指标算法。公共执行宿主固定整个目标/生命周期闭包，新增内容沿同一控制和输出安全边界传递。

**技术栈：** 现有 TypeScript/Vue/Pinia/Vitest、Node 22.19.0、pnpm 11.21.0、Electron 44.1.0、Spring Boot/JDK 21/H2、Docker；不升级依赖、不引入 MQ/Redis/新控制传输。

**规格：** [F7c 设计](../specs/2026-10-27-apicc-f7c-agent-stress-design.md)、[F7b 配置与协议](../specs/2026-10-26-apicc-f7b-execution-contract.md)、[页面展示规范](../../ui-presentation-guidelines.md)。执行者三份均须读取，设计中的默认值、边界和 AC 为本计划依据。

**状态：** 2026-10-27 准备完成，未开工。用户已批准阶段方向及本次文档归档；具体新增默认细则集中随开工确认，不冒称历史决定。源码基线 `e3d2066babcfab2d64077125fdd6bb343e48bbfe`，该 CI 通过由用户确认。文档位于现有隔离工作区 `C:/Users/imini/.codex/worktrees/contract-assets/apicc` 的 `codex/f7c-agent-stress`，保留原分支、stash 和所有证据。

## 全局约束

- 只接现有 HTTP 用例/HTTP 工作流及生命周期；常量 VU、常量到达率和分阶段负载沿用 Core，A 不变，不实现 B、跨代理压测、定时任务或长连接。
- Core、脚本/数据/环境/材料及运行兼容身份固定，不复制第二套执行、调度、统计、变量或认证内核。DEF-001 不恢复，不自动安装外部插件。
- F7b 的 EXECUTION-LOW-001、002、003 按 2026-10-28 用户决定统一排在 F7g 完成后处理，不纳入 F7c–F7g；详见[需求池](../../backlog.md)，本阶段不夹带遗留修复。
- 压测不进入共享调试 worker。`workerCount=1` 占一个独占执行进程；`N>1` 占一个协调器加 N 个 worker，不按请求或节点建进程。
- 资源预留、可配置参数及建议默认值逐项使用设计第3–4节；任务槽、进程数、VU、请求并发、RPS、数值预算、输入/结果缓存不能相互替代。
- Web 管基础设施/管理上限；客户端项目管计划、环境、认证和本次位置/参数。不自动上传个人仅本机材料，不自动换代理/环境或去认证发送。
- 已开始任务断线可按本地期限继续；重连/重启不得重放业务。确认全部后代退出才释放执行资源，报告 ACK 前缓存预算继续占用。
- 统一私有 marker union 后才公开富证据；屏障不完整则安全降级并说明。不得让内部原值进入进度、日志或错误。
- 页面默认摘要/表格/时间线，中英文、单位、毫秒时区、短指纹、局部滚动和不可用原因直接可读；原始数据默认折叠，不以 JSON 主视图交付。
- 有效行为 RED 在实现前。模块缺失、类型不通、错误夹具、服务未启动不记业务 RED；不删测试、不只加超时，不补造历史证据。
- 任务内定向验证，最终候选一次必要全门禁；不做全协议/全故障/全页面矩阵、24小时长稳或1000并发实验。真实高负载另经用户批准。
- 本轮不提交/合并/推送。将来开工后任务内以差异和证据检查点记录；Git 操作仍等届时用户授权，不套用上次 CI 修复的授权。

---

## 1. 工作包、文件与依赖

下表路径均相对仓库根；“新增”是未来交付物，不表示已存在。新增文件只承担列明责任，不顺便拆分全部旧模块。

| 任务 | 文件及责任 | 依赖 |
| --- | --- | --- |
| T1 Core 运行接缝 | 修改 `packages/core/src/stress/{plan,execution,metrics,workflowSession,caseSession,distributed}.ts`、`packages/core/src/report/evidence.ts`：预算、无脚本和运行设置；导出接入 `packages/core/src/{index,schema}.ts` | 无 |
| T2 协议、在线计划资产与配置 | 修改 `packages/core/src/{contract/workspace,storage/contractFiles}.ts` 和 `packages/execution/src/contract/{task,config,jobs,messages,runtime,index}.ts`；新增 `packages/execution/src/contract/stress.ts`：计划持久格式、配置、资源、进度/执行元数据；同步构建能力和 Java 输入 Schema | T1 |
| T3 共用压测宿主 | 新增 `packages/execution/src/host/{stress,nodeStressWorker}.ts`，修改 `packages/execution/src/host/{prepare,invoke,capabilities,index}.ts`；共用固定闭包和 Node IPC/时钟，CLI 仅替换宿主装配 | T1、T2 |
| T4 服务端控制 | 修改 `server/src/main/java/com/autumnharvestc/server/execution/{ExecutionProperties,ExecutionDtos,config/ExecutionConfigService,jobs/JobDtos,jobs/JobService,jobs/JobRepo,jobs/RunnerControlService,jobs/CoreInputValidator}.java`；新增 `server/src/main/java/com/autumnharvestc/server/execution/jobs/StressResourceReservations.java`，修改 `server/src/main/resources/schema.sql`：持久资源及类型化结果状态 | T2 |
| T5 代理执行 | 修改 `apps/runner-agent/src/{supervisor,slots,ledger,dispatch,taskChild,invocationContext,bootstrap}.ts`；新增 `apps/runner-agent/src/stressWorker.ts`：真实子树、租约、私有 IPC、进度、收束及补传 | T3、T4 |
| T6 在线项目入口 | 修改 `apps/desktop/src/{shared/online/execution,main/online/execution,renderer/src/stores/onlineExecution}.ts`、`apps/desktop/src/renderer/src/components/online/{OnlineProjectAssets,OnlineExecutionPanel}.vue`；新增 `apps/desktop/src/renderer/src/components/online/OnlineStressPanel.vue`：复用计划/报告组件 | T3、T4 |
| T7 管理与报告 | 修改 `apps/admin-web/src/{api/agents.ts,views/AgentsView.vue,views/ProjectAgentsView.vue,i18n/zh-CN.json,i18n/en.json}`、`apps/desktop/src/renderer/src/components/{StressReportView,StressTrendView}.vue` 和 `apps/desktop/src/renderer/src/i18n/{zh-CN,en}.json`、`packages/core/src/stress/{html,htmlDisplay}.ts`；新增 `packages/execution/src/contract/stressComparison.ts`：执行摘要/比较提示 | T2、T5、T6 |
| T8 集成与产物 | 扩展 `apps/runner-agent/tests/e2e-server.test.ts` 及既有隔离夹具；`Dockerfile.agent`、`scripts/smoke-runner-agent.mjs`、CI/Windows 门禁仅按新入口补接线；归档部署升级说明和证据 | T1–T7 |

CLI 适配涉及 `packages/cli/src/{stressPlanCommand,stressWorkerTransport,nodeStressClock}.ts`；保留 legacy 协议代码，只提取当前 Node clock/private channel。若新增 `@apicc/execution` 依赖，同时修改 CLI `package.json` 和 lockfile，并使独立 CLI test/build 的前置链包含 execution，避免只在整仓构建后可用。

T4 与 T3 可在 T2 冻结后独立推进；T6 可先接真实本机宿主，代理完整链等待 T5。T7 的字段和业务可读展示要在开发前确定，不等手验才补需求。阶段任务足够小以独立承载 RED/GREEN 和一次任务审核，不把每个脚手架/字段另拆任务。

## 2. 新增接口名称冻结

下列是实施时要声明的类型/接口，不是本轮产品代码。定义所在文件与任务一致；实现不得以不存在的模块作为测试失败证据。

```ts
// Core stress/execution.ts：第三参数可选，旧调用保留原默认语义。
export interface StressCompileOptions {
  limits?: { maxVus: number; maxRequestConcurrency: number; maxRps: number };
  evidenceLimits?: import("../report/evidence.js").EvidenceLimits;
  evidenceMaxSamples?: number;
  numericMemoryBytes?: number;
}
// compileStressPlan(snapshot, input, options?: StressCompileOptions): CompiledStressPlan

// execution/contract/stress.ts
export interface StressRunConfig {
  workerCount: number;
  confirmedTargetOrigins: string[];
}
export interface StressReservation {
  jobs: number; processes: number; vus: number;
  requestConcurrency: number; maxRps: number; metricMemoryBytes: number;
}
```

`StressRunConfigSchema`、`StressReservationSchema`、`StressExecutionMetadataSchema` 和 `StressProgressMessageSchema` 是对应 Zod 导出；字段、单位和验证见设计第4–5节。有效资源取值由 TS 准备/配置和 Java 权威上限重核，不能用客户端派生值作为授权依据。

`PreparedExecution` 增加可选的 `stressPlan: CompiledStressPlan`，但 prepared 仍由现有 owner/WeakSet 验证；`InvocationOutput` 增加 `{ kind: "stress"; result: StressReportV2 }`。定义/材料准备和实际启动分开，获取 start-permit 前不得开始 Core 生命周期或目标请求。

新增 `StressWorkerHost` 放在 execution `host/stress.ts`：只提供可信本机时钟/clock-domain 与 `spawnWorker(identity)`，worker 的输入是固定的私有配置。代理和本机宿主负责创建 channel、租约和退出监督；公共 `invokeExecution` 以可选 host 参数使用它，不导入 agent、CLI 命令或 Electron。

`StressExecutionComparison` 放在 execution `contract/stressComparison.ts`，包含 Core `StressComparison` 和执行元数据缺失/位置/代理/worker/构建/资源差异；最终可比性同时满足两层。Core HTML 接受可选类型化展示上下文而不导入 execution 类型、不接收任意 HTML。

## 3. 任务步骤

### T1：Core 可配置预算、无脚本及运行请求设置

**验证文件：** 复用 `packages/core/tests/stress/{plan,metrics,caseSession,workflowSession,distributed}.test.ts`；安全输出复用现有 `packages/core/tests/credentials/output.test.ts` 和 `packages/core/tests/report/reporters.test.ts` 中受影响夹具，不创建第二套报告夹具。

- [x] **1. 先有效 RED。** 在现有 `plan.test.ts` 的 `projectFixture/rawPlan` 上追加下列测试。先声明可选第三参数和类型使测试可运行，但不实现预算行为；旧编译器忽略配置时应在预算值断言失败，而不是编译报错。

```ts
it("uses the supplied numeric and report budgets in the real compiled plan", () => {
  const snapshot = createProjectSnapshot(projectFixture());
  const compiled = compileStressPlan(snapshot, StressPlanSchema.parse(rawPlan()), {
    numericMemoryBytes: 1048576,
    evidenceMaxSamples: 2,
    evidenceLimits: { bodyBytes: 1024, valueBytes: 256, caseBytes: 4096, reportBytes: 16384 },
  });
  expect(compiled.metricPlan.memory.maxNumericBytes).toBe(1048576);
  expect(compiled.metricPlan.evidence).toMatchObject({ maxSamples: 2, reportBytes: 16384 });
});
```

- [x] **2. 扩展真实行为 RED。** 用现有无脚本 HTTP 用例、真正 no-script registry 经 `createPreparedStressHost` 发送一次请求，确认旧强制引擎逻辑失败；另保留带脚本应前置拒绝/请求为零。用传输观察到的 `totalTimeoutMs` 验证运行设置到达用例、工作流和生命周期叶请求。夹具可先普通运行证明有效，不能把夹具缺失当功能 RED。
- [x] **3. 最小实现。** 可变预算从编译器贯穿 metricPlan、accumulator 验证、private evidence 和最终截样；校验合法范围/层级，保留统计版本、histogram 身份和跨 worker 一致性，不删除 `snapshot-invalid` 保护。no-script 只在实际无脚本闭包成立时生效，复用 CaseExecutor 既有可缺省引擎；运行设置逐层传递，不改变旧调用默认值。
- [x] **4. GREEN。** `pnpm -C packages/core test tests/stress/plan.test.ts tests/stress/metrics.test.ts tests/stress/caseSession.test.ts tests/stress/workflowSession.test.ts tests/stress/distributed.test.ts --maxWorkers=2`；输出路径有修改时加跑 credentials/output 和 report/reporters 两文件，随后 core build/typecheck。小预算真触发安全限制，缺失快照/重复合并/未知时钟的已有保护仍保留。
- [x] **5. 检查点。** 保存 RED/GREEN、实际请求设置和差异，任务审核只看本接缝；不宣称已接代理。

**T1实际记录（2026-10-28）：** Core接缝完成、独审规格/质量通过，C/I/M均无；169项Core定向及最后受影响149项、build/typecheck通过，完整日志和冻结差异在本计划SDD目录。private marker按较小报告预算拒绝的新分支专项断言为后补测试；用户明确接受如实记录、保留代码经独审后继续，不将该分支称为有效RED在先。允许的相邻plannedRunner/localWorker预算接线已入审核；未接代理、不代表F7c已完成，未提交。

### T2：协议、在线计划资产、资源模型与配置

**验证文件：** `packages/execution/tests/{contract,config}.test.ts`、Core `packages/core/tests/storage/contractFiles.test.ts`；生成器/schema 检查复用现有脚本。

- [x] **1. RED。** 在现有 `contract.test.ts` 添加有效 Core 计划，旧 `TaskTargetSchema` 应返回 success=false，与期望 true 不符；不是导入缺失。

```ts
it("accepts the existing Core stress plan as a dedicated target", () => {
  const plan = { formatVersion: 1,
    target: { kind: "workflow", workflowId: "flow" },
    load: { kind: "constant-vus", vus: 2 }, maxVus: 2,
    termination: { maxIterations: 4 } };
  expect(TaskTargetSchema.safeParse({ kind: "stress", plan }).success).toBe(true);
});
```

- [x] **2. 在线计划资产循环。** 先在现有真实文件编解码夹具增加一份有效 `SavedStressPlan`，观察旧严格项目 Schema 拒绝新增集合的行为；再实现可选 `stressPlans`、唯一id、完整保存/读取和空集合兼容。原本机 `.apicc/stress-plans` 不迁移；显式带入在线时只保存用户选择的计划。快照必须保留所选计划，其他项目内容 round trip 不变。
- [x] **3. 最小契约。** 增加 stress 目标及受限 run config、资源预留/元数据/累计进度 Schema；复用 `StressPlanSchema`，为 Java JSON 生成提供显式 wire metadata。stress 不允许共享 debug/session；环境冲突、无效 workerCount、超额资源、非法 origin、未知键都拒绝。配置默认值逐项采用设计第4节，旧配置补默认，上级约束不可扩大。
- [x] **4. 配置边界循环。** 在已有 config 测试里验证 node jobs=2/stress jobs=1、worker=2→processes=3、4→5、默认=1→1；节点总容量与单任务上限分别检查，显式超额拒绝，未填上限来源明确。新增验证先观察真实错误分支，再补该约束，不以源码包含字符串作为证据。
- [x] **5. 生成与 GREEN。** SDK/Core build → execution build/typecheck → `generate:java-input-schema` → `check:java-input-schema`；contract/config和Core storage/contractFiles定向测试。生成遇到未表示 refinement 必须处理真实公共 schema，不删除校验或输出 any。同步 `build-identity-sources.json` 的两项新能力。
- [x] **6. 检查点。** 归档字段、默认、来源、合法范围和序列化样例；普通三类目标/旧报告读取代表测试仍通过。仅协议可接受不等于可执行。

**T2实际记录（2026-10-28）：** 资产/协议/配置完成，独审规格与质量通过，C/I/M=0/0/0；execution定向136/136、Core定向70/70、构建/类型/Java Schema生成及漂移检查通过。冻结t2-candidate1，原始证据与审核在本计划SDD目录。准入上界不冒称Core最终限制，T3真实编译、T4/T5实际资源及T6确认绑定仍待执行；本轮未提交。

### T3：共用压测准备、调用与 Node worker 宿主

**验证文件：** 扩展 execution `projectFiles.test.ts`、`invoke.test.ts`，新增 `tests/stress.test.ts` 承载真实低负载 case/workflow/worker 组合；复用 CLI `stress-subprocess.test.ts` 的实际进程证据，不复制全部故障矩阵。

- [x] **1. RED。** 在现有 projectFiles 夹具中选一个真实 case，通过现有 `prepareProjectFiles` 提交 T2 已支持的 stress 目标。期望得到一项选择和 `task:stress`；旧 host 分支不能正确准备此目标，应观察业务准备失败。

```ts
const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
const collection = project.collections[0]!;
const api = collection.apis[0]!;
const target = { kind: "stress" as const, plan: StressPlanSchema.parse({ formatVersion: 1,
  target: { kind: "case", collectionId: collection.id, apiId: api.contract.id, caseId: api.cases[0]!.id },
  load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }) };
const value = await prepareProjectFiles(onlineAssets(project), { target, profile: "trusted-core-script" });
expect(value.prepared.selections).toHaveLength(1);
expect(value.prepared.requiredCapabilities).toContain("task:stress");
```

- [x] **2. 最小准备实现。** 将压力目标及全部生命周期编译为 `CompiledStressPlan`；从其请求/工作流闭包复用脚本源映射、材料选择和 identity，包含 v1 条件、子流程和 handlers；不要只扫描 `targets.requests` 而漏掉条件脚本。材料仍通过原 snapshot 对象绑定，运行配置/预算及目标确认进入 inputs digest。
- [x] **3. 真实调用循环。** `invokeExecution` 按 kind 调共用 stress host，使用相同 registry/profile、凭据/网络/数据；拒绝 unknown prepared。结果保留 `StressReportV2`，不走 reportingUnits 的普通用例逻辑；错误路径保留实际 started/not-started 和安全部分事实。
- [x] **4. 提取宿主。** `nodeStressWorker.ts` 迁入 CLI 实际 native clock 与真实 IPC channel 的可信绑定；调用方注入 child args、固定配置和退出监督。CLI 保留命令和 legacy 逻辑，agent 不通过 CLI 命令行重读 workspace。测试单/双 worker 的真实请求计数、数据/Cookie 隔离和私有 marker 重投影；不比较不可重复的真实耗时数值。
- [x] **5. GREEN / 检查点。** execution projectFiles/invoke/stress、CLI stress-subprocess 定向测试及相应 build/typecheck；确认 stdout 不作富证据通路、错误不携带标记。任务审核后冻结 host 接口供 T5/T6 使用。

**T3实际记录（2026-10-28）：** 共用宿主、CLI适配、最终编译binding和Core只读累计进度完成。首轮独审发现远端VU初始化已执行但发布失败时started错误；确定性真实HTTP503先RED后修，定向复审闭合，C/I/M=0/0/0。execution165项+owner1项、Core91项+reader1项、CLI两项原候选通过；修复后host27项/CLI代表1项及build/typecheck通过，残留0。冻结t3-candidate2及生成接缝候选，原始证据在SDD目录。T4/T5权威预留/来源/permit和T6/T8 Electron装配继续，未提交。

### T4：Java 权威资源、任务状态与报告

**验证文件：** 扩展 `ExecutionConfigTest`、`ExecutionJobsApiTest`、`RunnerControlTest`，新增 `StressResourceReservationsTest`。HTTP MockMvc/H2 复用 JobsFixture，不以 mock 的 reserve 被调用作为成功依据。

- [x] **1. 配置正负例 RED。** 在 `ExecutionJobsApiTest` 的有效 fixture 上提交节点参数；新契约字段合法、旧服务不支持时应观察期望200/实际400。随后测试字段版本冲突和错误关系拒绝，完成 Java/TS 默认对齐，再进入资源语义 RED，不把前置配置失败当作资源测试已覆盖。

```java
@Test void savesStressCapacitySeparatelyFromOrdinaryTaskCapacity() throws Exception {
    var f = fixture();
    member(f, patch("/api/v1/agents/"+f.agent()), Map.of(
        "expectedVersion", "0", "config", Map.of(
            "maxConcurrentJobs", 2, "maxConcurrentStressJobs", 1,
            "maxStressProcesses", 3)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.config.maxConcurrentJobs").value(2))
        .andExpect(jsonPath("$.config.maxStressProcesses").value(3));
}
```

- [x] **2. 资源有效 RED。** 准备两个合法任务和具备新能力的 runtime，先证明单任务领取/普通调试通过；再通过真实 heartbeat 竞争领取：总3个进程预算下，两项各worker=2的压测只能一项 preparing。控制取消、后代未释放、完成 ACK、降额和第二任务准入，直接断言数据库占用及实际返回 deliveries；无随机等待。
- [x] **3. 最小实现。** `execution_stress_reservations` 以 job/agent 关联持久预留向量；在既有锁顺序/短事务内领取和释放，与普通任务槽/输入/结果预算一并核验，重复消息不重复预留。启动时重核新限制，沿 start-rejected 持久收束；重启不把旧占用清空。项目删除/清理按原事务边界处理新记录，不能造成删除约束回归。
- [x] **4. 结果与能力。** Java 注册允许明确新能力，Core输入结构使用生成的 schema；不编译工作流/重算时延。累计 stressProgress 有身份/单调序列/大小限制，状态列表不读 BLOB。报告保留原 hash/长度/幂等归档和明确类型，权限仍由真实服务端实体 ID 判断。
- [x] **5. GREEN / 检查点。** `server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml -Dtest=ExecutionConfigTest,ExecutionJobsApiTest,RunnerControlTest,StressResourceReservationsTest test`。同一资源夹具重启服务上下文后核对预留；无须再增加一个完整跨端后端。任务独审只针对新控制路径。

T4执行回执（2026-10-28）：Java四服务115/115；execution定向154/154及最后契约42/42、typecheck/schema无drift；实际Node三份固定inputs和24数字向量一致。独审I1经有效RED修复并定向复审闭合，I2经真实HTTP/Controller前置校验由原审查者撤回；M1等待原因陈旧、M2既有工具链告警留最终宽审。两处顺序偏差已获用户明确接受且如实保留，不倒称原始RED。未提交/合并/推送；冻结t4-candidate2及t4-adjacent-candidate1，不代表T5–T8完成。

### T5：代理专属压测进程树与补传

完成凭据：未提交检查点 t5-candidate2 / t5-java-candidate1 / t5-schema-candidate1；任务独审后 R1 三项 Important 均经定向复审 ADDRESSED，无新 C/I。最后受影响 14/14、类型/构建及真实 OS 退出证据归档于本阶段 SDD task-5-report.md / task-5-rereview.md；两项 Minor 留最终宽审，Linux 实机和同场 Java+agent 联验仍由 T8 验证，不外推为已完成。

**验证文件：** 扩展 agent `supervisor.test.ts`、`recovery.test.ts`、`fixture-cleanup.test.ts`，新增 `stress.test.ts`。使用现有真实 child/目标服务器、丢 ACK 和退出夹具。

- [x] **1. 有效 RED。** T3宿主/T4控制已有正例后，从 Supervisor 收到合法 stress delivery，通过原启动许可路径运行；旧子进程没有 stress worker 装配时，多 worker 行为应失败。明确观察缺的是 worker 执行，不是 HTTP 服务/镜像/模块没启动。
- [x] **2. 资源 RED→GREEN。** 在 `slots.ts` 增加 stress reservation，普通 reserve 调用兼容。先用现有类真实 reserve/dispatch/release 测“3进程总额下第二项2-worker任务不能预留”，再实现。所有预留先于 fork；pending report 仍按原独立预算占用，不因进程退出自动删除。
- [x] **3. 子树实现。** taskChild 对 stress 注入 T3宿主，worker=1不额外 fork，N>1只建N个worker；每个worker执行前验证固定输入/构建，继承任务 scope/租约/epoch。固定材料通过私有IPC，不传后台登录令牌；新进程名称/ID/PID和退出结果入本次资源账本。
- [x] **4. 关键真实断言。** 对实际低负载目标记录请求：4个迭代结束后计数固定；取消/一个worker异常后所有后代确认退出、目标请求计数不再增长，相邻 debug 能继续。下列是所需不变量，不是用“promise resolve”代替 OS 退出：

```ts
// 在双worker代表夹具中采集真实waitForExit和目标计数，包含协调器。
expect(exitRecords).toHaveLength(3);
expect(exitRecords.every(record => record.exited && !record.stillAlive)).toBe(true);
expect(reservedStressProcesses).toBe(0);
expect(targetRequestsBeforeRecovery).toBeGreaterThan(0);
expect(targetRequestsAfterRecovery).toBe(targetRequestsBeforeRecovery);
```

该代码块的 `exitRecords/reservedStressProcesses/targetRequests*` 是夹具必须记录的结果字段，新增夹具时定义在测试工具中，不向生产类添加仅测试使用的查询 API。

- [x] **5. 补传和私有屏障。** 沿 recovery 既有丢ACK入口证明再次上传相同 hash/字节，目标不重执；多worker成功/故障均验证联合 marker 输出规则。progress按配置发布累计值；worker故障有明确不完整/中断结论，不能把旧 reportingUnits 默认零失败当压测 passed。
- [x] **6. GREEN / 检查点。** agent stress/supervisor/recovery/cleanup 定向测试、agent build/typecheck；确认实际 PID 归属及无残留后独审。不以全代理重启完成普通取消。

### T6：客户端在线项目内的压测入口

**验证文件：** 扩展 desktop `tests/main/online/execution.test.ts`、`tests/renderer/stores/onlineExecution.test.ts`、`tests/renderer/components/stressWorkbench.test.ts`，新增 `OnlineStressPanel.test.ts`（同 components 目录）。

- [x] **1. RED。** 在既有 online store 环境/位置测试里，先加入 stress 目标和本次确认的状态行为；挂真实 OnlineStressPanel 后检查可见的计划/位置/环境/运行与停止，而非 stub 是否被挂载。新文件骨架只保证可导入，不先实现目标交互。
- [x] **2. 现有不变量保留。** 复用该文件的 `context` 和 `createOnlineExecutionStore`，环境不得随代理选择变动：

```ts
const store = createOnlineExecutionStore({ onlineExecution: async () => [] });
store.activate(context);
store.environmentId = "00000000-0000-4000-8000-000000000019";
store.selectLocation({ kind: "agent", agentId: "5" });
expect(store.environmentId).toBe("00000000-0000-4000-8000-000000000019");
```

这条原行为已存在时记回归 GREEN，不伪造 RED。新增 RED 是执行位置改变后旧的 origin 确认必须失效，以及不支持 stress 的代理明确不可运行。

- [x] **3. 最小入口。** 在线项目复用已保存计划模型/StressLoadEditor；计划保存使用 assets expectedVersion，不覆盖冲突版本，不执行未保存旧内容。环境与plan一致；位置切换重做确认，loopback含义可见；仅本机材料在代理运行前拒绝。
- [x] **4. 宿主与上下文。** 本机运行用T3真实宿主及实际 Electron/Node装配；代理提交固定 inputs。账户/项目/run身份隔离、迟到结果过滤、停止只作用所选任务；关闭本机不假称转交后台，重开代理任务只查询历史不重新run。
- [x] **5. GREEN / 检查点。** main online执行、online store、OnlineStressPanel及既有stressWorkbench定向测试；desktop typecheck/typecheck:vue/build和renderer Node隔离测试。集中原生验收留T8，不以DOM通过外推打包窗口可用。

T6 回执（2026-10-28）：任务内原定向67项、进度/隔离25项、相邻session选定2项及desktop完整构建通过；R1只补跑受影响两文件25项及vue类型检查，不累加为一次全量。独审I1确认所有权/I2停止所选身份经真实RED后修复，定向复审全部ADDRESSED、新C/I/M=0/0/0，冻结`t6-candidate2` 307源hash匹配。单条worker-policy先实现后补测偏差已由用户独立接受、后补仅记回归；大chunk告警留最终宽审，实际Electron/Linux及视觉/匹配制品仍是T8，不据Node/DOM外推已验。未做Git集成。

### T7：可读管理、报告、基线和 HTML

**验证文件：** 复用 admin `tests/views/{AgentsView,ProjectAgentsView}.test.ts`、desktop stressWorkbench/新增OnlineStressPanel，Core `tests/stress/report.test.ts` 和 execution新增 `tests/stressComparison.test.ts`。

- [x] **1. RED。** 页面先断言真实标签、单位和有效来源；报告先给一份“逻辑通过但请求有失败/完整性不足”的有效结果，断言四类结论同时可读。不能只检查 metadata 属性或 `.json` 字符串存在。
- [x] **2. 最小展示。** 管理台复用当前表单/权限，新增设计第4节参数、单位/继承/保存与应用版本；客户端用既有 StressReportView 和趋势组件显示业务摘要。原始数据折叠，长名称不挤表头，时间到毫秒含时区、指纹短显可查，未采集/不适用分别说明。
- [x] **3. 比较行为。** Core六项指标公式保留；执行元数据不同/缺失不能标直接可比，仍显示数值差异与原因。使用同一份真实报告作为base/candidate但改变位置，先确认旧UI缺少这项原因，再实现外层比较。保留以下既有边界回归，不把已有行为说成新增修复：

```ts
const comparison = compareStressReports(baseReport, candidateReport);
expect(comparison.metrics.dropped.relative).toBeNull(); // 两份有效夹具的 dropped 均为0
expect(comparison.notices).toContain("environment-definition-not-compared");
```

`baseReport/candidateReport` 使用 `report.test.ts` 既有有效V2夹具，执行元数据在外层单独构造；不是向严格 Core report 中塞任意字段。

- [x] **4. HTML。** `renderStressHtml` 增加可选的类型化执行摘要/比较展示参数，不收任意HTML，不引入execution依赖循环。复用F6中文/English、目录/搜索/表格/原始折叠结构；导出的是同一安全报告。英文固定标签/单位及0/1桶说明定向核对。
- [x] **5. GREEN / 检查点。** 上述定向测试与admin/desktop相关类型构建；真实HTTP管理台自动观察新增参数和角色边界，集中离线HTML/原生手验只留工具不能完成的部分。任务审核含实际可见内容，不用构建代替页面证据。

T7已完成任务审核与R1定向复审（I1/I2/I3均已解决，新增C/I/M 0/0/0）。证据见本计划SDD目录task-7-report/review/rereview及两份真实浏览器观察；候选t7-candidate2 632源hash通过。最终定向为Core5/5、execution10/10、admin12/12、desktop30/30，普通投影8/8沿未变路径；不累计中间重复。管理台及合成HTML真实中英/布局已验，desktop原生新包、真实生命周期输出、Linux代理与最终门禁仍属T8，未提前打勾；两项Minor告警交最终宽审，未Git集成。

### T8：集中联验、最终门禁和交付

**文件：** 复用 runner `e2e-server.test.ts`/清理夹具、桌面在线 Electron probe、`scripts/smoke-runner-agent.mjs`；扩展已有 `docs/runner-agent.md`、`docs/deploy.md` 记录本阶段升级/容量/停止说明，不新建另一套部署文档。文档只在实际实现后填写证据，不在准备期打勾。

- [x] **1. 冻结候选。** 核对源SHA/差异、生成契约、CoreBuild/scriptApi和Node/V8身份。只按生成结果更新需要变化的受控基线，TS与Java同步；未知身份仍拒绝，不能用任意scriptApi登记来省验。复用LF/CRLF真实Git检出测试，不改哈希算法或全局Git配置。
- [x] **2. 一个合成闭环。** 复用一套隔离Java服务、HTTP目标及Linux代理，Windows客户端使用同一项目/计划。单worker和双worker各一个低负载代表，case与带生命周期/恢复的workflow各覆盖其真实语义；三负载的精细边界由Core定向测试承担，不做所有平台×模式矩阵。
- [x] **3. 受控故障集中。** 沿现有夹具完成资源竞争/降额、取消/worker退出和一次控制丢ACK补传；记录目标总请求不重复、后代退出及残留资源检查。客户端关窗后代理继续、重开查历史，不创建新任务。只有新增无法自动验证的原生动作交用户一次集中手验。
- [x] **4. 页面集中验收。** 新候选实际中英文：有效值/来源/进程数、排队与归档状态、逻辑与请求总体、完整性/失败原因、趋势/节点/生命周期、六项基线差异；导出HTML默认中文、English可切、常驻导航/搜索可用，富详情无未脱敏标记。保留截图和输出身份，不用旧包验收新代码。
- [x] **5. 独立整阶段审核一次。** 按AC01–14和实际变更做一次宽审；必要修正先有效复现，只定向复审改动，不扩大第二轮无关修复。Critical/Important闭合，Minor明确记录且不得冒称已修。
- [x] **6. 最终必要门禁。** 见下节；只有最终源码变更影响已验证路径时补跑对应范围，不因文档记录或merge同树重复所有包。任何失败原样保存，不能把分段绿冒称整次脚本exit0。
- [x] **7. 交付。** 新桌面目录包及真实启动、正式Dockerfile.agent/服务镜像和部署冒烟；固定源与产物SHA、构建/能力/配置身份、命令版本/退出码、AC矩阵与实际资源清理。升级要求配套版本和旧任务先排空；保留旧报告/账本/回退说明，不承诺旧代理热混用。

T8最终回执（2026-10-28）：限定范围AC01–14已逐项闭合，证据在本计划SDD目录`completion-audit.md`、`task-8-report.md`。唯一全阶段宽审及定向修复已完成；首次复审新增归档/缓存两项另经用户明确授权修复和独审，最后两条ADDRESSED、新C/I/M0/0/0。Java4完整类136/136、Panel27/27、正式制品/部署及真实bounded/recovered单项E2E均真0；此前普通Maven360、空格目录单项、品牌及未变构建路径具名保留。两次全Node命令原exit1未改写，之后按影响范围补验，不声称第三次全仓单命令通过。

最终制品候选`final-two-fixes-candidate1`1052路径，CoreBuild `6e7e042dc1dcbf9fb03b299a47f418b999cc4b77fc2e54f7c64d0114135ebb5f`、scriptApi `afaf628a48532cff1e1e9264f328830ea1678b877853e324bab040039d0721d0`；新目录包142文件、普通jar、新服务镜像及复用正式agent都已核hash和实际启动。实际原生运行中退出后代理继续29HTTP，同profile重开只查原历史；真实GUI下载HTML及中英浏览器可读。最后有界短场仅新增一个40迭代/1RPS任务，补齐环境选择、旧报告未采集/六指标中英、真实1/0排空；降额期间28HTTP继续，最终归档/资源归零。报告、SQLite及OS事实冷态审计真0。

所有合成运行资源已停止，原历史DB不变，证据/配置/账本保留。最后场外层句柄中断、原外层exit未知，独立cleanup recovery真0保存账本后精确移除自建已停容器/卷；不伪报该外层成功。浏览器临时tab7显式关闭未确认，但对应服务已停止。没有产品改动后未重制却沿用旧包；最后只更新本计划、设计、路线图三份状态文档并另存交付快照。开发和验收完成不授权Git集成，本轮未stage/commit/merge/push，main未改；F7b三项仍排F7g后，体积/既有工具告警保留，无性能/长稳承诺。

## 4. 门禁与成本控制

准备期不安装依赖、不跑产品测试、不启动Docker/服务或压测。开工时只检查所需工具并在当前子进程使用固定Node/pnpm/JDK，不更改全局环境。根目录没有package.json，不运行根npm命令。

```powershell
# 以下为执行期命令，不代表准备期已运行。
pnpm -C packages/plugin-sdk build
pnpm -C packages/plugin-sdk typecheck
pnpm -C packages/core build
pnpm -C packages/core typecheck
pnpm -C packages/execution build
pnpm -C packages/execution typecheck
pnpm -C packages/execution check:java-input-schema
pnpm -C apps/runner-agent build
pnpm -C apps/runner-agent typecheck
pnpm -C apps/desktop build
pnpm -C apps/admin-web build
pnpm -C packages/cli build
pnpm -C packages/cli typecheck
docker build -f Dockerfile.agent -t apicc-f7c-agent:candidate .
$env:APICC_RUNNER_E2E_IMAGE='apicc-f7c-agent:candidate'
pnpm -r --workspace-concurrency=1 test --maxWorkers=2
./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml test
node scripts/check-brand-neutral.mjs --self-check
node --test scripts/tests/check-brand-neutral.test.mjs
node scripts/check-brand-neutral.mjs --include-untracked
pnpm -C apps/desktop gen:icon
pnpm -C apps/desktop dist:dir
pnpm -C apps/desktop smoke:dir
```

普通Maven全量不得带 `-Dapicc.build.directory`，用于覆盖CI78入口；同一候选另在带空格的唯一自定义目录仅跑 `MavenBuildDirectoryTest`，验证隔离输出仍有效。该目录用平台临时目录/已忽略local建立且限定清理，不使用共享target替代并发E2E的唯一JAR根。

需要私有CA的代理正式HTTPS联验保持验证开启；其余管理页面优先HTTP自验，避免让用户重复处理无关证书。实际TLS错误测试必须使用对应隔离CA，不向系统全局安装信任。

最后按正式Docker构建控制服务/代理并执行 `node scripts/smoke-runner-agent.mjs` 的必要部署检查；CI变更只补新产物/能力/测试接线，保留原Java、品牌、Windows打包和部署job。若因宿主缺少实际Electron/容器环境而跳过，记录覆盖缺口，不将其算通过。

开发单任务不反复跑上述整套；不重复已完成F7b的全套故障矩阵。所有实测PID/容器/卷有唯一归属，停止后确认退出，保留合成账本/日志；不操作用户真实项目、旧客户端或无关资源。

## 5. AC覆盖、自检与执行交接

AC01–14映射见设计第8节，T1–T8均有对应可独立验证交付物。最终证据至少含：有效RED/夹具修正区分、GREEN命令/工具/cwd/退出码、固定输入与身份、请求次数/进程树/资源占用、私有屏障、页面实际内容、产物hash和开放项。

本轮自检检查：设计各节映射任务；配置字段/默认/单位与实现位置一致；workerCount与processUnits含义一致；新增类型/接口定义位置明确；现有/新增文件区分；相对链接/文件路径可核；历史CI/验收不冒称F7c通过。不为文档新增产品测试。

**交接状态：** 文档准备完毕，不自动开工。用户审阅整阶段设计/默认细则后，可选择沿既定子代理驱动方式（Sol high开发/Sol xhigh独审）执行，或改为当前会话内联执行。阶段开工确认后，普通task内修正连续推进，不逐task反复申请同一设计；实质范围变化、缺失外部材料或新增权限再集中提出。
