# apicc M7-B 桌面插件视图与扩展浮现实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** 桌面端「插件」管理视图（已加载插件/版本/贡献分类明细/失败诊断只读展示）+ Reporter/Importer 选择面动态枚举。**两阶段执行**（M5-B/M6-C 先例）：T1 fixture 先行；T2 同步 main 后切真加载器。

**工作目录：** `D:\workspace260609\project-2\apicc-m7-desktop`（worktree，分支 `feature/m7-desktop`）。**基线：desktop 512 全绿（main @ 67074e6）。**

**全局约束：** 品牌中立；中文 conventional commit（`feat(desktop): ...`）；门禁 = desktop typecheck 双跑 + desktop 全量 + core 全量；i18n zh/en 成对；组件零工厂调用；**T1 不依赖 core 加载器**（契约 fixture 自建：PluginLoadEntry 形状 = { kind: "loaded"|"failed", name, version?, contributions?: { protocols/auths/asserts/scripts/reporters/importers 各类计数与名称清单 }, error? }）。

---

### 任务 1：插件视图与选择面动态枚举（fixture 阶段）

- [ ] **步骤 1：失败的测试**
  1. IPC 新增 `plugins:list`（fixture 桩返回混合 loaded/failed 清单）四件套同构。
  2. PluginsView：侧栏新入口 → 只读 a-table（name/version/贡献分类 tag）+ 失败项红标 + 原因列；空清单给「未登记插件」空态与指引文案（指向 docs/plugins.md）。
  3. 扩展浮现：导入向导 importer 清单改走 IPC 动态枚举（fixture：内置 + 插件贡献各一）——改造点与既有硬编码清单对照（报告注明改造落点）。
  4. i18n `plugins.*` zh/en 成对。
- [ ] **步骤 2：实现**——PluginsView.vue、stores/plugins.ts（工厂）、channels/ipc/preload/memory 同步、router/App/侧栏入口接线。
- [ ] **步骤 3：门禁 + Commit** `feat(desktop): 插件管理视图与选择面动态枚举（契约 fixture）`

### 任务 2：内核集成与收口（同步 main 后）

- [ ] **前置**：`git merge main`（M7-A 加载器已合并）。
- [ ] **步骤 1：失败的测试**——`plugins:list` 切真实现：main 进程建 registry 时经 core 加载器装载用户级清单（测试注入 homeDir 夹具：登记本地路径示例插件 + 一个坏插件）→ 摘要返回（loaded/failed 混合）；桌面 registry 的贡献（如插件 reporter）在运行频道可选。
- [ ] **步骤 2：实现**——main/registry 装配接线；桌面加载开关与 CLI `--no-plugins` 对齐口径（报告注明）；打包冒烟。
- [ ] **步骤 3：门禁四件 + Commit** `test(desktop): 插件加载真集成`

---

## 规格覆盖对照

| 规格（m7 spec §2） | 任务 |
|---|---|
| D3 失败隔离诊断可见（桌面面） | 1、2 |
| D5 UI 扩展浮现 MVP | 1、2 |
| D8 桌面加载面 | 2 |

**明确推迟**：插件启用/停用 UI（编辑清单即接口）、自由 UI 注入、热重载（规格 §4）。
