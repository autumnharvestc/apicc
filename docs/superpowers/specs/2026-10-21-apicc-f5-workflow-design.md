# F5 强编排设计与验收规格

日期：2026-10-21。状态：**用户已确认“完成F5任务”，正式实施中**。基线：`e77c98d0d6f95c116487782d9af987143d5232d1`，F4/CI71 已闭合。

本轮用户授权核对现有实现、归档整阶段设计/验收/工作计划；不是产品实现或 Git 集成授权。开发配置沿用 GPT-6.1 Sol high，独立审核 GPT-6.1 Sol xhigh；max 必须另行批准。DEF-001 无限期延期，不因本阶段开始而恢复。

后续授权覆盖：用户已集中批准按本规格完成F5，解除上述产品实现等待；提交、合并、推送仍未授权。下文“待确认”是设计形成过程，不再阻挡A1–G。

独立Sol xhigh设计预审及三项修订定向复核已PASS（legacy适配、finally失败、取消信号）；仅为设计/计划结论，仍待用户一次集中确认，不是产品已实现。

## 1. 目标、范围与方案

目标：在当前项目中可视化组织可靠的本地业务场景，支持声明式条件、变量、延时、断言、子场景、有界循环、真并行、AND/OR 汇聚、重试、超时、错误处理和 finally，且桌面、CLI、套件的最终结论一致。

方案比较：

| 方案 | 收益 | 成本与裁定 |
| --- | --- | --- |
| **推荐：复用现有工作流，新增结构化控制节点** | 子场景、循环体、并行分支和处理器引用同项目 workflow；仍复用 CollectionRunner | 并行节点内置 AND/OR 汇聚，不支持任意位置的 fork/join 配对；避免首次就实现任意区域控制图 |
| 在任意连线上实现回边和自由 fork/join | 表达自由 | 需要处理跨区跳入、嵌套汇聚和令牌相关性，范围及验证量明显增加，本阶段不选 |
| 引入外部工作流引擎/服务 | 可复用成熟调度 | 改变本地执行及资产接线，引入依赖和迁移，不选 |

本阶段交付强编排，不顺带扩建压测调度。源码核对确认：现有 StressRunner 使用 createStressCaseSession，不调用 WorkflowRunner。**整场景作为 VU 压测单元、到达率/升压/趋势/基线属于 F6**，不在 F5 冒称完成 FLOW-008。

不包括任意脚本新节点、WASM/引擎补丁、独立服务端执行器、分布式性能基础设施、在线协作/SDK、任意图回边、断点单步或历史内存快照恢复。FLOW-007 本阶段交付轨迹与定位，不把已有整场景重跑称为节点断点重放；其余部分明确保留开放。

## 2. 已有事实与准确改动点

| 现状 | 源码依据 | F5 处理 |
| --- | --- | --- |
| 只有 request/noop；边 condition 是字符串 | `workflow/model.ts` | 增加显式 executionVersion=2、新节点及结构化 predicate；旧格式不被静默重解释 |
| 串行 await；普通多入是任一成功来源即可；禁止图环 | `workflow/runner.ts`、`validate.ts` | v1 保持原语义；v2 用结构化控制表达并行/循环 |
| 节点经真实模块/目录祖先的 CollectionRunner 执行 | `workflow/references.ts`、`runner.ts` | 保留容器操作、环境 scope、请求覆盖、断言、提取及错误分类 |
| 凭据/数据选择只扫描一层 request | CLI `main.ts`、Desktop `main/ipc.ts`、`testing/selection.ts` | 使用同一递归闭包计划，不能漏掉子场景/分支/处理器 |
| 每次运行独立 carried/extractions；当前 Cookie session 由宿主传入 | `workflow/runner.ts`、`http/session.ts` | 新 invocation frame；并行分支私有变量、提取和 Cookie 分叉 |
| F4 真实执行行与 NON-HTTP 诊断分离 | `workflow/adapter.ts`、`report/units.ts` | 保留事实；新增显式逻辑调用报告模式解决恢复语义 |
| 证据键/分组主要依赖 nodeId、entryId、数据行 | `report/evidence.ts` | 增加调用、节点访问和尝试身份，防止循环/嵌套覆盖 |
| UI 只有终态运行结果，无工作流停止通路 | `WfDesigner.vue`、`workflowDesign.ts`、IPC | 增加带 invocationId 的运行/停止和在途状态保护 |
| schema、快照和 clone 有 request/noop 硬编码 | `assets/snapshot.ts`、`assets/clone.ts`、Desktop `shared/ipc-contract.ts` | 同批更新，不以宽松 schema/删除校验绕开 |

