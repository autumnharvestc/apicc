# F2a 高频调试闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 未保存请求可发送，完整观察响应，保存本机历史并恢复/重放，显式保存为跨入口可执行的用例。

**架构：** 沿既有 Core 快照、用例物化和 Runner 运行；请求模式只在临时快照中替换当前请求并创建临时用例。HTTP 宿主捕获文件和会话，Core 调试服务输出有界投影 DTO；历史独立保存在应用私有目录。桌面和 CLI 均消费同一执行链，不在渲染器发包。

**技术栈：** TypeScript、Zod、Node 22.19.0、Undici、Vue/Pinia/Ant Design Vue、Electron、Vitest；Cookie jar 使用当前锁文件已有的 tough-cookie 6.0.2，精确声明为 Core 运行依赖，安装前核对该版本许可/engines/导出。

**规格：** [F2a 书面规格](../specs/2026-10-13-apicc-f2-debug-loop-design.md)，用户已确认；基线 `116194d1054e5b71f6c5db5990f1975377596aeb`。

## 全局约束

- 主智能体负责计划、调度、验收；每任务一个开发 GPT-6 Luna xhigh，独立审核 GPT-6.1 Sol xhigh。只允许一个产品写入者。
- 工作目录 `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，分支 `codex/debug-loop`；不编辑主 checkout、不提交、不暂存、不合并、不推送、不删除旧包或证据。用户的 Git 指令优先于技能的自动 commit/清理。
- DEF-001 无限期延期；普通输入校验、脱敏、取消、资源回收及既有目标保护仍保留。不修改脚本引擎/旧 c0 工作树，不建设恶意脚本隔离。
- 请求设置包含 connect/headers/body/total 超时及是否跟随重定向；缺省保持 connect 10s，其余 30s，正数校验。body 为闲置超时，total 覆盖整条网络尝试/重定向链。
- 重定向默认不跟随，启用最多 10 次跟随。303 转 GET（原 HEAD 保持 HEAD），301/302 的 POST 转 GET，307/308 保留方法/Body。
- 单次上传总量默认 64 MiB，可调至最高 1 GiB；累计整条重定向链实际文件内容字节，重传计入，文本/编码开销另记。
- 响应接收默认上限 32 MiB，可调但硬上限 128 MiB；encoded/decoded 两层分别计数和限额。超限 RESPONSE_LIMIT_EXCEEDED/response-body，不把部分响应当完整断言输入。
- 单 Body 展示摘要默认上限 1 MiB；每次调用所有 exchange Body 摘要合计 2 MiB；先投影再截断。Binary 在 hex/base64/IPC/下载前做有界已知凭据字节判断，不可靠或匹配时仅元数据。
- 历史 formatVersion=1；30 天/1000 条，最多 10000 条；最多100个 exchange元数据，分页默认50/最多200，单条序列化4 MiB。损坏/未来版本原件保留并给占用告警，不声称整个目录字节保证。
- TestCase 新可选 requestOverride 是完整 ApiRequest，缺失继承默认；requestSettingsOverride 是纯 JSON 部分设置。缺省 < 用例覆盖 < 显式调用覆盖；不能用填充默认值抹掉用例设置。
- 继续格式1可选扩展；旧严格读取器诊断/只读不能删字段保存。真实证据若不支持则报告版本阻塞，不建设旧 ApiDefinition 迁移。
- 历史结构化 needsInput 未补齐前禁止消费该字段的发送/保存。用例重放保持完整 CaseLocator、当前环境实际有效 scope、全部数据行/操作/断言。
- 普通凭据仍加密持久化、免主动解锁；不进入正式用例原文/IPC/日志/历史/复制下载。普通本地脚本既有行为保留，不扩大承诺。
- 只用受控本地服务、合成凭据和临时文件；复用测试，新的行为无覆盖才加必要断言。每任务聚焦门、最终受影响范围整体门一次；不重复 Admin/Java/延期引擎专项。

## 执行与证据约定

命令从对应包目录执行。系统默认 Node24/pnpm12 不作本阶段验收依据。所有 Node 命令前在进程级 PATH 首位加入已有 `local/toolchains/node-v22.19.0-win-x64`；不改机器环境和依赖版本。`node --version` 应为 v22.19.0；pnpm 调用沿用现有本地工具链并记实际版本，不得静默更新 lockfile。

基线聚焦检查已完成：`node node_modules/vitest/vitest.mjs run tests/contract/model.test.ts tests/request/materialize.test.ts --reporter=dot`，2文件100测试，exit0；原输出在 `local/f2-debug-loop-20261013/baseline.stdout.log` 和 stderr.log。不再跑一轮无关全量基线。

本计划账本/任务简报/实现报告/审核快照置于 `.superpowers/sdd/2026-10-13-apicc-f2-debug-loop/`，工具抽取简报后必须追加本计划全局约束和该任务引用的内部接口。当前未提交模式，审核不能使用 `BASE..HEAD` 的空 diff 假装检查：每个任务派发前保存各允许文件内容及 hash，完成后生成带上下文的 before/after 差异，包括新增文件；修复轮相对于上次审核快照。报告引用快照 hash、实际命令、原退出码及日志，而非不存在的提交 SHA。

root 作普通实现决策并记 `Ruling: 决定 — 理由 — 若错误的代价`；只有新产品策略、不能满足版本承诺、需要模型升级、平台阻塞或授权外副作用才询问用户。实现者不再派子智能体，不自行变更本计划。

## 文件边界与交付顺序

| 包 | 文件职责及路径 | 依赖 |
| --- | --- | --- |
| P1 | `domain/primitives.ts`/`contract/request.ts`抽取纯请求Schema以打断TestCase循环；`request/settings.ts`/`request/effective.ts`统一有效覆盖；现有graph/context/clone/secretRefs/credential output、storage/runner消费 | F1 |
| P2 | 新`http/files.ts`捕获可重读文件；`http/body.ts`编码；`http/session.ts`Cookie；`http/response.ts`有界字节/解码；现有client/CaseExecutor/Runner生命周期装配 | P1 |
| P3 | 新`debug/model.ts`观察/意图DTO及Schema；`debug/projection.ts`输出投影；`debug/service.ts`两模式及结果；桌面`main/debugController.ts`启动/等待/取消及原debug.ts集成 | P1–2 |
| P4 | 新`debug/history.ts`文件记录服务；`debug/replay.ts`恢复/重放；桌面`main/debugHistory.ts`私有根装配和共享IPC | P3 |
| P5 | 新renderer/stores/debugHistory.ts及components/DebugSettings.vue、DebugHistory.vue；现有editor/debug/RequestEditor/ResponseViewer/CasePanel；宿主保存和文件选择 | P1–4 |
| P6 | 现有CLI main/credentials/output/workspace接同一服务；集合/流程/压测有效覆盖消费回收，跨入口聚焦 | P1–5 |
| P7 | 必要端到端验证、完整受影响门、Windows验证包、AC矩阵及独立阶段审核 | P1–6 |

此表列修改区域而非要求每个文件机械制造 hunk。已有模块自动消费且证据成立的区域不重复改写；实质遗漏不可用“未改文件”搪塞。新增文件职责不能偷偷并入一个巨大 debug.ts。

## 内部接口契约

P1 是下游接口基准；实现者可调整局部名字但需报告最终签名，root 同步下游简报，不新造第二套同义类型。

```ts
// request/settings.ts：浏览器可加载，不包含 Node/AbortSignal。
interface RequestSettings {
  connectTimeoutMs: number; headersTimeoutMs: number;
  bodyTimeoutMs: number; totalTimeoutMs: number;
  followRedirects: boolean; maxRedirects: number;
  uploadLimitBytes: number; responseLimitBytes: number;
}
type RequestSettingsOverride = Partial<RequestSettings>;
// 相同严格Schema用于JSON；数值finite、positive、integer；maxRedirects 0..10。
// resolveRequestSettings(caseOverride?, invocationOverride?, entryDefaults?)填缺省；
// 旧Runner deps.timeouts的connect/total属于entryDefaults，不是invocationOverride。
// JSON显式调用层另用deps.requestSettings承载；signal和运行端口从不混入JSON。
// getEffectiveCaseRequest(asset, testCase)返回深只读request，不写asset。
// Context.checkGate("execution", contractId, effectiveRequest?)仅执行当前有效请求依赖。
// graph/删除/克隆仍扫描默认请求+全部用例覆盖，不能放宽资产引用约束。
```

执行凭据与管理扫描分开。P1 发布以下 Core 端口，实际桌面宿主在 P3、CLI 在 P6 消费；不是另造系统凭据提供方：

```ts
interface EffectiveCredentialRequest {
  readonly asset: DeepReadonly<ApiAsset>;
  readonly request: DeepReadonly<ApiRequest>;
}
// selectCredentialRequests(snapshot, selections: readonly { asset; testCase? }[])
// 校验asset是snapshot.project中的原对象、testCase是该asset.cases中的原对象，
// 再从已选effective request构造不可变EffectiveCredentialRequest[]；不接受伪复制asset。
// testCase缺失仅取该snapshot默认request，用于已覆盖草稿的临时snapshot。
// collectCredentialRefsForRequests(project, requests)与
// collectCredentialMarkersForRequests(project, requests, bindings)消费同一选择。
// 原selectedAssets入口保留默认request兼容包装，统一复用同一auth收集函数。
// collectDefinedProjectCredentialRefs(project)管理用扫描默认request、全部case覆盖、auth组件；
// 它不用于执行准备，未选中未绑定ref不得阻止有效调用。
```

非HTTP适用性在原始显式override上判断：connectTimeoutMs/totalTimeoutMs沿用既有协议能力，signal仍为宿主取消端口；headers/body/followRedirects/maxRedirects/uploadLimitBytes/responseLimitBytes属本轮HTTP专属，非HTTP显式给出时拒绝。resolve后的HTTP默认字段不能成为拒绝正常WS/SOAP调用的依据。

P2 扩展 ProtocolClient.execute 的 options 为可选运行端口，JSON 设置与内部句柄分开；原只带connect/total的插件调用仍可执行，不要求外部插件实现新HTTP观察能力。

```ts
interface DebugIdentity {
  workspaceId: string; groupId: string; projectId: string;
  collectionId: string; folderIds: string[]; apiId: string;
}
interface DebugCaseIdentity extends DebugIdentity { caseId: string; scope: string }
type FieldState = { path: string; status: "redacted" | "truncated" | "missing"; needsInput: boolean };
type DebugInvocation = {
  locator: DebugIdentity; environmentId?: string;
  settings?: RequestSettingsOverride; parentHistoryId?: string;
} & (
  | { mode: "request"; request: ApiRequest; parameters: Record<string, string>; fields: FieldState[] }
  | { mode: "case"; case: DebugCaseIdentity }
);
// P3 DebugExchange: case/rowIndex/hopIndex/order，transportState，settings，
// 安全请求DTO、响应DTO、timings、failureStage/code；不含句柄/回调/SecretBindings。
// P3 DebugResult: runId、sourceApiRevision、sourceProjectRevision、executionSnapshotRevision、
// mode/locator/environment、run/outcomes、exchanges、exchangeTotal/omitted、安全replay descriptor、warnings。
// P4 HistoryRecord: formatVersion:1/historyId/createdAt/parentHistoryId + DebugResult。
// P3/P4 DTO引用ApiRequest、locator、settings同一纯Schema，禁止任意unknown可执行载荷。
```

### 任务 1：用例覆盖与有效请求基础（P1）

**交付：** 存储并重开完整请求和设置覆盖，Core 按所选用例执行；引用/克隆/凭据及格式1边界闭合。对应 F2-03/04 的 Core 部分，桌面保存事务在任务5。

**文件：** 创建 `packages/core/src/domain/primitives.ts`、`contract/request.ts`、`request/settings.ts`、`request/effective.ts`；修改 `domain/common.ts`、`domain/model.ts`、`contract/model.ts`、`assets/graph.ts`、`assets/context.ts`、`assets/clone.ts`、`assets/secretRefs.ts`、`assets/snapshot.ts`、`credentials/output.ts`、`request/materialize.ts`、`runner/caseExecutor.ts`、`runner/runner.ts`、`schema.ts`、`shared.ts`、`index.ts`；按实质需要修改 `storage/contractFiles.ts`、`workflow/adapter.ts`、`stress/build.ts`、`stress/caseSession.ts`。测试复用 `tests/contract/model.test.ts`、`assets/context.test.ts`、`assets/clone.test.ts`、`credentials/output.test.ts`、`request/materialize.test.ts`、`storage/contractFiles.test.ts`、`runner/caseExecutor.test.ts`，不每个字段另建文件。

- [x] **步骤1：在现有fixture上新增/扩展失败断言。** 下面不是fixture替代品；使用现有 contractFixture/httpRequestFixture/workspaceFixture 组成同样断言；按真实接口写完整可执行测试。

```ts
const asset = contractFixture();
const draft = { ...asset.contract.request, path: "/case-only" };
asset.cases[0] = { ...asset.cases[0]!, requestOverride: draft,
  requestSettingsOverride: { headersTimeoutMs: 1200, followRedirects: true } };
