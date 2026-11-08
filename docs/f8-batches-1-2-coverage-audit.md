# F8 第一、二批：需求—验收—测试—证据对照与 CI96 缺口

核查日期：2026-11-08。被核查提交为第一批 `3c8503b4`、第二批 `49e06023040f287760c9780cf518e467726dec05`；CI96 四份日志的 checkout 身份均为后者。本次在 `codex/f8-coverage-ci96-audit` 分支推进，不使用 superpowers skill。首轮只做核查；随后用户明确批准先修 CI96/相邻链路、按计划补验、独审后提交/合并/推送，禁止全量。原 64 点表及原计划保留为 `49e06023` 的基线，当前进度以末尾逐项更新为准。

本文件补齐此前缺失的逐点追踪表，不把此前的文件级审查、通过总数或构建成功等同于验收条件全部覆盖。需求基线分别为 [第一批边界](f8-defect-closure.md)、[用户批准的第二批方案](f8-lifecycle-stability.md)，并核对 `backlog.md` 的 LOW-001/002/003、F3/F5 原登记及页面展示规范。原始记录保持原样；其中“未提交/未推送”是当时冻结状态，实际两批已于 2026-11-07 合并并推送，本轮开始时远端候选为 `49e06023`。

## 判断口径

- **有证：** 找到直接覆盖所述条件的测试及已运行结果；仅对该条件有效，不代表所有异常组合均覆盖。
- **部分：** 只验证了其中一层、部分条件、替身或注入路径，明确列出缺口。
- **失败：** 当前候选有明确失败，不能以相邻绿色用例覆盖它。
- **未关闭：** 现象或根因尚未解决。有限观测通过不能关闭历史风险。
- **延期：** 用户已划到第三/四批或原方案排除的内容，不将其混作两批已完成成果。

所有本地原始证据路径相对于本工作树。选用名称过滤时，未选项不能算通过；不同版本、不同轮次结果不拼成一次全绿。下表中的短用例名是源码/原始结果中的可检索片段，不是新造的测试名。

基线逐点结果为：64 个核查点，45 个有直接证据、16 个部分覆盖、2 个回归失败点（对应三条 CI 用例）、1 个未关闭风险。这是修正前的业务验收核查分类，不是代码覆盖率；当前补验结果见末尾逐项表，延期内容另列，不纳入“已完成”数量。

## 证据索引

| 编号 | 实际证据与范围 |
| --- | --- |
| E1 | `local/f8-defect-closure/login-green-02.json`：50 通过/65 未选；包含 `LOGIN-001`、正常登录/注册/恢复和连接管理选择项。 |
| E2 | `local/f8-defect-closure/login-workspaces-green.json`：33 通过/12 未选；工作区自动加载及旧列表迟到结果。 |
| E3 | `local/f8-defect-closure/login-late-success-verification.json`：6 通过/20 未选；同 URL 迟到成功与相邻迟到失败。 |
| E4 | `local/f8-defect-closure/report-download/green/result.json`、对应 Surefire XML 及 `conclusions.json`：4 个具名真实 Java 方法；红证据另在 `red-body/`。 |
| E5 | `local/f8-defect-closure/ui-defects/registered-green.log`、`registered-ui-report.md`：8 通过/210 未选；实际选择器与文件已记录。 |
| E6 | 同目录 `affected-regression.log`：96 通过/1 失败/135 未选；旧历史展示断言修正后 `history-assertion-final.log` 为 2 通过/8 未选。不拼成单次 98 全绿。 |
| E7 | 同目录 `p2-focused-green.log`：3 文件、8 通过/83 未选；真实 Core 非空套件、真实 App 设计保存及相邻断言。 |
| E8 | `local/f8-defect-closure/visual-report.md`、6 张 PNG 与 `review.md`：真实 Vue 组件/online store，合成 API 和静态视觉报告；不是原生认证联验。 |
| E9 | `local/f8-lifecycle-stability/cache/final-owning-green.json`：onlineExecution 拥有文件 29/29；原始 RED 和无效夹具失败分别保留。 |
| E10 | `local/f8-lifecycle-stability/cache-ui/ui-final-green.log`：TopBar 9、设置 5、locale parity 5，共 19/19；有真实 store/存储接线。 |
| E11 | `local/f8-lifecycle-stability/ledger/green-ledger-config.log`、`.json`、`candidate-manifest.json`：ledger/config 40/40，原始日志是汇总格式；逐条断言须连同已冻结测试源码读取。 |
| E12 | 同目录 `green-recovery.log`、`.json`：4 通过/6 未选；启动压缩开/关及两项恢复/报告重试。 |
| E13 | `local/f8-lifecycle-stability/schedule/diagnostic-01/`、`green-isolated-01/result.json` 和鲜 XML：可控反例 1 失败/1 正控，最终拥有类 51/51。 |
| E14 | `local/f8-lifecycle-stability/cancel/report.md`、`events.jsonl`、`observed-manifest.json`、`restored.json`：带观测两场景通过；正式测试恢复后未重新执行，不是修复证据。 |
| E15 | `local/f8-lifecycle-stability/visual-result.json`、中英文 PNG；560px 真实设置组件+store，合成无网环境，非原生完整抽屉联验。 |
| E16 | 两批各自的类型/构建回执、冻结清单与 `review.md`；第二批最终三步 `final-desktop-checks.json` 全部 exit0。只证明相应检查，不证明所有交互。 |
| C1 | 用户提供 `D:/workspace/project-2/apicc/local/ci96-test.log/3_SDK 与各包 build + test.txt`：桌面 3 失败/2257 通过/2 跳过；失败栈 27721–27771 行，汇总 27773–27775 行。 |
| C2 | 同目录 `2_服务端测试.txt`：13506–13509 行，2197/2197、BUILD SUCCESS；ExecutionRetentionTest 4/4（9946 行），ScheduleOccurrencesTest 51/51（9314 行）。启动失败字样出现在预期拒绝夹具中，不是该任务失败。 |
| C3 | 同目录 `1_Windows 打包冒烟.txt`：360 行“打包冒烟全部通过”；仅启动/产物冒烟，不能代替功能验收。 |
| C4 | 同目录 `4_品牌中立门禁.txt`：150 行品牌扫描通过。部署任务依赖包测试成功；现有日志没有部署执行通过证据。 |
| N1 | 本次仅运行 CI96 的三条原失败用例：`local/f8-coverage-ci96/ci96-three-cases-red.json`、`.log`、`ci96-three-cases-command.json`；Windows 固定工具链、同一提交，3 失败/0 通过/123 未选、exit1，约 13 秒。没有产品/测试修改，没有全量。 |

