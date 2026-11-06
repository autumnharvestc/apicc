# F7g 外部规范同步整阶段实施计划

> **开工确认（2026-11-04）：** 用户已批准按本计划 T1–T14 开工，沿用 Sol high 开发、Sol xhigh 独审，并包含 Windows 打包 CI 前移到候选分支／PR。Git 提交／合并／推送和每次本地全量仍须当次授权。

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 或 executing-plans 逐任务实现本计划。步骤使用复选框记录。以下编制回执保留开工前历史，执行以本段及任务账本为准。

> **执行节奏调整（2026-11-04）：** 按用户加快开发、保持回溯范围的要求，同职责的关联合同／校验／接线合批，共用夹具与构建；实现者核实并留存有效 RED 后连续完成 GREEN，正常批次无需等待控制者逐批放行。合同歧义、无效前提或范围变化仍及时裁决。每批保留源码快照／哈希、补丁及测试清单，每个 T 任务保留原来的独审验收点；网络、权限、原子提交的任务边界保持。

> **测试顺序关卡修正（2026-11-05，覆盖上段的自动 GREEN 部分）：** T4 完整顺序缺口已由用户接受如实记录，保留实现，以必要行为验证和独审验收；这不豁免新修改。后续每个较大的逻辑批次先汇总合法前提、实际失败断言、日志和未改产品快照，由控制者一次内部核对后进入 GREEN。仍按同职责合批，不增加逐保护项的用户确认或重复宽审。

**目标：** 本地和在线项目可绑定 URL、Git HTTPS、Git SSH 规范来源，通过共用 Core 得到稳定 ID、三方差异和固定候选；人工确认后原子应用并可持久回滚，在线定时检查只生成候选。

**架构：** Core 承载规范归一化、映射、三方比较和引用校验；`@apicc/execution` 承载受控来源宿主。桌面与私有 Node 运行服务复用这两层，Java 管理权限、材料、领取、版本与事务，不复制解析／合并算法。检查不依赖测试 Job，不增加代理代抓或自动应用。

**技术栈：** 现有 TypeScript、Zod、Node 22.19.0、pnpm 11.21.0、Vue／Pinia、Java 21／Spring Boot／H2、Git 与 OpenSSH；复用现有本地写入日志和私有 Core RPC。

**规格：** [已确认的 R0 基线](../specs/2026-11-04-apicc-f7g-external-sync-design.md)、[复用评估](../specs/2026-11-04-apicc-f7g-reuse-assessment.md)。页面遵循[展示规范](../../ui-presentation-guidelines.md)，验证遵循仓库 `AGENTS.md`。

## 1. 准入、范围与协作约束

- 基线为本地 main `b31b6b1a`，产品基线 `26063656` 对应 CI89 五任务通过。本计划及准备文档尚未提交；实施前创建独立工作区时须带上最终批准的设计、计划与最新验证约定，不能从旧工作区带回默认全量规则。
- 开工已获批准，沿用 Sol high 开发、Sol xhigh 独审；临时升级 Sol max 另申请。每个交付物完成一次定向审核，修正仅定向复核；不逐轮重开全分支审核。
- 默认运行受影响测试与必要回归，远端 CI 是独立证据。本地整仓、全工作区、Java 全套、`test-all.ps1`、完整 `pre-push-ci.ps1` 或等效拆分全量，均须用户对本次明确确认；重跑另确认。
- 不自动提交、合并、推送、启动真实同步计划或操作真实仓库／账号。任务中的“留档”指源码身份、实际命令、退出码和回执；Git 集成等用户当次授权。
- 本地检查位置为当前电脑，在线为服务端私有来源宿主；无静默客户端回退。Git／SSH 使用已安装的受支持工具；缺失明确诊断，不自动下载安装器。
- 不增加自动应用、Git 写入、代理代抓、多文件／远程 `$ref` 自动遍历、任意脚本、MCP／CLI 新命令或共享 AI 网关。既有 CLI 继续消费普通 apicc 契约。
- F7b 三项遗留仍排 F7g 后；[F7f 两项风险](../../f7f-known-risks.md)不因后续通过而关闭。独立部署调度 B、到达率 B、DEF-001 等延期不恢复。

## 2. 测试顺序与证据关卡

1. 每个新增行为先列出合法前提、真实入口、预期失败断言、受影响集合，再写测试。认证、目标项目、预算组合、来源文件和触发身份必须先核对。
2. 新模块加载、导出、测试夹具和工具可用性单独核对；缺模块、404、缺 Git／SSH、错误预算组合不算业务 RED。仅为入口可调用提供的不含业务校验的声明／接线，不能夹带保护分支；Zod 校验、权限与额度判断也属于业务行为。
3. **实现前阅读实际 RED：** 必须执行到目标断言，记录实际值与预期值以及命令退出码；没有有效 RED 就不放行该批产品逻辑。新增保护分支逐批检查，不只给主流程一条 RED。
4. GREEN 后运行该任务明列的定向回归、构建／类型／边界检查，独审只核该交付物。后补测试、变异或撤回代码验证可以补充正确性证据，不能改写为实现前 RED。
5. 使用临时测试夹具、真实 HTTP、隔离 Git 仓库和 SSH 服务验证承重边界；不为可读性补全页面快照，不循环运行到绿，不仅增加超时或放宽断言。
6. 下文命令是实施阶段检查清单，本轮未运行。执行前设置 JDK 21 和 `APICC_TEST_NODE`；Node／pnpm 使用技术栈中固定版本。Java 通过下列 PowerShell 函数按明确类名运行，Windows／Linux 自动选择已有 wrapper，每次生成独占绝对输出目录，并从打印出的目录收集新 XML；不混入旧输出、不传通配符。该函数不属于新产品代码。

```powershell
function Invoke-F7gJavaTest {
  param([Parameter(Mandatory)][string]$Tests)
  if ($Tests -notmatch '^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$') { throw 'Exact test classes required' }
  $repoRoot = (Resolve-Path .).Path
  $javaOutput = Join-Path $repoRoot ('local/f7g/java-' + [guid]::NewGuid().ToString('N') + '/maven')
  $wrapper = if ($IsWindows) { './server/mvnw.cmd' } else { './server/mvnw' }
  Write-Output ('Fresh Java output: ' + $javaOutput)
  & $wrapper -s server/.mvn/settings.xml -f server/pom.xml "-Dapicc.build.directory=$javaOutput" "-Dtest=$Tests" test
  if ($LASTEXITCODE -ne 0) { throw "Targeted Java tests failed: $LASTEXITCODE" }
}
```

## 3. 全阶段合同与文件职责

路径约定：每项先列完整包路径，其后省略前缀的同组文件归入该包的同目录；Core／execution 的 `tests/` 均相对对应包根。Java 新增 `sync/*.java` 源码均位于 `server/src/main/java/com/autumnharvestc/server/sync/`，同名新增测试及 `SyncHttpFixture.java` 位于 `server/src/test/java/com/autumnharvestc/server/sync/`；私有运行 Node 测试位于 `apps/collaboration-runtime/tests/`。客户端和管理台文件按 T12／T13 明列根目录；不创建同名的第二套目录。

### 3.1 命名和数据边界

T1 定义严格 schema 及同名类型，后续任务不得自行改名或另建同义 DTO：

| 名称 | 职责 |
| --- | --- |
| `SyncSource` | `url`／`git-https`／`git-ssh` 判别来源、稳定来源 ID、修订、目标模块、网络及材料引用、计划。只含引用，不含密钥值和本机工具路径。 |
| `SyncPolicy`、`SyncPolicyValues`、`SyncEffectivePolicy` | 保存层含 formatVersion／revision／scope（workspace 或 project）与可选 R0 覆盖字段，缺省字段不先填默认；完整值与有效值另有严格类型。有效值逐字段标明 default／workspace／project／deployment 来源、保存修订、部署上限及下一轮生效说明，显式填成默认值仍是本层覆盖。scope 仅为来源元数据，在线必须由可信路由核对，不代替权限。 |
| `SyncDeploymentLimits` | 宿主可信限制，至少含 `maxWireBytes` 与 `envelopeReserveBytes`；其余限制使用现有宿主已解析的有界配置，不由客户端上报或放大。 |
| `SyncStamp` | 项目资产身份、来源修订、映射修订、基线修订、授权代次、Core 身份；本地用既有 `createProjectSnapshot(project).definitionRevision`，在线另绑定十进制字符串资产版本，不转成 JS Number。本地写入仍另用当前工作区 `expectedRevision`，不能把二者混用。 |
| `SyncUpstream` | URL 最终来源及 SHA-256；Git 对象格式、完整 commit／blob OID 与原文 SHA-256。Git OID 不假设永远只有 40 位。 |
| `SyncIdentityMap` | 来源命名空间、外部实体键与 apicc UUID、已确认别名／人工对应、归属与映射修订；覆盖可引用子实体。 |
| `SyncCandidate` | 固定 stamp／upstream、候选摘要、语义诊断、分层变更、冲突和真实引用影响。每个 `SyncChange` 必填 `summaries:{baseline,current,source}`，使用 strict 的 absent／scalar／array／structure 有界业务摘要及截断事实，不能只有哈希或冲突项才有值。摘要预览上限为标量文本 240 个 UTF-16 单位、属性名 80、数组 5 项、结构 8 个属性，含实际截断标记；这些是展示合同上限，不截断固定原文。不含任意 `raw/project/unknown` wire 字段。 |
| `SyncCandidateView` | 不可变候选与当前 `applicable`／`reasonCode` 分开返回；读取过期候选仍能解释原因，不能为了刷新状态改写候选内容。 |
| `SyncDecisions`、`SyncResolvedPlan` | 对每个稳定 changeId 的 `take-source`／`keep-current`／`map-existing` 决策，解析后的文件变更、基线与映射更新、回滚前后摘要。 |
| `SyncReceipt`、`SyncHistoryEntry` | 稳定操作身份、应用／回滚结果、`afterStamp`、操作者、完整性和受保护引用。Receipt 不持久化自己的新存储 CAS，以免同步旁表参与 CAS 时形成自指摘要；本地协调器另读当前存储 CAS。历史持久化，不是内存 undo token。 |
| `SourceReadInput`、`SourceReadResult` | 宿主内的固定来源、期限／预算／取消输入，以及固定版本、原文和诊断输出。材料通过单独的 `SourceMaterialLease` 注入，不能序列化回项目或 UI。 |

