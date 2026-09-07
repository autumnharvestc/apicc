<!-- 徽章：远端仓库建立后启用 [![CI](<repo>/actions/workflows/ci.yml/badge.svg)](<repo>/actions) -->

# apicc

apicc 是一个开源（MIT）的、**本地优先**的 API 全生命周期平台：接口定义、调试、自动化测试、工作流编排、压测一站式覆盖。数据以 Git 友好的文本文件存于本地，免登录的本地模式功能完备——下载即用，数据不出本机。

## 特性

- **接口定义即代码资产**：纯文本 YAML/JSON 存储 + Git 优先，可 diff、可评审、可离线；SQLite 仅作可随时删除重建的索引缓存
- **接口调试与自动化测试**：用例、断言、变量提取、多环境变量集（支持派生），运行后产出 HTML 报告与运行历史；前置/后置操作（脚本）可在模块、文件夹与用例任一层级挂载，按执行路径有序生效
- **工作流编排**：把多个接口用例按 DAG 编排成端到端业务场景（如「登录 → 下单 → 查询 → 校验」），支持条件流转与生命周期管理，配套可视化设计器
- **分布式压测**：并发池、迭代/时长双模式，多 shard 并行施压、原始样本汇聚成单一报告，分位数（P50/P90/P95/P99）跨 shard 精确
- **开放生态导入**：支持开放 API 规范（OpenAPI）2.0/3.0 与集合文件 v2.1 兼容导入，导入前预览差异、不静默覆盖
- **AI 可消费的接口设计导出**：`export-design` 将接口定义与详细设计渲染为结构化 Markdown，供 AI 助手与自动化流水线消费
- **桌面端**：基于 Electron 的图形界面，接口调试、工作流设计、压测发起与报告查看均在本地完成
- **Web 管理后台**：服务端自托管 Web 控制制台（SPA），与协作 API 同一进程部署，账号、工作区、成员与项目权限管理在浏览器完成

## 桌面端界面结构

- **主页**（顶栏入口）：本地服务器（本地目录）与远程服务器（自托管协作服务）的连接管理；分组与项目的创建/打开从这里进入——打开本地来源的项目即进入本地模式，打开远程团队空间的项目即进入在线模式。启动时自动恢复上次打开的项目（无记录或恢复失败则回到主页）
- **接口**：项目内按 模块（一个服务）→ 文件夹 → 接口 组织，树形层级 + 搜索；调试（请求编辑/响应查看，环境按项目记忆）与设计两个子视图
- **测试**：单接口用例（用例项可增删、可单独运行、可发起压测）与场景用例（复用工作流编排）两个入口
- **环境**：全局变量与全局参数（Query/Header/Cookie/Body，归属项目）+ 多环境（环境变量、按模块设置的前置 URL，支持环境派生）
- **工作流 / 运行**：场景编排设计与集合/工作流运行、历史报告
- **设置**（顶栏齿轮）：插件管理

数据层级：`工作区目录 → 分组 → 项目 → 模块 → 文件夹 → 接口 → 用例`；环境归属项目，全局变量与全局参数归属项目并跨模块生效。

## 快速开始

环境要求：Node.js ≥ 22.19、pnpm ≥ 9。

```bash
git clone <repo-url> apicc
cd apicc
pnpm install
pnpm -r build
```

命令行入口为 `packages/cli/dist/bin.js`（下例以 `apicc` 指代，可自行设置别名）。所有命令均以本地工作区（含 `apicc.workspace.yaml` 的目录）为根。工作区本身是纯文本目录（分组 / 项目 / 集合 / 接口等层级），可手工编写、经 Git 版本化，或在桌面端中创建；层级约定见 `docs/` 下的设计规格。

服务端（团队协作/管理后台）支持 Docker Compose 与 k8s 一键部署（含首个管理员引导），见 [docs/deploy.md](docs/deploy.md)。

```bash
# 校验工作区结构
apicc validate my-workspace

# 运行集合（--env 为必填，报告默认输出到工作区根 .apicc/runs）
apicc run groups/ecommerce/projects/order-service/collections/order-api --env dev

# 运行工作流（DAG 场景）
apicc run-workflow groups/ecommerce/projects/order-service/workflows/checkout --env dev

# 压测接口（--case 与 --concurrency 必填）：并发 4、共 100 次迭代（也可用 --duration 按秒数施压）
apicc run-stress groups/ecommerce/projects/order-service/apis/create-order --case ok --concurrency 4 --iterations 100

# 导出接口设计（Markdown，供 AI 消费）
apicc export-design groups/ecommerce/projects/order-service/apis/create-order

# 导入外部定义（默认仅预览，--yes 确认写入；--group 必填）
apicc import order-api.json --group ecommerce
```

各命令完整参数以 `apicc <command> --help` 为准。

桌面端：

```bash
pnpm -C apps/desktop dev        # 开发模式（内部先构建再启动 Electron）
pnpm -C apps/desktop dist:dir   # 打包为本地目录（免安装运行）
```

## MCP 服务器（agent 接入）

`apicc mcp --workspace <工作区根>` 启动 stdio MCP 服务器，把工作区能力暴露为 MCP 工具，供 Claude Desktop、Cursor 等 agent 客户端消费：`list-apis`（接口摘要）与 `get-api-design`（接口详细设计 Markdown）默认可用，执行类工具 `run-case` 需显式加 `--allow-run`（执行类工具默认关闭）。构建、客户端 JSON 配置示例与安全边界见 [docs/mcp.md](docs/mcp.md)。

```bash
apicc mcp --workspace /path/to/your-workspace [--allow-run]
```

## 开发

```bash
pnpm -r test   # 各包测试（vitest）
pnpm -r build  # 全量构建
```

### 目录结构

| 目录 | 说明 |
|---|---|
| `packages/core` | 领域核心：数据模型、存储、执行引擎（集合/工作流/压测）、导入器、报告器 |
| `packages/cli` | 命令行工具（`apicc`） |
| `apps/desktop` | Electron 桌面端（设计器 UI、压测视图） |
| `server/` | 在线协作服务端（Spring Boot + H2），运行与配置见 `server/README.md` |
| `docs/` | 设计规格与实现计划 |

## CI

推送与 PR 会自动触发四 job 门禁：三包构建与测试（core 另行类型检查，覆盖测试文件）、服务端测试（JDK 21）、品牌中立扫描、（main 分支推送时）Windows 打包冒烟，见 `.github/workflows/ci.yml`。

## 许可证

[MIT](LICENSE)
