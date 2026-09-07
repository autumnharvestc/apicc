# apicc 桌面端批次：存储 id 布局 + 同名放开 + 导入双入口 + 主页重构 设计

日期：2026-09-08
状态：口径已获用户逐条拍板（2026-09-07/08 澄清），本轮开工交付
前置：部署线已收官（specs/2026-09-06-apicc-server-deploy-design.md）

## 0. 模型总纲

一切对象（分组/项目/模块/目录/接口/用例/环境/工作流）以 UUID 为唯一身份，名称仅为显示属性；**全层级允许同级同名**。盘上布局随之从「名称制」改为「id 制」。

## 1. 轨一：存储 id 布局（core）+ fail-fast + 同名放开

**现状核实**（fileStorage.ts）：load 全部按目录遍历读 yaml 内容（目录名仅用于行走与报错路径），save 按 `g.name/p.name/c.name/f.name/api.name` 建目录、`e.name.yaml`（环境）、`wf.name/workflow.yaml`（工作流）、`tc.name[.scope].yaml`（用例）；孤儿目录清理在桌面主进程 `cleanupOrphanDirs` 按名称（含 win32 大小写归一特判）匹配。

**改动**：
- save：全部目录/文件名改用实体 id——`groups/<g.id>/projects/<p.id>/collections/<c.id>/folders/<f.id>/apis/<a.id>/`、`environments/<e.id>.yaml`、`workflows/<wf.id>/workflow.yaml`、`cases/<tc.id>[.<scope>].yaml`。workspace.yaml 不变。
- load：**fail-fast 守卫**——任一层目录/文件基名不是合法 UUID 即抛错拒绝打开：`该工作区由旧版布局创建（目录名应为 id）：<相对路径>。请新建工作区使用；旧内容可经 OpenAPI 导出/导入迁移。`（用户裁定：不做自动迁移，静默双份数据不可接受）。在线模式走服务端 tree/content API，不经本地 fileStorage，不受影响。
- 同名放开：desktop `session.ts` 与其 jsdom 替身 `memory.ts` 中全部同级重名拒绝移除（createGroup/Project/Collection/Folder/Api/Workflow、renameNode、renameWorkflow、importProject）；环境同名放开一并覆盖。`sameName` 工具仅剩 workspace 内部用到名称比对的场景（ensureDefaultGroup 的同名补标记等），拒绝语义不复存在。
- cleanupOrphanDirs：改为按 id 精确匹配（win32 大小写特判自然消亡）。
- sanitizeNodeName 保留（防手输不可见字符等卫生用途），但不再承担「保护盘上目录」职责。

## 2. 轨二：克隆 / 移动 / 导入双入口（desktop main + 向导）

- **克隆项目** `project:clone`：整项目深拷贝（项目/环境/模块/目录/接口/用例/工作流全部新 UUID；变量/全局参数/操作列表随 structuredClone 带走），落回原分组，名称=原名（同名允许；头像色按 id 区分）。返回新项目 id。
- **移动项目** `project:move`：按 id 从原分组 splice 到目标分组，落盘。原分组为空不特殊处理。
- **导入双入口**（复用同一 ImportWizard，`mode` 区分）：
  - `project`（主页入口）：第二步=「目标分组」下拉（按 id 选择，默认分组默认选中，**不提供新建分组项**）+「项目名」输入（预填 title 可改）；apply=整项目落库含 `imported` 环境。`importApply` 载荷由 `groupName` 改为 `{mode, groupId, projectName}`（主进程按 id 找分组）。
  - `module`（api.head 入口，落当前项目）：**无落点选择**；第二步=「模块名」输入（预填 title 可改）；apply=把导入产物的每个集合改名后追加为当前项目的模块；`baseUrl` 写入该模块 `variables.baseUrl`（取导入环境里的 baseUrl 变量；变量链=环境>模块>全局，环境可覆盖），**不创建环境**，导入产物的环境/工作流在 module 模式丢弃。
  - 同名不拒绝（轨一生效）：导入即追加，重复导入同一文件得到两个同名模块（卡片/树按 id 区分）。
- 主页入口位置：项目区工具栏「导入项目」；项目视图入口维持 api.head 既有「导入」按钮，按当前项目进入 module 模式。

## 3. 轨三：主页左右栏重构 + 项目卡片 + 管理连接收口（renderer）

**主页 = 内部左栏 + 右栏**（参考已确认的交互图；ui-zones.md 届时补区块 id）：

- 左栏：
  - 「我的团队」= 当前本地工作区；子项=分组列表（含默认分组，点击过滤右栏）+「+ 新建分组」；未开工作区时显示「打开本地工作区」入口（现状行为保留）。
  - 远程服务器：每条在线档案一项（昵称，色块头像）；子项=该服务器的团队空间清单（已登录才可拉取；未登录显示引导去「管理连接」）；远程侧右栏只读，无「导入/新建」工具栏。
  - 底部「管理连接」按钮 → 右栏切换连接面板。
- 右栏：
  - 标题=左栏选中项名；本地侧工具栏=「导入项目」+「+ 新建项目」（新建对话框带分组选择器，默认「默认分组」）。
  - 项目卡片网格：色块+项目名首字头像（按项目 id 确定性生成颜色，纯 CSS 零素材——素材许可合规约束）、项目名；**不放标签但卡片组件预留标签插槽**（后置：双视图/排序/收藏/标签数据）。
  - 卡片操作：点击进入项目（本地）；悬停/「…」菜单=修改名称 / 克隆项目 / 移动项目（弹分组选择）/ 删除项目（非空确认沿用现状确认对话框）。
- **管理连接面板**（右栏形态）：连接列表行=头像+昵称+地址+登录状态；行内操作=编辑 / 删除 / 登录 / 浏览（拉取空间清单并打开）。新增连接=同表单空态。
- **登录对话框收口**：OnlineLoginDialog 移除档案增删改（档案管理唯一入口=管理连接面板），仅保留登录态展示 + 在线空间清单 + 退出登录；顶栏「在线模式」入口行为不变。

## 4. 测试口径

- core：id 布局 save→load 往返深等价；同层级同名实体共存落盘/读回；旧布局（名称目录）load 抛错文案钉住；用例/环境/工作流 id 文件名；clone 深拷贝 id 全新生成且内容深等价。
- desktop main：同名 create/rename 成功路径；clone/move IPC 契约；importApply 双模式（module 模式 baseUrl 进模块变量、不产环境；project 模式整包落库）。
- renderer：主页左右栏渲染/过滤/工具栏；卡片菜单四操作；管理连接列表与登录对话框收口后的形态；导入向导双模式表单差异。
- 真机核验：打包应用过一遍主页→新建分组/项目→项目视图导入 OpenAPI→同名再导一次→克隆/移动/改名/删除→重启恢复。旧布局 fail-fast 用既有 ws3（名称制存量）开一次验证拒绝文案。
- 全量基线 + CI 四 job。

## 5. 明确不做（后置）

卡片/列表双视图、排序、收藏星标、卡片标签数据模型、文件夹变量、场景级压测、多标签编辑（既有延后清单不变）。