机器可检索的已有 Vitest 逐条结果另提取至 `local/f8-coverage-ci96/existing-test-evidence.json`；它只索引现存 JSON，不把汇总日志或未记录的测试补造成逐项通过。

## 第一批逐点对照

### 登录、目标与异步归属（LOGIN-001）

测试目录简写：D=`apps/desktop/tests/renderer/`。

| 点 | 需求与验收条件 | 测试/实际检查 | 证据 | 判断与缺口 |
| --- | --- | --- | --- | --- |
| B1-01 | 零连接时顶栏进入管理连接，不出现可提交的无目标认证框 | D/App.test.ts `topbar with no connection opens Home connection management` 已过；旧 components.test.ts `在线入口：未登录显示` 仍断言 dialogOpen=true | E1、C1、N1 | **失败：** 新行为有正证，但受影响旧入口断言遗漏，G01 |
| B1-02 | 已保存目标时正常进入登录；零连接分支不能破坏有连接分支 | D/OnlineLoginDialog.test.ts 正常打开/提交已过；TopBar 旧综合用例在零连接断言处中断，没有直接核对“保存后再次点顶栏打开” | E1、C1 | **部分：** 缺 TopBar 两分支同一契约的直接核对，G01 |
| B1-03 | store 拒绝向未保存地址登录/注册，不能发送认证 RPC | D/stores/online.test.ts `refuses login and registration for an address that is not a saved connection` | E1；C1 中该文件 21/21 | **有证：** renderer port 边界；不是主进程鉴权证据 |
| B1-04 | 对话框明确显示目标名称与地址，中英可读、长名称可查 | D/components/OnlineLoginDialog.test.ts `clears credentials and errors on switch/reopen` 同时核对目标；集中截图 | E1、E2、E8 | **有证：** 当前正常组件宽度；极小窗口延期 |
| B1-05 | 关闭重开及 A→B 清账号、密码、注册显示名称、错误和成功提示，不留到新表单 | 同文件 `clears credentials and errors on reopen/switch`，核对账号/密码、错误及 store 不含密码；注册显示名称与已有成功提示清除只经源码核对 | E2、E8；C1 该文件 26/26 | **部分：** 登录表单有证，注册页全部临时字段/成功提示缺直接断言，G10；main token 另见 B1-12 |
| B1-06 | 删除目标立即移除认证输入、提供管理连接，不继续认证旧目标 | 同文件 `deleting the target removes credential inputs` 与 `without a saved target` | E2 | **有证：** 删除后可见界面/入口 |
| B1-07 | 同 URL 重开后，旧 login/register/resume 失败不污染新窗口 | 同文件参数化 `ignores a late %s failure after closing and reopening the same target` | E2、E3 | **有证：** 三种失败均测 |
| B1-08 | 同 URL 重开后，旧 login/resume 成功不替换新会话；旧注册成功不提示到另一目标 | 同文件 `late %s success cannot replace` 两参数、`does not show late registration success in another connection` | E3 | **有证：** renderer 成功回包归属；main token 另见 B1-12 |
| B1-09 | 登录/恢复在窗口打开后完成，自动加载当前工作区 | 同文件 `loads current workspaces when login/resume completes after the dialog opened` | E2、E8 | **有证：** 真实 store，合成 API；两个完成入口均测 |
| B1-10 | 旧目标工作区列表成功/失败、注册能力探测迟到，不污染当前目标 | D/stores/online.test.ts `ignores late workspace success/failure`；对话框 `探测注册能力…忽略…迟到结果` | E2、E1 | **有证：** 成功/失败和独立探测代次 |
| B1-11 | 正常登录、注册、恢复、退出仍可用；注册不建立登录态，草稿确认保留 | 对话框及 online store 的原正常流程、注册开关/校验、登出前草稿三条 | E1；C1 两文件分别 26/26、21/21 | **有证：** 使用 memory API，非真实在线认证 |
| B1-12 | 关闭/删连接期间，主进程迟到令牌写入、fresh resume 不把旧身份带到重开目标 | 原独审分析 main 两种先后关系；目前窗口测试绕过真实 main 认证/令牌存储 | E8、E16 | **部分：** 静态分析有、同一集成用例无，G03 |

### 报告下载与保留清理（EXECUTION-LOW-003）

测试类为 `server/src/test/java/com/autumnharvestc/server/execution/ExecutionRetentionTest.java`。

| 点 | 需求与验收条件 | 测试/实际检查 | 证据 | 判断与缺口 |
| --- | --- | --- | --- | --- |
| B1-13 | 授权后清理先提交，下载稳定 410，不能 200 空正文 | `reportDownloadReturnsGoneWhenCleanupCommitsAfterAuthorization`，真实清理器/数据库/授权，spy 只控交错 | E4 红/绿、C2 | **有证：** 旧实现实际 200/0B；修后 410 |
| B1-14 | 正文行图像先读完，再清理，仍返回原完整字节 | `reportDownloadKeepsOriginalBytesWhenCleanupCommitsAfterPayloadRead` | E4、C2 | **有证：** 不将读取后清理解释为空正文 |
| B1-15 | HISTORY_READ/当前权限仍先校验，无权限不能读取 payload | `reportDownloadsRetainCurrentAuthorizationAndPendingOrMissingResponses` | E4、C2 | **有证：** 权限拒绝与 payload 未调用断言 |
| B1-16 | missing/pending/expired 状态仍按原契约区分 | 同方法及清理先提交方法 | E4、C2 | **有证：** 未以通用 200/空结果替代 |
| B1-17 | 摘要、长度、原正文与 no-store 保持 | 上述实际响应断言及代码冻结核对 | E4、C2 | **有证：** 与原字节匹配 |
| B1-18 | 清理批次、保留期限、未 ACK 保护及去重/确认身份不被改动 | `scheduledCleanupUsesCurrentRetentionAndBoundedBatchesWithoutRemovingIntentOrAcknowledgementIdentity` | E4、C2 | **有证：** 清理器未改；四方法本地/CI 均过，无须再跑 Java 全套 |

