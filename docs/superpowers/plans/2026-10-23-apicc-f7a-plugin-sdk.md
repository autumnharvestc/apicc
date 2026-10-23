# F7a 插件 SDK V1 与扩展接入实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 在隔离 worktree 逐任务实施；root 调度，开发 GPT-6.1 Sol high，独立审核 GPT-6.1 Sol xhigh。不得派嵌套智能体或自行升级 max。复选框表示实际完成，不表示已批准即完成。

**目标：** 独立 SDK、静态版本准入、贡献事务及跨宿主消费形成生成插件到实际使用的闭环。

**架构：** SDK 只含公开纯数据契约与作者工具；Core 提供适配、catalog、暂存注册和文件加载。CLI/桌面消费同一加载事实及运行身份，保留既有请求、报告和存储实现。

**技术栈：** TypeScript/ESM、Node >=22.19.0、pnpm 11.21.0、现有 Vue/Electron/Vitest；Java 21 仅用于现有集成门禁。Core 显式声明现有锁定 semver 7.8.5，不升级其他依赖。

**规格：** [F7a 设计与 AC01–12](../specs/2026-10-23-apicc-f7a-plugin-sdk-design.md)。上位 PLUG-001–006 仅按该设计限定的非脚本范围落实。

**基线/归档：** `66e617e816e8566717b547ee2cfe3f7470e638d3`，用户确认 CI 通过。复用已登记独立工作树 `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，分支 `codex/f7a-plugin-sdk`。T1–T6已完成，逐任务及最终独审问题已关闭；两处历史TDD偏差经用户确认保留并如实记录。最终产品候选`task-6-final-candidate`（870文件），Windows最终包c04df9；完成状态文档更新与运行源码身份分别留证。门禁为首次失败后定向修正/续跑的完整覆盖，不伪称单次test-all退出0。未授权提交、合并、推送；不删除工作树或未提交证据。

## 全局约束

- API 主版本 1、SDK 包 0.1.0，宿主产品版本来自组合根 package.json，当前 0.1.0；不得混用三个版本。
- SDK 不依赖/re-export Core、内部 workspace/资源句柄、Electron/Pinia；Core→SDK，不建立反向依赖。
- 五类外部贡献：protocol/auth/assert/importer/reporter；scriptEngine/storage 不纳入外部 SDK V1，不重写或删除内置旧能力。
- 只加载用户主动登记的本机插件；不从项目/导入资产自动安装或加载，无插件不影响本地核心。
- 不兼容、静态冲突在 import/setup 前拒绝；setup 事务失败无贡献残留，不回滚任意受信代码的外部副作用。
- 协议/认证仅现有 kind 与显式用户绑定，默认内置；协议经真实宿主 transport 委托，不建第二 HTTP/计时/门禁实现。
- DEF-001 无限期延期、到达率 B 低优先级不实施；不混入 AI、在线增强、服务端调度、市场、热重载。
- [页面规范](../../ui-presentation-guidelines.md) 为设计/实现/审核约束：中文/英文、单位、可读原因、长内容局部滚动，原始清单次级折叠。
- 迭代只做最小受影响 RED/GREEN；不删用例、不增 timeout 求绿，不做所有排列测试。审核者不重复开发者同输入测试。
- 最终一次全量与一次新包联验，不逐任务全包重跑；完整证据含 cwd/argv/stdout/stderr/exit、候选提交或源码身份，失败原件保留。
- 阶段内连续推进，仅公开接口/范围重大调整、新授权、延期依赖或确切阻塞再询问用户，并说明需要用户做什么。

## 文件与接口地图

| 文件 | 职责/任务 |
| --- | --- |
| 新 `packages/plugin-sdk/{package.json,tsconfig.json,tsconfig.build.json}`、`src/{index,types,manifest,testing}.ts` | T1：纯公开 SDK、元数据/配置、作者契约工具 |
| 新 `packages/plugin-sdk/tests/contracts.test.ts` | T1：一个新包的必要契约/真实回调测试，不按文件拆测试组 |
| 新 `core/src/plugin/{catalog,sdkAdapter,sdkViews}.ts`，改 `plugin/{registry,types}.ts` | T2：暂存事务、适配、DTO 投影，内置注册面保留 |
| 新 `core/src/plugins/{manifest,compatibility,runtime}.ts`，改 `plugins/{loader,types}.ts` | T3：静态来源/版本准入、同源加载报告、运行身份 |
| 改 `core/src/{index,shared}.ts`、包依赖/锁文件、CI 与本地整合门禁 | T1/T3：依赖顺序与公共导出，不向 browser 入口漏 Node 加载器 |
| 改 `cli/src/{main,stressPlanCommand}.ts`、`desktop/src/main/{ipc,stressController}.ts`、`main/plugins/{runtime,fixture}.ts` | T4：组合根与实际运行接线，替换旧贡献旁路计数 |
| 改 `desktop/src/shared/plugins/contract.ts`、现有 plugins store/API/视图/i18n | T4：状态/版本/贡献/绑定/可读诊断 |
| 改 `cli/src/create-plugin.ts`、`docs/plugins.md`，新 `examples/plugin-sdk-v1/` | T5：静态清单、SDK 作者闭环，示例不是市场服务 |
| 现有 registry/loader、CLI plugins/create-plugin/stress-worker、Desktop plugins/session 测试 | T2–T5：复用受影响夹具；只有 SDK adapter 的新纯边界需新 `core/tests/plugin/sdkAdapter.test.ts` |
| 新 local 阶段交付记录，必要 `desktop/electron-builder.yml` | T6：新包纳入 SDK 产物、集中验收与 AC 证据 |

表中 core/cli/desktop 分别为 `packages/core`、`packages/cli`、`apps/desktop`；下文路径以仓库根为基准。

### 公共接口冻结

以下是实施时必须保持一致的接口名/语义；具体类型定义放 SDK，不让后续任务自行改名。JsonObject/JsonValue 是 JSON 树，ReadonlyJsonObject/ReadonlyJsonValue 是递归只读树。

```ts
type CapabilityV1 = "protocol" | "auth" | "assert" | "importer" | "reporter";
type ContributionIdV1 = `${string}/${CapabilityV1}.${string}`;
type ProtocolKindV1 = "http" | "websocket" | "soap";
type AuthKindV1 = "bearer" | "basic" | "apikey";
type ConfigFieldV1 =
  | { type: "string"; required?: boolean; default?: string }
  | { type: "number"; required?: boolean; default?: number }
  | { type: "boolean"; required?: boolean; default?: boolean }
  | { type: "enum"; values: readonly string[]; required?: boolean; default?: string };