Core 的公开函数由 T2／T3 完成：

```ts
export declare function normalizeSyncSource(input: SyncNormalizeInput): SyncNormalizedSource;
export declare function buildSyncCandidate(input: SyncPlanInput): Promise<SyncCandidate>;
export declare function resolveSyncCandidate(input: SyncResolveInput): Promise<SyncResolvedPlan>;
export declare function buildSyncRollback(input: SyncRollbackInput): Promise<SyncResolvedPlan>;
```

这里是导出签名，实际实现分别位于 T2／T3 文件，不把 `.d.ts` 声明当成可执行入口。T1 在 `sync/policy.ts` 导出 `resolveSyncPolicy(requested: SyncPolicy, deployment: SyncDeploymentLimits, inherited?: SyncEffectivePolicy): SyncEffectivePolicy`。输入／输出类型都由 `packages/core/src/sync/types.ts` 导出。`SyncNormalizeInput` 包含原文、来源身份、已有映射、稳定分配种子及预算；`SyncNormalizedSource` 明确提供 `files`、`mapping`、按外部键排序的 `entityIds`、`manifestDigest` 与 `diagnostics`。三方输入使用 B／L／R 文件清单和 stamp，不直接在 RPC 上暴露复杂契约内部对象；另以必填 `normalizationDiagnostics` 保留归一化诊断、`otherSourceMappings` 提供可信协调者传入的项目内其他来源归属。`SyncResolveInput` 包含固定候选、全部决策和对应三方输入；回滚输入除固定历史、当前文件与修订外，必填已解引用的 `beforeFiles`／`afterFiles`、当前 `mapping`／`baselineFiles`／`otherSourceMappings` 及比较 `budget`。三个规划函数返回 Promise，以复用真实异步文件解码与现有引用图，不另建同步解码器；规范化入口保持同步。

新增实体分配算法命名为 `apicc-sync-id-v1`：对 UTF-8 的 `JSON.stringify(['apicc-sync-id-v1', sourceId, entityKind, externalKey])` 求 SHA-256，取前 16 字节，设置 UUID 版本位为 8、variant 为 RFC 兼容值，再格式化 UUID；外部键包含稳定父实体键，不采用可变化的数组序号。T2 固定字节级 golden、碰撞／已有 ID 占用拒绝和算法版本；确认后的映射始终优先，不依赖每次 `randomUUID()`。这里的摘要用于确定性命名，不代替权限或完整内容校验。普通一次性导入继续保留既有行为。changeId 和 candidateDigest 使用带版本的规范字段序列化及完整 SHA-256，由固定输入确定，不能混入检查时间或请求随机 ID。

Core 新增 `@apicc/core/sync` Node 入口及 `@apicc/core/sync/shared` 浏览器安全类型／展示入口。宿主新增 `@apicc/execution/source-host`，不能经 renderer 导入 Node、私钥或进程 API。`createSourceHost(trustedOptions)` 捕获受信网络批准、prepared 网络解析与私有缓存 owner，返回 `SourceHost.readSource(input, materialLease, signal)` 三参数方法，输出 `SourceReadResult`；无环境／全局隐式批准。退出、取消和错误必须在其拥有的网络／子进程实际收束后结算。

### 3.2 持久化与在线接口

- 本地新增 `projectDirectoryPath(location) + '/synchronization.yaml'` 严格同步旁表索引，由 `SyncWorkspaceState` 独立装载，归入写入日志的受管理路径；不塞进 `ContractProject` 业务对象。索引只含来源引用、修订、映射与有界历史摘要；基线／回滚内容按完整 SHA-256 分文件放在项目 `synchronization/content/` 下，名称、字节、摘要及严格内容类型逐项校验，不能一次展开所有历史。相关资产、索引与内容文件作为同一写入日志事务的一部分；普通资产保存保留旁表。检查／候选状态写入会改变工作区存储修订，但不能改变项目资产指纹或让刚存下的候选自行失效；提交时先核资产 stamp，再用最新存储 CAS。临时原文、Git 对象库和材料在宿主私有目录，不能打包进普通契约分享、运行快照或发布副本。
- 服务端 `sync_sources`、`sync_checks`、`sync_candidates`、`sync_history`、`sync_operations`、`sync_policies` 六类数据由 `SyncRepo` 和 `SyncHistoryService` 统一维护。`sync_sources` 保存来源修订、映射修订、确认基线和其有界内容；候选保存不可变的 B／L／R 清单或受保护的内容寻址引用，历史保存已提交差异及回滚内容；引用计数与额度同事务更新。H2 使用幂等加法升级，保留现有项目／ACL 表与版本历史。
- 在线基础路径为 `/api/v1/workspaces/{ws}/projects/{project}/sync`。来源 `sources` 的创建／读取／版本化更新，`sources/{id}/checks` 的 POST 检查、`checks/{id}` 的 GET／POST cancel，`candidates/{id}` 的 GET，`applications` 与 `rollbacks` 的 POST，以及 `operations/{intentId}`、`history` 的 GET 分别明确职责。检查立即返回 202 和 checkId，不让客户端一直阻塞等待 Git。
- 写请求均携带预期来源／项目修订和稳定 intentId；创建修订用 `0`，旧对象不能因删除重建重置历史。应用还携带候选摘要和完整决策摘要；回滚携带目标 historyId。恢复查询不能泄露其他用户无权访问的回执。
- 当前项目资产写入仍是权威，不能用“同步专用 API”绕开资产授权、脚本分类或文件路径验证。锁外网络／RPC，短事务重新读取、校验并提交。

### 3.3 配置基线

逐字沿用 R0 的默认与范围：计划关闭，启用预填每小时／UTC、最小间隔 60 秒；连接 10 秒（1–60）；URL 总期限 60 秒（5–600）；Git 总期限 120 秒（10–1800）；总尝试 1 次（1–3）；原文 5 MiB（64 KiB–16 MiB）；比较输入／输出 16／8 MiB（1–64 MiB／256 KiB–32 MiB）；Git 材料 256 MiB（32 MiB–2 GiB）；项目／宿主并发 1／4（1–4／1–16）；候选 24 小时（5 分钟–7 天）；每来源历史 30 天／100 条（1–365 天／1–1000 条），项目／全局总字节另受存储额度约束。

T2 有限解析预算的实施细化：`maxNormalizeDepth` 默认 128，整数 16–256；`maxNormalizeNodes` 默认 100000，整数 1000–1000000。二者在保存覆盖、完整有效策略及 `SyncNormalizeInput.budget` 同名，实际规范化输入显式携带。别名展开后的节点／深度和字节在构造完整 JS 对象前核对；源模型的合法 `$ref` 递归不当作 YAML 别名环。T7／T12／T13 接入真实配置和单位；不声明解析器或操作系统内存硬保证。

这些值已随整阶段开工集中确认，由 T1 开始实现。有效值还受部署 RPC、字节封装、内存和磁盘限制约束；上级限制不被项目扩大，非法组合保存时拒绝。采样 Git 磁盘阈值与部署硬配额分别命名，不把阈值冒称零超量硬保证。已有普通 RPC 默认 10 秒不能悄悄把 120 秒 Git 检查截短；T8 增加来源读取专用期限上限，保留其他操作原期限。

### 3.4 任务依赖

`T1 → T2 → T3` 是 Core 主线；`T1 → T4 → T5` 是来源宿主；两条就绪后完成 T6 本地闭环。`T1 → T7` 建在线权限／来源基础，`T3 + T5 + T7 → T8 → T9 → T10 → T11` 建在线闭环。`T6 + T10 + T11 → T12` 客户端，`T7 + T11 → T13` 管理台，T14 最终集中联验。不同任务碰同一文件或生成边界时顺序集成，不并发写共享合同。

## 4. 任务清单

### T1：来源、策略、状态与 wire 合同

**交付物：** 严格、可序列化的单一合同及合法合成夹具，能解释默认值与上级限制；不是只有类型名字的空入口。

**文件：**
- 创建 `packages/core/src/sync/types.ts`、`shared.ts`、`policy.ts`、`index.ts`；修改 `packages/core/package.json`。
- 创建 `packages/execution/src/contract/synchronization.ts`；修改 `contract/index.ts`；创建 `packages/execution/scripts/generate-java-sync-schema.mjs` 及 `server/src/main/resources/sync-input-boundary.json`，添加对应生成／检查命令。
- 创建 `packages/core/tests/sync/fixtures.ts`、`contract.test.ts`；创建 `packages/execution/tests/syncContract.test.ts`。

