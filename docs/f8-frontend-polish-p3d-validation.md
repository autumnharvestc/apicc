# F8 P3d：AI 配置与辅助结果逐点验证

日期：2026-11-08。基线 `fef6de86`，工作树 `f8-frontend-polish`。本批改动限定在 AI 配置、建议抽屉及其展示子组件、局部 CSS 与一个中英文导航标签；不改 store、宿主、Core、协议和预算解析。不是整个 F8 或原生端到端验收。

## 需求、验收与实际证据

| 项目 | 验收条件 | 证据与结果 |
| --- | --- | --- |
| 配置区定位 | 连接/模型/预算可直接定位，聚焦标题，不卸载表单、不保存或联网 | 新 `P3d jumps to configuration sections…`：未保存名称与合成密钥不丢，设置和 networkActions 不变，URL hash 不变；实际浏览器三段往返，名称仍为 `未保存的合成连接 / Draft` |
| 连接及凭据 | 保留分层表单和单独保存；不可持久保存、地址重绑、模板冲突可读 | AiConfigDialog 原用例覆盖配置/密钥分离、重开密钥清空、失效/重绑、session-only、安全后端不可用、模板导入/冲突、错误后的重试；01 配置图及 03 模型图 |
| 模型与预算 | 能力声明、输入/输出预算、有效值和来源分别呈现；Token/字节/ms 不丢 | 原配置用例覆盖模型独立预算、应用/用途继承、范围拒绝、未知能力、请求次数与总输出预算；02/04 图、600px 下表格局部宽456/内容620，页面不横向溢出 |
| 配置弹窗高度 | 标题、导航与关闭按钮在短窗口内可达 | centered 与视口约束；600×360 实看关闭按钮底317、导航底127.51、聚焦标题顶140.81。11 图；这是浏览器，不代替 P5 原生287px |
| 具名候选选择 | 名称能识别选择对象，不自动采用/写盘 | 新 `P3d identifies each candidate checkbox…`：可访问名称含业务名，第二项只改 selectedIds，editor 原对象和 apiSave 不变；原抽屉用例覆盖明确采用、只读/过期/关闭/取消 |
| 出站确认 | 目标/来源、预算、包含/排除原因、脱敏限制直接可读，明确确认后才发送 | 原抽屉与共享结果测试覆盖确切预览、显式确认、默认不选正文、修改证据使预览失效并需重新预览、超额后删减再预览；05/06 图。浏览器没有点击发送 |
| 断言与脚本 | 条件、依据、业务原值、人工判断和脚本信任提示保留 | 所选 `T11 prepares independent assertions…` 与 `T11 shows independent assertion…`；07/08 图：脚本默认折叠，展开原文宽1877在573容器内滚动，暗色前景/底色可读；不执行脚本 |
| 报告事实 | 结论、程序事实、可能原因、建议、证据和限制分区，不把未采集当0 | 所选 `T11 separates conclusion…`、`T11 renders stress availability…`；09/10 图：逻辑总1/通过1/失败0，请求统计未采集，传输失败另列，推测明确“尚未证实”，限制直接显示 |
| 定位和导出 | 不扩大授权；保留独立安全副本与时间/来源 | 所选 `T11 locates only an authorised evidence ID…`、`T11 exports a separate safe AI analysis copy…`；合成浏览器所有未授权证据仍是不可定位文本，不伪造按钮 |
| 语言、主题和宽度 | 既有固定标签随语言切换，原始业务文本保留，长内容局部滚动 | 11 张最终截图，中文浅色/英文深色；480×600 抽屉由左侧裁剪修为视口约束，最终 left0/width480/documentWidth480；前后证据均保留 |

## 定向执行记录

使用既有 Node22/pnpm 工具链，在本工作树执行，日志在 `local/f8-frontend-p3d/`。没有调用 `test-all`、`pre-push-ci`、工作区全量、Java 全套或完整打包门禁。

| 日志 | 命令范围 | 结果 |
| --- | --- | --- |
| presentation-before.log | `vitest run tests/renderer/components/AiConfigDialog.test.ts tests/renderer/components/AiSuggestionsDrawer.test.ts -t P3d` | 实现前2失败、89未选：定位按钮不存在、候选无具名标签。初版标签预期误写“选择候选”，随后按已有文案纠正为“选择此候选”；不把错误文案子断言称为有效先红 |
| presentation-after.log | 同两项 | 2通过、89未选，8.43s |
| dialog-drawer-regression.log | 上述两个受影响组件文件，不加筛选 | 91通过，25.78s；涵盖原保存/模板/预算/发送/采用边界 |
| shared-results-regression.log | `AiAssertionSuggestions.test.ts`、`AiReportAnalysis.test.ts`，选择下列9项 | 9通过、41未选，12.71s |
| presentation-final.log | 最终定位/具名选择两项 | 2通过、89未选，9.25s；重复不累加 |
| typecheck-vue-final.log / build-renderer-final.log | `run typecheck:vue` / `run build:renderer` | 最终均通过；renderer 1.96s，仍有既有大于500KB chunk提示 |

共享测试筛选：`T11 prepares independent assertions|T11 shows independent assertion|T11 separates conclusion|T11 locates only|T11 exports a separate|T11 renders stress availability|final B UI explicit evidence|final C R73|final B I4 actual outbound`。

本组去重 **100项通过**，不是全量。91+9运行后，视觉检查追加了 modal 居中/高度、模板差异排布、抽屉宽度约束和sticky顶边间距；这些为呈现调整，复验实际宽窄/短窗口、两项新行为与最终Vue/renderer，没有机械重复100项。

## 视觉记录与局限

- 实际 Vue/Antd 组件配合个人设置和结果的合成 DTO。浏览器夹具在 `local/f8-frontend-p3d/browser/`；不接后台/IPC，不读取真实密钥或调用付费模型，采用/发送/保存语义由上述行为测试验证。
- 初次夹具遗漏 catalog.diff 导致 Vue 渲染错误，已补齐真实 DTO 结构。保留 `browser-fixture-initial-errors.json`；最终回执中仅这3条早期 warning/error，修正后未出现新增 warning/error。没有删除产品错误处理以清日志。
- 窄屏检查在修正前真实发现680px抽屉裁剪左侧，保存 `before-drawer-narrow-clipped.png`；改为 `min(680px, 100vw)` 后实际480px截图与几何已验证。此项是视觉先复现，不额外写CSS镜像测试。
- 图01–07早于最后两处纯几何修正；大视口下680px宽不变，内容/语义未变。图08、11及最终浏览器回执验证最终窄宽/短高边界；不将所有旧图冒称最后一次构建截图。
- 临时服务/标签收尾关闭，视口恢复。原生窗口、真实模型/完整IPC、应用缩放留 P5；本批没有更新安装包。此前P2交付zip仍不包含任何P3改动。

截图与几何回执见 [p3d](design/f8-frontend/p3d/)，[证据清单](design/f8-frontend/p3d-evidence-manifest.json)记录源码、测试、日志、截图哈希；[独审回执](f8-frontend-polish-p3d-review.md)独立记录审核范围和结论。