interface PluginManifestV1 {
  manifestVersion: 1; id: string; name: string; version: string; apiVersion: 1;
  engines: { apicc: string }; entry: string;
  capabilities: readonly CapabilityV1[];
  contributions: readonly { kind: CapabilityV1; id: ContributionIdV1 }[];
  configSchema?: { fields: Readonly<Record<string, ConfigFieldV1>> };
}
interface PluginDefinitionV1 {
  manifest: PluginManifestV1;
  setup(context: PluginSetupContextV1): void;
}
interface PluginSetupContextV1 {
  readonly config: ReadonlyJsonObject;
  register(contribution: PluginContributionV1): void;
}
// definePlugin 保留泛型推导；运行时准入仍由静态加载器负责。
declare function definePlugin<T extends PluginDefinitionV1>(definition: T): T;
```

`PluginContributionV1` 是以下五种具体接口的判别联合，各自有 kind/id/可选 label；禁止用 `{kind:string, handler:unknown}` 混过所有分支：

```ts
interface AssertionResultV1 {
  pass: boolean; message: string; kind?: "config" | "assertion";
  code?: string; differencePath?: string; schemaPath?: string;
}
interface AssertionContextV1 {
  found: boolean; options?: ReadonlyJsonObject; schema?: ReadonlyJsonValue;
  getModel(id: string): ReadonlyJsonValue | undefined;
}
interface AssertContributionV1 {
  kind: "assert"; id: ContributionIdV1; label?: string;
  descriptor?: { targets?: readonly string[]; expectedFormat?: "text" | "pattern" | "integer" | "json" | "jsonArray" | "xpath" | "none"; expectedRequired?: boolean };
  evaluate(actual: ReadonlyJsonValue | undefined, expected: string | undefined,
    context: AssertionContextV1): AssertionResultV1;
}
interface ImportDiagnosticV1 { code: string; ownerId: string; path: string; reason: string; targetId?: string }
interface ImporterContributionV1 {
  kind: "importer"; id: ContributionIdV1; label?: string;
  detect(fileName: string, content: string): boolean;
  parse(content: string): { formatVersion: 1; project: JsonObject;
    diagnostics: ImportDiagnosticV1[]; warnings: string[] };
}
interface ReportViewV1 {
  formatVersion: 1; kind: "collection" | "workflow" | "suite"; title: string;
  startedAt: string; finishedAt: string;
  rows: { total: number; passed: number; failed: number; skipped: number };
  logical?: { total: number; passed: number; failed: number; skipped: number };
  requestFacts?: { started: number; completed: number; httpExchanges: number };
  cases: readonly ReadonlyJsonObject[]; diagnostics: readonly string[];
  details?: ReadonlyJsonObject;
}
interface ReporterContributionV1 {
  kind: "reporter"; id: ContributionIdV1; label?: string;
  render(report: Readonly<ReportViewV1>, outDir: string): Promise<string>;
}
```

RequestViewV1/ResponseViewV1 的初始完整定义如下。ReadonlyJsonValue 在实际源码中递归声明，不把 Readonly<JsonObject> 当成深只读；不能把 RuntimeBody/RuntimeAuth/HttpExecuteOptions 从 Core 引入来代替。

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject { [key: string]: JsonValue }
type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJsonValue }
interface RequestFileViewV1 { readonly fileRef: string; readonly filename?: string; readonly sizeBytes?: number }
type RequestBodyViewV1 =
  | { readonly kind: "json" | "xml" | "raw"; readonly content: string }
  | { readonly kind: "form"; readonly form: readonly { readonly key: string; readonly value: string }[] }
  | { readonly kind: "binary"; readonly file: RequestFileViewV1; readonly contentType: string }
  | { readonly kind: "multipart"; readonly entries: readonly (
      | { readonly kind: "text"; readonly name: string; readonly value: string }
      | { readonly kind: "file"; readonly name: string; readonly file: RequestFileViewV1; readonly filename?: string; readonly contentType: string }
    )[] };
interface RequestCommonV1 {
  readonly url: string; readonly headers: Readonly<Record<string, string>>;
  readonly query: readonly { readonly key: string; readonly value: string }[];
}
type RequestViewV1 = RequestCommonV1 & (
  | { readonly protocol: "http"; readonly method: string; readonly body?: RequestBodyViewV1 }
  | { readonly protocol: "websocket"; readonly message?: string }
  | { readonly protocol: "soap"; readonly method: "POST"; readonly envelope: string; readonly soapAction?: string }
);
interface ResponseViewV1 {
  readonly status: number; readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string; readonly timeMs: number;
  readonly bodyBytes?: Uint8Array; readonly textAvailable?: boolean; readonly jsonAvailable?: boolean;
  readonly rawHeaders?: readonly (readonly [string, string])[];
  readonly encodedBytes?: number; readonly decodedBytes?: number; readonly declaredLength?: number;
}
```

