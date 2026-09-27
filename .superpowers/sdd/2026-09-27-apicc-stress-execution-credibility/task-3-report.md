# Task 3 实施报告：虚拟用户用例 session 与数据隔离

## RED

- 新增 `caseSession.test.ts` 后首次运行：Vitest suite 失败，`../../src/stress/caseSession.js` 不存在。
- 将 `runner.test.ts` 迁移至 `createWorker` 工厂后、尚未改生产代码时运行：8 个用例因旧实现调用 `this.opts.buildRequest` 失败，错误为 `this.opts.buildRequest is not a function`。

## GREEN

- 聚焦压测测试：`tests/stress/caseSession.test.ts` 与 `tests/stress/runner.test.ts`，12/12 passed。
- Core 全量：40 test files、331 tests passed。
- `pnpm -C packages/core typecheck`：通过。
- `pnpm -C packages/core build`：通过。
- 品牌门禁：`node scripts/check-brand-neutral.mjs --self-check` 与扫描均通过。
- `git diff --check`：通过（仅有 Git 的 LF/CRLF 提示，无 whitespace error）。

## 文件

- 新增 `packages/core/src/stress/caseSession.ts`：每 session 独立 resolver、persisted/snapshot、数据游标和 managed protocol client；构造时读取并校验数据；授权钩子位于 executor 发包前；close 幂等。
- 新增 `packages/core/tests/stress/caseSession.test.ts`：变量/数据隔离、完整用例语义、最终请求授权、空数据与创建时校验、幂等关闭。
- 修改 `packages/core/src/stress/runner.ts`：worker session 工厂、单 worker 单 session、finally close、executor 样本字段；保留旧 client/buildRequest 的过渡适配。
- 修改 `packages/core/tests/stress/runner.test.ts`：factory 夹具及成功/异常/中止 close-once 覆盖。
- 修改 `packages/core/src/stress/model.ts`、`aggregate.ts`：样本补充 request/script/iteration timing、failureKind/outcome，并保持状态与分类聚合兼容。
- 修改 `packages/core/src/index.ts`：导出 session 工厂和类型。

## 疑虑与边界

- 本任务没有实现 Task 4 阈值、Task 5 生成器指标或 Task 7 安全策略本体；`authorizeRequest` 仅作为可选注入钩子。
- JSON 数据行目前要求记录对象且字段值为字符串，与现有 `Record<string, string>` 执行契约一致；空 CSV/JSON 统一为一行 `undefined`。
- 旧 `StressRunner` 调用保留了兼容适配，新的压测路径应使用 `createWorker` 与 `createStressCaseSession`。

## Commit

- 实现 commit SHA：`7be1048d4aa83268caf8287585f5a435bd337f6f`。
