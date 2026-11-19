# 本地与在线项目工作台验收记录

实施分支为 `codex/f8-frontend-polish`，从 CI112 的 `cb4fe63d` 开始。[实施计划](f8-project-workbench-parity-plan.md) · [设计与样板](f8-project-workbench-parity-design.md)

## 逐项对照

| 用例 | 已走通的路径 | 验证依据 |
| --- | --- | --- |
| A01 | 从在线项目进入「接口」，未选接口时显示目录指引；选择已有接口后可编辑。空项目、只读成员和旧格式各走原入口。 | 原生在线首屏和目录选择；`viewSwitch.test.ts`、`onlineWorkspace.test.ts`、`App.test.ts` 的目录、权限及迁移用例。 |
| A02 | 两端底栏显示当前项目的环境。切模块保留选择，失效环境可识别。 | `moduleRail.test.ts`、`App.test.ts`；本地原生窗口从测试页转入运行页，合成服务收到所选预发布环境的请求。 |
| A03 | 接管旧请求签时区分原环境和当前项目环境。取消保留草稿，两边一致后才按确定的环境发送。 | `App.test.ts` 验证没有旧环境、旧环境被删、自由请求和有冲突的草稿，包含取消时没有请求的断言。 |
| A04 | 在线可从底栏选择本机或代理、查看执行详情。不可用代理保留标识和原因。 | `moduleRail.test.ts`、`onlineExecution.test.ts`；在同一真实在线项目依次选本机和 Linux 代理完成订单工作流。 |
| A05 | 当前接口可发送本次编辑快照、新建调试会话、查看结果并取消在途执行。 | `onlineWorkspace.test.ts` 核对当次快照和没有附带保存；`onlineExecution.test.ts` 覆盖捕获的执行身份、取消及结果归属。 |
| A06 | 从侧栏打开用例、套件、数据集和工作流，沿用原编辑器及保存宿主。 | `onlineWorkspace.test.ts`、`testingCenter.test.ts`、`wfDesigner.test.ts`。覆盖跨页草稿、项目环境、工作流和用例的原执行入口。 |
| A07 | 从接口认证面板编辑凭据引用，从项目工具进入项目材料、协作与分享。 | `onlineWorkspace.test.ts` 验证认证保存重开、合成附件上传/版本/字节数/绑定、Viewer 门控；`App.test.ts`、`CollaborationPanel.test.ts` 核对分享入口和来源。 |
| A08 | 压测归入测试，定时任务及通知归入运行。修改底栏不会覆盖保存的计划。 | `OnlineStressPanel.test.ts` 覆盖保存计划、单次确认、脏草稿及精确停止；在线实机从两份执行记录进入计划和通知。 |
| B01 | 本地模块预览列出所选环境适用的用例、子文件夹和跳过项，版本过期需重新确认。 | `main/debug.test.ts` 的 B01 用例。3 条有效用例产生 4 次真实 HTTP 请求，包含 2 行数据；过期版本收到 0 次请求。另用 Electron 合成项目验证 3 个接口、6 条用例的列表与报告。 |
| B02 | 单接口用例按已保存用例和环境身份发起。查看范围不会装入并覆盖现有编辑草稿。 | `RunView.test.ts`、`OnlineRunLaunch.test.ts`；两个同名环境用不同的真实 HTTP 服务和变量验证各自的目标。 |
| B03 | 套件预览与发起共用保存的定义、环境及数据集；再次确认当前范围。 | `RunView.test.ts`、`OnlineRunLaunch.test.ts`、`testingCenter.test.ts`。覆盖另一套件的草稿和套件原页查看此次结果。 |
| B04 | 工作流使用已保存版本和本次输入。原页和集中入口按同一工作流身份执行。 | `wfDesigner.test.ts`、`RunView.test.ts`；原生在线窗口两次执行创建订单→提取订单 ID→查询订单，分别在桌面及代理网络收到请求。 |
| B05 | 压测沿用目标来源确认、worker 限制及保存计划，停止绑定发起该次执行的计划。 | `OnlineStressPanel.test.ts`、`stressWorkbench.test.ts`、`OnlineRunLaunch.test.ts`。用定义相同、ID 不同的计划复核原页不能误停另一计划。 |
| B06 | 发起反馈可打开该次运行，切换目标和迟到响应按归属处理。提交结果不确定时可查询原提交。 | `RunView.test.ts`、`OnlineRunLaunch.test.ts`、`onlineExecution.test.ts`、`main/online/execution.test.ts`。区分已明确终态与仍未确认的执行事实。 |
| C01 | 无需选模块即可查当前项目档案，旧档归属不明时单列。打开档案会复核文件及完整项目身份。 | `runs.test.ts`、`LocalRunRecords.test.ts`。同名项目、文件被替换、缺少归属证明分别验证；实机直接从模块结果定位档案。 |
| C02 | 在线记录区分本机会话和服务端最近任务，对同一执行精确归并。 | `onlineExecution.test.ts`、`onlineWorkspace.test.ts`；在线实机列表同时出现同一工作流的本机与代理执行，进入原报告不重放。 |
| C03 | 任务状态、请求执行事实、逻辑结论与失败原因分别展示。取消和详情读取使用所选执行。 | `onlineExecution.test.ts`、`OnlineStressPanel.test.ts`；实机定时失败报告同时展示「已结束」「失败」「已归档」及断言失败原因。 |
| C04 | 所选报告仍可用原证据、AI、固定基线、导出和发布功能。失去历史权限后收回缓存和比较基线。 | `AiReportAnalysis.test.ts`、`reportPresentation.test.ts`、`OnlineStressPanel.test.ts`、`main/online/collaboration.test.ts`。读取或发布前再次确认归属及权限。 |
| C05 | 从计划发生历史按原作业、执行及代理定位报告。底栏选择与计划保存值分别显示。 | `OnlineSchedulesPanel.test.ts`、`onlineSchedules.test.ts`；实服创建合成计划，确认首次保存为暂停，单独启用后取得故意失败的归档及通知。 |
| C06 | 通知可分别查看计划和本次运行，返回来源时保留位置和已读状态。无执行关联时第二个入口禁用。 | `OnlineNotificationsPanel.test.ts`、`App.test.ts` 覆盖首屏外、跨项目、撤权、删除和主动改签；实机两次跳转再返回原未读通知，合成接口请求数未增加。 |