```ts
type AuthValueV1 =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "apikey"; name: string; placement: "header" | "query"; value: string };
interface AuthContributionV1 {
  kind: "auth"; id: ContributionIdV1; label?: string;
  supports: readonly AuthKindV1[];
  apply(request: Readonly<RequestViewV1>, auth: Readonly<AuthValueV1>): {
    headers?: Readonly<Record<string, string>>;
    query?: readonly { key: string; value: string }[];
  };
}
interface ProtocolContextV1 {
  signal?: AbortSignal; runId?: string; vuId?: string;
  transport: { execute(request: Readonly<RequestViewV1>): Promise<ResponseViewV1> };
}
interface ProtocolContributionV1 {
  kind: "protocol"; id: ContributionIdV1; label?: string;
  supports: readonly ProtocolKindV1[];
  execute(request: Readonly<RequestViewV1>, context: ProtocolContextV1): Promise<ResponseViewV1>;
}
type PluginContributionV1 = AssertContributionV1 | ImporterContributionV1
  | ReporterContributionV1 | AuthContributionV1 | ProtocolContributionV1;
```

Core 内部新增 `createPluginCatalog()`，提供 `begin(manifest,config)`；事务提供 `context`、`commit()`、`abort()`。catalog 的 `summary()`、`contributions()` 均从已提交记录派生；getters 不返回可变内部 Map。`installSdkContributions(registry,catalog,bindings)` 在 host 装配时连接外部解析器，使 registry 从 catalog 同一状态查询适配器，不是提交后逐项复制到另一组 Map。适配器和索引在 commit 前验证完成，一次发布新 catalog 状态；不把 SDK 回调直接伪装成内部对象。

Core `createUserPluginHost({hostVersion,homeDir?,enabled?,registry?})` 暴露异步 `registry()`、`summary()`、`snapshot()`；同一 host 只加载一次。可选内部 `registry:PluginRegistry` 用于保留 CLI 既有调用方注入的宿主能力，不注入则创建默认 registry；不复制注册表、不建立第二 catalog，worker replay 不接收该注入。`snapshot()` 返回纯 `PluginRuntimeSnapshotV1`：必需 pluginRuntimeVersion=1/enabled/hostVersion/digest/entries/bindings，entries 固定 source、pluginId、version、apiVersion、manifestDigest、entryDigest、规范化 config。只在私有 worker prepare 中含配置，不公开在 IPC 插件摘要。`assertPluginRuntimeSnapshot(expected,actual)` 在执行前比较身份。

用户配置中的逐项 disabled 来源在同一次加载中收集为不含 config 的可选摘要列表，不为界面再次读取清单或探测禁用插件文件；全局关闭只显示关闭提示，不读用户目录。该信息不进入启用项快照，也不承诺恢复禁用插件的元数据。

普通 case 的内部执行依赖允许可选宿主 transport：run/VU 已有 owner 时直接传入原 managed client；没有 owner 且实际选用 SDK 绑定时，在该 case 惰性创建既有 HTTP/SOAP 委托并 finally 关闭自己创建的 client，不关闭外部传入对象。不改变原 httpSession/cookies/network/files/observer/gate/signal/timeout；内置未绑定路径不动。默认普通 case 不承诺跨 case 连接池复用，保留可选输入供未来共享；WebSocket 保持原单请求关闭语义，不增加全局 HTTP fallback。

SDK reporter本阶段由原可自由选择registry格式ID的CLI collection/workflow入口实际消费；suite plan.reporters与桌面原html/json/junit枚举/选择器不扩。不能把第三参接线或列表显示当套件/桌面可选SDK格式的证据；文档交付明确限制，套件断言仍须实际接入。

Node-only 内部 companion：`createUserPluginHostFromSnapshot(expected: PluginRuntimeSnapshotV1, options: {hostVersion: string; importFn?: PluginLoaderOptions["importFn"]}): UserPluginHost`。实际 hostVersion 由当前组合根传入，和 expected 不符须 import 前失败；仅按固定绝对清单来源/规范化 config/bindings 重建，不读 HOME 清单。复用 memoized 加载与身份断言，确认前不允许 registry 消费；T4 ready 前再显式检查。清单/入口摘要读取时可先和 expected 核对，不引入 npm 全依赖闭包平台或公开 SDK 新字段。

内部v3 failure.code只允许worker-failed与plugin_runtime_mismatch；仅确切身份错误按后者返回，父端保留机器code，其余异常不带原消息/config/stack。envelope/协议版本不变，协调器与worker须同候选；用原worker用例的诊断丢失先RED后修，不开放任意错误帧。

legacy失败保持原退出码1+numeric报告，已识别prepare error.code仅将完整常量plugin_runtime_mismatch保留到原shardErrors.error；numeric-only投影精确允许该字面量，其他继续worker_incomplete_rich_output_withheld，不改rich/marker策略/字段/版本，不改成throw或复制任意原异常消息。

### 共用合成 fixture

T1/T2 的 demoManifest 只声明一条断言，不能直接取设计中声明了断言和 reporter 两项的演示清单，否则测试自身会因漏注册失败：

```ts
const demoManifest: PluginManifestV1 = {
  manifestVersion: 1, id: "example.demo", name: "apicc-plugin-demo", version: "0.1.0",
  apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./dist/index.js",
  capabilities: ["assert"],
  contributions: [{ kind: "assert", id: "example.demo/assert.has-field" }],
};
const demoAssert: AssertContributionV1 = {
  kind: "assert", id: "example.demo/assert.has-field",
  evaluate(actual, expected) {
    const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
      && expected !== undefined && Object.hasOwn(actual, expected);
    return { pass, message: pass ? "包含字段" : "缺少字段" };
  },
};
```