### 登记页面语义、保存与撤销

| 点 | 需求与验收条件 | 测试/实际检查 | 证据 | 判断与缺口 |
| --- | --- | --- | --- | --- |
| B1-19 | Suite skipped/aborted/verdict/skipReason 本地化，实际失败与跳过计数不被改写 | D/components/testingCenter.test.ts `localizes suite terminal states` | E5、E7；C1 文件 14/14 | **有证：** 最终夹具符合 Core 统计，不沿用首版空 cases |
| B1-20 | 非空套件统计与 case 行中英可读，保留名称、正文、未知码及原结果 | 同文件 `localizes nonempty suite result rows and reporting units`，真实 Core 两用例一过一败 | E7、E8 | **有证：** 不是仅验证空结果标题 |
| B1-21 | 证据采集选项、旧证据提示与复制标签本地化，复制安全 DTO 不变 | D/components/RunView.test.ts `C1 localizes historical evidence labels and copies the unchanged safe evidence DTO` | E5、E6、E8 | **有证：** 业务请求/响应原文允许 JSON |
| B1-22 | 历史逻辑统计与旧身份提示可读，用户集合名称与统计口径保留 | D/components/components.test.ts `localizes logical report metadata and legacy identity`；RunView 相邻历史断言 | E5、E6、E8 | **有证：** 该目标通过；不代表 components 整文件通过 |
| B1-23 | 离线原因 store 用稳定码；重试/关闭相邻签不破坏离线状态、保留及驱逐 | D/stores/tabs.test.ts 分歧防御已改；`关活跃签且相邻激活失败` 和 D/components/projectTabs.test.ts 仍断言中文 | C1、N1 | **失败：** 两个受影响入口漏检；必须保留签/不切换/驱逐断言，G02 |
| B1-24 | 离线错误沿实际 tabs.error→App 提示链随语言切换，未知原因保留 | D/App.test.ts `F8 registered error online-workspace-session-missing…` 是直接调用 reportError 注入稳定码；watch 接线只经静态核对 | E1、C1 App 文件 57/57 | **部分：** 没有真实点离线签或关闭相邻签触发后的中英文提示测试，G02 |
| B1-25 | 嵌套报告模式继承父上下文，子显式值优先、旧报告回退保留 | D/components/wfDesigner.test.ts `keeps nested report mode…` 与相邻旧报告测试；静态核对显式优先分支 | E5、E6、E8 | **部分：** 主继承有证；新增逻辑的“父 v2/子显式 legacy”冲突分支缺直接断言，G10 |
| B1-26 | AND 全成功不称落败；OR winner/superseded 仍依据真实事实，结果不变 | 同一用例 `keeps nested report mode and successful AND branches accurate without changing OR winner facts` | E5、E8；C1 文件 46/46 | **有证：** AND/OR 语义及输入 DTO 未修改 |
| B1-27 | 保存等待中新输入不误报全保存，新原文/dirty 保留，持久化不含晚到输入 | D/components/DesignPanel.test.ts `does not claim new raw schema input was saved…` | E5、E7；C1 文件 20/20 | **有证：** 真实异步保存交错 |
| B1-28 | 成功撤销显示已恢复，区别初次未写入；撤销失败/预览重置不残留成功标记 | D/components/ImportWizard.test.ts `reports successful undo as restored content…` 成功双语有证；新 undone 标记的 API 拒绝/重置分支只有源码检查 | E5、E7；C1 文件 13/13 | **部分：** 需直接补撤销拒绝、preview/reset 清标记，G10 |
| B1-29 | 无效设计 JSON 预览/真实保存提示随语言切换，拒绝保存且保留原文/未知码 | DesignPanel `localizes invalid raw preview input…`；App `F8 design save errors from invalid raw input…` 真实按钮入口 | E7、C1 | **有证：** 后一条覆盖此前提前翻译错误的真实边界 |

## 第二批逐点对照

### 非活动缓存与配置（EXECUTION-LOW-001 客户端）

主测试为 D/stores/onlineExecution.test.ts；界面测试为 D/components/OnlineExecutionCacheSettings.test.ts。

