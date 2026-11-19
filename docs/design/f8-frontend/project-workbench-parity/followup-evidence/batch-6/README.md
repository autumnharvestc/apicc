# 第六批 · Windows 实机联合验收

正式 Electron 客户端使用两份独立本地订单项目、真实 HTTPS 控制服务、Linux 代理及独占的合成 HTTP / Webhook 接收器。十四个定稿场景全部在渲染源码树 `726feb8d9a652d6d7c83b41cda0e08f8eec5ac63` 的正式产物 `index-BkY8mlgT.js` 上重新采集。主桌面运行本轮通过 `tsc -p tsconfig.electron.json` 编译的主进程。标准图使用中文亮色、1114 × 627 CSS 视口，设备像素比 1672/1114，单帧 PNG 为 1672 × 941。坐标为当帧 DOMRect 换算后的物理像素。[十四场坐标](final/geometry.json) · [单断言坐标](single-assertion/geometry.json)

| 定稿 | 同候选实机 | 实际选择 |
| --- | --- | --- |
| T01、T02 | [在线单断言](single-assertion/T01-online-case.png) · [本地单断言](single-assertion/T02-local-case.png) | 查询订单／已付款订单；回归、订单样本、状态码等于 200。两端由客户端实际保存，关闭保存反馈后采集；标题 y69、页签 y136、响应提取 y667、后置操作 y795。取证后按当前版本恢复两端原来的双断言，并回读原值。[在线双断言](final/T01-online-case.png) · [本地双断言](final/T02-local-case.png) |
| T03、T04 | [本地已选](final/T03-local-selected.png) · [在线未选](final/T04-online-unselected.png) | 已选样本 3 行 × 2 列，另一端只显示选择指引。 |
| T05、T06 | [在线套件](final/T05-online-suite.png) · [在线压测](final/T06-online-stress.png) | 订单回归按正常创建→已付款订单排列；订单查询压测为 5 VU、30 秒，当前真实合成目标与本机位置待确认。 |
| R01、R02 | [在线](final/R01-online-case.png) · [本地](final/R02-local-case.png) | 同为已付款订单、集成环境、本机。两卡从 y204 延伸至 883，底栏 y896。 |
| R03、R08 | [本地模块](final/R03-local-module.png) · [在线空选](final/R08-online-empty.png) | 递归模块下 3 个接口／2 个适用用例，可见跳过原因；空选页禁用运行。 |
| R04、R07 | [在线](final/R04-online-record.png) · [本地](final/R07-local-record.png) | 同一工作流的两个真实失败，均见失败节点和已归档状态，实际环境与底栏当前选择分别显示。 |
| R05、R06 | [在线计划](final/R05-online-schedule.png) · [在线通知](final/R06-online-notification.png) | 计划 2 每日 02:00，服务器两条候选可读；同一事件 2 的运行失败、快照等待归档、Webhook 外部已确认／1 次／HTTP 200。R06 使用同项目 Viewer 的未读视图。 |

每张 PNG 均按全幅复核，包括 T04 的右半部、下半部、顶栏及底栏。案例数、同名条目数、项目签与定稿示意图有差异；实际选择、所在主机和历史记录见表内说明。

### 五条联验

| 操作 | 实机结果与台账 |
| --- | --- |
| 三项目往返 | 本地 1→本地 2→在线→本地 2→本地 1→在线。前者查看「本地 1」环境但运行底栏为「无环境」；本地 2 选「订单样本」、集成环境；在线选失败归档 `1/9/10`、代理环境。六次位置回读全部一致，业务 HTTP 35→35，代理任务 4→4。[本地 1](roundtrip-1-local1.png) · [本地 2](roundtrip-2-local2.png) · [在线](roundtrip-3-online.png) |
| 数据集取消切换 | 两端选原「订单样本」，键入未保存名称，再点另一同名 ID。拒绝系统确认后原 ID 及输入值仍在；同意弃稿后才切到另一 ID，再点同一行清空。全程 39 / 4 保持不变。 |
| 从已存用例发起后定位 | 两端各显式执行已付款订单一次，集成环境／本机。每次产生 2 次 GET /orders/ORD-1001、HTTP 200，业务 HTTP 合计 35→39，代理任务保持 4。本地「查看本次运行」选中调试历史 `01fe80f6-ab5b-4221-8b55-5ad50670f230`，显示 2/2。在线选中 `61268880-e82c-4c64-bc67-a621c67c3744`，回执显示已结束、已接收、通过、已启动；两次请求在接收端最终回读确认。 |
| 从通知定位并返回 | 同一真实事件 2 打开原记录 `1/9/10`、返回原通知，再打开计划 2、返回原通知。Owner 在上个冻结产物 `index-BNymIiSc.js` 完成这两个入口后仍未读，显式点击「标为已读」才改变该成员状态，服务端回读为 `true / failed / pending`，投递仍为 `acknowledged / 1 / 200`。在本次最终产物中重新走完两条路线，同项目 Viewer 仍保有自己的未读状态。两次取证前后均为 35 / 4。 |
| 压测改变目标后重确认 | 真实选中 `order-lookup-preview`，初始禁止运行；填入本机合成目标、确认后可运行，单独确认没有发包。将目标改成「健康检查／正常响应」，按钮立即禁用，再切回旧目标也需重新确认。期间 35 / 4 保持不变。 |