## 集成与复核

开发按工作台、发起任务、任务记录分工。三个主体提交为 `f1b7f297`、`115b29ac`、`b1ae5b0c`。首批工作台和任务记录在提交时引用了稍后才提交的组件，未达到计划中“逐个提交可独立构建”的要求。测试和构建结果归属于三批合齐后的集成工作树。

独立审核逐项核对了执行来源、身份绑定、跨项目通知、撤权、同名环境、归档替换与草稿。修正包括精确读取归档、按原提交查询、通知目标失效返回来源、原入口查看本次运行，以及在权限收窄后撤去缓存。开发与独审的定向测试有重叠，计数按实际运行分别记录。

实机使用专用桌面用户目录与工作区副本。在线使用回环 HTTPS 服务、专用测试 CA、单独的 Linux 代理及合成订单服务。失败样本分别来自返回 HTTP 503 的接口、预期不满足的断言。

## 集成版本实机验收

产品代码版本为 `7ecd2a86`。本地及在线均以 Electron 打开桌面构建产物。下表链接指向验收时拍摄的窗口。

| 实际操作 | 观察结果 | 实拍 |
| --- | --- | --- |
| 本地切换项目环境，预览模块，再确认运行 | 预览列出 3 个接口、6 条用例。预览期间合成服务收到 0 次请求，确认后实际请求到达所选环境。 | [模块发起预览](design/f8-frontend/project-workbench-parity/acceptance/local-launch-preview.png) |
| 从本地结果定位档案，切到英文暗色并缩小窗口 | 打开此次归档后，请求日志没有增加。780 × 720 窗口内可辨认列表、选中记录和详情。 | [归档详情](design/f8-frontend/project-workbench-parity/acceptance/local-archive-detail.png) · [英文窄窗](design/f8-frontend/project-workbench-parity/acceptance/local-records-en-dark-narrow.png) |
| 在线打开项目，从接口目录选择健康检查，将草稿路径改为故意失败的接口并发送 | 首屏指向接口目录。请求发往本次输入的路径，客户端显示 HTTP 503、耗时、响应大小和响应正文。服务端项目版本与发送前一致。 | [中文接口编辑器](design/f8-frontend/project-workbench-parity/acceptance/online-api-editor.png) · [英文暗色响应](design/f8-frontend/project-workbench-parity/acceptance/online-editor-en-dark-narrow.png) |
| 在同一在线项目分别选本机和 Linux 代理，发起同一订单工作流 | 两个位置均先创建订单取得 HTTP 201，再用响应提取的 ID 查询刚创建的订单。底栏切换后，在发起区可以核对本次位置和环境。 | [代理发起预览](design/f8-frontend/project-workbench-parity/acceptance/online-agent-launch.png) |
| 从未读通知分别打开本次运行与原计划，再返回 | 记录选中原代理、作业及执行号。可辨认任务结束、断言失败、报告已归档三个状态。两次返回都回到原未读通知，合成服务没有收到新的业务请求。 | [通知](design/f8-frontend/project-workbench-parity/acceptance/online-notifications.png) · [对应执行](design/f8-frontend/project-workbench-parity/acceptance/online-notification-result.png) · [对应计划](design/f8-frontend/project-workbench-parity/acceptance/online-plan.png) |
| 代理接受慢请求后关闭桌面，等请求完成再重开 | 桌面进程退出期间，合成服务收到代理的慢请求并返回 HTTP 200。以同一桌面用户目录重开，任务记录能读取原作业与执行号的归档，查询过程没有重发请求。 | 以代理接单前后的列表、合成服务日志、重开的实际归档三个观测点核对。 |