上表 Core 路径以 `packages/core/src/` 为根，Desktop 以 `apps/desktop/src/` 为根。这是静态核对结果，不是本轮重新运行全部测试的结论。

## 3. 契约与预检

### 3.1 版本和图

- 原定义缺 executionVersion 时按 v1 解释；现有 v1 的 request/noop、普通多入 OR、旧 condition 字符串保留。新增 v2 定义使用 `executionVersion: 2`，不更改工作区/ApiContract 的 formatVersion。
- v2 顶层仍是 DAG：唯一入口；普通节点最多一条后继；condition 节点有 true/false 两个互斥端口，各最多一条后继；终点可没有后继。无连线孤点、多入口、普通隐式扇出在运行/启用时拒绝，草稿可保存并显示诊断。互斥路径可汇回同一节点，该次调用只执行一次。
- 真并行只通过 parallel 节点建立。循环只通过 loop 节点反复调用循环体，不放开图回边。错误处理及 finally 使用显式 workflow 引用，不把任意边重新解释为异常跳转。
- 同项目子场景可以引用已有 v1：其内部仍走既有串行语义，并通过 frame 适配输入/输出及身份。含旧 condition/脚本时明确保留现有引擎依赖；不自动转译 JS，不宣称其获得新脚本隔离或强制中断保证。
- 新字段保持 strict；未来未知 executionVersion 明确拒绝。保存、关闭重开、完整项目克隆、原生项目交换均保留语义；OpenAPI 等不承载工作流的格式沿用损失诊断，不新增外部流程格式。

### 3.2 编译计划与闭包

新增 `compileWorkflowPlan(snapshot, workflowId, options)`：只消费固定 ProjectSnapshot，返回固定 revision、所引用 workflow 集合、去重后的物理请求选择、控制关系和执行次数上界。结构、重复身份、跨项目/悬空引用、直接/间接递归、输入输出映射、非法策略及不支持版本在凭据读取/OAuth 准备前拒绝。

兼容边界：独立 v1 根场景在原 CLI/Desktop 入口保留“缺引用生成失败报告、非严格模式可继续独立节点”的既有行为。共用闭包遍历可显式选择 legacy 根准备/报告模式，返回合法选择及引用诊断，宿主仍按原 strict 参数准备，原 v1 runner 裁定报告；不另建请求扫描器。该模式不适用于 v2 根、v2 所调的 legacy 子流程或套件的既有严格预检，也不放宽结构、重复身份及 schema 校验。默认执行计划仍严格拒绝无效引用。

子场景、loop body、parallel branches、onError/finally 引用全部纳入同一闭包；共享子场景不是递归。静态图与调用图分别判环。运行中不重新读取活动项目、不二次读数据文件、不重新获取一套凭据；统一使用捕获的 ProjectExecutionRun 与一次 preparedTestData。

数据准备后、首个业务请求前核验“数据行 × 循环上界 × 重试 × 子调用 × 外层套件轮次”的保守上界；并行的分支求和，不取最大值。沿用 suite 50000 预计执行次数保护，未知条件采用最大可执行上界，不显示虚假的精确次数。

### 3.3 字段名称与策略约束

- v2 `Workflow.inputs` 为输入名→`{required:boolean,default?:JsonValue}`，`Workflow.outputs` 为输出名→WorkflowValue，`Workflow.limits` 只暴露 maxConcurrency/timeoutMs；未给值采用本规格默认值。根运行的 inputs 是值表，不是输入定义表。
- subflow/loop/parallel各分支的 `inputs` 为子输入名→WorkflowValue，`outputs` 为子输出名→父局部变量名。被调v2按其inputs/outputs声明检查名称和required/default；被调v1使用下条legacy适配规则。一个映射内多个输出写同一目标拒绝；AND跨分支重复目标拒绝，OR不同分支可声明同一目标但只提交winner。循环每轮先在loop frame中更新该映射，结束时只发布成功的最终值。
- **legacy调用侧声明：** 不给v1 strict定义添加inputs/outputs字段。调用侧inputs复制到该次v1 child的私有runtimeBridge变量，采用现有字符串转换；调用侧outputs的源名作为显式导出白名单，从该child最终有效提取/携带变量读取（提取优先，保留其JSON值，否则保留携带变量字符串）。输入不得改写项目/环境，原v1 root仍从原空carried开始。v1可导出名称不能静态证明存在：预检只校验映射结构，运行成功后读取缺值则该调用失败、整批不发布，不用父变量兜底或补造null。由B1验证“旧登录场景接收参数→提取token→映射输出”以及缺导出零提交。
- 节点 `policy` 含 timeoutMs、retry、onError、finally；retry含maxAttempts/retryOn/delayMs/backoff/allowRepeatSideEffects，只对request合法，其余节点不能静默接受。配置中显式覆盖期限时必须为正整数；depth/次数固定上限不是可随意关闭的开关。
- 请求执行错误沿用 CaseFailureKind；流程自己的结构/limit/timeout/cleanup等诊断另带稳定code和cause（不把局部超时混成用户aborted），不为此扩大插件失败类型。父取消优先于局部恢复。