| 点 | 需求与验收条件 | 测试/实际检查 | 证据 | 判断与缺口 |
| --- | --- | --- | --- | --- |
| B2-01 | 服务器/用户/工作区/分组/项目隔离，同身份属性顺序变化不串项 | `keeps cache identities separate…` 六种身份及重排对象 | E9；C1 该文件 29/29 | **有证：** 稳定元组 |
| B2-02 | 默认非活动数量 20，LRU 清最旧；0 不保留安全非活动项 | `evicts the oldest safe context after the default twenty…`、`persists only validated…`；真实设置保存 0 | E9、E10、E15 | **有证：** 基本容量和 0；不是进程总上下文/RSS 上限 |
| B2-03 | 空闲 30 分钟、单调时钟；到期前保留，到期点及之后清理 | `expires idle selections…` 只推进到 31 分钟，核对位置及环境重置 | E9 | **部分：** 缺 deadline−1/deadline 精确边界及活动期间不提前计空闲，G04 |
| B2-04 | UTF-8 序列化载荷预算，恰等预算保留、超额按最旧清，非进程 RSS 限制 | `releases a safe inactive result above…` 是 ASCII 大 warning、超过 1MiB | E9、E15 | **部分：** 缺精确字节边界、多字节、多个较小项累计超额，G04 |
| B2-05 | 当前上下文不驱逐；非活动 RPC 未结算保护，真实结算后才可清理 | `protects a local RPC across switches…`，上限 0，切换/返回/完成后核对 | E9 | **有证：** deferred 真实 Promise，非按不可见即删除 |
| B2-06 | RPC 无明确结果的失败保守保护，不以 reject 当物理释放，不自动重跑 | `retains an uncertain submitted RPC…`，检查位置/错误和调用仅 1 次 | E9 | **有证：** 不确定身份无自动解除属于批准的保守边界 |
| B2-07 | 所有已知任务保护，不能因最新运行被替换或列表缺项而释放旧任务 | `keeps every known unarchived job…`、`refreshes retained job identities absent from the latest page…` | E9 | **有证：** 旧任务实际仍可查询 |
| B2-08 | 解除必须同时 ended、executionReleased、archived/expired；active-status 最小视图不能冒认归档 | 运行中/none、完整 archived/expired 及原最小视图替换分别测过；未以零缓存驱逐断言覆盖每个独立否定条件 | E9 | **部分：** 缺 ended-but-unreleased、released-but-pending、最小视图等组合保护矩阵，G05 |
| B2-09 | 可见页刷新最多 20 项；单项失败不饿死后续项，失败引用保留并继续轮转 | `a failed status read does not starve…` 两参数 2/21；先失败再恢复 | E9 原始 RED/最终绿 | **有证：** 限额、轮转、首错误、恢复清保护 |
| B2-10 | 隐藏页不新轮询；换上下文后旧状态响应不得污染当前上下文或错误释放保护 | 原 `discards a late list response…` 覆盖 list；隐藏后 RPC 结算有证；新增 retained status/timer 接线未有直接时钟/迟到 status 测试 | E9 | **部分：** G05，list 代次通过不能代替 status 链 |
| B2-11 | 安全驱逐同时释放位置/环境、结果及旧调试会话引用；再次显式调试用新会话，其余上下文不受影响 | 位置/环境/结果已测；drop 删除 debugKeys 经静态核对，现有新缓存测试未返回并追踪 debugSessionId | E9、E16 | **部分：** 直接会话续用/驱逐/隔离断言缺失，G06 |
| B2-12 | 长期元数据不额外保留完整调试请求；实际 RPC 输入仍完整 | `retains only the target kind…`，合法 DebugInvocation >20KB、缓存 <5000B、结果可恢复 | E9 有效业务 RED/绿 | **有证：** 首版缺字段的夹具失败不算 RED |
| B2-13 | 数量 0–200、空闲 1–1440min、载荷 1–512MiB，整数/必填；默认 20/30/64 | UI `keeps drafts local…minimum and maximum`、`rejects empty, fractional and out-of-range…`；store 只直接拒数量 -1 | E9、E10 | **部分：** 已测混合一组边界，未把三个参数各自上下界/越界逐项覆盖，G07 |
| B2-14 | 只持久保存本机配置，成功后应用清理；写失败保持旧配置与草稿，不提交执行任务 | UI `saves through the real online store…`、store `persists only validated…` | E9、E10；C1 UI 5/5 | **有证：** 实际 storage/store 保存重开和失败，无 execution RPC |
| B2-15 | 损坏/不可用存储回默认并说明；读取或 localStorage getter 抛错也安全降级 | JSON 损坏真实 factory 已测；UI 对 corrupt/unavailable 的文字由注入代码验证 | E9、E10 | **部分：** factory 读异常/getter 异常及合法 JSON 非法 schema 缺直接测试，G07 |
| B2-16 | 草稿仅本地；保存/重开回填生效值，统计更新不覆盖草稿，外部配置变化及时同步 | UI `keeps drafts local…` 及 real store 一例核对引用、open、usage 和写失败 | E10 | **有证：** 不是只测保存按钮存在 |
| B2-17 | 主页未登录可找到设置；中英文/单位/占用/保护/副作用可读，无 JSON 主视图 | D/components/topBar.test.ts 真实入口、设置标签测试、560px 页面保存 0 后安全1→0/保护1/当前1 | E10、E15；C1 TopBar 9/9 | **有证：** 当前组件和正常抽屉宽度；不是完整原生包操作 |
| B2-18 | 所有占用说明与限制符合实际；清理不取消、不重跑、不删服务端历史 | UI 直接文字及 real store 调用计数；代码审查 drop 只删本地 Map | E10、E15、E16 | **有证：** 不证明 RSS/长期总身份有界；该保证原方案也未作出 |

### 代理归档账本（EXECUTION-LOW-001 代理）

测试目录为 `apps/runner-agent/tests/`。以下有证结论主要依赖本地冻结输入；CI96 在 desktop 失败后未留下 runner-agent 测试完成结果，不能把它们说成这次 Linux CI 已通过。

