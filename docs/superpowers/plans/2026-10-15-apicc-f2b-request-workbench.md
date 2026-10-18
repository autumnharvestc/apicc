# F2b-B1 顶栏导航、请求标签与自由请求实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。用户已集中批准整阶段，步骤使用复选框跟踪实际完成情况。

**目标：** 主页/项目同排且单项目可可靠切回；在当前项目内不创建模块或正式接口也能调试，多个请求签独立编辑/发送/查看，显式保存和历史恢复完整可用。

**架构：** 统一主页/项目页面选择来源，后台项目上下文与页面选择显式分离；项目内增加请求签注册表。Core 将项目级 free 来源只物化到一次性临时模块/接口/用例快照，复用既有 Runner 和输出投影；历史 v2 承载新来源、兼容读取 v1。

**技术栈：** TypeScript、Zod、Vue/Pinia、Electron IPC、现有 CollectionRunner/Vitest。

**规格：** [F2b 设计](../specs/2026-10-15-apicc-f2b-debug-workbench-design.md) §1–4、§7–8。用户已集中批准，先执行任务0，不把批准当作测试或审核通过。

## 全局约束

- 基线 `6abda9c5d0a82b868cd0e557ea84098decc0f4c8`；正式源与临时执行来源不混用。
- 主智能体不写产品代码；Luna xhigh 开发、独立 Sol xhigh 审核，一个产品写入者。
- 复用既有独立工作树；批准后新建 `codex/f2b-debug-workbench`，不在 main 开发。
- 不改既有脚本行为，不恢复 DEF-001，不新增依赖、旧模型迁移或任意脚本 API。
- 草稿只在内存；改 root/切签/关签的异步回复须核对原身份和 generation。
- 自由请求从已选项目工作区创建，无项目选择器、模块前置或主页发送；无模块项目也可发送。
- 主页为统一顶栏固定首签，不关闭项目上下文；后台上下文不等于页面选择，不用清空/重载项目来修导航。
- 最小 RED/GREEN；不得删测试/断言、增大 timeout，Core/CLI worker 上限保持 2。
- 每任务候选停写后定向审核；阶段末统一集成，不自动 commit/merge/push。

## 文件与职责

| 动作 | 文件 | 职责 |
| --- | --- | --- |
| 修改 | `packages/core/src/debug/{model,service,projection,replay,history}.ts` | free 来源、执行计划、脱敏结果、v1/v2 历史读取与重放 |
| 修改 | `packages/core/src/{index,shared,schema}.ts` | Node/浏览器导出保持边界，不把 fs 引入 renderer |
| 修改 | `apps/desktop/src/main/{debugController,debugHistory,session,ipc}.ts` | 验证上下文、owner/job、单事务新建接口和历史入口 |
| 修改 | `apps/desktop/src/shared/{types,channels,ipc-contract}.ts`、`src/preload/preload.ts` | 结构化 IPC 类型和桥接 |
| 新建 | `apps/desktop/src/renderer/src/stores/requestTabs.ts` | 签身份、顺序、激活、关闭与逐签视图态 |
| 修改 | `apps/desktop/src/renderer/src/stores/{editor,debug,tabs}.ts` | 逐签调试态及项目关闭驱逐，不另存第二份正式资产 |
| 修改 | `apps/desktop/src/renderer/src/components/{TopBar,ProjectTabs}.vue` | 同排主页/项目签及紧凑工具区，不保留割裂的第二组导航 |
| 新建 | `apps/desktop/src/renderer/src/components/RequestTabs.vue` | 编辑区请求签和新建/关闭交互 |
| 修改 | `apps/desktop/src/renderer/src/{App.vue,components/RequestEditor.vue,components/DebugHistory.vue,components/DebugSettings.vue,api/memory.ts}` | 真实装配、free 保存/历史、memory API 同契约 |
| 修改 | `apps/desktop/src/renderer/src/i18n/{zh-CN,en}.json` | 全部新增可见文案 |
| 复用/扩展 | Core `tests/debug/{service,history}.test.ts`；Desktop `tests/main/{debug,contract-assets}.test.ts`、`tests/renderer/stores/{debug,editor,tabs}.test.ts` | 现有 fixture 中加入最少回归，不重建测试框架 |
| 复用/扩展 | `apps/desktop/tests/renderer/App.test.ts`、`tests/renderer/components/{projectTabs,topBar}.test.ts` | 唯一项目返回、同排固定主页、已有在线/关闭入口及真实装配 |
| 新建 | `apps/desktop/tests/renderer/stores/requestTabs.test.ts` | 签状态机的小型独立测试 |