## 4. 声明式值、节点与作用域

### 4.1 值与条件

`WorkflowValue` 为 JSON literal 或显式字段引用，引用源限定 `inputs/vars/env/previous/error/loop`，path 为字段/数组索引序列。previous 只指本帧的前一逻辑节点摘要，不是完成最快的其他分支；需要正文值先用 F4 提取器取得。

`WorkflowPredicate` 支持 eq/neq/lt/lte/gt/gte、exists/notExists、and/or/not。比较不做隐式字符串/数字转换；缺值与 null 分开，只有存在性判断可以将缺值当作正常 false/true。结构错误与类型不符返回明确配置诊断，不当作条件 false。复用已有 JSON 值处理，不增加 eval、动态函数、表达式执行包或新依赖。新条件无需脚本引擎；既有请求执行器的插件/脚本注册约束不在本阶段整体重构。

predicate 最大深度32、总节点256，and/or至少一个item；ref path最多64段。配置解析和求值都遵守同一限制，错误为配置诊断而非正常分支剪枝。

### 4.2 节点

| kind | 结构与行为 |
| --- | --- |
| request/noop | 保留原绑定和执行内核；noop 不制造执行行 |
| assign | `assignments` 为目标变量名→WorkflowValue；同批先求值后原子提交，失败不留半批值 |
| delay | `delayMs` 为非负整数；可取消等待，不占请求并发许可 |
| assert | `predicate` 通过/失败形成节点诊断；不伪造 HTTP 响应。响应断言仍优先配置在真实用例中 |
| condition | `predicate` 决定 true/false 端口；未选路径按 condition-pruned 记录 |
| subflow | `workflowId`、输入映射、输出映射；父值不作为子场景可写全局 |
| loop | `workflowId` 为循环体；固定 count 或 while predicate，必有 maxIterations；支持成功的 until 提前终止条件 |
| parallel | `branches[{id,workflowId,inputs,outputs}]`，至少2支；`join=all/any-success`，内置汇聚 |

### 4.3 Frame、输出与 Cookie

- 每次 root/child invocation 有独立输入、局部变量、提取状态、previous 和错误上下文。环境/项目定义只读；请求层变量优先级与 F4 保持，只在既有 runtimeBridge 层接入 frame。JSON 值进入字符串变量时按现有数据集规则转换，不新造另一种编码。
- 输入在调用开始求值、复制；子场景仅声明的成功输出映射回父 frame；失败不发布部分变量。悬空映射及第3.3节定义的目标冲突预检拒绝。无输出默认不导出局部变量。
- subflow 与 loop 顺序共享所属分支的 Cookie 会话，便于登录→业务；循环变量留在 loop frame，成功轮次输出可供下一轮输入映射读取，整个 loop 成功后才向父发布。已产生的远端副作用及 Cookie 不回滚，界面明确说明。
- 并行分支从 fork 时父 Cookie 快照各自复制。**分支 Cookie 不回灌父会话**；分支之间互不可写。新增宿主内 `HttpSession.fork()`，不把 Cookie 原值交给 renderer、日志或项目文件；分叉 session 恰好由分支关闭一次，父会话仍由原宿主关闭。
- AND 只有全部成功才一次合并显式输出；写同一父变量的两个分支预检拒绝，不用完成先后裁定覆盖。OR 仅发布胜出分支的显式输出。没有跨分支环境写回或全局变量共享。

## 5. 调度、循环与故障

### 5.1 真并行和汇聚

顶层一次运行共享同一个叶子请求许可池，默认 maxConcurrency=4，可配置1–32。容器/循环/子调用不占许可，避免嵌套互等；一个 request 节点的一次尝试包含其按序数据行，占一个许可，结束释放。delay 和重试退避不占许可；每次重试重新排队。该数值不是 VU、RPS 或压测负载模型。

