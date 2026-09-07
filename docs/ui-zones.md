# 界面区域命名与唯一 ID 约定（ui-zones）

本文约定桌面端各界面区域的中文名称与唯一 ID，用于沟通、缺陷描述与自动化定位。

## 命名规则

- **中文名**用于日常沟通（如「接口头」「API 栏」「主页卡片」）；
- **ID** 为小写点分层级（`区域.子区域`），是沟通与代码的单一锚点；
- 每个 ID 与组件上既有的 `data-testid` 一一对应（见各表末列）——缺陷定位、自动化测试直接复用，不另造体系；
- 浮层（覆盖在主视图之上的对话框/抽屉）一律 `overlay.` 前缀；模块主视图一律 `module` 语义前缀（test / envs / wf / run）；
- 新增区域按同规则续编：先定中文名与归属层级，再补 `data-testid` 并在本表登记。

层级总览：`顶栏 + 导航栏 + API 栏（按模块专用） + 主视图 + 浮层`。数据层级（工作区 → 分组 → 项目 → 模块 → 文件夹 → 接口 → 用例）见 README。

## 一、全局框架（任何视图下都在）

| ID | 名称 | 说明 | data-testid |
|---|---|---|---|
| `topbar` | 顶栏 | 顶部横条 | `topbar` |
| `topbar.workspace-name` | 工作区名 | 当前工作区/在线空间名 | `workspace-name` |
| `topbar.home` | 主页按钮 | 进入主页（取代旧模式徽标位） | `topbar-home` |
| `topbar.project-switch` | 项目切换 | 下拉切换当前项目 | `project-switch` |
| `topbar.online` | 在线模式按钮 | 打开在线登录/连接对话框 | `online-toggle` |
| `topbar.settings` | 设置按钮 | 齿轮，打开设置抽屉（内含插件管理） | `settings-toggle` |
| `topbar.lang` | 语言切换 | 中文 / English | `lang-toggle`（菜单项 `lang-option`） |
| `topbar.theme` | 主题切换 | 自动 / 亮色 / 暗色 | `theme-toggle` |
| `rail` | 导航栏 | 左侧竖条，五项 | `module-rail` |
| `rail.api` | 导航项·接口 | | `rail-api` |
| `rail.run` | 导航项·运行 | | `rail-run` |
| `rail.wf` | 导航项·工作流 | | `rail-wf` |
| `rail.test` | 导航项·测试 | | `rail-test` |
| `rail.envs` | 导航项·环境 | | `rail-envs` |
| `toast.error` | 全局错误条 | 顶部错误提示，可手动关闭 | `app-error`（关闭钮 `app-error-close`） |

## 二、主页

| ID | 名称 | 说明 | data-testid |
|---|---|---|---|
| `home` | 主页 | 内部左栏（落点选择）+ 右栏（内容视图），整页无 API 栏 | `home-view` |
| `home.sidebar` | 主页左栏 | 落点选择：我的团队（本地工作区+分组树）/ 服务器 / 底部「管理连接」 | `home-sidebar` |
| `home.sidebar.local` | 我的团队 | 本地工作区节点（选中=右栏全部项目）；子项=分组（选中=过滤）+ 新建分组；常驻打开/新建本地目录 | `home-side-local` |
| `home.sidebar.group` | 分组节点 | 行内 重命名 / 删除（仅空分组可删） | `home-side-group` |
| `home.sidebar.server` | 服务器节点 | 每条在线档案一项，选中=右栏该服务器团队空间只读清单 | `home-side-server-{baseUrl}` |
| `home.content` | 主页右栏 | 内容视图：项目网格 / 服务器视图 / 连接管理面板 三态切换 | `home-content` |
| `home.content.toolbar` | 项目区工具栏 | 导入项目（project 模式向导）+ 新建项目（带分组选择器） | `home-import-project` / `home-new-project-top` |
| `home.content.card` | 项目卡片 | 色块头像（按 id 确定性生成）+ 名称 + 菜单（修改名称/克隆/移动/删除）；预留标签插槽 | `project-card-{id}` / `project-menu-*` |
| `home.connections` | 连接管理面板 | 连接列表（头像/昵称/地址/登录态）+ 新增/编辑/删除/登录/浏览——档案管理唯一入口 | `connections-panel` / `connection-*` |
| `home.import-modal` | 导入项目向导 | project 模式：目标分组下拉（默认「默认分组」）+ 项目名（预填可改） | `home-import-modal` / `import-group-select` |
| `home.move-dialog` | 移动项目对话框 | 目标分组下拉 | `home-move-dialog` / `home-move-dialog-group` |
| `home.project-dialog` | 新建项目对话框 | 分组选择器（默认「默认分组」）+ 项目名 | `home-project-dialog` |