此为测试 fixture；生产元数据与校验函数仍只在 SDK 一份实现。合成文件/目录只建于测试临时根。

## 任务 1：独立 SDK、契约工具与构建拓扑

**文件：** 创建 `packages/plugin-sdk/package.json`、两份 tsconfig、`src/{index,types,manifest,testing}.ts`、`tests/contracts.test.ts`；修改 Core 的 SDK workspace 依赖、锁文件、`scripts/test-all.ps1`、`.github/workflows/ci.yml` 的 producer 顺序；CLI 独立 test 前置构建补齐 SDK。

- [x] **1. RED：** 在唯一 SDK 契约测试中导入真实 definePlugin、checkPluginContract；用 has-field 实际结果和一次缺 required config 证明行为，不测简单字段存在。首次未实现导入/校验失败保留。

```ts
const check = checkPluginContract(definePlugin({ manifest: demoManifest, setup(ctx) {
  ctx.register({ kind: "assert", id: "example.demo/assert.has-field",
    evaluate(actual, expected) {
      const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
        && expected !== undefined && Object.hasOwn(actual, expected);
      return { pass, message: pass ? "包含字段" : "缺少字段" };
    } });
} }), { config: {} });
expect(check.ok).toBe(true);
const operator = check.contributions.find(value => value.kind === "assert");
expect(operator?.kind).toBe("assert");
if (operator?.kind !== "assert") throw new Error("assert contribution missing");
expect(operator.evaluate({ value: 1 }, "value", { found: true, getModel: () => undefined }).pass).toBe(true);
expect(operator.evaluate({}, "value", { found: true, getModel: () => undefined }).pass).toBe(false);
```

- [x] **2. SDK 实现：** 完整定义上述类型及 Request/Response/JSON DTO；definePlugin 不加载任何宿主；manifest/config 校验与 /testing 共享同一纯校验函数。`checkPluginContract` 返回 `{ok,problems,contributions}`，运行同步 setup 的临时收集器并检查声明集；异步 setup 不当成功处理。SDK 无运行时第三方依赖。
- [x] **3. 包与拓扑：** package name=`@apicc/plugin-sdk`、version=`0.1.0`、ESM，exports `.`→dist/index.js+d.ts、`./testing`→dist/testing.js+d.ts；files 仅 dist/README/LICENSE。build=`tsc -p tsconfig.build.json`，typecheck=`tsc --noEmit`，test=`vitest run`；build 仅 src，typecheck 覆盖 src/tests。保持 Node/pnpm/Vitest 现有版本，不另下载新工具链。
- [x] **4. producer 顺序：** 本地门禁及 CI 在原 Core build 前加入 SDK build/typecheck；保留 Core 先 build 再含 tests typecheck 的既定顺序。CLI test 的原独立 Core/build 前置增加 SDK producer，不能要求作者/干净 CI 恰好有旧 dist。不借机重写 Java/打包 jobs。
- [x] **5. GREEN：** `pnpm -C packages/plugin-sdk build`、`typecheck`、`exec vitest run tests/contracts.test.ts --maxWorkers=2`，保留命令/完整输出/退出码。自审 SDK 构建声明的依赖闭包。暂不全仓构建或 npm 发布。
- [x] **6. 审核与记录：** root 安排独立任务审核，确认公开契约与规格对应；本阶段未获另行授权时不 commit。下一任务只消费已审接口。

T1 证据：本计划 SDD 目录 task-1-report.md、task-1-review.md、task-1-fix1-review.md；SDK 11/11、build/typecheck/声明闭包通过。首轮 P2 已修复并定向复审放行；外部 tarball 作者消费、完整宿主及干净集成仍由后续任务负责。

## 任务 2：贡献目录、DTO 适配与原子注册

**文件：** 新建 `packages/core/src/plugin/{catalog,sdkAdapter,sdkViews}.ts`；修改原 `plugin/registry.ts`、必要 `plugin/types.ts`；扩展 `tests/plugin/registry.test.ts`，新建唯一 `tests/plugin/sdkAdapter.test.ts`。

- [x] **1. RED（本次历史流程偏差已获用户确认）：** 复用现有 registry 夹具，插件先暂存一条断言再抛出异常，断言正式 `getAssert(id)` 仍 undefined；保留既有贡献；另一个正常插件可提交。冲突和声明漏项使用同一 fixture，不新增独立测试矩阵。首次实际运行仅停在缺新模块导入错误、0test，不能称为业务断言RED；后续修复轮有真实断言级RED/GREEN，用户明确接受保留代码并记录偏差，不删除重写，也不放宽后续TDD。

```ts
const registry = createDefaultRegistry();
const catalog = createPluginCatalog();
const transaction = catalog.begin(demoManifest, {});
transaction.context.register(demoAssert);
transaction.abort();
installSdkContributions(registry, catalog, {});
expect(registry.getAssert("example.demo/assert.has-field")).toBeUndefined();
expect(registry.getAssert("eq")).toBeDefined();
```

