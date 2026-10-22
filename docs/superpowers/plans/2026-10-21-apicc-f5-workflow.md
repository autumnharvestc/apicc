# F5 强编排实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框跟踪进度。用户已集中确认“完成F5任务”，现正式实施；勾选必须有真实证据，Git集成仍另需授权。

**目标：** 在当前项目内交付可编辑、可持久化、可诊断的本地强编排，桌面/CLI/套件的最终结论一致。

**架构：** 基于既有 WorkflowRunner/CollectionRunner 增加结构化节点、固定闭包计划、隔离 invocation frame 和共享叶子许可池。不引入外部引擎或第二套请求执行器；并行块内置 AND/OR，子场景/循环体/处理器复用项目已有 workflow。真实执行事实与最终逻辑结论分开投影。

**技术栈：** 现有 TypeScript、Zod、Vue/Pinia、Vue Flow、tough-cookie、Vitest、Electron；不新增依赖，不改版本。

**规格：** `docs/superpowers/specs/2026-10-21-apicc-f5-workflow-design.md`，全文及18项验收是唯一阶段规格。

## 全局约束与基线

- 基线 `e77c98d0d6f95c116487782d9af987143d5232d1`，CI71通过。工作树 `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，分支 `codex/f5-workflow-design`；main/stash/旧工作树/旧证据保持。
- 用户确认整阶段后才执行。开发 GPT-6.1 Sol high，独立审核 GPT-6.1 Sol xhigh；不能自行升 max。普通任务连续执行，不逐 task 请求用户批准；提交、合并、推送另需授权。
- DEF-001无限期延期。F6场景压测/新负载模型、F7在线/SDK、断点和历史内存快照重放不在本计划；普通输入检查、脱敏、取消、资源释放保持。
- executionVersion=2 的明确新语义不得覆盖 v1 的既有行为；新字段 strict，未知版本拒绝。原任意脚本能力不扩权、旧condition字符串不转译。
- 默认并发4、上限32；root默认300000ms、上限3600000ms；调用深度8；root最大节点访问/尝试10000；loop默认maxIterations100、上限10000；request最大attempts5、退避封顶30000ms；cleanup默认5000ms、上限30000ms。
- 真实行不造假；旧 executeCase 发送前失败不冒称已发送HTTP。新逻辑报告模式要明确标识，不把失败attempt改绿，不用 raw failed 覆盖已明确恢复的最终 verdict。
- 输出仍先完整脱敏再截断：值4KiB、正文64KiB、case256KiB、整次16MiB，轨迹最多20000事件并明示截断。标记不进入公开DTO。迭代/行内部0起始，界面1起始；attempt1起始。
- 不增timeout、不删失败断言、不skip求绿；不按AC逐建测试文件。复用现有测试，新增测试文件只为新职责：`workflow/predicate.test.ts` 与 `workflow/scheduler.test.ts`，不建立新的通用测试框架。
- 文档准备不安装依赖、不跑产品构建/测试。基线证据复用CI71；实现后按受影响面验证。Node22、pnpm11.21、JDK21根目录 `C:/Program Files/Java/jdk-21.0.12`。

## 文件职责图

| 边界 | 新建文件 | 修改的主要已有文件 |
| --- | --- | --- |
| 契约/闭包 | `packages/core/src/workflow/plan.ts` | workflow/model、validate、references、impact；assets/snapshot、clone、context、graph；schema.ts、index.ts、shared.ts（按现有导出分工） |
| 声明式值/frame | `workflow/predicate.ts`、`workflow/scope.ts`（均位于core/src） | workflow/runner；runner/runner的runtimeBridge接点；testing/extraction |
| 调度/尝试 | `workflow/scheduler.ts`、`workflow/policy.ts`、`workflow/trace.ts`（均位于core/src） | workflow/runner；http/session |
| 报告/入口 | Desktop `main/workflow.ts`（拥有工作流运行表和取消） | core report/types、units、evidence、junit、html、workflow/adapter、testing/selection、suiteRunner；CLI main；Desktop main/ipc、session、testing、shared/types、channels、ipc-contract、testing、preload/preload |
| 编辑与轨迹 | Desktop renderer `components/WfControlFields.vue` | WfDesigner、WfNode、WfPropertyPanel、WfResultDrawer、wf/wfCanvas、stores/workflowDesign、api/memory、i18n/en.json、zh-CN.json |

上表省略后缀的已有文件均为 `.ts`；精确测试及改动子集按下列任务列出，不强迫为没有真实需要的路径制造diff。新模块按职责拆开，不通盘拆分CLI main、Desktop session或重建执行平台。

## 共用接口约定

由A1定义并导出，后续任务不自行发明第二套名称：

```ts
type WorkflowValue =
  | { kind: "literal"; value: import("../contract/schemaNode.js").JsonValue }
  | { kind: "ref"; source: "inputs" | "vars" | "env" | "previous" | "error" | "loop"; path: Array<string | number> };
