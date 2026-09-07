# M10 操作模型与项目级环境设置 — 设计规格（2026-09-07）

## 背景（M9 后用户澄清纪要，全部已确认）

- 主页新建分组/项目走命名对话框（重名对话框内报错）；
- 默认分组：持久化标记识别（非名字）；新建目录自动建、存量打开补建（同名就地补标记）；不可删不可改；
- 自建分组仅空（无项目）可删，主页行内入口；
- 全局参数归属项目、四类（query/header/cookie/body）：body 仅对 form-data/x-www-form-urlencoded
  请求合并（接口同名 key 优先，不改变请求形态）；cookie 序列化为 Cookie 头（接口自有 Cookie 整头优先）；带启用勾选；
- 全局变量 = project.variables（UI 名「全局变量」，沿用环境模块页签）；workspace 级 globals 弃用不迁移；
- 集合更名「模块」（存储 kind=collection 不变），表征项目内一个服务；前置 URL 按模块（环境管理内）；
- 集合变量保留，管理入口在模块「管理」对话框；
- 文件夹保持叫法，无变量；模块与文件夹任意层级均可挂「前置操作/后置操作」；
- 操作模型：Operation = { id, type, 参数 }（第一版仅 type=script），有序列表；用例级 preScript/postScript
  同步升级为操作列表（同一概念）；执行 = 沿执行路径前置自上而下、后置自下而上；旧 scripts/preScript 读取自动转换；
- 导入归属接口模块（rail 移除，接口头右侧按钮）；环境选中态项目级会话内记忆（调试/压测共享）；
- 文件夹变量、场景级压测、多标签编辑：延后。

## 数据模型变更（core domain）

```
GroupSchema      += default?: boolean                       # 默认分组标记（缺省 undefined）
ProjectSchema    += globals: { query, headers, cookies, body: KV[] }.default  # 全局参数（仅参数）
WorkspaceSchema   # globals 键保留但弃用（兼容旧文件 strict 解析），不再读写
CollectionSchema += preOperations/postOperations: Operation[]（scripts 保留为读兼容可选字段）
FolderSchema     += preOperations/postOperations: Operation[]
TestCaseSchema   += preOperations/postOperations: Operation[]（preScript/postScript 读兼容可选）
OperationSchema   = { id, type: "script", content: string }
```

读取归一（fileStorage/loadYaml 后处理）：scripts.pre/post → 一条 script 操作；preScript/postScript 同理。
写入只写新形态。

## 运行语义（core runner）

- 变量链收敛：runtime > 环境（含 baseUrl 注入）> 模块变量 > 全局变量（project.variables）。
  workspace.variables 层删除；
- 全局参数合并：query/header 追加（接口同名优先，接口侧禁用项视为显式关闭）；cookie 序列化为
  `Cookie: k=v; ...` 头（接口自有 Cookie 头则整头以接口为准）；body 仅当请求体 kind=form 时合并进
  form 表单（接口同名 key 优先）；其他 kind（json/xml/raw/graphql）与 none 不受影响；
- 操作执行：模块前置操作最先（自上而下），随后沿执行路径每层文件夹的前置操作依次执行；
  请求后后置操作自下而上（最深文件夹 → 模块）；用例级前置/后置操作在每用例前后（沿用原脚本时点）；
- 调试（合成单用例集合）：合成容器的操作 = 模块操作 + 沿路径文件夹操作按上述顺序合并；
- 脚本操作经既有 jsScriptEngine 执行，上下文与原脚本一致（pm 变量/断言桥不变）。

## 通道与 store

- 项目级全局设置：`globals:get(projectId)` / `globals:save(projectId, globals)`（variables+参数整体），
  替换原工作区级两频道；memory 同契约；树 DTO 不变（项目变量经此通道水合）；
- 默认分组守卫：session/memory 的 deleteNode("group") 拒绝默认分组；renameNode("group") 拒绝默认分组；
  wsOpen/load 后 ensureDefaultGroup（带标记→就地用；同名→补标记；否则创建+落盘）；
- 环境选中态：debug store 持 `envByProject: Record<projectId, envName|null>`，项目切换时恢复/重置；
  压测面板环境下拉与调试共享同一状态源。

## UI（desktop renderer）

- HomeView：新建分组/项目 → ConfirmDialog 命名（重名错误显示在对话框内，ConfirmDialog 增 error 插槽）；
  分组行内操作：新建项目 / 重命名（默认分组禁用）/ 删除（默认分组禁用；自建分组空才可用，非空提示）；
- EnvPanel：全局变量页签数据源 = project.variables；全局参数页签扩为 query/header/cookie/body 四表；
- SideTree：模块行「管理」→ 容器对话框（变量 / 前置操作 / 后置操作三页签）；文件夹行 →
  （前置操作 / 后置操作两页签）；「新建集合」等文案改「模块」；
- CasePanel：用例前置/后置脚本 → 前置操作/后置操作列表（可增删/排序，第一版仅脚本类型）；
- 接口头右侧增「导入」按钮（打开既有向导）；rail 移除导入（6 项）；测试模块内压测环境选择与调试共享；
- i18n：集合→模块 全量更名（新建集合→新建模块等）。

## 测试

- core：默认分组守卫/补建迁移；操作读取归一与执行顺序（模块/多层文件夹/用例级）；全局参数
  （cookie/body 合并边界）；变量链（workspace 层删除）；旧文件读兼容（scripts→操作）；
- desktop：session 守卫与 ensureDefaultGroup；globals 通道项目隔离；环境记忆（切项目恢复/重置/删除回退）；
  HomeView 对话框与默认分组行内操作；EnvPanel 四类参数；CasePanel 操作列表；rail 6 项；
- 全量四包 + build + 打包冒烟四道底线 + 真机核验（存量目录补默认分组、命名对话框、操作执行、环境记忆）。

## 范围外（延后清单不变）

文件夹变量、场景级压测、多标签编辑、操作类型扩展（延时/数据库）、body 全局参数改变请求形态。
