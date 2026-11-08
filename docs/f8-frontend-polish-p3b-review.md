# F8 前端 P3b 压测报告有界独审

日期：2026-11-08。工作树 `C:/Users/imini/.codex/worktrees/f8-frontend-polish/apicc`，分支 `codex/f8-frontend-polish`，前序已提交基线 `ac800736e51d22537579659ea7edeedb1a95b9ee`。沿用当前确认的独审配置。未使用 superpowers 或同源别名技能，未开新 agent，未运行测试/构建/全量，未修改产品、测试或 Git 状态；只写本地审查回执。

## 最终结论

本组完整 delta 和直接调用关系静态审查、两项实际修订及最终证据封存完成。集中提出的两项P2（安全未知码二次通用翻译、策略并发上限误称运行申请值）均已关闭；第一轮修订引入的旧安全别名回归也已通过明确白名单及原测试收束，没有修改旧回归放行。当前无有证据的未关闭 P0/P1/P2，P3b 本组可结项、按既有授权提交并继续后续子组；不代表整个P3、原生完整链或全量/CI通过。

已遵循本工作树 AGENTS 和 UI 展示规范，阅读 `docs/f8-frontend-polish-p3b-design.md`。仅覆盖 StressReportView、StressTrendView、zh-CN/en 的 stressReportUi、新 stressPresentation 测试及本项直接影响的既有报告测试；P1/P2/P3a 不重审，Core/运行器/宿主/管理页等不扩大进本组。

## 已关闭 P2-01：安全专用码不能再次按通用状态翻译

初次候选 `safetyDecision(value)=code(stressSafetyCodeText(value,locale))` 会在 Core 安全映射保留未知字符串后，再套 stressFinal/stressPresentation 的通用翻译。例如合法旧报告 safety.policy='passed'，Core 专用表没有该码，原应保留passed；后续code却命中 states.passed，显示“通过/Passed”。confirmation='http' 同样被翻成HTTP。两者均为 `StressSafetySchema` 允许的字符串，未知码不能因碰巧与另一个领域码同名而被改写，尤其不能在安全结果中伪装成已通过。

已核 Core `stress/presentation.ts` 的安全专用表和 model 的target字段，不是根据测试名推测。这个问题发生于本次新增的legacy映射，相邻v2原来也有相同组合；同组统一通过专用安全映射是必要且有限的修复范围。新三个反例中的legacy/v2两项均先parse真实schema，`review-red.log` 确证passed的中英文误译，不是夹具导入失败。

第一轮仅删除通用code的修订方向正确，但 `review-green.log` 又出现既有 stressWorkbench I5 对 Confirmed/Allowed 的四个断言失败；该旧用例有有效 `StressReportV2Schema.parse`，不是本次新增的非法数据。应明确保留已经支持的confirmed/allowed安全别名，同时避免任意通用状态翻译；不要仅将既有有效测试的值改成别的码来回避兼容回归。新测试改成实际producer的explicit是可以的，但不能替代旧别名回归的处理。

反例断言也需收紧：对整个safety.text().toContain('http')会被origin='https://literal.test'满足，即使决策仍显示HTTP也可能通过。应在现有两项用例中只检查决策字段或精确http/passed组合，排除来源URL。passed的反例断言本身有效，不需要另起额外测试组。

最终修订已核：safetyDecision只对confirmed/allowed两个已有别名使用各自stressFinal.codes键，其余交Core安全专用表，完全不再经过通用code。相邻v2使用同一函数。两个unknown用例先parse合法报告，再精确比较决策片段数组['http','passed']，来源URL不在比较值里；中文/英文均核。原stressWorkbench没有diff，`review-final.log` 为新7项+既有报告12项，共19通过/3未选；随后精确断言加强的两个用例在`unknown-exact-final.log`为2通过/5未选。这个最终子集是重复验证，不加成21个不同用例。此项及兼容回归已关闭。

## 已关闭 P2-02：应用策略上限与运行申请/生效值分别命名

初次候选把 `row.appliedPolicy.maxConcurrency` 标为 `stressReportUi.requestedConcurrency`，英文为Requested concurrency limit。但 Core `StressSafetyTarget.appliedPolicy` 明确是规范化策略快照；`safety.ts` 用它校验输入上限，`plannedRunner.ts` 则另从compiled schedule记录run.requestedConcurrency/effectiveConcurrency。因此策略上限3、运行申请2、生效1是不同事实，不能把3也标为本次申请。

最终修订新增policyConcurrency标签并保留原run的requested/effective标签。新增一个用例以3/2/1不同值parse合法报告，逐个dt/dd精确验证三组，`review-red.log` 先因没有Policy concurrency limit字段失败，属于有意义反例；`review-final.log` 中本用例通过。旧报告实际截图也显示三个独立标签。此项已关闭，不改Core或限制策略。

