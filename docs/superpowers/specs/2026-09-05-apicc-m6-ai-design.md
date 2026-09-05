# apicc M6 设计规格：AI 能力（AI 生成测试用例 + MCP 工具形态）

日期：2026-09-05
状态：已批准（用户指示继续；M1 规格路线图 M6 = AI 生成测试用例、agent 导出增强（MCP 工具形态））
上游：M1 规格（§5.1 扩展点、§7.5 设计导出「人写设计、agent 实现代码」）、M5 交付的 protocol/runner 面

---

## 1. 背景与目标

M1 立项的差异化立场「接口详细设计可导出为 agent 可消费的格式——人写设计、agent 实现代码」目前是单向静态导出（export-design）。M6 打通双向：

1. **AI 生成测试用例**：基于接口定义（设计文档/URL/头/体/既有用例），经用户自备的 LLM API（OpenAI 兼容协议）生成候选测试用例，zod 严格校验后交用户审阅采用——AI 产出永不静默落盘。
2. **MCP 工具形态**：`apicc mcp` 起一个 stdio MCP 服务器，把工作区能力（检索接口/读设计/导出）暴露为工具，供 Claude Desktop、Cursor 等 agent 客户端直接消费；`run-case` 执行类工具默认关闭、显式 opt-in。

### 成功标准

用户在桌面端配置一次 AI 端点与密钥后，任意接口可一键获取候选用例列表、勾选采用；agent 客户端按 README 配置 MCP 后能检索并读取接口设计；`apicc ai suggest-cases` CLI 全流程可用。

### 非目标

多轮对话/聊天界面；非 OpenAI 兼容协议适配（Anthropic 原生协议等——provider 抽象留扩展点）；AI 自动执行/自动落盘（人审采用是硬边界）；gRPC/MQTT（M5 推迟项不变）。

---

## 2. 关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | Provider 抽象 | core 新 `src/ai/`：`AiProviderConfig { baseUrl, apiKey, model, timeoutMs? }` + `createAiProvider(config)`——OpenAI 兼容 chat completions（`POST {baseUrl}/chat/completions`，Bearer apiKey，`response_format: {type:"json_object"}`）；注入 fetch（测试替身），超时默认 60s |
| D2 | 密钥与配置边界 | **密钥永不落工作区**（git 文本文件优先）。CLI：env `APICC_AI_BASE_URL/API_KEY/MODEL` > 用户级 `~/.apicc/ai.json`；桌面：配置对话框（baseUrl/model 明文 localStorage，key 走 safeStorage——沿用 online token 模式）。core 只认显式传入的 config，配置解析归宿主 |
| D3 | Prompt 与解析 | 系统提示词内置（角色：API 测试工程师；输出 JSON 对象 `{"cases":[...]}`）；用户消息 = ApiDefinition 摘要（name/url/headers/body/design/既有 cases 清单）+ 可选用户指令。输出 zod 严格校验（TestCase 同构子集：name/scope/parameters/assertions/postScript，id 由本地补 ULID——不信任 AI 生成的 id）；校验失败 → 携 issues 一次修复重试 → 仍失败报错带原因 |
| D4 | 桌面接入 | 调试视图增「AI 建议用例」入口 → 建议列表（只读预览，标注来源为 AI 生成）→ 勾选采用才并入接口 cases（经既有保存链路落盘）；配置对话框独立（连接测试按钮） |
| D5 | MCP 服务器 | CLI 新命令 `apicc mcp --workspace <root> [--allow-run]`：stdio MCP 服务器（`@modelcontextprotocol/sdk`）。工具集：`list-apis`（id/name/protocol/url 摘要）、`get-api-design`（设计 Markdown）、`run-case`（**仅 `--allow-run` 时注册**，默认只读——AI 触发网络请求须显式开启） |
| D6 | MCP 实现约束 | stdio 传输、JSON-RPC 由 SDK 承接；工作区只读加载（fileStorage）；run-case 复用 CollectionRunner 单接口语义（与 sendDebug 同源）；日志走 stderr（stdout 是协议通道） |
| D7 | 测试纪律 | 全部 AI/MCP 测试用替身（fetch 替身/stdio 内存对测），**CI 零真实网络调用**；契约 fixture 从规格构造 |
| D8 | CLI 命令 | `apicc ai suggest-cases <apiPath> [--instruction "..."] [--limit n] [--out <file>]`——输出候选用例 YAML（供人工审阅后并入；不自动写回接口） |

---

## 3. 子项目划分（三轨并行）

### 轨 1 — M6-A AI 用例生成内核 + CLI（`packages/core` + `packages/cli`，分支 `feature/m6-ai`，worktree `apicc-m6-ai`）

T1 core ai 模块（provider/prompt/解析重试/ULID 补齐）+ 单测（fetch 替身、重试路径、校验负例）→ T2 CLI `ai suggest-cases`（配置解析 env/file、YAML 输出、错误面）+ e2e（替身 server 模拟 OpenAI 兼容端点）。基线：core 254 / cli 28。

### 轨 2 — M6-B MCP 服务器（`packages/cli` + `packages/core` 只读消费，分支 `feature/m6-mcp`，worktree `apicc-m6-mcp`）

T1 `apicc mcp` 命令 + SDK 接线 + 工具实现（list-apis/get-api-design/run-case opt-in）+ 测试（stdio 集成/工具单测/只读默认验证）→ T2 README（MCP 客户端配置示例）。基线：cli 28（与轨 1 同基线，**命令面不相交**——轨 1 加 `ai` 命令、轨 2 加 `mcp` 命令，main.ts 合并时手动调和）。

### 轨 3 — M6-C 桌面 AI 接入（`apps/desktop`，分支 `feature/m6-desktop`，worktree `apicc-m6-desktop`）

T1（fixture 先行，M5-B 先例）：AI 配置对话框 + 建议列表 UI + 采用流（契约 fixture 自建）→ T2（轨 1 合并后同步 main）：切 core 真 provider + sendDebug 式真调用集成 + 打包冒烟。基线：desktop 469。

### 冲突面分析

轨 1 与轨 2 都动 `packages/cli/src/main.ts`（不同命令段）与 pnpm-lock——**合并时后并者需手动调和 main.ts 与 lockfile**（控制者处理）。轨 3 只动 apps/desktop。core 面：轨 1 加 `src/ai/`；轨 2 仅可能加只读导出（预期零 core 改动）。

---

## 4. 明确推迟

Anthropic/其他原生协议 provider、多轮对话 UI、AI 生成接口定义（当前只生成用例）、MCP resources/prompts 形态（MVP 仅 tools）、自动执行/自动落盘、用量统计。

---

## 5. 验收

1. 三轨各自 TDD 闭环 + 终审 + 门禁绿。
2. 合并后 main：六面全绿（core/cli/desktop/admin-web/mvn/打包冒烟）+ CI 七 job 绿。
3. 演示路径：配置替身端点 → `apicc ai suggest-cases` 产出合法 YAML；MCP 客户端完成 list-apis/get-api-design 往返；桌面端采用一条 AI 建议用例成功落盘。
