# apicc M6-B MCP 服务器实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** `apicc mcp --workspace <root> [--allow-run]`：stdio MCP 服务器（@modelcontextprotocol/sdk），暴露只读工具 `list-apis`/`get-api-design` 与 opt-in 的 `run-case`；README 配置示例。

**工作目录：** `D:\workspace260609\project-2\apicc-m6-mcp`（worktree，分支 `feature/m6-mcp`）。**基线：core 254 / cli 28 全绿（main @ b6dac7e）。**

**全局约束：** 品牌中立；中文 conventional commit（`feat(cli): ...`）；门禁 = core 全量 + cli 全量 + typecheck；日志走 stderr（stdout 是 MCP 协议通道）；**run-case 默认不注册**；安全边界——工具只暴露 --workspace 指定的工作区，路径不得逃逸。

**注意：** 与 M6-A 轨并行——两者都改 `packages/cli/src/main.ts`（不同命令段）与 pnpm-lock；**本轨不碰 `ai` 命令段与 packages/core/src/ai/**（轨 1 领地）；合并冲突由控制者调和。

---

## 文件结构

```
packages/cli/src/mcp/server.ts   ← 新：createMcpServer(root, {allowRun})——SDK 接线与工具实现
packages/cli/src/main.ts         ← 改：mcp 命令（--workspace 必填、--allow-run 开关）
packages/cli/package.json        ← dependencies 增 @modelcontextprotocol/sdk
packages/cli/tests/mcp-server.test.ts
README.md                        ← MCP 客户端配置示例节（或 docs/，报告注明落点）
```

---

### 任务 1：mcp 命令与工具实现

- [ ] **步骤 1：失败的测试**
  1. 工具单测（直接调 server 内部工具实现或 SDK client 内存对测——SDK 支持 InMemoryTransport 对测，实现者选型报告注明）：`list-apis` → 临时工作区夹具返回三接口摘要（id/name/protocol/url，含 folder 内接口）；`get-api-design`（参数 apiId 或 apiPath——实现者定口径并报告注明）→ 返回 renderDesignMarkdown 产物；`run-case` 在未开 `--allow-run` 时**不在工具清单**。
  2. run-case（--allow-run 开启）：本地 http server 夹具 → 调用后返回 CaseOutcome 摘要（passed/assertions/error）；执行复用 CollectionRunner 单接口语义（与 core sendDebug 同源——报告注明实现落点）。
  3. 边界：--workspace 外路径不可达（工具无路径参数，天然收敛——测试钉住 list-apis 只见指定工作区）；stderr 日志不污染 stdout（协议通道）。
  4. stdio 端到端（可选加分项）：spawn 自身 `mcp --workspace` + JSON-RPC initialize/tools-list 往返——若 SDK 内存对测已足够则免，报告注明取舍。
- [ ] **步骤 2：实现**——SDK 依赖（版本选当前稳定最新报告注明）；`McpServer` + `registerTool`；工作区加载复用 fileStorage + 定位先例；run-case 的 runner 构造复用/对齐 resolveStressTarget 的按协议选 client 口径（M5 交付——报告注明复用点）。
- [ ] **步骤 3：全量回归 + Commit** `feat(cli): apicc mcp——stdio MCP 服务器与只读工具集`

### 任务 2：README 配置示例

- [ ] **步骤 1：核对清单**——README（或 docs/mcp.md，报告注明）增节：构建前提、Claude Desktop / Cursor 的 mcpServers JSON 配置示例（command 指向构建产物、args 含 --workspace）、工具清单表（三工具 + allow-run 说明 + 安全边界「执行类工具默认关闭」）。
- [ ] **步骤 2：Commit** `docs: MCP 客户端配置示例与工具说明`

---

## 规格覆盖对照

| 规格（m6 spec §2） | 任务 |
|---|---|
| D5 MCP 服务器/工具集/opt-in | 1 |
| D6 实现约束（stdio/只读/日志） | 1 |
| 成功标准（agent 客户端消费） | 2 |

**明确推迟**：MCP resources/prompts、写类工具、远程传输（SSE/HTTP）。