## 统计、缺测与原文核查

- 已读 v2 report/schema 的iterations、requests、caseRows、httpExchanges、节点和lifecycle模型。新卡片直接绑定既有字段，没有重新计算总体：逻辑passed/completed和原始请求eligibleCompleted/failed分块；requests.started/completed、caseRows、HTTP hops以及生命周期总体说明仍在。完整性/饱和/丢弃/精度/生成器状态未被隐藏，也没有以逻辑通过覆盖请求失败。
- 节点十列逐一对应 visits/passed/failed/aborted/skipped/requests.eligibleCompleted/requests.failed/requestLatency/nodeLatency，未把行次数当HTTP跳数。Other只改变聚合桶标签，真实workflowId/nodeId字符串不经code；完整key仍在title。
- 生命周期只对role/state/failureKind翻译，vuId原样，即使其内容是passed；null才显示Run level。duration两位显示并保留原值title，不改DTO；真实0仍为0 ms，缺失败类型为不适用。空节点/生命周期列表给无记录说明，不凭空造0行。
- 阈值沿用原数值，rate转百分比、p95补ms、rps补请求/秒；未知metric回退原名，说明保留业务原文。v2 errorKinds现在直接String输出，避免把业务错误键碰名翻译。
- Legacy loopback缺失改为未采集，与true/false分开；可选来源列表区分undefined和空列表。requested/effective RPS的undefined、null、数值分别是未采集、无限制和带单位数字。RSS按1048576转MiB，仅改可见格式，CPU/事件循环/backlog的真实0不被假值分支吞掉。
- 两版本failureEvidence共用原props字段：undefined为未采集、[]为无保留样本，样本条数不再写死20或冒充失败总数；CaseEvidencePanel继续收到原安全DTO，没有扩大采集/重新构造身份或授权执行动作。

## 趋势、样式与共享调用

StressTrendView脚本与基线相同：原bucket上限、原观测点、缺值分段、时间缺口断线、phase边界和坐标计算保留。新phase表把eligibleCompleted与failed拆列，stageId、时间范围仍原文；0/1桶与时钟不对齐提示保留。仅系列/圆点颜色改为已有accent及局部表格/图形样式，没有新增平滑曲线或填补未观测区间。

两组件style均为scoped；业务ID单元格可换行，宽表在自身overflow区域，节点/生命周期/phase滚动容器有tabindex及焦点轮廓。父组件没有以全局td/th选择器去改管理台或其他报告。实际窄屏/短高是否能操作仍等浏览器证据，不能凭这些CSS或构建结果称通过。

直接调用方已核：StressPanel工作台报告/基线和legacy运行结果、RunsHistory历史抽屉、OnlineExecutionPanel在线报告；StressTrend仅由StressReport调用。本次没有修改调用方或AI analyzeReport捕获的displayed/source/report/baseline/isCurrent，原显式baseline选择和导出仍由原store/调用方拥有；未改比较、统计、执行器或网络。在线execution摘要继续独立传入，不与报告的运行统计混为一项。

## 测试与证据归属

已读初始四个新组件用例、既有stressWorkbench报告/基线用例、当前三个复核反例及原始日志。首次presentation-red.log为未导出导入路径导致0测试执行，不能计RED；presentation-red-valid.log确有4个呈现失败，但第三项available generator原夹具未满足当前完整schema，不能把“valid”文件名当作所有前提均已合法的证明。实现者已补齐完整generator指标并加StressReportSchema.parse，最终结果另记，不能倒写历史先红前提。

targeted-green.log的既有报告12项通过，同时新四项3通过1英文Run-level拼写预期失败；按既有Run level修正后presentation-final.log新4/4。legacy-consumers.log另7通过/67未选，既有报告3未选。初始去重为12+4+7=23，不将红绿复跑重复累计。第一轮review-green为18通过/1失败/3未选，其中旧别名回归四个断言失败；该原日志保留，不作为最终GREEN。最终19项及精确2项按前节分别归属，不把不同版本执行拼成一轮全绿。

既有受影响测试有实际非空请求失败、完整性、容量/精度、阈值Core输出、phase业务ID、零/单桶与缺口、到达率不适用/未采集、基线固定及精确导出选择；不是只测字段存在。最终新增字段各列测试精确比较单元格，生命周期还比较原DTO未改变。原始16份日志已核，最终Vue/renderer frozen完成记录和主会话退出0回执一致，保留大chunk和jsdom pseudo-style提示。本独审没有运行这些命令。

## 最终证据封存与边界

