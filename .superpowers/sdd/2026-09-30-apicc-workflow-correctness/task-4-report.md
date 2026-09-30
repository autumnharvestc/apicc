# 任务 4：CLI/桌面工作流消费一致结论报告

## 交付

- CLI `run-workflow` 增加 `--no-strict`，默认向 `WorkflowRunner` 传 `strict=true`；放宽模式只继续独立节点诊断，最终仍按 `wfr.verdict === "failed" || wfr.failed > 0` 返回退出码 1。
- CLI 与 IPC 只用工作流所属项目的 `findProjectApi` 递归解析接口（含多层文件夹），保留实际 HTTP 行，不把路由/条件失败改写成通过行失败；CLI/IPC 原始结果名改为 `workflow-${workflowId}-${randomUUID()}.json`。
- IPC `WfRunInput.strict?: boolean` 经 Zod 白名单透传；session/memory 启用校验把所属项目传给 `validateEnablement`。
- CLI 报告沿用 `workflowToRunResult` 的展开行/独立诊断；CLI 输出增加节点统计和跳过原因。
- 桌面 RunView/WfResultDrawer 消费三态：优先 skipped，再 passed/failed；显示 row、failureKind、error、skipReason；工作流抽屉展开全部 outcomes，并在请求行通过但节点路由失败时追加独立节点诊断行。

## 精确修改文件

`packages/cli/src/main.ts`, `packages/cli/tests/e2e.test.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/session.ts`, `apps/desktop/src/renderer/src/api/memory.ts`, `apps/desktop/src/shared/types.ts`, `apps/desktop/src/renderer/src/components/RunView.vue`, `apps/desktop/src/renderer/src/components/WfResultDrawer.vue`, `apps/desktop/src/renderer/src/i18n/en.json`, `apps/desktop/src/renderer/src/i18n/zh-CN.json`, `apps/desktop/tests/main/ipc.test.ts`, `apps/desktop/tests/renderer/components/RunView.test.ts`, `apps/desktop/tests/renderer/components/wfDesigner.test.ts`。

## TDD 证据

### RED

- `pnpm -C packages/cli exec vitest run tests/e2e.test.ts`：26 tests 中 2 个失败。新增 strict 回归在旧 CLI 下无法按测试期望建立 strict/relaxed 行为；既有条件流断言仍期待旧的“条件不满足”输出，而 core 已提供 `condition-pruned` 字段。随后将 strict 断言修正为实际进程退出码 1，并让 CLI 输出兼容的中文跳过原因。
- `pnpm -C apps/desktop exec vitest run tests/main/ipc.test.ts tests/renderer/components/wfDesigner.test.ts tests/renderer/components/RunView.test.ts tests/renderer/stores/workflowDesign.test.ts`：83 tests 中 3 个失败：IPC `strict=false` 独立节点仍为 skipped、RunView 未显示三态字段、抽屉仍只有节点行而没有全部 outcomes。

### GREEN

- `pnpm -C packages/core build`：exit 0。
- `pnpm -C packages/cli test`：8 files / 92 tests passed；包含 core build、CLI build。
- `pnpm -C packages/cli build`：exit 0；随后实际进程回归 `pnpm -C packages/cli exec vitest run tests/e2e.test.ts`：26 tests passed（测试启动 `packages/cli/dist/bin.js`）。
- `pnpm -C apps/desktop test`：70 files / 717 tests passed。
- `pnpm -C apps/desktop build`：exit 0，包含 `tsc -p tsconfig.json --noEmit`、`vue-tsc --noEmit -p tsconfig.json`、renderer/electron/preload build。构建保留既有大 bundle 与 Node 模块 externalized warning，无 typecheck/build error。

## 消费字段清单

| 消费者 | 字段 |
| --- | --- |
| CLI 原始/退出结论 | `WorkflowRunResult.verdict`, `failed`, `skipped`, `nodeResults[].state`, `skipReason`, `failureKind`, `outcomes` |
| CLI HTML/JUnit | `workflowToRunResult` 展开的 `CaseOutcome.row`, `nodeId`, `skipped`, `skipReason`, `failureKind`, `error` |
| IPC | `WfRunInput.strict`, `WorkflowRunResult.verdict/nodeResults/outcomes` |
| 工作流抽屉 | `outcomes`（旧报告回退 `outcome`）、`row`, `nodeId`, `skipped`, `skipReason`, `failureKind`, `error` |
| RunView | `CaseOutcome.passed/skipped/skipReason/failureKind/error/row`，旧报告 `skipped` 缺省按 0 |

## 同毫秒回归

CLI e2e 的实际 `dist/bin.js` 测试将同一工作流连续运行两次并断言同一目录存在两个不同原始 JSON；IPC 测试同样连续运行两次并断言两个不同文件。CLI 与 IPC 均使用 `randomUUID()`，因此同一 `workflowId` 在同毫秒运行不会覆盖。文件名不再依赖 `Date.now()`。

## 疑虑

- 工作区 `docs/superpowers/plans/2026-09-30-apicc-workflow-correctness.md` 在本任务开始时已存在其他协作者修改；本任务未编辑、未暂存该文件。
- 桌面 jsdom 全测保留既有 `getComputedStyle(... pseudo-elements)` 警告；不影响 70/717 通过。全测包含 `apps/desktop/tests/main/online/e2e-server.test.ts` 的真实 jar server E2E（该文件 beforeAll 会构建/启动 JDK 21 服务端并 afterAll 确认退出）；本任务没有故意制造真实 server 争用场景，因此无 Task 5 争用记录，也未启动真实 Electron GUI。