AND 等待全部分支终态；任一最终失败则 parallel 失败。OR 采用 **any-success**：先失败不立即判整个 OR 失败；首个成功分支胜出，无成功且全部终态才失败。胜出后取消未完成分支，并等待已启动分支收尾，再封存输出和所有敏感标记；竞争成功以调度器接收完成通知的次序决定，轨迹保留确切 winner，不冒称跨机器确定性。未启动/落败取消不是用户取消。

并发真实性用可控 barrier 和活跃计数证明，不以“恰好少于某毫秒”作为唯一测试依据。完成顺序变化不得造成父变量竞争或证据串号。

### 5.2 有界循环

count/while/until 只在 loop frame 中求值；固定 count=0 合法且零次调用。零次循环成功但不发布从未产生过的输出，父目标保持原样，不补 null 或以父值代替子输出。默认 maxIterations=100，配置1–10000；固定次数超过上限预检拒绝。while 在下一轮仍为 true 而预算已用完时失败，不伪装正常完成；until 成功结束不追加一轮。体失败默认停止，确需恢复用体内 onError；不新增隐式 continue-on-error。

每轮、每个分支、子调用和重试都有独立身份。循环本身不再隐式推进数据行：体内请求沿用已有数据策略；外层 suite 绑定一行时向所有子调用传递同一 preparedRowIndex，不生成隐式笛卡尔积。

### 5.3 超时与重试

整场景默认 timeoutMs=300000，可配置1–3600000；节点可配更短期限，request 未覆盖时继续既有请求超时。子节点不能延长父期限。调用深度默认/上限8，单 root 最大节点访问/尝试数10000，耗尽为明确 limit 失败。上述是普通产品有界性，不是重新启动脚本资源认证专项。

重试首版只用于 **request 节点**，默认 maxAttempts=1，可配1–5；一次重试会重新执行该节点的全部选中数据行及原容器操作，UI 明示此边界。retryOn 可选 transport/http/assertion/extraction，不重试 config/script/用户中止；maxAttempts 耗尽保持最终故障。delayMs 为0–30000，fixed/exponential 退避封顶30000，不加随机抖动。非 GET/HEAD/OPTIONS 必须显式确认 allowRepeatSideEffects；即便 GET 也提示可能有副作用，不宣称幂等或请求未到服务端。

每次失败尝试的变量/提取写入不提交到节点外；成功尝试才提交。远端操作和 Cookie 不回滚。超时必须传递取消信号、禁止晚到结果发布、清 timer/listener；**Promise.race 不算已经停止请求**。已有同步脚本及不合作的第三方插件不获得可强杀保证；未确认停止时保持 stopping/未完成标识，不谎称资源已回收，不因此新增引擎/进程隔离。

### 5.4 错误路由和 finally

节点可声明 `onError:{workflowId,mode:propagate|recover,timeoutMs?}` 和 `finally:{workflowId,timeoutMs?}`。二者都是同项目场景调用，闭包纳入预检；处理器通过只读 error 摘要取得失败类别，不获得任意宿主异常对象。两类处理器的timeoutMs都默认5000、范围1–30000，并受仍有效的祖先/root期限限制。

顺序固定：节点各次尝试→必要的 onError→一次 finally→裁定节点终态→父级 failFast。recover 只有处理器成功且原故障可恢复才消费故障；预检/config、用户中止、运行总预算耗尽不可恢复。原容器 pre/post operations 的行为不偷改成新 finally。

**finally故障裁定：** 主体成功＋finally失败、主体故障已recover＋finally失败，最终均failed，由cleanup故障作为当前未处理主错误。主体仍有未处理故障时，保留原主错误，handler/cleanup故障按发生顺序作为次要故障。已恢复的原始错误仍留在轨迹，不被cleanup覆盖删除；不得把“次要”解释成不影响成功结论。一次finally失败不回头重新调用所属节点的onError。

policy.timeoutMs约束节点主体（包括其重试/退避），不复用这个已到期信号启动处理器。自然错误或本节点局部超时、且所属祖先/分支仍有效时，onError/finally各创建独立的有界子信号，链接仍有效的父scope，因而局部超时可以被处理，不能延长root期限。

