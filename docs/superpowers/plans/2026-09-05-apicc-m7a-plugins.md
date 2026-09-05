# apicc M7-A 插件加载与脚手架实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** 外部插件加载器（用户级清单 → 动态 import → 形状校验 → 失败隔离注册）+ `apicc plugins list` + `apicc create-plugin` 脚手架 + `docs/plugins.md` 市场索引。

**工作目录：** `D:\workspace260609\project-2\apicc-m7-plugins`（worktree，分支 `feature/m7-plugins`）。**基线：core 285 / cli 56 全绿（main @ 67074e6）。**

**全局约束：** 品牌中立；中文 conventional commit；门禁 = core 全量 + cli 全量 + typecheck；测试零真实网络（本地路径/本地包夹具）；**安全边界：仅用户级清单、路径相对清单文件解析、加载失败隔离**；契约以 M7 规格 `docs/superpowers/specs/2026-09-05-apicc-m7-plugin-ecosystem-design.md`（D1–D4/D6/D7）为唯一事实。

---

## 文件结构

```
packages/core/src/plugins/loader.ts      ← 新：清单读取/动态 import/形状校验/失败隔离（import 可注入）
packages/core/src/plugins/types.ts       ← 新：PluginManifest、PluginLoadEntry（已加载/失败/贡献摘要）
packages/core/src/index.ts               ← 导出核对
packages/core/tests/plugins/loader.test.ts
packages/cli/src/plugins-cmd.ts 或并入 main.ts ← plugins list / create-plugin 命令
packages/cli/tests/plugins-cmd.test.ts
packages/cli/tests/fixtures/sample-plugin/  ← 本地插件包夹具（index.js + package.json）
docs/plugins.md                          ← 市场索引与发布指南（任务 2）
```

---

### 任务 1：加载器 + plugins list

- [ ] **步骤 1：失败的测试**
  1. 清单读取：`~/.apicc/plugins.json` 不存在 → 空清单零加载（不报错）；非法 JSON → 单条 LoadProblem；`plugins` 非数组 → LoadProblem。
  2. 加载：本地路径插件（测试夹具包：ESM `export const plugin = {name, version, setup}`）→ 加载成功、setup 收到 registry、贡献面注册生效（setup 内 registerAssert 后 registry.listAsserts 含之）；包只导出 default → 同样识别；两者都无/形状不符（缺 name/version/setup）→ LoadProblem 带原因；import 抛错（语法错误的包）→ LoadProblem 隔离，后续插件继续加载。
  3. 路径解析：相对路径相对清单文件所在目录；npm 包名（非 ./ 开头）按裸导入解析。
  4. 注入：loader 接受 `{ homeDir, importFn }` 注入（测试免真写 HOME）。
- [ ] **步骤 2：实现**——`loadUserPlugins(registry, {homeDir?, importFn?}) → { loaded: PluginLoadEntry[], problems: LoadProblem[] }`；CLI `runCli` 入口接线（`--no-plugins` 逃生开关，deps 可注入关闭供既有测试零扰动——**注意：默认开启后既有 56 测试若因空清单路径受扰须排查而非改断言**）；`plugins list` 命令输出已加载（name/version/贡献计数）与失败（原因）。
- [ ] **步骤 3：全量回归 + Commit** `feat(core): 外部插件加载器——用户级清单/失败隔离` + `feat(cli): plugins list 命令与启动接线`

### 任务 2：create-plugin 脚手架 + 市场索引文档

- [ ] **步骤 1：失败的测试**
  1. `apicc create-plugin apicc-plugin-demo --dir <tmp>`：生成目录结构（package.json name 正确且 keyword 含 `apicc-plugin`、src/index.ts 示例含 registerAssert+registerReporter、test 文件、tsconfig、README）；生成物内示例插件的构建产物可直接被加载器加载（端到端：生成 → 按其 README 构建或直接以源码路径登记 → plugins list 显示已加载——实现者按模板形态选端到端口径并报告注明）。
  2. 重名目录已存在 → 可读拒绝；name 非 `apicc-plugin-` 前缀 → 警告不阻断（约定非强制）。
- [ ] **步骤 2：实现**——`create-plugin` 命令（模板内联字符串，报告注明模板维护取舍）；`docs/plugins.md`（D7：命名约定 keyword `apicc-plugin`/精选索引表首发仅示例/发布指南 build→test→publish/信任模型与 D1 边界说明）。
- [ ] **步骤 3：全量回归 + Commit** `feat(cli): create-plugin 脚手架` + `docs: 插件市场索引与发布指南`

---

## 规格覆盖对照

| 规格（m7 spec §2） | 任务 |
|---|---|
| D1 清单与信任边界 | 1 |
| D2 插件形态（复用 PluginDefinition） | 1 |
| D3 失败隔离 | 1 |
| D4 加载时机/逃生开关 | 1 |
| D6 脚手架 | 2 |
| D7 市场索引 MVP | 2 |

**明确推迟**：中心化市场、工作区级清单、自由 UI 注入、热重载、插件依赖、签名机制（规格 §4）。
