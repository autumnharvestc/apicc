# 本地与在线项目工作台统一实施计划

2026-11-18 制定，2026-11-19 获准实施三个批次。代码核对基线为 `cb4fe63d`。以下编号为验收要求，执行结果见[逐项验收记录](f8-project-workbench-parity-verification.md)。

评审时先看[本地「运行 → 发起任务」样板](design/f8-frontend/project-workbench-parity/local-run-launch-proposal.png)，再对照[接口与底栏样板](design/f8-frontend/project-workbench-parity/api-status-bar.png)、[任务记录样板](design/f8-frontend/project-workbench-parity/run-records.png)和[已归档的交互设计](f8-project-workbench-parity-design.md)。本地样板中的「3 个用例」是所选环境下的用例数，同一接口可有多条；它不承诺会发出 3 次请求。

## 批次与交付边界

| 顺序 | 本批交付 | 交给下一批的接口 |
| --- | --- | --- |
| 1．项目工作台与底栏 | 两端侧栏进入同名模块；在线「接口」首屏可直接编辑；环境和执行位置归入项目底栏。旧执行面板的操作都有去向。 | 活动项目身份、当前手动执行上下文、能力及不可用原因；各业务页继续调用原宿主。 |
| 2．发起任务 | 两端共用选类型、选目标、核对范围和发起的流程。本地增加现有模块运行的范围预览。 | 一次明确启动对应的既有执行身份、实际环境和位置，供业务页和任务记录定位。 |
| 3．任务记录与在线跳转 | 两端有一致的列表及详情；接回原报告与动作；在线定时任务、通知可定位原计划或原运行并返回。 | 完成项目级联验，按下表逐项交付证据。 |

