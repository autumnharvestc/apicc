# MCP 服务器（agent 接入）

apicc 内置一个 stdio MCP（Model Context Protocol）服务器：`apicc mcp` 把本地工作区的接口能力暴露为 MCP 工具，供 Claude Desktop、Cursor 等 agent 客户端直接检索接口、读取接口详细设计，以及（显式开启后）执行单个测试用例。

- 传输：stdio（JSON-RPC 由官方 MCP SDK 承接），**stdout 是协议通道**，人类可读日志一律走 stderr
- 默认只读：`list-apis` / `get-api-design` 两个只读工具始终可用；执行类工具 `run-case` **默认关闭**，仅在 `--allow-run` 启动时注册
- 安全边界：工具只能访问 `--workspace` 指定的工作区；工具没有任何文件系统路径类参数，路径无法逃逸工作区根；工作区只读加载、零落盘

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

开启执行类工具（`run-case`）——AI 触发网络请求须显式 opt-in：

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
- 排查问题时看 stderr：服务器启动行与错误信息都输出到 stderr，stdout 中只应有 MCP 协议帧