- [x] **1. 写合法夹具和保护断言。** `fixtures.ts` 导出 `syncFixture()`：用现有 `parseContractOpenapi` 构造合法 Pet 项目和 `/pets/{id}` 接口，包含 Pet 模型、200 响应、用例与真实引用；固定来源、模块、stamp 和只含内部 `$ref` 的 OpenAPI 3.1 文本。夹具提供 `normalizeInput`、`localProject`、`planInput()`：后者在调用时从当前 `localProject` 编码 L，不能捕获修改前的旧对象。导出 `urlSource()`、`gitHttpsSource()`、`gitSshSource()` 和 `defaultSyncPolicy()`，都必须先通过正常 schema 路径。无效样本由合法样本只改一个字段。

```ts
it('rejects SSH without approved host-key material', () => {
  const input: Record<string, unknown> = { ...gitSshSource() }; delete input.knownHostsRef;
  expect(SyncSourceSchema.safeParse(input).success).toBe(false);
});
it('rejects a project budget above the deployment wire ceiling', () => {
  expect(() => resolveSyncPolicy(defaultSyncPolicy(), {
    maxWireBytes: 8 * 1024 * 1024, envelopeReserveBytes: 128 * 1024,
  })).toThrowError('SYNC_POLICY_INVALID');
});
```

- [x] **2. 观察 RED。** 运行 `pnpm -C packages/core exec vitest run tests/sync/contract.test.ts --maxWorkers=2`，确认分别进入 SSH 材料、整数／范围、跨字段预算、来源判别和版本校验的断言；加载错误不记业务 RED。
- [x] **3. 最小实现。** 实现有限来源类型、稳定错误码和有效策略；拒绝未知字段、URL 内嵌口令、非法版本、非规范路径与不合法预算组合。HTTP／SSH 认证值不进入 Source 类型。wire schema 表达结构、判别、整数及固定范围；跨字段有效策略由显式 `resolveSyncPolicy` 校验并配合同一组合同夹具验证 Java 保存入口，不把该函数伪称为 JSON Schema 已表达的规则。生成器只接受可完整表达的严格 wire schema，遇到未表达 refinement 失败，不放宽成 `any`。
- [x] **4. GREEN 与检查。** 运行上述 Core 文件和 `pnpm -C packages/execution exec vitest run tests/syncContract.test.ts --maxWorkers=2`；运行两包 build／typecheck 与新 `check:java-sync-schema`。受影响旧协作边界按第 5 节更新并核对。
- [x] **5. 留档与定向审核。** 核对每一类新拒绝都有实际 RED／GREEN；提交前的约束定义不得把行为校验称作“声明脚手架”。

### T2：来源归一化与稳定实体 ID

**交付物：** 相同来源重复解析得到稳定实体身份；重命名与歧义能解释，普通导入不改变既有语义。

**文件：** 创建 `packages/core/src/sync/normalize.ts`、`identity.ts`；修改 `import/contractOpenapi.ts` 中 ID 分配接缝及 `sync/index.ts`；创建 `tests/sync/identity.test.ts`、`normalize.test.ts`，复用 `tests/import/contractOpenapi.test.ts`。为有限解析预算允许增量修改 `sync/types.ts`、`policy.ts`、对应合法夹具及生成资源；只添加第 3.3 节两项配置，原十三项数值保持。

- [x] **1. 写身份回归。** 覆盖接口、模型、参数、响应、组件、引用子实体；准备同来源两次、operationId 改名但路由相同、路由变更但已有对应明确、两者都变且候选歧义、重复 operationId、跨来源相同路由。

```ts
it('keeps confirmed API and response identities across source refresh', () => {
  const f = syncFixture();
  const first = normalizeSyncSource(f.normalizeInput);
  const again = normalizeSyncSource({ ...f.normalizeInput, mapping: first.mapping });
  expect(again.entityIds).toEqual(first.entityIds);
  expect(again.manifestDigest).toBe(first.manifestDigest);
});
```

- [x] **2. RED。** `pnpm -C packages/core exec vitest run tests/sync/identity.test.ts tests/sync/normalize.test.ts --maxWorkers=2`；断言必须证明随机身份／错误匹配，而非找不到新模块。
- [x] **3. 实现。** 使用第 3.1 节的 `apicc-sync-id-v1`，确认映射优先；显式保留别名和资产归属，冲突不猜配。首次绑定现有模块时，路由／operationId 只生成匹配建议，已有实体的归属接管须明确确认。普通导入默认继续随机 ID；同步复用解析与诊断但注入稳定分配。只接受明确支持的版本和单文档内部引用，报告外部引用与保真度缺口；YAML 别名展开、深度和节点数在有限解析预算内校验，不先无限展开再检查大小。

  文件语义：返回项目相对文件清单，导入 collection.id 固定为 source.moduleId；内部项目容器 ID 按来源命名空间确定性生成，只用于规范化容器，不获得对目标项目根身份的所有权。T3 以实际目标项目／stamp 绑定并保留其 project.yaml 根身份。
- [x] **4. GREEN／回归。** 上述两文件，加 `tests/import/contractOpenapi.test.ts`；Core build／typecheck。golden 记录 UUID 分配、映射与内容摘要，不能只检查实体数量。
- [x] **5. 留档／审核。** 审核重点是模型／响应子 ID、同来源重放、跨来源归属与普通导入兼容。

### T3：Core 三方候选、完整决策与回滚校验

**交付物：** B／L／R 差异、引用影响与候选摘要统一；任何未解决冲突、失效 stamp 或危险回滚都不能变成提交计划。

**文件：** 创建 `packages/core/src/sync/compare.ts`、`resolve.ts`、`rollback.ts`、`presentation.ts`，以及最小共用 `files.ts`（规范文件／摘要／真实解码）和 `mapping.ts`（typed 对应／引用重写）、`summary.ts`（有界业务摘要事实）；修改 `sync/index.ts`、`shared.ts`、`types.ts` 及受影响的合同／wire 夹具与生成资源；创建 `tests/sync/compare.test.ts`、`resolve.test.ts`、`rollback.test.ts`。复用 `assets/context.ts` 和现有 Mock／测试引用图。

- [x] **1. 写真实三方表。** 至少覆盖仅本地编辑、仅上游变化、同值并发、同字段冲突、不相交变化、依赖删除、保留当前、缺决策、重复决策、映射歧义及回滚后续编辑。`fixtures.ts` 补充 `candidateFixture()`，返回包含一个实际未解字段冲突的合法 `planInput`、`candidate`、`resolveInput` 与对每项显式作出的 `keepCurrentDecisions`；不能用空变化样本验证缺决策拒绝。

```ts
it('keeps the local edit when upstream is unchanged', async () => {
  const f = syncFixture(); f.localProject.collections[0].apis[0].contract.metadata.description = 'local';
  const result = await buildSyncCandidate(f.planInput());
  expect(result.changes.filter(c => c.fieldPath.endsWith('/description'))).toEqual([]);
});
it('rejects an unresolved conflict before producing writes', async () => {
  const f = await candidateFixture();
  await expect(resolveSyncCandidate({ ...f.resolveInput, decisions: { ...f.resolveInput.decisions, entries: [] } })).rejects.toThrowError('SYNC_DECISION_REQUIRED');
});
```

- [x] **2. RED。** 运行 `pnpm -C packages/core exec vitest run tests/sync/compare.test.ts tests/sync/resolve.test.ts tests/sync/rollback.test.ts --maxWorkers=2`；每个拒绝均须进入对应真实业务前提。
- [x] **3. 实现。** 变更按资产／字段分层；非来源拥有的用例、脚本、环境与凭据绑定保留。采用来源和保留当前都要明确记录；取消不推进基线。引用损坏、跨来源占用或删除未解决则阻止计划。回滚要求当前目标摘要与历史 after 匹配，生成新版本计划而不恢复整份工作区。只反转该记录造成的资产变化，保留当前已确认上游基线和映射，作为相对已确认上游的本地覆盖；协调器原子生成新修订，不倒退上游认知或版本。内容引用的规范载荷为 UTF-8 JSON.stringify(按 path 排序的 [{path,content}])，digest／bytes 基于该载荷；manifestDigest 沿用 T2 版本化 tuple 算法，不能混用。
- [x] **4. GREEN／回归。** 上述三文件，已有 `tests/import/merge.test.ts` 和 `tests/collaboration/mutation.test.ts`；Core build／typecheck。展示结果用业务 DTO，Schema 原文仅高级详情，不把 JSON 文本当主单元格。
- [x] **5. 留档／审核。** 同时核对内容、实体 ID 和真实引用，不以“保留接口 ID”代替子实体完整性。`map-existing` 覆盖来源实际生成的 API、模型、同类组件及可引用参数／响应／示例；父子决策和目标父归属必须一致，typed 引用重写不得替换业务 JSON 字符串。显式重命名可对应同一来源已确认的旧身份，保持安全别名及唯一 ID，不只接纳未归属本地实体。目标模块身份固定，不扩为任意目录／用例迁移或本地凭据授权转移。

### T4：共享 URL 来源宿主与网络／材料边界