文件表是允许触及的职责范围；若源码已有更合适的小模块，可等价拆分并在报告记录映射，不扩大需求。

## 任务 0：主页/项目统一导航与紧凑顶栏（先做）

**交付物：** 唯一项目从主页一次点签切回，主页与项目在同一排，布局和页面选择一致。

已知静态机制：`App.vue` 的主页动作只写 `view='home'`；tabs store 的同项目 `activateTab` 提前返回；组合根仅在 activeTab 变化时从主页切回。主页卡片另行写 view，因此“卡片能回、同签不能回”与用户观察一致。尚未执行最小行为复现，不将静态链误写成修复验证。任务必须先保留旧行为RED。

- [x] **1. 在现有 App.test.ts 补唯一项目回归RED。** 复用 `mountApp` 及打开本地项目 helper；只开一个项目，保存其tabId和dirty请求值，点旧 `topbar-home`，再点该唯一项目签，断言主页消失、同一项目内容出现、tabId/签数/草稿未变，spy工作区open不增加。不用点击主页项目卡片代替最后一步。

```ts
// 沿App现有fixture打开唯一项目后，先在旧选择器复现。
await wrapper.get('[data-testid="topbar-home"]').trigger('click');
expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
await wrapper.get('[data-testid="project-tab-0"]').trigger('click');
await flushPromises();
expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(false);
```

统一标签之后主页选择器语义仍可保留 `topbar-home`；它必须位于同一tablist且role=tab，不因改DOM而删回归断言。现有two-project/online/草稿确认fixture中追加少量断言，不另起重复App测试设施。
- [x] **2. 取得行为RED后实现唯一导航模型。** tabs store新增 `selectedPage` 联合与 retained `contextTabId`；`activateHome()`改变页面和epoch、不驱逐；`activateTab`成功后选择project，即使context已经是该项目；旧activeTabId/activeTab导航读口改派生，不留独立可写home状态。

```ts
type SelectedPage = { kind: 'home' } | { kind: 'project'; tabId: string };
// selectedPage: 唯一可写的页面选择；contextTabId: 后台上下文身份，不能用于标签高亮。
// activateHome(): void；activateTab(tabId): Promise<void>。
// 项目栏目和请求签状态按原项目驻留，App的可见view由selectedPage及该项目栏目派生。
```

`A→主页→B` 的工作流草稿确认从retained context取A，取消保持主页及A草稿；`A→主页→A`直接恢复。复用activationEpoch使旧激活不能抢回主页；离线失败不提前改page/highlight。关闭后台签不离开主页，关闭末签显示主页。继续原持久化tabs/activeIndex，null表示主页，不把home造为项目条目。
- [x] **3. 合并顶栏实际DOM并优化布局。** TopBar承载统一ProjectTabs：固定home首签＋可滚动项目签共用tablist，移除独立主页按钮组和第二行独立项目导航。工具区单行紧凑，工作区状态长名省略；语言/主题、连接和工作区动作保留在可达菜单，项目下拉转为打开/查找入口而非第二套高亮。样式限定scope；不改原生菜单/窗口按钮。窄窗口更多菜单＋项目区滚动，home不滚出、工具不遮挡、整体不横向溢出。
- [x] **4. 最小GREEN与防回归。** 原App目标加：在主页关闭后台签仍home、工作流确认从home不绕过、迟到激活不抢page；component用例断言零项目也有home、无关闭按钮、唯一aria-selected及原关闭按钮事件隔离。保留原online连接/工作区进入和退出检查，按新统一页面模型更新接线而非删测试。启动activeIndex=null停主页，有效项目恢复仍能进项目。
- [ ] **5. 定向审核及视觉检查记录。** Desktop renderer类型门，真实renderer/包中检查中英文/明暗、长名/多签/窄窗口、进入工作流的顶栏位置；不能只靠jsdom宽度为0宣布布局通过。B-16–18与B-06逐项记实证，完成后继续任务1，不重复询问开工。