type WorkflowPredicate =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; left: WorkflowValue; right: WorkflowValue }
  | { op: "exists" | "notExists"; value: WorkflowValue }
  | { op: "and" | "or"; items: WorkflowPredicate[] }
  | { op: "not"; item: WorkflowPredicate };
```

以上类型定义放在 `workflow/model.ts`。`WorkflowPredicateSchema` 限深度32/总节点256，and/or至少一个item，ref path最多64段；配置解析和求值器同口径，不能用无界递归求值器替代。Workflow输入定义、子调用输入值映射和输出映射采用规格第3.3节的准确字段与冲突规则。

- `compileWorkflowPlan(snapshot, workflowId, {environmentId?,allowDraft?,strict?})` 返回 `CompiledWorkflowPlan`，含 projectId、definitionRevision、rootWorkflowId、workflowIds、唯一物理请求 selections、结构化调用闭包和 conservativeExecutions 上界描述。计划是只读、只属于该 snapshot。
- `workflowPlanRequests(snapshot, plan)` 返回既有 `CredentialRequestSelection[]`，在 plan revision 不同/所选请求不匹配时拒绝；用于所有宿主准备，不能重复写递归扫描。
- `evaluateWorkflowPredicate(predicate, context)` 返回既有三态 matched/pruned/error，context 含 inputs/vars/env/previous/error/loop 的只读JSON视图；不存在的ref使用显式缺值，不转换成null。
- `createWorkflowScheduler({maxConcurrency,signal?})` 返回 `runLeaf<T>(task,signal?)` 和 `drain()`；只负责许可/等待/取消，节点语义留 runner/policy，容器不能持有叶子许可等待子节点。
- frame 由 `createWorkflowScope` 创建，提供 fork、stage、commitOutputs；定义变量和提取的显式删除标记，禁止以 Object.assign 假冒完整状态合并。原 request runtimeBridge string 转换仅在接点进行。
- trace 身份结构由 `workflow/trace.ts` 定义：root/child invocationId、parentInvocationId、invocationPath、nodeVisitId、attempt。与 `EvidenceIdentity` 同源，不给每个宿主再定义一种路径编码。

## Task 1：A1 — 契约、固定闭包和引用纪律

**交付：** 可保存/读取新模型，有唯一预检及请求闭包接口；尚未实现的新节点运行时明确拒绝，不能临时用noop执行。

**主要文件：** core `workflow/{model,plan,validate,references,impact}.ts`，`assets/{snapshot,clone,graph,context}.ts`，schema/index/shared导出；Desktop `main/session.ts`、`shared/ipc-contract.ts`。

**复用测试：** core `tests/workflow/{model,validate,references,impact}.test.ts`、`tests/assets/{snapshot,clone}.test.ts`、`tests/storage/contractFiles.test.ts`；Desktop `tests/main/session-transactions.test.ts`、`tests/main/contract-ipc.test.ts`、`tests/main/contract-ipc-types.test-d.ts` 中实际受影响文件。

- [x] RED：在现有model/validate文件加入executionVersion2及新节点往返、未知字段/未知版本、同项目间接递归和闭包缺引用。最小model例：

```ts
const value = WorkflowSchema.parse({ id: "flow", name: "flow", executionVersion: 2,
  nodes: [{ id: "wait", kind: "delay", delayMs: 0 }], edges: [] });
