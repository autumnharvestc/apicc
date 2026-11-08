# F8 前端 P3a 有界独审

日期：2026-11-08。工作树 `C:/Users/imini/.codex/worktrees/f8-frontend-polish/apicc`，分支 `codex/f8-frontend-polish`，基线 `569f7bf257b8387b51879b17512a44b080f89278`。沿用当前已确认独审配置。未使用 superpowers 或同源别名技能，未开新 agent，未运行测试/构建/全量，未修改产品、测试或 Git 状态；只写本地回执。

## 最终结论

P3a 的六产品/两测试候选静态审查及最终证据封存完成。实现者自审发现的 scope 误译用户环境名 P2 已按实际模型确认，并通过最小修订/反例和更新图像关闭；当前没有有证据的未关闭 P0/P1/P2。原始统计与 Core 逻辑统计没有混为一项，容量投影捕获总数的权威性保留，失败原因、警告、证据原 DTO 与动作绑定未被新呈现替换。本组去重32项受影响通过、分阶段Vue/renderer日志及六张实际组件图像已核，P3a 可以结项继续既定下一子组；不代表整个P3、所有共享调用方完整页面或原生端到端已验收。

已读本工作树 `AGENTS.md`、UI规范、P3盘点及P3a边界。仅审 RunView summary/布局、新 RunSummaryView、共享 CaseEvidencePanel、ResponseViewer Console增量、zh-CN/en 的 reportPresentation，以及新 presentation 测试/RunView断言适配。P2样式和包不重审，压测页本身、其他P3/P4页面留后续子组。共享组件的实际调用关系纳入，但不将其称为那些页面全面验收。

## 已关闭 P2：证据 scope 是环境名，不能按资源类别翻译

实现者自审指出，初次候选将 locator.scope 交给 reportPresentation.scopes，并定义 project/global/api/collection 等翻译。本独审随后核读 Core `domain/executionSelection.ts` 与 CasePanel.scopeOptions：保留值 base 才表示基础用例，其余 scope 实际按环境名chain匹配，选项直接来自 env.name。因此名为 project 的合法用户环境会被中文视图误译成“项目”，其他碰名也一样；未知码fallback本身不能保护碰巧命中翻译键的业务值。应仅翻译保留值base，其余逐字保留，不改DTO或选择身份。现有浏览器合成 proof.scope=project 正好覆盖该反例，修后证据图/回执需对应真实显示。

最终delta仅移除两语言 scopes 中的 project/global/api/collection，保留base；通用label既有te检查使其他scope直接回退原字符串。新增真实CaseEvidencePanel反例逐一检查四个碰名及中文环境名，并切英文核对原名和base。`scope-red.log` 为1项中4个实际错误译值的失败，`scope-green.log` 为该1项通过/6未选；没有改copy/identity/store逻辑。当前两张证据图中文浅色与英文深色都显示原名project。此点可关闭；初稿只检查通用枚举fallback未识别其环境名语义，不作为该点此前已通过的证明。

## 统计与结论

- RunSummaryView 的逻辑卡只使用 `reportingUnits(result).summary`，原始执行行卡只使用 result.total/passed/failed/skipped；无基于当前可见 DOM/裁剪 cases 数量重新推算总体。已读 Core `report/units.ts`：reportFailure+evidenceOmitted+reportingUnits 同时存在时捕获 summary 覆盖派生值，组件没有绕过该优先权。
- 已读 Core `projectRunFailure` 容量降级路径，确认它保留原始聚合、捕获的逻辑聚合和首要原因/警告，明细可能为空。新视图对报告失败或证据省略直接给出不完整说明，套件/工作流无明细时不会据空列表伪造总数0。
- 工作流/套件条目默认展开为表格，保留 entryId/workflowId、数据行1起算或缺失破折号、类型/状态、error、skipReason，以及工作流 failureKind。工作流/套件已有 verdict 仍显示；工作流 state优先status体现 noop 等事实，不把失败原因只埋进原始JSON。警告原文完整循环保留，没有删诊断来换取“全部通过”。
- 请求开始、完成和HTTP交换按独立 requestFacts 显示；没有把原始执行行数等同 HTTP次数。普通集合/旧报告的额外非请求诊断仍由 Core reportingUnits 合成，不写回原 result 或 runner 统计。
- RunView 仍把原 result 交给 AI摘要/分享摘要，保留精确项目/集合、环境与原始CaseOutcome rowKey、观测定位及历史装配。本次 script 只增加 RunSummaryView import，没有改 store、执行、认证、分享 descriptor 或摘要授权边界。

## 证据与共享调用方

