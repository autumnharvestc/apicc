# apicc M7 设计规格：插件生态（外部插件加载、UI 扩展浮现、脚手架与市场索引）

日期：2026-09-06
状态：已批准（用户指示继续；M1 规格路线图 M7 = 插件市场、UI 扩展点、插件开发脚手架）
上游：M1 规格（§5 插件模型：七个扩展点与 PluginDefinition 契约、§5.3 契约测试）、既有 `createPluginRegistry`/`plugin(def)` 注册面

---

## 1. 背景与目标

「一切皆插件」目前只对内置实现成立：七个扩展点与 `PluginDefinition` 契约已在 core 定义并经契约测试，但**没有加载外部插件的机制**。M7 补齐最后一环：

1. **外部插件加载**：用户级清单声明插件（npm 包名或本地路径），CLI 与桌面端启动时加载并注册，失败隔离不阻断。
2. **UI 扩展浮现**：桌面端新增「插件」管理视图（已加载插件与贡献面只读展示）；Reporter/Importer/断言操作符等贡献自动浮现于既有选择面（CLI `--reporters`、桌面导入向导等）。
3. **插件开发脚手架与市场索引**：`apicc create-plugin` 生成可开发的模板包（含契约测试）；命名约定 + 精选索引文档构成去中心化「市场」MVP（中心化市场推迟）。

### 成功标准

插件作者按脚手架建包 → 发 npm（或本地路径）→ 用户在 `~/.apicc/plugins.json` 登记 → CLI 与桌面端启动即加载，其贡献的报告格式/导入器/断言操作符在既有 UI 面自动可选；坏插件不阻断启动且诊断可见。

### 非目标

中心化插件市场服务与在线安装（`npm install` 由用户自行执行——加载器只认已安装的包名或本地路径）；桌面端加载任意 UI 组件（安全/沙箱复杂度，M7+ 评估）；插件间依赖解析；插件热重载。

---

## 2. 关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 清单与信任边界 | **仅用户级** `~/.apicc/plugins.json`（`{"plugins": ["<npm包名或本地绝对/相对路径>", ...]}`）。**不支持工作区级清单**——工作区文件会进 Git，克隆即执行任意代码是供应链陷阱（文档显式注明此信任模型）。本地路径相对清单文件所在目录解析 |
| D2 | 插件形态 | 复用既有 `PluginDefinition { name, version, setup(ctx) }`：加载 = 动态 `import()` 后取包默认导出或 `plugin` 具名导出，经 zod 形状校验（name/version 字符串、setup 函数）→ `registry.plugin(def)` |
| D3 | 失败隔离 | 单插件加载/校验/setup 抛错 → 收集为 LoadProblem（name + 原因）继续加载其余；启动不阻断；CLI `plugins list` 与桌面插件视图展示失败项与原因 |
| D4 | 加载时机 | CLI：`runCli` 入口在命令分发前加载（`--no-plugins` 逃生开关）；桌面：main 进程建 registry 时加载（同样可经用户级清单关闭项）。加载器纯函数化注入 `import` 便于测试 |
| D5 | UI 扩展浮现（MVP 口径） | 既有选择面改为走 registry 动态枚举：CLI `--reporters` 帮助文案、桌面导入向导 importer 清单、断言操作符提示。**不做自由 UI 注入**（沙箱复杂度）；桌面「插件」视图 = 已加载插件（name/version）+ 贡献清单（协议/认证/断言/脚本/报告/导入器分类计数与明细）只读展示 |
| D6 | 脚手架 | `apicc create-plugin <name> [--dir <path>]`：生成目录 = package.json（name 遵循 `apicc-plugin-*` 约定、type module、peerDependencies @apicc/core）、src/index.ts（示例断言操作符 + 报告器 + setup）、vitest 最小契约测试、tsconfig、README——开箱即可 `pnpm build` + `vitest` |
| D7 | 市场索引 MVP | `docs/plugins.md`：命名约定（npm keyword `apicc-plugin`）、精选索引表（首发仅示例脚手架自身）、发布指南（build/publish 步骤 + 契约测试自检要求）。中心化市场推迟 |
| D8 | 桌面加载面 | desktop main 与 CLI 共用 core 的加载器；desktop 无用户交互管理（MVP 只读视图），启用/停用 = 编辑用户级清单 |

---

## 3. 子项目划分（两轨）

### 轨 1 — M7-A 插件加载与脚手架（`packages/core` + `packages/cli`，分支 `feature/m7-plugins`，worktree `apicc-m7-plugins`）

T1 core 加载器（`src/plugins/loader.ts`：清单读取/动态 import/形状校验/失败隔离，注入 import 可测）+ CLI `plugins list`（表格输出含失败项）→ T2 `create-plugin` 脚手架 + `docs/plugins.md` 市场索引与发布指南。基线：core 285 / cli 56。

### 轨 2 — M7-B 桌面插件视图与扩展浮现（`apps/desktop`，分支 `feature/m7-desktop`，worktree `apicc-m7-desktop`）

T1（fixture 先行）：「插件」管理视图（侧栏入口 + 只读清单：插件/版本/贡献分类明细 + 失败项诊断）+ reporter/importer 选择面动态枚举改造（fixture 契约：plugins:list 频道 + 加载摘要 DTO）→ T2（A 合并后同步 main）：切真加载器集成（用户级清单 fixture 经注入）+ 打包冒烟。基线：desktop 512。

### 冲突面分析

轨 1 只动 packages/core+cli；轨 2 只动 apps/desktop。轨 2 T1 以 fixture 契约先行（M5-B/M6-C 两阶段先例），T2 同步 main 后真集成。

---

## 4. 明确推迟

中心化市场服务与在线安装、工作区级插件清单（供应链边界，D1）、自由 UI 组件注入、插件热重载、插件间依赖、签名/校验和机制。

---

## 5. 验收

1. 两轨各自 TDD 闭环 + 终审 + 门禁绿。
2. 合并后 main：六面全绿 + CI 七 job 绿。
3. 演示路径：脚手架生成示例插件 → 本地路径登记 → `apicc plugins list` 显示已加载与贡献 → `apicc run --reporters <插件格式>` 用插件报告器出报告；桌面插件视图显示同一插件；坏插件（语法错误包）登记后启动不阻断且诊断可见。
