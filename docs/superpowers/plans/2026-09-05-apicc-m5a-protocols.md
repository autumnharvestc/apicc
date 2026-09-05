# apicc M5-A 协议内核（core + CLI）实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** WebSocket 与 SOAP 作为 ProtocolClient 插件全链路落地：域 schema 演进（protocol 字段零破坏）、按协议显式分发、WS 客户端（握手/发帧/收帧映射到 ExecutionResponse）、SOAP 客户端（复用 httpClient）、xpath 断言操作符、多协议混合集合端到端。

**工作目录：** `D:\workspace260609\project-2\apicc-m5-protocols`（worktree，分支 `feature/m5-protocols`）。**基线：core 203 / cli 26 全绿（main @ 25f5e74）。**

**环境注意：** 新依赖 `ws`（dependencies）+ `@types/ws`（dev）+ `@xmldom/xmldom` + `xpath`（dependencies）入 packages/core；安装走既有 worktree pnpm install。

**全局约束：** 品牌中立；中文 conventional commit（`feat(core): ...`）；显式路径 git add；门禁 = core 全量 + cli 全量 + typecheck；旧 yaml 零破坏（无 protocol 字段 = http，既有 203 测试不许改断言）；契约 fixture 以 M5 规格 `docs/superpowers/specs/2026-09-05-apicc-m5-multi-protocol-design.md`（D2/D3/D5/D6）为唯一事实。

---

## 文件结构

```
packages/core/src/domain/model.ts        ← protocol 字段 + superRefine（ws/soap 约束）
packages/core/src/protocol/websocket.ts  ← 新：WS 客户端（ws 包）
packages/core/src/protocol/soap.ts       ← 新：SOAP 客户端（复用 httpClient）
packages/core/src/protocol/index.ts      ← 新：按 protocol 显式分发的 canHandle/注册助手
packages/core/src/assert/operators.ts    ← 改：xpath 操作符（或既有操作符所在文件）
packages/core/src/index.ts               ← 导出核对
packages/core/tests/protocol/*.test.ts   ← 新
packages/cli/...                         ← 集成核验（理论上零改动——runner 经 registry；如需改动报告注明）
```

---

### 任务 1：域 schema 演进 + WS 客户端

- [ ] **步骤 1：失败的测试**
  1. schema：无 protocol 的旧 yaml 形状 parse 后 protocol==="http"（默认值）；protocol:"websocket" + message 模板合法；protocol:"soap" 无 envelope → 拒绝；soap method 非 POST → 拒绝；websocket 显式 method 非法值仍受 HttpMethod 枚举约束；未知 protocol:"grpc" → 拒绝（M5 未含，枚举拒绝即 fail-fast）。
  2. WS 客户端（注入本地 ws server 夹具）：握手成功 → ExecutionResponse{status:101, headers=握手响应头, bodyText=首帧文本, timeMs≥0}；带 message 模板 → 服务端收到帧内容（变量已解析）；不发送 message → 仅连接即正常关闭，bodyText 为空且不等待；总超时内未收到帧 → 执行错误（错误信息含 "websocket"）；非文本帧（二进制）→ 忽略继续等文本帧或按错误处理（实现者定，报告注明口径）；服务端拒绝（URL 错误）→ 执行错误非悬挂。
  3. 分发：protocol:"websocket" 的请求由 WS 客户端承接、http 客户端不再接（canHandle 按 protocol 显式匹配）；未知协议 → 明确错误。
- [ ] **步骤 2：实现**——model.ts 字段与 superRefine（注意 method 在 websocket 下可选化：superRefine 或 default 处理，保持旧形状兼容）；protocol/websocket.ts（ws 包，AbortSignal/超时对接 HttpExecuteOptions：连接超时=connectTimeoutMs，收帧等待=totalTimeoutMs）；protocol/index.ts 分发助手 + registry 接线核对（createDefaultRegistry 注册 wsClient/soapClient，任务 2 补 soap）。
- [ ] **步骤 3：全量回归 + Commit** `feat(core): 协议字段演进与 WebSocket 客户端`

### 任务 2：SOAP 客户端 + xpath 断言

- [ ] **步骤 1：失败的测试**
  1. SOAP 客户端（本地 http server 夹具）：envelope 模板变量解析后作为 XML body POST；`Content-Type: text/xml; charset=utf-8`；soapAction → `SOAPAction` 头（无则不带）；响应 status/bodyText/headers/timeMs 透传映射；端点错误（非 2xx）→ 正常响应（HTTP 语义，非执行错误——SOAP fault 是合法响应，断言层处理）。
  2. xpath 操作符：`xpath(actual, "//User/id[==42]")` → 提取并比较相等；仅表达式（无期望值）→ 存在性断言；多节点取首个（口径注明）；XML 解析失败 → 断言失败带原因；表达式语法错误 → 断言失败带原因；非字符串 actual（undefined）→ 失败不抛。
  3. 分发：protocol:"soap" 由 soap 客户端承接。
- [ ] **步骤 2：实现**——protocol/soap.ts（变量解析后的 envelope 作为 BodyContent 注入，经既有 httpClient——复用其超时/错误分类）；xpath 操作符注册进默认 registry（`@xmldom/xmldom` + `xpath`）。
- [ ] **步骤 3：全量回归 + Commit** `feat(core): SOAP 客户端与 xpath 断言操作符`

### 任务 3：全链路集成（debug/集合/工作流/CLI）

- [ ] **步骤 1：失败的测试**
  1. debug send：WS 接口走 sendDebug 语义（合成单接口集合经 CollectionRunner）→ outcome 断言/变量提取照常（pm.response.text()=首帧）。
  2. 集合运行：混合集合（HTTP + WS + SOAP 各一用例）`CollectionRunner` 全过，RunResult 混合协议结果形状一致。
  3. 工作流：WS 节点输出（首帧 JSON 时）可被后续 HTTP 节点经 prev 引用（条件边链一例）。
  4. CLI e2e：`apicc run` 混合集合本地 ws+http server 夹具全过；`apicc run-stress` 对 SOAP 接口照常（并发池复用 execute）。
  5. 导出（export-design）对 ws/soap 接口不崩（设计文档渲染含协议信息——最小适配，报告注明）。
- [ ] **步骤 2：实现**——预计 runner/CLI 零改动（D5 分发使然）；如需小改（如 ws 接口 debug 的合成集合组装）按实际落点。
- [ ] **步骤 3：core+cli 全量 + Commit** `test(core): 多协议混合集合全链路集成`

---

## 规格覆盖对照

| 规格（m5 spec §2） | 任务 |
|---|---|
| D2 schema 演进（零破坏） | 1 |
| D3 WS 响应映射 | 1 |
| D4/D5 分发与依赖 | 1、2 |
| SOAP + D6 xpath | 2 |
| D7 变量解析 | 1、2 |
| D9 压测/工作流零专项 | 3 |

**明确推迟**：gRPC、MQTT（规格 §4）；WSDL 导入；WS 二进制帧高级处理；SOAP 1.2 Content-Type 细分（MVP 固定 text/xml 1.1 口径，报告注明）。
