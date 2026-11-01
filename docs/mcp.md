# MCP 服务器（agent 接入）

apicc 内置 stdio MCP（Model Context Protocol）服务器，固定本地工作区或获授权的在线成员来源。F7e 的完整工具、在线 profile、准备/启动/对账、预算与安全边界见 [AI 与 MCP 使用说明](f7e-ai-mcp.md)。下列本地客户端配置仍可使用。

- 传输：stdio（JSON-RPC 由官方 MCP SDK 承接），**stdout 是协议通道**，人类可读日志一律走 stderr
- 默认只读：资产/运行/报告工具可用，保留旧本地 `list-apis` / `get-api-design`；`prepare-run` / `start-run` / `cancel-run` 及旧本地 `run-case` 仅在 `--allow-run` 启动时注册
- 安全边界：工具只能访问固定本地根或在线 profile 的项目 allowlist；不能选择任意文件路径、秘密或自由请求。源工作区不因 AI 候选自动写入；宿主私有运行结果与在线意图 journal 是有界持久数据，不应理解为整个宿主零落盘

## 构建前提

环境要求与仓库构建一致（Node.js ≥ 22.19、pnpm ≥ 9）：

```bash
git clone <repo-url> apicc
cd apicc
pnpm install
pnpm -r build
```

配置示例中的命令指向构建产物 `packages/cli/dist/bin.js`（建议使用绝对路径）。

## 客户端配置

在 MCP 客户端的 mcpServers 配置（如 Claude Desktop 的 `claude_desktop_config.json`、Cursor 的 `mcp.json`）中加入：

```json
{
  "mcpServers": {
    "apicc": {
      "command": "node",
      "args": [
        "<仓库绝对路径>/packages/cli/dist/bin.js",
        "mcp",
        "--workspace",
        "<你的工作区绝对路径>"
      ]
    }
  }
}
```

开启保存目标执行工具——AI 触发网络请求须显式 opt-in，建议客户端为 start/cancel 等副作用另启人工确认：

```json
{
  "mcpServers": {
    "apicc": {
      "command": "node",
      "args": [
        "<仓库绝对路径>/packages/cli/dist/bin.js",
        "mcp",
        "--workspace",
        "<你的工作区绝对路径>",
        "--allow-run"
      ]
    }
  }
}
```

说明：

- `command` 用 `node` + 产物绝对路径，跨平台（含 Windows）最稳；类 Unix 下也可给 `bin.js` 赋执行权限后直接作为 command
- `--workspace` 必须指向含 `apicc.workspace.yaml` 的目录，建议绝对路径；服务器启动时校验，缺失即报错退出
- 配置修改后重启客户端生效

## 工具清单

F7e 增加 `list-assets`、`get-asset`、`list-runs`、`get-run`、`get-report`，以及显式开启的 `prepare-run`、`start-run`、`cancel-run`。分页和输出受预算约束；ticket 是原准备的引用，不是人工确认或认证秘密。以下为保留的本地兼容入口：

| 工具 | 参数 | 说明 |
|---|---|---|
| `list-apis` | 无 | 列出工作区内全部接口摘要（`id`/`name`/`protocol`/`url`/`apiPath`，含文件夹内接口）；`apiPath` 用于其余两个工具定位接口 |
| `get-api-design` | `apiPath` | 读取接口详细设计——结构化 Markdown（定义 / 请求体 / 设计正文 / 测试用例表），即 `apicc export-design` 同源产物 |
| `run-case` | `apiPath`、`caseId` | 执行单个接口的单个用例，返回结果摘要（passed / assertions / error）。**执行类工具，默认关闭**：仅服务器以 `--allow-run` 启动时才出现在工具清单 |

`run-case` 补充：

- 未选环境执行，仅适用 `base` 作用域用例；环境作用域用例会显式报错而非静默跳过
- 每次调用只执行目标用例并返回结果，不在工作区写入任何文件

## stdio 与进程生命周期

- 服务器是客户端拉起的子进程：启动、停止、崩溃重启均由 MCP 客户端负责；客户端断开（关闭 stdin）后服务器自动退出
- 本地拥有的活动执行会取消并收束；在线已接纳的 agent 任务继续，由 `get-run/get-report` 查询，明确 `cancel-run` 才请求取消。提交响应丢失时保留原 ticket/intent 对账，禁止换 intent 自动重发
- 排查问题时看 stderr：服务器启动行与错误信息都输出到 stderr，stdout 中只应有 MCP 协议帧
