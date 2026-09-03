# apicc M2-A 工作流引擎设计规格

- 日期：2026-09-02
- 状态：设计经控制者按用户既有授权裁定（用户离线，决策清单见 §2，可否决）
- 范围：M2 第一子项目——工作流引擎（headless：core + CLI）；设计器 UI 属 M2-B
- 上游：`docs/superpowers/specs/2026-09-01-apicc-m1-local-core-design.md`（§11 路线图）、`local/原始需求.md`（工作流细节）

## 1. 背景与定位

工作流是 apicc 的核心差异点（原始需求中细节最丰富的部分）：把多个接口用例按 DAG 编排成端到端场景（如「登录 → 下单 → 查询 → 校验」），支持条件流转与多入多出。M2-A 交付 headless 引擎（数据模型、生命周期、校验、执行器、CLI），M2-B 在其上建设计器 UI。

**M2 成功标准（M2-A 部分）**：用户在 YAML 中手写一个三节点条件工作流，`apicc run-workflow` 按条件流转执行，产出兼容现有 Reporter 的报告；删除被引用用例后工作流进入「引用缺失」可诊断状态而非静默破坏。

## 2. 已确认决策（控制者按授权裁定，用户可否决）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 执行模型 | **图遍历 + 条件边**：节点 = 接口用例（或空过占位），边携带条件表达式，运行时逐边求值决定流转；支持多入多出、条件流转、空过节点——原始需求「多入多出、条件流转」的直接实现 |
| D2 | 条件表达式 | **JavaScript 表达式**，复用既有 `ScriptEngine` 沙箱（与脚本语言一等公民决策一致）；求值上下文注入上游结果与变量；异常/超时按 false 处理并告警 |
| D3 | 生命周期 | 草稿（draft）→ 已发布（published）→ 已启用（enabled）三态；编辑 published 自动回退 draft；编辑 enabled 需先解除启用；启用前强制校验（§5） |
| D4 | 引用缺失处理 | 删除被工作流引用的用例/接口 → 节点保留并标记 `missing`（执行时跳过并告警，启用校验失败），不做静默剔除；用户可改绑或删节点——比「二选一」更可诊断，且保留原始需求要求的占位/置灰语义 |
| D5 | M2 顺序 | A 工作流引擎 → B 设计器 UI → C 压测 → D 分布式与 CI |
| D6 | 压测/分布式 | 本规格不涉及；执行器接口预留并发与外部触发扩展点（不实现） |

## 3. 范围

### 3.1 包含

| 模块 | 需求 |
|------|------|
| 工作流文件 | `projects/<项目>/workflows/<工作流名>/workflow.yaml`（Git 友好文本，§6 布局新增顶层目录）；ULID 稳定标识与既有约定一致 |
| 数据模型 | `Workflow { id, name, status, nodes[], edges[] }`；`WorkflowNode { id, kind: request\|noop, apiId?, caseId?, label? }`；`WorkflowEdge { id, from, to, condition? }`（condition 缺省恒真） |
| 校验器 | DAG 无环；边端点存在；启用校验（§5）；孤立节点警告；引用缺失检测 |
| 生命周期 | `setWorkflowStatus(id, status)`：draft→published→enabled 单向推进，published/enabled 编辑自动回退（§5）；启用校验失败拒绝启用并列出全部原因 |
| 影响分析 | `workflowImpact(caseId/apiId)`：列出引用节点与所在工作流及状态（供 CLI 与 M2-B UI 消费） |
| 执行器 | `WorkflowRunner`：从入度 0 节点开始拓扑遍历；noop 直接通过；request 节点复用 core Runner 语义（前置/后置脚本、断言、变量、环境）；条件边求值决定下游；不满足条件或上游被跳过的节点记 skipped；节点间共享运行时变量 |
| 运行结果 | `WorkflowRunResult { workflowId, status, nodeResults[], total/passed/failed/skipped, startedAt, finishedAt }`；提供到 `RunResult` 的适配（复用 Reporter 插件渲染） |
| CLI | `apicc run-workflow <工作流相对路径> --env <名称> [--reporters html,junit] [--force-draft]`；结果落盘 `.apicc/runs/` |
| 存储接线 | fileStorage 增 workflows 读写；孤儿清理覆盖 workflows 目录；session 增工作区加载后的工作流索引 |

### 3.2 不包含（后续子项目）

设计器 UI 与画布（M2-B）；节点 position 坐标（数据模型预留可选字段）；压测并发与采样（M2-C）；master/worker 与远程触发（M2-D）；定时调度；并行网关（D1 模型下多出边天然并发语义留 M2-C 定义——M2-A 多出边按声明顺序串行求值）。

## 4. 数据模型与文件结构

```
projects/<项目>/workflows/下单流程/
└── workflow.yaml
```