**祖先取消优先：** 用户停止、root总期限耗尽、父调用取消、OR落败取消均不再新启onError或网络finally，已在途的处理器/cleanup也接收该取消；记录handler-skipped/cleanup-skipped和明确cause。本地资源close/dispose仍执行。OR winner不能消费其他分支的清理失败来伪造“资源已结束”；只有所有已启动分支收尾后才能正常完成，无法确认停止时仍按第5.3节显示stopping/未完成。此为本轮需集中批准的取消语义，不称为“无论如何执行远端清理”。

用户中止在最终 verdict 中独立为 aborted，CLI 非零。failFast 只在重试/恢复/finally 的最终裁定后生效，并等待在途任务收尾。不能用 OR 的内部取消把整场景标 aborted。

本地资源释放保证覆盖任意嵌套层级：本 root 创建的 fork session 若 close 失败，必须保留诊断并阻止该 root 成功封存，不能被祖先 OR/recover 消费。该约束只针对宿主资源释放失败；一般网络 finally 的业务故障仍按节点故障、父汇聚及显式恢复语义裁定。

## 6. 事实、最终结论与报告

### 6.1 唯一身份与事实

扩展 EvidenceIdentity/CaseOutcome：`invocationId`、`parentInvocationId`、`invocationPath`、`nodeVisitId`、`attempt`；path 含 workflow/node/branch/loop 的结构身份，iteration/rowIndex 内部0起始、界面1起始，attempt 从1起始。nodeId 不是一次运行出现的唯一键。

保留每次真实 executeCase 行及其原始 passed/failureKind；不把重试失败、OR 落败分支或已恢复错误涂绿。**真实执行行不等于 HTTP 请求数**：发送前的执行失败也可有真实行；实际协议启动/完成次数依据 CaseExecutionResult.requestStarted/requestCompleted 的观察统计，HTTP 重定向交换另按既有 observeHttp 口径记录，不凭 CaseOutcome 总数推导。

### 6.2 显式新报告模式

v2 root 的报告声明 `workflow-invocation-v2` 模式；JSON/HTML 展示两组不同命名的数值：最终逻辑调用结论，以及执行行/失败尝试/协议请求事实。JSON 的原 cases 和原始行计数不变；新增逻辑 reporting units，不把逻辑数冒充请求数。

JUnit：顶层 v2 工作流调用为一个 testcase；suite 中的 v2 workflow entry×外层数据行为一个 testcase，普通 case/v1 entry 保持原模式。failure/skipped 依据最终调用 verdict；失败尝试、恢复关系、OR winner、原始计数以有界脱敏 system-out/properties 保留。HTML/JSON 显示相同最终结论及可展开的真实失败，不让报告消费者再从 raw failed 数猜测场景成败。

SuiteRunner 对新模式以最终 verdict 判条目状态，而非 `verdict || raw failed`；无新模式的 F4/旧历史保持旧解释。NON-HTTP 未处理故障仍计入新模式的逻辑失败，不再为已恢复 attempt 重复追加 failure。新旧混合套件的逻辑总数为各 entry 产生的 reporting units 之和，界面/JSON/JUnit 均明确标明计数类型。

### 6.3 轨迹与输出边界

轨迹记录节点开始/终态、尝试、等待、分支胜出/取消、循环轮次、恢复和 cleanup 结果，能定位到原场景/节点/真实用例。父容器的摘要不再次复制子叶 outcomes；真实行只记一次。历史仍是只读，不从当前资产补造旧轨迹。

完成并收齐所有相关分支的敏感标记后，沿用现有输出边界统一脱敏再截断；值预览4KiB、正文64KiB、case证据256KiB、整次证据16MiB不提高，新增业务轨迹也计入预算。轨迹事件最多20000，超限标 truncated 并保留最终结论/数字汇总；不保存无界变量快照，不向 renderer/报告泄露私有标记。关键身份、公开枚举与业务文本按来源分开，不重现 F4 的误遮蔽问题。

并行仍在同一宿主运行，无新 worker 协议。对 stress 仅保持现有消费兼容，不扩充 F4 跨进程安全专项。

## 7. 桌面、CLI 与资产一致性