执行记录：任务0工程实现与类型门、独立审核已完成；首候选85/85，修复后App/store73/73，I1/I2经Sol定向复审闭合。真实视觉及新包明确合并到G，不勾选本步骤或据此宣称B-18通过；原jsdom告警Minor仍留账。详细证据见本计划SDD账本与task-0报告/复审。

## 任务 1：free 执行身份及历史 v2

**交付物：** 当前项目即使没有模块也能发送 free 请求，不改正式资产；其结果和历史具有项目级真实来源、可恢复。

- [x] **1. 先扩展现有 service.test.ts 的最小 RED。** 使用已存在 `createContractExecutionProject`/`contractExecutionIds`，将源项目collections置空；保留项目/环境、构造完整地址request，断言计划成立且源快照未改变。新增调用/计划约定为：

```ts
type FreeInvocation = {
  mode: "free";
  project: { workspaceId: string; groupId: string; projectId: string };
  draftId: string;
  request: ApiRequest;
  parameters: Record<string, string>;
  fields: DebugFieldState[];
  environmentId?: string;
  settings?: RequestSettingsOverride;
  parentHistoryId?: string;
};
// 新的计划保留 mode/source 区分；asset 计划维持 sourceApiRevision，free 计划用 draftRevision。
```

测试核心使用同一 `prepareDebugExecution(snapshot, invocation)`：

```ts
const before = JSON.stringify(snapshot);
const plan = prepareDebugExecution(snapshot, invocation);
expect(plan.invocation.mode).toBe("free");
expect(JSON.stringify(snapshot)).toBe(before);
expect("sourceApiRevision" in plan).toBe(false);
expect(plan.snapshot.project.collections[0]!.apis.length).toBe(1);
```

源fixture无任何模块，计划快照只有内部临时模块，最后一条断言检查它的唯一临时API。另沿既有项目fixture给真实模块配置独有header/操作，证明free不会借该模块、不会使用模块baseUrls映射；项目/环境变量和全局参数仍生效。运行现有真实本地HTTP服务观察到达内容，不能只测parse。

- [x] **2. 从 package cwd 跑该最小目标，确认行为 RED；记录退出码。** 先更新必要类型使测试能加载；加载/编译失败单独记，不当行为 RED。
- [x] **3. 实现最小调用联合、来源联合及计划分派。** Controller 对free验证原请求签的project/环境、同步捕获owner/root，启动早于凭据/文件/网络；临时模块/API UUID由宿主生成，模块变量和操作为空，只进执行副本。结果/异常/取消/重放分支都消费新来源，不返回临时locator。凭据选择来自最终请求。完整URL编辑按契约拆分baseUrl/path/query，保留重复参数和编码，不隐式选模块。UI只有激活本地项目后可新建，不增加主页发送/项目选择器。
- [x] **4. 扩展 history.test.ts 的既有临时根 fixture。** 写free v2、读v1并比较原文件字节、恢复成free、项目不可用/当前项目不匹配拒绝执行、项目/当前接口筛选、脱敏needsInput；删改真实模块不影响free归属；v1 sidecar能读或按缓存规则重建。使用sourceKind/project/draftId严格联合，不把所有身份字段全部optional来求兼容。
- [x] **5. GREEN＋定向审核。** 跑 Core `tests/debug/service.test.ts tests/debug/history.test.ts` 和 Desktop `tests/main/debug.test.ts`，接好共享 Schema/IPC/memory API 的必要分支；实际控制器无保存调用/正式文件不变。报告 AC B-03/B-05 覆盖及尚无 UI 证据，冻结候选供独立审核。