| 组件/入口 | 已核对影响与不变量 |
| --- | --- |
| RunView→RunSummaryView | 唯一生产消费者为 App 的 run 模块，App 原 panel-view 局部滚动仍在。摘要布局替换旧JSON/混合固定文本，原非请求诊断 CaseEvidencePanel、原始结果表及行展开仍在；新增 table.x=680 只提供局部横向滚动。 |
| CaseEvidencePanel→RunView | 诊断条目由原 reportEntryEvidence 构造，原始结果行传 record.evidence；disabled/inspect/rerun/locate绑定未改。新的证据字段卡、默认折叠定义指纹与断言/提取卡不重组身份。 |
| CaseEvidencePanel→SuitePanel | 失败/中止条目与结果行两个入口仍传原 safe evidence，dirty/running/transitioning gate 继续由调用方决定。没有把本次共用样式解释成套件编辑、取消或保存全面验收。 |
| CaseEvidencePanel→ResponseViewer/WfResultDrawer | 只读显示证据，没有新增 inspect/rerun 权限。inspect 动作按回调显示；既有 rerun 局部函数仍检查 props.rerun 和 target.available 才能调用，不把同名模板变量当作无回调时一定隐藏按钮的证明。ResponseViewer 又共享给 App/TestView/OnlineExecutionPanel，未新增 api 必填假设。 |
| CaseEvidencePanel→StressReportView/OnlineExecutionPanel | 原 stress v2/legacy failureEvidence、在线结果行继续传原 DTO；没有给这些只读入口暗加重跑。压测摘要/统计/生命周期、在线执行的全页面调整不在本组。 |

CaseEvidencePanel 复制仍是 `JSON.stringify(props.evidence, null, 2)`，不经显示字段重新组装、不扩大采集；定义指纹短显12字符且完整值可展开，复制保留完整身份。请求/响应正文、断言实际/期望与提取值仍为原始业务文本，未翻译/反序列化，也没有 v-html；断言结论/原因、差异/Schema路径和提取发布状态直接可读。缺失、not-collected、omitted/truncated及响应不可用提示仍保留。

本次 CaseEvidencePanel 行为代码只改 label 的分组参数。既有 inspect watch 的 epoch 拒绝迟到结果；rerun busy/disabled 和父 store 的 captured identity/generation/cancellation cleanup 原字节保持。已读 run store 重跑实际路径与对应 RunView 测试：同步占位，准备和host两个阶段退出都等待 owned completion，旧generation不得回填结果。新增 presentation 的迟到 inspect 测试覆盖组件可用性不被旧响应恢复；它不代表新增了一套重跑代次协议或所有异步失败组合均已复验。

## 本地化和 Console

RunSummaryView 对模式、类型、状态、跳过/失败原因使用 te 后再 t，未知码回退原文；CaseEvidencePanel 提取状态也保留未知码。scope 则是业务环境名，最终按上节只映射保留值，其他值原样。业务label/error/message、ID、路径和安全值不被翻译。zh-CN/en 新键对应，没有用整个JSON或含JSON表格单元格替代配置/统计主视图。

ResponseViewer 与P2已审脚本段逐字相同，本组仅 Console 模板/样式增量。Console 保持原数组顺序，以级别和消息逐行显示；当前 DebugResult model 的 level严格为log/info/warn/error，四者均有两语言标签。模型没有日志时间戳，所以没有编造时间列。消息使用文本插值，换行和消息内JSON保留为业务原文，HTML字串不会执行；空控制台继续沿原文案。交换/请求/响应/搜索/投影/剪贴板/下载及tab状态保护未改。

## 测试与构建证据

已完整阅读新 `reportPresentation.test.ts` 六项及 RunView 断言适配。新增用例实际挂载 RunView+stores/CaseEvidencePanel/ResponseViewer：独立检查逻辑1和原始3、容量权威8与不完整提示、旧报告0原始行加1诊断、非空工作流/套件状态与原因、未知码/业务原文/转义、指纹默认折叠/完整复制/动作gate、迟到inspect，以及非空Console顺序/语言/清空。断言不是仅检查翻译字段存在。RunView旧字符串断言改为精确三行五列中文业务内容，数据行0/1→1/2和缺失保留，旧结果对象未被改写。

已读 `presentation-red.log`：新六项中5因新结构/文字缺失失败、1项既有迟到inspect保护通过；不能称6项都先红。首次实现后 RunView+presentation 为15通过1失败，失败为旧展示串预期；改为业务表格断言后 `run-evidence-tests-final.log` 两文件16通过。另 ResponseViewer13通过/61未选、共享Suite2通过/12未选；合计31是三次具名范围，不是整工作区或整个P3通过。共享Suite两项有真实非空成功/失败结果与保持DTO原值的断言，不是只挂载空组件。

首次Vue类型检查有 RequestFacts 直接传翻译Record及get(...).exists的类型失败，最终已用结构展开和find修正；原日志保留，不充当产品呈现RED。最终Vue检查日志及renderer完成记录已读，主会话回执退出0；保留 jsdom pseudo-element、Tabs旧slot弃用和大chunk提示，不称零警告。本独审未执行上述命令。

## 最终证据与交付边界

已读最终 `p3a-validation.md` 和 `browser-receipt.json`，并实际打开六张PNG：中文浅色1440运行摘要的逻辑1通过/原始3含1失败、工作流三节点及警告清楚；英文深色900摘要/节点标签与业务原文分离；640宽表格局部滚动而非逐字挤断表头；更新后的中英文证据字段/断言结论、路径和实际/期望值可读，scope=project原样；Console四行的Info/Log/Warning/Error及长HTML字面消息不撑宽。证据正文/原请求响应继续在折叠或局部滚动区域，不把状态/结论整体藏入原始JSON。