expect(value.executionVersion).toBe(2);
expect(() => WorkflowSchema.parse({ ...value, executionVersion: 99 })).toThrow();
```

- [x] 在 `packages/core` cwd 用固定Node执行现有Vitest，确认新增断言真实失败而非宿主加载错误：`node node_modules/vitest/vitest.mjs run tests/workflow/model.test.ts tests/workflow/validate.test.ts --maxWorkers=2`。
- [x] 实现strict节点/策略/输入输出schema、v1/v2分派、compileWorkflowPlan和workflowPlanRequests。递归扫描含parallel/loop/handler，调用图判环不误拒绝共享子流程。检查v2单入口和条件端口，不放开图环。
- [x] 接入快照正规化、保存/克隆、删除影响和IPC schema parity。克隆重写结构身份但不改literal字符串；所有union消费者按kind缩窄，不改成任意对象宽松校验。
- [x] GREEN：只跑上述受影响文件，Core类型及Desktop契约类型按producer顺序检查。输出本任务来源、diff和AC01/02/17证据；交独立规格/质量审核，不自动commit。

## Task 2：A2 — 声明式值、基础节点与frame/身份骨架

**交付：** assign/delay/assert/condition可运行；request保留F4内核；执行身份可被后续复用。

**文件：** 新建core `workflow/{predicate,scope,trace}.ts`，修改workflow/runner、runner/runner的桥接点及必要testing/extraction；新增 `tests/workflow/predicate.test.ts`，复用workflow/runner、adapter及contract/consumerIntegration测试。

- [x] RED：新增无脚本引擎的条件求值单测，missing与null分开、类型不符返回error、and/or短路；现有runner测试增加原子assign、delay取消、assert非HTTP故障。

```ts
const context = { inputs: {}, vars: { value: null }, env: {}, previous: {}, error: {}, loop: {} };
expect(evaluateWorkflowPredicate({ op: "exists", value: { kind: "ref", source: "vars", path: ["value"] } }, context).kind).toBe("matched");
expect(evaluateWorkflowPredicate({ op: "exists", value: { kind: "ref", source: "vars", path: ["missing"] } }, context).kind).toBe("pruned");
```

- [x] 运行predicate+runner定向用例确认RED。实现纯字段访问/JSON比较，不使用eval/函数构造器；frame stage/commit支持删除墓碑并保持本次运行隔离。
- [x] 给每个节点访问分配nodeVisitId，复用调用上下文产生trace身份；request仍调用CollectionRunner且保留真实目录、scope、dataDriver、容器错误部分结果。不要提前把trace业务值序列化输出。
- [x] GREEN：新测试与原runner相关回归通过；新增模块只从browser-safe入口导出相应纯类型/函数。独立审核AC03/04和身份接口，不为每个控件写测试。

## Task 3：B1 — 子场景、有界循环和准备闭包接线

**交付：** 子调用/循环复用固定执行快照，正确输入输出、行策略、上界及身份。

**文件：** core workflow/runner、scope、plan，testing/{selection,data,suiteRunner}.ts中相关接点，CLI main及Desktop main/ipc/main/testing的请求选择改用A1闭包；复用workflow/runner、testing/{suite,data}和contract/consumerIntegration测试。

- [x] RED：同一child调用两次不串局部变量；子场景成功输出映射/失败不发布；v1旧登录场景由调用侧输入参数、提取token并显式导出，缺失导出整批零提交，原v1 root仍空carried；loop0次零请求、while耗尽失败、until不多跑；嵌套独立数据与suite单行行为不变。复用现有 `createContractExecutionProject` 构造完整项目，不另造旧ApiDefinition生产适配。
- [x] 用现有workflow runner测试的捕获观察器记录 `(invocationPath,nodeVisitId,attempt,rowIndex)`，断言重复child/不同轮次键不同且定义revision相同；前置读取计数保持一次。
- [x] 实现child invoke和loop frame，适配旧v1 child的原串行/OR逻辑：调用侧inputs复制到私有bridge，outputs从最终有效提取/携带变量按白名单读取，不要求v1 strict模型有声明字段；被调v2才静态校验其inputs/outputs声明。输入复制，成功输出受映射控制；顺序子调用共享所属分支Cookie但不写回项目/环境。
- [x] 统一所有入口的闭包选择；数据准备后校验保守执行上界和suite50000限制，不把上限展开成庞大内存数组。不得在运行子节点时再次读凭据/数据文件。
- [x] 保留原CLI/Desktop独立v1根缺引用的失败报告及no-strict独立节点行为；共用遍历提供显式legacy根准备/报告模式和引用诊断，不保留第二套扫描。v2及其legacy子闭包、Suite原严格预检不弱化。
- [x] GREEN：只验证所改入口及上述相关文件，核对缺引用在credentials/OAuth前拒绝。独立审核AC05/06、AC02闭包消费；不扩stress算法。

## Task 4：B2 — 真并行、AND/OR和Cookie分叉

**交付：** 有界嵌套并行、可解释汇聚、分支状态与输出隔离。

**文件：** 新建core `workflow/scheduler.ts`，修改runner/scope、`http/session.ts`；新增 `tests/workflow/scheduler.test.ts`，复用workflow/runner、http/client、testing/suite测试。

- [x] RED：scheduler测试使用Promise屏障确认两个task在释放前同时进入，第三个在许可可用前不能进入；不靠CPU负载/固定sleep推断真并行。

```ts
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let twoEntered!: () => void;
const entered = new Promise<void>((resolve) => { twoEntered = resolve; });
const scheduler = createWorkflowScheduler({ maxConcurrency: 2 });
let active = 0;
const tasks = [1, 2, 3].map(() => scheduler.runLeaf(async () => {
  active += 1;
  if (active === 2) twoEntered();
  await gate;
  active -= 1;
}));
await entered;
expect(active).toBe(2);
release();
await Promise.all(tasks);
await scheduler.drain();
expect(active).toBe(0);
```

- [x] 真实runner用受控协议adapter证明AND全成功/一败、OR先败后胜/全败/胜出后取消；给用户取消独立cause，禁止OR内部取消覆盖root verdict。
- [x] 新增HttpSession.fork内部复制CookieJar；测试父登录Cookie被子继承、兄弟设置互不影响且父值不变，分支session与父owner分别恰好关闭一次。不公开Cookie值序列化接口。
- [x] 所有嵌套child复用root scheduler；容器不持许可。等待OR落败分支drain后提交winner输出/合并markers；AND只在全成功后提交，重复目标预检拒绝。
- [x] GREEN：受影响scheduler/runner/http/suite文件通过；独立审核AC07–09及晚到状态禁止发布，不扩建分布式协议。

## Task 5：B3 — request重试、期限、错误路由和finally

**交付：** 有界故障处理，不丢真实attempt和主次错误，取消含义固定。

**文件：** 新建core `workflow/policy.ts`，修改runner/scheduler/scope/trace；复用workflow/runner与scheduler测试，复用已有假时钟/可控adapter，不另增时间测试框架。

- [x] RED：request首次失败→第二次成功恰好两次；每次包含全部选中数据行，失败尝试不向外发布变量。副作用方法未确认时零次发送；config/script/abort不重试。
- [x] 假时钟断言fixed/exponential退避及封顶；超时信号到adapter、迟到结果不能更新frame/observer终态。验证总期限不能被child延长、计时器/listener退出后释放。
- [x] 实现顺序 `attempts -> onError -> finally -> final verdict -> failFast`；recover仅消费可恢复原故障。主体成功/恢复成功后finally失败均最终failed，以cleanup为当前未处理主错；主体仍失败则保留原主错和有序次错，不回调同一onError。两个成功→cleanup失败分支各加现有文件中的定向断言；finally不等同旧postOperations。
- [x] 节点主体局部期限覆盖重试/退避，onError/finally用仍有效父scope派生的独立有界信号，各默认5000ms、上限30000ms。验证局部超时后handler可执行且不超过祖先期限；用户停止/root耗尽/父取消/OR落败不新启handler或网络cleanup、取消已在途处理器，轨迹记录cause和skip，本地资源关闭。对不合作插件保持stopping/未完成，不伪造“race已停止”。
- [x] GREEN：定向runner/policy/scheduler测试，独立审核AC10–12及次数预算。没有新增权限、脚本运行时或取消强杀项目；若需要这些，停止并报告不自行扩项。

## Task 6：C1 — 宿主取消、统一事实/逻辑报告和证据

**交付：** CLI/Desktop/Suite共用F5内核与报告模式，重试/OR/恢复结果一致，精确身份与部分结果可用。

**文件：** core `report/{types,units,evidence,junit,html}.ts`、workflow/adapter、testing/{suiteRunner,selection}.ts；CLI main；新建Desktop main/workflow.ts，修改main/{ipc,testing,runs}.ts、shared/{types,channels,ipc-contract,testing}.ts、preload/preload.ts。若src/stress/model.ts的共用EvidenceIdentity需要新增字段，仅作schema parity，不改stress执行/统计。

**测试：** 复用core workflow/adapter、report/reporters、testing/suite；CLI contract-assets/e2e；Desktop main/ipc、contract-ipc、testing相关现有文件，声明类型测试保留。

- [x] RED：复用同一个小合成项目，三种行为“重试成功、OR有失败分支但成功、recover成功”分别验证root/suite通过；所有失败事实仍passed=false，JSON/HTML/JUnit最终结论一致且JUnit逻辑testcase不按raw failed翻红。
- [x] 将EvidenceIdentity、keyFor、identityDto、projectWorkflow分组及IPC schema同时接上invocationPath/nodeVisitId/attempt。更新adapter平铺逻辑，只从叶子记录一次真实行；旧v1/旧历史保留原模式。
- [x] 实现新reporting mode、混合suite units与逻辑verdict优先级，JUnit失败attempt放安全system-out/properties。保留requestStarted/requestCompleted与observeHttp数值，不把real-case-rows标成HTTP次数。
- [x] Desktop main/workflow拥有invocation运行表/AbortController/owner scope，WfRun新增invocationId和输入，新增WfCancel通道；IPC handler、preload、memory API及类型声明同批接线。复用现有testing controller生命周期约束，取消不能跨项目/窗口/工作区。
- [x] CLI增加 `--inputs <json>`、`--concurrency <n>`、`--timeout-ms <n>`；校验失败零业务请求，SIGINT/SIGTERM撤listener并保留安全部分结果。报告失败仍非零并保留JSON。
- [x] 复用晚到敏感marker夹具覆盖早期/兄弟trace，全部drain后统一投影；新增trace共享既有16MiB预算，不无界保存变量。导出错误/复制/日志使用同一边界，精确身份不得因业务文本省略而丢失。
- [x] GREEN：仅受影响Core/CLI/Desktop文件及类型，独立审核AC11、13–15、17。状态输出须区分历史尝试失败与最终逻辑失败，不靠文案掩盖矛盾。

## Task 7：C2 — 设计器、控制配置、停止和轨迹体验

**交付：** 所有F5功能可在当前项目界面配置使用，不仅是模型/API可用。

**文件：** 新建WfControlFields.vue，修改WfDesigner/WfNode/WfPropertyPanel/WfResultDrawer、wf/wfCanvas、stores/workflowDesign、api/memory、i18n/en.json/zh-CN.json。必要App.vue接点只接现有项目/导航/dirty，不能重排顶层布局。

**测试：** 复用Desktop `tests/renderer/components/wfDesigner.test.ts`、`tests/renderer/wf/{wfCanvas,wfBindings}.test.ts`、`tests/renderer/stores/workflowDesign.test.ts` 与既有IPC plain args测试，不按控件新建文件。

- [x] RED：新parallel/loop/subflow字段修改保存往返不丢、节点移动不丢payload；运行→停止发相同invocationId，切项目后旧结果不覆盖；重试副作用确认/无效输出冲突能显示。
- [x] 节点库用kind选择器替代不断加顶栏按钮；属性表单按kind显示，结构化predicate按源/字段/操作/值编辑。parallel面板展示各workflow分支及AND/OR；handler/finally引用可定位打开，dirty确认沿用现有流程。
- [x] 新结果视图同时展示逻辑结论/真实行数，展开调用→轮次→attempt，显示恢复/落败/cleanup skip。行号统一1起始，利用精确身份跳转原节点/用例，不提供假快照重放。
- [x] 保持顶栏固定和分区滚动/最小尺寸/只读/正常短窗口可达；renderer用browser-safe纯入口。补齐中英词条，不把i18n key显示为label。memory入口的演示结果明确不作为真实执行验收。（组件及类型已验，原生几何/组合交互由G继续实际核验。）
- [x] GREEN：上述组件/store回归及Vue类型通过；独立审核AC16/17与所有新节点真实可配性，不重新宽审无关界面。

## Task 8：G — 最终集成、独立审核与Windows交付

**交付：** 18AC逐项证据、一个新验证包、明确剩余边界。未授权Git操作。

- [x] 冻结最终候选diff和构建输入，去重前面已通过的定向文件；唯一一次全增量规格/质量独立审核，由Sol xhigh完成。重要修正只定向复审，不每轮重启全阶段宽审。
- [x] 最终producer顺序：`pnpm -C packages/core build` → `pnpm -C packages/core typecheck` → `pnpm --filter '!@apicc/core' -r build`。递归实际包含admin-web，原命令和证据保留；修复后仅重建受影响producer并绑定。
- [x] 一次顺序跑Core/CLI/Desktop完整测试，每包2workers；Core1214、CLI174通过，Desktop1066通过/1项I06失败。保留原失败，修后受影响Core100/CLI68/Desktop113全部通过，未与重叠统计相加、未排除文件/删断言/增超时；未改admin/Java复用既有基线。后续HTML手验缺口仅复验reporters完整19项及Core构建/类型，不重跑同一宽集。
- [x] 品牌自检+全树扫描、diff空白检查通过；新独立Windows包与Core/Electron/preload/renderer字节绑定、启动冒烟通过。HTML手验修后新包位于`local/packages/f5-g-20261022-htmlfix1/win-unpacked`，旧包/用户项目不覆盖。
- [x] 同一合成项目完成登录Cookie→AND/OR→循环→重试→恢复/finally→混合套件→三种报告→定位，另一次停止在途。封存请求52次，与四次主流程各12、普通/v1两次及停止两次一致；兄弟Cookie隔离、父Cookie未回灌，停止后无新请求/网络cleanup，等待连接在响应前关闭。
- [x] 用户确认新版HTML逻辑统计/可读节点轨迹展示通过，并确认Cleanup节点拖动、保存、返回重开位置及绑定保留。旧HTML失败及修复/独审证据保留，不绕过本地HTML工具限制，不重复已闭合手验。
- [x] 18AC、最终源码/产物/新包路径和边界已归档。G-UI-01/02低优先级标签观察、FLOW007断点重放、FLOW008/F6场景压测、DEF001及F3旧观察保持开放，不列为本阶段已修复。
- [x] 按未授权Git集成的边界保留分支/工作树，未stage/commit/merge/push。后续获准后，暂存/commit前核对冻结tree，FF同tree只核对一致性；push成功不等于CI通过。

G验收完成：2026-10-22。最终产品实现与`g-html-accept-base`一致；收尾只更新本计划复选框，最终归档检查点为`g-accept-final`。全部原始五件套、独审报告及R1–R18裁定保存在`.superpowers/sdd/2026-10-21-apicc-f5-workflow/`；用户阅读入口为主工作区`local/F5阶段验收与交付记录-2026-10-22.md`。无Git提交授权，不能把验收完成称为已合并/远端CI通过。

## 集中自检与批准范围

- [x] 18AC均对应A1/A2/B1/B2/B3/C1/C2/G，无孤立验收项。
- [x] 结构化控制方案、v1保留、Cookie不回灌、request整节点重试、用户停止不新发cleanup、新JUnit逻辑计数、F6/断点边界均在规格中明示。
- [x] 没有插件/引擎/外部服务新依赖，没有自动Git操作；本轮文件归档不是产品验收。
- [x] 用户已集中确认本规格与计划并要求完成F5，现启动A1；仅实质范围变更再向用户确认。