```yaml
id: 01Jxxxxxxxxxxxxxxxxxxx
name: 下单流程
status: draft
nodes:
  - id: n1
    kind: request
    apiId: 01Jaaa...
    caseId: 01Jbbb...
    label: 登录
  - id: n2
    kind: request
    apiId: 01Jccc...
    caseId: 01Jddd...
    label: 下单
  - id: n3
    kind: noop            # 空过占位节点（如：退款用例未设计好）
    label: 退款（占位）
edges:
  - id: e1
    from: n1
    to: n2
    condition: "prev.passed && vars.orderId !== undefined"   # 缺省恒真
  - id: e2
    from: n2
    to: n3
```

规则：
- **稳定标识**：节点/边均带 ULID；节点经 `apiId+caseId` 引用域对象（不内联请求定义）——用例内容变化自然生效，与「定义驱动」一致
- **起始节点**：入度 0 的节点；多个起始节点按声明顺序依次执行（各自独立遍历）
- **条件求值上下文**（只读）：`prev.passed`（直前上游用例结果）、`prev.outcome`（上游 CaseOutcome 只读快照：status/assertions/error）、`vars`（运行时变量读取）、`env`（环境变量读取）；求值结果须可转布尔（truthy）
- **noop 节点**：直接标记通过（skippedOf=noop 语义单列），不执行请求；满足启用校验
- **missing 引用**：节点引用的 apiId/caseId 在工作区中不存在 → 执行时跳过并告警，启用校验失败
- **校验**：zod strict schema（与 §6 既有纪律一致）

## 5. 生命周期与校验

状态机：`draft → published → enabled`（单向推进；任何编辑作用于 published/enabled 时：published 自动回 draft，enabled 拒绝编辑并提示先解除启用——解除启用回到 published）。

启用校验（全部通过才允许 enabled）：
1. DAG 无环、边端点存在
2. 每个 request 节点的 apiId/caseId 存在于工作区（运行时环境适配由变量表达，启用时不校验环境适用性）
3. 无 missing 引用
4. 至少一个起始节点可达全部非孤立节点（孤立节点允许存在但产生警告）

## 6. 执行语义（WorkflowRunner）

```
输入：workflow（enabled；draft 需 --force-draft）、项目、环境（resolveEnv 语义，未找到显式报错）
1. 校验启用前提（缺失即抛，--force-draft 跳过生命周期但跳过校验不跳过结构校验）
2. 从入度 0 节点队列开始；维护节点状态集合 { pending, running, passed, failed, skipped, noop }
3. 取节点：
   - noop → noop
   - missing → skipped（告警）
   - request → 复用 CollectionRunner 单用例路径（合成单用例集合，与调试/集合运行同语义）
4. 节点完成后遍历出边（按声明顺序）：求值 condition（注入该节点上游上下文）；真 → 下游节点入度减一，归零且未被跳过阻断则入队；假 → 该边标记 skipped，下游入度不减
5. 上游全部出边为 skipped/false 的下游节点 → skipped（级联）
6. 全部队列空 → 汇总 WorkflowRunResult
```

- **变量**：节点间共享运行时变量（复用 Runner 的 persisted 机制——登录态提取的 token 对后续节点可见）
- **fail-fast**：默认 false（节点失败继续走条件流转——失败本身就是条件输入）；可配置 true
- **数据驱动**：M2-A 节点绑定单用例；用例自带 dataDriver 时沿用其逐行展开（每行独立经过条件流转）

## 7. 错误处理

- **环**：校验器在保存/启用时拒绝；执行前再防御性检测（抛「检测到环: a → b → a」）
- **条件求值异常/超时**：该边按 false 处理 + 告警（进入 WorkflowRunResult.warnings）
- **用例执行异常**：与集合运行同语义（outcome.error，不中断图）
- **并发写**：进程内写队列（既有 fileStorage 语义）
- **CLI 退出码**：failed > 0 → 1；skipped-only → 0

## 8. 测试策略

- 校验器单测：环/端点/missing/孤立/生命周期非法迁移
- 遍历单测：多起始、条件分支走/跳、级联 skipped、noop、变量跨节点传递
- 条件求值单测：上下文注入、异常按 false、truthy 转换
- 影响分析单测：case/api 引用反查
- 端到端：临时工作区三节点条件工作流经 CLI 运行（本地 http 服务），报告落盘
- 覆盖率门槛：新增模块 ≥ 85%（延续 core 基线纪律）

## 9. 技术栈

无新运行时依赖（zod/yaml/ulid 既有）；条件求值复用 js-script-engine 沙箱（表达式 = 无语句脚本）。

## 10. 明确推迟的决策（均有归属）

- 条件表达式 UI 编辑器与画布（M2-B）；节点 position（数据模型预留 `position?: { x: number; y: number }` 可选字段）
- 并发执行语义与采样指标（M2-C）；master/worker 协议（M2-D）
- 工作流级变量/初始化脚本（观察 M2-B 使用反馈后再定）