- [x] **2. 事务：** 规范化 manifest 声明集；begin 只建私有 staged map；register 校验所属 namespace/kind/shape/重复；commit 再核全部声明与当前冲突，一次提交；abort/commit 后关闭事务。无论 setup 是否忽略注册异常，存在失败的事务不允许部分提交。保留内置短名；外部 SDK 不得到内部 registerScriptEngine/registerStorage。
- [x] **3. 五类适配：** sdkViews 按设计投影 Request/Response、模型/Schema、ReportView；report 输入先经原输出边界，保留真实行/逻辑总体。import 返回的 project 经现有 ProjectSchema/图诊断验证，不直接写磁盘。assert 的 descriptor 接 F4 编辑器/编译路径，不向 SDK 泄漏 CompiledRegex/资产服务。
- [x] **4. 显式绑定：** 支持用户 bindings 的 protocol/auth 选择，未选保持内置；无效显式绑定给 binding_invalid，不能无认证继续。auth 只接受 headers/query 补丁；协议接真实 run/VU transport 委托和 opaque file ref 映射，每次 execute 恰好一次委托，零次/第二次拒绝，执行响应及观测采用宿主实际结果。原门禁/计时/关闭继续由宿主持有。为每次执行生成脱离内部对象的请求，不共享可变 DTO。T2建立内部接缝，T4/T6仍须证明实际宿主装配。
- [x] **5. GREEN：** `pnpm -C packages/core exec vitest run tests/plugin/registry.test.ts tests/plugin/sdkAdapter.test.ts --maxWorkers=2`。适配组用五个代表贡献检查真实行为；F5 逻辑通过但原失败仍存在的报告 fixture、带文件 ref 的请求走既有夹具，不做真实高负载。必要 Core build/typecheck 仅一次。
- [x] **6. 自审/独审：** 核对内部 Map 无回滚前删除旧项的做法；核对取消与 managed client 所有权、零事实和缺失事实不混淆；审查不跑新宽测。接口变化先更新两份正式文档再继续。

T2 证据：本计划SDD目录 task-2-report.md、task-2-review.md、task-2-fix1-review.md。三项重要问题已一次修复并复审关闭，原两文件11/11、Core build/typecheck通过；用户确认仅接受已披露的历史RED流程偏差。真实loader/宿主/网络/父child等后续边界仍保留，不因本任务放行提前记完成。

## 任务 3：静态清单加载、版本判断与运行身份

**文件：** 新建 `packages/core/src/plugins/{manifest,compatibility,runtime}.ts`；修改 `plugins/{loader,types}.ts`、Core 导出/依赖和锁文件；扩展 `tests/plugins/loader.test.ts` 及既有 fixtures 的静态清单。

- [x] **1. RED：** 在现有 loader 的 importFn 注入和具名/default fixture 中增加静态 manifest；不兼容 API、宿主版本、静态冲突分别要求 importFn 未调用，setup 副作用计数为 0。不是通过删掉原真实 ESM 加载覆盖得到绿。

```ts
const fixtureHome = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
const pluginDir = join(fixtureHome, "demo");
mkdirSync(join(pluginDir, "dist"), { recursive: true });
mkdirSync(join(fixtureHome, ".apicc"), { recursive: true });
const incompatibleManifest = { ...demoManifest, engines: { apicc: ">=0.2.0 <0.3.0" } };
writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
  name: demoManifest.name, version: demoManifest.version, type: "module",
}));
writeFileSync(join(pluginDir, "apicc-plugin.json"), JSON.stringify(incompatibleManifest));
writeFileSync(join(pluginDir, "dist/index.js"), "export const plugin = {};\n");
writeFileSync(join(fixtureHome, ".apicc/plugins.json"), JSON.stringify({ plugins: [pluginDir] }));
const registry = createDefaultRegistry();
const imported: string[] = [];
const result = await loadUserPlugins(registry, { homeDir: fixtureHome,
  hostVersion: "0.1.0", importFn: async source => {
    imported.push(source);
    return { plugin: definePlugin({ manifest: demoManifest, setup(ctx) { ctx.register(demoAssert); } }) };
  } });
expect(imported).toEqual([]);
expect(result.problems[0]?.code).toBe("host_incompatible");
expect(registry.getAssert("example.demo/assert.has-field")).toBeUndefined();
```

- [x] **2. 路径/版本：** 用户字符串或对象 source → 静态清单；本地目录/JSON 路径按用户清单基准，包名从用户安装上下文解析已导出清单。先读静态信息与配置，标准 SemVer 判断 engines，数值判断 apiVersion；非法/未知/缺清单明确诊断，无 import 回退。静态读取层先保留正整数 apiVersion 和字符串 capability 再做语义准入，不用 SDK V1 的字面量联合把 API=2/未知能力误归为一般 manifest_invalid；分别给 api_incompatible/unsupported_capability 和实际值。name/version 对照 package.json，entry 相对清单目录解析。
- [x] **3. 加载/摘要：** 静态通过后真实 import，比较规范化模块 manifest，再用 T2 事务调用同步 setup；Promise/thenable、throw、形状/集合不符均作失败。成功贡献计数/IDs 来自已提交 catalog，不再先计数后委托。失败隔离并继续清单后续项。
- [x] **4. host/snapshot：** createUserPluginHost memoize 同一 catalog/registry/summary；snapshot 规范化 config/bindings 并计算清单/入口及整体摘要。hostVersion 由调用方产品 package.json 传入。内部 snapshot v1 严格检查必需字段，关闭模式也有确定身份。摘要不含 config 值/认证材料。
- [x] **5. GREEN：** `pnpm -C packages/core exec vitest run tests/plugins/loader.test.ts --maxWorkers=2`，包含现有正常目录/包解析、真实 ESM 和坏插件隔离；只扩有差异的原 fixture。Core build/typecheck 确认 Node 加载模块没有进入 shared/browser 导出。
- [x] **6. 自审/独审：** 区分 import 前拒绝、setup 前拒绝和 setup 后回滚；不宣称可以撤销已 import 的任意外部副作用。旧无清单试验接口的破坏性诊断与文档一致，不偷加适配层。

## 任务 4：CLI、桌面、工作流/压测与 worker 一致接入

