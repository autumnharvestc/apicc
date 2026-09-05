# apicc M5 设计规格：多协议（协议即插件——WebSocket 与 SOAP 全链路）

日期：2026-09-05
状态：已批准（用户指示继续；M1 规格路线图 M5 = gRPC/WS/MQTT/SOAP 作为 ProtocolClient 插件）
上游：`2026-09-01-apicc-m1-local-core-design.md`（§5.1 ProtocolClient 扩展点、§7.1 调试流）、M2 执行引擎语义（runner/工作流/压测复用同一 execute 面）

---

## 1. 背景与目标

当前全平台仅 HTTP。M5 把「协议即插件」从接口形态落地为真实能力：API 定义可声明 `protocol`，执行引擎按协议选择客户端，调试/集合/工作流/CLI 全链路无差别工作。**本阶段交付 WebSocket 与 SOAP 两个协议的全链路**；gRPC 与 MQTT 显式推迟（见 §4）。

### 成功标准

用户在桌面端新建 WebSocket 接口（ws(s):// URL + 可选消息模板）调试发送，收到首个文本帧作为响应体、握手状态作为 status，断言/变量提取照常工作；SOAP 接口填 XML 信封模板，POST 到端点，响应可用新增 `xpath` 断言操作符；`apicc run` 集合运行对多协议混合集合无差别工作。

### 非目标

gRPC、MQTT（推迟，见 §4）；WSDL 自动导入；压测对 WS/SOAP 的专项优化（压测面复用 execute，不做专项）；Mock 服务；桌面端协议级高级配置（子协议、每消息超时等进阶项）。

---

## 2. 关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 范围 | **WebSocket + SOAP 全链路**；gRPC/MQTT 推迟。理由：gRPC 需 proto 加载工具链（@grpc/grpc-js + proto-loader）与 proto 文件管理面，MQTT 需 broker 测试设施——两者体量各堪比一个完整协议阶段；先以两协议把协议插件架构、schema 演进、全链路集成做扎实，后续协议按同一模式复制 |
| D2 | schema 演进 | `ApiDefinitionSchema` 增 `protocol: z.enum(["http","websocket","soap"]).default("http")`；WS 增可选 `message`（连接后发送的文本帧模板，缺省仅连接）；SOAP 增必填 `envelope`（XML 模板）与可选 `soapAction`。superRefine：websocket → method 缺省 GET 不参与执行；soap → method 固定 POST、必须显式 POST。**旧 yaml 零破坏**（无 protocol = http，既有测试全绿） |
| D3 | 响应映射契约（跨协议统一） | 复用 `ExecutionResponse`：**WS**——status=握手 HTTP 状态（101 成功）、bodyText=连接后收到的首个文本帧（发送 message 后等待，总超时内未收到 → 执行错误）、headers=握手响应头、timeMs=连接+发送+接收总时长；**SOAP**——透传 HTTP 语义（status/bodyText/headers/timeMs）。效果：PmApi.response.text()/json()、断言操作符、变量提取、ResponseViewer 对新协议零特殊分支 |
| D4 | 客户端选型 | WS：`ws` npm 包（dependencies，@types/ws devDep）；SOAP：复用既有 httpClient（信封经变量解析后作为 XML body，`Content-Type: text/xml`，soapAction → `SOAPAction` 头）零新依赖；xpath 断言：`@xmldom/xmldom` + `xpath` 两小依赖入 core |
| D5 | canHandle 语义 | registry 选客户端从「URL 嗅探」改为**按 protocol 字段显式分发**：http→httpClient、websocket→wsClient、soap→soapClient；未知 protocol → 执行错误（fail-fast）。旧 HTTP 路径行为不变 |
| D6 | xpath 断言操作符 | 新内置 AssertOperator：`xpath`——actual=XML 文本，expected=`表达式[==期望值]` 或仅表达式（存在性）；依托 @xmldom/xmldom 解析，解析失败 → 断言失败带原因 |
| D7 | 变量解析 | WS message 与 SOAP envelope 均走既有变量解析管线（环境/集合/项目/全局/动态变量同 HTTP body） |
| D8 | 桌面端适配 | RequestEditor 协议选择（http/websocket/soap）→ 按协议显隐字段（WS 隐藏 query/body 显 message；SOAP 显 envelope/soapAction）；ResponseViewer 零变更（D3 保证语义统一）；保存链路经 core schema 校验零 IPC 变更 |
| D9 | 压测/工作流 | 零专项改动：StressRunner/CollectionRunner/WorkflowRunner 均经 client.execute——SOAP 天然可压测；WS 可执行但每采样建连成本高（文档注明，不禁止） |

---

## 3. 子项目划分（两轨，B 先按规格契约并行开发、A 合并后中段同步）

### 轨 1 — M5-A 协议内核（`packages/core` + `packages/cli`，分支 `feature/m5-protocols`，worktree `apicc-m5-protocols`）

T1 域 schema 演进 + 协议分发（canHandle 按 protocol）+ WS 客户端（ws 依赖；本地 ws server 夹具测试：握手/发帧收帧/超时/非文本帧）→ T2 SOAP 客户端（信封模板/soapAction/复用 httpClient）+ xpath 断言操作符（@xmldom/xmldom + xpath；正负用例）→ T3 全链路集成：debug/集合/工作流/CLI 对多协议混合集合端到端（本地 ws+http server 夹具）+ 导出核对。基线：core 203 / cli 26。

### 轨 2 — M5-B 桌面端协议适配（`apps/desktop`，分支 `feature/m5-desktop`，worktree `apicc-m5-desktop`）

T1 RequestEditor 协议选择与字段显隐 + ResponseViewer 映射核验（对规格 D2/D3 契约 fixture 开发，先于 A 合并）→ T2 A 合并后同步 main：保存链路经新 schema 校验集成 + 组件测试 + 打包冒烟。基线：desktop 450。

### 冲突面分析

轨 1 只动 packages/core+cli；轨 2 只动 apps/desktop。轨 2 T1 以规格契约 fixture 开发（M3-B 先例），T2 中段同步 main 后做真集成——A 先合并。

---

## 4. 明确推迟（M5+ 后续阶段，均有归属）

- **gRPC**：proto 文件加载与消息编解码（@grpc/grpc-js + @grpc/proto-loader）、proto 文件工作区管理约定、unary 调用映射（status=grpc-status、bodyText=响应消息 JSON）。
- **MQTT**：broker 测试设施（进程内 Aedes 或 testcontainers）、QoS 语义、订阅/发布映射。
- 两者按 D1 的「协议即插件」模式复制：schema 增枚举值 + 客户端注册 + 响应映射契约即可接入。

---

## 5. 验收

1. 两轨各自 TDD 闭环 + 终审 + 门禁绿（轨 1：core+cli 全量；轨 2：desktop 门禁 + 打包冒烟）。
2. 合并后 main：core/cli/desktop/admin-web 四包 + mvn 全绿 + 打包冒烟过 + CI 五 job 绿（admin-web 已纳入）。
3. 演示路径：混合集合（HTTP + WS + SOAP 各一用例）`apicc run` 全过；桌面端分别调试 WS 与 SOAP 接口成功。