**验收状态（2026-11-05）：** 已通过任务审核及定向修正复核，冻结 `task-4-controller-m1`。历史 R1–R8／U1–U14 的测试顺序缺口已获用户接受如实记录，补充行为验证不追认为原始先红；新 I1/I2 修复有有效先红。产品候选 105 项及构建／类型／编译出口通过，最后测试计时修正另验单项。详见本阶段 SDD 账本与 T4 回执，未运行本地全量。

宿主配置细化（2026-11-05）：`maxRedirects` 默认 5，整数 0–20；0 允许初始正常响应但禁止跟随跳转。工厂在借用材料／发起网络前拒绝非法宿主配置。T6 的本机设置与 T8 的部署配置必须实际传入此值，保留逐跳批准、origin 身份隔离及单一总期限；不扩大公开项目同步策略。

**交付物：** 有界 HTTP(S) 规范读取，身份、认证、CA、实际连接目标、取消和 304 行为可核对。

宿主接缝实施细化：受信 factory 捕获 `PreparedNetworkRun`／`policyIdentity`／`approveDestination(url,address)`，逐跳固定实际批准地址；原始租约 HTTP 头及客户端 TLS 身份只用于初始 origin。304 缓存为可选、受保护且有界的宿主 adapter，绑定完整来源及修订、稳定实际材料身份、prepared／policy 身份与完整原文／upstream 摘要，不能以随机 leaseId 作为稳定材料身份；未命中不能伪造304内容。网络 profile 本身不代替目标地址批准，不能安全固定目标的代理明确拒绝。`onContent(content,signal)` 私有回调在200／已验证304交付只读 `SourceValidatedContent`（完整原文／通用 upstream／私有 bindingIdentity）；每检查实例闭包接到内容后，协调者按当前映射重新归一化，不能复用旧候选。回调不提交资产或推进基线，失败不得假成功。

**文件：** 创建 `packages/execution/src/source-host/types.ts`、`index.ts`、`network.ts`、`materials.ts`、`url.ts`、`limits.ts`；修改 `packages/execution/package.json` 添加独立宿主出口；创建 `tests/sourceHost/url.test.ts`、`network.test.ts`、`fixtures.ts`。

- [x] **1. 建真实 HTTP／HTTPS 合成源。** `fixtures.ts` 导出 `withSourceServer(callback)`，回调取得 `url`、CA、调用次数、可控分块响应、带认证且跳向不被批准来源的 `redirectSource`、`redirectTargetRequests()` 和 `read(input, overrides)`；finally 关闭自身连接。覆盖 304 的完整内容缓存绑定、读到一半断开、内容超额、重定向跨来源认证、DNS 切换、受批准内网／被拒内网、CA 错误与取消；304 后项目变化的候选失效在 T6／T9 验证。

```ts
it('does not forward credentials to a redirect origin', async () => {
  await withSourceServer(async f => {
    await expect(f.read(f.redirectSource)).rejects.toMatchObject({ code: 'SYNC_NETWORK_DENIED' });
    expect(f.redirectTargetRequests()).toHaveLength(0);
  });
});
```

- [x] **2. RED／历史偏差处置。** 本步骤依本节用户已接受的 R1–R8／U1–U14 完整记录完成，后补验证不称严格先红。 `pnpm -C packages/execution exec vitest run tests/sourceHost/url.test.ts tests/sourceHost/network.test.ts --maxWorkers=2`；源端确实启动并执行到网络／字节／证书断言。
- [x] **3. 实现。** 复用已声明网络与材料引用解析，禁止隐式认证回退。解析并固定允许的最终地址，逐跳检查，读取和解压后都受预算。不能安全保持策略目标的代理模式明确拒绝，不能默默直连。材料只借给本次读取，源与计划里不落值。重试只处理允许的只读暂态，受同一个总期限约束。
- [x] **4. GREEN／检查。** 上述文件和 execution build／typecheck；已有网络实现只跑实际受影响文件，不能顺手跑 execution 全套。
- [x] **5. 留档／审核。** 保留实际请求次数、字节与取消收束事实，密钥、正文与原生路径不写普通日志。

### T5：Git HTTPS／SSH 固定对象读取与进程收束

> **执行回执（2026-11-05）：** T5 已通过任务独审及 I1 定向复审，接受快照 `task-5-controller-i1`。原始先红与后补验证按报告区分；历史 174 项和后续 5／3 项的实际 runner 版本未记录，不冒称实跑 Node 22。本轮 I1 固定 Node 22 的反例、5 项定向验证及编译包消费已确认。真实新包、干净 Linux 与部署验证仍属 T14，未运行本地全量或新远端 CI。

**交付物：** 同一来源宿主支持两种 Git 协议、严格主机／证书校验和受控进程；读取的内容由完整提交与 blob 固定。

**文件：** 创建 `packages/execution/src/source-host/git.ts`、`process.ts`、`gitCredentials.ts`、`ssh.ts`、`tools.ts`；补 `index.ts`；创建 `tests/sourceHost/gitHttps.test.ts`、`gitSsh.test.ts`、`process.test.ts`、`tools.test.ts` 与 `tests/sourceHost/git-fixture.mjs`。

- [x] **1. 建隔离合成仓库和服务。** `git-fixture.mjs` 导出 `withGitSource(callback)`，由 `fixtures.ts` 转出供 TS 测试使用；回调包含 `readSsh(overrides)`、`wrongHostKeyRef`、`blobsRead()`、HTTPS 对应入口及进程屏障。夹具创建私有 bare 仓库、固定分支和单入口规范；HTTPS 使用临时 CA／认证，SSH 使用临时主机钥、受限只读账号和 authorized_keys。Windows 真实 SSH 联验可连本机隔离 Linux 服务；缺服务是夹具阻断，不能记业务 RED 或假通过。

```ts
it('rejects a changed SSH host key before reading a blob', async () => {
  await withGitSource(async f => {
    await expect(f.readSsh({ knownHostsRef: f.wrongHostKeyRef })).rejects.toMatchObject({ code: 'SYNC_HOST_KEY_MISMATCH' });
    expect(f.blobsRead()).toBe(0);
  });
});
```

- [x] **2. RED。** 明确观察 HTTPS 认证／CA、SSH 主机钥／口令、路径、受控配置、Git 材料和取消各分支失败。运行 `pnpm -C packages/execution exec vitest run tests/sourceHost/gitHttps.test.ts tests/sourceHost/gitSsh.test.ts tests/sourceHost/process.test.ts tests/sourceHost/tools.test.ts --maxWorkers=2`。
- [x] **3. 实现。** 通过管理员配置的可信绝对路径及能力预检选择 Git／SSH，`spawn(toolPath, args, { shell: false, env: controlledEnv })` 只接应用生成参数。隔离对象库中固定执行 init、无递归 fetch、commit／树／对象类型检查及不带 filters／textconv 的原始 blob 读取，不建工作树；关闭 hooks、LFS、非白名单协议与环境／用户配置继承。HTTPS 使用已核对的解析固定能力且保持 TLS 校验；SSH 使用应用生成的隔离配置、固定目标和严格主机钥检查，不继承 ProxyCommand／SSH agent。凭据桥接文件由应用生成，不能接项目提供的命令；工具缺少必需能力即明确拒绝。分支移动、符号链接、gitlink、LFS 指针、非法路径、错误对象类型明确拒绝。
- [x] **4. GREEN／收束证明。** 运行上述文件和 T4 的 URL 邻接回归。对暂停中的实际读取发取消，证明所拥有 PID／后代已退出、临时密钥已删除后才释放槽位；进程归属不能确定时保留占用并报告原因，不能杀无关 PID。测试容器使用 init 回收孤儿；源缓存采样阈值与硬配额证据分开。
- [x] **5. 留档／审核。** 验证完整 OID／SHA-256、分支移动前后 blob、无真实仓库写入、无秘密命令行和错误输出，不以模拟 spawn 回调代替实际 HTTPS／SSH 承重证据。

### T6：本地来源、候选、应用与跨重启回滚

> **执行回执（2026-11-05）：** T6 已通过任务独审及 I1–I3 定向复审，接受快照 `task-6-controller-fix1`。经用户明确确认，T6 测试顺序偏差集中记录、补必要真实行为验证并交唯一独审验收，不将后补测试称为原始先红；此处理不自动沿用到 T7。取消／绝对期限、同内容过期重查和物理目录别名额度三项修复的 8 项定向验证通过，分组历史、类型／编译及边界证据另列；未称单次全绿或完成整阶段门禁。生产配置／材料与私有目录提供者、原生界面与新包生命周期由 T12／T14 接入和验收。

**交付物：** 从本地来源配置到候选、确认应用和重开后回滚的完整事务闭环，普通导入撤销仍独立工作。

**文件：** 创建 `packages/core/src/sync/storage.ts`、`state.ts`；修改 `storage/contractFiles.ts`、`definitionFiles.ts`、`paths.ts` 的旁表装载／受管理路径，复用 `writeJournal.ts`，保留 `contract/workspace.ts` 中业务项目与同步旁表分离；创建 `apps/desktop/src/main/sync/local.ts`、`types.ts`、`tests/main/sync/fixtures.ts`。创建 `packages/core/tests/sync/storage.test.ts`、`apps/desktop/tests/main/sync/local.test.ts`，回归 `tests/storage/contractFiles.test.ts` 与 `tests/storage/writeJournal.test.ts` 的受影响用例。

