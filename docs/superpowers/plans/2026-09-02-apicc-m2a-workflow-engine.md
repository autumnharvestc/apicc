# apicc M2-A 工作流引擎 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 core 实现 DAG 工作流引擎（数据模型、结构/启用校验、生命周期、影响分析、图遍历执行器、条件边求值、RunResult 适配）并暴露 `apicc run-workflow` CLI——headless 可测，设计器 UI 属 M2-B。

**架构：** 工作流文件为 `projects/<项目>/workflows/<名>/workflow.yaml`（Project 域模型增 `workflows` 数组，zod strict）；执行 = 从入度 0 节点拓扑遍历，request 节点复用 `CollectionRunner` 单用例路径（与调试/集合运行同语义），条件边经 JS 沙箱求值（`pm.__value = Boolean((expr))`，上下文 `prev`/`vars`）；节点间变量经 `CollectionRunner` 新增的**运行时桥**（加法式可选项）跨节点携带；结构/启用校验与影响分析为纯函数。

**技术栈：** 既有栈，无新运行时依赖（zod/yaml/ulid/ScriptEngine 复用）。

**工作目录：** `D:\workspace260609\project-2\apicc-m2`（worktree，分支 feature/m2）。**基线：core 123 / cli 8 测试全绿。**

**全局约束：** 入库文件不得出现竞品品牌名；中文 conventional commit；显式路径 git add（禁止 `git add -A`）；不推送远端；每任务提交前三绿（`pnpm typecheck`（core+cli 各自）+ `cd packages/core && pnpm vitest run` + `cd packages/cli && pnpm vitest run`）；desktop（apps/）不在本计划范围，若被迫触及即 BLOCKED 上报。

---

## 文件结构

```
packages/core/src/
  workflow/model.ts          WorkflowSchema/WorkflowNodeSchema/WorkflowEdgeSchema（strict）+ 类型
  workflow/validate.ts       validateWorkflowStructure（环/端点/孤立）+ validateEnablement（启用校验）+ transitionWorkflowStatus（生命周期迁移守卫）
  workflow/impact.ts         workflowImpact（caseId/apiId 反查引用节点）
  workflow/runner.ts         WorkflowRunner（拓扑遍历/条件求值/级联跳过/noop/missing）+ workflowToRunResult 适配
  domain/model.ts            ProjectSchema 增 workflows: z.array(WorkflowSchema).default([])
  runner/runner.ts           CollectionRunner opts 增 runtimeBridge?: { get(); set(vars) }（加法式：跨节点变量桥）
  storage/fileStorage.ts     workflows 目录读写（save/load roundtrip）
  index.ts                   导出 workflow 公共 API
  cli (packages/cli/src/main.ts)  run-workflow 命令
tests:
  packages/core/tests/workflow/{model,validate,impact,runner}.test.ts
  packages/core/tests/storage/fileStorage.test.ts（追加 workflows roundtrip）
  packages/core/tests/runner/runner.test.ts（追加 runtimeBridge 用例）
  packages/cli/tests/e2e.test.ts（追加 run-workflow 端到端）
```

---

### 任务 1：工作流数据模型

**文件：**
- 创建：`packages/core/src/workflow/model.ts`
- 修改：`packages/core/src/domain/model.ts`（ProjectSchema 增 workflows 字段）
- 测试：`packages/core/tests/workflow/model.test.ts`、`packages/core/tests/domain/model.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

`packages/core/tests/workflow/model.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { WorkflowSchema, WorkflowStatusSchema } from "../../src/workflow/model.js";

