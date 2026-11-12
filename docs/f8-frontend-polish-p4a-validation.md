# F8 P4a 管理台逐点验证记录

2026-11-12，基线 `842645e0`；工作树 `f8-frontend-polish`。按[设计](f8-frontend-polish-p4a-design.md)完成 15 个管理页面、4 个共用字段／容量组件、2 份样式和两语言文件。业务 API、store、路由、Core、宿主和服务端未改。唯一独立审核见[回执](f8-frontend-polish-p4a-review.md)。本批仅本地提交，未合并／推送。

## 逐点对照

| 需求点 | 验收条件 | 测试与代码证据 | 实际页面证据／边界 |
| --- | --- | --- | --- |
| 工作区列表 | 角色有中文／英文含义，名称可查；创建／删除仍显式确认 | WorkspacesView 全文件；新增双语标签＋工作区选择 GET 身份，无额外写入；原删除名称确认不变 | workspace-modal-en-640x400：短高弹窗输入、取消、创建可见，取消未写入；列表横滚为 Antd 表内 |
| 成员 | 标签本地化，提交值仍 ADMIN 等原码；OWNER 禁用／转让确认、候选修订、迟到保护不变 | MembersView 全文件；新增双语原码 PUT＋expectedRevision，双语候选 EDITOR＋继承且零写入 | members-en-1280：英文下拉完整；修前图显示原110／120px截断，改220px后关闭 |
| 项目 ACL | NONE 明确拒绝与删除恢复继承分开；候选和当前角色完整可读 | ProjectAclView 全文件；双语 NONE PUT＋expectedRevision／零DELETE；候选 NONE+active 双语，保留原CAS和候选代次测试 | acl-role-en-640：完整 Deny access (NONE)、Administrator (ADMIN)，说明与表内横滚保持 |
| 用户 | 平台／普通用户标签本地化，管理动作和超管路由不变 | UsersView 全文件；新增双语无账号写入；原停启用、创建、验活／路由守卫仍验 | users-en-640：长角色随表局部横滚，不以根页面撑宽容纳 |
| 组织 | 分组具名按钮可键盘选择，长名可悬停、默认组禁用和管理入口保留 | OrgView 全文件；双语button/type/aria-pressed、目标项目、零写入和默认组限制 | org-zh-1280／640；Enter选择目标分组，只改变项目展示；项目操作按钮换行 |
| 平台／工作区代理 | 原生控件与卡片统一；保存与实际应用分开、未登记不当在线；容量单位与排空可读 | AgentsView 全文件；登记／撤销／授权、配置、版本、单位与并发预算原测试保持 | agent-pending-zh-1280：保存2／已应用1、待应用字段、未登记及3/2进程排空分开；workspace-agents-en-1280：单位／继承可读 |
| 项目代理／脚本批准 | 项目候选范围、批准版本／指纹与风险可读，保存确认不改 | ProjectAgentsView 全文件＋StressCapacityView 调用路径；无权全局节点、批准CAS、真实脚本版本与风险确认保留 | project-script-zh-1280：脚本风险说明、批准版本与输入表可读；真实权限写入不由合成浏览器证明 |
| 调度策略／授权 | 单位、范围、继承和生效时机可读；不合格授权禁用并显示理由 | SchedulePolicyView、ProjectScheduleGrantsView 全文件；旧草稿、冲突、候选资格与原控制身份不变 | schedule-policy-zh-1280／schedule-grants-zh-1280：多列局部滚动，角色／停用／项目不可读理由直显 |
| 通知渠道 | 列表、编辑、一次写入材料和风险提示区分；取消与旋转保持 | NotificationChannelsView 全文件；不修改 URL／密钥保存、版本与删除确认事件 | notifications-en-1280／notification-form-en-640：编辑草稿布局；未保存材料、未调用通知接收端 |
| 同步策略 | 保存／继承／实际有效值、范围、部署限额保留；长表仅局部滚动 | SyncPolicyView 全文件，末轮19项；真实重试／对账意图不改；只为隐藏辅助标签建立原滚动容器定位上下文 | sync-policy-overflow-before 根625/1543；修后sync-policy-en-640 根625/625，表344/1566；540聚焦输入根525/525、scrollX0，只有表横移 |
| 同步管理 | 有效角色、不可读／未采集、材料安全状态与失败原因可读 | ProjectSyncAccessView 全文件，管理目录不代表内容权限、NONE/迟到响应／冲突草稿保持 | sync-access-en-640：多表独立横滚，无整段JSON；没有真实SSH或同步读取 |
| 协作管理／字段组件 | 配置与资源为表格，审计原始数据默认折叠；显式保存和身份绑定不变 | CollaborationView 全文件，覆盖CollaborationAccessTable／PolicyTable直接调用；原授权对账、scope变化和拒绝保留 | collaboration-en-640／collaboration-policy-zh-1280；只读加载审计，audit-raw无open属性；未创建／轮换／撤销真实授权 |
| 登录／布局 | 统一登录卡、宽窄顶栏与菜单；认证／注册和角色导航不变 | LoginView、LayoutView 全文件，App实际语言与Antd提供器用于浏览器 | login-en-640x400、540宽布局；未输入真实凭据，不替代原生或真实服务认证验收 |