执行记录：Task1内核/历史/宿主工程和独立审核闭合，正式case重放回归经修复轮1/5及Sol复审解决。Core首候选30/30，修复后history16/16，必要类型/构建通过；完整原始证据与限制见SDD。步骤3包含跨任务UI要求，内核/宿主部分已完成，完整URL编辑、激活项目后的新建入口明确由Task2落实后再勾选，不将当前Task1工程完成冒称UI或WS/SOAP验收通过。M1迟到恢复移交Task2，M2测试告警保留至G。

## 任务 2：逐请求签状态与关闭生命周期

**交付物：** 同项目多个请求签独立编辑、并发发送和看结果，关签/退出可预期。

- [x] **1. 在新 requestTabs.test.ts 做一个表驱动状态 RED。** 以现有ApiLocator/ProjectLocator为数据，不发IPC；最小端口如下，state保存签注册表、activeId，editor/debug中的数据仍只有各自单一所有者：

```ts
type RequestTabSource = { kind: "asset"; locator: ApiLocator }
  | { kind: "free"; project: ProjectLocator; draftId: string };
// open(source) -> tabId；activate(tabId)；close(tabId) -> Promise<boolean>。
// close 注入 confirmClose 与 cancelRun；只在确认成功后驱逐。
```

断言同正式接口重复打开不增签、两 free 不合并、切签保留设置/面板/滚动；dirty＋在途只调用一次 confirm，拒绝时 cancel/evict 都不调用。对两个 deferred debugWait 复用既有 debug.test.ts stub，先切签再逆序完成，结果各归原签。
- [x] **2. 跑 `tests/renderer/stores/requestTabs.test.ts` 与原 debug store 最相关目标取得 RED。** 保留已有 restore/保存迟到响应测试，不复制全部组合。
- [x] **3. 实现签 store、逐签调试状态、RequestTabs.vue 和 App 装配。** 在原editor会话上增加free分支，不复制正式ApiAsset到新签store；project由当前已选项目捕获，无需选择模块/项目。request/protocol/settings/环境/用例/恢复字段随签，runId保持原sender所有权；同签禁重复启动，别签可运行。接口/自由面板复用RequestEditor请求部分，设计响应只对正式接口显示；回主页隐藏项目操作但不清草稿/结果。
- [x] **4. 接通关闭与退出。** 关项目检查所有请求签，一次确认后逐签取消/驱逐；关程序复用既有退出确认管线。切在线项目不改变本地签驻留；在线既有编辑入口不新接本地 free 发包。所有普通异步回调核对 root＋tab/generation。
- [ ] **5. GREEN＋定向审核。** Store 目标、现有 RequestEditor/相关 App 集成目标、renderer 类型门；人工点两正式＋两 free，检查固定顶栏和窄窗口。截图/手工未运行则明确缺口，不以 jsdom 保证布局。

执行记录（2026-10-16）：Task2工程/独立审核完成，七项Important经原Luna修复及Sol增量复审全部ADDRESSED、新增C/I/M=0。真实行为RED与四文件157/157、最终debug16/16、editor15/15、必要类型门有原始证据；设置/面板/scroll数值往返亦已覆盖。初始registry RED只缺factory入口，不能冒称完整状态机行为失败。步骤5含实际窗口，故不勾选整步：两正式＋两free、顶栏/窄窗仍G。已知测试噪声与单请求关闭文案Minor保留。继续Task3，无Git集成。

## 任务 3：自由请求单事务保存及历史 UI