## 定向检查与复查

- Node 22.19 下集中运行 15 个桌面测试文件，492 项通过。范围为 App、工作台导航、发起任务、任务记录、在线通知与计划、压测、归档读取、预加载接口和历史身份匹配。
- 再检查原业务入口及宿主的 12 个测试文件，441 项通过。范围为请求签、环境管理、测试中心、用例、工作流设计器、压测工作台、在线计划、协作、AI 报告与报告展示，以及在线执行和协作的主进程入口。两组共 27 个不同测试文件、933 项通过。
- 单独运行模块预览与同名环境的两个回环 HTTP 用例，2 项通过。Core 环境继承与选择用例 4 项通过。
- 桌面 Vue 类型检查、渲染进程构建、Electron 主进程与预加载构建通过。品牌中立检查通过。此次按受影响范围验收，本地全量和远端 CI 均未运行。
- 原生脚本第一次复开时误把项目恢复过程判断为已停在主页，因等待主页刷新按钮而超时。调整探针等待已恢复的项目底栏后，整个在线流程一次通过。实现代码未因这次探针超时而调整。
- 独审复核了在线编辑器、自由请求转换、回执归属、历史记录元数据四组修正。历史调试名称须同时匹配完整接口位置、用例范围或自由草稿身份。审核者的 7 项定向用例通过，未重复计入集中回归数量。

## CI113 复盘补验

CI113 对应提交 `cb81b31f`。四份任务日志中，品牌检查通过。Linux 包测试、Java 服务端和 Windows 打包均在 `generate-java-boundary.mjs --check` 退出。Maven 用例、桌面打包及后续部署在该次 CI 中没有运行。

| 前次验收漏项 | 修复与针对性复验 |
| --- | --- |
| `dd5db787` 修改环境继承、执行环境选择和工作流取值，影响协作运行时使用的 Core 字节指纹。 | 用正式生成器更新 Java 资源。两次生成字节一致，输入及同步两份 Java 边界检查均通过。另用 Linux 协作镜像从源码构建，以及 Java 调用真实 Node 运行时复验。 |
| 桌面只做过 Vue 类型检查和分项构建，CI 还运行普通 `tsc`，测试夹具展开完整工作区类型触发 TS2589。 | 夹具从项目树读取定位符。已有显式项目的用例继续使用原定位符。Windows 桌面正式构建、目录包和打包冒烟通过，Linux 桌面普通类型检查也通过。 |
| 不确定调试请求的旧缓存用例仍期待无需确认即可重发。 | 覆盖缺少确认、明确拒绝与明确同意三种情况，核实 RPC 次数和提交身份，同时区分保留会话与手动新建会话。 |
| 工作流报告捕获、内存归档和磁盘正文的字段边界不一致，部分测试还按目录文件数或枚举顺序查报告。 | 捕获与写入共用最终脱敏正文，项目归属单独交给存储。调用方以回执的文件名查正文和归属证明。定向验证保留了断言结果、归档归属和凭据脱敏检查。 |

复验结果包括 Linux 桌面 6 个文件 136 项、Windows 渲染及产物依赖检查 5 个文件 112 项、Core 环境及工作流 99 项、Java 边界与真实协作调用 54 项，均通过。Windows 新目录包实际启动通过。跨平台结果分别计数，同一行为会有覆盖重叠。

后续只要改动 Core 的运行时代码，在重新构建 Core、execution 和 collaboration-runtime 后即可执行 `node apps/collaboration-runtime/scripts/generate-java-boundary.mjs --check`。改动桌面测试夹具时，使用桌面包的 `typecheck` 核对普通 TypeScript 路径。两项检查都可在推送前单独执行。