已逐张实际打开七份PNG：中文浅色摘要4/4逻辑通过与原请求10/失败6并列，完整性/容量/精度保留；节点十列和其他桶、生命周期角色/业务VU/0ms/不适用清楚；英文深色900下结构可读，640宽表只在自身水平滚动；旧报告Confirmed别名、custom-business-policy原文、独立policy/requested/effective标签、MiB/请求每秒单位可见。单桶图只有实际一个观测点，单点限制明确，没有新造曲线。没有发现图像的实质可读性/布局交付问题。

浏览器receipt中的document640/内容640、main625/内容625、node表544/内容931，以及证据展开空样本说明和无browser error，采用主会话当次观察；本独审没有重开浏览器或独立执行这些交互。图像显示局部滚动条，不把它扩大为原生键盘/触摸所有状态均验。浏览器本轮没有剪贴板/导出副作用验收，未计通过；原基线/精确导出选择由具名测试补充，也不代表真实文件对话框已验。

已读Vite entry/serve和generate-fixture：别名从当前工作树推导，实际导入StressReportView（内部StressTrendView）、主题与ThemeLanguageToggle；数据由本工作树stressV2Report/computeReport构造，v2写出前有Schema.parse，generator补齐全字段后才用于最终浏览器。legacy合成数据同样沿用完整generator，没有从别的worktree借源码或用手绘表替代组件。ConfigProvider是同值镜像、报告为合成props；不能拿这些截图证明真实执行、后台/IPC或P2包已更新。

最终去重26通过=新7+既有报告12+旧报告/历史7，70未选=3+67；exact子集2及各轮复跑不重复累计。19轮后仅两个unknown断言由子串加强成精确字段，并在单独2项轮次重新通过，剩余用例仍按各自实际运行版本归属，不称最终整个文件全部再次执行。本轮没有全量、完整CI或远端CI结果。

最终manifest `docs/design/f8-frontend/p3b-evidence-manifest.json` 的34项（5源码/测试、16日志、5夹具、7PNG+1回执）实际SHA256全部匹配，自身为 `0bbe10198b6ed73416811cf7387da76413b1f861d91f07eca45a1487b8d3c841`。源码/测试最终哈希如下，未发现声明delta以外漂移。最终文档design/validation/acceptance/worklog的计数、原失败和限制一致，确认首次导入0测试、generator前提不足、分类/Run-level错误、未知码URL断言缺口与旧别名回归都没有被隐去或伪称严格全程TDD。

完整原生287px/缩放/拖动、真实后台/IPC和任务链仍留既定P5；其他P3复杂页面/P4不在本次结论内。P2交付zip不包含P3a/P3b，本轮未重新打包，不因当前源码构建通过冒称包更新。临时页/服务关闭和视口恢复由主会话验证记录说明，本独审没有新增进程清理或包运行检查。后续只因实际产品delta做定向复核，不重开全分支宽审。

| 已审最终源码/测试 | SHA256 | Git blob |
| --- | --- | --- |
| apps/desktop/src/renderer/src/components/StressReportView.vue | 6b859f4d8b5d9d80586ac43b55894406484fa2c766d5a90899d5971b0ba77894 | 69558b1f163b6ff4b8996cca0dd4a892dd5c518a |
| apps/desktop/src/renderer/src/components/StressTrendView.vue | c812c3391bae8a6d0efa93742c46b4f49776090dedff994e0675a7cec6920aee | 5bf228ef6512130ce11667d854e968cd88b7f97b |
| apps/desktop/src/renderer/src/i18n/zh-CN.json | 17f091feed55fa3eb806ec4d485a366824261104d834363f8dc8926567e105f3 | afe15c42569a542a21a5cfbf1b01d0474f7353ba |
| apps/desktop/src/renderer/src/i18n/en.json | a1a9b289f63da60f50181efec31c449ab976ab60477e195c2de250e3939911a3 | 18745c3cc938bc88350b72a7647a1c7d9700e187 |
| apps/desktop/tests/renderer/components/stressPresentation.test.ts | f704514225b229f0d9ab090655b9a6b29d4dd94c210f5173932ff4fee6e8c235 | 31466a813c027e68bfa5f110b60cb5fefb555f13 |

| 最终文档 | SHA256 |
| --- | --- |
| docs/f8-frontend-polish-p3b-design.md | 71275ef0fb2d9d117a64086f9d7b22156e8db1c426100f5b3c7939e8106f171b |
| docs/f8-frontend-polish-p3b-validation.md | 86675de2263d84d615e08288ebe92663ced28bd38b5c0f4a1f11b353de3bd8b7 |
| docs/f8-frontend-polish-acceptance.md | e10dd23cb850c568b6d0275ec25b518eefffbb650af5ec2392ed7c4feb6cfcb1 |
| docs/f8-frontend-polish-worklog.md | bf2683229f199e60b99af794f4477593d6c9e58cb5901979b071bb1520caef4b |
