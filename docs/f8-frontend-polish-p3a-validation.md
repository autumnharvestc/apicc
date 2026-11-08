# F8 前端 P3a：运行报告、证据与 Console

2026-11-08，工作树 `f8-frontend-polish/apicc`，分支 `codex/f8-frontend-polish`。范围按 [P3 盘点](f8-frontend-polish-p3-inventory.md) 的 P3a 边界执行。未提交、合并或推送；未运行本地全量或完整 CI。

## 逐点对照

| 需求 / 验收条件 | 实现与保留边界 | 测试 / 证据 | 状态 |
| --- | --- | --- | --- |
| 逻辑通过与原始失败分开 | RunSummaryView 复用 Core reportingUnits，另列原始行与请求事实；不再以第一个工作流单元替代整体结论 | presentation 的逻辑/原始、容量投影、旧报告诊断三项；实际组件中文宽屏与英文窄屏 | 已验 |
| 节点、套件状态可直接阅读 | 节点/条目表有本地化类型、结果、1 起算行号、原因；未知码原样；警告及诊断仍显示 | 上述三项与 RunView 既有跳过/失败/行号测试，HTML 特殊字符保持字面文字 | 已验 |
| 证据主视图可读，正文与安全边界保留 | 元信息字段卡；指纹短显/展开；断言实际/期望与差异路径，提取状态/原因/值分组；请求/响应业务 JSON 原样 | presentation 的字段/操作与迟到保护、RunView C1 证据复制/语言与重跑收束、共享套件 2 项；指纹键盘展开，英深色局部滚动 | 已验 |
| 作用域环境名不误译 | Core scope 是 base 或环境名；只翻译保留值 base，其余原样 | scope 单项：project/global/api/collection/中文环境名原样，base 英文；两张证据图修后更新 | 已验 |
| 定位/重跑与复制不被布局改变 | 原 inspect/rerun/watch 代次保护、disabled/busy/available 门控和复制函数不变 | 精确 DTO 序列化复制、迟到 inspect、disabled 按钮、事件身份、合成定位/重跑各一次 | 已验；浏览器剪贴板字节未独立确认 |
| Console 可读，原文不变 | 按已有顺序显示 4 类日志级别/消息；无时间戳不造时间列 | presentation 的 Console 项：中英文、顺序、换行、HTML 字面、空状态；实际 4 行日志、长消息不撑宽 | 已验 |
| 原功能和共享调用方 | RunView 运行/历史/环境/分享/观测绑定不改；ResponseViewer 仅 Console 增量；共享证据调用方静态盘点 | RunView 10 项、ResponseViewer 13 项、SuitePanel 所属 testingCenter 2 项；独审检查直接调用方 | 定向回归和独审已完成 |

## 命令与结果

使用已有锁定 Node 22.19.0 / pnpm，日志均在 `local/f8-frontend-p3/`。

| 命令（在仓库根目录使用 pnpm --dir apps/desktop） | 日志 | 结果 |
| --- | --- | --- |
| `exec vitest run tests/renderer/components/reportPresentation.test.ts`（实现前） | presentation-red.log | 5 项因旧可读视图缺失失败；1 项已有迟到响应保护通过 |
| `exec vitest run tests/renderer/components/reportPresentation.test.ts tests/renderer/components/RunView.test.ts`（首轮） | run-evidence-tests.log | 15 通过 / 1 失败：旧套件测试仍要求英文点分隔串 |
| 同上（结构化断言适配后） | run-evidence-tests-final.log | 16 通过 |
| `exec vitest run tests/renderer/components/components.test.ts -t ResponseViewer` | response-regression.log | 13 通过 / 61 未选 |
| `exec vitest run tests/renderer/components/testingCenter.test.ts -t 'localizes nonempty suite result\|localizes suite terminal'` | shared-suite-regression.log | 2 通过 / 12 未选 |
| `typecheck:vue`（首轮） | vue-typecheck.log | 2 处类型问题：i18n 参数需对象投影，get 返回值无 exists；已最小修正 |
| `typecheck:vue`（修正后） | vue-typecheck-final.log | 通过 |
| `build:renderer` | renderer-build.log | 通过；保留既有大 chunk 提示 |
| `exec vitest run tests/renderer/components/reportPresentation.test.ts -t 'preserves scope environment names'`（自审缺陷） | scope-red.log / scope-green.log | 先观察 4 个真实误译失败；修正后 1 项通过 / 6 未选 |
| `typecheck:vue` / `build:renderer`（scope 修正后） | vue-typecheck-scope-final.log / renderer-build-scope-final.log | 通过；保留大 chunk 提示 |

本组去重 **32 项通过**，73 项未选；scope 单跑未选的6项已在前轮通过，不再次计为未覆盖。不累计红绿复跑次数。原 RunView 的 1 起算/缺行断言由旧等号串改为 dt/dd，套件由英文串改为逐列完整数组，未删除原事实验证。Console 空状态断言准备时误写成 not collected，核对现有文案后更正为 no console capture capability；产品原提示保持。

## 实际组件浏览器证据

夹具：`local/f8-frontend-p3/browser/`，导入实际 RunView、CaseEvidencePanel、ResponseViewer 和主题控件；用合成数据与内存事件，无真实网络/后台/IPC。截图和 [验收回执](design/f8-frontend/p3a-evidence/browser-receipt.json) 位于 `docs/design/f8-frontend/p3a-evidence/`。

- 中文浅色 1440×900：运行摘要分区、节点表、证据字段与断言卡可读。
- 英文深色 900×720：标签切换、业务原文不翻译、长内容局部滚动。Console 4 行有序，无新 img/script 元素；文档宽度仍 900。
- 640×720：表格视口 592 / 内容 640，文档宽度 640，表头不逐字断开；键盘滚动后 scrollLeft 40，末列仍可达。
- 指纹 Enter 展开完整 64 字符并可折叠；定位/重跑合成计数各 1。浏览器点击复制后工具读回空剪贴板，**不称浏览器字节校验通过**；字节不变由组件测试确认。
- 工具初次按 button 定位原生 summary 失败；读取 DOM 后改用 summary 控件，验证成功。浏览器保留既有 Tabs 废弃 slot 提示；组件回归保留 jsdom pseudo-style 提示，不声称零警告。

## 未覆盖部分

P3 压测页、测试中心完整编辑、AI/同步/在线/工作流其余页面仍待后续子组；P4 管理与公共/离线页面待推进。原生 287px 短窗口、缩放、拖动及真实落盘/请求/IPC 保留 P5。本组不以样例截图代替这些验证。

P2 已冻结的新包不含 P3a；本组代码没有重新打进那个 zip。

## 独审封存

[最终独审回执](f8-frontend-polish-p3a-review.md)：无未关闭 P0/P1/P2，P3a 可结项。作用域误译在本次同一审核中以单项增量关闭，没有再次开启宽审。最终 [清单](design/f8-frontend/p3a-evidence-manifest.json) 共30项（8源/测试、12日志、6图+浏览器回执、3夹具），全部实际哈希匹配，清单 SHA256 `561f70ab601b4088b111c887a08f59fcb0972e8d33f14004ef3b00174f9b54a7`。临时页与Vite服务已关闭，视口恢复。
