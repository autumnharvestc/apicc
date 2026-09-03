# apicc M2-B 工作流设计器 UI 设计规格

- 日期：2026-09-02
- 状态：设计经用户确认（画布选型 Vue Flow、完整闭环范围），待实现
- 范围：M2 第二子项目——工作流设计器 UI（desktop）；依赖 M2-A 引擎（feature/m2 已含）
- 上游：M2-A 规格 §4/§5（数据模型/生命周期）、§7（执行语义）

## 1. 定位与成功标准

把 M2-A 的 headless 工作流能力变成可视闭环：**画布编排 → 保存 → 发布/启用（校验错误可见）→ 画布运行着色**。

**成功标准**：用户不离开桌面端即可创建工作流、拖拽编排三节点条件流、发布并启用、运行后画布按结果着色；删除被引用用例时收到影响提醒。

## 2. 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | 画布库 | **Vue Flow**（`@vue-flow/core`，MIT，React Flow 的 Vue3 官方移植）；自定义节点用 Vue 组件（可内嵌 antd 徽标/图标） |
| D2 | 范围 | 完整闭环：画布编辑 + 生命周期 + 影响提醒 + 运行着色 |
| D3 | 视图入口 | 侧树项目节点下新增「工作流」列表（与环境列表同款交互：新建/删除/重命名）；点击工作流 → 设计器视图（与调试/运行并列的主视图） |
| D4 | 编辑缓冲 | 画布编辑作用于 store 本地缓冲（nodes/edges），显式保存走 `wf:save`；dirty 跟踪与切换丢失语义沿用编辑器先例 |
| D5 | 测试策略 | 数据层纯函数 TDD（Workflow→Vue Flow 节点/边双向转换、状态着色映射）；Vue Flow 组件在 jsdom 下渲染受限——画布组件以挂载冒烟 + 数据层断言为主 |

## 3. IPC 新频道（8 个，channels.ts 单源 + zod 校验 + preload/memory 同步）

| 频道 | 入参 → 出参 | 主进程实现 |
|------|-------------|------------|
| `wf:list` | `{ projectId }` → `Array<{ id, name, status }>` | session 遍历 project.workflows |
| `wf:get` | `{ workflowId }` → 完整 Workflow + 所属 projectId | session.locateWorkflow |
| `wf:create` | `{ projectId, name }` → Workflow（status=draft） | session.createWorkflow（重名拒绝） |
| `wf:delete` | `{ workflowId }` → void | session.deleteWorkflow（引用节点无从谈起，直接删）+ save |
| `wf:save` | `{ workflow }`（WorkflowSchema 全量校验）→ void | session.saveWorkflow（status 保持；编辑 published/enabled 自动回退规则见 §4）+ save |
| `wf:set-status` | `{ workflowId, next }` → `{ workflow, errors, warnings }` | session.setWorkflowStatus：core `transitionWorkflowStatus` + `validateEnablement`（enabled 失败返回 errors 不改状态；其余迁移失败抛错）+ save |
| `wf:impact` | `{ caseId?, apiId? }` → WorkflowImpactEntry[] | core workflowImpact |
| `wf:run` | `{ workflowId, envName? }` → WorkflowRunResult | WorkflowRunner（resolveEnv 未找到抛错；draft 拒绝运行）+ 落盘 `.apicc/runs/workflow-*.json` |

session 新增：`locateWorkflow`、`createWorkflow`、`deleteWorkflow`、`saveWorkflow`（含 D4 回退规则：保存时 status 为 published/enabled 且内容有变 → 回退 draft？**裁定：保存恒保持当前 status 不变，回退仅在显式「编辑草稿」动作时由 UI 询问用户**——M2-B 简化：保存不改 status；「修改已启用工作流」由 UI 在进入编辑时提示）、`setWorkflowStatus`。

## 4. 视图结构与交互

**侧树**：项目节点 children 末尾追加 `workflows` 虚拟分组（TreeNodeDTO 增 `workflows?: Array<{id, name, status}>`，仅 M2-B 消费）；工作流节点点击 → 打开设计器；右键/悬停动作：删除、重命名。

**设计器视图**（三区）：
- 顶栏：工作流名 + 状态 Tag（draft=默认/published=蓝/enabled=绿）+ 保存（dirty 圆点）+ 生命周期按钮组（发布：draft 可用；启用：published 可用，点击后若校验失败弹 errors 列表；解除启用：enabled 可用）+ 运行（enabled 可用；draft 需确认走强制运行）+ 运行环境选择
- 中央画布：Vue Flow；request 节点 = 自定义节点组件（label、接口名/用例名、状态徽标）；noop 节点 = 虚线边框占位样式；missing = 红框（保存后 reload 时由引用存在性检测标注）；边 = 默认贝塞尔，condition 存在时标签显示表达式摘要（截断 24 字符），点击边选中 → 属性面板编辑
- 右侧属性面板（a-tabs：节点/边 上下文切换）：选中节点 → label、接口/用例改绑（a-cascader：集合→接口→用例，数据来自当前项目）、request↔noop 切换；选中边 → condition 多行输入（占位提示 `prev.passed && vars.token !== undefined`）+ 「可用变量」提示块

**运行着色**：`wf:run` 完成后按 nodeResults.nodeId 映射节点 class（passed=绿描边 / failed=红 / skipped=灰 / noop=蓝）+ 右侧结果抽屉（节点列表 + 断言明细，复用响应查看器模式）；warnings 以 a-alert 列表展示。

**影响提醒**：SideTree 删除用例/接口前调 `wf:impact` → 命中时确认弹窗列出「工作流名（状态）— 节点 label」清单并说明「删除后这些节点将标记为缺失（可改绑恢复）」→ 确认后删除。

## 5. 数据流与状态

- `stores/workflowDesign.ts`：`{ workflow, dirty, selectedNodeId, selectedEdgeId, runResult }`；编辑动作只改本地缓冲；`save()` → `wf:save`；`setStatus(next)` → `wf:set-status`（失败把 errors 存入 `validationErrors`）；`run(envName)` → `wf:run`
- 画布↔缓冲的映射为**纯函数**（`wfCanvas.ts`）：`toFlowElements(workflow, nodeStates?) → { nodes, edges }` 与 `applyFlowChange(buffer, change) → buffer`——TDD 主战场
- 装配沿用组合根约定（App 一次创建，props 下发，组件内零工厂调用）

## 6. 错误处理

- 保存校验失败（WorkflowSchema 不合规）→ reportError 通道；启用校验失败 → 属性面板上方 a-alert 列表（errors 阻断、warnings 提示）
- 运行被拒（draft/环境未找到）→ reportError
- 画布空态：无节点时画布中央 EmptyState 提示「从右侧添加节点开始编排」

## 7. 打包与合规

`@vue-flow/core` 及子包为 devDependencies（vite 打包进 dist-renderer，先例同 antd）；MIT 许可（合规约束 ✓，报告附声明）；打包后 `dist:dir + smoke:dir` 必须通过。

## 8. 明确推迟（均有归属）

自动布局（力导/分层排列——M2-B 手动拖放 + position 持久化）；撤销/重做（观察反馈）；工作流级变量与初始化脚本；小地图/快捷键；并行网关节点类型（M2-C 定义并发语义后补）。