- [x] **1. 写事务和恢复用例。** `openLocalSync(root, deps)` 由 `main/sync/local.ts` 导出；`tests/main/sync/fixtures.ts` 的 `withLocalSync(callback)` 创建并负责清理合法项目与私有目录。回调提供 `check()`、`apply(candidate, decisions, intentId)`、`reopen()`、`rollback(historyId, intentId)`、`readProject()`；还提供 `applyPreparedChange()`（真实检查并明确采用来源后应用，夹具另记 `beforeStorageRevision`）、`newIntent()`、`unrelatedAssetBytes()`、只读初始值 `originalUnrelatedAssetBytes` 和 `storageRevision()`。覆盖写到中途故障、应用后重启、后续编辑拒绝回滚、响应／刷新失败后回执恢复和重复 intentId。资产指纹在内容被精确恢复时可相同，新增历史及映射／基线修订仍保证提交身份前进；不要求相同内容产生不同资产摘要。

```ts
it('restores a persisted sync after reopen without replacing unrelated assets', async () => {
  await withLocalSync(async f => {
    const applied = await f.applyPreparedChange(); await f.reopen();
    await f.rollback(applied.historyId, f.newIntent());
    expect(f.unrelatedAssetBytes()).toEqual(f.originalUnrelatedAssetBytes);
    expect(f.storageRevision()).not.toBe(applied.beforeStorageRevision);
  });
});
```

- [x] **2. RED。** 运行 `pnpm -C packages/core exec vitest run tests/sync/storage.test.ts --maxWorkers=2` 和 `pnpm -C apps/desktop exec vitest run tests/main/sync/local.test.ts --maxWorkers=2`。`withLocalSync` 为 fixtures 中拥有清理职责的包装，先核其合法项目和故障注入确实触发。
- [x] **3. 实现。** 按第 3.2 节旁表与资产分离，状态路径严格注册，来源、候选摘要、资产、映射、基线和历史／回执同日志提交，临时下载与密钥目录不进入该集合。候选绑定资产指纹，存储 CAS 独立更新；正常存候选、同源状态刷新不得自行作废候选。缓存只是缓存，崩溃恢复不靠缓存猜测提交。私有原文／基线预算及引用保护落在状态读写层；普通契约分享、执行快照与发布投影不含同步旁表或私有材料。
- [x] **4. GREEN／回归。** 上述两文件和受影响存储、导入文件；Core、desktop main 类型检查。普通项目无同步状态时继续解码；格式错误不能被当成空同步状态后覆盖。
- [x] **5. 留档／审核。** 核对资产与基线没有半提交、回滚版本递增、已确认保留当前不会反复弹同一冲突，以及切工作区后的迟到读取／提交不会作用于新工作区。

### T7：在线来源、策略、凭据用途与有限权限

**交付物：** 新表和来源／策略 API 接入当前授权权威，能安全保存和展示来源，但尚不执行假测试任务。

**文件：** 创建 `server/.../sync/SyncDtos.java`、`SyncRepo.java`、`SyncPolicyService.java`、`SyncSourceService.java`、`SyncSourceController.java`、`SyncPolicyController.java`、`SyncMaterialService.java`；修改 `resources/schema.sql`、`application.yml`、`access/Capability.java`、`ProjectAccessService.java` 及必要的能力写入验证。创建 `server/src/test/java/com/autumnharvestc/server/sync/SyncHttpFixture.java`、`SyncSourceApiTest.java`、`SyncPolicyTest.java`、`SyncMaterialsTest.java`。

本计划 `server/.../` 均指 `server/src/main/java/com/autumnharvestc/server/`；测试路径均完整列出。

- [x] **1. 真实 HTTP 先红。** `SyncHttpFixture` 复用 `AccessHttpFixture` 的真实合法项目／成员和版本，不用失权样本模拟成功。测试类使用该夹具提供的 `sourceBody(kind)`、`createSourceAsAdmin(kind)`、`sourceUpdateBody(source)`（含当前修订）、`readSourceAsAdmin(id)`、`editor()` 及 `sourceRequest(method, path, caller, body)`；后者把正文和状态同时交给断言。覆盖 VIEWER／EDITOR／ADMIN、显式 deny、NONE、移除重入、凭据管理、重复来源、修订上下界、默认／项目／部署预算及密钥不回显；材料解析另通过 `SyncMaterialService` 的实际授权入口验证，真实 checks HTTP 入口留到 T9。

```java
@Test void editorWithoutDelegatedManageCannotChangeASource() throws Exception {
    var source=createSourceAsAdmin("git-ssh");
    sourceRequest("PUT", "/sources/"+source.id(), editor(), sourceUpdateBody(source))
        .andExpect(status().isForbidden());
    assertThat(readSourceAsAdmin(source.id()).revision()).isEqualTo(source.revision());
}
```

- [x] **2. RED。** `Invoke-F7gJavaTest -Tests 'SyncSourceApiTest,SyncPolicyTest,SyncMaterialsTest'`。T7 只验证本任务已接入的来源／策略／材料入口，不能调用 T9 尚未提供的 checks 路由；版本与授权拒绝必须各有合法成功对照，404 不算授权 RED。
- [x] **3. 实现。** 增加 `sync.manage`、`sync.check`、`sync.apply`，均下限 EDITOR；manage 内置仅 ADMIN／OWNER 默认授予，check／apply 给 EDITOR 及以上，既有 deny／委派规则保留。解析材料必须携带来源身份、授权主体和用途，不能伪造 agent Job 或回退本机凭据。所有新表升级幂等，旧项目无来源即空列表。
- [x] **4. GREEN／回归。** 上述三类，加 `AccessPolicyResolutionTest`、`ProjectAssetsApiTest` 的受影响用例；核 source DTO 与 T1 生成 schema 一致。只运行明确测试类，不运行 Java 全套。
- [x] **5. 留档／审核。** 核权限与版本保护、真实信封存储、跨项目材料拒绝、部署策略配置入口和旧 ACL 生命周期；不要复制一套局部角色判断。

> T7 执行回执（2026-11-05）：实现与唯一独审、I1 定向修复复核已完成（C0/I0/M0）。新同步用例77，另生命周期4；受影响 Java 回归35及删除8，客户端指定文件117，实际构建／类型／边界证据见任务账本；这些分批运行，不是单次全量。保留原 RED／工具版本和静默 tsc 回执可见性限度，未运行本地全量、远端新 CI 或 Git 集成。

### T8：私有 RPC 与可取消的来源宿主接线

**交付物：** Java 能调用同一 SourceHost／Core，长检查受专用期限约束，断连和取消能收束真实网络／Git 子进程。

**文件：** 修改 `apps/collaboration-runtime/src/protocol.ts`、`handlers.ts`、`server.ts`、`limits.ts`；创建 `sourceHost.ts`；修改 Java `collaboration/runtime/RuntimeProperties.java`、`CollaborationRuntimeClient.java`、`RuntimeProtocol.java`；生成 `resources/collaboration-runtime-boundary.json`。创建 Node `tests/sync-runtime.test.ts`、Java `sync/SyncRuntimeClientTest.java`，回归已有 runtime 协议／取消测试。

- [x] **1. 写真实协议承重测试。** 既有 envelope 追加有限 `sync-read`、`sync-plan`、`sync-resolve`、`sync-rollback` 操作，不开放通用执行。`sync-read` 使用 T4／T5 合成源；`tests/sync-runtime-fixture.ts` 导出 `withSyncRuntime(callback)`，提供 `startBlockedGitRead()`、`disconnect(pending)`、`capacity()`、`allowOwnedChildExit()`、`waitCollected(pending)`。屏障控制本轮真实子进程的退出与收集，必须证明 abort 后仍实际存活及最终退出，不能只扣住一个模拟完成通知。Node HTTP 调用真实断连，确认 AbortSignal 到达且子进程收束前预算仍占用。Java 测试让合法读取超过原普通 10 秒门限但小于本次来源期限，证明不会被旧上限截短。

```ts
it('retains the source slot until real child collection after disconnect', async () => {
  await withSyncRuntime(async f => {
    const pending = await f.startBlockedGitRead(); await f.disconnect(pending);
    expect(f.capacity().held).toBe(1);
    await f.allowOwnedChildExit(); await f.waitCollected(pending);
    expect(f.capacity().held).toBe(0);
  });
});
```

- [x] **2. RED。** 使用真实 server 与 T5 可控子进程夹具，运行 `pnpm -C apps/collaboration-runtime exec vitest run tests/sync-runtime.test.ts --maxWorkers=2` 及 `Invoke-F7gJavaTest -Tests 'SyncRuntimeClientTest'`，拒绝只 mock 一个已解决 Promise。
- [x] **3. 实现。** `handleOperation` 的默认分支也取得请求 AbortSignal；同步解析／合并调用唯一 Core。新增 `apicc.collaboration.runtime.source-read-timeout-max-ms`，默认／上限 1800000 ms、可配 1000–1800000 ms；每次实际期限取来源配置和部署上限较小值，保存时拒绝总期限超出有效上限的配置。该期限包括读取及正常收束；到期开始取消，实际仍未收束须保持占用并显示原因，不谎报恰在期限内已退出。普通／Mock 原期限不扩大。输出摘要、Core 身份、操作／请求身份和字节封装校验继续严格；旧 source generation 不能覆盖新调用。材料不进普通日志与响应。
- [x] **4. GREEN／检查。** Node／Java 上述文件、现有 `CollaborationRuntimeClientTest` 和实际受影响 Node 协议文件；运行 runtime build、生成边界及 `--check`。未知操作、未知字段、摘要不符、版本不兼容、期限与消息超额均需具体拒绝断言。
- [x] **5. 留档／审核。** 特别核默认生产 handler 的 signal，而非只有测试注入 handler 可取消；也核关闭运行服务时真实清理，不把 HTTP 错误返回当作进程已结束。

