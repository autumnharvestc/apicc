# F7e AI 与 MCP 整阶段实施计划

> 2026-11-01 最新状态：F7e 的 T1–T12 开发、审核、联验、目录包及归档已完成，见[阶段最终回执](#阶段最终回执2026-11-01)。最终三处追加修复经原审查者定向复核，N1/I6/M7 全部关闭；产品树 `428bcbe7254501235bb6ba955aa48d6a178cf507`，目录包构建、275 个运行资源核对、真实启动冒烟及三处新包可见验收通过。此前完整全量为基线 `226343ce…` 的 5929 通过、14 条条件跳过；428 仅重验受影响部分，不冒称重新全仓通过。用户本次即时批准丢弃合成内存草稿后，测试窗口于北京时间14:01:26正常退出，保存的用例/报告/日志保留。当前未提交、合并或推送。使用入口：[个人 AI 与 MCP 使用说明](../../f7e-ai-mcp.md)、`scripts/f7e-acceptance.mjs`。下方早期状态保留为历史，实际证据以本计划专属 SDD 账本及验收映射为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. 开发沿用 GPT-6.1 Sol high，独立审核 GPT-6.1 Sol xhigh；升级 Sol max 先申请。每个任务一名实现者串行推进，审核与实现分离；不得派生重复审核者。

**Goal:** 完成个人分层 AI 配置、三协议人工辅助和本地/在线受控 MCP，复用现有 Core 与成员执行权威，提供可验证的客户端和 CLI 交付。

**Architecture:** Core 负责纯配置、有效预算、安全投影、协议与业务校验，宿主负责身份、秘密、持久化与生命周期。成员执行编排从桌面抽到 execution/client；桌面和 MCP 使用同一准备/启动与状态通路。AI 只产生候选或解读，执行由显式、默认关闭的 MCP 工具沿既有执行权威完成。

**Tech Stack:** TypeScript、Zod 4、现有 fetch/ReadableStream、Vue 3、Electron、MCP SDK 1.x、Vitest、现有 Spring Boot/Java 21 与 Maven wrapper；不为本阶段升级无关依赖。

**Spec:** [F7e R1 设计](../specs/2026-10-30-apicc-f7e-ai-mcp-design.md)，特别是 §4.5 的模型独立能力/使用预算与 §5.2 的精确默认和范围；[页面展示规范](../../ui-presentation-guidelines.md)。

日期：2026-10-30。基线 `1330a81071769458e0461764aef40d9a7970ab6d`，工作树 `codex/f7e-ai-mcp-design`。用户目标为“可以，完成 F7e 阶段”；现已集中确认“确认计划，按原模型配置开始实施”，按本计划连续推进。提交、合并、推送仍另行授权。

执行状态（2026-10-31）：用户已请求继续，暂停解除。T1–T10 已完成任务独审及必要定向复审，已登记 Minor 留最终宽审。T9 桌面安全宿主最终已审树为 `156f17aa53f04cb52d65cb0b9d5a35125d2546bf`；T10 个人设置表单在修正预算跨模型误校验、绑定模型回填及模板迟到回复后关闭，最终已审树为 `38ff0d48e66ae960dc89c93059220e7a375e1e43`，受影响两文件 68 项通过、桌面构建通过。各次限定测试分别保留，不拼成整仓或整阶段通过。T10 安全存储不可用时拒绝持久密钥分支的顺序偏差已获用户限定接受，其后验验证不改称历史先红；其他偏差、校准失败和早期部分快照限制均保留。剩余新保护先核对实际失败再实现；接下来执行 T11 业务辅助页面，T12 集中真实联验、整分支审查、全量及打包尚未交付。精确源码/日志见本计划专属 SDD 账本，不重做已完成任务，尚未提交、合并或推送。

## Global Constraints

- AI 配置分为供应商模板、连接实例、模型配置和用途绑定。模板预置默认 Base URL 及支持协议，可按配置增加，不把厂商列表写死；支持自定义供应商。
- 协议明确支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses，不以改 URL 代替协议适配。
- 预算优先级为：本次显式值 > 当前用途/个人项目覆盖 > 模型对应默认值 > 应用用途默认值。模型能力不是这个覆盖链的一环，而是最后必须满足的约束；应用资源保护也独立校验。
- 对纯继承的应用默认值，可按已确认模型能力派生较小的有效默认，并显示“继承应用默认，受模型限制”；用户显式填写的超限值不能这样静默裁剪。
- 首版支持三协议的流式传输，但业务结果在完整接收、终态及严格校验成功后一次性交付；不把半段 JSON 当可采用候选。
- 新连接秘密使用宿主安全存储。不可用时仅允许显式会话内使用或拒绝持久保存，不自动落明文；CLI 支持秘密环境变量/标准输入或 OS 安全存储，不新增 key 命令行参数。
- 采用只把所选新内容追加到原目标的编辑草稿，标 dirty，保存仍走已有版本/权限校验。新建议不能替换已有用例、改既有 ID、删除断言或自动触发执行。
- 本期只装配个人配置解析与本地调用宿主。连接记录显式个人归属，接口允许以后解析其他归属，但不注册未实现的 team/backend 模式、不放不可工作的切换控件。
- 单用例目标映射到已有 `TaskTarget.kind=debug`、`DebugInvocation.mode=case`，使用完整 case locator/scope；不新增另一种服务端 case Runner。
- 在线已接纳的代理任务不依赖 MCP/桌面继续存在；断开默认不取消。明确 `cancel-run` 走现有取消权限/通路；取消一个状态读取请求不等于取消业务任务。
- 配置、状态、统计、比较、节点、生命周期和运行轨迹，应按业务含义使用摘要、字段表、列表、可展开详情或时间线。不能把 `JSON.stringify`、对象调试输出、整段 `<pre>` 或 JSON 单元格作为主要页面的交付形式。
- 不恢复 DEF-001，不提前实施 F7f/F7g，不把 F7b 的三项遗留带进本阶段。
- 使用当前隔离工作树；不删除已有证据。任务交接采用可校验 diff/原始树快照而非擅自 commit；根全量在最终候选统一安排一次，限制并发，不以加超时或删测试换通过。

## Review Focus

1. 小输出模型继承大默认、另一个大窗口模型手动覆盖：前者显示受模型限制，后者不受前者影响；显式超限拒绝，修改请求次数不扩总 Token 预算。由 T1/T10 固定行为。
2. 模型返回完整 JSON 后继续无限心跳、错误或 EOF：必须等正确终态，期限/流量/缓冲全程生效，取消不交付迟到结果。由 T2 固定行为。
3. 同名项目、切账号/地址、旧草稿和报告清理：不能把内容、凭据或结果错用到新来源；已有报告不可读不自动重跑。由 T3/T4/T7/T9/T11 固定行为。
4. POST 已被服务器接纳但响应丢失，重开 MCP 时资产又变更：先对账原 intent 返回原任务，不因新版本错误提示重新执行。由 T6/T8 固定行为。
5. Unicode 长名称、长 Schema、脚本候选及密钥存储不可用：字段可读且有单位/来源，脚本完整可查但非自动执行，无明文持久降级。由 T4/T10/T11/T12 固定行为。

## 执行、接口和证据约定

阶段按 T1→T12 连续推进，不逐任务请求批准。实质范围、安全边界、新权限或必要外部材料变化才集中提出。开发任务不互相并行修改；只读审核在实现完成后派发。每个任务记录实际 RED/GREEN 命令、退出码、失败原因和代码快照，任务独审同时给规格/质量结论。

新模块首次缺失、导入/编译错误不计有效 RED。先写测试；必要时仅建立不含业务分支的可加载接口骨架，再观察目标行为断言失败，之后才实现相应行为。不能先完成算法再用撤回变异补称先红。修复仍先复现；顺序偏差如实记录，不援引旧阶段例外自动豁免。

每批私有源码快照须基于前序已核实完整基线，累计本任务此前全部新增/修改的产品与测试文件，新增文件同步清单；只取当批子集生成的树不能称完整当时源码。部分记录或事后推导必须明示覆盖限制，不能用后来的文件/编译产物补造历史。最终候选另冻结完整累计源码，按依赖顺序构建并绑定实际验证日志。

任务开始前控制者完成共享文件/接口和任务内部一致性预检，生成任务专用简报与账本。下列新增名称为交接合同：任务可拆内部文件，不得静默改导出名/签名；确需改变时先记裁决并同步消费者。类型由所属任务在指定模块导出，`@apicc/core` 的纯类型/schema 可经 `shared.ts`/`schema.ts` 暴露，Node 文件/秘密宿主不得进入 browser 导出。

Node 精确 `22.19.0`、pnpm 精确 `11.21.0`、Java 21 沿现有最终门禁。未安装依赖时只在当前工作树执行冻结锁安装，不更新锁来绕过环境故障。任务命令使用现有包目录，不存在根 package.json。依赖包的 dist 在首次下游消费及接口变化后按 plugin-sdk→core→execution 构建；审核不无理由重跑实现者已在同一快照上跑过的命令。

### 任务与验收覆盖

| 任务 | 可独立审核的交付 | 依赖 | 覆盖 |
| --- | --- | --- | --- |
| T1 | 分层配置、模板及模型有效预算 | 无 | E1、E2 |
| T2 | 三协议有限流式调用与总预算 | T1 | E1、E8 |
| T3 | 安全上下文、断言与报告业务结果 | T1、T2 | E3、E4、E5 |
| T4 | 个人配置/秘密存储及旧配置迁移 | T1，T2 的 resolver 类型 | E1、E2 |
| T5 | CLI AI 三用途和独立输出 | T2、T3、T4 | E2、E3、E4 |
| T6 | 共用成员准备/启动、准确 intent 查询 | T1–T5 无产品依赖，按顺序交付 | E6、E7 |
| T7 | MCP source、成员引导、资产/报告只读 | T3、T6 | E5 |
| T8 | MCP 票据、启动、对账和生命周期 | T6、T7 | E6、E7 |
| T9 | 桌面配置/AI 宿主与 IPC | T2、T3、T4、T6 | E2、E3、E4、E7 |
| T10 | 设置 → AI 与模型 | T9 | E1、E2 |
| T11 | 用例、断言、报告可读预览/采用 | T9、T10 | E3、E4 |
| T12 | 真实联验、全分支独审、门禁和包 | T1–T11 | E1–E8 |

## 共同数据合同

T1 在 `ai/config.ts` 导出 `AiProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'`、`AiPurpose = 'case-suggestion' | 'assertion-suggestion' | 'report-analysis'`、`AiProviderTemplate`、`AiConnection`、`AiModelProfile`、`AiPurposeBinding`、`AiConfigDocument` 及同名 `Schema`。字段至少覆盖设计 §4，ID 稳定、revision 正整数；配置格式 `formatVersion: 1`。持久连接只含 `credentialRef`，不含 key。

T1 的 `AiResolveInput` 明确为 `{ document: AiConfigDocument; purpose: AiPurpose; modelProfileId?: string; projectKey?: string; overrides?: AiBudgetOverrides }`。`resolveAiInvocation(input: AiResolveInput): AiResolvedInvocation` 返回固定的非秘密 connection/model/purpose、effective budgets、每字段 source/限制说明及能力确认状态；冲突抛稳定的 `AiConfigurationError`（code、field、source、allowed），不携秘密。

T2 导出 `AiOperationInput`（resolved、signal、可选 onProgress）、`AiAttemptInput`（messages、outputSchema、kind 为 initial/repair）、`AiCallResult`（text、requestId?、usage?、明确成功终态）。`AiInvocationHost.run<T>(input: AiOperationInput, work: (session: AiOperationSession) => Promise<T>): Promise<T>` 包住整次排队/请求/修复生命周期；`AiOperationSession.invoke(input: AiAttemptInput): Promise<AiCallResult>` 共享同一计数、Token 余额和总 deadline，不能每次调用重置。`createAiInvocationHost(deps: { credentials: AiCredentialResolver; fetch?: typeof fetch }): AiInvocationHost` 创建宿主。`AiCredentialResolver.resolve(connection: AiConnection): Promise<AiResolvedCredentials>` 只在可信宿主解析；结果含受众绑定和合法鉴权头，绝不作为 UI DTO。

T3 导出 `AiSourceBinding`、`AiContextPreview`、`AiBusinessRequest`、`AiBusinessResult`、`AiEvidence`，后两者按 purpose 可判别。`prepareAiContext(input: AiContextInput): AiContextPreview` 是纯安全投影，返回完整消息/Schema、字节、包含/省略及来源摘要；`runAiAssistance(preview: AiContextPreview, resolved: AiResolvedInvocation, host: AiInvocationHost, options: { signal: AbortSignal; onProgress?: (event: AiProgress) => void }): Promise<AiBusinessResult>` 不读取项目、不保存或执行。source 中的真实根/成员 token 不返回 UI，UI 使用不透明 bindingId。

T4 导出 `AiConfigRepository`：`read(): Promise<AiConfigDocument>`、`write(next: AiConfigDocument, expectedRevision: number): Promise<AiConfigDocument>`；`AiPersonalConfigHost` 负责模板导入/差异、连接写入与凭据操作，导出的状态 DTO 仅 `missing | available | unavailable | session-only`。T9 的公共 DTO 通过显式 allowlist 构建，不序列化上述宿主对象。

### Task 1: 分层配置、声明式模板和独立模型预算

**Files:** Create `packages/core/src/ai/{config,budgets,catalog}.ts`、`packages/core/src/ai/providers.v1.json`；Modify `packages/core/src/ai/types.ts`、`suggest.ts`、`packages/core/src/{index,shared,schema}.ts`、`packages/core/tsconfig.json`；Test `packages/core/tests/ai/{config,budgets,catalog}.test.ts` 及已有 `suggest.test.ts`。

**Interfaces:** Produces 上述 T1 配置合同和 `loadAiProviderCatalog(builtin: unknown, overrides: readonly unknown[], previous?: readonly AiProviderTemplate[]): AiCatalogLoadResult`（有效目录、文件/字段错误和差异；失败保留 previous）。`AiBudgetOverrides` 仅允许预算字段，不允许改变身份/协议/能力。`DEFAULT_AI_TIMEOUT_MS` 旧兼容常量暂不借改默认悄悄改变旧调用；新用途明确用新解析器。

- [ ] Step 1：在已有 `suggestCases` 补 `limit_51_rejects_before_provider`，断言 provider 未调用而非先收结果再 slice；新增两模型测试：应用输出 16384，模型 A `maxOutputTokens=8192` 的纯继承有效值 8192、来源受模型限制；模型 B 显式输出 32768 和输入 1 MiB，A 不改变 B；显式超限报字段/source，不裁剪。
- [ ] Step 2：运行 `pnpm -C packages/core exec vitest run tests/ai/suggest.test.ts tests/ai/config.test.ts tests/ai/budgets.test.ts tests/ai/catalog.test.ts`。保留实际业务 RED；模块骨架/加载失败按上文单独记，不算先红。
- [ ] Step 3：实现配置/继承、窗口口径、未知能力状态及完整输入预算。精确默认和范围逐项使用设计 §5.2，候选数 5/10、1–50；请求 3、1–10；用途期限 10/5/15 分钟；单次 5 分钟；输出 8192/16384/32768；总 Token 初始 3 倍但单独持久配置，改请求次数不能改它。初始输出保护 262144 可高级校验提高；模型真实能力与应用可用额度分开。
- [ ] Step 4：补行为 RED/GREEN：完整修复消息/Schema 也纳入窗口；不按固定字节比率伪造精确 Token；应用保护不能被模型覆盖；部分覆盖/恢复继承；模板坏字段保留最后有效目录；更新/删除模板不漂移现有连接。JSON 以 TS 的 `resolveJsonModule` 和 Node import attributes 引入，验证编译产物实际携带目录，不复制一份硬编码 TS 厂商表。
- [ ] Step 5：同命令 GREEN，`pnpm -C packages/core build`、`pnpm -C packages/core typecheck`。记录 diff/实际 JSON dist 路径、有效配置例和任务独审，不 commit。

### Task 2: 三协议流式与统一操作预算

**Files:** Create `packages/core/src/ai/protocols/{chatCompletions,responses,messages}.ts`、`ai/{stream,invocation}.ts`；Modify `ai/provider.ts`、`ai/types.ts`、`src/index.ts`；Test `tests/ai/{protocols,stream,invocation}.test.ts` 和 `provider.test.ts`。

**Interfaces:** Consumes T1 `AiResolvedInvocation`。Produces 上述 T2 调用合同、`AiProgress` 和结构化安全 `AiInvocationError`。旧 `createAiProvider(config, deps): AiProvider` 保留为 Chat Completions 兼容适配，不制造独立不受限 reader。

- [ ] Step 1：三协议同业务输出 fixture；先通过现有 `createAiProvider` 写 `redirect_is_rejected_and_error_body_not_echoed` 取得行为 RED，再对新协议逐个先红。断言路径/认证头/版本头、输出字段、显式不保存状态和各自结构化参数，不使用相同 body 只换 URL。
- [ ] Step 2：运行 `pnpm -C packages/core exec vitest run tests/ai/provider.test.ts tests/ai/protocols.test.ts tests/ai/stream.test.ts tests/ai/invocation.test.ts`，确认 RED 原因是协议/边界行为，不是真网失败。
- [ ] Step 3：实现有限 SSE 帧/UTF-8 跨块解析及非流式兼容；Chat choices、Responses 文本 output、Messages 文本块分别装配；reasoning/tool 不作业务正文。不缓存整条原始事件链。每事件 256 KiB、累计 64 MiB、在途缓冲 64 MiB 默认及范围按设计校验，错误体/未完成行/心跳同样计数。
- [ ] Step 4：先红再实现：HTTP200 后错误、完整 JSON 后 EOF 无终态、拒绝/截断、超大单帧和无限心跳、中文跨块、排队取消、读体取消、修复中取消、迟到结果丢弃。统一总 deadline、单次 deadline、并发 1/队列 8；仅允许已确认可重试失败，Retry-After 有界；重试/修复共同消耗 3 次和 Token 预留，未知 usage 不零返还。禁止自动接龙、切协议/模型/stream。
- [ ] Step 5：上述 GREEN、Core build/typecheck；旧 provider 兼容测试只调整已明确废弃的原始错误体展示断言，保留安全和功能覆盖。交任务独审。

### Task 3: 安全上下文、三用途业务结果与证据

**Files:** Create `packages/core/src/ai/{context,assertions,analysis,assistance}.ts`；Modify `ai/{contractView,prompt,suggest,types}.ts`、`src/{index,shared,schema}.ts`；Test `tests/ai/{context,assertions,analysis,assistance}.test.ts` 及 `suggest.test.ts`。

**Interfaces:** Consumes T1/T2，Produces 上述 T3 合同。`AiContextInput` 判别为契约/当前用例/已读取报告，包含同一 ProjectAssetContextReadView、固定 source 与显式正文选择；不接收任意磁盘路径、网络 URL 或凭据 resolver。`AiBusinessResult` 候选 ID 本地生成，分析只引用 `AiEvidence.id`。

- [ ] Step 1：已有建议 fixture 加 `model_ids_are_not_trusted_for_assertions_and_operations`；断言既有资产不被修改且 ID 均本地新建。新增 `same_name_different_project_is_not_same_binding`、`unknown_evidence_id_rejected`、`raw_request_failures_remain_distinct_from_logical_passes`。
- [ ] Step 2：`pnpm -C packages/core exec vitest run tests/ai` 观察各新增业务 RED；测试实际契约和报告 fixture，不伪造另一个 Core Runner。
- [ ] Step 3：实现相关引用闭包、同快照投影、已知字段/URL凭据及文本脱敏、包含/省略摘要。默认不含附件、秘密、绝对路径、全量数据行、body/脚本；用户只可勾有权限且已有的安全证据。提示中的文字不能授予工具/网络权限。
- [ ] Step 4：先红再实现独立断言（当前 Core 支持的操作符，契约/观测依据分开）、报告事实/可能原因/证据/核查/限制的严格输出。保持逻辑与真实请求事实、完整性、饱和、阶段/比较限制；统计由程序投影，模型不得重写。结果保留来源摘要，分析不写回原报告或 verdict。一次 `host.run` 内完成初次和结构修复，每次 `session.invoke` 共用预算；重用旧建议的解析/消息逻辑，不再嵌套旧修复循环乘出次数。
- [ ] Step 5：同命令 GREEN、Core build/typecheck；报告输入前后摘要相等、安全正文选择有界、未知/缺失证据显式状态，交任务独审。

### Task 4: 个人配置仓储、秘密受众绑定及迁移

**Files:** Create `packages/core/src/ai/host/{repository,personal,secrets,migration}.ts`、`tests/ai/host/{repository,personal,migration}.test.ts`；Modify `packages/core/src/index.ts`；后续 Electron adapter 在 T9，CLI adapter 在 T5。

**Interfaces:** Consumes T1 config/catalog 和 T2 的 AiCredentialResolver 类型；T4 提供个人凭据 resolver adapter。Produces 上述 T4 repository/host，`createAiConfigRepository({ privateRoot }): AiConfigRepository`、`createAiPersonalConfigHost({ repository, secretBackend, catalog }): AiPersonalConfigHost`。`AiSecretBackend` 定义 `get(ref,audience)`、`put(value,audience,mode)`、`remove(ref,audience)` 和 availability；受众由规范地址/鉴权构成。不得反向让纯配置依赖协议实现，不复用项目凭据的授权身份来冒充 AI 个人凭据。

- [ ] Step 1：先测试非敏感 document 写入后精确 roundtrip、expectedRevision 冲突、密钥状态 DTO 不含值；改显示名保留 ref，改地址/鉴权受众不再解析旧 ref。`unavailable_secure_backend_never_creates_plaintext_file` 核对真实临时目录。
- [ ] Step 2：`pnpm -C packages/core exec vitest run tests/ai/host` 记录 RED，不能把临时目录未创建的 IO 错误当目标断言。
- [ ] Step 3：原子私有配置写入、稳定 ID/修订、模板导入差异/冲突与最后有效目录。秘密只经安全 backend 或显式 session-only；不改变旧项目秘密模块政策。迁移需确认旧地址，不能只凭 renderer 给新地址取出单一旧 key。
- [ ] Step 4：先红再验幂等迁移、旧密文不可解密/旧配置不完整、旧明文 CLI 文件保留且不复制进项目、坏配置不覆盖好配置、保存不联网；混合来源拒绝。保留未来 repository/resolver/host seam，不注册 team/backend。
- [ ] Step 5：同命令 GREEN、Core build/typecheck；记录磁盘文件 allowlist 和安全状态，交任务独审。

### Task 5: CLI 个人 AI、三用途命令与安全输出

**Files:** Create `packages/cli/src/ai/{config,commands,output}.ts`、`packages/cli/tests/{ai-config,ai-assistance}.test.ts`；Modify `src/main.ts`、已有 `tests/ai-suggest.test.ts`。

**Interfaces:** Consumes T1–T4。Produces `registerAiCommands(program, deps): void`；保留 `resolveAiConfig` 旧公开入口作为兼容解析；命令 `ai suggest-cases`、`ai suggest-assertions`、`ai analyze-report`。个人 profile 显式选择最高，完整旧 env 三件套其次，旧文件最后；部分 env 拒绝而非拼接。配置子命令只写私有配置，项目命令不写资产。

- [ ] Step 1：先改已有解析测试，partial env + valid file 应拒绝（目前会回退）；新增已存在 `--out` 不显式 `--overwrite` 就失败且原文件字节不变。记录有效 RED。
- [ ] Step 2：`pnpm -C packages/cli exec vitest run tests/ai-suggest.test.ts tests/ai-config.test.ts tests/ai-assistance.test.ts`；初次运行前依赖 dist 按上文顺序构建。
- [ ] Step 3：接 T4 个人配置，使用现有 `@napi-rs/keyring` 的 OS backend/秘密 env 或受控 stdin；不得新增 key argv。建立三用途命令、外发范围预览和显式确认参数，非交互调用必须给足明确确认；yaml/分析独立输出，CLI 默认诊断不带正文/key。
- [ ] Step 4：先红再验证两独立模型/三协议、取消 exit/无悬挂 reader、无选择/缺来源/能力未知、文件冲突和安全 report 选择；断言工作区 hash 未变，不自动执行。`--overwrite` 只限用户指定候选输出，不扩大为项目修改。
- [ ] Step 5：上述 GREEN、`pnpm -C packages/cli build`、`pnpm -C packages/cli typecheck`；实际 CLI process 替身端点测试留 stdout/exit 证据，交任务独审。

### Task 6: 共同成员执行准备/启动与精确意图查询

**Files:** Create `packages/execution/src/client/{member,memberTypes}.ts`、`packages/execution/tests/client/member.test.ts`；Modify `client/index.ts`、desktop `src/main/online/{execution,client}.ts`、`src/shared/online/execution.ts`、`tests/main/online/execution.test.ts`；Modify server `execution/jobs/{JobController,JobService}.java`、`ExecutionJobsApiTest.java`。

**Interfaces:** 从桌面移动现有 `OnlineExecutionContextSchema`、非压测的 run/status/report DTO 校验到 `memberTypes.ts`，桌面原名重导出保持兼容，不能让 execution 依赖 Electron/桌面路径。`MemberRunInput` 使用当前 run 字段（context/runId/location/target/expectedVersion/environmentId/debugSessionId/runConfig/materials/localOnlyRefIds/network），target 限 debug/suite/workflow。`MemberSession.captureExecution(context)` 返回 `{serverId,userId,token(): string | Promise<string>,assertCurrent(): void}`。

Produces `createMemberExecutionClient(deps: MemberExecutionDependencies): MemberExecutionClient`，方法 `assets(context,signal)`、`prepare(input: MemberRunInput, signal): Promise<PreparedMemberRun>`、`start(prepared: PreparedMemberRun, intentId: string, signal): Promise<MemberStartedRun>`、`findIntent(context,intentId,signal)`、`status(context,location,runId,signal)`、`cancel(context,location,runId,signal)`、`report(context,location,runId,signal)`、`close(): Promise<void>`。`PreparedMemberRun` 由本客户端签发且不可伪造，封装既有 snapshot/prepared/material versions 和 summary，不含可序列化秘密；start 不重建 snapshot。`MemberStartedRun` 返回 runId/实际 location/固定来源和状态，不等待本机整次执行结束；桌面兼容 adapter 在旧 run 入口等待同一客户端结果，不另起 Runner。`MemberExecutionDependencies` 注入 session、fetch、本机 SecretStore/声明文件/插件和本机生命周期，底层继续 prepareProjectFiles/invokeExecution。

- [ ] Step 1：先写真实 HTTP 测试 `GET /api/v1/workspaces/{ws}/projects/{project}/jobs/by-intent?intentId=...`，断言只返回同 caller/project 已接纳任务，无任务 404，越权 403，无缓存；先观察新 API 尚不支持的失败不算权限分支 RED，随后分别以可加载入口验证边界。桌面原入口加 prepare/start 的 snapshot ID/manifest 固定断言。
- [ ] Step 2：`pnpm -C apps/desktop exec vitest run tests/main/online/execution.test.ts`、`pnpm -C packages/execution exec vitest run tests/client/member.test.ts`；Java `server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml -Dtest=ExecutionJobsApiTest test`。各阶段记录目标行为 RED。
- [ ] Step 3：抽共用成员 HTTP/资产/准备/材料/启动/身份核验。prepare 不执行业务和脚本；start 复用准备 snapshot，当前权限/脚本/代理再由服务端权威检查；已有 intent 查询先于新版本拒绝。不改原 SubmitJob 去重事实，不靠任务列表最近一条猜结果。查询复用现有 repository intent 和当前成员授权，不加独立数据库/执行内核。
- [ ] Step 4：先红再覆盖授权撤回、脚本批准不足、材料缺失、同 intent 改输入冲突、固定 agent 不自动回退、本机关闭取消；原桌面 debug/case、suite、workflow 的本机/代理路径继续通过。压测特有编排留原桌面 adapter，不为 MCP 不暴露的压测启动大重构。
- [ ] Step 5：上述 GREEN、execution build/typecheck 和 desktop build；记录共用 import 与真实旧入口回归，交任务独审。

### Task 7: MCP source、成员登录和资产/报告只读

**Files:** Create `packages/cli/src/mcp/{source,localSource,onlineSource,pagination,reports,profiles}.ts`、`tests/{mcp-source,mcp-reports,mcp-profiles}.test.ts`；Modify `mcp/server.ts`、`main.ts`、`src/ai/commands.ts`、已有 `mcp-server.test.ts` 与 `ai-assistance.test.ts`。

**Interfaces:** Consumes T3 安全投影、T6 member client。`createMcpSource(options: McpSourceOptions): Promise<McpSource>` 的 options 互斥 workspace/onlineProfile；`McpSource` 导出 `identity`、`readProject(projectId,signal)`、`listRuns(projectId,page,signal)`、`getRun(runId,signal)`、`getReport(runId,selection,signal)`、`close()`。项目 snapshot 统一返回 Core ProjectSnapshot + 不透明绑定及 revision，不把 token 放对象。保留 `createMcpServer(root, options)` 包装；新增 `createScopedMcpServer(source, options): McpServer`。

- [ ] Step 1：旧工具真实 SDK 客户端测试加 URL 用户信息/密码查询脱敏、输出超额明确拒绝；测试不带 allow-run 没有任何执行工具，保留旧本地 list/get/full UUID apiPath 和合法 run-case 契约。
- [ ] Step 2：`pnpm -C packages/cli exec vitest run tests/mcp-server.test.ts tests/mcp-source.test.ts tests/mcp-reports.test.ts tests/mcp-profiles.test.ts` 记录 RED。
- [ ] Step 3：在线 profile 的单独隐藏输入/受控 stdin 登录，复用现有 /auth/login、/me，不占 MCP stdin，不保存密码、不读 Electron token；profile 固定服务器、成员与作用域 allowlist。每工具/页/启动重新鉴权；401/403 不换身份，注销使 cursor/ticket 失效。生产仍 HTTPS/redirect 拒绝，HTTP 仅隔离替身。
- [ ] Step 4：注册 list-assets/get-asset/list-runs/get-run/get-report，页 50（1–200），输出 128 KiB（4 KiB–1 MiB）；cursor 绑定成员/项目/源修订/查询，不能无界序列化后截断。默认仅数据集列/行数。旧 list-apis 完整数组预算足才返回，显式分页 envelope，无参数超额提示分页，不悄悄少返回。
- [ ] Step 5：先红再覆盖 local realpath/symlink 逃逸、跨项目报告、旧报告归属不明、在线 report/execution/scope 不符、410/未归档/损坏/HTTP200 空体；来源无权不外发、不可读不重跑。只接受 opaque report ID，不增加任意路径/body/秘密读取工具。将 T5 三用途 CLI 的在线 profile 选择接到同一只读 source，验证在线用例/断言/报告读取和外发绑定，不为 CLI 再实现项目读取器。
- [ ] Step 6：同命令 GREEN、CLI build/typecheck；启动真实 stdio 子进程并用 SDK 握手/调用，stdout 全为协议，stderr 诊断无秘密，交任务独审。

### Task 8: MCP 准备票据、意图回执、启动与生命周期

**Files:** Create `packages/cli/src/mcp/{execution,tickets,intents,localRuns}.ts`、`tests/{mcp-execution,mcp-intents,mcp-lifecycle}.test.ts`；Modify `mcp/server.ts`、source 适配文件、`main.ts`。

**Interfaces:** Consumes T6 prepared/start/findIntent，T7 source。`createMcpExecutionHost({source,privateRoot,limits,localHost}): McpExecutionHost`，成员 client 从同一 source 的可信内部 capability 取得（R37），不再独立传入身份未绑定的 client；`prepare(input,signal): Promise<McpPreparedSummary>`、`start({ticketId,intentId},signal): Promise<McpRunHandle>`、`cancel(runId,signal)`、`close()`。本任务定义 `McpLocalExecutionHost`，方法 `prepare(snapshot,target,environmentId,limits): PreparedExecution`、`start(prepared,runId,signal): Promise<InvocationOutput>`，分别直接复用 execution/host 的 prepareExecution/invokeExecution；结果及 AbortController 存本任务 localRuns，不写新内核。ticket 绑定已准备对象，summary 有具体位置/环境/预算/版本/限制，不含秘密。运行状态/报告接 T7，同一 runId 不建立第二事实来源。

- [ ] Step 1：先写 `prepare_sends_zero_business_requests`、`same_ticket_intent_returns_prior_run`、`different_input_same_intent_conflicts`、`local_source_rejects_agent`。先存在行为断言，不能只以工具未注册 404 算全部先红。
- [ ] Step 2：`pnpm -C packages/cli exec vitest run tests/mcp-execution.test.ts tests/mcp-intents.test.ts tests/mcp-lifecycle.test.ts` 记录 RED。
- [ ] Step 3：allow-run 才注册 prepare/start/cancel；新入口支持保存 case/suite/workflow，不支持 stress/freeURL。case 用已有 debug/mode=case。ticket 默认 5 分钟、30 秒–15 分钟、最多 32；过期/来源换代拒绝新 start。提交前写私有回执，再单次 POST；结果不确定只查询同 intent，不重新提交/生成新 intent。
- [ ] Step 4：先红再覆盖 POST 接纳后丢响应、重开 MCP 且资产变化、成员换代/权限撤回、重入 start、断线后 agent 继续且可查历史、明确 cancel。在线不因 MCP 退出 cancel；本地退出才取消并收束。子进程去除 AI/member token，不宣称 node:vm/同账号进程强隔离。
- [ ] Step 5：本机 active 1（1–4）、终态 20/32 MiB（1–100/1–128 MiB）；活动/不确定项不驱逐，满则拒绝新执行。清理限本宿主明确私有项，不碰在线防重记录/既有工作区业务文件；旧本地 run-case 继续单步、base-only，在线不注册该别名。
- [ ] Step 6：上述 GREEN、CLI build/typecheck，真实 stdio prepare/start/status/cancel 合成回环请求有准确计数和退出证据，交任务独审。

### Task 9: 桌面 AI 配置宿主、来源捕获和可取消 IPC

**Files:** Create `apps/desktop/src/main/ai/{personal,runtime,sources}.ts`、`tests/main/ai/{runtime,sources}.test.ts`；Modify `main/ai/{config,suggest}.ts`、`main/ipc.ts`、`shared/ai/contract.ts`、`shared/{types,channels,ipc-contract}.ts`、`preload/preload.ts`、既有 main ai 测试。

**Interfaces:** Consumes T1–T4、T6。公共 `AiSettingsView` 只含无秘密配置/状态；IPC 分 `settings-read/write`、`catalog-import/reload`、`connection-test/discover`、`prepare-assistance/start/cancel`。`prepare-assistance` 由 main 捕获来源返回 `previewId + AiContextPreviewDto`；start 显式 previewId/operationId，cancel 作用于本 renderer owner 的 operationId。`AiBusinessResultDto` 仅 bindingId、候选/分析、安全来源摘要。

- [ ] Step 1：现有 config 测试加 safeStorage 不可用绝不新写明文；IPC 测试模拟 renderer 改 baseUrl/locator，必须不能把旧 key 送新地址或读别项目。取得目标行为 RED 后更换旧 fallback 断言而非删测试。
- [ ] Step 2：`pnpm -C apps/desktop exec vitest run tests/main/ai tests/main/preload-contract.test.ts`，必要追加现有 IPC 类型检查，不用整桌面全套替代定位。
- [ ] Step 3：T4 Electron safeStorage adapter、地址确认迁移、revision 并发保存；读配置不需选项目、保存不联网、key 不回 renderer。main 解析本地固定快照/在线授权资产及当前草稿 allowlist；只当前接口可叠未保存草稿，其他来源必须同快照。在线用 T6 client 不另拼后端执行入口。
- [ ] Step 4：先红再覆盖生成中切项目/账号、preview 后来源变动、同名不同项目、取消排队/读流/修复、renderer owner 关闭、晚到不更新；来源变动后旧采用必须拒绝。配置冻结仅影响后续新调用。
- [ ] Step 5：上述 GREEN、desktop build/typecheck:vue，检查实际 bridge 参数/结果严格白名单，无 token/key/host 对象，交任务独审。

### Task 10: 应用设置入口、连接/模型独立配置和继承展示

**Files:** Modify `renderer/src/components/{TopBar,AiConfigDialog}.vue`、`renderer/src/stores/ai.ts`、`renderer/src/App.vue`、`i18n/{zh-CN,en}.json`；Create `components/ai/{AiConnections,AiModels,AiBudgets}.vue`；Test `tests/renderer/components/{topBar,AiConfigDialog}.test.ts`、`tests/renderer/stores/ai.test.ts`。

**Interfaces:** Consumes T9 settings DTO/IPC，通过同一 ai store 给 TopBar 和业务管理快捷入口，避免两个独立配置副本。表单用稳定 ID，能力输入与使用预算分别呈现；继承项有“恢复继承”，显示有效值/来源/模型或应用限制。模板差异显式选择应用，不保存即联网。

- [ ] Step 1：可见 DOM 行为测试：主页/本地/在线顶栏均能打开同一个“设置 → AI 与模型”；窄窗更多入口仍可达；接口头部旧独立配置按钮移除但“管理模型”可返回工作。
- [ ] Step 2：`pnpm -C apps/desktop exec vitest run tests/renderer/components/topBar.test.ts tests/renderer/components/AiConfigDialog.test.ts tests/renderer/stores/ai.test.ts` 记录 RED。
- [ ] Step 3：实现三分节表单、模板导入/重载/更新差异、同厂商多连接、手工模型/显式发现及完整最终 URL 预览。个人/当前设备归属标签，无 team/backend 空开关。凭据只显示状态，安全存储不可用显式 session-only/拒绝持久化。
- [ ] Step 4：先红再覆盖模型 A 8192 vs B 32768 独立默认、上下文与输入/输出使用预算各自保存、应用默认变化不改显式值、恢复继承、未知能力标记、显式超限报来源；请求数从 3 改 10 不自动改总 Token。所有精确范围使用 Core schema，不在 renderer 复制另一份校验常量。
- [ ] Step 5：上述 GREEN、desktop build/typecheck:vue；中英文可见文案/单位/状态/错误，长地址/名称局部可查、表头不挤断。真实视觉集中在 T12，不用 DOM 存在代替视觉验收，交任务独审。

### Task 11: 用例、独立断言、报告分析的可读预览与显式采用

**Files:** Modify `components/{AiSuggestionsDrawer,CasePanel,RunView,StressReportView}.vue`、`stores/ai.ts`、`App.vue`、`i18n/{zh-CN,en}.json`；复用 `stores/editor.ts` 既有 append/派生 dirty/save 接缝，无需为了文件清单制造源码改动（R69）；Create `components/ai/{AiOutboundPreview,AiAssertionSuggestions,AiReportAnalysis}.vue`；Test 既有 `AiSuggestionsDrawer.test.ts`、`ai.test.ts`，新增 `tests/renderer/components/{AiAssertionSuggestions,AiReportAnalysis}.test.ts`。

**Interfaces:** Consumes T9 preview/result binding，沿已有编辑器 append/dirty/save 路径；不新增直接写盘/在线资产覆盖接口。分析 evidenceId 映射已有证据定位回调，不把 AI 文字当定位路径/URL。报告分析只存当前会话，显式导出独立副本。

- [ ] Step 1：先测候选默认零选择/零修改，展开能看到真实参数、断言目标/操作符/期望及完整前后置操作；采用只追加所选，旧 ID/expected 不变、dirty=true、save/run 调用数=0。
- [ ] Step 2：`pnpm -C apps/desktop exec vitest run tests/renderer/stores/ai.test.ts tests/renderer/components/AiSuggestionsDrawer.test.ts tests/renderer/components/AiAssertionSuggestions.test.ts tests/renderer/components/AiReportAnalysis.test.ts` 取得行为 RED。
- [ ] Step 3：接本地/在线当前接口/用例来源、外发明细和确认、可取消状态/耗时/尝试；无伪进度、无部分 JSON 采用。已有正式操作兼容但显示完整脚本与受信风险，不增加独立脚本生成产品。无项目不显示可执行 AI 业务；只读项目不绕过写权限。
- [ ] Step 4：先红再测试来源变更/账号切换/过期拒绝、独立断言追加到精确用例、不替换失败 expected。报告区主要结论/程序事实/推测/证据/限制分别可读，逻辑通过和真实请求失败分开，缺失/不可计算不补零；原报告字节和 verdict 不变。不向离线 HTML 导出器塞入新分析主视图。
- [ ] Step 5：上述 GREEN、desktop build/typecheck:vue；导出含 AI 辅助、模型、来源摘要、毫秒时间及时区，正文默认安全投影。交任务独审。

### Task 12: 集中联验、同候选门禁、独审与打包

**Files:** Create `docs/f7e-ai-mcp.md`、`scripts/f7e-acceptance.mjs`、必要的合成 fixture/验收测试（只覆盖实际未被任务测试证明的联验）；Modify 本计划、路线和 README 中实际使用入口。日志/私有结果放本计划独立忽略的证据目录，不提交秘密或用户数据。

**Interfaces:** Consumes T1–T11 实际接口和 diff，不改语义。Produces 每个 E 条件的证据路径/候选源码摘要、CLI 和 Windows 目录包/冒烟身份、限制和遗留清单。

- [x] Step 1：核对所有任务独审、Minor/裁决、TDD 记录；按 E1–E8 做缺口审计。只新增必要先红行为，不重新创造全页面/全协议/全故障矩阵。功能缺口回所属任务修复并定向复审。
- [x] Step 2：真实 stdio + 隔离 Java 后端 + Linux 合成 agent 验资产、准备/启动/同 intent、防重/权限/脚本批准不足、丢提交响应/重开只查历史、agent 不依赖桌面继续。复用既有真实后端夹具；回环替身/管理台 HTTP 与生产控制 HTTPS 边界分清。只合成低负载，不访问真实项目、付费模型或启动无关长压测。
- [x] Step 3：同候选仅一次集中真实页面/原生验收：中英文、主页设置入口、两个不同能力模型及继承、长名称、外发确认/取消、候选具体内容/脚本风险、断言追加、报告事实/推测与证据定位。工具能完成的自行完成；确实受认证/本地文件限制才集中请用户手验，不反复换短效服务要求登录。
- [x] Step 4：唯一整分支独审（Sol xhigh），提供基线到候选完整 diff 文件、规格/计划、任务证据及 Minor/裁决。必要发现统一一轮修复和定向复审；未解决承重项阻止宣称完成，不用预算将尽当完成理由。
- [x] Step 5：冻结候选后运行 `pnpm install --frozen-lockfile`（如当前依赖已冻结且未变可记录现有冻结证据）、`pwsh -NoProfile -File scripts/test-all.ps1`，沿现有串行包/最多 2 worker。运行 `pnpm -C apps/desktop dist:dir`、`pnpm -C apps/desktop smoke:dir`，核对实际 JSON 模板、Core/execution 打包资源及安全秘密 adapter 随包可用。不要修改全量脚本来排除失败。
- [x] Step 6：全量若失败保留原记录，定位最小原因，先复现再修/独审，补必要受影响测试；不拼接成“单次全绿”。实质候选变化重新判断需要重跑范围，避免无差别连续占满机器。收尾测试进程/合成资源按 exact ID 停止；不删除证据或真实项目。
- [x] Step 7：更新文档：三协议范围、模板文件/导入格式、各层配置/单位/继承/生效、CLI 命令、MCP 默认只读与外部人工确认建议、在线登录/秘密、准备/start/不确定处置、旧迁移和边界。逐 E 给实际结果/路径；标未验证/不支持及延期，交付包供用户验证。没有 Git 集成授权就停在可交付未提交状态，不自动 commit/merge/push。

## 计划自检回执与当前状态

- §1–§5 的分层配置/三协议/额度由 T1/T2/T4/T10 承担；§6/§7 的人工辅助/可读交互由 T3/T5/T9/T11 承担；§8/§9 的 source/执行权威和生命周期由 T6–T8 承担；迁移 §10 在 T4/T5/T9，E1–E8 集中由 T12 核对。
- 五项 Review Focus 均有指名测试行为；任务合同只依赖前序定义，桌面不再是 CLI 的库，Core browser 不导入秘密/文件宿主。计划新增类型名是实现交接约束，不冒称仓库已存在。
- 本阶段团队共享/后端 AI、AI-FUTURE-001–004、F7b 三项遗留、调度 B、到达率 B 和 DEF-001 均未实施；MCP 读取压测报告不扩大为压测启动授权。
- 状态：T1–T12及E1–E8已按下方回执核对，产品交付完成、Git集成未授权。早期基线、失败、已接受的具名顺序偏差和验证限制均保留，不把设计复核冒充代码审核，也不把后验验证改称历史先红。

## 阶段最终回执（2026-11-01）

最终产品私有树为`428bcbe7254501235bb6ba955aa48d6a178cf507`，分支`codex/f7e-ai-mcp-design`；真实HEAD仍为`1330a81071769458e0461764aef40d9a7970ab6d`。私有树用于证据校验，不是已创建提交。收尾后仅更新四份说明/状态文档，不改变包内产品代码。

| 条件 | 实际交付及证据 |
| --- | --- |
| E1 | 分层个人配置、配置驱动模板、自定义供应商、三协议及流式/非流式行为；真实主页/项目设置、中英、长名称、不同模型与继承、连接探测及失败回退已验。 |
| E2 | 受众绑定、密钥不进入公开DTO/项目/MCP输出、迁移与安全存储失败行为；实际Windows打包safeStorage往返及包内适配器资源核对。 |
| E3 | 本地/在线候选与断言可读预览、显式追加、无自动保存/执行；实际资产摘要在独立人工保存之前不变，来源/版本/权限拒绝受测。 |
| E4 | 实际报告事实/推测、不同总体和缺失值、证据选择/导出/原报告不变；最终补验真实首次超额后缩小证据、显式重预览与正确定位，以及中英证据不足安全提示。 |
| E5 | 真实构建stdio、只读默认、旧入口、分页/路径/归属/输出预算与秘密边界，任务及最终审核覆盖。 |
| E6 | 真实Java/Linux代理/成员/stdio故障联验；丢响应按原intent对账、重开只查历史、EOF不默认取消、显式取消和桌面关闭后继续/归档均有实际证据。 |
| E7 | 共用Core及成员准备/提交权威；原桌面路径回归、实际打包子进程退出和IPC断连；CoreBuildId为`4d7dd6c8dc0f52f32fed3c067bbab4305b3f14c3340f1b3a0e6f07446b6de01d`。 |
| E8 | 任务独审、唯一整分支审查、原失败定向复审和用户具名追加三项复核均保留；最终复核3项关闭、0新增阻断。延期项未恢复。 |

门禁：固定Node22.19.0、pnpm11.21.0、JDK21；冻结依赖证据保留。`root-final-full-gate-04`是226源码上的一次真实完整exit0：SDK11/Core2004/execution403/admin289/desktop1687/runner92/CLI510/Java933，合计5929通过、14条件跳过。原失败不覆盖。最终428仅重验受影响16项，测试类型校准后N1四项、desktop tsc/Vue types通过，并重新构建目录包、核对275运行资源及启动冒烟；没有宣称428重新全仓测试。

交付目录：工作树内`.superpowers/sdd/2026-10-30-apicc-f7e-ai-mcp/final-package-03/win-unpacked/`，入口`apicc.exe`；须保留整个目录使用。EXE SHA-256为`4bd13039e1cd340617381dd262b2721033eb1263489a6631ec57382edc33e422`，ASAR为`ed904c0bfb6e7112b6ca80a74c21d7f4a0e4d74f756e59318dfc58f965f53a41`。CLI构建入口`packages/cli/dist/main.js`，用法见[使用说明](../../f7e-ai-mcp.md)。没有发布安装器或新CI结论。

验证限制：未用付费供应商/真实项目；不宣称Linux CLI密钥库实机、最新旧配置安全确认弹窗的物理触发，或带脚本候选跨信任确认的自动采用已验。Node22代理与Electron内Node24运行时明确区分，不承诺任意平台/脚本完全相同。旧功能历史在新进程中安全拒绝时的泛化补救提示仍是已披露边界，不自动重跑。团队共享/后端AI、AI-FUTURE-001–005、F7b三遗留、调度/到达率B与DEF-001仍按原排期。

完整阶段证据保留于同一忽略目录：`progress.md`、`acceptance-map.md`、`root-final-acceptance.md`、`final-completion-audit.md`、`final-review.md`、`final-rereview.md`、`final-residual-rereview.md`及原始命令日志/源码快照。63条裁决按原顺序保存在`rulings-handoff.md`，包含风险/代价；不删除该目录。Java/代理、AI替身及测试窗口均已收尾，合成报告/显式保存用例保留；仅按用户本次授权放弃内存草稿。尚未暂存、提交、合并或推送，下一阶段未自动开工。
