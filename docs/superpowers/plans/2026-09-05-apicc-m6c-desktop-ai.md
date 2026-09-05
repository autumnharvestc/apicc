# apicc M6-C 桌面端 AI 接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** 桌面端 AI 用例生成接入：AI 配置对话框（baseUrl/model 明文 + key safeStorage）、调试视图「AI 建议用例」入口、建议列表预览与勾选采用（经既有保存链路落盘）。**两阶段执行**（M5-B 先例）：T1 fixture 先行（main 基线，不依赖 core ai 模块）；T2 同步 main 后切真 provider。

**工作目录：** `D:\workspace260609\project-2\apicc-m6-desktop`（worktree，分支 `feature/m6-desktop`）。**基线：desktop 469 全绿（main @ b6dac7e）。**

**全局约束：** 品牌中立；中文 conventional commit（`feat(desktop): ...`）；门禁 = desktop typecheck 双跑 + desktop 全量 + core 全量；i18n zh/en 成对零内联中文；组件零工厂调用；渲染层禁 node 内置模块（守卫测试）；key 走 safeStorage（沿用 online token 模式，不可用降级明文 + warn）；**T1 不依赖 core ai 模块**（契约 fixture 自建：`AiSuggestedCase` 形状 = name/scope/parameters/assertions/postScript，id 本地生成）。

---

### 任务 1：AI 配置对话框与建议采用 UI（fixture 阶段）

- [ ] **步骤 1：失败的测试**
  1. 配置对话框：baseUrl/model 输入 + key 密码框；保存 → baseUrl/model 入 localStorage（键 `apicc.ai.config`）、key 入 safeStorage 经 main 进程 IPC（新增 `ai:save-config`/`ai:get-config`——沿用 online tokenStore 模式，key 不回传渲染层明文除非用户点「测试」）；连接测试按钮（fixture 阶段：调 IPC 桩返回成功/失败两态）。
  2. 建议列表：调试视图「AI 建议用例」按钮（fixture 阶段调 IPC 桩返回固定两条建议）→ 建议列表抽屉（只读预览：name/scope/断言数/来源标注「AI 生成」）→ 勾选 → 「采用」并入 editor.api.cases（经既有保存链路）→ 列表清空；不采用可关闭丢弃（零落盘——AI 产出永不静默写入）。
  3. i18n `ai.*` zh/en 成对；守卫测试不破。
- [ ] **步骤 2：实现**——`AiConfigDialog.vue`、`AiSuggestionsDrawer.vue`、stores/ai.ts（工厂）、main/online/tokenStore 邻位的 `main/ai/config.ts`（safeStorage key 存取）、channels/ipc/preload/memory 同步（fixture 桩实现）、App.vue 入口接线。
- [ ] **步骤 3：门禁 + Commit** `feat(desktop): AI 配置与建议采用界面（契约 fixture）`

### 任务 2：内核集成与收口（同步 main 后）

- [ ] **前置**：`git merge main`（M6-A 已合并——core ai 模块/契约就位）。
- [ ] **步骤 1：失败的测试**
  1. fixture 桩切真实现：`ai:suggest` IPC → main 进程以保存的配置构造 provider（core 导出）→ suggestCases → 返回建议；配置缺失 → 可读错误指引打开配置对话框。
  2. 连接测试 → provider 轻量调用（如列出 models 或最小 completions）成功/失败两态。
  3. 采用落盘 → 既有保存链路往返（严格 schema）。
- [ ] **步骤 2：实现**——main/ai/suggest.ts（provider 构造 + 调用 + 深拷贝返回）；ipc/memory 同步；打包冒烟。
- [ ] **步骤 3：门禁四件 + Commit** `test(desktop): AI 建议真调用链路集成`

---

## 规格覆盖对照

| 规格（m6 spec §2） | 任务 |
|---|---|
| D2 密钥边界（桌面 safeStorage） | 1、2 |
| D4 桌面接入（配置/建议/采用） | 1、2 |
| D7 测试纪律（fixture/替身） | 1、2 |

**明确推迟**：流式建议、多轮指令调优、建议 diff 视图、非 OpenAI 兼容 provider。