2026-10-16 工程与独立复审完成：I1–I3 全部闭合，无剩余 Critical/Important。新入口只读路径已核对共同事务守卫，不冒称新增只读 UI 故障流程已执行。实际窗口、原生包及前文任务0/2的手工视觉检查仍留G；本任务通过不等于整阶段验收。新增有效 free URL 同时显示两套控件的 Minor 已登记G，不延长本轮修复。

**交付物：** free 结果能显式转为正式接口，不产生空资产；历史恢复进入正确签。

- [x] **1. 在现有 main contract-assets.test.ts 增加原子保存 RED。** 新 Session 入口约定：

```ts
// 输入 project/targetParent/name/request/sourceProjectRevision/fields；targetParent必须属于原project。
// createApiFromRequestDraft(input) -> { locator: ApiLocator; detail: ApiDetail }。
// 从候选工作区创建完整 ApiAsset，一次 mutate/persist；不先调用 createApi 再 saveApi。
```

注入一次已有 storage 保存失败，再核对树、磁盘和会话没有新增接口，原 free 草稿仍存在；成功后打开新正式签且 request 原样保存。沿已有 fixture 验证 stale revision/只读不写入；覆盖同名不覆盖身份。M2 沿原设置不兼容测试加完整 CaseLocator 断言。
- [x] **2. 跑该 main 最小目标取得 RED，再实现 Session/IPC/preload/memory 契约和 UI 保存入口。** 已知凭据字面值拒绝及 fields.needsInput 检查沿 F2a，free 不绕过。目标限同项目，避免跨项目资产闭包成为隐含新需求。
- [x] **3. 扩展现有 DebugHistory 组件测试。** free记录显示来源、项目筛选、所属当前项目恢复新签、项目丢失只读、其他项目记录只查看并提示先切项目；v1 asset恢复仍定位原接口。保存时才选当前项目内目标模块；无模块时显式建模块后再保存，不阻断free发送。成功转正式签后说明继承将按目标模块生效，再开放保存用例；不能悄悄跨项目或覆盖别的API。
- [x] **4. 定向 GREEN 与类型/构建。** Core build → Core typecheck → Desktop typecheck/typecheck:vue/build，必要 CLI build 检出 DebugInvocation/Result 的穷尽分支。只运行受改变的 CLI 历史目标，不提前全 CLI suite。
- [x] **5. 独立审核 B1 并记录矩阵。** B-01–06、B-11的M2、B-16–18；发现普通缺陷同范围修复，只有设计变动/新授权才找用户。此处不提交、不打正式阶段包，继续B2。

## 验证命令和交接

所有测试从对应 package cwd 运行，不在仓库根执行 Vitest 以免扫描旧 SDD 快照。PowerShell 基本命令如下；每次运行前记录精确目标、stdout/stderr、native exit，路径中的工作树以本计划批准后的实际位置为准：

```powershell
$f2bRoot = 'C:/Users/imini/.codex/worktrees/contract-assets/apicc'
$f2bNode = Join-Path $f2bRoot 'local/toolchains/node-v22.19.0-win-x64/node.exe'
$env:PATH = (Split-Path -Parent $f2bNode) + [IO.Path]::PathSeparator + $env:PATH
Push-Location (Join-Path $f2bRoot 'packages/core')
& $f2bNode node_modules/vitest/vitest.mjs run tests/debug/service.test.ts tests/debug/history.test.ts
$f2bExit = $LASTEXITCODE
Pop-Location
if ($f2bExit -ne 0) { throw "B1 Core target failed: $f2bExit" }
```

Desktop 同形式、cwd `apps/desktop`，显式传表内目标。包编译用 `pnpm -C packages/core build`、`pnpm -C packages/core typecheck`、`pnpm -C apps/desktop build`；先记录 `pnpm --version` 为 11.21.0，不安装/升级工具求匹配。

最终输出：改动文件、AC→具体测试/人工证据、未验证项、候选版本、独立审核结论；随后执行 [B2 网络配置计划](2026-10-15-apicc-f2b-network-profiles.md)。