expect(ApiAssetSchema.parse(asset).cases[0]!.requestOverride?.path).toBe("/case-only");
expect(asset.contract.request.path).not.toBe("/case-only");
// 同测试文件补：原无覆盖case可读、非匹配协议拒绝、非HTTP专属设置拒绝，connect/total保留。
// 物化现有fixture：覆盖引用可用/缺失拒绝，未选中坏覆盖不得挡另一有效case。
// 复用clone/secretRef测试：覆盖中ID旋转且依赖闭包保留，无凭据原文。
```

- [x] **步骤2：运行修改的目标 it 确認 RED。** `node node_modules/vitest/vitest.mjs run tests/contract/model.test.ts tests/request/materialize.test.ts --reporter=dot`；应因未知覆盖字段/未消费覆盖失败，而不是导入错误。
- [x] **步骤3：按以下最小路径实现。** 抽取现有请求类型/Schema到纯 `contract/request.ts`，HttpMethod/Protocol/KeyValue基础到primitives；保持所有现有 re-export，不复制请求Schema、不将 fs/keyring带入schema。common 的 TestCase 添加 `requestOverride: ApiRequestSchema.optional()` 和 `requestSettingsOverride: RequestSettingsOverrideSchema.optional()`；ApiAsset 在持有默认request时检查协议及HTTP设置适用，错误定位case/scope。不要从common直接反向静态import model形成初始化环。

```ts
export function resolveRequestSettings(
  caseOverride: RequestSettingsOverride = {}, invocationOverride: RequestSettingsOverride = {},
  entryDefaults: RequestSettingsOverride = {},
): RequestSettings {
  return RequestSettingsSchema.parse({
    connectTimeoutMs: 10_000, headersTimeoutMs: 30_000, bodyTimeoutMs: 30_000,
    totalTimeoutMs: 30_000, followRedirects: false, maxRedirects: 10,
    uploadLimitBytes: 64 * 1024 * 1024, responseLimitBytes: 32 * 1024 * 1024,
    ...RequestSettingsOverrideSchema.parse(entryDefaults),
    ...RequestSettingsOverrideSchema.parse(caseOverride),
    ...RequestSettingsOverrideSchema.parse(invocationOverride),
  });
}
// effective.ts：深只读输入，不改默认contract、不回填字段。
export function getEffectiveCaseRequest(asset: DeepReadonly<ApiAsset>, testCase: DeepReadonly<TestCase>) {
  return testCase.requestOverride ?? asset.contract.request;
}
```

graph抽取同一request引用收集器，覆盖path包含cases[index].requestOverride；clone申明/重写覆盖内部parameter/file-entry/模型/组件/ref并复用逻辑。secretRefs项目遍历及credential output选中执行输入共同覆盖auth；不要为执行一个case准备所有未选中case凭据。context保持全局管理诊断，execution gate可传当前有效请求；materialize从有效request检查/物化，CaseExecutor统一传入，Runner保留选中case及设置。snapshot可选字段undefined白名单同步正式Schema。storage严格load/save保留覆盖字段，无新增迁移。

Schema首次修改前先冻结真实旧loader证据：在既有临时workspace的case YAML直接加入两种覆盖，使用HEAD116194d的fileStorage.load得到problems/readOnly；使用实际loaded.workspace、loaded.revision和deletions:[]调用fileStorage.save，必须拒绝且原YAML字节/hash不变。不要交未知candidate给旧save以Schema提前拒绝替代writeJournal只读门。冻结原日志、HEAD及domain/common/contractFiles/writeJournal源hash；修改后新writer真实save/newloader重开保留覆盖，原无覆盖case仍可读。原TestCase shape helper只能辅助，不能标为旧真实loader动态证据。可在现有storage测试及一次性证据脚本中完成，不新建旧worktree或永久另一套reader。

P1验证settings入口：仍按旧Runner构造timeouts缺省10s/30s时，case保存的connect/total覆盖必须保持；只有deps.requestSettings显式传入不同值才覆盖case。signal单独组合，最终向client合成一次；不能在下游再次把默认timeouts盖回。P1凭据Core证据：默认请求和两个case覆盖有不同ref，selected request只收集自身refs/markers，管理扫描可找所有覆盖ref；宿主真实未绑定/发包在P3/P6执行。
- [x] **步骤4：只跑上述实际修改的现有测试文件，加 `pnpm -C packages/core build` 后 `pnpm -C packages/core typecheck`。** 检查renderer轻入口既有schemaEntry测试及类型导出，源Schema成功不等同包dist已更新。
- [x] **步骤5：自审并写 task-1-report.md。** 包含最終导出签名、consumer调用点、RED/GREEN、未修改区域的消费依据；不提交，交root生成候选快照独立审核。不得将任务5/6/7的跨入口实证写成已完成。

### 任务 2：HTTP 文件、会话和传输设置（P2）

**交付：** 受控本地服务收到multipart/Binary实际字节，Cookie/四种超时/逐跳重定向/取消可用，完整有界响应供Runner。对应 F2-05/06/07、F2-08传输部分。

**文件：** 创建 `packages/core/src/http/files.ts`、`http/body.ts`、`http/session.ts`、`http/response.ts`；修改 `http/client.ts`、`request/body.ts`、`request/materialize.ts`、`plugin/types.ts`、`runner/caseExecutor.ts`、`runner/runner.ts`、`workflow/runner.ts`、`workflow/adapter.ts`、`stress/caseSession.ts`、`index.ts`、`packages/core/package.json`、`pnpm-lock.yaml`；纯Schema增加multipart可选filename时只动 `contract/request.ts`，snapshot可选白名单同步。复用 `tests/http/client.test.ts`、`http/timing.test.ts`、`runner/caseExecutor.test.ts`，必要新 `tests/http/files.test.ts` 汇总文件生命周期；不改脚本引擎。

- [x] **步骤1：扩展既有http服务fixture，RED验证multipart/Binary、重复Set-Cookie、redirect hop以及取消。** 一个端口服务覆盖同origin功能，第二端口仅用于crossorigin；临时小文件，不用大容量真实压测。

```ts
// 真实服务把收到的Buffer送回断言，不以mock证明流已发送。
const chunks: Buffer[] = [];
for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
const received = Buffer.concat(chunks);
expect(received).toEqual(expectedBinary);
expect(observedRequests.map(r => r.method)).toEqual(["POST", "POST"]); // 307
expect(observedRequests[1]!.headers.authorization).toBeUndefined(); // 跨origin另例
// 断言文件流/句柄closed、取消后未新增server hit，而非只assert AbortError。
```

- [x] **步骤2：运行对应目标it记录RED。** `node node_modules/vitest/vitest.mjs run tests/http/client.test.ts tests/http/files.test.ts --reporter=dot`（新文件建立后运行）；unsupported body等真实失败，不允许空测试“补覆盖”。
- [x] **步骤3：装配同一传输链。** 文件端口在CaseExecutor前置脚本之前捕获有效文件引用，按工作区根resolve并打开/检查；内部绑定保留filehandle/stat fingerprint，流每次从同绑定position0创建，autoClose:false，由调用finally释放，重复发送再验证来源。全入口根路径由宿主注入，缺端口明确配置错误。materialize生成文件描述而非读内容；脚本修改未知路径没有已捕获binding即拒绝。multipart编码器按启用项顺序、含空文本/重复名流式生成boundary/filename/type；Content-Type冲突拒绝。

```ts
// 内部资源不得放在ExecutableRequest的可串行化属性或IPC中。
interface CapturedFile {
  readonly sourceId: string; readonly filename: string; readonly size: number;
  openStream(signal: AbortSignal): AsyncIterable<Uint8Array>;
  assertUnchanged(): Promise<void>; close(): Promise<void>;
}
// 上传计数器在调用上下文共享：每次读到chunk先累计，再决定是否继续写入transport。
// 总timeout一个deadline，hop只使用remaining时间；connect/headers/body各独立计时。
```

核对npm包6.0.2许可/engines/exports，用精确依赖且最小lock变更。jar依root+完整project+env session注入，集合/run/VU独立，关闭释放；显式Cookieheader与普通Cookie参数来源要保留区别，后者才同名覆盖jar。Set-Cookie逐条传jar；过期/domain/path/Secure由库处理。

手工redirect循环保留每hop，使用同一total deadline/上传budget；每跳调用既有beforeSend保护（初次也保持），转换方法移除实体头，跨origin剥离认证头/生成query key/显式Cookie且不重套原auth。Location带原auth query值也需删除相应绑定项；可用新origin jar Cookie。307/308同绑定重建，非重复源/变更给规格机器码，保留前跳响应/下一跳未发送诊断。

响应读取同时计编码/解码字节，Node zlib流支持identity/gzip/deflate/br，先根据Content-Type及严格解码建立文本视图；无法可靠text不给伪字符串。ExecutionResponse保持旧插件bodyText兼容，通过可选响应bytes/encoding/text适用标记扩展；pm.response.text/json及bodyJson遇binary给明确不适用，不把undefined当成功。接收超限/编码失败不把partialbody给后置脚本，观察端仍获meta。请求计时至完整body结束，prepare/cleanup不能污染旧timing，所有abort/timer/流/agent cleanup在finally。
- [x] **步骤4：GREEN聚焦测试+Core build/typecheck。** 复用timing/已有连接测试证明pooled/fresh没回退。小limit证明读中超限/解压超限；timer用本地headers/body延时，connect测试复用已有可控连接fixture，不依公共超时IP。报告不能把“协议execute已进入”当“服务端已收到”。
- [x] **步骤5：报告资源所有权、可用端口/observe签名和依赖核对证据，交独立审核。** 不跑无关全套，不提交；若四种timeout某项缺真实验证显式记缺口不能标P2完成。

### 任务 3：Core 调试服务、最终观察与可取消宿主（P3）

**交付：** Core两模式临时快照服务；可投影多行/多hop最终结果，主进程立即返回runId且取消归属正确。对应 F2-01/02/08/11及F2-10身份基础。

**文件：** 创建 `packages/core/src/debug/model.ts`、`debug/projection.ts`、`debug/service.ts`、`apps/desktop/src/main/debugController.ts`；修改 Core `credentials/output.ts`、`events/bus.ts`、`runner/runner.ts`、`index.ts`、`schema.ts`、`shared.ts`，Desktop `main/debug.ts`、`main/ipc.ts`、`main/executionContext.ts`、`main/credentials.ts`、`main/credentialHost.ts`、`main/main.ts`、`shared/types.ts`、`shared/channels.ts`、`shared/ipc-contract.ts`、`preload/preload.ts`、`renderer/src/api/index.ts`、`renderer/src/api/memory.ts`。测试复用Desktop main/debug.test.ts、credentials.test.ts、execution-credentials.test.ts、contract-ipc.test.ts及Core credentials/output.test.ts；新 `packages/core/tests/debug/service.test.ts` 为真正新服务必要聚焦。

- [x] **步骤1：建立RED：零正式case的dirty request发送/两行case收集/启动前准备挂起可取消。** 用服务端hit与Session/磁盘字节不变断言；controlled deferred只用来挂住凭据prepare而非模拟整条发包。

```ts
const before = JSON.stringify(session.view());
const started = controller.start(owner, invocation);
expect(started.runId).toBeTruthy();
controller.cancel(owner, started.runId);
releaseCredentialPreparation();
const completed = await controller.wait(owner, started.runId);
expect(serverHits).toBe(0);
expect(completed.failureKind).toBe("aborted");
expect(JSON.stringify(session.view())).toBe(before);
// owner是主进程event.sender身份，不信任renderer自行传一个owner字符串。
```

- [x] **步骤2：运行新服务/现有debug目标it证明RED。** Core新service文件和Desktop现有debug文件分包运行，每条原生退出码写报告。
- [x] **步骤3：按以下接口实现，不绕开Runner祖先链。** sourceApiRevision stablehash ApiAsset，sourceProjectRevision由正式snapshot，executionSnapshotRevision由替换后snapshot；请求模式从clone项目定位当前API仅替换request/cases临时base，不改正式Session。用例模式按当前环境closest选中effectivecase并记录scope；历史exactcase输入不同scope时拒绝。保留祖先container操作/变量；请求模式无其他case前后置/断言/data，case模式全消费。

```ts
// 桌面host验证Schema/root/完整locator之后调用start；内部map按owner/runId。
// 同步创建AbortController+运行身份；Promise.resolve().then(run)才开始异步准备。
// wait重复读取同一完成结果；cancel无在途返回明确no-active状态，不碰其他run。
// 切root/关闭renderer按本owner回收任务；结果仍只归原root/session。
// 在main/credentialHost.ts现有prepareRun中接入P1的snapshot归属验证/有效请求选择；
// 选中case由当前snapshot环境closest解析，refs及markers同一选择；request模式用临时snapshot默认request。
// 缺失选中ref拒绝且无server hit，未选中缺失ref不阻挡；不绕过原host另建系统库。
// Core debug/service接入该prepareRun、registry、file/session端口。
// Client transport-prepared观察每hop，不能复用beforeRequest伪造最终请求。
```

观察记录包括逐跳真实URL/method/header/Cookie/bodymetadata，行号/完整case/hop/order、进入状态/headersreceived、失败stage/code与实际timings。收集run总行数不只last afterResponse；最多100元数据+合计2MiB摘要仍运行全部行。

 projection固定output DTO，不直接序列化ExecutableRequest/response句柄；已知markers/auth标准表示由F1boundary复用。Byte投影在hex/base64之前按已知合成credential bytes及标准表示判断，命中/不确定metadataonly；文本投影后截断不泄漏跨界fragment。replay descriptor模板/refs独立于展示，有结构化path FieldState；键名/identity冲突降级，不盲stringredact重写ref/locator。字段未完整不向下消费；普通literal掩码不自动needsInput。console/assert/error/filename/warnings一起投影；真实完整response仅内部给脚本/assert，历史不是执行response。
- [x] **步骤4：GREEN服务、IPC合约/现有credentials聚焦；Corebuild后Desktop typecheck/typecheck:vue。** memory API更新类型但不作真实宿主凭据验收。旧 sendDebug 如保留仅桥接case模式，不新增一条HTTP发包链。
- [x] **步骤5：输出已发布内部签名及包含synthetic marker检查的报告，交独立审核。** 桌面UI还未接通如实记为P5依赖，不提前宣称闭环完成。

### 任务 4：应用私有历史与恢复/重放（P4）

**交付：** 可重开、查询、删除/清理的投影历史；查看/恢复/两模式重放不混淆。对应 F2-09/10/11历史部分。

**文件：** 创建 Core `debug/history.ts`、`debug/replay.ts`，Desktop `main/debugHistory.ts`；修改P3的debug/model/projection/service导出、Desktop debugController/main/ipc/main/main/shared/types/channels/ipc-contract/preload/renderer/api/index/memory。必要新 `packages/core/tests/debug/history.test.ts`；复用 `debug/service.test.ts` 和Desktop main/debug.test.ts/contract-ipc.test.ts。

- [x] **步骤1：临时私有目录中RED验证重开、一个validatedcall恰一记录、损坏/写失败和needsInput阻止消费。** 查询不会访问网络；fixture复用P3多行输出，无整套新服务重复搭建。

```ts
const stored = await history.append(result);
const reopened = createDebugHistoryStore({ root: privateTempRoot });
expect((await reopened.get(stored.historyId)).runId).toBe(result.runId);
expect((await reopened.list({ limit: 50 })).items).toHaveLength(1);
expect(serverHits).toBe(hitsBeforeListing);
// replay request有FieldState needsInput应拒绝，mask样式正常literal应可发送。
// deleted API / envscope changed不能改走新API；case replay全部rows而非最后一row。
```

- [x] **步骤2：运行 `node node_modules/vitest/vitest.mjs run tests/debug/history.test.ts tests/debug/service.test.ts --reporter=dot`，记录预期RED。** 无权限模拟用注入storewriter错误避免改变用户目录ACL。
- [x] **步骤3：文件服务实现如下。** privateRoot由Desktop/CLI共用defaultDebugHistoryRoot宿主函数定位（Windows AppData/apicc/debug-history），支持宿主测试注入，禁止从renderer改根；沿起飞前已归档同根配置裁定统一旧userData措辞。索引使用canonicalroot+完整归属hash，不在workspace。record UUID文件，临时写入→rename，不authoritative mutableindex；摘要sidecar可重建，列表分页只读有界meta，按project/API/time/method/result/text筛选。

```ts
// file owner必须是合法UUID记录，delete/cleanup先resolve真实文件路径并校验位于historyRoot。
// mkdir/write/rename失败只产生history warning，不改变已发生的执行outcome。
// record序列化>4MiB：缩减body展示+标记intent incomplete，不截断JSON可执行结构。
// recordread先stat cap，再parse+strict version/schema；未来/损坏保留原件，另diagnostic/quarantine。
// age/count清理只处理有效自有记录；10000硬最大，关闭=不append不清旧记录。
```

按completedvalidatedcall追加一次，含pre-send config失败/cancel；非法IPC不写。异步append与重复wait不能重复写。replay descriptor解析Schema/归属、字段状态guard；request模式生成新invocation，case模式核对exactcase+当前envclosest全运行；parentHistoryId关联新record。restore以selectedexchange生成requestdraft+普通row参数，不带case脚本/assert，保留needsInput；源revision变更提示currentresources，并始终当前凭据/文件重新解析。locator被删view仍可用，execute拒绝。修复字段后只清对应状态，清全部/用mask替代不算补齐。

历史配置同服务根私有 `config.json`，非项目资产。新严格纯JSON HistoryPreferencesSchema = `{ enabled:boolean, retentionDays:positive finite integer, maxRecords:positive integer <=10000 }`，缺文件使用true/30/1000。host提供getPreferences/updatePreferences，原子保存后服务采用该配置，关闭后既有记录可查看且不append/retain。未来/损坏配置保留原件并诊断，暂不append/retain，不影响网络结果；通过显式设置更新恢复。Desktop与CLI都使用同一个defaultDebugHistoryRoot宿主函数（在Windows按应用私有AppData/apicc/debug-history定位，支持测试注入），不要分别采用不同默认根导致配置互不相干。renderer不能指定根。
- [x] **步骤4：GREEN历史新服务+相关P3目标it，Corebuild后Desktoptypecheck。** 验证多个store实例append不覆盖，损坏原文仍在，body不常驻列表；用小limits验证retain，禁止为了测试真写10000个大文件。
- [x] **步骤5：报告容量/保真边界和原退出码，交独立审核。** 不偷偷把 `.apicc/runs` 改历史，不把原件占用告警当已控整个目录空间。

### 任务 5：桌面调试、历史及显式保存体验（P5）

**交付：** 普通用户可走草稿发送→观察→历史→恢复/重放→保存契约/用例；文件、会话设置及取消可操作。对应 F2-01/02/03/08/09/10/11 UI与事务。

**文件：** 创建 `renderer/src/stores/debugHistory.ts`、`renderer/src/components/DebugSettings.vue`、`DebugHistory.vue`；修改Desktop `stores/editor.ts`、`stores/debug.ts`、`stores/cases.ts`、`components/RequestEditor.vue`、`ResponseViewer.vue`、`CasePanel.vue`、`ConnectionPanel.vue`、`App.vue`、`main/session.ts`、`main/ipc.ts`、`main/debugController.ts`、`shared/types.ts`、`shared/ipc-contract.ts`、`shared/channels.ts`、`preload/preload.ts`、`renderer/src/api/index.ts`、`api/memory.ts`、`i18n/zh-CN.json`、`i18n/en.json`。复用Desktop `tests/renderer/stores/debug.test.ts`、`editor.test.ts`、`cases.test.ts`、`components/components.test.ts`、`contractAssets.test.ts`、`CasePanel.test.ts`、`main/session-transactions.test.ts`、`main/contract-ipc.test.ts`。只若当前组件测试没有宿主挂载入口才新增一个DebugHistory组件文件。

- [x] **步骤1：更新旧“dirty发送先保存”的断言为批准行为并RED。** 不删脏草稿/迟到结果保护，保留回归；增加保存事务同Sessionrevision及协议切换覆盖检查。

```ts
await debug.send(editor);
expect(api.apiSave).not.toHaveBeenCalled();
expect(api.debugStart).toHaveBeenCalledWith(expect.objectContaining({ mode: "request" }));
expect(editor.dirty).toBe(true);
// 宿主真实Session：sourceApiRevision来自草稿加载时，别处改case后旧保存应冲突。
// 改协议而已有不兼容override时拒绝+CaseLocator；磁盘和draft保持，不能cascade删case。
```

- [x] **步骤2：聚焦既有debug/editor/session目标it证明RED。** 不重写所有memory store fixtures，不用纯memory证明宿主加密存取。
- [x] **步骤3：接P3/P4宿主能力。** editor保留加载sourceApiRevision/sourceProjectRevision，草稿独立于session已存内容；dirty发送没有api.save和firstcasefallback。请求/用例按钮明确，case覆盖显示独立/移除继承。start即得runId、await结果、可cancel；results按root/fullApiLocator/generation归属、runEpoch只释放自己的sending；打开其他API不串result。

```ts
// 新宿主保存方法通过同一个Session.mutate事务完成，绝不先比较再异步调用普通save形成TOCTOU。
// saveRequestDraft(locator,request,expectedSourceApiRevision):仅替换request；
// saveDraftCase(caseLocator,input,expectedSourceApiRevision):明确创建/覆盖一个case。
// 事务内hash当前正式ApiAsset与expected比较，case变化也冲突；随后storage expectedRevision照旧。
// host再验已知凭据literal/needsInput/协议/settings；不能只renderer验。
```

用filechooser仅返回用户选文件的ref/元数据，渲染器无fs。multipart禁用/重复/filename/type和Binaryref编辑接通移除unsupportedbadge。设置面板四timeout/follow/budgets展示，Cookie查看/清空host投影；保存case说明jar不持久化。

ResponseViewer分实际请求/response/header/cookie/assert/console；支持Raw/Pretty JSON/XML/Text、literal搜索、复制/下载，HTML仅文本，不注入HTML执行或加载资源。二进制经P3投影DTO已允许内容才boundedhex，下载通过host/安全已投影内容，明确截断/脱敏/旧文本观察。结构无可信字节不伪造rawfile。失败/meta长度按unknown显示不填0。

历史可分页过滤/显式deleteclear确认；view无send，restore dirtyconfirm+exchange选择+模式切request、needsInput展示并字段级补齐；replay用当前环境/refs并显示sourcechanged。未绑定missingcredential不要降级无auth；不恢复自由请求或全多tab重构。各按钮和错误/i18n对齐，维持已修顶栏/局部ALayout边界及三种主题。

DebugHistory内提供历史enabled/retentionDays/maxRecords简短设置入口，消费P4真实host通道；重开可读设置，关闭保留已有记录，说明配置属于本机应用而非项目。复用P4小限额/host测试证明配置实际改变append/retain，不新增通用设置框架。
- [x] **步骤4：GREEN受影响renderer/main测试、Desktoptypecheck/vue、rendererbuild。** 复用App已存workflow布局目标it一次，不整套主题像素矩阵。history和ResponseViewer功能尽量合并现有component场景。
- [x] **步骤5：报告实际IPC/保存事务、UI行为/未验证点，交独立审核。** 只读工作区拒绝所有保存，不让debug查看行为把readOnly强制解除。无真实Electron包不能声称P7完成。

### 任务 6：CLI 与集合/编排/压测真实消费闭合（P6）

**交付：** CLI本地debug请求或case，经相同Core发包、当前环境凭据、历史和设置；已有run入口同样消费已存覆盖。对应 F2-03及跨入口工程验收。

**文件：** 修改 `packages/cli/src/main.ts`、`credentials.ts`、`output.ts`、`workspace.ts`、Core `workflow/runner.ts`、`workflow/adapter.ts`、`stress/build.ts`、`stress/caseSession.ts`、`stress/runner.ts`、Desktop `main/ipc.ts`（真实runWorkflow装配）、`main/debug.ts`、`main/stress.ts`，限真实缺口；说明 `README.md` 的新CLI用法。复用 CLI `tests/contract-assets.test.ts`、`e2e.test.ts` 及Core workflow/runner.test.ts、workflow/adapter.test.ts、stress/caseSession.test.ts、Desktopmain/debug.test.ts。

- [x] **步骤1：复用本地echo服务和真实workspace fixture，RED一个已存覆盖通过CLI运行。** 三包单次/集合/流程/单迭代压测可共用核心场景和相同初始会话，不能把各入口重复几十个功能矩阵。

```ts
// 用例默认path=/default，override=/override，settings有短headers timeout。
expect(serverPaths).toContain("/override");
expect(serverPaths).not.toContain("/default");
expect(reloaded.contract.request.path).toBe("/default");
// CLI subprocess实际exit及stdout检查；未绑定凭据拒绝且serverhits不增加。
```

- [x] **步骤2：按真实CLI options组装debug命令，记录RED。** `node node_modules/vitest/vitest.mjs run tests/contract-assets.test.ts --reporter=dot`；subprocess使用本阶段Node22，不落到系统Node24。
- [x] **步骤3：新增CLI `debug`入口。** 新debug命令新增--root（缺省沿用cwd定位，不改旧命令）、完整项目/API定位/环境解析；`--request <json-file>`表示已绑定API的请求草稿，`--case <id> --scope <scope>`显式case，二者互斥；settings JSON参数经同Schema，--no-history允许关闭本次历史，输出投影JSON和failure exit，CLI取消信号清理运行。允许新增options保持既有命令兼容，不支持游离自由请求。API/项目歧义明确错误，不凭同名猜定位；文件基于workspace root而非CLI cwd，历史根来自宿主私有目录，无Electron启动/nativeprovider导入schema。

```ts
// pipeline：load workspace -> locate exact API -> capture snapshot -> resolve environment ->
// DebugInvocationSchema.parse -> prepare current credentials/files/session -> Core debug service ->
// output projection -> history append -> emit CLI JSON+exit status。
// caseSelection保持nearestscope；--scope与实际effective不一致给清晰错误。
```

检查runCollection/workflow/VU/CLI的覆盖settings层级、文件端口根和每runjar ownership；只补真实缺口，不能写桌面专用判定或改压测算法/计时。相同输入/初始会话验证有效request，jar登录态本来不同不作为失败。README只写实际命令/支持限制，不提参考品牌。

CLI prepareExecutionRun改用P1 snapshot归属/有效选择refs及markers；findProjectCredentialRef等管理lookup使用collectDefinedProjectCredentialRefs，不把管理全refs用于执行。验证覆盖独有ref可管理绑定，未选中未绑定ref不阻挡、选中缺失ref无serverhit。历史采用P4同根配置，提供 `debug-history config --enabled <boolean> --days <positive-int> --max-records <1..10000>` 查询/更新同一preferences，原 `--no-history`只禁用本次，不改变持久配置或重启已关闭历史。
- [x] **步骤4：GREEN CLI真实consumer、Core受影响adapter/caseSession、CLIbuild。** 不触发CLI test脚本重复整Corebuild多轮；只最终检查dist后目标Vitest。
- [x] **步骤5：报告各入口收到有效请求/设置和未做功能，交独立审核。** 未接任何入口不以“共享CaseExecutor所以肯定可用”当实证。

### 任务 7：阶段集成、审核与 Windows 验证包（P7）

**交付：** F2-01..12矩阵可追溯，受影响构建门、独立阶段审核和新Windows包；交用户检查，不自动Git集成。

**文件：** 仅补前6任务真实集成缺口及已有测试；新增 `local/f2-debug-loop-20261013/acceptance.md`、`verification.md`、原stdout/stderr、独立package目录。无新功能层/测试框架。

- [x] **步骤1：汇集前6报告/审查、逐条核对AC，不重复跑已覆盖的同候选聚焦。** AC03必须重开存储再验证执行，不只memory。AC04旧严格reader动态/静态证据不能替代真实write/load；root明确两种证据区别。开放Minor/无法核实项集中列明，实际缺口给同一开发者一次补齐。
- [x] **步骤2：必要集成RED/GREEN复用前面fixture。** 主链：无case接口编辑dirty→真实IPC发送→history重开→restore→savecase→reopen→CLI/集合/流程/单迭代执行；response/meta/download projection用同一合成凭据。CLI与Electron如不能共用hostfixture分别说明，不制造全平台外部验证。
- [x] **步骤3：一次阶段整体工程门，以下按顺序执行并分别保留退出码。** Core dist是入口类型消费前置，Desktopbuild自己含类型门。

```powershell
pnpm -C packages/core build
pnpm -C packages/core typecheck
pnpm -C packages/cli build
pnpm -C apps/desktop build
# Core本阶段源引擎未改：现有suite中延期sandbox专项不作为新验收；
# 实际Vitest命令使用 --exclude tests/sandbox/**，报告明确范围。
# Core其余全部、CLI全部；Desktop本地main/renderer范围排除online/server-e2e。
node scripts/check-brand-neutral.mjs --self-check
node scripts/check-brand-neutral.mjs
node scripts/check-contract-assets.mjs
git diff --check
```

Core `node node_modules/vitest/vitest.mjs run --exclude 'tests/sandbox/**' --reporter=dot`；CLI `node node_modules/vitest/vitest.mjs run --reporter=dot`；Desktop `node node_modules/vitest/vitest.mjs run tests/main tests/renderer --exclude 'tests/main/online/**' --reporter=dot`。未跟踪新增源码/设计/计划按品牌词表显式扫描，不能只靠git ls-files漏扫。失败保留原结果、只增量修复复验，不整个门从头反复跑；不称这些范围替代CI全部Java/online。
- [x] **步骤4：root分派一次Sol xhigh整阶段审核，开发者集中处理完整发现清单，复审仅修复候选增量。** 候选文件hash可对账；不能用空提交diff。遇必须升级开发模型先询问用户，不能技能自动换强模型。所有残留重要缺口必须显式处理，不为赶进度静默验收。
- [x] **步骤5：真实Windows包独立产出，不覆盖旧release。** 从apps/desktop运行 `pnpm exec electron-builder --dir --win --x64 --config.directories.output=../../local/f2-debug-loop-20261013/package`。检查exe和asar中renderer/electron/preload与当前build一致，新增依赖可打入；既有smoke-dir硬编码release不能偷指旧包验收。最小调整脚本支持可选packageDir/绝对exe参数（原默认保持）后运行同一冒烟；正常测试helper隐藏窗口，用户人工检查时给路径。
- [x] **步骤6：真实Electron临时工作区验证启动、bridge、dirty发送、history重开/保存case，不用纯browser-memory冒充。** 复用已有打包CDP/IPC验证方式，可用受控临时根及本地server，禁止写用户活动项目/凭据。失败如具体平台不能自动UI实证，交付包并明确让用户检查哪些点，不谎称PASS。
- [x] **步骤7：归档最终AC矩阵、风险/限制及验证包路径，等待用户单独提交/合并/推送指令。** 保留F1旧开放项、macOS/Linux未验和F2未纳入能力；不称整个产品/整个F2完成。

2026-10-15 P7代码/审核/验证包交付已完成，非全产品或人工验收通过。最终候选为`package-final-fix2`；原六项Important经集中修复与用户批准的R1追加修复全部关闭，累计C0/I0/M3。步骤2证据按Core/各入口/packaged bridge分流，不声称真实RequestEditor打字/dirty/发送按钮已验；步骤3原CLI/Desktop aggregate native1保留，实际缺口按增量复验，没有新的整套PASS。最终审核及人工待验、容量、平台限制见`local/f2-debug-loop-20261013/acceptance.md`、`final-open-items.md`、`manual-checks.md`；不自动Git集成或删除工作树/原证据。

## 规格覆盖自检

| 规格 | 实现/证据任务 |
| --- | --- |
| §1范围/§2同一执行链 | P1/P3/P6，P7声明未纳入功能 |
| §3.1草稿快照/revision/start-wait-cancel | P3服务/P5草稿保存及事务 |
| §3.2两模式/环境scope/祖先及行语义 | P1有效选择/P3/P4case重放/P6 |
| §3.3保存/覆盖/settings/协议N1/格式1/引用 | P1存储图闭包/P5同事务/P6/P7重开 |
| §4文件/binding/预算/307重读/元数据 | P2/P3/P5filechooser/P6宿主注入 |
| §5Cookie/超时/保护/取消/计时 | P2/P3controller/P5/P6run/VU |
| §6最终多hop观察/接收bytes/全文assert/二进制投影/查看 | P2/P3/P5/P7 |
| §7存储/分页/保留/损坏/needsInput/精确身份/多行重放 | P3DTO/P4/P5/P6 |
| §8工作包/§9 F2-01..12 | P1..P7，最终acceptance逐行日志引用 |
| §10限制/§11预审处置 | 本计划全局约束/P7交付开放项 |

本表是计划覆盖而非验收完成。任务是否完成仅以报告、候选hash、独立审核和所需实证为准。