## 三、侧栏（API 栏，按模块专用）

API 栏仅在**接口**与**测试**模块显示（`sidebar-api` / `sidebar-test` 两个常驻实例按模块显隐）；运行、工作流、环境与主页不显示。

| ID | 名称 | 说明 | data-testid |
|---|---|---|---|
| `sidebar.api` | 接口模块侧栏 | 标题 + 搜索 + 接口树 | `sidebar-api` |
| `sidebar.api.title` | 树标题 | 当前模块名 | `sider-title` |
| `sidebar.api.search` | 树搜索 | 按名称过滤，命中展开 | `tree-search` |
| `sidebar.api.tree` | 接口树 | 模块 → 文件夹 → 接口（图标 + 缩进 + 折叠钮） | `side-tree` |
| `sidebar.test` | 测试模块侧栏 | 锚点 + 接口清单 + 场景清单 | `sidebar-test` |
| `sidebar.test.anchors` | 测试锚点 | 单接口用例 / 场景用例 | `test-tab-api-cases` / `test-tab-scenario` |
| `sidebar.test.api-list` | 测试接口清单 | 按模块分组，点选载入用例面板 | `test-api-*` |
| `sidebar.test.scenarios` | 场景清单 | 项目工作流；行内「运行」 | `test-scenario-*` |

侧栏状态（展开/选中/过滤/页签）按模块独立记忆，重启保留（应用本地存储）；接口树恢复选中接口时会同步载入编辑器。

## 四、接口模块

| ID | 名称 | 说明 | data-testid |
|---|---|---|---|
| `api.head` | 接口头 | 子视图页签 + 导入 + AI 按钮 | `api-head` |
| `api.head.subtabs` | 子视图页签 | 调试 / 设计 | `api-sub-tabs`（项 `view-debug` / `view-design`） |
| `api.head.import` | 导入按钮 | 打开导入向导（浮层） | `api-import-btn` |
| `api.urlbar` | URL 栏 | 协议 / 方法 / URL / 环境 / 用例 / 发送 / 保存 | `editor-protocol` `editor-method` `editor-url` `debug-env-select` `debug-case-select` `send-btn` `save-btn` |
| `api.tabs` | 请求配置页签 | 参数 / 请求头 / 认证 / 请求体 | `tab-params` `tab-headers` `tab-auth` `tab-body` |
| `api.editor` | 请求编辑区 | URL 栏 + 页签整体 | `editor-pane` |
| `api.divider` | 分割条 | 可拖拽调整上下高度，双击复位 | `split-divider` |
| `api.response` | 响应面板 | Body / Headers / 断言 + 状态行 | `viewer-pane` |

## 五、其余模块主视图

| ID | 名称 | data-testid |
|---|---|---|
| `test.cases` | 用例面板（用例项增删、断言表、前置/后置操作列表，行内运行/压测） | `case-panel` |
| `test.result` | 运行结果（内嵌响应查看） | `test-result` |
| `test.stress` | 压测面板（从用例行「压测」进入） | `stress-panel` |
| `envs.panel` | 环境管理（全局变量 / 全局参数 query·header·cookie·body / 环境清单与详情） | `env-panel` |
| `wf.designer` | 工作流设计器（清单 / 画布 / 属性） | `wf-designer` |
| `run.view` | 运行视图（集合运行 + 历史入口） | `run-view` |

## 六、浮层（覆盖主视图之上）

| ID | 名称 | data-testid |
|---|---|---|
| `overlay.confirm` | 通用确认 / 命名对话框（重名等错误行内显示） | `confirm-dialog`（`dialog-input` `dialog-confirm` `dialog-cancel` `dialog-error`） |
| `overlay.container` | 容器管理（模块：变量/前置/后置；文件夹：前置/后置） | `container-dialog` |
| `overlay.import` | 导入向导（三步：选择文件 / 预览 / 完成） | `import-wizard` |
| `overlay.login` | 在线登录与连接对话框 | `online-body` |
| `overlay.conflict` | 在线推送冲突 | `online-conflict-dialog` |
| `overlay.migrate` | 在线迁移向导 | `online-migrate-dialog` |
| `overlay.ai-config` | AI 配置对话框 | `ai-config-dialog` |
| `overlay.ai-suggest` | AI 建议抽屉 | `ai-suggestions-drawer` |
| `overlay.settings` | 设置抽屉（内含插件管理 `plugins-view`） | `settings-drawer` |
| `overlay.runs-history` | 运行历史抽屉（入口按钮 `runs-history-btn`） | `runs-drawer` |

## 变更流程

新增区域或更名时：① 定中文名与归属层级；② 组件挂 `data-testid`（与 ID 对应，浮层前缀 `overlay.`）；③ 本表登记一行。PR 中改动界面结构时请同步本表。