## 运行与失败记录

日志与21张JPEG在 [P4a证据目录](design/f8-frontend/p4a/)，复现场景夹具在其中 fixture；截图尺寸另存 image-metadata.json。

1. 角色／组织新增10项在实现前失败，85项未选，13.04秒：presentation-red.log。失败为缺本地化标签／具名分组按钮。
2. 15个具名受影响视图文件共272项，首次260通过／12失败，20.66秒：targeted.log。不是全管理台／全工作区测试，未执行API/store/e2e套件。12项为原业务行选择器把新增Antd横向滚动的隐藏测量行算入，以及旧角色显示预期不符；保留原业务行数、对象身份、写入和状态断言，仅改为 `tbody tr[data-row-key]` 和完整本地化预期。4文件78项通过，13.29秒：targeted-correction.log。
3. 独审指出两个候选摘要仍裸角色码；最初候选夹具把工作区响应设为NONE，且项目状态设为confirmed/explicit-none，不是对应后端真实前提。两份原失败日志保留但不计有效先红。改为工作区null+inherited、项目NONE+active后，4项仍因标签缺失失败：candidate-contract-red.log，6.49秒；此时尚未修改对应产品代码。修后成员／ACL两文件59项通过，12.84秒：candidate-green.log。其余无关已过文件未重跑。
4. 浏览器发现英文角色宽度截断和同步页隐藏标签脱离局部滚动容器，均先保留实际截图，随后最小CSS修正。最后同步视图19项通过，3.60秒：sync-final.log。最终管理台构建包含 `vue-tsc --noEmit`、节点配置tsc及Vite构建，全部通过：build-final.log。500kB分块提示及jsdom伪元素提示保留。
5. 本组最终 **276项去重受影响用例通过**（原272＋候选4），不是某次单次全绿，也不把重复78/59/19累计为更多覆盖。最终 `git diff --check` 通过；新增adminRoles双语键一致。

未运行本地全量、Java全套、完整CI或新打包。没有将提交授权当作本地全量授权。

## 真实页面与剩余边界

浏览器用真实管理台App、router、stores和组件；fetch为合成只读适配，未连接真实管理服务。21图包含19张最终图与2张修前图；回执 captures 是几何采样，不逐一覆盖所有图。org-zh-640-transient-measurement-only是视口刚变更时的测量，不对应最终截图。最终同名图在渲染稳定后重拍。

合成夹具曾缺代理stressConfiguration四项来源、并给严格项目投影多传revoked，被真实schema拒绝；修正后再验。夹具错误不计产品通过或失败。Antd选择容器不接受press(Escape)的工具操作失败后，改点击标题关闭；不解释为产品键盘缺陷。项目agent截图最终无契约错误。

全程Vite尾段保留 **8次 ResizeObserver未交付通知**（跨初次渲染和夹具HMR重载），最终文档内计数为3，不应当作全程总数。未观察到空白或操作阻塞，根因未定；与P3h同类观察一起留P5核对原生／生产壳，不宣称零控制台错误。临时页关闭、视口恢复、Vite正常中断收尾、63578无监听。

管理台本组已完成；前端还余 **2环**：公共／离线页面（含共享DocumentPreview长指纹／状态），然后原生集中验收与统一新包。原生287px／系统缩放／真实拖动／完整IPC仍待P5。旧P2 ZIP不含P3和本批P4a，未把旧包当作本批交付。