**文件：** 修改 `packages/cli/src/{main,stressPlanCommand}.ts`；`apps/desktop/src/main/{ipc,stressController}.ts`、`main/plugins/{runtime,fixture}.ts`、`shared/plugins/contract.ts`、原 plugins store/API/`PluginsView.vue`/中英文文案。必要的 prepared stress host 接缝仅改 registry/委托输入，不改调度算法。

**测试：** 优先扩展原 `cli/tests/plugins-cmd.test.ts`、`stress-worker.test.ts`，`desktop/tests/main/plugins/ipc-plugins.test.ts`、`main/session.test.ts`、`renderer/components/PluginsView.test.ts`；其他入口只在存在实际接线差异时选原用例，不为每入口建新文件。

- [x] **1. RED及历史处置：** 原始要求为同一用户级断言先失败再接线；实际宿主/断言、worker、reporter缺合格初始RED，用户已确认保留并准确记录，不追认为TDD。协议/UI及本轮首跳/绑定修复有真实业务RED；原session/loopback已证明loaded贡献、特定缺字段失败和真实I/O，原计数/取消/关闭断言保留。
- [x] **2. 组合根：** CLI/桌面只创建一个插件 host；桌面 summary 与执行 registry 同源；去掉旁路 register* 包装计数，默认无插件和 tests 注入关闭不读取真实用户目录。既有 debug/testing/workflow 复用 registry 工厂，压测改为接相同 host 而非局部 defaultRegistry。
- [x] **3. transport 与断言：** 请求/场景/压测使用已适配贡献，逐 VU 委托原 managed client。SDK改写后实际首跳执行原检查/gate，使用内部纯预选以保留非SDK原拒绝顺序；借用/自有关闭及原计时不变。现有内置协议/auth默认不变，外部auth仍用现有晚准备，不增加密钥API。
- [x] **4. worker 身份：** plan/legacy 内部 prepare 配置均新增 pluginRuntimeVersion=1 与固定 snapshot。内部 worker 启动跳过隐式用户插件 preAction，再按协调器固定来源重核 catalog；对照完整 fingerprint 后才 ready/create VU。不一致稳定报 plugin_runtime_mismatch，关闭/no-plugins 也不能在 child 自行恢复。外层 v3 frame、旧协议拒绝、报告与计划版本不变。
- [x] **5. 页面：** loaded/failed/disabled/显式绑定状态有稳定身份 key；版本、要求、失败阶段/操作可读。绑定从同host实际resolver核supports，不再按ID存在推断。长内容局部滚动、原始摘要折叠，无config树；中英文DOM/IPC及CLI实际摘要已验，最终新包视觉仍交T6集中验证。
- [x] **6. GREEN：** 必要原组/具名及真实child证据已核；修复后Core三文件101/101、CLI具名3/3、Desktop8/8；Core build→含tests类型、CLI/Desktop真实build和编译入口通过。无全仓重复或高负载矩阵，完整原件保留。
- [x] **7. 自审/独审：** root读完整task-4-review与fix1-review；P1/P2全部ADDRESSED，无新Critical/Important，T4签收。实际外部作者reporter与最终跨功能/新包视觉仍在T5/T6，不以本任务签收冒称整阶段完成。

### T4 执行修订：三个内部闭环，不再一批改完再验

2026-10-23 冻结后的执行修订。上述七项产品要求不变，T4 仍为一个独立任务；以下是同一实现者按顺序执行的三个检查点，不是再开三批全仓测试或三次整任务独审。root 在每个检查点核原件并放行下一段，只有必要的人类决定才询问用户。

**当前准入：** 用户于2026-10-23明确“确认”，接受完整T4历史偏差处理：保留宿主/断言、worker身份、reporter边界等现有实现，如实记录，按本修订计划完成必要真实行为验证、构建和独审。此前有效RED与后验验证仍分开记，不删除重写来伪造时间线；此确认不豁免后续新缺陷的先复现要求。自检查点A恢复，T1–T3不重做。

**固定候选：** `task-4-output` 为863文件快照，实际输入→输出35文件差异包已保存；完整未完成清单在本计划 SDD 的 `task-4-report.md`。T1–T3不重启。冻结时 Desktop 指定三文件41/41；CLI最后组37/38，SOAP普通入口的json→html夹具修正未复跑；ImportWizard具名用例已复现宿主版本URL问题；这些不是同一种失败。

#### 检查点 A：宿主、断言与真实传输

**职责文件：** `packages/core/src/plugins/{loader,runtime,types}.ts`、`plugin/{sdkAdapter,types}.ts`、`runner/caseExecutor.ts`、`stress/{caseSession,workflowSession}.ts`；`packages/cli/src/main.ts`；`apps/desktop/src/main/{ipc,stressController}.ts`、`main/plugins/runtime.ts`。已有接线只在具体行为失败时修，不顺手重构。

- [x] **A1 核实前置条件：** 在原session夹具同一用例中先断言真实loaded=2，再观察插件消息与真实服务端请求头；把夹具/参数错误与目标行为失败区分。新缺陷的有效失败原件先交root核对，不以unknown断言、加载失败或0test放行产品修改。
- [x] **A2 修已复现的版本读取：** 沿用`red-11`，优先去掉会被Vite转换的`new URL`资产表达式，使用既有Node路径，不硬编码产品版本、不引入JSON编译导致输出目录变化。

```ts
import { resolve } from "node:path";
const hostVersion: string = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../package.json"), "utf8",
)).version;
```

本片段为续工方案而非已验证修复。若该路径在具名用例或真实Electron构建中仍不成立，停止该修改并把原始错误交root，不叠加新的版本回退或猜值。

- [x] **A3 最小验证：** 固定工具链执行以下具名用例，分别证明原ImportWizard会话恢复、SOAP普通/压测真实I/O，不重复已通过的整桌面41项。