describe("工作流 schema", () => {
  it("接受合法工作流并填充默认值", () => {
    const wf = WorkflowSchema.parse({
      id: "w1", name: "下单流程",
      nodes: [
        { id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录" },
        { id: "n3", kind: "noop", label: "退款占位" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n3" }],
    });
    expect(wf.status).toBe("draft");
    expect(wf.nodes[1]!.kind).toBe("noop");
    expect(wf.edges[0]!.condition).toBeUndefined();
  });

  it("拒绝未知字段与非法状态/节点类型", () => {
    expect(() => WorkflowSchema.parse({ id: "w", name: "x", nonsense: 1 })).toThrow();
    expect(() => WorkflowStatusSchema.parse("archived")).toThrow();
    expect(() => WorkflowSchema.parse({ id: "w", name: "x", nodes: [{ id: "n", kind: "timer" }], edges: [] })).toThrow();
  });

  it("position 字段（M2-B 预留）合法且可选", () => {
    const wf = WorkflowSchema.parse({
      id: "w", name: "x",
      nodes: [{ id: "n", kind: "request", apiId: "a", caseId: "c", position: { x: 10, y: -20 } }],
      edges: [],
    });
    expect(wf.nodes[0]!.position).toEqual({ x: 10, y: -20 });
  });
});
```

`packages/core/tests/domain/model.test.ts` 追加：

```ts
import { ProjectSchema } from "../../src/domain/model.js";

describe("Project.workflows 字段（M2-A）", () => {
  it("缺省为空数组；接受工作流对象", () => {
    const p = ProjectSchema.parse({ id: "p", name: "x", variables: {} });
    expect(p.workflows).toEqual([]);
    const p2 = ProjectSchema.parse({
      id: "p", name: "x", variables: {}, environments: [], collections: [],
      workflows: [{ id: "w", name: "wf", status: "draft", nodes: [], edges: [] }],
    });
    expect(p2.workflows).toHaveLength(1);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd packages/core && pnpm vitest run tests/workflow/model.test.ts tests/domain/model.test.ts`
预期：FAIL，模块不存在 / workflows 字段不存在

- [ ] **步骤 3：实现**

`packages/core/src/workflow/model.ts`：

```ts
import { z } from "zod";

export const WorkflowStatusSchema = z.enum(["draft", "published", "enabled"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WorkflowNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["request", "noop"]),
    apiId: z.string().optional(),
    caseId: z.string().optional(),
    label: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  })
  .strict();
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    condition: z.string().optional(),
  })
  .strict();
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: WorkflowStatusSchema.default("draft"),
    nodes: z.array(WorkflowNodeSchema).default([]),
    edges: z.array(WorkflowEdgeSchema).default([]),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;
```

`packages/core/src/domain/model.ts`：ProjectSchema 增一行（import 从 `../workflow/model.js`）：

```ts
import { WorkflowSchema } from "../workflow/model.js";
// ProjectSchema 内：
workflows: z.array(WorkflowSchema).default([]),
```

注意：`@apicc/core` 的 exports 消费方（apps/desktop 经 dist）不受影响——desktop 包不在本计划范围，不重建不验证。

- [ ] **步骤 4：运行验证通过 + 全量回归**

运行：`cd packages/core && pnpm vitest run`
预期：全部 PASS（含既有 123 例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/workflow/model.ts packages/core/src/domain/model.ts packages/core/tests/workflow packages/core/tests/domain/model.test.ts
git commit -m "feat(core): 工作流数据模型与 Project.workflows 接线"
```

---

### 任务 2：fileStorage 工作流读写

**文件：**
- 修改：`packages/core/src/storage/fileStorage.ts`
- 测试：`packages/core/tests/storage/fileStorage.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

`packages/core/tests/storage/fileStorage.test.ts` 追加：

```ts
import type { Workflow } from "../../src/workflow/model.js";

describe("fileStorage workflows 读写（M2-A）", () => {
  const workflow: Workflow = {
    id: "wf1", name: "下单流程", status: "draft",
    nodes: [{ id: "n1", kind: "request", apiId: "a1", caseId: "c1" }],
    edges: [],
  };

  it("save 落盘 projects/<p>/workflows/<名>/workflow.yaml 并读回", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-wfio-"));
    const ws: Workspace = {
      id: "w", name: "demo", variables: {},
      groups: [{
        id: "g", name: "g", projects: [{
          id: "p", name: "p", variables: {}, environments: [], collections: [],
          workflows: [workflow],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    expect(loaded.groups[0]!.projects[0]!.workflows[0]!.name).toBe("下单流程");
    expect(loaded.groups[0]!.projects[0]!.workflows[0]!.edges).toEqual([]);
  });

  it("坏 workflow.yaml 隔离为 problem", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-wfio2-"));
    await fileStorage.save(root, { ...基线工作区, groups: [{ id: "g", name: "g", projects: [{ id: "p", name: "p", variables: {}, environments: [], collections: [], workflows: [workflow] }] }] });
    writeFileSync(join(root, "groups", "g", "projects", "p", "workflows", "下单流程", "workflow.yaml"), "id: [broken");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.workflows).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toContain("workflow.yaml");
  });
});
```

（`基线工作区` 处用本文件既有测试的 workspace 夹具构造方式直写，禁止引用未定义符号。）

- [ ] **步骤 2：运行验证失败**

运行：`cd packages/core && pnpm vitest run tests/storage/fileStorage.test.ts`
预期：新用例 FAIL（workflows 不落盘）

- [ ] **步骤 3：实现 fileStorage 接线**

save：project 层写入（在 environments 写入之后）：

```ts
for (const wf of p.workflows) {
  writeYaml(join(pDir, "workflows", wf.name, "workflow.yaml"), {
    id: wf.id, name: wf.name, status: wf.status, nodes: wf.nodes, edges: wf.edges,
  });
}
```

（`pDir` 为该 project 实际写盘目录变量，按现有 save 结构对位。）

load：project 读取段（environments 之后）：

```ts
const workflowsDir = join(pDir, "workflows");
if (existsSync(workflowsDir)) {
  const { WorkflowSchema } = await import("../workflow/model.js"); // 顶部静态导入，勿动态
  for (const wfName of sortedNames(workflowsDir)) {
    const res = readYaml(join(workflowsDir, wfName, "workflow.yaml"));
    if (!res.ok) {
      problems.push({ file: join("workflows", wfName, "workflow.yaml"), message: res.error });
      continue;
    }
    const parsed = WorkflowSchema.safeParse(res.data);
    if (!parsed.success) {
      problems.push({ file: join("workflows", wfName, "workflow.yaml"), message: `schema 校验失败: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
      continue;
    }
    project.workflows.push(parsed.data);
  }
}
```

实现更正指令（照做）：① 顶部静态 `import { WorkflowSchema } from "../workflow/model.js";`，禁用上面的动态 import 示例；② project.workflows 在解析前初始化为 `[]`（与 environments/collections 同款）；③ problem.file 沿用工作区相对完整路径口径（join(pRel, "workflows", wfName, "workflow.yaml")）。

- [ ] **步骤 4：运行验证通过 + 全量回归**

运行：`cd packages/core && pnpm vitest run`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/storage/fileStorage.ts packages/core/tests/storage/fileStorage.test.ts
git commit -m "feat(core): fileStorage 工作流读写与坏文件隔离"
```

---

### 任务 3：结构校验器（环 / 端点 / 孤立）

**文件：**
- 创建：`packages/core/src/workflow/validate.ts`
- 测试：`packages/core/tests/workflow/validate.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { validateWorkflowStructure } from "../../src/workflow/validate.js";
import type { Workflow } from "../../src/workflow/model.js";

function wf(nodes: Workflow["nodes"], edges: Workflow["edges"]): Workflow {
  return { id: "w", name: "wf", status: "draft", nodes, edges };
}
const req = (id: string) => ({ id, kind: "request" as const, apiId: `a-${id}`, caseId: `c-${id}` });

describe("validateWorkflowStructure", () => {
  it("合法链式图零 error 零 warning", () => {
    const issues = validateWorkflowStructure(wf([req("n1"), req("n2")], [{ id: "e", from: "n1", to: "n2" }]));
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.filter((i) => i.level === "warning")).toEqual([]);
  });

  it("环报 error（含路径）", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("b")], [
      { id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "a" },
    ]));
    expect(issues.some((i) => i.level === "error" && i.code === "cycle" && /a/.test(i.message))).toBe(true);
  });

  it("边端点不存在报 error", () => {
    const issues = validateWorkflowStructure(wf([req("a")], [{ id: "e", from: "a", to: "ghost" }]));
    expect(issues.some((i) => i.level === "error" && i.code === "edge-endpoint")).toBe(true);
  });

  it("孤立节点报 warning", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("lonely")], []));
    expect(issues.some((i) => i.level === "warning" && i.code === "isolated-node")).toBe(true);
  });

  it("重复边报 warning（同 from-to 多条合法用于多条件，完全同向同条件才告警）", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("b")], [
      { id: "e1", from: "a", to: "b", condition: "prev.passed" },
      { id: "e2", from: "a", to: "b", condition: "prev.passed" },
    ]));
    expect(issues.some((i) => i.level === "warning" && i.code === "duplicate-edge")).toBe(true);
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现**

`packages/core/src/workflow/validate.ts`：

```ts
import type { Workflow, WorkflowNode, WorkflowEdge } from "./model.js";

export interface ValidationIssue { level: "error" | "warning"; code: string; message: string }

/** 结构校验：环（error）/ 边端点（error）/ 孤立节点与完全重复边（warning）。 */
export function validateWorkflowStructure(wf: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(wf.nodes.map((n) => n.id));

  for (const e of wf.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({ level: "error", code: "edge-endpoint", message: `边 ${e.id} 端点不存在: ${e.from} → ${e.to}` });
    }
  }

  // 环检测：仅对端点完整的边做 DFS
  const adj = new Map<string, string[]>();
  for (const e of wf.edges) {
    if (ids.has(e.from) && ids.has(e.to)) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const dfs = (node: string) => {
    state.set(node, "visiting");
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        const start = path.indexOf(next);
        issues.push({ level: "error", code: "cycle", message: `检测到环: ${[...path.slice(start), next].join(" → ")}` });
      } else if (!state.has(next)) {
        dfs(next);
      }
    }
    path.pop();
    state.set(node, "done");
  };
  for (const n of wf.nodes) if (!state.has(n.id)) dfs(n.id);

  // 孤立节点：无入边且无出边
  const hasInOut = new Set(wf.edges.flatMap((e) => [e.from, e.to]));
  for (const n of wf.nodes) {
    if (!hasInOut.has(n.id) && wf.nodes.length > 1) {
      issues.push({ level: "warning", code: "isolated-node", message: `节点「${n.label ?? n.id}」没有任何连线（孤立节点）` });
    }
  }

  // 完全重复边（同 from/to/condition）
  const seen = new Map<string, number>();
  for (const e of wf.edges) {
    const key = `${e.from}\u0000${e.to}\u0000${e.condition ?? ""}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) {
      issues.push({ level: "warning", code: "duplicate-edge", message: `存在完全重复的边: ${e.from} → ${e.to}` });
    }
  }
  return issues;
}