| 点 | 需求与验收条件 | 测试/实际检查 | 证据 | 判断与缺口 |
| --- | --- | --- | --- | --- |
| B2-19 | 仅 settled/archived、无 pending report、合法非空 delivery 身份才压缩 | ledger-compaction.test.ts `conservatively retains…` 的 missing archive/inconsistent settlement、`legacy archived flag with a still-pending valid report` | E11，结合冻结源码 | **有证：** 各相应禁止条件；其余身份守卫未宣称穷举 |
| B2-20 | ACK→archive 和 archive→ACK 两顺序均正确，真实 SQLite 重开后仍正确 | `compacts confirmed history after ack-first/archive-first…` | E11 | **有证：** 非仅内存状态 |
| B2-21 | execution 或同 job 任何相关消息未 ACK，或报告回执不匹配，不压缩 | `retains details until every message…exact report is archived`，错误 hash 与同 job 另一 execution 消息 | E11 | **有证：** 已测实际消息集合与不匹配回执；不是全字段变异矩阵 |
| B2-22 | 实际进程明确退出，spawn/process id/role/scope/epoch 一一匹配；空列表不能算退出 | 16 参数 `conservatively retains…`：空/缺/活跃/unknown/mismatch/duplicate/invalid/legacy；active 生命周期正控 | E11 | **有证：** 构造真实账本登记数据后 SQLite 重开；不是由真实 worker 生产整条压缩历史，见 B2-30 |
| B2-23 | 只删逐进程明细，永久 intent/command 去重身份保留，不重放旧任务 | 双顺序测试比对完整 expected、重开 recover/accept；recovery 的重复 delivery/command 不 loadInputs/发请求 | E11、E12 | **有证：** 不删除身份水位协议未实现、未承诺总量有限 |
| B2-24 | processBudget、partial/uncertain 历史事实与统计不升级，原值保留 | 双顺序测试 partial=true、完整 expected 比对及不一致 observation 负例 | E11 | **有证：** 不因清理变成 complete |
| B2-25 | archive/ACK 与压缩同次原子写；无变化不写；失败内存/SQLite 均旧态并 unhealthy | `checks only a configured batch…writes at most once`；`rolls back the complete archive/ack/maintenance transaction…` 真实 trigger 拒绝 | E11 | **有证：** 真实事务写失败；不冒称覆盖断电/文件系统损坏 |
| B2-26 | 默认启用、每批50、范围1–1000；旧部署兼容，未知/非法值拒绝，远端 AgentConfig 不扩 | config.test.ts 默认/上下界、8个 batchSize 反例、3个 enabled 反例、unknown 配置 | E11 | **有证：** 本地部署解析/工厂 |
| B2-27 | 批次资格检查有界、跳过不合格历史、游标渐进，不饿死后面记录 | `checks only a configured batch, advances past unsafe history…` | E11 | **有证：** 不承诺整 State 扫描/clone/rewrite CPU 或存储总量有界 |
| B2-28 | 关闭压缩时 archive/ACK/显式维护/重开均保留详情，重启生效 | `keeps eligible details when disabled…` 及 startup enabled=false | E11、E12 | **有证：** 不新增管理台假开关或热更新 |
| B2-29 | 启动先恢复进程、seen/messages，再压缩；待归档/重复身份不重放，报告仍重试原字节 | recovery.test.ts `restores seen and pending messages…` 两参数、`stops new admission…`、`production bootstrap retries identical report bytes…` | E12 | **有证：** 恢复顺序、防重和生产 bootstrap 原字节重试分别有证 |
| B2-30 | 正式部署配置→真实 worker 退出→报告/消息 ACK→符合资格压缩→重启防重整条链可用 | startup 新用例的历史进程由测试 seed 构造；bootstrap 真请求用例没有直接断言其历史最终被压缩；静态核对了真实 worker 的进程形状 | E11、E12、E16 | **部分：** 两段分别有证，缺同一次真实生命周期压缩闭环，G08 |

### 两项稳定性风险与整体验证边界

| 点 | 需求与验收条件 | 测试/实际检查 | 证据 | 判断与缺口 |
| --- | --- | --- | --- | --- |
| B2-31 | KR-F7F-01 取消历史失败必须有真实 IPC done、terminate 来源、exit code/signal 与 A/B 收束归属 | 两个观测场景未复现 interrupted；socket 结束观测缺失，同步日志影响时序 | E14 | **未关闭：** G09；无定因，不将两次通过当修复 |
| B2-32 | 取消仍保持 200ms/严格 cancelled、B 在途同 PID 最终通过，不靠放宽断言收尾 | 原严格场景及一次父循环 350ms 停顿均保留严格断言；正式原测试恢复 | E14 | **部分：** 只对带观测输入通过，恢复后的原文件未重新执行；不是产品取消正确性全证 |
| B2-33 | KR-F7F-02 旧 hook 被无关事务抢占的机制可确定复现，保留严格旧拒绝 count0 | diagnostic 实际通知事务 COMMITTED 抢占→mutation未执行→count1；目标事务正控 count0 | E13 | **有证：** 历史失败当次没轨迹，不能排他倒推同因 |
| B2-34 | 修后 hook 精确绑定目标线程/scope/admit，核对回滚、mutation、新事务提交和异常；数据库隔离不关 timer | ScheduleOccurrencesTest 五参数与正控，类级独立 H2、51/51；CI 同类51/51 | E13、C2 | **有证：** 生产调度未改；原断言未删 |
| B2-35 | 整批真实认证/原生交互与部署、证据可追踪性不能被构建/组件截图冒充 | Windows CI 冒烟过；实际交互只到组件；原始报告多为 ignored local；部署无完成证据 | E8、E15、E16、C3、C4 | **部分：** 原生集中联验 G11、证据与集成状态归档 G12；不因此批准全量 |

## CI96：根因与原核查遗漏

1. **旧入口断言未跟随批准行为。** TopBar.openOnline 已按 hasActiveProfile 分流；旧 `components.test.ts:1949–1962` 在没有 profile 时仍要求 dialogOpen=true，并在这个失败点后才 addProfile。App 新零连接用例通过，只证明新分支正确，未同步核对旧契约和有连接分支。修正应明确测零连接 emit 管理入口、有连接打开认证；不能把产品退回无目标登录。
2. **store 错误码和展示文字的边界未贯穿调用者。** `tabs.ts:255` 改稳定码；`App.vue:438–442` watch tabs.error，再由 `presentedError` 翻译。只更新 tabs 的“激活编排/分歧防御”断言、通过注入 code 测 App，漏掉 `projectTabs.test.ts:396` 重试和 `tabs.test.ts:620` 关闭相邻签两个旧中文断言。应让 store/组件状态检查精确稳定码，用户可见中文/英文在真实 App 触发入口核对，保留全部离线、保留签和驱逐断言。
3. **验证清单按新增测试名选取，未按行为契约追调用者。** UI 首轮选择器含“激活编排”，不含“关签”；projectTabs 文件不在该选择清单内。TopBar 的正常零连接 App 测试没有带出 components 中旧在线入口用例。原独审核对了相关代码，却未检索完所有 `dialogOpen=true` / “离线”断言及它们的业务前提。具体漏项不是没有跑一次本地全量导致；三条在本机约 13 秒即可确定复现，静态搜索也能发现。