> T8 执行回执（2026-11-05）：实现与唯一独审、并发初始化 I1 修复定向复核完成（C0/I0；M1 既有日志噪声保留非阻断）。Node 主批48、独立 wire 补充1及重叠别名1、既有回归85，Java指定两类63；修复新2＋旧5定向7，构建／类型／边界分别通过，均为分批证据，非一次全量。Core RPC 身份 fdf046…；保留原 RED／无效前提与工具版本限定。未执行本地全量、真实新镜像部署或远端新 CI，无 Git 集成。

### T9：在线手动检查、固定候选与失效代次

**交付物：** 来源检查形成持久、可读取的固定候选，刷新、并发、304 和权限变化不会错用旧数据。

**文件：** 创建 Java `sync/SyncCheckService.java`、`SyncCheckWorker.java`、`SyncCandidateService.java`、`SyncCheckController.java`、`SyncCandidateController.java`；扩展 `SyncRepo.java`。创建 `SyncChecksTest.java`、`SyncCandidatesTest.java`、`SyncCheckCancellationTest.java`。

> T9 接线细化（T8 后实际消费者预飞）：在线资产 API 只有存储版本／文件 manifestHash，没有 Core 语义 definitionRevision；T9 允许最小调整同一有限 `sync-plan` 私有输入／handler，由既有 Core decoder／snapshot 完成在线 stamp，再生成候选。保留公开 T1 stamp 严格性、已有完整指纹不匹配拒绝，不复制 Java 算法、不新增通用操作；先以实际 Java 数据库资产取得有效功能 RED，再纳入同一次 T9 独审。材料使用沿用真实注册版本／字节上界与 source-check 解密接缝；全局授权代次使用实际单调项目修订及必要材料生命周期接入，不能用无序哈希或跨成员不可比较的本地 epoch 替代。

- [x] **1. 写有真实 Core 的 HTTP 场景。** 首次检查、重复 intentId、同源并行、不同来源、304 后本地变化、来源修改、检查期间撤权、取消、失联和迟到完成都需合法成功对照。`SyncHttpFixture` 增加 `createUrlSource()`、`checkToCandidate(source)`（通过真实 202 及状态读取等到完成）、`editProjectWithCurrentVersion()`、`readCandidate(id)` 和 `sourceHostCalls()`；读取返回 T1 的 `SyncCandidateView`。夹具记录实际来源读取／Core 调用次数，不以数据库插行代替真实候选产生。

```java
@Test void changedProjectInvalidatesACompletedOldCandidate() throws Exception {
    var c=checkToCandidate(createUrlSource());
    editProjectWithCurrentVersion();
    var view=readCandidate(c.id());
    assertThat(view.applicable()).isFalse();
    assertThat(view.reasonCode()).isEqualTo("project-assets-changed");
}
```

- [x] **2. RED。** `Invoke-F7gJavaTest -Tests 'SyncChecksTest,SyncCandidatesTest,SyncCheckCancellationTest'`。T9 的候选过期先由候选读取／校验入口证明；真实 applications 写入拒绝由 T10 再验证，不能用尚不存在的应用路由 404 充数。
- [x] **3. 实现。** POST 检查返回持久 checkId；工作者锁外领取材料／读取和计算，结果写入再核来源修订、授权和代次。Node 自身持有来源互斥直到实际收束，Java 不能因失联便假定宿主已释放；重新领取遇忙明确等待，不把旧结果接回新代次。重复上游快照可复用内容，但当前项目 stamp 必须重新比较；固定候选不可被后台覆盖。
- [x] **4. GREEN／回归。** 上述三类及 T7 材料／权限受影响用例，验证原文只在私有材料空间，列表与状态返回可读摘要、原因码和有限定位。
- [x] **5. 留档／审核。** 记录一次真实“请求取消 → IPC／网络收束 → 槽位释放”事实，权限、来源变更与迟到结果覆盖用确定性屏障而非固定睡眠。

> T9 执行回执（2026-11-05）：唯一独审规格／质量通过，C0/I0/M0。冻结24文件；同候选Java指定65项通过（本任务46＋受影响旧19），Node定向4项、类型／构建／边界通过；原两个304场景另补事实，不加算独立用例。用户接受本任务同类顺序偏差集中记录／验证／独审，原始记录与限定保留。恢复证据为同JVM第二Spring上下文，不代替T11／T14真实进程生命周期；未执行本地全量、页面／打包／新部署或新远端CI，无Git集成。

### T10：在线原子应用、回执、回滚和保留

**交付物：** 资产、映射、基线、历史／计费和回执同事务完成；重复提交、丢响应及跨重启回滚有明确事实。

**文件：** 创建 Java `sync/SyncApplicationService.java`、`SyncOperationService.java`、`SyncHistoryService.java`、`SyncRetentionService.java`、`SyncApplicationController.java`、`SyncHistoryController.java`；将必要原子资产写入接缝提取到 `execution/assets/ProjectAssetsService.java`，仍经过原授权／分类。创建 `SyncApplyTest.java`、`SyncRollbackTest.java`、`SyncOperationReceiptsTest.java`、`SyncRetentionTest.java`。

> T10 消费者接线细化：私有 resolve／rollback 现只返回计划，在线持久历史还需 Core 内容引用与规范正文；可在原有限操作中最小组合既有 `encodeSyncContent` 输出，不新增通用操作，不在 Java 重写内容摘要／序列化算法，原严格输入路径保留。在线回执／历史的宿主元数据可复用既有规范 JSON 摘要并使用明确在线命名空间；Core 仍独占解析、合并与回滚判断。先以实际 Java 应用／持久历史／Core 回滚取得有效消费者 RED，完整输出仍受 wire 预算约束，最终资产事务内不调用 RPC。

- [x] **1. 写真实事务失败与恢复测试。** 应用时版本改变、脚本权限不足、引用删除、回执同身份重放／不同正文、断响应后查询、提交前故障、重启回滚、后续编辑拒绝回滚、配额耗尽与受保护历史不可删。`SyncHttpFixture` 增加 `newIntent()`、`dropOnlyThisSuccessfulApplyResponse(intent)`（事务提交后、写 HTTP 响应前只断该请求）、`submitApplication(candidate,intent)`（明确采用来源；丢响应抛 `IOException`）、`readOwnOperation(intent)` 和 `applicationMutationCount(intent)`（查实际提交事实）。并发测试应证明实际提交／回滚，不把“请求已返回”当事务或审计已收束。

```java
@Test void lostApplyResponseIsReconciledWithoutASecondMutation() throws Exception {
    var candidate=checkToCandidate(createUrlSource());
    var intent=newIntent(); dropOnlyThisSuccessfulApplyResponse(intent);
    assertThatThrownBy(() -> submitApplication(candidate,intent)).isInstanceOf(IOException.class);
    var receipt=readOwnOperation(intent);
    assertThat(receipt.committed()).isTrue();
    assertThat(applicationMutationCount(intent)).isEqualTo(1);
}
```

- [x] **2. RED。** `Invoke-F7gJavaTest -Tests 'SyncApplyTest,SyncRollbackTest,SyncOperationReceiptsTest,SyncRetentionTest'`；合法来源与预算先通过，确认失败确属目标事务／保护；补 T9 旧候选在真实应用入口的 409 与资产无变化断言。
- [x] **3. 实现。** 固定读 → 锁外 Core resolve／脚本分类 → 短事务重验 → 同事务资产／映射／基线／历史／回执／必要审计。回滚提交新版本，当前目标不匹配则冲突；不能恢复全工作区。计费仅算实际持久内容及引用，受保护记录不按普通过期删除；空间不足拒绝新操作，不能删除基线换取成功。其他用户回执读取走当前授权并防越权枚举。
- [x] **4. GREEN／回归。** 上述四类，必要 `ProjectAssetsApiTest`、`CollaborationAuditTest` 中受影响用例；fresh XML 与实际数据库版本／摘要、故障回滚证据对应同一源码。
- [x] **5. 留档／审核。** 核长网络／RPC 没持项目锁，提交时仍重验，旧 generic assets PUT 和同步新入口都无权限旁路；不做无关事务大重构。

> T10 执行回执（2026-11-05）：唯一独审三项 Important 已由原实现者集中修复并经原审查者定向复核，规格／质量通过，C0/I0/M0；接受快照 task-10-controller-fix1。原候选混合定向77项通过；修复后受影响19项通过（含新增5项，不累加为一次全量），Java编译完成。原Node4项、类型／构建／边界结果按原候选归档，未对未改Core／TS重复执行。每来源历史、无效策略维护隔离和有限进展预留已恢复原规格；local对应修复明确交T12。保留原失败、受控探针和同JVM重开限定；未执行本地全量、页面／打包／新部署、新远端CI或Git集成。
### T11：后台检查、重启防重与失权暂停

**交付物：** 客户端关闭后在线计划仍检查，但只生成候选；停用、撤权、凭据变更和后端重启不能触发旧写入。