export type { WorkflowNode, WorkflowEdge };
```

- [ ] **步骤 3：运行验证通过 + Commit**

运行：`cd packages/core && pnpm vitest run tests/workflow/validate.test.ts` → PASS 后全量回归

```bash
git add packages/core/src/workflow/validate.ts packages/core/tests/workflow/validate.test.ts
git commit -m "feat(core): 工作流结构校验器——环/端点/孤立/重复边"
```

---

### 任务 4：生命周期迁移与启用校验

**文件：**
- 修改：`packages/core/src/workflow/validate.ts`（追加两个函数）
- 测试：`packages/core/tests/workflow/validate.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```ts
import { transitionWorkflowStatus, validateEnablement } from "../../src/workflow/validate.js";
import type { Workspace } from "../../src/domain/model.js";

describe("transitionWorkflowStatus", () => {
  const wf = (status: Workflow["status"]): Workflow => ({ id: "w", name: "wf", status, nodes: [], edges: [] });
  it("draft→published→enabled 合法；跳级拒绝", () => {
    expect(transitionWorkflowStatus(wf("draft"), "published").status).toBe("published");
    expect(() => transitionWorkflowStatus(wf("draft"), "enabled")).toThrow(/draft.*enabled/);
  });
  it("published→enabled 需启用校验通过（注入校验结果）", () => {
    expect(() => transitionWorkflowStatus(wf("published"), "enabled", { ok: false, errors: ["节点 n1 引用缺失"], warnings: [] }))
      .toThrow(/节点 n1 引用缺失/);
    expect(transitionWorkflowStatus(wf("published"), "enabled", { ok: true, errors: [], warnings: [] }).status).toBe("enabled");
  });
  it("enabled→published（解除启用）合法；draft→draft 拒绝", () => {
    expect(transitionWorkflowStatus(wf("enabled"), "published").status).toBe("published");
    expect(() => transitionWorkflowStatus(wf("draft"), "draft")).toThrow();
  });
});

describe("validateEnablement", () => {
  const workspaceWith = (apis: Array<{ id: string }>, cases: Array<{ id: string; apiId: string }>): Workspace =>
    ({ id: "w", name: "w", variables: {}, groups: [{ id: "g", name: "g", projects: [{ id: "p", name: "p", variables: {}, environments: [], collections: apis.map((a) => ({ id: a.id, name: a.id, variables: {}, folders: [], apis: [{ id: a.id, name: a.id, version: "1", deprecated: false, method: "GET", url: "/", headers: [], query: [], cases: cases.filter((c) => c.apiId === a.id).map((c) => ({ id: c.id, name: c.id, scope: "base", parameters: {}, assertions: [] })) }] })), workflows: [] }] }] } as unknown as Workspace);

  it("全部节点引用存在且图合法 → ok", () => {
    const wf = wfFactory([req("n1")], []);
    // n1 引用 a-1/c-1（workspaceWith 已含）
    const r = validateEnablement(wf, workspaceWith([{ id: "a-1" }], [{ id: "c-1", apiId: "a-1" }]));
    expect(r.ok).toBe(true);
  });

  it("missing 引用与环 → ok=false 且 errors 齐全", () => {
    const wf = wfFactory([req("n1"), req("n2")], [{ id: "e1", from: "n1", to: "n2" }, { id: "e2", from: "n2", to: "n1" }]);
    const r = validateEnablement(wf, workspaceWith([], []));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /环/.test(e))).toBe(true);
    expect(r.errors.some((e) => /不存在/.test(e))).toBe(true);
  });
});
```

实现更正指令（照做）：上面 `wfFactory` 未定义——测试文件内定义辅助 `const wfFactory = (nodes, edges) => ({ id: "w", name: "wf", status: "published" as const, nodes, edges });`，并把第一个 describe 里重复的 `wf` 局部函数与之合并（单一定义）。

- [ ] **步骤 2：运行验证失败 → 实现**

`validate.ts` 追加：