CI 包测试不是全绿：desktop 3 个失败；runner-agent 测试阶段未完成，部署阶段没有通过证据。Java 2197、Windows 包冒烟和品牌门禁通过分别记录，不能合称 CI 通过。当前发现尚无证据需要修改产品逻辑；若补验暴露实际产品问题，先保留有效反例再修，不先放宽断言。

## 首轮归档的缺口与补验计划（历史基线）

归档时除 N1 三条原失败复现外均未实施；用户批准后的实际执行、修正及剩余边界见末尾更新。

优先级“先处理”不等同于高危产品缺陷；有些是测试/证据缺口。每组先集中读清相关调用者再改，完成后只跑该组具名范围。下面不是安排一轮拆分全量。

| 缺口 | 对应点 | 最小补验及验收标准 | 执行范围/顺序 |
| --- | --- | --- | --- |
| G01：入口旧断言及有连接分支 | B1-01/02 | 将旧综合测试拆明零连接/已保存连接：零连接发出管理事件且不打开认证；保存后再点顶栏打开；登录后身份文案仍保留。App 既有零连接证据复用，至少复核更多菜单同一 handler。 | 第一组，和 G02 一次收敛；components、projectTabs、tabs 三文件受影响回归，不跑整个 desktop |
| G02：离线重试/关签及真实 App 提示 | B1-23/24 | 两个旧断言改核对精确稳定码，完整保留“不切换、签仍在、关闭后只驱逐旧项目”等要求。新增一条真实 App 签操作→tabs.error watcher→app-error→切 English 的链路，未知错误仍原样。 | 第一组；先已有 N1，修后3文件 + App 单条选择，不因改文字跑 Java/全包 |
| G03：main 认证与令牌归属集成证据 | B1-12 | 复用现有 main 在线认证夹具，临时令牌存储+合成 HTTP 服务，受控交错“旧 login 完成在 fresh resume 前/后”；核对新目标身份/令牌不被错误替换、删除连接无认证输入。不是再用 memory API 替换 main。 | 单个命名集成用例或有限两参数；若现有夹具无法贯穿两层，则在 G11 实包集中验收中保留未证项，不把静态分析写成通过 |
| G04：缓存精确边界 | B2-03/04 | 注入单调时钟，deadline−1/deadline 两点；活动期间不按旧空闲起点驱逐。计算实际 UTF-8 序列化字节，等额/超1字节、多字节与多个小结果累计超额，检查最旧先释放及其余保留。 | 第二组，仅 onlineExecution 拥有文件新增具名参数；不引入真实等待/长稳压测 |
| G05：保护条件及隐藏/迟到状态 | B2-08/10 | 用少量正交参数覆盖 ended-but-unreleased、released-but-pending/none、minimal active-status、archived/expired 正控；零缓存下检查实际保留/驱逐。控 timer 验证隐藏不发新 status；旧 status 在切项目后完成不污染新项目或误释放保护。 | 第二组，同一缓存测试文件；复用已有29项拥有文件回归，不重跑无关执行内核 |
| G06：调试会话驱逐 | B2-11 | 合法 debug 调用产生真实形状的 debugSessionId，缓存未清时续用；安全驱逐后再运行不送旧 ID、位置/环境/结果恢复默认；另一个上下文的会话仍可续用；受保护上下文不能清。 | 第二组，至少正常保留/安全驱逐/受保护三条有限行为，不改会话协议 |
| G07：三个配置与存储工厂边界 | B2-13/15 | 参数化逐字段 min/max/越界/小数；拒绝时不持久化、不改变策略。真实 factory 覆盖 getItem 抛错、getter 抛错（测试后恢复环境）、合法 JSON 非法 shape，均用默认并返回可读诊断；未知码文字现有证据复用。 | 第二组，preferences/store 为主；仅受影响设置组件补必要断言，不扩全页面语言矩阵 |
| G08：真实 worker 压缩闭环 | B2-30 | 复用现有真实 TaskWorker/HTTP fixture，让本次运行产生登记→done→确认物理退出→归档/消息ACK；核对只有合格进程明细被删、身份/总体保留；重启重复 delivery/command 不多发一次真实业务请求。 | 第三组，单条新 recovery 集成链；复用原40项证据，只有产品改动影响其资格逻辑才补跑两个拥有文件 |
| G09：取消未定因 | B2-31/32 | 保留风险。若继续定位，仅一次有界原严格场景，采同次取消起点、IPC done、kill调用来源、exit code/signal、A/B物理收束；先解决无效 socket observer，使用有界安全事件，避免同步大量日志扰动。没复现就仍未定因，不循环找绿，不改200ms或接受任意终态。 | 独立风险项；不阻塞 G01/G02 的明确修正，也不把本次补验计划当作已获产品修复证据 |
| G10：表单/展示/撤销分支直证 | B1-05/25/28 | 注册页填显示名称并产生本地提示，关闭重开/换目标后检查显示名称及旧成功提示清除。嵌套父v2+子显式legacy冲突一例，核对显式优先、旧无上下文回退；导入 API 撤销拒绝不显示已恢复，成功后 preview/reset 清 undone，刷新失败和撤销失败不混称。 | 第二组附带三个拥有文件的具名选择；不重跑全部登录/工作流/导入 |
| G11：原生功能与尚未执行的部署 | B2-35、B1-12 | 两批补验收敛后，单次隔离新包集中核对目标/凭据清空、真实认证一次、离线提示语言、设置保存重开/释放；仅合成项目。C3 可复用为产物启动证据，不能代替这些操作。部署留待失败依赖消除后同一提交远端 CI，不为此擅自跑完整本地 CI。 | 发布收口前的集中功能验收，不是每小改重打包；不将延期项当作当前通过 |
| G12：证据与集成状态 | B2-35及全部行 | 本对照表入文档；为具名补验记录确切用例、源码提交、命令、exit、鲜输出与哈希，新增未选项明确标识。保留原RED/原CI失败。统一索引本机 ignored证据，提取无敏感最小摘要；不把有Git哈希的产品文档说成全部原始证据已在Git。补充两批已推送/CI96失败的最新状态，不改写旧冻结历史。 | 本次已完成对照/索引；后续补验按行更新状态，静态自查+差异审核后结束，不自发追加全量 |