**文件：** 创建 Java `sync/SyncScheduleService.java`、`SyncOccurrenceService.java`、`SyncScheduleDriver.java`、`EmbeddedSyncScheduleDriver.java`、`SyncScheduleTimer.java`、`SyncScheduleController.java`；复用 F7d `ScheduleRuleCalculator`、`ScheduleTimeSource`，不改其测试 Job 提交语义。创建 `SyncScheduleRulesTest.java`、`SyncScheduleOccurrencesTest.java`、`SyncScheduleLifecycleTest.java`。

- [x] **1. 写真实触发和授权测试。** 默认关闭、Cron／UTC／DST、同 UTC 触发重复领取、手动与定时同源竞争、后端重启、旧代次迟到、计划暂停、主体移除／NONE／能力 deny／凭据撤销。`SyncHttpFixture` 增加 `enabledHourlySource()`、`projectVersion()`、`tickAtSameUtcInstantTwice(source)`（注入既有时钟接缝，两次调用实际 driver／领取事务）、`awaitOneCompletedCheck(source)`（有界等待真实检查）、`checkCountForTrigger(source)` 和 `automaticApplicationCount()`（查真实持久记录）。每个场景记录检查数、候选数与资产版本，不能仅检查定时器注册。

```java
@Test void duplicateTimerTicksNeverApplyAssets() throws Exception {
    var source=enabledHourlySource(); var version=projectVersion();
    tickAtSameUtcInstantTwice(source);
    awaitOneCompletedCheck(source);
    assertThat(checkCountForTrigger(source)).isEqualTo(1);
    assertThat(projectVersion()).isEqualTo(version);
    assertThat(automaticApplicationCount()).isZero();
}
```

- [x] **2. RED。** `Invoke-F7gJavaTest -Tests 'SyncScheduleRulesTest,SyncScheduleOccurrencesTest,SyncScheduleLifecycleTest'`，合法时钟与真实数据库领取前提须达到目标断言。
- [x] **3. 实现。** 默认不启用计划；后台使用明确主体的版本化授权，失效记录可读原因并暂停后续领取，不换管理员身份。领取／取消／恢复使用 source generation 和稳定触发身份；只生成候选。保留驱动接缝，不实现独立服务 B。同步定时器独立命名与注册，现有清理／通知测试只核自己的注册，不要求所有定时器同一间隔。
- [x] **4. GREEN／回归。** 上述三类，加 `ScheduleRulesApiTest` 的实际受影响用例。用一次隔离进程重启与关闭桌面后检查证明持续性，不启动真实用户计划或长时间循环实验。
- [x] **5. 留档／审核。** 核暂停旧授权不覆盖新授权、事务回滚不留下旧拒绝；发现旧已知风险相关现象先保留证据，不能借本任务宣称其已修复。

> T11 执行回执（2026-11-06）：唯一独审两项 Important 已由原实现者最小修复并经原审查者定向复核，规格／质量通过，C0/I0/M0；接受快照 task-11-controller-fix1。原三类42项、修正后同JVM组合22项及strict9项／scope2项分别归档；最终修复受影响8项通过，不累加成一次全量。真实Windows两次后端进程、同Node／DB／URL与定时器证明重启防重和后台只检查；Linux实际单方法因Windows依赖绑定前提不足尚未执行，明确交T14正确Linux环境验证。保留原失败、固定时钟注入和旧风险限定；未运行本地全量、页面／native打包、新镜像、新远端CI或Git集成。

### T12：客户端本地／在线同步界面与迟到结果保护

**交付物：** 项目内同一入口可管理来源、查看固定差异、明确决策、应用和回滚；中文／English 可读，不把数据序列化当页面。

**文件：** 创建 `apps/desktop/src/shared/synchronization.ts`、`main/sync/ipc.ts`、`main/online/synchronization.ts`、`renderer/src/stores/synchronization.ts`、`renderer/src/components/sync/SyncPanel.vue`、`SyncSourceForm.vue`、`SyncDiffView.vue`、`SyncHistory.vue`；修改 `shared/channels.ts`、`ipc-contract.ts`、`types.ts`、`preload/preload.ts`、`renderer/src/App.vue`、两种 i18n。未带 `apps/desktop/src/` 前缀的上述源码路径均相对此目录。创建 main／store／组件对应测试，复用现有导入与在线会话测试结构。

- [x] **1. 写真实交互。** 新增 `tests/main/sync/ipc.test.ts`、`tests/renderer/stores/synchronization.test.ts`、`tests/renderer/components/sync/SyncPanel.test.ts`；覆盖本地／在线位置、Git／SSH 材料状态、超额／失效原因、未解冲突禁用、保留当前后的确认、丢响应查询回执、刷新失败不重放、切项目立即清旧候选与迟到返回拒绝。

```ts
it('clears the old candidate when project scope changes', async () => {
  const f = mountSyncPanel(); await f.showCandidate('project-a');
  await f.switchProject('project-b');
  expect(f.visibleCandidate()).toBeNull();
  await f.completeOldRequest();
  expect(f.visibleCandidate()).toBeNull();
  expect(f.applicationCalls()).toHaveLength(0);
});
```

- [x] **2. RED。** `mountSyncPanel` 在 `tests/renderer/components/sync/fixtures.ts` 定义，使用合法 T1／T3 DTO，提供代码片段中的 `showCandidate`、`switchProject`、`visibleCandidate`、`completeOldRequest`、`applicationCalls` 方法；运行 `pnpm -C apps/desktop exec vitest run tests/main/sync/ipc.test.ts tests/renderer/stores/synchronization.test.ts tests/renderer/components/sync/SyncPanel.test.ts --maxWorkers=2`，新增 main 权限／上下文保护也要对应入口 RED。
- [x] **3. 实现。** 主进程保有材料和持久候选；renderer 使用安全 DTO 与 scope token，切换开始立即清候选／旧错误。界面逐字段呈现 B／L／R、冲突／依赖和决策，不渲染整段 JSON 主视图。原始 OpenAPI／Schema 仅专用高级详情；版本短显可展开，日期含毫秒和时区，单位一致。不能自动点击应用、发布、测试或回滚。
- [x] **4. GREEN／检查。** 上述文件和与新入口接线直接相关的 `App.test.ts` 用例；desktop build／typecheck／typecheck:vue，renderer Node-import 防线检查；集中原生验收交给 T14，不逐任务反复开包。
- [x] **5. 留档／审核。** 审核实际文本、清除／搜索／焦点、局部滚动和禁用原因；不以翻译 key 存在、按钮数量或 mock DTO 字段齐全代替页面验收。

> T12 执行回执（2026-11-06）：接受未提交快照 task-12-controller-fix2。可信生产接线、异步上下文／材料边界、持久操作与预览分离、在线网络材料语义表单、默认折叠的固定 B/L/R 完整资产详情及有限错误消息均已接入；独审原六项和直接 reader 修正，经原审查者两轮定向复核后规格／质量通过，最终 C0/I0/M0。固定详情扩展使用共用 Core 投影、有限 RPC 与当前项目读权限，不复制比较算法；Markdown／YAML 如实区分。命名客户端58项、Core10项、RPC与Java3项等证据分轮留档，最后错误通路 client5项／客户端6项及构建与边界通过，不累加为一次全量。原失败与夹具／依赖前提修正保留。原生视觉、真实工具／GitSSH、Linux及新镜像联验交T14；未运行本地全量、打包、部署、新远端CI或Git集成。

### T13：管理台分层策略、有限能力与只读审计

**交付物：** 管理员可读地配置有效来源策略、授权和材料状态；业务来源／差异仍在客户端项目内，管理台不复制编辑器。

**文件：** 创建 `apps/admin-web/src/api/synchronization.ts`、`views/SyncPolicyView.vue`、`views/ProjectSyncAccessView.vue`、`components/SyncPolicyFields.vue`；修改 `router/index.ts`、相关工作区／项目入口和两种 i18n。创建 `tests/views/SyncPolicyView.test.ts`、`ProjectSyncAccessView.test.ts`；必要扩展 Java策略与能力读取 DTO。

- [x] **1. 写 DOM／权限用例。** 合法管理员配置、无内容读取权的管理目录、EDITOR 被明确委派／deny、部署硬限制只读、项目不能扩大上级、有效值／来源／保存版本／单位、中英长名称和错误状态。

```ts
it('shows effective inherited limits without presenting JSON as configuration', async () => {
  const f = mountSyncPolicyView({ level: 'project', effectiveSource: 'workspace' });
  expect(f.row('Git 检查总期限').text()).toContain('秒');
  expect(f.row('Git 检查总期限').text()).toContain('工作区');
  expect(f.primaryConfigurationPre()).toHaveLength(0);
});
```

- [x] **2. RED。** 上述两个文件明确命名运行：`pnpm -C apps/admin-web exec vitest run tests/views/SyncPolicyView.test.ts tests/views/ProjectSyncAccessView.test.ts --maxWorkers=2`；`mountSyncPolicyView(options)` 在 `tests/views/sync-fixtures.ts` 定义，返回 `row(label)`（实际渲染行）与 `primaryConfigurationPre()`（主配置区 pre 元素）；不能用失权样本模拟保存成功。
- [x] **3. 实现。** 表单呈现默认、保存、有效、来源、版本、单位与生效方式；来源／密钥摘要、主机信任状态和检查审计用表格，密钥不回显。菜单／路由使用当前权限，错误拒绝由服务端再次判定；保留顶栏语言持久选择与项目长名布局。
- [x] **4. GREEN／检查。** 两文件、实际受影响路由／权限测试、admin build／typecheck；实际浏览器只集中验证新增页面，不扫全部旧页面。
- [x] **5. 留档／审核。** 核可管理与可读内容不混淆，网络／工具部署权限不下放给普通项目写入，未注册后续功能不出现空开关。

