# M8 桌面端布局层级改造 — 设计规格（2026-09-06）

## 背景与目标

用户反馈：借鉴参考产品（主流 API 协作平台）的界面布局与展示层级改造 apicc 桌面端渲染层。
参考层级：**图标导航栏（模块）→ 树面板（资源）→ 接口子视图页签 → 请求配置区 → 底部响应区**。

现状：九个视图以「侧栏顶部 radio 按钮组」平铺切换（debug/cases/envs/run/import/design/wf/stress/plugins），
调试页为「名称行 + URL 行 + 页签」，响应区为「徽标行 + 断言表 + 页签」，无模块层级。

## 设计

### 1. 布局骨架

```
┌─ TopBar（不动：工作区/在线/语言/主题）──────────────────────┐
├──┬─────────┬──────────────────────────────────────────────┤
│图│ 树面板   │ 内容区                                        │
│标│ 240px   │  ┌ 接口头（名称+徽标+dirty）/ 模块标题 ┐      │
│导│ 模块标题 │  ├ 子视图页签（仅接口模块：调试/设计/用例）┤    │
│航│ 搜索框   │  ├ URL 栏（方法+URL+环境+用例+发送+保存）┤     │
│栏│ 侧树    │  ├ 请求配置页签 ──────────────────┤            │
│64│        │  ├──── 可拖拽分割条 ──────────────┤            │
│px│        │  └ 响应面板（页签+状态胶囊右对齐）──┘           │
└──┴─────────┴──────────────────────────────────────────────┘
```

- 图标导航栏（新增 `ModuleRail.vue`）：64px 竖排，`@ant-design/icons-vue`（ant-design-vue
  自带依赖，MIT）图标 + 11px 中文/英文标签，选中态高亮 + 左侧指示条；tooltip 展示完整名。
- 树面板头（SideTree 增强）：模块标题（当前模块 i18n 名）+ 搜索框（前端按节点 label
  不区分大小写过滤，命中节点自动展开其祖先链）；在线模式只读语义不变（隐藏搜索外动作）。

### 2. 模块归并（9 平铺视图 → 7 模块）

| 模块 | 图标 | 内容 | 门控 |
|---|---|---|---|
| api 接口 | ApiOutlined | 子视图页签：调试/设计/用例（原 debug/design/cases） | 需打开工作区 |
| run 运行 | PlayCircleOutlined | RunView（原样） | 需打开工作区 |
| wf 工作流 | DeploymentUnitOutlined | WfDesigner（原样） | 需打开工作区 |
| stress 压测 | ThunderboltOutlined | StressPanel（原样） | 需选中接口 |
| envs 环境 | GlobalOutlined | EnvPanel（原样） | 需打开工作区 |
| import 导入 | ImportOutlined | ImportWizard（原样） | 需打开工作区 |
| plugins 插件 | AppstoreOutlined | PluginsView（原样） | 恒可用 |

- `viewSwitch.ts`：`SwitchView` 收敛为上述 7 模块；新增 `ApiSubView = "debug" | "design" | "cases"`
  与 `isApiSubViewDisabled`（接口未选中禁用，在线模式禁用）；`isViewDisabled` 语义按上表
  调整（门控判定不变，仅归属从视图改为模块）。
- 在线模式：内容区仍整体让位 `OnlineApiEditor`（现有裁定不变），rail 全禁用。

### 3. 调试子视图重排（RequestEditor + App）

- 接口头（App.vue 内 api 模块头部）：名称输入 + 协议三选（原样保留）+ dirty 点 + AI 按钮右对齐
  （原 debug-ai-bar 收编于此，testid 不变）。
- URL 栏：方法选择按语义着色（GET 绿 / POST 橙 / PUT 蓝 / DELETE 红…，antd select dropdown
  与选择框文字色）、URL 输入、环境选择、用例选择、发送（primary）、保存。
  全部 testid 不变（editor-method/editor-url/debug-env-select/debug-case-select/send-btn/save-btn）。
- 请求配置页签：params/headers/auth/body + 按协议 message/envelope（逻辑不动）；
  Body 页签内把 kind 下拉改为胶囊单选组（none/form/json/xml/raw/graphql，testid body-kind 保留）。
- main-split 结构契约保留：调试子视图下 editor-pane + viewer-pane 两个子元素（App 布局测试钉住）。

### 4. 响应面板重排（ResponseViewer）

- 顶部行：左侧页签（Body / Headers / 断言——断言从独立块收编为页签，新增
  `response-tab-assertions`）；右侧状态胶囊（2xx 绿 / 4xx 橙 / 5xx 红 / 其他灰，语义色
  a-tag，testid response-status 保留）+ 耗时（response-time）+ 用例名（response-case-name）+
  outcome 徽标（response-outcome）+ 错误 tag。
- Body/Headers 内容渲染逻辑不变（Pretty JSON、响应头表格）。

### 5. 可拖拽分割条（App.vue）

- editor-pane 与 viewer-pane 之间 4px 竖条（hover 高亮），pointer 事件拖拽调整
  viewer 高度占比（clamp 20%–70%），键盘不可达时可双击恢复默认 40%。纯前端布局态，
  不入 store、不持久化。

### 6. i18n

- zh/en 增补：模块标题复用现有 `nav.*`（debug→调试 等保留给子视图页签），新增
  `nav.api`（接口）、`tree.searchPlaceholder`、`response.assertions`（已有）核对、
  分割条 aria 文案。英文同步。

## 非目标（YAGNI，入账本待后续）

- **多标签编辑**（参考图的接口标签栏）：需编辑器 store 从单会话重构为会话表
  （cases/design/stress 均绑定 editor.apiId，连带面大），列为下一里程碑候选。
- 环境选择器上收顶栏、底部状态栏、Mock/文档预览/修改记录、请求前置/后置操作页签。

## 测试

- `viewSwitch.test.ts`：模块清单/禁用语义/子视图禁用全量重写。
- `App.test.ts`：视图切换点改 rail-* testid；调试子视图契约（main-split 两子元素、
  editor-pane/viewer-pane 存在性）保留；新增 api 子视图页签切换断言。
- 新增 `ModuleRail.test.ts`（渲染/切换/禁用门控）、SideTree 搜索过滤用例。
- 守卫链全绿后跑打包冒烟四道底线（存活/无 FATAL/title/#app 挂载非空）。

## 风险

- App.test.ts 改动面大（视图切换路径全部换 testid）——逐段核对引用清单后改。
- antd Tabs 页签 slot 内 testid 模式沿用（#tab span），无新坑。
- 分割条 pointer capture 在 jsdom 不可测——只测样式/结构存在性，拖拽行为手工冒烟。

## 裁定记录（用户离线，沿用既有授权「由我决定、最优实践导向」）

- D1 不做假标签栏：多标签是真功能不是布局，宁缺毋滥，单接口头 + 子视图页签表达层级。
- D2 rail 图标用 ant-design 图标（MIT，许可合规），不引入新素材。
- D3 断言收编为响应页签而非独立块——与参考层级一致，testid 全保留。