保留接口「发送」、测试、工作流、压测等原有业务入口。在线「运行模块用例」已列入[低优先级需求池](backlog.md#execution-low-004)。本地仅显示「发起任务」「任务记录」。在线再显示「定时任务」「通知」。预期改动集中在桌面工作台、状态绑定和必要的本地读取适配；沿用现有 Core、服务端权限、任务类型与代理协议。若实施核对发现某项必须新增服务端历史存储或改变执行协议，单列缺口供评审。

## 第一批　项目工作台与底栏

**实施顺序。** 先将活动项目及可访问视图从编辑器选中项中分离，再接底栏和旧草稿兼容，最后搬迁控件。原在线 11 个页签逐个改接新导航。在第二、三批交付前，「运行」允许先承载旧发起、任务列表、报告、计划和通知组件；只有目标入口可达后才撤下旧入口。项目级执行状态由项目宿主持有，切页面只切换视图。

| 用例 | 现有入口 → 迁移去向 | 复用路径与需改的部分 | 验收操作与通过判据 |
| --- | --- | --- | --- |
| A01 | 在线项目首屏、旧「接口调试」和接口选择框 → 侧栏「接口」及项目目录 | 修改 `viewSwitch.isViewDisabled`、子视图门控和 `App.vue` 内容分发；复用 `online.selectNode`、`OnlineApiEditor`、目录草稿及远端更新处理。本地仍使用现有请求签。 | 有效在线项目首次打开直接看到选接口的提示，点目录即显示正确接口。切离后返回保留未保存编辑。空项目按权限显示创建入口；旧格式、原始文件浏览和已有「发布为新项目」路径仍可达。 |
| A02 | 本地请求行／侧栏快捷环境、在线执行面板的环境 → 项目底栏「环境」；原「环境」页签 → 侧栏「环境」管理 | 本地沿用 `debugEnvironmentSelection` 的请求签校验、`projectSessionKey` 与环境数据。在线沿用 `onlineExecution.environmentId`、`EnvPanel` 和项目适配器。底栏脱离“必须打开接口”的前提。 | 在接口、运行、工作流、测试分别切换环境，保持页面位置。用两项目同名环境验证身份隔离。在主页收起项目快捷项；选中环境被删除时说明失效并让用户选定。 |
| A03 | 旧请求签的独立环境 → 项目选择接管前的一次兼容处理 | 按活动签、请求签草稿和实际环境 ID 判断。尚无项目选择时，可以当前签可验证的旧值初始化；其他旧草稿与项目值不同，在发送处显示两者，允许采用原环境或当前项目环境。旧名称到 ID 只接受项目内唯一匹配。 | 项目为开发，旧签为预发，第一次发送前能看到差异；取消则零请求且保留草稿。选择后检查实际目标。覆盖未选环境的旧签、自由请求、同名或已删除环境；仅切签不产生写盘或发送。 |
| A04 | 在线执行位置、压测页运行位置 → 底栏「执行位置」；执行面板的下一次运行说明 → 该菜单的「执行详情」 | 复用 `onlineExecution.activate/selectLocation`、代理可用性、配置是否应用、受信脚本批准入口、超时和运行时信息。角色、项目及本机专用凭据在发起时继续复核。 | 在线选择本机和合成代理分别运行，目的地与所选一致；代理离线、配置未应用、无批准或材料仅限本机时能看到具体原因。切项目、成员或服务器不会串选，也不会自动改走本机。本地底栏只有环境，在发起预览中可见「本机」。 |
| A05 | 在线「调试当前接口」、面板「新建调试会话／取消」 → 接口「发送」、发送旁更多及当前响应区 | 复用 `OnlineProjectAssets.debugRequest` 的已保存接口定位与本次请求快照、`onlineExecution.run/newDebugSession/cancelLocal/cancel`。本地保留 `debug.sendRequestTab`、响应折叠及调试历史。 | 对已保存接口修改请求后发送，核对收到的是本次草稿且未顺带保存；新建会话只作用于当前上下文。慢请求切页再返回仍能找回进度并取消。只读、无有效目标或执行受限时保留原限制。 |
| A06 | 在线「用例与脚本／数据集／测试套件」→「测试」对应分区；「工作流」→ 侧栏「工作流」 | 分别沿用 `CasePanel` 与脚本编辑、`DatasetPanel`、`SuitePanel`、`WfDesigner` 以及 `onlineProjectAdapter` 的保存绑定。本地保留单接口、场景、套件、数据集分区。 | 分别从新入口打开一份已有资产，核对编辑、保存及原运行入口；切换时保护未保存内容。只读成员可读范围与原入口一致。工作流节点和用例绑定仍指向原对象。 |
| A07 | 在线「认证」→ 接口的「认证」；「项目材料」→「项目工具 → 项目材料」；「协作与分享」→ 项目工具 | 复用原认证编辑、`CredentialEditor`、`reloadMaterials/uploadAttachment/bindAttachment` 和 `CollaborationPanel`。保留已有项目工具及外部规范同步。 | 修改合成接口的认证引用并重开；上传附件后可见版本、字节数与绑定目标；用受限成员复核按钮。打开协作再返回保留项目及草稿，从结果发布仍指向选中结果。 |
| A08 | 在线「压测」→「测试 → 压测」及原业务快捷入口；「定时任务／通知」→「运行」同名页签；旧面板任务区 →「运行 → 任务记录」 | 先挂载 `OnlineStressPanel`、`OnlineSchedulesPanel`、`OnlineNotificationsPanel` 及原任务区，后续批次完善内页。压测资产的环境编辑与本次执行位置分别绑定。 | 每个原页签均能从新位置到达；进入压测仍能创建、保存、确认和停止。切底栏不修改保存的压测计划、定时任务或凭据。进入计划、通知时接口上方不再出现执行面板。 |

**本批技术检查。** 本地按工作区根路径及项目定位隔离，在线按服务器、成员及项目上下文隔离。页面离开、切项目或注销后，迟到的读取、预览或菜单选择不能更新另一项目。集中手验底栏约 28–32 逻辑像素、长名称、窄窗、键盘展开与返回焦点、中英文、亮暗主题。目标仍可在底栏直接辨认。

代码起点：[视图门控](../apps/desktop/src/renderer/src/viewSwitch.ts)、[工作台装配](../apps/desktop/src/renderer/src/App.vue)、[本地环境选择](../apps/desktop/src/renderer/src/debugEnvironment.ts)、[在线资产页及旧入口](../apps/desktop/src/renderer/src/components/online/OnlineProjectAssets.vue)、[现有执行面板](../apps/desktop/src/renderer/src/components/online/OnlineExecutionPanel.vue)。

## 第二批　发起任务

**实施顺序。** 先接当前项目的已保存目标及只读预览，形成一条本地模块用例的完整路径，再复用各业务入口的启动处理接入其余类型。预览只读取目标、范围和上下文；点击有明确对象的主按钮才执行。原业务页可以直接发起，集中入口与原入口共用启动前校验。

| 用例 | 现有入口 → 迁移或复用去向 | 复用的执行路径 | 验收操作与通过判据 |
| --- | --- | --- | --- |
| B01 | 本地「运行」的模块、环境和蓝色「运行」→「发起任务 → 模块用例」 | `RunView.onRun → run.runCollection → api.runCollection → CollectionRunner`。将候选收窄到活动项目。预览共用 `collectCollectionApis`、`resolveExecutionEnvironment`、`selectEffectiveCases`；在调用需名称的旧入口前核对同项目环境。 | 两项目有同名模块，目标列表只出现本项目项。用子文件夹、多用例、无适用用例和数据集验证；换环境后名单及跳过原因刷新，实际选例与预览一致。0 个可运行用例时禁用；3 个用例展开更多数据行时分别计数。 |
| B02 | 本地／在线「测试」的单用例运行 → 保留，同时可从「发起任务 → 单接口用例」调用 | 本地 `CasePanel → debug.runCase`；在线复用 `execution.run` 的 `debug` 目标及 `mode: case`，携带接口定位、用例作用域及环境。即席请求仍从接口页发送。 | 选中同接口下两条不同用例，对照实际参数及断言。两个入口各点一次，各产生一次执行；切换选项或查看预览不发请求。未保存或已失效目标沿用原业务限制。 |
| B03 | 两端「测试套件 → 运行」→ 保留，同时提供「发起任务 → 测试套件」 | 本地 `SuitePanel → testing.run → api.runSuite`；在线 `suiteRun → execution.run({kind: 'suite'})`。保留数据集、草稿策略、套件条目和既有环境优先级。 | 套件含用例与工作流，预览显示条目数和实际环境；核对原入口及集中入口参数。带数据集、草稿受限、部分失败三种情形的结果或拒绝原因一致。 |
| B04 | 两端工作流设计器「运行」→ 保留，同时提供「发起任务 → 工作流」 | 本地 `workflowDesign.run → api.wfRun`；在线 `workflowRun → execution.run({kind: 'workflow'})`。复用输入、发布状态、未保存保护及可取消的原路径。 | 用一个需要输入的已启用工作流核对输入、环境、节点轨迹；再选不可运行的草稿。选择另一个目标不会覆盖设计器中尚未保存的编辑。 |
| B05 | 用例／工作流压测快捷项、压测计划页 → 保留；集中入口选择已有压测计划 | 本地沿用 `stress.startPlan` 及原 `StressPanel` 快捷启动；在线复用 `OnlineStressPanel` 的计划校验、来源确认与 `execution.run({kind: 'stress'})`。计划编辑留在原页。 | 分别改环境、位置或来源使旧确认失效；核对执行地点、并发和确认范围。两端的取消、结果和报告保持可达；不通过集中入口绕过授权。 |
| B06 | 旧面板提交及结果选择 → 业务按钮和集中入口共享同一次调用 | 在线继续走 `onlineExecution.run → onlineExecution IPC → main/online/execution`，本机与代理沿用各自执行宿主。记录发起时的实际上下文及既有身份。已发起或结果未确定时不因切页、重复点击或刷新自动重发。 | 分别使用本机与代理，检查同一点击的调用次数、身份及实际请求日志；提交后切环境、切页，再查看该次运行。在线无模块类型，本地无代理选项。关闭客户端后，已接收的代理任务可在重开后查状态；本机任务遵循桌面宿主生命周期。 |

若预览后的项目定义或环境变更导致目标范围改变，刷新预览并提示用户再次发起；禁止在过期预览下静默扩大范围。选目标不复用会覆盖编辑器草稿的“加载并选中”副作用。类型列表只使用当前项目实际支持且可解释的能力。

代码起点：[本地模块页](../apps/desktop/src/renderer/src/components/RunView.vue)、[模块运行与选例准备](../apps/desktop/src/main/debug.ts)、[Core 执行遍历](../packages/core/src/runner/runner.ts)、[本地调试及用例](../apps/desktop/src/renderer/src/stores/debug.ts)、[套件](../apps/desktop/src/renderer/src/stores/testing.ts)、[工作流](../apps/desktop/src/renderer/src/stores/workflowDesign.ts)、[压测](../apps/desktop/src/renderer/src/stores/stress.ts)、[在线压测](../apps/desktop/src/renderer/src/components/online/OnlineStressPanel.vue)、[在线调度入口](../apps/desktop/src/renderer/src/stores/onlineExecution.ts)、[在线执行宿主](../apps/desktop/src/main/online/execution.ts)、[既有任务类型](../packages/execution/src/contract/task.ts)。

## 第三批　任务记录与在线跳转

**实施顺序。** 先让本地已有归档、本次会话可读的在线本机结果和服务端可读的代理记录进入同一列表／详情布局，再接具体报告、计划和通知。来源与权限分别判断；打开详情、返回、刷新均走读取路径。证据重跑仍是单独的显式动作。

| 用例 | 现有入口 → 迁移或复用去向 | 复用路径与需补的交互 | 验收操作与通过判据 |
| --- | --- | --- | --- |
| C01 | 本地「运行历史」抽屉 →「运行 → 任务记录」；接口调试历史继续可达 | 复用 `run.loadHistory/openRun → runsList/runsGet` 及既有报告格式。列表以活动项目为准，解除必须先选模块的依赖。单请求／单用例沿原调试历史留存，有精确关联才显示定位。旧记录无法证明项目归属时保留兼容查看入口并注明。 | 未选模块也能查看当前项目模块、套件、工作流及压测历史。两个项目同名、缺项目 ID 的旧报告不会被错误归属。打开报告再返回保留选中项与滚动位置；空项目有「发起任务」。 |
| C02 | 在线执行面板「刷新任务／刷新间隔／最近任务」→「任务记录」列表及列表设置 | 复用 `refresh/refreshActive/setRefreshMs/inspect` 和现有本机结果缓存。代理列表标注最近 20 条；在线本机说明会话可见范围。按项目及来源的真实身份合并发起反馈与随后收到的记录，不按名称或时间去重。 | 同一代理任务从响应区、刷新后的列表进入，均定位同一执行；两次同名任务可区分。本机和代理均可读时可辨来源；切项目、重开及缓存释放后如实展示可用记录。改变刷新间隔不会增加重复轮询器。 |
| C03 | 面板的排队／取消、运行事实 → 所选任务详情；当前动作旁保留反馈 | 复用 `inspect/cancel/cancelLocal` 及原报告权限和身份校验。详情分开展示提交、请求是否发出、执行生命周期、逻辑结论、取消收束及归档。缺失字段显示「未记录」。 | 覆盖容量等待、已申请取消、已结束但断言失败、仅状态权限、报告待归档或过期。底栏切到另一环境后打开记录，仍显示原环境、位置和失败原因；快速连选两条记录不会串报告。 |
| C04 | 结果区中的证据、工作流轨迹、报告 AI 分析、压测比较与 HTML 导出、发布 → 对应结果的详情或原专用查看器 | 复用 `CaseEvidencePanel`、已有工作流／压测报告视图、`pinBaseline/exportStressHtml/analyzeReport`、原发布事件。保留原支持范围、固定基线和证据重跑确认／权限。 | 选择两份不同报告，固定第一份基线再查看第二份；导出、AI 分析及发布均引用明确所选来源。查看证据零执行，显式重跑才产生新执行。无报告权限时无法读出详情。 |
| C05 | 在线旧「定时任务」及发生历史中的原报告 →「运行 → 定时任务」及精确任务详情 | 复用 `OnlineSchedulesPanel`、`onlineSchedules` 的预览、保存／启停、刷新快照、授权、历史及分页。原报告沿 `originalJob → status → inspect`。 | 新计划先保存为暂停，单独启用；核对计划时区、下次时间、固定代理与环境。修改项目底栏后，计划及过去执行保持原值；分页仍能打开历史中的指定执行。 |
| C06 | 在线旧「通知」→「运行 → 通知」，详情依次放「查看计划」「查看本次运行」 | 复用 `loadNotifications/markRead`、投递列表与 `inspect(scheduleId)`。运行跳转复用 C05；用事件中工作区及项目在已授权项目树内解析完整上下文，再核对 `jobId + executionId`。恢复来源的选中通知、分页及滚动位置。 | 有运行、无运行、首屏 20 条之外、跨项目且有草稿、目标已删除或撤权分别核对。无完整执行关联时保留第二个按钮并就地说明原因；跳转不改已读。单次执行失败、Webhook 投递成功能同时正确显示。 |

**记录身份与历史边界。** 本地文件报告按实际归档标识定位，调试按调试历史标识定位。规划在需要时让宿主把本次已落盘文件的既有定位一并交给界面；不靠“最新一条”猜测。在线本机用项目上下文及 `runId`；代理用服务端返回的任务／执行身份，并保存本次提交与返回身份的对应关系。历史字段缺失时不以底栏当前值补写。访问控制和留存规则继续由各来源负责。

代码起点：[本地历史抽屉](../apps/desktop/src/renderer/src/components/RunsHistory.vue)、[本地历史读取](../apps/desktop/src/renderer/src/stores/run.ts)、[归档格式兼容](../apps/desktop/src/main/runs.ts)、[定时任务](../apps/desktop/src/renderer/src/components/online/OnlineSchedulesPanel.vue)、[通知与投递](../apps/desktop/src/renderer/src/components/online/OnlineNotificationsPanel.vue)、[计划和通知读取](../apps/desktop/src/renderer/src/stores/onlineSchedules.ts)、[通知关联字段](../packages/execution/src/contract/scheduling.ts)。

## 验证、独审与交接

使用专用合成数据。准备两个含同名模块及环境的项目；本地至少有子文件夹、基础／环境用例及多行数据集；在线具备一名可执行成员、一名受限成员、一个可用代理及可控的不可用状态。为通知准备有关联和无关联两种事件。可以复用 CI112 验收资源的独立副本；用户手验目录中的数据不作为可写测试夹具。

| 批次 | 定向自动验证的起点 | 集中手验与独审重点 |
| --- | --- | --- |
| 1 | 桌面 `viewSwitch.test.ts`、`moduleRail.test.ts`、`requestTabs.test.ts`、`onlineWorkspace.test.ts`、`EnvPanel.test.ts` 中与 A01–A08 对应的用例；补旧草稿迁移和迟到响应反例。 | 各打开一个本地与在线项目，对照接口样板观察导航、草稿、底栏和错误就地反馈；核对旧 11 项入口和面板控件的实际可达性。 |
| 2 | 桌面 `RunView.test.ts`、`CasePanel.test.ts`、`testingCenter.test.ts`、`wfDesigner.test.ts`、`OnlineStressPanel.test.ts` 和在线执行 store；若提取选例逻辑，定向跑 Core 的选例、递归和数据行用例。 | 用本地样板逐项对照目标列表、范围、跳过原因和按钮；用合成服务请求日志与实际报告核对 B01–B06。独审核对所有入口的准入规则和唯一发起点。 |
| 3 | 桌面 `run.test.ts`、`runs.test.ts`、`onlineExecution.test.ts`、`onlineSchedules.test.ts`、`OnlineSchedulesPanel.test.ts`、`OnlineNotificationsPanel.test.ts` 的相关用例；补跨项目精确定位和无归属旧报告反例。 | 同时制造手动、定时及有失败的记录，对照记录样板。独审核对每条读取路径、取消归属、权限与通知返回位置。结束时串走一次「改环境 → 发起 → 从原页面定位 → 看报告 → 返回」。 |

实施获准后沿用约定的开发子代理和独立审核子代理。每批由开发者提交可独立验证的改动，审查者按本批编号逐项对照迁移表；实现和审查分别记录。每项回填**提交、定向用例及结果、手验截图或日志、遗留与原因**，有未验证项时单独标出。优先复用已有测试，缺口按可观察行为补测。按[页面展示规范](ui-presentation-guidelines.md)核对可读文字、单位和实际布局。日常按影响面验证，本地全量仍需用户对该次运行另行确认。