### 必须保持的延期/非承诺边界

- 287px 极短原生窗口、原生导出损失确认语言、全站前端交互盘点仍属第三批；两批的正常组件尺寸截图不能关闭这些问题。
- 永久去重身份删除、跨重启身份回收水位协议、进程 RSS/数据库总量硬界不是本次批准的生命周期方案；不为“测试覆盖率”临时实现这些新功能。
- 没有安排任何本地全量、Java 全套、全 desktop、全 runner-agent 或 `pre-push-ci.ps1`。最终受影响测试若失败，先诊断并集中修正；不通过拆命令变相执行全量。

## 首轮核查状态（历史）

已完成：读四份原始 CI96 日志；逐点核对需求、当前源码、具名测试和既有原始证据；提取证据索引；仅复现三条 CI 原失败（N1）。当前产品和测试仍是 `49e06023` 原字节，CI96 尚未修复。没有运行补验计划其余项目、构建、打包或全量，没有新增产品结论。后续先集中完成 G01/G02，再按风险和验收边界补 G04–G08/G10，G03/G11 按真实集成能力合并集中验收；G09 保持独立未关闭风险。

## 用户批准后的补验进度（2026-11-08）

所有新增原始证据位于 `local/f8-coverage-ci96/`。以下是基线缺口逐项更新，不将原 CI96 失败、夹具错误或早期失败覆盖掉。

### 新证据

| 编号 | 具名范围及结果 |
| --- | --- |
| N2 | `g01-g02-focused-green.json`：7 通过/177 未选；三条旧断言修正、新 App 真实离线重试及原语言边界。随后 `ci96-owning-files-green.json`：components/projectTabs/tabs 三个拥有文件 126/126。新 App 测试先有 `g02-app-retry-red.json` 的真实 RED：关闭提示后重试，同 tick 的 null→相同 code 被异步 watch 合并，提示不再出现。唯一产品修正为 App 的 tabs.error watcher 同步观察，保留重复失败事件。 |
| N3 | `g04-g07-first.json`：新 onlineExecutionCacheBoundaries 拥有文件 39/39，无未选。时间、预算阈值/累计容量、保护条件正交参数、隐藏 timer/迟到 status、会话续用/驱逐/保护、三个参数逐字段上下界/越界及真实存储异常。独审发现其多字节检查仍依赖被测计数自校准，不能独立证明 UTF-8；补等长1000个“界”/ASCII结果精确差2000B的独立断言后，`g04-review-delta-green.json` 为 G04 7通过/33未选，原审查者复核关闭。不能合并称单轮40全绿。产品缓存实现未改。 |
| N4 | `g10-first.json`：OnlineLoginDialog、wfDesigner、importW 三个明确文件内新补验 9 通过，其他按名称未选；四个注册页场景、合法显式模式、四个撤销/重置场景。测试补验不冒称实现前 RED。 |
| N5 | `g03-first.json`：2/2，renderer store→实际 createIpcDeps→实际 OnlineClient/fetch→本机 HTTP→真实临时 token 文件，两种旧登录/fresh resume 顺序。OS safeStorage 为形状替身，不冒称 OS 密钥环测试；认证端为合成协议服务，不冒称 Java 账号库验收。 |
| N6 | `g08-stress-chain.json`：recovery 内新具名链路 1 通过/10 未选；真实 stress coordinator/worker 产生进程记录并确认退出，ACK/归档后删明细，重启重复 delivery/command 不读取输入、不多发 HTTP，身份/总体保留。代理产品未改。 |
| N7 | `g09/observed-result.json`：只选正式 supervisor 原严格场景一次，1 通过/12 未选；父/子缓冲事件确认 A cancelled、B passed、同 PID、exit0/null，没有 terminate。取消产品和 200ms 预算未改，历史根因仍未知。该次 socket 事件仍未采到；精确匹配完整 URL 会漏 query 的观察器问题已修正，并以独立实际 HTTP `observer-selfcheck.json` 验证 A close/未完成、B finish/完成；这份 self-check 不是取消场景重跑，不能补称原场景已采 socket。原实际观测输入有 `.snapshot` 留档，未循环重跑。 |
| N8 | `desktop-build-first.log`：desktop 类型/Vue/renderer/main/preload 构建通过；`agent-typecheck.log`：代理类型检查通过。独审新增测试后仅再执行 `final-desktop-typecheck.log`，exit0，未重建不变的产品。只构建受影响产物，不是完整 CI。目录包先缺 Electron dist，复用已安装且版本核对为 44.1.0 的 Electron 后打包；首包缺 share-viewer dist 资源，补构建该包后得到 `package-complete`。正在验收包与完整资源包 app.asar SHA256 均为 `289d6a021a6d50cc0e8a19c7318bd657b784b14551bf65b370858049dfd05bc1`。 |

G08 两个初始测试前提错误分别保留在 `g08-first.json`（fixture 只对含 hold 的路径设 gate）和 `g08-corrected-fixture.json`（普通 workflow 不产生 stress 的逐进程登记，无详情可压缩）。改用现有真实 stress fixture 后取得 N6；它们不是产品缺陷 RED，没有为测试增加生产登记或放宽压缩资格。G09 首次配置相对路径错误在执行任何业务测试前退出，保留 `config-preflight-failure.log`，不计一次取消场景执行。

### 基线缺口的当前逐项状态