- UI 仍限当前项目工作区。节点库/属性面板支持本规格所有新节点；并行块直接显示分支列表和 AND/OR 汇聚规则，点击引用打开相应子场景，错误处理/finally 同样有可见引用入口。不是仅手写 YAML 可用。
- 输入映射、输出映射、循环上限、超时/重试和副作用确认均可配置、保存重开；预检错误定位节点/字段。沿用顶栏固定、画布/属性区各自滚动、只读、dirty、切项目及异步 ABA 防护，不重做整体外观。
- 运行请求带唯一 invocationId；新增停止入口只取消同一工作区/项目/窗口捕获的对应运行。切页后的迟到结果不得覆盖新项目；关闭工作区按既有生命周期处理其在途运行，不移交外部服务。renderer 不持有运行器或 HttpSession。
- CLI `run-workflow` 增加 JSON 输入和并发/总期限覆盖；先校验再执行。退出码：passed=0，failed/aborted/报告失败非零。SIGINT/SIGTERM 经相同取消通路，保留安全的部分结果。
- 删除子场景须显示所有父场景/套件引用并拒绝悬空删除；克隆项目重写 workflow/branch/node/handler/output 中的结构身份，不改字面业务值。更名不破坏引用。
- renderer 只从已有 browser-safe 子入口取纯数据函数；不能为新模型静态导入 Core Node 主入口而再带入 SQLite。新依赖、版本变更或额外服务均不属于默认范围。

## 8. 验收矩阵（一次集中批准）

| AC | 可观察通过条件 | 任务 |
| --- | --- | --- |
| 01 | 新节点/策略保存重开与项目克隆不丢字段；旧 v1 不改义；未知版本拒绝 | A1 |
| 02 | 递归/跨项目/悬空引用/非法图在凭据准备和业务请求前拒绝；闭包含所有分支/处理器 | A1 |
| 03 | 新条件不依赖脚本引擎求值；missing/null/类型错误分开，assign 批次原子 | A2 |
| 04 | delay 可取消；assert 失败是非HTTP诊断；request 沿真实祖先和 F4 内核执行 | A2 |
| 05 | 子场景输入/局部/输出隔离；不重读定义/凭据/文件；旧子流程保留内部语义 | B1 |
| 06 | 循环0次、until及上限准确；行号与轮次独立；数据/执行上界预检可靠 | B1 |
| 07 | barrier 证明真实并行及共享叶子并发上限；嵌套容器不持许可、不死锁 | B2 |
| 08 | AND一败/全成功，OR先败后胜/全败，内部取消与用户取消均按本规格裁定 | B2 |
| 09 | 分支变量/提取/Cookie不串；输出冲突预检拒绝；fork登录Cookie可用且不回灌 | B2 |
| 10 | maxAttempts与退避正确，完整节点/数据行重试边界可见；副作用确认有效 | B3 |
| 11 | 超时取消/停止不发布迟到结果，无多余重试/新请求；资源和计时器正常释放 | B3/C1 |
| 12 | recover与propagate、处理器失败、finally失败及用户取消清理策略都有确定结果 | B3 |
| 13 | 重试成功、OR成功、显式恢复三例的桌面/CLI/套件/JSON/HTML/JUnit最终结论一致；真实失败未改绿 | C1 |
| 14 | 重复子场景/循环/attempt证据身份不混淆；无HTTP故障不伪造通过行、不重复计错 | C1 |
| 15 | 晚出现敏感值覆盖早期轨迹与兄弟分支；先脱敏后截断、预算和标记收齐有效 | C1 |
| 16 | UI所有新配置可编辑保存；停止、dirty、只读、项目切换和内部滚动实际可用 | C2 |
| 17 | 子场景删除影响、项目克隆、混合套件、旧历史及旧场景的消费回归通过 | A1/C1/C2 |
| 18 | 同一隔离合成项目完成设计→子场景/并行/循环→失败恢复→取消→报告/定位；最终门禁/独立审核/Windows包通过 | G |

不为18行各建一个测试文件，也不承诺每个排列组合都实机穷举。旧 F3 四项低优先级观察及完整脚本控制台未采集边界继续记账，不在 F5 静默关闭。

## 9. 执行与验证纪律

A1→A2→B1→B2→B3→C1→C2→G 连续推进，共7个开发交付＋G。整阶段确认后不逐 task 再索批准；仅实质设计变更、需要新权限/升级模型、进入 DEF-001 或具体阻塞时打断，并说清用户须做什么。

开发只跑必要 RED/GREEN；阶段最终候选合并前一次 Core/CLI/Desktop 完整受影响包测试和构建/类型/品牌/打包。Node22、pnpm11.21、JDK21；Core build→Core typecheck→其余 build→包间顺序/每包2workers测试；不增timeout、不删断言或skip求绿。admin-web/Java 未改则复用已闭合基线，不为文档或每次修复重复全仓；CI实际递归及全量入口仍保留。

快进合并 tree 不变只核对一致性；Git集成另需用户授权。写计划本轮不跑产品测试/构建、不安装依赖、不自动提交文档。