### 旁注、原档与键盘

- 主页 [本地前](before-home-local.png)／[后](after-home-local.png)、[在线前](before-home-online.png)／[后](after-home-online.png)；项目工具 [本地前](before-project-tools-local.png)／[后](after-project-tools-local.png)、[在线前](before-project-tools-online.png)／[后](after-project-tools-online.png)；[设置前](before-settings.png)／[后](after-settings.png)；同一在线「两轮订单链路」[压测前](before-online-stress.png)／[后](after-online-stress.png)。这六组均为 1672 × 941、100% 的前后实拍；后图复用第六批首个可用产物 `index-CwFMAlF6.js`。不同测试阶段项目标签与样本数量有变化。
- [调试历史前](before-local-debug-history-exchange.png)／[最终后图](after-local-debug-history-exchange.png)使用同一磁盘记录 `ec3cc565-79b7-4748-a4fa-2cc2086605e5`。之前首屏直接列出 sourceKind、locator 等产品内部身份，最终首屏显示请求、进度、HTTP 200、3.73 ms、采集来源；请求/响应原文与完整交换分别收折。切 #2 后显示 2.05 ms，前一次展开的原始交换自动收折。从双交换的 #2 直开只有一次请求的 503 后，选择框与正文均回到 #1。最终候选重新从历史打开同名的两条失败记录之一，选中行独有蓝色边线及 `aria-current=true`；打开与查看 39→39、4→4。[503 原档](history-503.png)
- 另一份最初的合成桌面档案 `d473cb4c…` 来自 11 月 19 日，格式版本 2 且交换数组为空。用最终候选读取原文件，显示「没有可显示的交换记录」，以及当前资产已经变化的提醒。[无交换旧档](old-record-no-exchange.png)
- [英文深色的长名称草稿](english-dark-narrow-dataset.png)为 780 × 720。保存与底栏均可命中，滚动表格时 scrollLeft 0→46，底栏保持 y690，草稿已放弃。[同尺寸空目标](english-dark-narrow-empty.png)使用最终产物：从活动页签按 Tab 经任务记录至清空按钮，Enter 清空，再 Tab 经任务类型到搜索框。右栏显示选择用例的指引，运行按钮禁用，39 / 4 保持不变。
- [只读说明焦点](viewer-readonly-focus.png)来自真实 Viewer，活动侧栏后 Tab 三次即达说明；名称与保存均禁用。[撤权恢复焦点](viewer-access-recovery-focus.png)来自该成员离开项目后真实撤权，原编辑区和项目状态栏已撤去。从项目签 Tab 九次至「返回项目列表」，Enter 返回原在线工作区，只出现可读的兄弟项目；最后恢复原继承权限。两张焦点图取自第六批首版。
- [停止的 Mock](mock-stopped.png)可见「已停止」、可用的启动按钮、禁用的停止与重新加载、收折的高级 JSON。[代理执行详情](agent-script-details.png)显示实际脚本时限 3000 ms，选本机时没有代理审批入口；选合成 Linux 代理后审批风险默认收折，展开会显示 Viewer 的权限原因。[工作流请求节点](workflow-request-node.png)显示真实绑定「查询订单／已付款订单」，节点策略、错误处理和收尾可达。这三张及英文长名称草稿取自 `index-BNymIiSc.js`，该产物与最终产物的渲染源码差异仅为 DebugHistory 的选中样式与 aria-current。