**执行回执（2026-11-06）：** T13 初始候选及六路径修复已由原唯一审查者完成规格／质量审查与定向复核，I1–I3 关闭，C/I/M=0/0/0。接受源码快照 `task-13-controller-fix1`；最终受影响的8项selector和管理台构建／类型检查通过，27项双页面回归发生于最后所有权收敛之前，未混称最终30项全绿。原主功能RED对后半未执行断言的证明范围有限，独审附记确认没有具体code-first新证据。真实中英浏览器／原生／工具／部署集中验收仍归T14；本次未跑全量或操作Git集成。详见阶段账本及 `task-13-rereview-1.md`（SHA-256 `346b3dc7f344ea46837f539163dd7f519e742dbdc5f82a3b3e7813b05f6581b1`）。
### T14：部署依赖、候选 CI、同源码集中联验与交付

**交付物：** 真实 URL／Git HTTPS／SSH、本地和在线、重启与页面验收可核对；源码与产物／CI 身份一致，交付限制明确。

**文件：** 修改 `Dockerfile.collaboration`、`.github/workflows/ci.yml`、`scripts/ci-stage.mjs`、`scripts/tests/ci-stage.test.mjs`；创建 `scripts/smoke-synchronization.mjs`、`scripts/tests/f7g-acceptance.test.mjs`、`apps/desktop/tests/main/sync/f7g-acceptance.test.ts`；创建 `docs/f7g-external-sync.md` 和最终带日期回执，更新路线图和部署说明。仅在确实受影响时修改本地工具镜像／打包清单。

- [x] **1. 先写部署与触发验证。** 合成 Git HTTPS 服务带认证／私有 CA；SSH 服务带独立主机钥，成功和错误钥两条路径都要走真实客户端。检查镜像 Git／SSH、工具缺失诊断、实际进程回收与 Linux 容器 init；不先跑全仓才发现依赖缺失。配置级 RED 覆盖 Windows 打包候选分支／PR 不再被 main-only 条件排除，原 main 行为保留。
- [x] **2. RED／预检。** `node --test scripts/tests/f7g-acceptance.test.mjs scripts/tests/ci-stage.test.mjs`；精确运行合成来源预检，不构建无关镜像或运行旧全量。脚本实际缺工具的失败只算预检，产品断言另外执行。
- [x] **3. 实现交付接线。** 私有运行镜像安装 Git／OpenSSH 及 CA，镜像自检工具能力。将新 wire 检查接入共享 CI 阶段。**用户已随开工批准：移除 Windows 打包仅 main 的限制，让现有 workflow 的候选分支／PR 也运行；部署仍复用共享阶段。由 T14 实施并验证。** 私有 CA／主机钥只作用于本轮隔离进程／容器，不能关闭校验或修改系统全局信任。
- [x] **4. 集中联验。** 固定一个候选，复用同一合成服务地址：本地检查／重开回滚、在线三方冲突／丢响应回执、桌面关闭后后台生成候选、后端重启／来源暂停／重复触发／撤权、新版原生与管理台中英页面，以及 HTTPS／SSH 失败原因。跑 `node scripts/smoke-synchronization.mjs` 和精确的 `tests/main/sync/f7g-acceptance.test.ts`，只打包一次已收敛候选；新缺陷先复现、定向修，必要重包只重验受影响场景。
- [x] **5. 最终审核与交付。** 唯一整阶段审核后，只做原问题定向复核；留存源码／工具／产物身份、实际退出码、安全事实、材料清理和边界。不把 DOM 结果冒称真实视觉，不把条件跳过称为覆盖，不把多候选的局部绿拼成一次全绿。本地全量仍先申请；用户未确认则如实写“未执行”。Git 集成取得当次授权后进行，远端 CI 需核所有适用任务、真实部署与同一提交，不能仅看测试 job。

> T14 进行中回执（2026-11-06）：真实来源与工具、Linux 单项生命周期、目录包与新镜像、同地址重启及回执／回滚均有定向证据。最终三项发现已由原审查者精确复核关闭，新包锚点和管理台中英文策略也已实际复验。其余原生差异／在线验收与最终保留环境退出清理仍待完成，因此第4、5项不提前勾选。启动检查器的整数／私有目录／公开RPC保护顺序缺口已获用户接受如实记录、验证与独审；不追认为先红。未运行本地全量或远端CI，未提交／合并／推送。

> T14 最终回执（2026-11-06，覆盖上段进行中状态）：本地原生检查／显式应用／跨包重开回滚、在线来源／失效／历史／调度预览及中英配置均完成。后续真实发现 I3（Electron 已知错误展示）与 I4（手动检查清掉调度及最近记录）各有有效先红、最小修正、原审查者单项复核及必要新包实测；最终 C/I/M=0/0/0。I4 最后两个小测试文件63/63、desktop build和candidate5目录包／包冒烟通过；没有拼成全仓单次通过。保留服务 keeper 实际 exit0，四个本轮容器／精确数据卷／相关PID／监听已清理，静态证据保留。当前快照task-14-controller-fix3（223个非文档路径）、candidate5产物与1440消费输入零漂移；[交付回执](../../f7g-acceptance-20261106.md)记录完整范围／限制和唯一审核文件。第4、5项据此完成。本地全量／完整本地CI／远端新CI未执行；Git提交／合并／推送仍未操作且须当次授权。

## 5. 构建、边界与检查矩阵

- Core 源码改变会影响现有私有运行身份。每次需要运行相关 Java／RPC 检查前，依次 build Core、execution、runtime，运行 `node apps/collaboration-runtime/scripts/generate-java-boundary.mjs` 后再 `--check`；源码和生成文件作为同一候选核对，不关闭身份校验。
- T1 同步 schema 使用 `generate:java-sync-schema`／`check:java-sync-schema`；原 `check:java-input-schema` 保留。新同步 wire 不扩大旧测试 Job 输入。
- 依赖构建按实际受影响路径选择 `pnpm -C packages/core build`、`pnpm -C packages/execution build`、`pnpm -C apps/collaboration-runtime build`、`pnpm -C apps/desktop build`、`pnpm -C apps/admin-web build`；相应 `typecheck` 用同样的明确包路径运行，desktop 另运行 `pnpm -C apps/desktop typecheck:vue`。构建不授权运行该包或整仓全部测试；Java 使用第 2 节函数和精确测试类集合。
- 普通局部失败先确认合法前提与实际调用，再处理同类分支；不因失败便自动运行更大测试集合。版本、状态或夹具变化时明确新旧证据归属。
- 收尾验证分四栏报告：本地定向、构建／边界、集中页面／部署、远端 CI；可选本地全量另栏列出确认记录和具体结果。未获 Git 推送授权时，远端新 CI 状态只能记“未运行”。

| 需求／承重边界 | 所属任务 | 最终证据 |
| --- | --- | --- |
| URL、Git HTTPS、Git SSH，受控位置和材料 | T1、T4、T5、T8、T14 | 真实合成源、认证／CA／主机钥正反例、工具与进程事实 |
| 稳定 ID、版本／映射、重复上游 | T1、T2、T3 | 接口及可引用子实体 golden、同源重放／改名／歧义 |
| B／L／R、保护本地资产、引用与脚本权限 | T3、T6、T7、T10 | 内容与 ID 对照、真实依赖、当前权限重验 |
| 固定候选、失效代次、取消和不确定收束 | T6、T8、T9 | 迟到请求、取消实际结束、旧候选／来源拒绝 |
| 原子应用、幂等恢复、持久回滚与保留 | T6、T10 | 故障事务、响应丢失／重启、后续编辑拒绝、受保护历史 |
| 后台只检查、关闭桌面／重启／暂停／重复触发 | T7、T9、T11、T14 | 同一触发身份、检查数／候选数、资产版本不变 |
| 可配置、有效来源、分层权限与审计 | T1、T7、T11、T13 | 合法组合、上级约束、角色／deny／NONE、无秘密审计 |
| 中英业务视图、固定导航、局部滚动与高级原文 | T3、T12、T13、T14 | DOM 行为＋集中真实页面，不以 JSON 堆叠交付 |
| CI 候选覆盖、产物身份与已知风险边界 | T14 | 适用 CI 任务、真实新镜像、精确候选与限制回执 |

## 6. 编制回执（开工前历史）

- 用户已确认以 R0 制定本计划，URL／Git HTTPS／SSH、后台只检查、服务端获取位置、宿主已安装工具均进入计划基线；本计划的具体任务、合同细化和 T14 候选 CI 调整等待集中开工确认。
- 本轮只编写设计／计划／路线文档。已核对 4 份文档、12 个本地链接、32 个既有文件入口、T1–T14 共 70 个任务步骤，文档空白／占位扫描及 `git diff --check` 通过；新建文件按计划明确标注，不能把它们尚不存在当成已开发。未运行产品测试、部署、打包或本地全量，未操作真实来源，未提交／合并／推送。
- 任务验收时的源码和命令结果填写到阶段账本，不能把计划中的代码片段或预期输出当成已通过的证据。