```text
pnpm -C apps/desktop exec vitest run tests/renderer/components/ImportWizard.test.ts --maxWorkers=2 -t "真实 session/storage"
pnpm -C packages/cli exec vitest run tests/stress-worker.test.ts --maxWorkers=2 -t "delegates SDK SOAP"
```

沿用原断言：loaded项真实存在；缺字段消息不是OPERATOR_UNKNOWN；SOAP两条入口各实际请求一次；借用VU客户端只由其owner关闭。每次自建普通case资源均结束后关闭，未绑定内置路径不变。

#### 检查点 B：父子进程固定身份

**职责文件：** `packages/cli/src/{main,stressPlanCommand}.ts`、`packages/core/src/stress/{workerProtocol,distributed,runner}.ts`；测试只用原`packages/cli/tests/stress-worker.test.ts`。

- [x] **B1 核对已有真实child原件：** 分别核plan/legacy的固定来源、自定义“缺少字段”结果、各2次HTTP与未读取另一份child HOME的标记结果。复用已经通过且相关源码未变的原件；in-process mismatch seam不冒充真实child。
- [x] **B2 核对固定失败诊断：** `plugin_runtime_mismatch`在ready/create VU前拒绝，零HTTP，legacy仍exit1和numeric报告；仅该完整常量可以保留，其他原异常/配置/富证据仍withheld，不把runCli改成throw求绿。

```ts
expect(await running).toBe(1);
expect(captured).toBe("plugin_runtime_mismatch");
expect(seenPaths.length).toBe(before);
expect(JSON.stringify(readLastReport(join(root, ".apicc", "plugin-mismatch"))))
  .toContain("plugin_runtime_mismatch");
```

若A后的相关worker/诊断源码未变，不重跑该已通过用例；确需修复时先具名复现，命令为`pnpm -C packages/cli exec vitest run tests/stress-worker.test.ts --maxWorkers=2 -t "preserves plugin_runtime_mismatch"`。原prepare取消与关闭覆盖保留，不增加身份排列或高并发矩阵。

#### 检查点 C：可读界面、公开摘要与报告边界

**职责文件：** `apps/desktop/src/shared/plugins/contract.ts`、renderer的plugins store/`PluginsView.vue`/中英文；`packages/cli/src/main.ts`与原`plugins-cmd.test.ts`；CLI/桌面现有reporter调用点。公开SDK、套件格式枚举和F6压测报告链不改。

- [x] **C1 公开摘要：** 原CLI插件文件实际解析`plugins list --json`，合成清单核hostVersion/API、disabled/绑定来源且无config树；6/6。此为历史实现后验补验，不伪称先RED。
- [x] **C2 可读界面：** 中英文原因/重复名/折叠/绑定行为用原PluginsView及修复后具名原件验证；不加快照矩阵。最终新包长内容视觉按T6集中验证，不以DOM或旧预览替代。
- [x] **C3 报告输入与视觉清理：** 独审核collection/workflow每次reporter输入的真实投影和第三参；作者实际闭环交T5/T6。临时preview源码已移除且ignored副本保留可恢复；最终中英文统一留T6唯一新包，不重复临时harness。
- [x] **C4 最终构建与一次独审：** 最终Core build/含tests类型→CLI/Desktop真实build及编译入口通过。冻结task-4-fix1-output，原完整任务独审及第1轮定向复审均已核，P1/P2关闭，无新Critical/Important。T4签收进入T5；全量及唯一新包仍只在T6。

**root门控规则：** 每次先看“具体哪条行为因何失败”，再允许对应源码修改；一个有效RED不授权同时改其他独立行为。实现者每次只处理当前闭环，不得以“同轮”或赶进度先编辑下个闭环。阶段内由root放行，不把这些内部检查点转嫁为用户逐项审批。历史处理选择和技术验收分别记账，任何一项未满足都不勾T4完成。

## 任务 5：脚手架、作者工程和 SDK pack

**文件：** 修改 `packages/cli/src/create-plugin.ts`、`packages/cli/tests/create-plugin.test.ts`、旧 sample-plugin fixture、`docs/plugins.md`；新建 `examples/plugin-sdk-v1/{package.json,apicc-plugin.json,tsconfig.json,src/index.ts,test/contract.test.ts,README.md}`，以及 SDK README/LICENSE 打包文件。

- [x] **1. RED：** 原脚手架测试改为生成后真实编译/调用贡献，而不是只搜索源码字符串。原生成物Core peer与SDK预期不符形成有效RED；缺清单ENOENT不伪称业务断言。生成清单与模块 manifest 一致，保留原名称/目标目录冲突/不覆盖已有文件用例。
- [x] **2. 模板：** 静态清单采用设计第 4 节结构，namespace 根据完整小写包名派生为 `local.<包名>`；apicc-plugin-demo 的断言 ID=`local.apicc-plugin-demo/assert.has-field`、reporter=`local.apicc-plugin-demo/reporter.text`。先完成合法性与目录检查，再写文件；不是所有生成物写死 example.demo。手写说明样本可使用 example.demo，但清单/源码/作者测试三者保持对应。源码仅从 SDK 导入公开类型；实际文本 reporter 消费 ReportView.rows，并分别列可选 logical/requestFacts，不把恢复后的逻辑通过写成原请求零失败。I1已修，失败用例/ID/类别及投影已有原因直接可读，缺细节明确提示，不回填正文。

```ts
import { checkPluginContract } from "@apicc/plugin-sdk/testing";
import { plugin } from "../src/index.js";
const checked = checkPluginContract(plugin, { config: {} });
expect(checked.problems).toEqual([]);
const assertion = checked.contributions.find(item => item.kind === "assert");
if (assertion?.kind !== "assert") throw new Error("示例断言未注册");
expect(assertion.evaluate({ id: 1 }, "id", { found: true, getModel: () => undefined }).pass).toBe(true);
```

