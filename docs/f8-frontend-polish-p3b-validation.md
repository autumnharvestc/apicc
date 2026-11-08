# F8 P3b：压测报告逐点验证

2026-11-08，分支 `codex/f8-frontend-polish`，基线 `ac800736`。本组按 [设计](f8-frontend-polish-p3b-design.md) 修改两个组件和两份语言文件，不改 Core 统计、执行器、store、基线选择或导出协议。仅定向验证；没有运行本地全量/完整门禁，也没有合并或推送。

## 逐点对照

| 验收条件 | 实现 / 保留边界 | 证据 | 状态 |
| --- | --- | --- | --- |
| 逻辑成功和原始请求失败分开 | 两块摘要；原始请求、用例行、HTTP 交换、完整性和生命周期说明全部保留 | stressWorkbench 的逻辑/预算/完整性、最终权威结论；浏览器4/4与10/失败6并列 | 已验 |
| 节点计数可独立读出 | 访问/通过/失败/中止/跳过、合格请求/请求失败各列；聚合桶本地化，业务 ID 原样 | 新节点用例，含15次访问及失败/缺测/真实0；中英宽窄截图 | 已验 |
| 生命周期可读且不改原值 | 角色/VU/状态/耗时/失败类型表格，耗时原值 title 可查 | 新生命周期用例及原2项生命周期回归；1.234567显示1.23、0保持0、失败HTTP、业务VU名原样 | 已验 |
| 阈值与旧安全策略有单位和语义 | 阈值实际/要求分列；安全策略快照与运行请求/生效并发独立命名；RSS以MiB、速率以请求/秒 | Core真实阈值百分比/ms/RPS原回归；新增旧安全字段及策略3/请求2/生效1反例；旧报告7项调用方 | 已验 |
| 未知码不被误译 | 安全决策只用Core专用表及confirmed/allowed已有别名；未知码即使名为http/passed也原样 | 新legacy/v2精确决策片段数组，原I5的已确认/允许/未知业务码回归 | 已验 |
| 证据缺测和空样本区分 | 标题显示实际保留数，不硬编码20；明确样本数不代表失败总数；缺测与空数组不同 | 新双语证据空态测试，浏览器展开；原CaseEvidencePanel不改 | 已验 |
| 趋势不伪造观测，宽表局部滚动 | 原图点/断线/坐标算法不变；阶段合格完成/失败分列；主题色与间距 | 原零/单桶/缺口/来源阶段测试；单桶图、640px局部滚动实看 | 已验 |
| 相邻功能保持 | AI引用捕获/回调不改；基线固定与过滤/导出选择不改；历史复用报告 | 原固定基线与精确导出选择，7项旧报告/历史回归；独审核对diff | 定向已验，不代表原生完整执行链 |

## 测试、构建及真实失败记录

锁定 Node 22.19.0/pnpm；日志在 `local/f8-frontend-p3b/`。选择命令为：

```text
pnpm --dir apps/desktop exec vitest run tests/renderer/components/stressPresentation.test.ts tests/renderer/components/stressWorkbench.test.ts -t 'P3b|final I|T7 R1|T7 keeps|T7 explains|keeps the explicit baseline|shows the authoritative'
pnpm --dir apps/desktop exec vitest run tests/renderer/components/components.test.ts -t 'StressReportView|RunsHistory kind'
```

| 日志 | 结果 / 说明 |
| --- | --- |
| presentation-red.log | 首次误用了未导出的Core路径，0测试；不算业务RED |
| presentation-red-valid.log | 修正导入后4项进入真实组件并失败；其中旧安全测试的generator标为available却缺完整字段，后续补齐并加Schema校验，因此不声称该夹具已具备完整合法前提的先红证据 |
| presentation-green.log / targeted-green.log | 首轮新增3/4通过；失败类型误用“分类”修正为专用标签；随后既有12项通过，新用例1项因预期Run-level与现有Run level拼写不同失败，仅改测试预期 |
| presentation-final.log | 首批4项通过；后来加强generator合法前提并非伪造先红 |
| legacy-consumers.log | 7通过，67未选；保留jsdom pseudo-style提示 |
| review-red.log | 审核2项缺陷的3个反例失败：未知码碰名legacy/v2、策略/请求并发混淆；后续发现http子串会被URL满足，改为精确片段数组，不冒称原断言已能独立识别http误译 |
| review-green.log | 18通过/1失败/3未选；移除通用映射后误丢既有confirmed/allowed别名。保留原失败，不改旧测试放行 |
| review-final.log | 仅显式恢复上述两别名后19通过/3未选（新7项+既有报告12项） |
| unknown-exact-final.log | 强化精确断言后2通过/5未选；5项此前已验，不重复计数 |
| vue-typecheck.log / vue-final.log / vue-frozen.log | 各对应候选Vue类型检查；最终以frozen日志为准 |
| renderer-build.log / renderer-final.log / renderer-frozen.log | 对应候选renderer构建；最终以frozen日志为准；保留既有大chunk提示 |

本组去重 **26 项定向通过**（7新增呈现、12既有压测工作台、7旧报告/历史），70项未选。红绿复跑和单项强化不累加通过数；流程/夹具失误按上表保留，不声称严格全程TDD或单次全绿。

## 集中实际组件验收

实际 StressReportView/StressTrendView + ThemeLanguageToggle，合成props，夹具在 `local/f8-frontend-p3b/browser/`。导入Core后先用Schema验证v2数据；初次generator缺字段导致生成中止，补齐后才打开浏览器。没有真实后台、请求或IPC，也没有付费服务。

- 中文浅色1440×900：逻辑4/4通过、原请求10/失败6、完整性/容量/精度、节点和生命周期表格。
- 英文深色900×720：摘要换行、节点/生命周期长内容、0ms/缺测与业务ID保留。
- 英文深色640×720：document宽640/内容640，main宽625/内容625；节点表视口544/内容931，表头nowrap，溢出限制在表内。
- 旧报告英文1100×850：已确认别名、未知业务策略、策略/请求/生效并发分别可读；速率/RSS单位；失败证据展开为空样本说明。
- 单桶真实点和坐标、单点限制直接可见；浏览器error记录为空。七张PNG与[回执](design/f8-frontend/p3b/browser-receipt.json)均已封存。临时页/服务已关闭，视口恢复。

P2交付zip不包含P3a/P3b；本组未重新打包。原生287px、缩放、拖动、真实后台/IPC及完整任务链留P5；其他P3复杂页面和P4未由这些测试推定通过。

最终清单：[证据SHA清单](design/f8-frontend/p3b-evidence-manifest.json)。独审回执单独归档，本次两项缺陷在同一组审核中关闭，不重开全分支宽审。