```ts
import type { Workspace } from "../domain/model.js";
import { WorkflowStatusSchema } from "./model.js";

const TRANSITIONS: Record<string, string[]> = {
  draft: ["published"],
  published: ["enabled"],
  enabled: ["published"], // 解除启用
};

export function transitionWorkflowStatus(
  wf: Workflow, next: Workflow["status"], enablement?: { ok: boolean; errors: string[]; warnings: string[] },
): Workflow {
  const allowed = TRANSITIONS[wf.status] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`非法状态迁移: ${wf.status} → ${next}（允许: ${allowed.join(", ") || "无"}）`);
  }
  if (next === "enabled") {
    const check = enablement ?? { ok: false, errors: ["未提供启用校验结果"], warnings: [] };
    if (!check.ok) throw new Error(`启用校验未通过: ${check.errors.join("; ")}`);
  }
  return { ...wf, status: next };
}

export function validateEnablement(wf: Workflow, workspace: Workspace): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  errors.push(...validateWorkflowStructure(wf).filter((i) => i.level === "error").map((i) => i.message));
  warnings.push(...validateWorkflowStructure(wf).filter((i) => i.level === "warning").map((i) => i.message));

  const findCase = (apiId: string, caseId: string) => {
    for (const g of workspace.groups) for (const p of g.projects) for (const c of p.collections) {
      const api = c.apis.find((a) => a.id === apiId);
      if (api) {
        const tc = api.cases.find((x) => x.id === caseId);
        if (tc) return true;
        for (const f of c.folders) if (f.apis.some((a2) => a2.id === apiId && a2.cases.some((x) => x.id === caseId))) return true;
      }
      for (const f of c.folders) {
        const fApi = f.apis.find((a) => a.id === apiId);
        if (fApi?.cases.some((x) => x.id === caseId)) return true;
      }
    }
    return false;
  };

  for (const n of wf.nodes) {
    if (n.kind !== "request") continue;
    if (!n.apiId || !n.caseId) { errors.push(`节点「${n.label ?? n.id}」缺少接口/用例引用`); continue; }
    if (!findCase(n.apiId, n.caseId)) {
      errors.push(`节点「${n.label ?? n.id}」引用的接口/用例不存在（apiId=${n.apiId}, caseId=${n.caseId}）`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
```

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add packages/core/src/workflow/validate.ts packages/core/tests/workflow/validate.test.ts
git commit -m "feat(core): 工作流生命周期迁移守卫与启用校验"
```

---

### 任务 5：影响分析

**文件：**
- 创建：`packages/core/src/workflow/impact.ts`
- 测试：`packages/core/tests/workflow/impact.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { workflowImpact } from "../../src/workflow/impact.js";
import type { Workspace } from "../../src/domain/model.js";