指纹Enter展开/折叠、定位/重跑计数各一次、640宽表viewport592/content640及键盘横移40、Console四行/unsafe元素0/文档宽900，采用主会话当次浏览器测量回执。本独审未重操浏览器。浏览器copy工具读回空值，明确不计剪贴板字节通过；只有组件测试证明精确序列化原DTO。没有以截图或合成事件计数代替真实授权/执行/持久化证明。

已读最终夹具entry/serve：别名从本工作树位置推导，真实导入RunView、CaseEvidencePanel、ResponseViewer、theme.css/主题控件，ConfigProvider同值镜像、内存run/workspace、合成report/evidence/debug与计数装配清楚；没有借用另一工作树源码。合成原始总数3但只保留一行用于布局，不能拿该样例另证明真实runner统计。浏览器功能页不是完整App/原生包/真实后台IPC。summary初次role定位错误、热重载语言重置后纠正、Tabs旧slot提示与复制读取限制均如实保留，没有充当产品RED或零警告证明。

最终scope追加1项是前述31项之外的新用例，因此去重32成立；scope单跑的6未选属于此前已通过的6项，不再算新增未覆盖；原ResponseViewer61+Suite12未选仍为73。它是具名分阶段证据的去重结果，不是单轮32全绿。最终Vue/renderer scope日志已读，主会话记录退出0；其余31未因仅两语言键删除再次执行，不假称重跑。此前失败/类型错误日志都保留。

`p3a-evidence-manifest.json` 最终SHA256为 `561f70ab601b4088b111c887a08f59fcb0972e8d33f14004ef3b00174f9b54a7`。30项实际散列全部一致：8源码/测试、12日志、6PNG+1浏览器回执、3夹具。与初审相比，仅两语言文件和新增scope测试的哈希按已声明delta变化，其余5源/测试无漂移；下表已更新最终字节。P2源码/包不为此重审，原交付zip没有被本次源码当作已更新。

最终文档散列：validation `31f25e3556a86abbb2828f9df4200c8ebfaa78c146c531abbbaaa00581b87187`；P3 inventory `d8dff552f6ba10a86d166763dc8641b256d0b2028a54fe2da27d3988402031eb`；acceptance `949c9fda4598d6d6e56a4f7f21f644db386569cea3f631bce979da7122492d14`；worklog `0904f2a43c0f85ac45d484eb47e993fd33d968d2123ea2bde35186d638983b43`。这些记录的初始31与追加scope为历史时点，不累加红绿复跑为更多用例。

原生287px、缩放、拖动及完整后台/IPC仍属后续集中验收；浏览器剪贴板字节未独立确认。本回执不关闭压测页本身、测试中心完整编辑、其他P3/P4页面；CaseEvidencePanel共享样式接入也不等于那些页面逐状态全部验收。未跑全量、完整CI或远端门禁。后续证据/文档更新不重开源码宽审，实际产品修订仅复核具体delta及必要相邻影响。

## 已审源文件

| 路径 | SHA256 | Git blob |
| --- | --- | --- |
| apps/desktop/src/renderer/src/components/RunView.vue | 9f441399f14129689ce315e723ea161c4cfbd7b827f035041f10402491e3c636 | 27385f7a1ba513c38956b93db3c58b8ba775bd5a |
| apps/desktop/src/renderer/src/components/RunSummaryView.vue | 97283a841ea303178e6db755a2f8d0a905e0215df0af5de4815062aea55221fb | e18b58465280cc679b3793feec08e075e96b0984 |
| apps/desktop/src/renderer/src/components/CaseEvidencePanel.vue | 308a117936a199bb324092bbdf4f3248c33be14c849943c271a426ef6603404a | 359e5adbdcf1337a7cb03e22da78f73a2feb852d |
| apps/desktop/src/renderer/src/components/ResponseViewer.vue | 82aab0cefb2f4fdc6286e7c9bf7b440f6b44058b8360d66c518d89cc5c8792f6 | fde5c4a87e50cd71df724588a81a04b1f8077aff |
| apps/desktop/src/renderer/src/i18n/zh-CN.json | 631ce46c3afe5e39888c8908646fc59b2d1041078e86423b3743a2d7f956310b | 3a8d78751b2f1ca40c3bc8c63598cff05c3ec8e5 |
| apps/desktop/src/renderer/src/i18n/en.json | de3cf98e99a615fa982b682d8f60f30b8be7541f801ae2d23beb9c8917dc39a1 | 9a154ec60017bacbbcb3a827aa8e6c892e291567 |
| apps/desktop/tests/renderer/components/reportPresentation.test.ts | beafda05e5ef930ce8872356048384b4ebe2d87d55c3c92b12f1d3ba040b2bbc | 5b90c79a9e0f165f26896987f9640c61de0d95d9 |
| apps/desktop/tests/renderer/components/RunView.test.ts | 3c771d3a5178812028b332936eabef8b7faa80fb0c83a9936beb8d689b8d29a7 | 3d0569f591b34c86c1a5035f259acaefdc14f3eb |
