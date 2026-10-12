# apicc F1 契约与资产基础实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框跟踪；用户已选择子智能体执行，不再询问执行方式。

**目标：** 交付可编辑、可保存、可执行、可派生的新契约与项目资产，以及桌面/CLI 共用、免主动解锁的普通测试凭据存取。

**架构：** ApiContract 是唯一接口定义，ApiAsset 聚合独立用例和文档；项目资产上下文按 ID 解析模型/组件，每次运行固定快照。文件层版本化且有写保护/可恢复保存；临时请求由唯一物化函数产生，宿主在运行准备阶段注入凭据绑定。

**技术栈：** TypeScript strict、Zod 4、Vitest、YAML、SQLite、Vue 3/Pinia、Electron、Node CLI。候选系统凭据库精确版本 `@napi-rs/keyring@2.1.0`，准入以任务 3 实测为准。

**规格：** `docs/superpowers/specs/2026-10-07-apicc-contract-assets-design.md`，用户于 2026-10-07 明确回复“确认”，包括 §8.3 普通凭据对主动执行的现有本地测试逻辑可见/可修改边界。DEF-001 以同目录正式延期裁定为准。

## 全局约束

- 未发布，不兼容旧 `ApiDefinition`，不开发旧工作区迁移器。
- 工作区入口和接口/模型/组件文件都显式 `formatVersion: 1`；元数据的业务 `version` 仍为字符串，两者不可混用。
- 缺失格式版本属于旧工作区，拒绝打开写入模式并解释如何在新目录新建。未来版本明确拒绝；未知字段严格报错，不通过 Zod strip 或保存白名单静默丢弃。
- 开发 GPT-6 Luna xhigh，审核独立 GPT-6.1 Sol xhigh；主智能体仅规划、调度、核验。
- Node 最低 22.19.0，CI pnpm 11.21.0。JDK 21 根 `C:/Program Files/Java/jdk-21.0.12`。
- 普通测试凭据加密持久化、自动读取，不设应用主密码、无每会话主动解锁、无每次请求重复输入。
- 2026-10-08 用户批准 A：CredentialScope 为 workspaceId/groupId/projectId，跨组移动统一换新 SecretRef、用户重绑，不复制系统值；不同组同 project.id 仍合法。分组仅改名不换身份。旧二字段地址不迁移/回退；v2 地址与契约 formatVersion=1 独立。
- `SecretStore` 不注入脚本；不扩展旧引擎，不扩大脚本原有文件/进程/网络权限。
- DEF-001 无限期暂缓；不读写冻结工作树，不跑专项实验，不引入失败候选，不创建自动恢复/监控。
- 同一 worktree `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，分支 `codex/contract-assets`，起点 `dfd20c34962d6b3aee54675f054962ba11240ddf`；只允许一名产品写入者。
- 禁止自动暂存、提交、合并、推送、清理工作树或删除审计产物。任务检查点以完整未提交候选文件和 SHA-256 清单记账，不以空的 HEAD..HEAD diff 冒充审查包。
- 新 multipart/binary 传输、完整 Mock/导出、测试中心、强编排及完整脚本安全承诺不在本阶段交付。

## 执行与开工门禁

任务 1–6 是未激活的基础模块，不接入第二套生产编辑/保存源。任务 7–11 属于同一破坏性切换区间，内部允许尚未切换包出现已列明的旧形状类型错误，但不得通过 any、关闭 strict、删除断言、skip 测试或旧模型兼容层消除；每项必须有自己的聚焦测试、审查和具体剩余调用清单。任务 12 全部消费面通过统一激活门之前，不宣称任何中间候选可发布/合并。

此安排是源代码施工次序，不是两套格式可同时打开/保存，也不是用户分批授权。阶段内常规任务/修复连续推进；只有新授权、重大范围变化、延期依赖、无法安全推进或实际平台限制才停下并说明用户需要做什么。

所有路径相对该 worktree。下面使用 `pnpm` 表示 **11.21.0**，本机通过以下命令固定，不改全局版本：

```powershell
$env:PATH = 'D:/env/nvm/installs/v24.21.0;C:/Program Files/Java/jdk-21.0.12/bin;' + $env:PATH
$env:JAVA_HOME = 'C:/Program Files/Java/jdk-21.0.12'
& 'D:/env/nvm/.nodejs/corepack.exe' pnpm@11.21.0 --version
& 'D:/env/nvm/.nodejs/corepack.exe' pnpm@11.21.0 install --frozen-lockfile
```

产品源码修改前的完整基线：`pnpm -C packages/core typecheck`、`pnpm -r build`、`pnpm -r test`、`mvn -s server/.mvn/settings.xml -f server/pom.xml test`、品牌脚本自检/扫描。Node 24 仅是本机证据，不当作 Node 22 等价。依赖更新只限任务 3 的精确候选与所需平台包；不升级无关依赖。服务器测试与会构建同一 server/target 的 E2E 顺序执行，避免输出竞争。

## 文件结构与职责

| 文件/范围 | 职责 | 任务 |
|---|---|---|
| `packages/core/src/contract/{schemaNode,model,workspace}.ts` | 纯 Schema/契约/组件与未激活容器类型，无 Node/Electron 依赖 | 1 |
| `packages/core/src/assets/{context,graph,clone,snapshot}.ts` | ID 解析、引用图、闭包/映射、只读修订 | 2 |
| `packages/core/src/credentials/{types,bindings,systemStore,privateIndex}.ts` | 存取端口、运行绑定、延迟加载系统提供方、本机非秘密提交指针 | 3 |
| `packages/core/src/storage/{contractFiles,paths,writeJournal}.ts` | 文件 DTO、UUID 路径、恢复写入 | 4 |
| `packages/core/src/request/{materialize,parameters,body}.ts` | 唯一请求物化，无存储/全局状态 | 5 |
| `packages/core/src/import/{contractOpenapi,contractCollection21}.ts` | 准备新格式导入产物与损失诊断 | 6 |
| `packages/core/src/design/contractMarkdown.ts`、`ai/contractView.ts` | 新契约派生文档、无运行绑定的摘要 | 6 |
| `domain/model.ts`、`plugin/types.ts`、`storage/{fileStorage,sqliteIndex}.ts`、`runner/*`、`workflow/*`、`stress/*`、`http/*`、`protocol/*` | Core 的统一破坏性切换；不改引擎内部 | 7 |
| `packages/cli/src/{main,mcp/server}.ts` | CLI/MCP 新格式与宿主凭据注入 | 8 |
| `apps/desktop/src/{main,preload,shared}` | Session/IPC 事务、资产操作、运行绑定与只读状态 | 9 |
| `apps/desktop/src/renderer/src/{stores,components,api/memory.ts}` | 同一契约编辑、资产管理与独立凭据保存反馈 | 10 |
| 在线编辑、AI、实际模块导入/克隆路径 | 消费一致/拒绝口径及跨入口测试 | 11 |
| 打包配置、集成夹具、阶段验收记录 | 全消费激活、Node22/24 与 Electron 后端实证、最终宽范围审核 | 12 |

### 任务 1：纯契约、SchemaNode 与组件定义

**文件：** 创建 `packages/core/src/contract/schemaNode.ts`、`contract/model.ts`、`contract/workspace.ts`、`tests/contract/model.test.ts`、`tests/helpers/contractFixtures.ts`。暂不修改 `domain/model.ts` 的生产消费类型或 Core 根导出。

- [ ] **步骤 1：建立严格 Schema 的失败测试。** 新夹具只导入新模块，UUID 使用固定合法值；至少包含三个协议、八类 Body、四类参数/组件、多个响应、嵌套/组合/模型引用及未知字段。行为断言如下，不以 snapshot-only 代替：

```ts
it('keeps schema examples separate from an absent request value', () => {
  const asset = contractFixture();
  asset.contract.request.query = [inlineParameter({
    name: 'limit', schema: { kind: 'scalar', type: 'integer', default: 10, examples: [20], enum: [10, 20] },
  })];
  const parsed = ApiAssetSchema.parse(asset);
  expect(parsed.contract.request.query[0]).not.toHaveProperty('value');
  expect(ApiAssetSchema.safeParse({ ...asset, method: 'GET' }).success).toBe(false);
});
```

- [ ] **步骤 2：运行 RED。** `pnpm -C packages/core exec vitest run tests/contract/model.test.ts`。缺模块只作为 bootstrap 记录；先建立可导入的最小 skeleton，再分别看到未知字段、协议互斥、版本、Schema/实例分离等实际断言失败。不能“缺模块→写完全部实现→全绿”后声称完成行为 TDD。
- [ ] **步骤 3：定义以下唯一形状并实现 strict Zod。** SchemaNode 使用 lazy 递归，所有 object strict；JSON 值不允许函数/undefined/循环宿主对象。协议 request 判别联合；参数 required 与对象 required 分开。

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SchemaNode = SchemaAnnotations & (
  | { kind: 'scalar'; type: 'string' | 'number' | 'integer' | 'boolean' | 'null' }
  | { kind: 'object'; properties: Record<string, SchemaNode>; required: string[]; additionalProperties: boolean | SchemaNode }
  | { kind: 'array'; items: SchemaNode }
  | { kind: 'allOf' | 'oneOf' | 'anyOf'; variants: SchemaNode[] }
  | { kind: 'modelRef'; modelId: string }
);
export interface SchemaAnnotations { description?: string; default?: JsonValue; examples?: JsonValue[]; enum?: JsonValue[] }
export interface SecretRef { id: string; policy: string }
export interface InlineParameter {
  kind: 'inline'; id: string; name: string; schema: SchemaNode;
  required: boolean; enabled: boolean; description: string; value?: string;
}
export interface ParameterReference {
  kind: 'componentRef'; id: string; componentId: string; expectedKind: 'parameter'; value?: string; enabled?: boolean;
}
export type ParameterBinding = InlineParameter | ParameterReference;
export type AuthBinding =
  | { kind: 'none' }
  | { kind: 'bearer'; token: SecretRef }
  | { kind: 'basic'; username: string; password: SecretRef }
  | { kind: 'apikey'; name: string; placement: 'header' | 'query'; value: SecretRef }
  | { kind: 'componentRef'; componentId: string; expectedKind: 'auth' };
```

`RequestBody` 必须逐类定义：none；json/xml/text 为 content 模板与可选 schema；graphql 为 query/variables/operationName；urlencoded 为有序 `{id,name,value,enabled}`；multipart 为带文本/本地文件引用判别条目；binary 为 `{file:{path},contentType}`。本地文件仅描述，不在本任务读取。禁止沿用 raw/form 含糊类型。

`ApiContract` 为 `{formatVersion:1,id,metadata,request,responses}`；metadata 含 name/description/tags/version/status。HTTP request 含 method/baseUrl/path/四类参数/auth/body；WS 含 baseUrl/path/四类参数/auth/message?；SOAP 固定 POST，含 baseUrl/path/四类参数/auth/envelope/soapAction?。四类参数数组必有，auth 默认 none，HTTP body 默认 none。

`ApiAsset` 为 `{contract,cases,documentation}`，cases 基于现有 TestCaseSchema 派生不含 preScript/postScript 的 strict 新格式 Schema，类型采用该 Schema 的输出；本任务不修改旧 domain/model.ts。任务 7 再抽取公共叶子并让标准域只接受 operations，消除临时派生边界；不复制请求。`ModelAsset` 为 `{formatVersion:1,id,name,description,schema}`。四类组件共同为 `{formatVersion:1,id,name,description,kind,definition}`；parameter.definition 含 location/name/schema/required/description；auth.definition 为非组件引用 AuthBinding；response.definition 为响应定义；example.definition 为 `{name,value}`。每个绑定/响应出现位置的 id 与组件资产 id 分离。

响应为 inline `{kind:'inline',id,status,description,headers,content}` 或 typed response componentRef；content 为按 contentType 索引的 `{schema?,examples}`。示例为 inline `{kind:'inline',id,name,value}` 或 typed example componentRef；status 接受 100–599 字符串、1XX–5XX、default。不在结构解析中拒绝缺引用等草稿语义。

`contract/workspace.ts` 定义未激活的显式容器类型/strict Schema，不能 `Omit<Project,...>` 派生后再让 Project 指回它形成循环：ContractWorkspace 为 formatVersion/id/name/variables/groups；ContractGroup 为 id/name/default?/projects；ContractProject 为 id/name/variables/globals/environments/collections/workflows/stressPolicy/models/components；ContractCollection 为 id/name/variables/preOperations/postOperations/folders/apis；ContractFolder 为 id/name/preOperations/postOperations/folders/apis。此处复用现有 Environment/Operation/TestCase/Globals/StressPolicy/Workflow 的基本类型和 Schema；任务 7 激活时先抽取 `domain/common.ts` 的公共叶子 Schema 并更改 import，避免 domain/model 与新契约的运行时初始化环。准备类型没有独立保存入口；任务 7 将标准域导出切到此唯一实现。

- [ ] **步骤 4：GREEN 与类型核验。** 上述聚焦测试、`pnpm -C packages/core typecheck`、Core build；测试必须证明错误协议字段、参数顶层 enum/default/example、错误版本和未知字段均被拒绝。
- [ ] **结构边界补充：** SchemaNode 主体必须为有限可保存树，拒绝直接对象环，正常 modelRef 递归及无环共享子对象可用。JsonValue 数组只接受实际索引和length，额外字符串/Symbol键、函数、环及异常描述符明确拒绝。合法JSON字典键不得成功后静默消失；所有新字典逐类验证保真或有定位诊断的明确拒绝，包括复用叶子的准备边界。不改引擎、不做运行时专项实验。新ApiAsset.cases拒绝preScript/postScript，而operations保持。
- [ ] **修复回归约束：** 冻结/密封只改变可写性，不使正常有限JSON数据失效；允许只读data descriptor，仍拒绝额外键/访问器/空洞/函数/环。字典校验与重建对每个子值只解析一次，复用成功的parsed.data；小型递归链精确计数验证，不以深度上限或资源负载实验掩盖重复校验。
- [ ] **步骤 5：自审并交付未提交候选。** 报告精确导出签名、RED/GREEN、文件清单/hash、无生产入口激活；不执行 git add/commit。

### 任务 2：显式资产上下文、引用闭包与快照

**文件：** 创建 `packages/core/src/assets/context.ts`、`graph.ts`、`clone.ts`、`snapshot.ts`，测试 `tests/assets/{context,clone,snapshot}.test.ts`。依赖任务 1，不改生产 Project 类型。

- [ ] **步骤 1：写失败测试。** 两个接口共享每类组件；模型结构递归合法、纯 ref 环诊断；错类型/缺失/重复 ID 有稳定 code/path。断言重命名 ID 不变、拒绝删除被引用项、闭包无遗漏、克隆跨 scope 用例映射一致且秘密新 ref 未绑定。

```ts
const context = createProjectAssetContext({ projectId, assets: [a, b], models: [userModel], components: [queryComponent] });
expect(context.referencesTo(queryComponent.id).map(x => x.ownerId).sort()).toEqual([a.contract.id, b.contract.id].sort());
expect(context.delete(queryComponent.id)).toMatchObject({ ok: false, code: 'ASSET_REFERENCED' });
const before = createProjectSnapshot(project);
const changed = structuredClone(project);
changed.components.find(component => component.id === queryComponent.id)!.name = 'renamed';
expect(before.definitionRevision).not.toBe(createProjectSnapshot(changed).definitionRevision);
expect(before.context.getComponent(queryComponent.id)?.name).not.toBe('renamed');
```

- [ ] **步骤 2：RED。** `pnpm -C packages/core exec vitest run tests/assets`；先实际断言失败，再实现。
- [ ] **步骤 3：实现固定接口。** `createProjectAssetContext({projectId,assets,models,components})` 返回按 ID 的 getContract/getModel/getComponent、diagnostics、referencesTo、rename、delete、dependencyClosure。它是编辑/解析视图，不是完整运行定义。`createProjectSnapshot(project: ContractProject)` 深复制并冻结完整项目定义，返回 `{project,context,definitionRevision}`；context 从冻结 project 构建，只有只读接口；definitionRevision 包括 variables/globals、环境/baseUrls、模块/祖先操作、workflows、stressPolicy 及全部资产，不只 hash 接口/模型/组件。图遍历不展开第二份定义。

`cloneAssetBundle(bundle,{newProjectId,newId})` 仅用于模块依赖闭包；另外实现 `cloneProjectDefinition(project,{newId})`。完整项目克隆第一遍为 project、collection/folder、environment、workflow/节点/边、API/参数/响应/示例、模型/组件、逻辑 caseId、operation/断言及 SecretRef 建立统一映射，第二遍重写定义/引用。明确重写 environment.baseUrls 的 collectionId 键、workflow apiId/caseId/边端点和全部 typed refs；环境名不变时 extends/case.scope 仍保持名称关联。相同逻辑 caseId 的不同 scope 共用同一新 ID；源不变，不调用 SecretStore。

```ts
export interface AssetDiagnostic { code: string; ownerId: string; path: string; targetId?: string }
export interface AssetBundle { assets: ApiAsset[]; models: ModelAsset[]; components: ComponentAsset[] }
export type AssetMutationResult = { ok: true } | { ok: false; code: 'ASSET_REFERENCED' | 'ASSET_NOT_FOUND'; references: AssetDiagnostic[] };
```

definitionRevision 使用完整项目定义的规范 JSON 键排序 hash，保留有序数组顺序，不包括解密绑定。工作区文件 revision、项目 definitionRevision、凭据版本描述符分开。内部 Map 不暴露可变引用；图递归不无限展开。增加只改 globals、环境基础地址、模块变量、祖先操作的测试：新修订变化，新运行见新值，已启动运行及快照保持原值。草稿语义诊断与 publish/execution 门分别返回，不能因响应模型未完成阻止负向请求。

- [ ] **步骤 4：GREEN。** 聚焦测试、Core typecheck/build；额外断言原项目/源 bundle 未被 clone 或失败 delete 修改。
- [ ] **步骤 5：报告并独立审核。** 列出所有引用字段的处理位置，遗漏不能用“通用递归会处理”代替证据；不提交。

### 任务 3：凭据端口、默认提供方准入与运行绑定

**文件：** 创建 `packages/core/src/credentials/types.ts`、`bindings.ts`、`privateIndex.ts`、`systemStore.ts`，`tests/credentials/{bindings,systemStore}.test.ts`，`scripts/verify-test-credentials.mjs`；必要时精确更新 `packages/core/package.json`、`pnpm-lock.yaml`，不接桌面 UI。

- [ ] **步骤 1：先做候选准入。** 下载/安装精确发布包，读安装后的 index.d.ts/package.json，核实 Node22/24 与当前锁定 Electron 的 Windows x64 N-API 绑定。测试只用 `apicc-f1-verification-<UUID>` 专用命名空间和合成随机值，不枚举/读取用户条目。验证进程 A 保存、进程 B 读取、第三次替换/删除；打印状态和布尔结果，不打印值。Electron 绑定至少真实启动同一版本进程载入并往返。候选不可用则上报实际证据，不改成明文或主密码，也不强行启动后续凭据消费。
- [ ] **步骤 2：写 RED 与端口契约。** 不含 Node 的 types 导出如下（SecretRef 使用任务 1 定义，不再重定义）：

```ts
export interface CredentialScope { workspaceId: string; groupId: string; projectId: string }
export interface SecretStore {
  put(scope: CredentialScope, ref: SecretRef, value: string): Promise<void>;
  resolve(scope: CredentialScope, ref: SecretRef, expectedVersion?: string): Promise<string>;
  version(scope: CredentialScope, ref: SecretRef): Promise<string>;
  remove(scope: CredentialScope, ref: SecretRef): Promise<void>;
  status(scope: CredentialScope, ref: SecretRef): Promise<'available' | 'missing' | 'unavailable'>;
}
export interface CredentialBindings { resolve(ref: SecretRef): string; readonly versions: Readonly<Record<string, string>> }
export function prepareCredentialBindings(scope: CredentialScope, refs: readonly SecretRef[], store: SecretStore, expectedVersions?: Readonly<Record<string, string>>): Promise<CredentialBindings>;
```

绑定实现按 refId 去重，准备期间一次读取并固定值；不把值 Map 返回脚本或序列化。version 返回不含秘密/秘密hash的随机 generation 身份，不是值指纹。准备先获取全部版本、与 expectedVersions 比较，再按版本 resolve，最后重新核对版本及存在状态；变化报 `CREDENTIAL_VERSION_CONFLICT`，不返回混合版本 bindings。空 refs 不加载提供方。错误使用稳定 `CredentialError(code, refId)`，code 区分 MISSING/UNAVAILABLE/FORMAT_UNSUPPORTED/POLICY_UNSUPPORTED/READ_FAILED/SAVE_FAILED/REMOVE_FAILED/VERSION_CONFLICT，完整 code 前缀为 `CREDENTIAL_`；上层映射到 config，未知 policy 不允许发送。

```ts
const bindings = await prepareCredentialBindings(scope, [ref, ref], fakeStore);
expect(fakeStore.resolve).toHaveBeenCalledTimes(1);
await fakeStore.put(scope, ref, 'next-synthetic');
expect(bindings.resolve(ref)).toBe('old-synthetic');
expect(() => bindings.resolve(otherRef)).toThrow();
```

- [ ] **步骤 3：RED。** `pnpm -C packages/core exec vitest run tests/credentials`，记录缺失/策略拒绝/替换校验失败等实际红灯。
- [ ] **步骤 4：实现默认适配器。** 内部 `createSystemSecretStore({privateRoot,loadBackend?})` 延迟动态导入 native 包；公开根入口只接受 `{privateRoot}` 并投影字段，不暴露 loadBackend。无凭据运行不能触发加载。系统库 service 为产品/地址版本/workspace/group/project 命名空间；value envelope 含 formatVersion/policy/value。禁止自己保存裸主密钥、固定密钥、Linux basic_text 明文降级或 Electron 常驻代理。此处作用域按 2026-10-08 A 修订，Task3 原验收历史不覆盖新要求。

替换使用新 generation 条目先写入再读取校验；本机 privateRoot 的**非秘密**索引只保存 ref→generation/策略及版本，通过同目录临时文件+原子 rename 提交活动指针。候选校验或指针提交失败保留旧有效指针，不覆盖旧系统条目。索引路径通过完整 scope UUID 与逻辑 ref string 的无歧义编码定位、单写者锁；不进入共享项目、日志/备份/修订。native 后端错误不直接插入诊断字符串。A 修订采用 credentials-v2/service v2 地址，不扫描旧二字段条目。

remove 不先写逻辑 tombstone：在同一 scope/ref 锁内定位活动 generation，以系统库成功删除该活动条目作为唯一提交点，之后没有决定公开成功/失败的索引写入或清理步骤。系统删除失败返回 REMOVE_FAILED，活动指针/有效条目不改变；条目本已不存在则幂等成功。允许保留指向已删除 generation 的非秘密索引，resolve/status/version 必须核实条目存在，不能把“索引有记录”当作凭据可用。后续 put 提交新的 generation。旧非活动/失败暂存条目的回收与介质安全擦除不承诺为本次 remove 的结果，不自动枚举全库；若实际后端不能满足删除失败保持活动条目的契约，则不准入，不重命名失败为成功。

- [ ] **步骤 5：GREEN 和真实准入。** 用注入替身故障覆盖保存失败、读取校验失败、指针提交失败、同 ref 旧值保留、系统删除失败保留绑定、删除成功且重开仍missing、幂等删除、准备期间版本改变、缺失 native 后端的无凭据运行。Node22/24 与 Electron 发布绑定有独立证据；打包后再次验证归任务 12。若本机缺 Node22，记录缺口，不把 Node24 测试当作替代。
- [ ] **步骤 6：自审报告/独立审核。** 报告依赖锁差异、平台、专用条目清理状态，不附值。不得带入既有 AI/登录秘密。

### 任务 4：版本化文件 DTO、规范路径与恢复写入模块

**文件：** 创建 `packages/core/src/storage/contractFiles.ts`、`paths.ts`、`writeJournal.ts`、`tests/storage/contractFiles.test.ts`、`writeJournal.test.ts`。保持旧 fileStorage 尚未激活，不读取用户工作区。

- [ ] **步骤 1：写真实临时目录 RED。** api.yaml 只含 contract，design.md/cases 单独文件；全部模型/四类组件往返。未知字段/版本诊断、坏文件原字节保留；同 caseId 不同 scope 两文件共存。使用 mkdtemp/测试 finally 精确清理自身临时目录。

```ts
const plan = encodeContractWorkspace(workspace);
expect(parseYaml(plan.files.get(apiPath)!)).not.toHaveProperty('cases');
await commitWritePlan(root, plan, { expectedRevision: 'empty', deletions: [] });
const loaded = await decodeContractWorkspace(root);
expect(loaded.workspace).toEqual(workspace);
expect(loaded.readOnly).toBe(false);
```

- [ ] **步骤 2：RED。** `pnpm -C packages/core exec vitest run tests/storage/contractFiles.test.ts tests/storage/writeJournal.test.ts`。
- [ ] **步骤 3：实现文件对称 Schema 与公共路径。** workspace/group/project/collection/folder 元数据 DTO 不含子树，api 文件为 ApiContract；首次 formatVersion 门在 workspace 与资产文件。路径只接受合法 UUID，scope 文件名可逆编码，拒绝斜杠/逃逸；导入器丢失诊断不能包含秘密原文。所有保存先完整 encode/parse 再触盘。

```ts
export interface WorkspaceLoadState<T> { workspace: T; problems: LoadProblem[]; revision: string; readOnly: boolean }
export interface WorkspaceWritePlan { files: Map<string, string> }
export interface SaveOptions { expectedRevision: string; deletions: readonly string[] }
export function commitWritePlan(root: string, plan: WorkspaceWritePlan, opts: SaveOptions): Promise<{ revision: string }>;
```

decode 的结构错误令整体 readOnly；语义缺引用只诊断可保留草稿。元数据文件、侧文件都纳入 workspace revision，外部文件修改不能被覆盖。新建 root 使用显式空修订，不把不存在 root 当成可任意覆盖路径。

- [ ] **步骤 4：实现 journal。** 锁使用独占创建并记录 owner/operationId，不抢未知锁；在 `.apicc/write-journal/<operationId>/` 写 manifest/new/backups、应用 replace/delete、最后 committed marker。manifest 相对路径必须经同一根边界验证，不执行任意路径。失败反向恢复，失败回滚保持日志/readOnly；重开遇未完成记录先恢复到前状态，再 load。已完成记录仅清理本操作暂存，不删除任意用户目录。显式 delete 清单必须来自完整加载+资产服务已验证删除，不能推导 orphan 删除。
- [ ] **步骤 5：GREEN 故障矩阵。** 在 staging、替换第二文件、删除、写 marker、rollback、reopen 各点注入错误；断言前状态一致或 readOnly+日志保留，不能笼统仅 assert rejects。第二写入者和外部编辑修订冲突不改文件。Core typecheck/build。
- [ ] **步骤 6：报告并审查。** 给每个故障点的测试名；只核验应用异常/重开语义，不宣称全掉电原子性。

### 任务 5：唯一物化与临时执行 DTO

**文件：** 创建 `packages/core/src/request/materialize.ts`、`parameters.ts`、`body.ts`、`tests/request/materialize.test.ts`。暂不接现有 executeCase，物化可测试但不是新生产入口。

- [ ] **步骤 1：RED 覆盖固定规则。** base `/v1` 和 `/v1/` × path `users` 和 `/users` 四组合；空 path；非法绝对 path/network-path/query/fragment；Path 编码一次、Cookie 合并、Header 大小写启用/禁用覆盖；引用组件变更；负向 Query/Body 不因 Schema 拒绝；multipart/binary 零传输明确拒绝。

```ts
for (const baseUrl of ['https://example.test/v1', 'https://example.test/v1/']) {
  for (const path of ['users', '/users']) {
    expect(materializeRequest(contractFixture({ baseUrl, path }).contract, context, inputs).url)
      .toBe('https://example.test/v1/users');
  }
}
expect(() => materializeRequest(binaryAsset.contract, context, inputs))
  .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_BODY_ENCODING' }));
```

- [ ] **步骤 2：RED。** `pnpm -C packages/core exec vitest run tests/request/materialize.test.ts`。
- [ ] **步骤 3：实现明确输入。** `materializeRequest(contract, context, inputs)` 同步，inputs 提供 resolver/envBaseUrl/globals/credentialBindings；不得自行读盘/系统库/全局 singleton。独立临时 DTO 定义 `RuntimeAuth`（解密字符串，仅执行使用）、`RuntimeBody`（仅现有支持编码的 transport 形状），不把它们放回 contract。变量重放优先级由调用者保留，物化只用传入 resolver。

```ts
export interface MaterializeInputs {
  resolve(template: string): string;
  envBaseUrl?: string;
  globals: Partial<ProjectGlobals>;
  credentials: CredentialBindings;
}
```

四类参数按上下文解析，实例覆盖不复制设计值；必须 Path 无值 config；Schema default/examples 不自动用作值。HTTP none/json/xml/text/graphql/urlencoded 转换为临时 transport body；graphql 编码 query/variables/operationName；WS/SOAP 各自载荷，不夹带非法协议字段。auth SecretRef 在本次 bindings 读取，不能保留未解析占位符发送。最终请求对象及嵌套结构归该次调用所有。

- [ ] **步骤 4：GREEN。** 聚焦测试与 Core typecheck/build；两个物化结果互改 headers/query/auth/body 不影响彼此或快照。明确报告新 URL/Header 规则与原行为的差异。
- [ ] **步骤 5：报告和审核。** 不调整计时、不改变最终目标保护位置、不增加脚本 API。

### 任务 6：两个新契约导入器及文档/AI 派生视图准备

**文件：** 创建 `packages/core/src/import/contractOpenapi.ts`、`contractCollection21.ts`、`import/schemaMapping.ts`、`design/contractMarkdown.ts`、`ai/contractView.ts`；测试 `tests/import/contractOpenapi.test.ts`、`contractCollection21.test.ts`、`tests/design/contractMarkdown.test.ts`。依赖任务 1/2，不保留两个激活 importer 名称。

- [ ] **步骤 1：写 RED。** OpenAPI 2/3 的 Path 与 Query 分离、Schema 不进入实例、servers 前缀、多响应、四类本地组件、内部引用/递归；集合 v2.1 任意深度文件夹、原 URL query 拆分、响应例、文件描述、脚本事件只给损失诊断不执行。外部引用/未知关键字逐项给 owner/path 损失诊断。

```ts
const imported = parseContractOpenapi(openapiFixture);
const asset = imported.project.collections[0].apis[0];
expect(asset.contract.request.pathParams).toHaveLength(1);
expect(asset.contract.request.query).toHaveLength(1);
expect(asset.contract.request.body).toMatchObject({ kind: 'json', content: '' });
expect(asset.contract.responses).toHaveLength(2);
expect(JSON.stringify(imported)).not.toContain('synthetic-import-token');
```

- [ ] **步骤 2：RED。** `pnpm -C packages/core exec vitest run tests/import/contractOpenapi.test.ts tests/import/contractCollection21.test.ts tests/design/contractMarkdown.test.ts`。
- [ ] **步骤 3：实现准备产物。** 新格式项目直接采用任务 1 的 ContractProject，不再定义另一套容器 DTO，最终任务 7 由标准 Project 指向唯一实现；不得写盘或系统凭据库。导入认证真实值剥离并创建未绑定 SecretRef+遮罩提示，绝不将原值放 warning/preview/hidden pending 字段。导入用户自行在凭据入口重新填入，不隐式保存。
- [ ] **步骤 4：Markdown/AI 视图。** `renderContractMarkdown(asset,context)` 与 `contractAiView(asset,context)` 接受同一快照，输出参数/响应/模型的引用 ID 和设计值，循环图按 ID 标注，不无限展开。认证只输出类型/占位符；不接受 CredentialBindings。文本/Header/Body 中的常见认证字段预览按现有脱敏约定处理，不能承诺识别任意用户故意嵌入普通正文的秘密。新增规范认证只允许 SecretRef，原文输出回归覆盖样本。
- [ ] **步骤 5：GREEN 与报告。** 聚焦测试、Core typecheck/build；完整导入图通过资产诊断，无法保留的标准特性有损失记录而非 silent strip。说明任务 7 将删除旧实现，而非并行启用两个事实源。

### 任务 7：Core 域、存储、执行内核统一切换

**文件：** 创建 `packages/core/src/domain/common.ts`；修改 `domain/model.ts`、`contract/{model,workspace}.ts`、`plugin/types.ts`、`index.ts`、`schema.ts`、`storage/fileStorage.ts`、`storage/sqliteIndex.ts`、`runner/runner.ts`、`runner/caseExecutor.ts`、`workflow/references.ts`、`workflow/runner.ts`、`workflow/validate.ts`、`workflow/impact.ts`、`stress/build.ts`、`stress/caseSession.ts`、`stress/distributed.ts`、`http/auth.ts`、`http/client.ts`、`protocol/soap.ts`、两个既有 importer 入口、`design/export.ts`、`ai/{prompt,suggest}.ts`；同步全部 Core 受影响测试。不得改 `sandbox/jsEngine.ts` 或引擎专项。

**内部执行单元：** 7a 公共叶子/标准域/Schema 导出；7b 文件存储/索引/插件存储契约；7c executeCase/集合/工作流/压测内核；7d 两导入入口/Markdown/AI 激活及 Core 全量门。按此顺序各自分派、聚焦测试、独立审核并在账本记录，只有四个单元全部通过才记 Task 7 完成。不增加用户逐单元审批，不将中间候选发布或合并；跨单元暂存的类型错误须逐点列明。

- [ ] **步骤 1：以新夹具改写 Core 行为测试形成 RED。** 全量定位 `rg -n 'ApiDefinition|preScript|postScript|\.scripts' packages/core/src packages/core/tests`，列入报告逐入口 disposition，不机械删除旧断言。用本地回环 HTTP/WS/SOAP 服务，不访问外网。
- [ ] **步骤 2：替换标准域及导出。** 先把 Environment/Operation/TestCase/Globals/StressPolicy 等叶子 Schema 移到 common.ts，新契约/容器改为直接导入 common.ts，domain/model.ts 只聚合导出，确保无运行时循环。Folder/Collection.apis 为 ApiAsset[]，Project.models/components 必有，Workspace.formatVersion=1；删除 ApiDefinition/LooseApi 及旧兼容 Schema，TestCase/容器仅 operations。旧 BodyContent/AuthSpec 移除或改为明确的执行 DTO 名称，不留持久明文认证别名。Schema 子入口只导出无副作用类型/校验，不引入凭据提供方或 Node 模块。
- [ ] **步骤 3：接入存储和索引。** fileStorage 委托任务 4，StorageAdapter.load/save 采用新状态/expectedRevision/deletions/返回 revision；更新 registry/第三方 fixture 的编译契约，但不宣称插件 API V1 版本化已实现。SqliteIndex 复用 paths、递归遍历 UUID，case 主键包含 owner+id+scope；增加 models/components/ref edges。旧缓存可丢弃重建，不迁移文件格式。
- [ ] **步骤 4：接入执行。** executeCase 输入 ApiAsset、ProjectAssetContext、CredentialBindings，唯一组装委托任务 5；CollectionRunner/WorkflowRunner 接收固定完整项目运行快照与 bindings，环境基础地址/模块变量/祖先操作全部从该快照派生，不再读活动项目。保留变量重放、数据源、祖先操作、流程桥和 failFast。stress caseSession 每 VU 独立 mutable 请求，所有 VU 共享只读 snapshot/bindings；旧 buildStressRequest 入口删除或仅委托唯一物化，不自行复制组装逻辑。

Task2审核交接：workflow references/impact 在完整项目层保留 workflow→API/case 的调用关系与删除保护；窄资产context没有workflows输入，不能用它的referencesTo/delete代替完整项目校验。Task9写入口必须接续，Task11真实操作验收；详见本计划执行账本task-2-cross-task-obligations.md。

```ts
const execution = await executeCase({
  asset, assetContext: run.snapshot.context, credentialBindings: run.credentials,
  testCase, row, rowIndex, isDataDriven, resolver, envVars, globals, persisted, persistedSnapshot,
}, deps);
expect(execution.outcome.failureKind).toBe('config'); // 缺凭据或非法结构时不进入 execute
expect(protocolExecute).not.toHaveBeenCalled();
```

- [ ] **步骤 5：保留测量与最后保护。** request/auth/scripts 的原顺序由普通本地脚本回归明确；脚本当前请求可以看到普通凭据，不向其提供 store。HTTP response body 完成前不结束请求计时；beforeSend 最终目标检查仍在脚本/认证处理后；工作流任意深度定位和完整祖先上下文保持。取消/超时/收尾连接、failureKind、requestStarted/completed 全部断言。资源/脚本专项不借机改造。
- [ ] **步骤 6：激活两个 importer/Markdown/AI 新实现。** 旧入口委托准备模块或移动新实现到旧路径后删除重复文件；只注册一个各格式 importer；AI 签名消费资产和 context，无解密值入 messages。
- [ ] **步骤 7：GREEN 和审查包。** `pnpm -C packages/core typecheck`、`pnpm -C packages/core build`、`pnpm -C packages/core test`。增加 `tests/contract/consumerIntegration.test.ts` 证明同契约同快照通过集合/流程/压测得到相同 URL/字段。报告其他包尚未切换的精确编译接点；不把 Core 全绿当阶段完成。

### 任务 8：CLI/MCP 新格式与独立凭据宿主

**内部执行单元（A 批准后）：** 8a 先完成三字段凭据身份／地址格式／共同 privateRoot 的 Core 接线与独立审核；8b 再完成以下 CLI/MCP 全量消费与 worker 回归。两单元均完成才记 Task8 完成，不增加用户逐单元审批。跨组移动纯函数与 Session/IPC 接线归 Task9，真实保存重开／历史目标绑定／失败／UI 验收归 Task11/12。

**8a 文件与步骤：** 修改 Core `credentials/{types,bindings,privateIndex,systemStore}.ts` 与 `index.ts`；新增 `credentials/host.ts`、必要的内部 `credentials/address.ts`；测试 `tests/credentials/{bindings,systemStore}.test.ts`、新 `host.test.ts` 与受影响 Core 夹具/smoke。先在真实临时目录+注入后端证明不同 group、相同 project/ref 被旧实现错误共用（RED），再实现三字段 namespace/index/lock 和全部调用点。正式位置 UUID 包括 NIL/MAX，ref 保留 string 接受域（含空串、分隔符、Unicode），路径编码不丢身份；随机 generation 校验仍单独处理。不改共享 Schema 规避格式问题。增加相邻 namespace/同组往返、删除/替换隔离、旧地址不回退、空 refs 不加载后端、固定绑定版本回归。共同 helper 精确返回 `join(homedir(), '.apicc', 'private', 'test-credentials', 'v1')`，仅命名导出于 Node 根入口，不引入 schema 子入口。完成 Node24/真实 Node22 Core test/typecheck/build、正常包声明/运行消费及独立审核，保留 Node22 SQLite warning。不声称真实 OS/ACL/打包已验收。

**8b 文件：** 修改 `packages/cli/src/main.ts`、`src/mcp/server.ts`；创建 `src/credentials.ts`、必要的共用 `src/{workspace,output}.ts`、`tests/contract-assets.test.ts`；同步 `tests/{e2e,multi-protocol-e2e,mcp-server,ai-suggest,stress-worker,stress-subprocess,stress-special-url}.test.ts` 与 fixture，其他测试只迁移受影响夹具并保留原目的。唯一 Core 例外是 `src/stress/distributed.ts` 的 credentialVersions 字典校验及 `tests/stress/distributed.test.ts`：保留所有 own 字符串键，包括 `__proto__`，不改其他协议字段／压测算法／计时。依赖任务 7/8a。

- [ ] **步骤 1：RED。** 新工作区文件夹的 CLI 与 MCP list-apis/get-api-design/run-case、workflow/stress/AI 路径；UUID 真实完整 group/project/递归位置而非按名称或后缀首项；损坏工作区只读、未来格式明确错误。本单元验 CLI 独立 fresh process 的合成凭据；打包后关闭桌面同身份 CLI 验收仍归任务12，不互相替代。
- [ ] **步骤 2：执行 `pnpm -C packages/cli test`，记录失败。** 不接受只看转译通过。
- [ ] **步骤 3：修改加载/运行上下文。** 从同一次 load 的完整 Project 建立 createProjectSnapshot，宿主运行准备只解析所选运行实际需要的 refs，空refs不加载store/native；三字段scope从明确group位置取得，共用Core默认privateRoot。现有本地 --shards 协调者选择 snapshot.definitionRevision 和 bindings.versions，将这两个无秘密描述符传入 worker spec；worker 重新加载完整项目并核对 definitionRevision，确认本次所需每个ref都有own期待版本，再用 prepareCredentialBindings(expectedVersions) 在读取前后核对所选版本。字典解析/JSON往返不能静默丢合法键，缺键不能当无期待而取新值。变化/删除在发送前 config 失败并沿既有协调收尾，不让晚启动 worker 静默改用新值。不通过 argv/环境变量/worker spec JSON 传解密值，不扩成新分布式能力。CLI 不依赖 Electron 进程或文件模块。
- [ ] **步骤 4：MCP 与输出。** 保持 list-apis/get-api-design 和 allowRun才注册的run-case，不新增get-api；summarize 使用 contract metadata/request，设计用同 context，不返回运行绑定；run-case用完整snapshot+caseSelection保留祖先上下文、不落盘。raw request/report/诊断及实际runs JSON都先脱敏投影，再保存→reporter；host不传Core runsDir自动写raw路径，报告失败仍留已投影结果。凭据缺失提供重新绑定指引，不把引用转字符串发送。CLI提供独立save/remove/status，从显式交互/标准输入取得值，禁止把实际值作为必需 CLI 参数写进 shell history；测试只使用注入 store 或专用合成命名空间。

```ts
expect(JSON.stringify(await callTool('get-api-design', { apiPath }))).not.toContain(syntheticSecret);
expect(await runCaseFromFreshProcess(workspacePath, apiPath)).toMatchObject({ passed: true });
```

- [ ] **步骤 5：GREEN。** CLI build/test，所有 worker/subprocess 真实退出与超时清理测试保留；增加延迟启动worker期间修改定义/替换或删除同ref的测试：不混用两代、旧已准备运行不变、下一次运行用新值；无实际秘密打印。报告 Node24/Node22 验证差别。
- [ ] **步骤 6：独立审核，无提交。** 不扩展 MCP 功能或分布式压测产品职责。

### 任务 9：桌面主进程、IPC 与真实资产操作

**文件：** 修改 `apps/desktop/src/main/{session,tree,ipc,debug,runs,stress}.ts`、`src/preload/preload.ts`、`src/shared/{types,channels,tree-dto}.ts`；创建 `src/main/credentials.ts`、`src/shared/credentials.ts`、`tests/main/contract-assets.test.ts`、`tests/main/credentials.test.ts`；同步 session/ipc/tree/debug/runs/stress 测试。依赖任务 7/3。

**A 接线补充：** 所有凭据操作显式带 groupId，Session 查找和移动显式源/目标完整位置。新增 Core `assets/secretRefs.ts` 及 `tests/assets/secretRefs.test.ts` 的纯 SecretRef 换新函数（窄命名根导出），仅遍历全部 API inline 认证和全部 auth 组件，统一旧→新映射，保持其他 ID/值和别名关系，不调用 SecretStore、不复刻整个 clone 算法。跨组移动候选使用此函数；同组移动/分组改名不换新。工厂返回旧 ref 或重复目标时拒绝且源不变；目标同 project.id 冲突整次拒绝；原子文件提交前不变内存。桌面使用 Task8a 同一 privateRoot helper。

**内部实施顺序（2026-10-09）：** 9a 纯换新后，先做 9b0 共用纯输出服务，再接 Desktop Session/IPC/运行。9b0 仅将已验收 CLI 的 refs 收集、标准认证 markers 与输出投影移至 Core `credentials/output.ts`，新增对应测试并窄命名根导出 `collectProjectCredentialRefs`、`collectCredentialOutputMarkers`、`createCredentialOutputSanitizer` / `CredentialOutputSanitizer`；CLI `credentials.ts` 委托、`output.ts` 薄别名，保持当前行为。输入为正式只读 project/选中 assets/已准备的内存 bindings，不查系统库、不重复物化认证算法、不改 runner/计时/worker/错误分类/策略。轻量 schema 不导出这些 host 纯服务。先真实业务 RED/GREEN，再 Core/CLI 双 runtime 完整门、公开消费与独立审核；不以此代替本任务桌面真实接线与最终 build:electron。

**桌面内部检查点（9b0局部准入后）：** 9b1为Session正式域/完整locator/命令事务与最小真实转移。仅新增Core `src/storage/definitionFiles.ts`、`tests/storage/definitionFiles.test.ts`并修改`src/index.ts`窄根导出 `listContractWorkspaceDefinitionFiles(workspace: ContractWorkspace): readonly string[]`（只复用现有encode的文件键，无IO，不公开journal/故障缝，schema不导出）；新增Desktop `src/shared/locations.ts`、`tests/main/locations.test.ts`，重写`src/main/session.ts`，新增`tests/main/{contract-assets,session-transactions}.test.ts`及`tests/main/helpers/contract-assets.ts`，共九允许文件。locator逐层workspace/group/project/collection/folderIds/实体id严格解析，保持正式UUID与逻辑case/string域，不按裸ID回退。读取/定位结果独立；所有文件写入口async自存，候选→结构/本操作引用保护→expectedRevision/明确已知目标deletions→成功后内存，readOnly/修订冲突/队列跨workspace/失败源身份及真实bytes不变必须有测试。全项目workflow按API+logicalcase成对检查；跨组move调用9a全部换ref/alias，统一clone/闭包服务而非手工reid，真实保存重开，不访问系统值。精确唯一需求与消费签名交付按同计划ledger的task-9b1-brief.md执行。

9b2随后接shared IPC/types/channels/tree DTO、preload/main严格入口与完整位置树（UI key分离域ID，深层位置保留）、最小online树适配；9b3接主进程凭据宿主、debug/collection/workflow/stress与持久输出、AI main正式context最小接线及全部受影响旧main夹具。9b1不修改IPC/renderer/runtime；其未迁移main错误和旧测试逐项交9b2/3，不删/skip凑绿。Task9最终仍须完整main测试与build:electron，Task10接renderer，Task11完整跨入口导入/转移，Task12全门/平台/打包；内部切分不缩减阶段验收、不增加用户逐单元审批、不恢复DEF-001。

**9b2精确实施边界（9b1 candidate03验收后）：** 同计划ledger的 `task-9b2-brief.md` 是本单元唯一分派需求，逐字携带全局约束。增加轻量 `src/shared/ipc-contract.ts` 统一严格载荷与频道参数/结果映射；shared/types/channels/tree-dto/locations、main/tree/ipc、preload/preload与stressBridge、online/session的树DTO最小适配同时切换，不改renderer/Core/CLI/执行宿主。Session仅窄改workflowImpact：完整Api位置可查询整API，附可选逻辑caseId时精确成对查询，先核真实API祖先，不要求物理scope，不全工作区OR查找。模型/四组件/物理case CRUD、引用反查、容器变量、环境/全局、工作流编辑、导入/克隆/移动/设计导出均有真实完整位置桥，async写只await一次Session命令，不再generic save。运行输入先切完整locator，执行body/固定snapshot与bindings仍9b3，不拆回裸ID或假停用。

树DTO区分local/online；本地kind与严格完整locator一一对应、任意folder深度、env/workflow摘要也带位置，UI key按source/kind/完整位置生成并与域id分离。线上保留数字/路径id、排序及角色，不伪造UUID。preload显式满足完整ApiccApi，独立严格类型门覆盖preload/shared，不用main tsc代替。既有authConfig缺桥补 `online:auth-config`：公开方法显式baseUrl，通过现有createClient工厂的独立匿名client委托既有authConfig，不登录、不读写token/会话；Task10把现有UI无参调用迁移到当前选中服务器（不得用常量开关或删除能力）。此为已有能力补桥，不变服务端协议。

9b2新增真实fileStorage Session的contract-ipc、真实preload桥及类型消费测试，迁移现有tree/onlineTree，补Session的workflowImpact与位置Schema回归。旧session.test.ts/ipc.test.ts混有真实执行、旧清孤儿和旧非HTTP拒绝语义，统一交9b3迁移保留行为目的；9b2不删改或skip它们，最终Task9全main/build:electron必回收。9b2可见的运行body/AI与renderer旧调用剩余诊断逐文件/位置/owner明账；聚焦绿不声称完整桌面可发布。

本机后续验证可固定Vitest文件worker上限2，所有测试/既有timeout及测试内部真实并发保留，命令与结果明确记录；不得写成默认CI已通过。9b0默认Run02/03的跨包超时与e2e共享root的可能级联仍是Task12/最终宽审必收开放项；若正式改变CI文件worker配置，须审核该配置及并发覆盖，不靠放宽timeout或skip关闭。

**9b3先行依赖（2026-10-10，9b2 candidate02局部验收后）：** 将9b3内部拆为9b3a公共有效逻辑case/只读环境解析、9b3b实际桌面运行宿主。9b3a不是新的产品范围：补齐规格§3.1既有环境覆盖、§5固定快照与§7跨入口一致性。root已模拟证实同一child环境中CollectionRunner选child而StressCaseSession选首base；CLI当前也find首case。先在Core创建`src/domain/executionSelection.ts`及`tests/domain/executionSelection.test.ts`，窄改`domain/envChain.ts`以接受正式DeepReadonly输入；公开根命名导出`selectEffectiveCases`、`resolveExecutionEnvironment`及其结果类型，不加入schema入口。runner/stress真实调用同一选择器/环境解析，CLI stress选中用例metadata与静态origin来自同一准备快照，继承模块baseUrl并遵守非空契约baseUrl优先。MCP无环境/base选择语义不扩展，Session物理case编辑仍按scope定位。

9b3a精确允许11路径：上述两个新文件、Core `src/{domain/envChain,index,runner/runner,stress/caseSession}.ts`、`tests/{domain/envChain,contract/consumerIntegration}.test.ts`，CLI `src/main.ts`、`tests/{contract-assets,stress-special-url}.test.ts`。其余产品/测试、配置/依赖、Desktop全树与引擎冻结。不得借选择修复改计时、并发、worker、超时、目标确认、最终发送校验、取消、错误分类、数据驱动或连接生命周期。先真实业务RED证明base/child不一致，再最小实现；覆盖无环境base、最近覆盖/祖先fallback、无适用版本、乱序、逻辑保序/单次执行、不同API同ID隔离、错环境和无适用压测case在操作/client/发送前拒绝、嵌套祖先、快照不变及CLI origin/实际请求一致。两个Node各Core TC/build/full、CLI build/full（文件worker2、超时不改）、正常公开包声明/runtime消费、9b2已验收Desktop七文件/严格preload回归和品牌门；完整Desktop main仍归9b3b，不提前宣称全绿。唯一需求/分派/证据按同计划ledger `task-9b3a-brief.md`，停止后冻结完整候选+实际增量、独立Sol xhigh审核。9b3a批准才启9b3b，不增加用户逐单位确认，最终Task9完整main/build:electron不减。

**9b3a接受及9b3b启用（2026-10-10）：** 9b3a按ledger的materialize补充实际十三路径交付，candidate02经原独立Sol xhigh复审及root审核后审计局部接受。上文十一初始路径和双版本宽门是原计划历史，不抹除；补充与最新用户加急验证安排见对应scope-supplement、fix-verification-update及root-verification-02。新修复只执行受影响文件/类型/构建/品牌六门，未改模块复用已核验candidate01证据，不冒称新候选全项目fresh，原SQLite和raw002索引转录Minor由Task12回收。

9b3b内部切为b1（实际凭据宿主与put/remove/status三桥）和b2（debug/collection/workflow/stress固定绑定接线、明确普通DTO投影/持久输出、AI main最低类型接线及旧main夹具回收）。b1唯一需求为同ledger `task-9b3b1-brief.md`，精确十二路径：新增Desktop main/credentials、shared/credentials及main/credentials测试；窄改main/ipc/main、shared/types/channels/ipc-contract、preload与contract-ipc/preload-contract/声明类型三测试。Core/CLI/Session主体/renderer/runtime和依赖配置冻结。host只惰性持有已有SecretStore，完整三字段scope，readOnly阻断put/remove但允许status；新ref可先存后被文件引用。prepareRun只消费输入同一snapshot及其中已选资产，唯一Core准备/输出marker算法，空refs零store；非法配置固定TypeError，凭据错误仅合法Core code/ref，不新增权限系统/沙箱专项。

按用户加急安排b1开发Node24三受影响文件一次，root新候选Node22八个桌面相关文件一次＋host/preload严格类型/preload构建/品牌，不重复未改Core/CLI整包/公开门；完整main只记录一次实际旧/新诊断归b2，不改strict、不skip旧语义。b1审核后才b2，Task9最终完整main/build:electron、Task10–12与全部历史owner不减，DEF-001仍无限期延期。内部切分及真实等价setup合并不增加逐task用户审批；如需要超出十二路径/更换开发模型/真实系统实验，则暂停并指出所需用户动作。

**9b3b1接受与b2正式启用（2026-10-10）：** b1 candidate04经原Sol xhigh两轮定向复审与root审核后审计局部接受，证据见ledger `task-9b3b1-root-verification-02.md`。原十二路径边界只约束b1；本次b2唯一需求为 `task-9b3b2-brief.md`，五生产路径main/debug、stress、ipc、ai/suggest与新增executionOutput；九测试/夹具路径main/session、ipc、debug、multi-protocol-debug、multi-protocol-save、plugins/ipc-plugins、ai/ipc-ai、新execution-credentials、现有helpers/contract-assets；另外Core runner/runner与consumerIntegration两路径最小修复完整folder路径匹配。root已用普通合成协议/字符串操作标签证实membership错误使合法顶层B操作串入目标A/B；正式回归有序prefix/同ID不同路径/空路径/正常深祖先与无selection行为，不改引擎或复制Desktop裁树。其他Core/CLI/shared/preload/b1host/Session主体/renderer/config/依赖冻结，允许路径不是强制造diff。

b2同步捕获完整scope/root/独立project与所有输入、创建一次snapshot；配置/有效case/环境在凭据与client之前检查，插件registry用惰性factory在固定准备后消费。debug/collection/workflow/stress共用b1宿主固定bindings与Core选择器/runner。workflow预检委托公开验证/项目内位置接口，strict缺引用整图不运行时prepare空refs并由Core产出失败报告。压测prepare前占用active、stop只abort且finished/finally释放，准备取消明确拒绝且不落假成功报告；没有abort的store端口须等待现有await结束。普通DTO明确Error/Date/partial结果投影，所有新IPC/警告/持久输出经过共用marker sanitizer，旧历史不回溯删改。AI仅同snapshot正式asset/context最低接线，旧bare ID跨项目多匹配先拒绝、零key-load/fetch，完整locator/来源/采纳归11。

按用户加急补充：真正等价setup/参数表合并，旧夹具迁移保留不同作用域/协议/失败阶段/生命周期与结果目的；不skip/删验收/放宽timeout。开发Node24只跑受影响Desktop八文件一次和Core consumer一次；root冻结后Core类型/构建、Node24完整build:electron先行，编译失败不启动慢套件；再Node22完整tests/main一次（worker2/原超时/JDK21）及Core consumer，品牌/diff/审计一次。未改CLI、preload/shared沿已核输入hash的证据，不重复宽测，不声称默认CI已通过。b2接受必须完整main/build双门真实通过，Task10/11/12及全部历史Minor/UNKNOWN/⚠️/Rulings不缩减，不增加用户逐task审批，不恢复DEF-001。

- [ ] **步骤 1：RED。** Session 新建、编辑 contract/模型/四类组件、重命名/引用反查/拒绝被引用删除、保存重开。坏 api.yaml + 无关资产编辑不得删原文件；存储失败不提前改活动模型；凭据与项目部分成功分别反馈。

包含workflow节点引用API/逻辑case的删除负例：完整项目层拒绝并列出调用方，活动模型及文件保持不变；不能仅核对Task2 assets/models/components窄context。克隆/导入目标已有资产及已知SecretRef身份冲突、真实绑定状态/UI与真实运行接线按task-2-cross-task-obligations.md逐项回收。
- [ ] **步骤 2：聚焦运行。** `pnpm -C apps/desktop exec vitest run tests/main/session.test.ts tests/main/ipc.test.ts tests/main/contract-assets.test.ts tests/main/credentials.test.ts`。
- [ ] **步骤 3：Session 事务。** 先 clone 候选域模型→资产校验→fileStorage.save(expectedRevision, explicitDeletions)→成功后替换活动模型/快照；加载 readOnly 状态贯穿所有写入口。删除 cleanupOrphanDirs 的内存缺失推导，改经明确删除意图；失败不损用户原件。
- [ ] **步骤 4：IPC/树。** apiGet/apiSave 传 ApiAsset；新建 API 默认 draft/none auth/none body。模型及组件 CRUD/ref impact 返回稳定 DTO；入参严格 Schema，无 Node/napi 在 renderer/preload。树 ID/label/method 从 contract 派生；case 环境定位仍复合键。
- [ ] **步骤 5：凭据宿主。** main 注入唯一 SecretStore，save/remove/status 是明确独立 IPC 操作，resolve 原值不作为通用 renderer API；输入保存值只用于该操作，不持久缓存到 editor。debug/run/stress 启动前prepare bindings；已有运行不随编辑切换。错误不泄漏 native exception。

```ts
await secretStore.put(scope, ref, 'synthetic-next'); // 独立SecretStore，不由Session保存密钥
storageSave.mockRejectedValueOnce(new Error('file-failure'));
await expect(session.saveApi(apiLocator, changedAsset)).rejects.toThrow();
expect(session.locateApi(apiLocator)?.api.contract.metadata.name).toBe(oldName);
expect(await secretStore.status(scope, ref)).toBe('available');
```

运行隔离测试另按真实 `CredentialBindings.versions` 核对非秘密generation：已准备bindings保持原值/原版本，下一次prepare取得新版本；generation不能直接断言等于保存的合成值，不引入虚构credentialVersion属性。

- [ ] **步骤 6：GREEN/审查。** 主进程聚焦测试、build:electron；renderer 未切换错误如实列入任务 10，不能关闭类型检查。对实际 Session 导入/克隆未覆盖项明确留给任务 11。

### 任务 10：桌面契约编辑、资产管理与 memory 对齐

**2026-10-10 加急执行裁定（Task9已局部接受后启用）：** 9b3b2 candidate02、原Sol定向复审及root七门/审计依据同计划ledger `task-9b3b2-root-verification-02.md`；完整main335和Electron主进程编译真实通过。Task10内部连续切为10a（统一memory、本地身份帮助函数及workspace/tree/editor/cases/design/assets草稿）和10b（实际契约/资产/凭据组件、App/树/页签/模块记忆、环境/工作流/debug/run/stress调用回收、中英文与完整renderer收口），不追加用户分批授权。共享面及验收由root开工前一次定好，单组件不单独开审核/重复fixture矩阵；同一唯一写者，上一单位局部审核接受后才启下一写者。10a精确二十路径/接口/旧消费者owner唯一来源为ledger `task-10a-brief.md`，10b必须回收其全部真实挂载消费，原Task10整体验收不减。

本地驻留身份包含目录root、workspace/group/project和完整对象路径；根目录不加入批准的三字段CredentialScope。保存开始固定资产/locator/root与提交快照，同槽继续编辑与迟到保存不误复位dirty或污染另一槽。memory只用新ContractWorkspace/ApiAsset和正式ApiccApi，优先复用已验收服务，不复制图/物化/绑定/调度，不保留旧签名兼容层；已有动态fallback边界保持，合成凭据不称系统库加密验收。只读由OpenResult.readOnly贯穿，case操作为preOperations/postOperations，物理同逻辑case多scope不首项误删。

验证精简：10a只受影响memory/store/正式入参及源码边界，root冻结后Node22同范围一次，未改main/Core/CLI按SHA继承，不重复335主进程门。10b一次完整受影响renderer及类型/模板/i18n/源码与产物边界；bundle-isolation已有真实Vite构建，不重复同输入内部构建，正式打包仍12。旧online/AI/transfer完整消费和多环境/名称净化关联仍11，准确列施工期残余诊断，不关闭strict/缩include/any/timeout放宽/skip换绿。原b2 M3签名文档/取消gate临时目录失败清理/stress同毫秒wx碰撞保留12，局部SFC夹具实际依赖变化需10核对；全部旧Minor/UNKNOWN/⚠️/Rulings与DEF-001无限期延期不变。

**文件：** 修改 `apps/desktop/src/renderer/src/stores/{editor,cases,debug,design,tree,workspace,run,stress}.ts`、`api/memory.ts`、`components/RequestEditor.vue`、`DesignPanel.vue`、`CasePanel.vue`；创建 `components/{SchemaEditor,ResponseEditor,ProjectAssetsPanel,CredentialEditor}.vue`、`stores/assets.ts`；挂载到现有项目/接口视图，不建平行项目树；更新中英 i18n。测试创建 `tests/renderer/components/contractAssets.test.ts`、`tests/renderer/stores/assets.test.ts` 并同步现有受影响 renderer 测试。

- [ ] **步骤 1：RED 实际 UI 行为。** 用户修改 metadata/status/四类参数/Body/多响应，保存关闭重开仍存在；至少各建一个模型与四类组件、两个接口引用，变更显示一致；Schema 与实例编辑分区、显式“使用示例”；删除被引用项有引用方说明。
- [ ] **步骤 2：运行聚焦组件/store/memory 测试。** `pnpm -C apps/desktop exec vitest run tests/renderer/components/contractAssets.test.ts tests/renderer/stores/assets.test.ts tests/renderer/stores/editor.test.ts tests/renderer/api/memory.test.ts`。
- [ ] **步骤 3：实现同一契约编辑。** editor 草稿只维护 ApiAsset，不能再提供旧 name/url/auth 可编辑平行字段；协议切换只保存当前有效载荷，需保留未保存切换草稿时留在 UI 临时区而非非法契约字段。SchemaEditor 递归和 ref 选择均用同项目 context，组合/递归只展示引用而非展开无限树。
- [ ] **步骤 4：凭据体验。** 输入 Token/密码后明确“保存凭据”，正常运行自动取用；另一个“保存接口”状态独立，显示可用/未绑定/不可用与部分成功。普通凭据/本地脚本可见性在说明中醒目一次展示，不每次发送弹窗；不提供假的严格保密模式。CredentialEditor 不把值放持久 Pinia/localStorage/普通 apiSave/AI payload。
- [ ] **步骤 5：memory/只读与 bundle。** memory 模拟同一新类型与失败语义，示例使用内存替身但不假称持久加密；readOnly 禁用所有写按钮且主进程仍强制。新资产 Schema 通过轻量 schema 子入口，不引入 native keyring 到 renderer；现有 bundle 外部化告警与本轮新增依赖区分，相关边界测试应证明无新增 native 提供方路径。

```ts
await wrapper.get('[data-test="credential-save"]').trigger('click');
expect(api.credentialPut).toHaveBeenCalledTimes(1);
expect(JSON.stringify(api.apiSave.mock.calls)).not.toContain('synthetic-token');
expect(wrapper.text()).toContain('凭据已保存');
```

- [ ] **步骤 6：GREEN 与审查。** Desktop typecheck/typecheck:vue/build/test，包含 i18n parity、renderer-node-imports、bundle-isolation 等原门。测试不止断言新组件可挂载，还要证明可保存重开和实际引用更新。

### 任务 11：实际导入/克隆、在线/AI 消费闭环

**文件：** 修改 `apps/desktop/src/main/session.ts` 的 importProjectToGroup/importModuleToProject/cloneProject、`main/ai/suggest.ts`、`main/ipc.ts` 的 Import/Design/AI 路径、renderer `stores/{online,importW,ai}.ts`、`components/OnlineApiEditor.vue` 与 ImportWizard/AiSuggestionsDrawer；同步 `api/memory.ts` 的相应路径。创建 `tests/main/asset-transfer.test.ts`，同步在线、AI、导入既有测试。

- [ ] **步骤 1：RED。** 实际 IPC 预览→应用模块→保存→重开，依赖闭包完整；ID 冲突整次不变；完整项目克隆统一映射 models/components/响应/示例/SecretRef/用例环境版本/工作流引用，源项目不变，新项目凭据未绑定。
- [ ] **A 移动验收：** 两组同 project.id 的凭据互不影响；跨组移动（目标无项目但有历史同 ref 绑定）保存重开后全部新 ref 未绑定、非秘密 ID/别名关系保真，分组改名保留原绑定；失败和目标冲突不改源/目标文件及内存，已启动运行不变。memory/UI 明确未绑定，不以纯函数测试替代真实 Session 路径。
- [ ] **步骤 2：在线与 AI RED。** 不支持新格式的服务端入口明确拒绝编辑/保存，不留旧编辑器；支持的新 view 同 ApiContract Schema。AI buildSuggestMessages/suggestCases 收到脱敏新视图，建议采用写 cases 侧资产而非请求定义。
- [ ] **步骤 3：GREEN 实现。** Session 模块导入调任务 2 bundle 闭包服务，完整项目克隆调 cloneProjectDefinition 的统一映射，再按任务 9 文件事务提交。验证克隆环境baseUrls指向新模块、工作流apiId/caseId与边端点均闭合，保存重开仍可定位；源不变。模块导入先检查全部目标 ID，再整次应用。线上不增加账号或服务端作为本地前置，不自动上传凭据，不扩展服务端格式协议；只读限制明确文案。旧 online buffer 中的 ApiDefinitionSchema/原文 auth 编辑入口移除。

```ts
const cloned = await session.cloneProject(projectLocator);
await session.open(root);
const reopened = session.locateProject({ ...projectLocator, projectId: cloned.id });
expect(reopened?.project).toEqual(cloned);
expect(await session.validate()).toEqual([]);
```

真实转移测试还须经独立SecretStore.status验证克隆新refs未绑定，并验证实际IPC preview/apply脱敏，不用不存在的Session.close/getProject或未定义的模拟成功helper。模块多环境歧义的正式选择入口属于本任务必需能力；完整项目导入需净化的环境名称、extends与case.scope关联必须真实保存重开验证，不能以9b1不携环境的模块回归替代。

- [ ] **步骤 4：验证。** `pnpm -C apps/desktop exec vitest run tests/main/asset-transfer.test.ts tests/main/ai/ipc-ai.test.ts tests/renderer/stores/online-workspace.test.ts tests/renderer/components/onlineWorkspace.test.ts tests/renderer/stores/importW.test.ts tests/renderer/stores/ai.test.ts`，再 desktop 完整 build/test。
- [ ] **步骤 5：审查。** 检查各依赖资产类型逐类闭合，不能以一种演示组件绿灯替代四类。现有服务端/AI 登录凭据降级不在本任务重构，但在交付已知限制中保留。

### 任务 12：统一激活、真实后端打包与阶段验收

**文件：** 同步全部剩余 fixture、`apps/desktop/electron-builder.yml`、`scripts/check-contract-assets.mjs`、`apps/desktop/scripts/smoke-credentials.mjs`；新增阶段验收记录 `docs/superpowers/reviews/2026-10-07-apicc-f1-acceptance.md`。不修改 server 业务或旧冻结工作树。

- [ ] **步骤 1：核对所有旧入口。** `rg -n 'ApiDefinition|LooseApi|ApiDefinitionSchema' packages apps --glob '!**/dist/**' --glob '!**/dist-electron/**' --glob '!**/node_modules/**'`；生产源码应无旧类型/Schema，文档历史提及和 fixture 说明逐条记账。检查旧脚本字段只存在历史文字，不保留新格式解析入口；不删除现有脚本引擎或取消执行来凑测试成功。
- [ ] **步骤 2：建立统一消费测试。** 新建工作区/两接口/模型/四类组件/普通凭据→保存重开→HTTP/WS/SOAP→集合/流程/压测→Markdown/MCP/导入克隆；每个路径使用同 revision、同材料化入口、明确 failureKind，编辑后新 run 见新修订，旧 run 不变。请求计时/连接回收/最终目标保护与既有 A/B 门有映射测试。
- [ ] **步骤 3：全量门禁。** 冻结安装、Core typecheck、`pnpm -r build`、`pnpm -r test`；结束后单独 server Maven test；品牌自检/跟踪树扫描+所有未跟踪候选显式扫描。失败保留日志，不以修改预期值或忽略测试静默抹掉。Node22.19+ 与 Node24 的声明/CLI/提供方单独记录。
- [ ] **步骤 4：真实打包冒烟。** 需要 Electron 二进制时执行现有 install.js，不更换 runtime 版本。`pnpm -C apps/desktop gen:icon`、`pnpm -C apps/desktop dist:dir`、`pnpm -C apps/desktop smoke:dir`。原生 keyring 平台包进入打包产物、正确 unpack，使用专用合成命名空间从已打包 Electron 保存/重开读取；关闭应用后 CLI 同身份读取；验证不打印凭据。不能只凭 require 成功就宣称 roundtrip。
- [ ] **步骤 5：验收矩阵与最终宽范围审核。** 正式报告按规格 §11 的十项逐行列命令/测试/候选 hash/结果/未验证平台，Known Limitations 不消失；主智能体生成包含全部未提交修改和未跟踪文件的候选审查包，独立 Sol xhigh 做整个分支规格+质量审核，处理发现后定向复审。仅本机 Windows 实证不宣称其他平台通过。
- [ ] **步骤 6：交付不集成。** 保留工作树与全部账本，给用户代码状态、计划完成度、包路径、剩余真实限制；不自动 git add/commit/merge/push。最终若有未解决 Important/Critical，不宣称 F1 完成。

## 覆盖与交接

| 规格章节 | 实现任务 | 必需证据 |
|---|---|---|
| 1–3 权威/版本/聚合 | 1、7、12 | 严格格式、旧入口移除、延期无改动 |
| 4 全契约/Schema/实例 | 1、5、6、10 | 字段往返、负向请求、实际编辑 |
| 5 引用/快照/克隆 | 2、7、9、11 | 递归图、固定修订、真实闭包 |
| 6 存储/写保护/索引 | 4、7、9 | 故障矩阵、原件保留、UUID/复合键 |
| 7 物化/执行/测量 | 5、7、8、9、12 | 跨入口等价及 A/B 回归 |
| 8 凭据/脚本边界 | 3、7–10、12 | 默认真实后端、部分成功、无泄漏/无扩权 |
| 9 全消费矩阵 | 6–12 | 两导入器/文档/AI/online/CLI/desktop |
| 10–12 门禁/状态 | 全部、12 | 逐任务审核、完整候选与真实平台证据 |

每项报告必须包含 RED/GREEN 命令和退出码、文件清单/hash、自审、已知剩余调用点；工作区/报告路径由控制者分派时明确。无新授权不更换开发模型。发现任务过大时只细分同阶段内部交付和测试面，保持规格/整体验收不变，不回用户逐 task 审批。