const ws: Workspace = {
  id: "w", name: "w", variables: {},
  groups: [{
    id: "g", name: "g", projects: [{
      id: "p", name: "p", variables: {}, environments: [], collections: [],
      workflows: [
        { id: "wf1", name: "已启用流", status: "enabled",
          nodes: [{ id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录" }], edges: [] },
        { id: "wf2", name: "草稿流", status: "draft",
          nodes: [{ id: "n2", kind: "request", apiId: "a1", caseId: "c9", label: "引用缺失" }], edges: [] },
      ],
    }],
  }],
};

describe("workflowImpact", () => {
  it("按 caseId 反查：命中 enabled 工作流节点", () => {
    const r = workflowImpact(ws, { caseId: "c1" });
    expect(r).toEqual([{ workflowId: "wf1", workflowName: "已启用流", status: "enabled", nodeId: "n1", nodeLabel: "登录" }]);
  });
  it("按 apiId 反查：两个工作流的节点都命中", () => {
    expect(workflowImpact(ws, { apiId: "a1" })).toHaveLength(2);
  });
  it("无命中返回空数组", () => {
    expect(workflowImpact(ws, { caseId: "nope" })).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现**

`packages/core/src/workflow/impact.ts`：

```ts
import type { Workspace } from "../domain/model.js";

export interface WorkflowImpactEntry {
  workflowId: string; workflowName: string; status: string;
  nodeId: string; nodeLabel?: string;
}

/** 反查某用例/接口被哪些工作流节点引用（规格 §3.1 影响分析；删除/修改前供 CLI 与 UI 提醒）。 */
export function workflowImpact(workspace: Workspace, ref: { caseId?: string; apiId?: string }): WorkflowImpactEntry[] {
  const hits: WorkflowImpactEntry[] = [];
  for (const g of workspace.groups) for (const p of g.projects) for (const wf of p.workflows) {
    for (const n of wf.nodes) {
      if (n.kind !== "request") continue;
      const hit = (ref.caseId !== undefined && n.caseId === ref.caseId)
        || (ref.apiId !== undefined && n.apiId === ref.apiId);
      if (hit) hits.push({ workflowId: wf.id, workflowName: wf.name, status: wf.status, nodeId: n.id, nodeLabel: n.label });
    }
  }
  return hits;
}
```

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add packages/core/src/workflow/impact.ts packages/core/tests/workflow/impact.test.ts packages/core/src/index.ts
git commit -m "feat(core): 工作流影响分析——用例/接口引用反查"
```

（提交前：`packages/core/src/index.ts` 追加 `export * from "./workflow/model.js"; export { validateWorkflowStructure, transitionWorkflowStatus, validateEnablement, type ValidationIssue } from "./workflow/validate.js"; export { workflowImpact, type WorkflowImpactEntry } from "./workflow/impact.js";`——本任务起随各任务累计追加，任务 8 统一核对。）

---

### 任务 6：CollectionRunner 运行时桥（加法式）

**文件：**
- 修改：`packages/core/src/runner/runner.ts`
- 测试：`packages/core/tests/runner/runner.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

```ts
it("runtimeBridge：跨 run 携带运行时变量（工作流节点间传值基座）", async () => {
  const carried: Record<string, string> = {};
  const bridge = {
    get: () => ({ ...carried }),
    set: (vars: Record<string, string>) => { Object.assign(carried, vars); },
  };
  const runner = new CollectionRunner({ registry: buildRegistryForBridge(), bus: createEventBus(), timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 }, failFast: false });
  // buildRegistryForBridge = 与既有测试相同的注册装配辅助（文件内若已有 buildDeps 抽取复用，否则内联）
  const col = (pre: string, post: string): Collection => ({
    id: "c", name: "c", variables: {}, folders: [],
    apis: [{ id: "a", name: "a", version: "1", deprecated: false, method: "GET", url: "http://127.0.0.1:1/", headers: [], query: [],
      cases: [{ id: "t", name: "t", scope: "base", parameters: {}, preScript: pre, postScript: post, assertions: [] }] }],
  });
  const opts = { runtimeBridge: bridge };
  // run1: 提取 token
  await runner.run(col("pm.variables.set('token','abc');", ""), env, project, workspace, opts);
  expect(carried.token).toBe("abc");
  // run2: 读取 token（网络错误不影响变量断言——用后置脚本抛错检测可读性）
  const r2 = await runner.run(col("", "if (pm.variables.get('token') !== 'abc') throw new Error('token 丢失');"), env, project, workspace, opts);
  expect(r2.cases[0]!.error).toBeUndefined();
});
```

（对位现有文件内的 env/project/workspace 构造——复用既有顶层夹具。）

- [ ] **步骤 2：运行验证失败 → 实现（加法式）**

`runner.ts` 的 `RunnerOptions` 增：

```ts
export interface RunnerOptions {
  runsDir?: string;
  runtimeBridge?: {
    /** 读取外部携带的运行时变量（进入本 run 前注入 persisted 层）。 */
    get(): Record<string, string>;
    /** 本 run 结束后接收最终运行时变量（persisted 层快照）。 */
    set(vars: Record<string, string>): void;
  };
}
```

`run()` 内：构造 resolver 后、任何用例执行前：

```ts
const carried = opts.runtimeBridge?.get() ?? {};
for (const [k, v] of Object.entries(carried)) resolver.setRuntime(k, v);
```

`run()` 结尾（写 runsDir 之前）：

```ts
opts.runtimeBridge?.set(Object.fromEntries(/* persisted 快照 */));
```

实现更正指令（照做）：`persisted` 是 `run()` 局部 Map——在其旁维护 `const persistedSnapshot: Record<string, string> = {}`，`pm.variables.set` 双写处同步写快照，run 结尾 `opts.runtimeBridge?.set({ ...persistedSnapshot })`（含 `clearRuntime` 重放持久值时快照不回退——快照只在 set 时增长，语义 =「本次运行累计提取的变量」）。

- [ ] **步骤 3：运行验证通过 + Commit**

运行：`cd packages/core && pnpm vitest run`（既有用例零破坏——opts 可选）

```bash
git add packages/core/src/runner/runner.ts packages/core/tests/runner/runner.test.ts
git commit -m "feat(core): CollectionRunner 运行时桥——跨 run 变量携带（加法式）"
```

---

### 任务 7：WorkflowRunner（遍历 / 条件求值 / 级联跳过）

**文件：**
- 创建：`packages/core/src/workflow/runner.ts`
- 测试：`packages/core/tests/workflow/runner.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import type { Workflow } from "../../src/workflow/model.js";
import type { Workspace, Project } from "../../src/domain/model.js";
import { createDefaultRegistry } from "../../src/index.js";

let server: Server; let baseUrl = "";
beforeAll(async () => {
  server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ws: Workspace = { id: "w", name: "w", variables: {}, groups: [] };
const project: Project = { id: "p", name: "p", variables: {}, environments: [{ id: "e", name: "dev", variables: { baseUrl } }], collections: [], workflows: [] };
const apiOf = (id: string, url: string) => ({ id, name: id, version: "1", deprecated: false, method: "GET" as const, url, headers: [], query: [], cases: [{ id: `case-${id}`, name: `${id}-用例`, scope: "base", parameters: {}, assertions: [{ id: `as-${id}`, target: "status" as const, op: "eq" as const, expected: "200" }] }] });
const apis = [apiOf("a1", "{{baseUrl}}/one"), apiOf("a2", "{{baseUrl}}/two"), apiOf("a3", "{{baseUrl}}/three")];
const resolve = (apiId: string) => apis.find((a) => a.id === apiId);
const wf = (nodes: Workflow["nodes"], edges: Workflow["edges"]): Workflow => ({ id: "wf", name: "条件流", status: "enabled", nodes, edges });
const runOpts = { envName: "dev" as string | undefined };

function nodeResults(r: ReturnType<typeof Object>) { /* 见下——直接访问 r.nodeResults */ }

describe("WorkflowRunner", () => {
  it("线性两节点顺序执行且变量跨节点携带", async () => {
    // a1 后置提取 token；a2 前置断言 token 存在（经桥）
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    // 实现：为让 a2 校验 token，apiOf 需支持自定义脚本——改用 runOpts 不可行；改为在 WorkflowRunner 选项中不注入脚本，
    // 直接断言 nodeResults 顺序与 passed（变量桥已由任务 6 测试覆盖，此处覆盖遍历顺序）。
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: runOpts.envName, failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
    expect(r.total).toBe(2);
    expect(r.passed).toBe(2);
  });

  it("条件边：条件为假时下游 skipped 且级联", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
      { id: "n3", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "three" },
    ];
    const edges = [
      { id: "e1", from: "n1", to: "n2", condition: "prev.passed" },
      { id: "e2", from: "n2", to: "n3", condition: "false" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, edges), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["passed", "passed", "skipped"]);
    expect(r.skipped).toBe(1);
  });

  it("noop 节点直接通过；missing 引用 skipped 带告警", async () => {
    const nodes = [
      { id: "n1", kind: "noop", label: "占位" },
      { id: "n2", kind: "request" as const, apiId: "ghost", caseId: "ghost-case", label: "缺失" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2" }]), { project, workspace: ws });
    expect(r.nodeResults[0]!.state).toBe("noop");
    expect(r.nodeResults[1]!.state).toBe("skipped");
    expect(r.warnings.join("\n")).toContain("不存在");
  });

  it("多入节点：任一上游通过即执行（多入多出语义）", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "A" },
      { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const edges = [
      { id: "e1", from: "a", to: "c", condition: "true" },
      { id: "e2", from: "b", to: "c", condition: "true" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, edges), { project, workspace: ws });
    // a、b 都是起始节点顺序执行；c 两个入边条件均真——执行一次
    expect(r.nodeResults.filter((n) => n.nodeId === "c")).toHaveLength(1);
    expect(r.total).toBe(3);
  });

  it("条件表达式求值异常按 false 并告警", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2", condition: "prev.missing.deep" }]), { project, workspace: ws });
    expect(r.nodeResults[1]!.state).toBe("skipped");
    expect(r.warnings.some((w) => /条件求值失败/.test(w))).toBe(true);
  });

  it("环在执行前拒绝", async () => {
    const nodes = [ { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1" }, { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2" } ];
    await expect(new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "a" }]), { project, workspace: ws }))
      .rejects.toThrow(/环/);
  });

  it("envName 未找到显式报错（resolveEnv 对齐）", async () => {
    await expect(new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "ghost", failFast: false })
      .run(wf([{ id: "n", kind: "request" as const, apiId: "a1", caseId: "case-a1" }], []), { project, workspace: ws }))
      .rejects.toThrow(/未找到环境/);
  });
});
```

实现更正指令（照做）：删除测试草稿中的空辅助 `nodeResults`（未用）；`runOpts` 定义与用法不一致——各用例直接写 `envName: "dev"`/`undefined` 字面量，删除 `runOpts`。`it("线性两节点…")` 中注释块删除。`wf` 测试局部函数与文件级导入按需命名避撞。

- [ ] **步骤 2：运行验证失败 → 实现**

`packages/core/src/workflow/runner.ts`：

```ts
import { CollectionRunner, createDefaultRegistry, createEventBus } from "../index.js";
import { validateWorkflowStructure } from "./validate.js";
import type { Workflow, WorkflowNode } from "./model.js";
import type { CaseOutcome, RunResult } from "../report/types.js";
import type { Environment, Project, Workspace } from "../domain/model.js";
import type { PluginRegistry, PmApi } from "../plugin/types.js";

export type NodeState = "passed" | "failed" | "skipped" | "noop";

export interface NodeResult {
  nodeId: string; label?: string; kind: WorkflowNode["kind"];
  state: NodeState; outcome?: CaseOutcome; error?: string;
}

export interface WorkflowRunResult {
  workflowId: string; workflowName: string; status: Workflow["status"];
  nodeResults: NodeResult[];
  total: number; passed: number; failed: number; skipped: number;
  warnings: string[];
  startedAt: string; finishedAt: string;
}

export interface WorkflowRunnerOptions {
  registry: PluginRegistry;
  resolve: (apiId: string) => ApiDefinition | undefined;
  envName?: string;
  failFast?: boolean;
}

export class WorkflowRunner {
  private carried: Record<string, string> = {};

  constructor(private opts: WorkflowRunnerOptions) {}

  async run(workflow: Workflow, ctx: { project: Project; workspace: Workspace }): Promise<WorkflowRunResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    // 结构防御（环/端点）
    const structural = validateWorkflowStructure(workflow);
    const cycle = structural.find((i) => i.code === "cycle");
    if (cycle) throw new Error(cycle.message);

    const project = ctx.project;
    const env = resolveEnv(project, this.opts.envName);
    const runner = new CollectionRunner({
      registry: this.opts.registry, bus: createEventBus(),
      timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
      failFast: this.opts.failFast ?? false,
    });

    const nodeResults = new Map<string, NodeResult>();
    const incoming = new Map<string, WorkflowEdge[]>();
    const outgoing = new Map<string, WorkflowEdge[]>();
    for (const e of workflow.edges) {
      outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
      incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    }

    const ready = (nodeId: string): boolean => {
      const ins = incoming.get(nodeId) ?? [];
      if (ins.length === 0) return true;
      // 多入：任一入边来源通过（或 noop）即就绪；来源被跳过/失败不计——取「首个已完成的非 skipped 上游」语义简化为：任一上游 passed/noop
      return ins.some((e) => {
        const s = nodeResults.get(e.from);
        return s !== undefined && (s.state === "passed" || s.state === "noop");
      });
    };
    const blocked = (nodeId: string): boolean => {
      const ins = incoming.get(nodeId) ?? [];
      if (ins.length === 0) return false;
      // 所有上游均已终态且没有一条可达（passed/noop）→ 级联跳过
      const allSettled = ins.every((e) => nodeResults.has(e.from));
      return allSettled && !ready(nodeId);
    };

    const queue: WorkflowNode[] = workflow.nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0);
    const order: string[] = [];
    const apiOf = (node: WorkflowNode) => (node.apiId ? this.opts.resolve(node.apiId) : undefined);

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (nodeResults.has(node.id)) continue;
      order.push(node.id);

      if (node.kind === "noop") {
        nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "noop", state: "noop" });
      } else {
        const api = apiOf(node);
        const caseDef = api?.cases.find((c) => c.id === node.caseId);
        if (!api || !caseDef) {
          const msg = `节点「${node.label ?? node.id}」引用的接口/用例不存在（apiId=${node.apiId ?? ""}, caseId=${node.caseId ?? ""}），已跳过`;
          warnings.push(msg);
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state: "skipped", error: msg });
        } else {
          const collection = { id: `wf-${workflow.id}-${node.id}`, name: `${workflow.name}/${node.label ?? api.name}`, variables: workflowNodeVariables(workflow, node), folders: [], apis: [{ ...api, cases: [caseDef] }] };
          const outcome = await runSingleNode(runner, collection, env, project, ctx.workspace, { get: () => ({ ...this.carried }), set: (v) => Object.assign(this.carried, v) });
          const state: NodeState = outcome.passed ? "passed" : "failed";
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state, outcome, error: outcome.error });
        }
      }

      // 出边求值
      for (const edge of outgoing.get(node.id) ?? []) {
        if (edge.condition) {
          const verdict = evaluateCondition(edge.condition, nodeResults.get(node.id)!, this.carried, this.opts.registry, warnings);
          if (!verdict) {
            warnings.push(`边 ${edge.from} → ${edge.to} 条件不满足: ${edge.condition}`);
            continue;
          }
        }
        const target = workflow.nodes.find((n) => n.id === edge.to)!;
        if (!queue.some((n) => n.id === target.id) && !nodeResults.has(target.id) && !blocked(target.id)) {
          queue.push(target);
        }
      }
      // 级联：上游全部终态且不可达的节点标记 skipped
      for (const n of workflow.nodes) {
        if (!nodeResults.has(n.id) && blocked(n.id)) {
          nodeResults.set(n.id, { nodeId: n.id, label: n.label, kind: n.kind, state: "skipped" });
        }
      }
      if (this.opts.failFast && nodeResults.get(node.id)?.state === "failed") break;
    }

    // 未触达节点（不在任何已完成路径）→ skipped
    for (const n of workflow.nodes) {
      if (!nodeResults.has(n.id)) {
        nodeResults.set(n.id, { nodeId: n.id, label: n.label, kind: n.kind, state: "skipped" });
      }
    }

    const list = order.length > 0 ? order.map((id) => nodeResults.get(id)!) : [...nodeResults.values()];
    const total = list.length;
    const passed = list.filter((n) => n.state === "passed" || n.state === "noop").length;
    const failed = list.filter((n) => n.state === "failed").length;
    const skipped = list.filter((n) => n.state === "skipped").length;
    return {
      workflowId: workflow.id, workflowName: workflow.name, status: workflow.status,
      nodeResults: list, total, passed, failed, skipped, warnings,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }
}
```

配套私有函数（同文件）：

```ts
function resolveEnv(project: Project, envName: string | undefined): Environment | undefined {
  if (!envName) return undefined;
  const env = project.environments.find((e) => e.name === envName);
  if (!env) throw new Error(`未找到环境: ${envName}`);
  return env;
}

function workflowNodeVariables(_wf: Workflow, _node: WorkflowNode): Record<string, string> { return {}; }

async function runSingleNode(runner: CollectionRunner, collection: unknown, env: unknown, project: Project, workspace: Workspace, bridge: { get(): Record<string, string>; set(v: Record<string, string>): void }): Promise<CaseOutcome> {
  const result = await runner.run(collection as Parameters<CollectionRunner["run"]>[0], env as Environment, project, workspace, { runtimeBridge: bridge });
  return result.cases[0]!;
}

function evaluateCondition(expr: string, upstream: NodeResult, carried: Record<string, string>, registry: PluginRegistry, warnings: string[]): boolean {
  const engine = registry.getScriptEngine("javascript");
  if (!engine) { warnings.push("缺少 javascript 脚本引擎，条件按 false 处理"); return false; }
  const prev = upstream.outcome
    ? { passed: upstream.outcome.passed, caseName: upstream.outcome.caseName, error: upstream.outcome.error, assertions: upstream.outcome.assertions }
    : { passed: upstream.state === "noop", caseName: upstream.label, error: undefined, assertions: [] };
  const vars = { ...carried };
  const pm = { prev, vars, __value: undefined as unknown } as PmApi & { __value: unknown; vars: Record<string, string>; prev: unknown };
  try {
    engine.run(`pm.__value = Boolean((${expr}))`, { pm: pm as PmApi });
    return pm.__value === true;
  } catch (e) {
    warnings.push(`条件求值失败（按不通过处理）: ${expr} —— ${(e as Error).message}`);
    return false;
  }
}
```

实现更正指令（照做，均为计划草稿自纠）：① 文件顶部补 `import type { ApiDefinition } from "../domain/model.js";`；② `runSingleNode` 的 `collection/env` 参数改强类型（构造处已是合规对象，直接以 `Collection`/`Environment` 类型声明，去掉 unknown cast）；③ `workflowNodeVariables` 无用——删除；④ `pm` 构造为普通对象并 cast，`vars` 属性直接可枚举（属性访问语义 `vars.orderId` 成立）；⑤ 队列循环里「级联 skipped」扫描放在出边求值之后（如上）；⑥ 多入节点 `ready()` 语义=「任一上游 passed/noop」，与测试 4 对齐；⑦ `import { CollectionRunner, createEventBus }` 与 `createDefaultRegistry` 分开：runner.ts 内部用相对导入 `../runner/runner.js`、`../events/bus.js`（避免 index 循环），`createDefaultRegistry` 由测试注入不在此导入——构造处已由 opts 传入 registry，删除 `createDefaultRegistry` 导入。

- [ ] **步骤 3：运行验证通过 + Commit**

运行：`cd packages/core && pnpm vitest run tests/workflow/runner.test.ts` → PASS → 全量回归

```bash
git add packages/core/src/workflow/runner.ts packages/core/tests/workflow/runner.test.ts
git commit -m "feat(core): WorkflowRunner——拓扑遍历/条件边/级联跳过/运行时桥"
```

---

### 任务 8：RunResult 适配 + CLI run-workflow

**文件：**
- 创建：`packages/core/src/workflow/adapter.ts`
- 修改：`packages/core/src/index.ts`（累计导出核对）、`packages/cli/src/main.ts`
- 测试：`packages/core/tests/workflow/adapter.test.ts`、`packages/cli/tests/e2e.test.ts`（追加）

- [ ] **步骤 1：编写失败的适配器测试**

`packages/core/tests/workflow/adapter.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { workflowToRunResult } from "../../src/workflow/adapter.js";
import type { WorkflowRunResult } from "../../src/workflow/runner.js";

const sample: WorkflowRunResult = {
  workflowId: "wf", workflowName: "条件流", status: "enabled",
  nodeResults: [
    { nodeId: "n1", label: "one", kind: "request", state: "passed", outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "one-用例", passed: true, durationMs: 3, assertions: [] } },
    { nodeId: "n2", label: "占位", kind: "noop", state: "noop" },
    { nodeId: "n3", label: "skip", kind: "request", state: "skipped" },
    { nodeId: "n4", label: "bad", kind: "request", state: "failed", outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "bad-用例", passed: false, durationMs: 1, assertions: [{ pass: false, message: "eq 失败" }] } },
  ],
  total: 4, passed: 2, failed: 1, skipped: 1,
  warnings: ["边 n2 → n3 条件不满足"], startedAt: "2026-09-02T00:00:00Z", finishedAt: "2026-09-02T00:00:01Z",
};

describe("workflowToRunResult", () => {
  it("映射为 RunResult：请求节点带 outcome，noop/skipped 生成合成用例", () => {
    const r = workflowToRunResult(sample);
    expect(r.collectionName).toBe("条件流");
    expect(r.total).toBe(4);
    expect(r.cases).toHaveLength(4);
    expect(r.cases[0]!.caseName).toBe("one-用例");
    expect(r.cases[1]!.caseName).toBe("占位");
    expect(r.cases[1]!.passed).toBe(true);
    expect(r.cases[2]!.passed).toBe(false);
    expect(r.cases[2]!.error).toContain("skipped");
    expect(r.cases[3]!.assertions.some((a) => !a.pass)).toBe(true);
    expect(r.warnings).toEqual(["边 n2 → n3 条件不满足"]);
  });
});
```

- [ ] **步骤 2：运行验证失败 → 实现**

`packages/core/src/workflow/adapter.ts`：

```ts
import type { RunResult, CaseOutcome } from "../report/types.js";
import type { WorkflowRunResult, NodeResult } from "./runner.js";

function toCaseOutcome(node: NodeResult): CaseOutcome {
  if (node.outcome) return node.outcome;
  const message = node.state === "skipped" ? "skipped（上游条件不满足或引用缺失）" : "noop（空过占位节点）";
  return {
    apiId: node.nodeId, apiName: node.label ?? node.nodeId,
    caseId: node.nodeId, caseName: node.label ?? node.nodeId,
    passed: node.state === "noop", durationMs: 0,
    assertions: [{ pass: node.state === "noop", message }],
    error: node.error,
  };
}

/** WorkflowRunResult → RunResult（复用既有 Reporter 插件渲染；skipped 计为失败以在报告可见）。 */
export function workflowToRunResult(wfr: WorkflowRunResult): RunResult {
  const cases = wfr.nodeResults.map(toCaseOutcome);
  return {
    collectionId: wfr.workflowId,
    collectionName: `工作流: ${wfr.workflowName}`,
    envName: undefined,
    startedAt: wfr.startedAt, finishedAt: wfr.finishedAt,
    total: cases.length,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    cases,
    warnings: wfr.warnings,
  };
}
```

注意：`RunResult.warnings` 若在 2B 已存在则直接用；核对 `report/types.ts`（2B 任务 8 加过 `warnings?: string[]`）。skipped→passed:false 的映射决策写入注释。

- [ ] **步骤 3：编写失败的 CLI e2e → 实现 run-workflow**

`packages/cli/tests/e2e.test.ts` 追加（临时工作区三节点条件工作流，本地 http 服务；断言 exit 0、报告生成、workflow.yaml 位置）：

```ts
it("run-workflow 按条件流转执行并产出报告", async () => {
  // 夹具：项目含 3 个接口（one/two/three）+ workflow.yaml（one --prev.passed--> two --false--> three）
  // 执行 runCli(["run-workflow", "groups/demo/projects/svc/workflows/条件流", "--env", "dev", "--reporters", "json"], ...)
  // 断言：exit 0；.apicc/runs 出现 json；three 节点为 skipped
}, 30000);
```

（夹具构造沿既有 e2e 的 fileStorage.save 模式；workflow.yaml 手写 YAML 文本写入 `.../workflows/条件流/workflow.yaml`，nodes 引用夹具接口 id。）

`packages/cli/src/main.ts` 增命令（复用 run 命令的加载/定位/报告模式）：

```ts
program
  .command("run-workflow")
  .argument("<workflowPath>", "工作流目录（相对工作区根，如 groups/g/projects/p/workflows/名）")
  .option("--env <name>", "环境名称")
  .option("--force-draft", "允许运行草稿（跳过生命周期与启用校验，仅结构校验）", false)
  .option("--reporters <list>", "报告格式，逗号分隔", "html")
  .option("--runs-dir <dir>", "运行历史输出目录")
  .action(async (workflowPath: string, opts: { env?: string; forceDraft: boolean; reporters: string; runsDir?: string }) => {
    // 1. findWorkspaceRoot + storage.load（同 run 命令）
    // 2. 遍历 groups→projects→workflows 定位（目录后缀匹配，toSlash 归一，首个命中 break；未找到抛错）
    // 3. env 解析：opts.env ? project.environments.find(name) : undefined；find 未命中抛 未找到环境
    // 4. 状态门：workflow.status === "draft" && !opts.forceDraft → 抛「工作流为草稿，请先发布启用或加 --force-draft」
    // 5. new WorkflowRunner({ registry, resolve: (apiId) => 沿 workspace 查找 api, envName: opts.env, failFast: false })
    //    .run(workflow, { project, workspace }) → wfr
    // 6. workflowToRunResult(wfr) → 按 --reporters 渲染到 join(root, ".apicc", "runs")
    // 7. process.exitCode = wfr.failed > 0 ? 1 : 0；log 汇总（含 skipped 计数与 warnings）
  });
```

resolve 实现（workspace 全树查找 api）：

```ts
const findApi = (apiId: string) => {
  for (const g of workspace.groups) for (const p of g.projects) for (const c of p.collections) {
    const api = c.apis.find((a) => a.id === apiId);
    if (api) return api;
    for (const f of c.folders) { const fa = f.apis.find((a) => a.id === apiId); if (fa) return fa; }
  }
  return undefined;
};
```

`packages/core/src/index.ts` 导出核对（累计）：`WorkflowSchema/WorkflowStatusSchema`、`validateWorkflowStructure/transitionWorkflowStatus/validateEnablement/ValidationIssue`、`workflowImpact/WorkflowImpactEntry`、`WorkflowRunner/WorkflowRunResult/NodeResult/WorkflowRunnerOptions`、`workflowToRunResult`。

- [ ] **步骤 4：运行验证通过 + 全量回归**

运行：`cd packages/core && pnpm vitest run && cd ../../packages/cli && pnpm vitest run`
预期：全绿

- [ ] **步骤 5：Commit**

```bash
git add packages/core packages/cli
git commit -m "feat(cli): run-workflow 命令与 WorkflowRunResult→RunResult 适配"
```

---

## 规格覆盖对照（计划 ↔ 规格 §3.1）

| 规格条目 | 任务 |
|----------|------|
| 工作流文件/数据模型/position 预留 | 1 |
| 存储接线（含坏文件隔离、§6 布局） | 2 |
| 校验器：环/端点/孤立/重复边 | 3 |
| 生命周期三态迁移 + 启用校验（§5） | 4 |
| 影响分析 workflowImpact | 5 |
| 节点间变量共享（runtimeBridge） | 6 |
| 执行器：遍历/条件/级联/noop/missing/多入多出/环拒绝/env 显式报错 | 7 |
| RunResult 适配 + CLI run-workflow + 退出码 | 8 |
| 端到端 + 报告落盘 | 8 |
| 条件求值上下文 prev/vars、异常按 false | 7 |

## 自检结果

1. **覆盖度**：规格 §3.1 全条目映射如上；§3.2 排除项未混入（position 仅 schema 预留、无并发语义）。
2. **占位符扫描**：任务 7/8 的「实现更正指令」是计划草稿自纠的显式指令（非 TODO）；无未定义符号（wfFactory、buildRegistryForBridge 等已给定义指令）。
3. **类型一致性**：`WorkflowRunResult/NodeResult` 在任务 7 定义、任务 8 消费；`runtimeBridge` 在任务 6 定义、任务 7 构造；`resolveEnv` 语义与 2B desktop 侧对齐（未找到显式报错）；`RunResult.warnings` 2B 已存在。

## 执行注意事项

- 品牌中立约束适用于全部新文件
- 每任务提交前三绿（core + cli；desktop 不在范围但 core schema 变更后需确保 apps/desktop 不受破坏——ProjectSchema 加字段为加法式，desktop 侧 strict 解析不受影响，任务 1 全量回归时顺带跑一次 desktop 测试确认）
- Windows 路径一律 node:path；workflow 名称可含中文（目录名），fileStorage 既有 sortedNames 已处理
