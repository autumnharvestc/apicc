# apicc M2-B 收口包（UI）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐 M2-B 遗留的侧树工作流入口（持续导航 + 重命名）、workflows 孤儿清理，并落地 vue-tsc 评估——用户可直接在侧树发现/打开/重命名/删除工作流。

**架构：** tree DTO 的 project 节点增 `workflows` 摘要（main/tree.ts + memory 同构）；SideTree 渲染工作流节点（点击打开设计器、hover 动作重命名/删除）；session 增 `renameWorkflow`（name 改字段 + save，孤儿目录由既有 cleanupOrphanDirs 补 workflows 层）；vue-tsc 以 report-only 引入评估，可控则修复并接入门禁。

**技术栈：** 既有栈 + `vue-tsc`（devDep，评估用）。

**工作目录：** `D:\workspace260609\project-2\apicc-m2-ui`（worktree，分支 feature/m2-ui）。**基线：core 172 / cli 10 / desktop 229 全绿。**

**全局约束：** 品牌中立；中文 conventional commit；显式路径 git add；门禁 = desktop typecheck（双 tsconfig）+ desktop 全量 + core 全量；组件内零工厂调用；data-testid 契约保留。

---

## 文件结构

```
apps/desktop/src/
  shared/channels.ts        ← 增 wf:rename
  shared/types.ts           ← ApiccApi 增 wfRename；TreeNodeDTO 增 workflows 摘要（shared/tree-dto.ts）
  main/tree.ts              ← project 节点映射 workflows 摘要
  main/session.ts           ← renameWorkflow + cleanupOrphanDirs 补 workflows 层
  main/ipc.ts、preload/preload.ts、renderer/src/api/memory.ts ← 同步
  renderer/src/components/SideTree.vue ← 工作流节点渲染（点击打开/重命名/删除）
  renderer/src/App.vue      ← 工作流节点点击 → 装配设计器
tests: session.test.ts / ipc.test.ts / components.test.ts 追加；新建 rename 覆盖
```

---

### 任务 1：侧树工作流入口（DTO 扩展 + 重命名 + 孤儿清理）

**文件：** `shared/tree-dto.ts`（TreeNodeDTO project 节点增 `workflows?: Array<{ id; name; status }>`）、`main/tree.ts`、`main/session.ts`（renameWorkflow + cleanup 补层）、`shared/channels.ts`（WfRename: "wf:rename"）、`shared/types.ts`（wfRename）、`main/ipc.ts`、`preload`、`memory.ts`、`SideTree.vue`、`App.vue`；测试三处追加。

- [ ] **步骤 1：编写失败的测试**

session.test.ts 追加：

```ts
it("renameWorkflow 改名后旧目录清理、新目录可读", async () => {
  // 建 g/p/workflow("旧名") → save（断言旧目录存在）→ renameWorkflow → save
  // 重开断言 workflows[0].name === "新名" 且 join(root,...,"workflows","旧名") 不存在
});
it("cleanupOrphanDirs 清理已删除工作流的残留目录", async () => {
  // save 含 wf → 内存 deleteWorkflow（或手工 splice）→ save → 旧目录不存在
});
```

ipc.test.ts 追加：`wf:rename` 链路（改名 → wf:list 反映 + 落盘读回）。SideTree 组件测试追加：工作流节点渲染（status Tag）、点击 emit open、重命名对话框链路。

- [ ] **步骤 2：运行验证失败 → 实现**

要点：
- `renameWorkflow(workflowId, name)`：定位 → `wf.name = name` → save；cleanupOrphanDirs 的 workflows 层补齐（对位 collections 既有模式：先写新、后删旧，已由 save+cleanup 顺序保证）
- TreeNodeDTO project 节点：`workflows: p.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status }))`
- SideTree：project 的 children 尾部追加 workflow 节点（label=name + 状态色点，`data-testid="tree-workflow"`）；点击 emit `select("workflow", id)`（App 据此 `design.load(id)` 打开设计器）；动作钮：重命名（`api.wfRename`）/ 删除（`api.wfDelete` + 确认）
- App.vue：`onSelect` 处理 `kind === "workflow"` → `design.load(id)` + 视图切到工作流
- i18n：`tree.workflows`（工作流/Workflows）等键两语言同构

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 侧树工作流入口——DTO 扩展、重命名与孤儿清理"
```

---

### 任务 2：vue-tsc 评估与引入

**文件：** `apps/desktop/package.json`（devDep vue-tsc + `typecheck:vue` 脚本）；可能的多处类型修复

- [ ] **步骤 1：引入并运行（评估）**

```bash
pnpm -C apps/desktop add -D vue-tsc
# package.json scripts 增： "typecheck:vue": "vue-tsc --noEmit -p tsconfig.json"
pnpm -C apps/desktop run typecheck:vue
```

- [ ] **步骤 2：归类裁定（控制者已授权执行者按此办理）**

- 错误总数 ≤ 20 且均可机械修复（类型标注/导入后缀/prop 类型）→ 修复并把 `typecheck:vue` 串联进 `build` 链（typecheck 之后）
- 错误泛滥（>20 或涉及大范围重构）→ 保持 report-only 脚本不入门禁，错误清单全文写入报告，标注 M2-C 待办

- [ ] **步骤 3：运行验证 + Commit**

```bash
git add apps/desktop
git commit -m "chore(desktop): 引入 vue-tsc 评估与类型修复（report-only 或门禁，按裁定）"
```

---

### 任务 3：顺带清理（2B 账本低成本项）

**文件：** `ResponseViewer.vue`（断言表 row-key、错误列溢出处理）等

- [ ] **步骤 1：修复账本低成本项**

- ResponseViewer 断言 a-table 补 `:row-key`（2B T2①）
- 抽屉/表格错误列 `word-break: break-all`（2B T7③）
- WfDesigner auto-pan-on-connect 按任务 7 疑虑裁定处理（关闭或保留，报告注明）

- [ ] **步骤 2：全量门禁 + Commit**

```bash
git add apps/desktop
git commit -m "chore(desktop): 2B 账本低成本清理（row-key/溢出/auto-pan）"
```

---

## 自检结果

1. 覆盖度：M2-B 延后项（侧树入口/重命名/清理/vue-tsc）全覆盖；用户诉求「工作流从 UI 可发现可管理」达成。
2. 占位符扫描：无 TODO；vue-tsc 分支裁定显式。
3. 类型一致性：TreeNodeDTO 扩展三处同构（tree-dto/tree.ts/memory）；wfRename 五层同步。
