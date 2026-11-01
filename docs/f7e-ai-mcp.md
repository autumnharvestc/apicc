# 个人 AI 辅助与受控 MCP

F7e 提供个人 AI 连接、模型和用途配置，以及本地/获授权在线项目的 stdio MCP。AI 生成候选与报告解读；采用、保存和执行仍是独立动作。桌面与 MCP 复用 Core 和现有成员准备/提交权威。

2026-11-01，T1–T12 开发、审核、真实合成联验和 Windows 目录包验收已完成；具体源码身份、全量与最小补验的区别、交付包及验证限制见[阶段最终回执](superpowers/plans/2026-10-30-apicc-f7e-ai-mcp.md#阶段最终回执2026-11-01)。未使用真实项目或付费模型。Git 提交、合并、推送尚未获授权。

## 从桌面开始

主页和项目顶栏的设置入口打开同一个个人 AI 设置。依次建立连接、模型配置，再绑定“建议用例”“建议断言”“报告分析”用途。设置保存不会请求模型；模型发现、连接测试均须主动触发，可以取消。模板更新只填入连接草稿，确认保存后才影响连接。

业务入口先显示固定来源、目标连接/模型、外发范围、预算及省略项；确认后才发送。默认不发送请求/响应正文，按已有位置显式选择正文后重新预览。启发式脱敏不能保证发现所有自定义秘密，发送前仍须人工检查。

功能报告的准确用例行可“选为断言观测依据”，再在同一已保存用例的断言区明确选择“接口契约”或“已有观测”。缺少完整用例定位/作用域的行不可选；不按名称猜对应关系，也不会为取得观测执行请求。观察503等失败响应不自动成为契约允许值，观察建议仍需人工判断。

外发抽屉先取得不含证据值/正文的安全选择目录，即使完整输入超出预算也可缩小选择。目录分页默认20、单页最多50项，证据最多1000项、正文位置最多200项；显示真实总计、可选择数量及目录省略，原报告不会被删减。大报告可先“清空证据选择”，再勾选所需的真实证据。修改勾选立即使旧外发预览失效；正文改动会换选择身份并清空原证据勾选，须重新选择证据、点击“重新预览”，检查最终范围后另行确认外发。不会自动增预算、截短证据或恢复未选正文。

候选默认不选中。展开检查参数、断言的目标/选择器/操作符/期望及完整前后置脚本；脚本带受信风险提示。显式采用只追加所选候选并标记草稿有修改，不自动保存或运行，也不修改原用例的期望值。切换来源、账号、连接或编辑代次后，旧预览不能继续写入新来源。

报告分析区分别展示程序事实、可能原因、核查步骤、证据定位及限制。逻辑结果与请求总体分开；缺失、不可计算、不可比不会补零或伪造趋势。分析只在当前会话，导出的是标注 AI、模型、来源与时间的独立副本，原报告及其判定保持原样。

## 协议与供应商模板

连接地址是 API 根地址（例如 `https://example.test/v1`），不能含用户信息、query 或 fragment。生产使用 HTTPS、拒绝重定向；只有显式 `insecureLocalTest` 的回环测试允许 HTTP，无鉴权同样仅限该测试范围。

| 协议 | 根地址后追加路径 | 结构化输出 |
| --- | --- | --- |
| `openai-chat-completions` | `/chat/completions` | `json-schema`、`json-object`、`prompt-json` |
| `openai-responses` | `/responses` | 同上；请求 `store:false` |
| `anthropic-messages` | `/messages` | `json-schema`、`prompt-json`；不支持 `json-object` |

三种协议支持纯文本非流式和 SSE 流式响应，不提供工具调用/任意 Shell、多模态、模型端自动执行或后端 AI 网关。OpenAI 兼容发现使用 `/models`；模型发现列表不等于能力已经确认，用户仍需声明并确认上下文和独立输入/输出上限。同协议自定义供应商不需要增加 provider 实现。

内置模板在 `packages/core/src/ai/providers.v1.json`，实际分发位于 Core 的 `dist/ai/providers.v1.json`。个人覆盖文件置于私有 AI 根的 `providers.d/<basename>.json`。桌面支持选文件→预览差异→显式应用；冲突须确认，错误文件不替换上次有效目录。模板引用不会自动重写已有连接或模型。

最小导入文件如下（模板 JSON 是编辑对象，不是统计/状态主视图）：

```json
{
  "formatVersion": 1,
  "providers": [{
    "id": "my-compatible-provider", "formatVersion": 1, "revision": 1,
    "name": "My provider", "baseUrl": "https://example.test/v1",
    "protocols": ["openai-responses"], "defaultProtocol": "openai-responses",
    "auth": { "kind": "bearer" }, "headers": {}, "modelDiscovery": true
  }]
}
```

模板、静态请求头及项目资产都不能存放 API key。`api-key` 鉴权使用单独秘密头（例如 `x-api-key`），不能把同名秘密值放入 `headers`。连接 ID、规范化地址及鉴权种类/秘密头名共同绑定秘密受众；修改地址不会携带旧 key 到新地址。

## 配置归属、继承与预算

桌面配置保存在当前设备个人 AI 根，CLI 为 `~/.apicc/ai/config.v1.json`，模板覆盖在同根 `providers.d/`。它们不随项目或在线资产同步。CLI 与桌面不互读秘密。桌面用 Electron 安全存储，CLI 用操作系统 keyring；不可用时拒绝持久秘密，只有用户明确选择的会话秘密才留在内存，没有隐式明文回退。

模型 profile 绑定一个连接、一个模型 ID、协议、输出模式、流式设置、能力和使用预算。能力是模型最大容量；预算是本次用途允许消耗的额度，两者含义不同。能力未确认时不能通过扩大使用预算绕过保护。输入 token 估算不等于供应商精确计费。

有效预算按应用用途默认→模型通用→该模型用途→个人用途绑定→个人项目用途覆盖→本次调用覆盖解析，最后受应用保护和确认的模型能力约束。来源随有效值显示；纯继承应用默认可以受模型上限收窄，显式超限声明则报错。项目覆盖只在个人私有配置，不改变团队项目。

| 预算 | 用例 / 断言 / 报告默认 | 单位 |
| --- | --- | --- |
| 总期限 `deadlineMs` | 600000 / 300000 / 900000 | ms，含等待、重试和修复 |
| 单请求 `requestTimeoutMs` | 300000 | ms，仍受剩余总期限约束 |
| 请求/传输重试/结构修复 | 3 / 1 / 1 | 次；总请求额度统一计数 |
| 单请求输出 `maxOutputTokens` | 16384 / 8192 / 16384 | token |
| 累计输出 `totalOutputTokens` | 49152 / 24576 / 49152 | token，独立预算，不随请求数重算 |
| 输入/补充指令/输出 | 256 KiB / 8 KiB / 4 MiB | bytes；1 KiB=1024 bytes |
| 候选 `candidateCount` | 5 / 10 / 5 | 条；报告主要受证据数量限制 |
| 证据 `evidenceCount` | 20 | 条 |
| SSE 单事件/累计流 | 256 KiB / 64 MiB | bytes |

确认的推理模型新建时可初始化单请求输出 32768、累计 98304 token；编辑不会重置已有预算。应用保护默认单请求输出 262144 token，输入 4 MiB、指令 64 KiB、输出 32 MiB、事件 4 MiB、流 512 MiB；宿主并发 1、队列 8、载荷缓冲 64 MiB。连接测试默认 30000 ms、发现 15000 ms，走同一受限宿主。预算保存后影响后续准备，已经确认的操作不会静默切换配置。

## CLI

构建入口在 `packages/cli`，Node ≥22.19.0；仓库固定包管理器版本见 `packageManager`。以下以构建后的 `apicc` 为例，也可用 `node <repo>/packages/cli/dist/bin.js`。精确可用参数可用各子命令 `--help` 查看。

```bash
apicc ai config templates
apicc ai config connection personal --template openai --name Personal
apicc ai config model general --connection personal --model YOUR_MODEL --protocol openai-responses --output-mode json-schema
apicc ai config credential personal --secret-stdin
apicc ai config bind case-suggestion general
apicc ai config bind assertion-suggestion general
apicc ai config bind report-analysis general
apicc ai config show

# 在工作区内：第一次只预览，第二次显式发送；不采用、不保存、不执行
apicc ai suggest-cases groups/G/projects/P/collections/C/apis/A --model-profile general
apicc ai suggest-cases groups/G/projects/P/collections/C/apis/A --model-profile general --confirm-send
apicc ai suggest-assertions groups/G/projects/P/collections/C/apis/A --case CASE --scope base --confirm-send
apicc ai reports groups/G/projects/P
apicc ai suggest-assertions groups/G/projects/P/collections/C/apis/A --case CASE --scope base --basis observation --report OPAQUE_REPORT_ID --case-index 0
apicc ai analyze-report groups/G/projects/P --report OPAQUE_REPORT_ID --confirm-send
```

秘密输入仅接受环境变量名 `--secret-env NAME` 或受控 `--secret-stdin`，不接受 key argv。业务命令的临时秘密须同时指定 `--session-only`；它不跨 CLI 进程持久化。`--model-profile` 是 AI 模型选择，`--online-profile` 是独立成员来源，不能混用。显式模型优先于完整旧环境 trio，继而是项目/个人用途绑定，最后才读取旧文件；部分旧环境配置报错，不静默退回其他来源。旧环境变量为 `APICC_AI_BASE_URL`、`APICC_AI_API_KEY`、`APICC_AI_MODEL`。

`--include-body ID` 只选择已经授权投影的正文位置，`--evidence ID` 缩小报告证据后重新预览。`--out` 导出独立候选文件，不能写回源工作区；覆盖须 `--overwrite`。在线建议/报告同样加 `--online-profile ID`，并保持发送确认。列举或读取历史失败不会启动重跑。

断言默认 `--basis contract`；观察依据须同时明确 `--basis observation --report ID --case-index N`（N从0开始），且报告行或正式执行身份能证明完整同一用例定位和scope。CLI在完整输入预算检查前列出安全证据ID及默认关闭的正文位置，只提供前1000项证据、200个可用正文位置，超出目录会如实提示省略。只在这些实际位置/ID中选择，改正文后重新查看新证据ID；显式缩小后再次运行命令预览，再加 `--confirm-send` 发送，不会自动截断或增加配置预算。

## MCP：默认只读，显式准备和启动

```bash
apicc mcp --workspace /absolute/workspace
apicc mcp --workspace /absolute/workspace --allow-run --local-profile no-script
# 成员登录须独立进行，不占 MCP 的 stdin，不把密码置于 argv
apicc mcp-profile login member --server https://server.example --username NAME --workspace W --group G --project P --password-stdin
apicc mcp --online-profile member
apicc mcp --online-profile member --allow-run
apicc mcp-profile logout member
```

本地 `--workspace` 与在线 `--online-profile` 互斥。在线 profile 固定 HTTPS 服务、成员和项目 allowlist，每次工具/页面/启动重新鉴权；失效要求重新登录，不自动换身份。默认使用 OS keyring；`--token-env NAME` 可明确改用进程环境 token，密码始终不保存，不能读取 Electron token 或用户其他 profile。

只读工具是 `list-assets`、`get-asset`、`list-runs`、`get-run`、`get-report`；旧本地 `list-apis`、`get-api-design` 保留兼容。分页 `limit` 默认 50、范围 1–200，cursor 是固定来源签发的不透明值；来源或版本变化后从首页重读。报告 run ID 是列举得到的不透明选择，不是任意路径。默认省略脚本、正文、数据行和秘密；安全证据与完整请求事实分别标识。单次输出默认 131072 bytes，可设 `--max-output-bytes`（4096–1048576）；超过预算需分页或缩小选择。

`--allow-run` 才注册 `prepare-run`、`start-run`、`cancel-run`；旧本地 `run-case` 只在此模式兼容。建议在外部 MCP 客户端为 start/cancel 等副作用启用人工确认。`--allow-run` 是操作人给予该进程的执行许可；ticket 是准备结果的拥有引用，既不是人工确认，也不是认证秘密，不能替代服务端权限或脚本批准。

准备仅接受当前固定来源已保存的 case/suite/workflow，显式选择本机或 agent，固定快照、材料、版本、脚本计划和预算，不发送业务请求。模型不能提供任意 URL、自由正文、秘密、提权档位或压测启动。`start-run` 使用原 `ticketId` 和稳定 `intentId`；同意图重入返回原运行，接纳并不代表完成或成功。用 `get-run/get-report` 读取状态与报告，明确取消才调用 `cancel-run`。

提交响应丢失时结果不确定：保留原票据和 intent，查询原意图/历史，不换 intent 重提。重开进程后的回执仅供原任务对账，不能创造新的准备或提交；无完整输入校验证据会标出 `fixed-input-binding-unverified`。资产变化也不把原任务重跑。权限撤销、脚本批准不足或材料变化会拒绝准备/启动，不静默换 agent 或回退本机。

在线已接纳的 agent 任务在桌面/MCP 退出后继续，除非明确取消或服务端自身策略终止。读取请求取消只停止读取。本地拥有任务则在 MCP stdin EOF 时取消并收束，不承诺跨进程继续；本地终态结果和在线防重 journal 都有独立数量/字节上限。

## 旧配置迁移和边界

旧 CLI `~/.apicc/ai.json` 可用 `apicc ai config migrate-legacy --confirm-address ORIGINAL_API_ROOT` 迁移；桌面通过原生确认展示完整旧地址，默认取消。确认当前原始地址后宿主才读取旧 key；回环 HTTP 迁移另须明确本次本地测试选择。迁移保留 Chat Completions 协议和原用途，缺 key/安全存储不可用时保留非敏感配置并要求补齐，不改写或删除原明文文件。重复迁移不重读旧 key，renderer 不能自行授予迁移权威。

本期不含团队共享 AI、后端统一代调用、无人值守分析、AI-FUTURE-001–005、调度/到达率 B、F7b 三项遗留或 DEF-001。MCP 可读压测报告不代表可以启动压测。node:vm 与同账号子进程也不是操作系统强隔离。具体设计见 [F7e R1](superpowers/specs/2026-10-30-apicc-f7e-ai-mcp-design.md)，实施/验收状态见 [阶段计划](superpowers/plans/2026-10-30-apicc-f7e-ai-mcp.md)。

## 合成联验入口

`scripts/f7e-acceptance.mjs` 只编排显式证据子目录：`snapshot` 记录源码/真实 HEAD/index 摘要；`ai-serve` 启动本机三协议替身直到显式停止；`prepare-profile` 用 Core 创建新隔离配置和合成工作区；`ai-check` 通过真实 Core host 校验六种协议/流式组合，`probe-check` 校验三协议极小连接探测。命令都要求显式传入仓库内证据子目录，输出文件/新 profile 拒绝覆盖；不会自动构建、打开窗口、读取用户 profile 或删证据。

真实 Java/agent/stdio 联验复用公共测试夹具，仅在显式合成环境下运行，最终报告逐 E1–E8 区分任务证据、真实可见验收、全量门禁与包。替身成功不能证明付费供应商实际兼容，也不能代替原生布局/秘密存储验证。