- [x] **3. package：** 生成物 peer/dev 依赖 SDK 首版，移除 Core peer；exports 包含 `./apicc-plugin.json`，files 包含清单与 dist。本地执行 `pnpm -C packages/plugin-sdk pack --pack-destination ../../local/f7a-author-sdk-20261023`，产物 `local/f7a-author-sdk-20261023/apicc-plugin-sdk-0.1.0.tgz`。作者工程通过 PowerShell `Join-Path ([IO.Path]::GetTempPath()) ('apicc-f7a-author-' + [guid]::NewGuid().ToString('N'))` 创建在仓库之外，记录实际路径，SDK 依赖使用此 tarball 绝对路径；实际SDK解析在该工程独立node_modules、Core为MODULE_NOT_FOUND。
- [x] **4. 文档：** 解释三个版本/产品0.1.0、用户 source/相对路径基准、bindings 与非敏感 config、受信本机权限、不兼容和半注册诊断、无清单试验插件升级及重启生效；无 npm 发布或自动安装。已有脚本/存储试验入口不被示例宣称为 SDK V1 能力。
- [x] **5. GREEN：** 原两文件12/12；I1修复后原生成器6/6、CLI build、外部作者build/test1/1及真实CLI list/collection/recovery消费通过。collection保留退出1，恢复workflow退出0但原行失败1/逻辑通过1/请求1/1/1分列；证据none且正文marker在JSON/文本均缺席。需要的新依赖只按既有 lock/toolchain 准备，不操作真实用户清单。
- [x] **6. 自审/独审：** 实际SDK pack11文件含README/LICENSE/主与testing声明，无Core依赖；root完整读task-5-review及fix1-review，唯一I1已ADDRESSED，无新Critical/Important/Minor。未重pack未变SDK，未重建全量产品包；T5签收进入T6。

T5实际作者根：`C:/Users/imini/AppData/Local/Temp/apicc-f7a-author-d02f32624c9b4408990c26e321de798d`。SDK SHA256：`b2f1996d303e78fc05bcaa053bb207d0655ab7dadd93bc5453e5b028e329c6fe`。失败原件/前后作者源码及源码快照保留在本计划SDD证据，不追认为成功运行。

## 任务 6：最终审核、一次门禁和新包集中验收

**文件：** 仅必要打包依赖边界、正式文档完成勾选及 `local/F7a阶段验收与交付记录-2026-10-23.md`（执行跨日时使用交付日期）；证据写入本计划专属 ignored SDD 目录。没有新产品功能工作包。

- [x] **1. 根核对：** AC01–12逐行证据齐全；一次最终宽审I1经集中修复及原审查者定向复审关闭。两测试夹具及一条打包配置仅必要差异复核，无重复宽审，无开放C/I/M，未升级max。
- [x] **2. 一次集成门禁：** 固定Node22.19/pnpm11.21/JDK21，原test-all一次退出1，保留原件。TopBar旧夹具4项、私有worker旧夹具13项最小修正补过，续原CLI/Java；唯一覆盖admin185、SDK11、Core1339、Desktop1101、CLI189、Java192，构建/类型/品牌通过。不冒称单次整命令全绿，不重跑同输入通过组。
- [x] **3. 包：** 首包b97e31实际缺SDK声明，保留真实失败；独立FileSet必要修正后最终c04df9的dist:dir/smoke/实际asar主与testing声明闭包均过。SDK唯一tarball不变，未升级运行时或依赖。
- [x] **4. 唯一合成联验：** 最终真实asar提取模块在同根完成F3预览/仅合成模块提交撤销、作者debug/collection/workflow、6次显式protocol/bearer原transport请求、未登记项目来源零import；T5实际CLI文本报告及T4真实双child证据复用。原生与Node package-source联验分别记账。
- [x] **5. 集中手验：** root用Sky操作最终c04df9 EXE，实际中英文版本/状态/具体原因/绑定、长来源展开、局部滚动和默认原始数据折叠通过；测试页运行作者两个真实用例，HTTP200下分别Passed/断言Failed，具体“缺少字段”可见。无需再要求用户重复同项手验，未操作真实项目或旧客户端。
- [x] **6. 交付：** 主工作区local交付记录含路径/hash、逐AC证据、测试真实退出、历史偏差及14条裁决/返工代价；root native-final-validation.md保留实际观察。仅完成状态文档更新，不改变已验产品；Windows x64以外未验证。延期专项/在线/B未恢复，无Git集成/npm发布。

## 覆盖、自检和恢复规则

| 设计范围 | 责任任务 | 验收 |
| --- | --- | --- |
| 公开包与稳定 DTO | T1/T2/T5 | AC01/05/10 |
| 静态版本准入、配置、用户来源 | T3/T4 | AC02/06 |
| 命名空间、事务、显式绑定 | T2/T3 | AC03/04/08 |
| 跨宿主与 worker 真消费 | T4 | AC07/11 |
| 页面本地化与诊断 | T4/T6 | AC09 |
| pack、实际新包与交付边界 | T5/T6 | AC10/12 |

root 在开工前做任务共享文件/接口预检并记入本计划账本；当前依赖顺序 T1→T2→T3→T4→T5→T6，不并行写同一实现。中断后按账本完成行、报告和 Git/source 身份恢复，不重新分派已完成任务，不因额度/网络恢复重开延期项。

本次规划自检要求：AC01–12 全部有责任任务；同名公共接口统一；静态与动态清单两阶段区别明确；内部 v3 frame 与新增配置版本不混用；无产品代码已实现/测试已绿的提前勾选。计划归档不等于代码开工授权。