| 原核查点 | 补验/修正后的当前结果 | 证据/剩余边界 |
| --- | --- | --- |
| B1-01 | CI96 旧入口断言已修正，零连接走管理入口且不开认证 | N2 |
| B1-02 | 保存后再点顶栏正常打开认证，身份文案保留 | N2；更多菜单同用 openOnline，源码已核对 |
| B1-05 | 注册成功/本地校验失败 × 重开/换目标，全部字段与旧提示清除 | N4 四参数 |
| B1-12 | 两种 main 令牌顺序已贯穿 IPC/HTTP/真实文件验证 | N5；旧登录先完成时，fresh resume 必须向服务端重新验活存档，而非把 renderer 迟到结果直接当当前登录；native/OS 层由 G11 单独记录 |
| B1-23 | 离线重试/关闭相邻签核精确 code，原签保留、活跃位和驱逐断言均保留 | N2 126/126 |
| B1-24 | 实际创建离线签、关闭提示、再次点击该签，新错误重新出现，切 English 同一提示更新 | 有效 RED→唯一 App watcher 修正→N2 |
| B1-25 | 合法显式子模式和无模式父报告同时准确展示、结果不变 | N4；原计划的“子显式 legacy”前提不存在：WorkflowRunResult 只允许显式 v2，legacy 是缺字段，不能构造非法 enum 来补证据 |
| B1-28 | 撤销 API 拒绝不报成功；撤销成功但刷新失败仍保留实际 undone；preview/reset 清标记 | N4 四场景，区分两种失败事实 |
| B2-03 | deadline−1/deadline、长期活动后才开始空闲，均符合批准语义 | N3 |
| B2-04 | 同形等长中文/ASCII字节差独立核对，等预算/超1B及多小项累计超额，最旧先清 | N3 独审 P2 修正及定向复核；不是 RSS |
| B2-08 | ended-but-unreleased、pending/none、running、minimum 保护；完整 archived/expired 才清 | N3 七参数，零缓存实际驱逐断言 |
| B2-10 | 隐藏停止新 status，重显继续当前任务；迟到旧 status 不污染另一项目、不推断释放 | N3 控 timer 与 deferred status |
| B2-11 | 未清会话续用，清后不送旧 ID/位置环境结果回默认；另一上下文与不确定保护保持 | N3 三条完整 debug 调用 |
| B2-13 | 三配置各自 min/max、越界/小数，拒绝不持久化、不改变旧策略 | N3 十五参数 |
| B2-15 | 真实读取异常、getter 异常、四种合法 JSON 非法 schema 均降级且不覆写旧值 | N3 六条；getter 描述符恢复 |
| B2-30 | 真实 stress worker 进程树→确认退出→归档压缩→重启防重已贯通 | N6；普通单请求没有逐进程明细，不假造该前提 |
| B2-31 | 未复现历史 interrupted，仍未定因/未修复 | N7；保留 KR-F7F-01，socket self-check 不补称原失败轨迹 |
| B2-32 | 当前正式原用例的严格 A/B 断言以一次缓冲观测通过 | N7；结果仅属于该观测输入，不宣称无观察器又跑过 |
| B2-35 | 构建、目录包及本轮具名原生功能验收完成；远端部署仍待新的 CI，保持部分覆盖 | N8、N9；本地全量始终未跑，不以本机包验收替代新提交的 Linux/部署 CI |

上述测试均已具名落盘；代码、测试和补验结论已冻结。已排除本次三个已知 CI 回归，新增 App 相邻链路缺陷另有有效 RED 与修正。KR-F7F-01 仍未定因，远端部署仍无本次通过证据；不把 CI96 写为已通过。提交、合并、推送的实际身份单独记录在集成回执，不改写这些验证的基线及源码归属。

### 独审进度与交接

唯一 Sol xhigh 审查者已覆盖本轮全部代码/测试、64点对照和原始证据，未运行测试或全量。发现的唯一验证 P2 为 UTF-8 自校准不能检出字符计数退化，按上文 N3 补验后已定向复核关闭；其余目前无未关闭代码 P0/P1/P2。未因补单点重开宽泛审查。

N9 / G11：用户已完成同一隔离窗口“填入→关闭→重开检查账号密码均为空→登录”，并明确回复通过。工具随后核对目标与 F8 synthetic member 身份；设置默认 20 个/30 分钟/64 MiB，保存为 0 个/31 分钟/8 MiB 后，关闭面板再开值不变；English 的标签、单位、范围、保护条件及局部滚动可读，无 JSON 主视图或翻译 key。正常退出后以同一私有用户目录重启，语言、三项配置及身份恢复，合成服务记录新的 GET /me 验活。实际 Electron token 文件 encrypted=true 且不含明文合成令牌，未输出令牌或密文。

原生证据见 `native-verification.json`、`native-*-ax.txt`、中文/英文/重启 PNG 与仅含方法/路径的 `native-requests.jsonl`，文件 SHA256 已写入机器索引。验收使用空工作区：真实缓存释放由 N3 的 store 行为覆盖，重复离线提示由 N2 的 App 集成覆盖，未冒称原生项目点击覆盖；合成 HTTP 服务不等于 Java 账号库或部署验收。仅观察本机安全存储加密标志及正常恢复，不扩大为 OS 密钥环所有失败场景均已覆盖。两次客户端均正常退出、合成 helper 和监听端口已关闭，私有证据保留。

G12：64 点基线、19 个部分/失败/风险点的更新、12 次具名测试运行及构建/打包命令和退出码已索引。退出码来源为本轮实际工具 stdout 的追记，原始工具 trace 未导出入 Git，不能把原始 Vitest success 字段当 shell exit 证明。全部原始 local 文件保持 ignored；Git 保存可移植摘要和源码/原始产物哈希，不称全部原始证据已归档进 Git。最终清单在 `local/f8-coverage-ci96/final-candidate-manifest.json`，仅对这些冻结文件做最终独审封存核对，未重新宽审或追加全量。
