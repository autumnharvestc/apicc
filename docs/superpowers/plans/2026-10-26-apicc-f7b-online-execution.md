# F7b 在线项目与执行代理整阶段实施计划

> 开工批准：2026-10-26，用户要求“可以，完成F7b阶段”。按R1及已列默认细则实施；下文保留的“未开工/待集中确认”等文字为此前准备记录，不构成再次询问的要求。开发与必要验证已获授权，提交/合并/推送仍未授权。实际进度以本阶段SDD账本及证据为准，不以计划文字认定已完成。

> **面向AI代理的工作者：** 使用subagent-driven-development逐任务实施；复选框记录真实进度。执行者必须同时阅读规格与本计划。开发沿用独立GPT-6.1 Sol high，独立审核GPT-6.1 Sol xhigh；升级Sol max须另向用户申请。

**目标：** 在线项目无需拉成另一份本地工作区，即可选择本机或指定代理完成单接口调试、测试计划/套件和工作流；支持现有Core受信同步前置/后置测试脚本，代理采用“无脚本单请求调试复用常驻子进程，其余任务独占子进程”的混合策略，具备可配置运行参数、可读结果和可部署代理。

**架构：** Java复用现有H2/JdbcTemplate承担控制、资产和结果存取；独立Node代理主动HTTPS长轮询。新增 `@apicc/execution` 作为跨宿主准备/协议边界，本机与代理、代理两类执行进程均调用既有Core，不在Java或代理重写Runner。代理主进程只控制和监督，不内联执行任务。

**技术栈：** 现有TypeScript/Vue/Pinia/Vitest、Node 22.19.0、pnpm 11.21.0、Spring Boot/JDK 21/H2/JdbcTemplate、Docker；不升级现有依赖版本，不引入Redis/MQ/WebSocket控制适配。

**规格：** [完整架构](../specs/2026-10-26-apicc-f7b-online-execution-design.md)、[配置与协议](../specs/2026-10-26-apicc-f7b-execution-contract.md)、[已确认裁定](../specs/2026-10-26-apicc-f7b-decisions.md)、[混合策略修订记录](../specs/2026-10-26-apicc-f7b-hybrid-decision.md)、[页面规范](../../ui-presentation-guidelines.md)。

**状态：** R1实施与集中验收于2026-10-27收尾；T1–T11及唯一宽审/一次修复定向复审完成，保留第8节明确的三项Minor，不等于零缺陷或已发布。未提交/合并/推送，工作树及全部历史证据保留。

## 全局约束

- 首版范围A：单接口、测试计划/套件、工作流，包含现有Core已支持的受信同步测试脚本；不含代理压测、定时任务、长连接实现、自动安装插件或跨代理分布式压测。
- 混合策略只用于代理进程装配：真正无脚本的单请求调试复用一个独立常驻子进程；带脚本调试、套件和工作流使用完整任务独占子进程，不按节点/请求拆进程。两条路径共享代理总任务槽，具体语义见第3.1节。
- 运行参数必须可配置，初值与额度按配套清单；默认并发1但支持配置多任务，不限死为串行。
- Web只管代理基础设施、授权和管理策略；接口认证、环境、数据及测试配置在客户端对应项目操作。
- 项目凭据后端加密保存，个人临时项可仅本机；无需主动解锁，不静默上传现有凭据或缺失时无认证发送。
- 环境和执行位置独立；代理不可用不自动改本机或另一个代理；重连不重跑任务。
- 使用真实服务端实体ID鉴权，Core内部UUID单独映射；单次快照及运行输入固定，保存冲突不可覆盖其他修改。
- 不恢复DEF-001。只复用既有Core/node:vm测试脚本语义，不把它宣称为安全沙箱或延期运行时替代；不引入任意宿主API、npm加载、WASM/QuickJS修复、固定脚本/VU池或密钥句柄桥接，不以吞脚本的假引擎通过准入。
- 新主视图为摘要、表格、列表和轨迹；中文/English、时间/单位、不可用原因直接可读；原始数据默认折叠。
- 测试只覆盖受影响行为，复用既有夹具；不增加全页面、全协议、全故障组合矩阵，不做24小时占机实验。
- 不删除现有测试、不只加超时、不篡改历史RED/GREEN；模块不存在、环境未启动、夹具错误不能登记为有效功能RED。
- 没有用户新的Git授权时不自动commit/merge/push；任务通过后使用局部差异和证据检查点代替擅自提交。

## 1. 当前基线与可用环境

准备期基线为 `1a585a8e17deba4979d4dacd35e4fde4c5a08f26`，当时tracked工作区干净、用户确认此前CI通过。实际执行复用worktree `C:/Users/imini/.codex/worktrees/contract-assets/apicc` 的 `codex/f7b-online-execution` 分支，所有本阶段源码保持未提交；未创建其他checkout、未清理其他worktree/stash。此前CI不作为本阶段实际CI证据。

2026-10-25实际读取版本：系统默认Node v24.21.0/pnpm12.8.1，不用它们代表CI环境；已有专用Node v22.19.0/pnpm11.21.0可用。JDK21.0.12可用，JAVA_HOME使用 `C:/Program Files/Java/jdk-21.0.12`，Docker daemon29.8.0当时可访问。本次不将历史状态冒称10月26日重新验证；开工再确认所需工具。此前仅调用版本/状态命令，未启动容器、拉镜像、安装依赖或运行全量测试。

固定工具路径：

```powershell
$taskNode = 'C:/Users/imini/.codex/worktrees/contract-assets/apicc/local/toolchains/node-v22.19.0-win-x64/node.exe'
$taskPnpm = 'C:/Users/imini/AppData/Local/node/corepack/v1/pnpm/11.21.0/bin/pnpm.cjs'
& $taskNode $taskPnpm --version
```

正式执行由子进程环境注入该Node目录及对应pnpm shim、JAVA_HOME；不更改用户全局版本。工具路径仅为当前机器定位，不写入产品代码/CI。初始化只在独立worktree安装新增workspace链接并受控更新lockfile，不借主工作区源码伪装冻结候选。

### 已确认的实现缺口

1. `OnlineApiEditor.vue`明确不提供运行，配置叶只读；本机在线执行同样是新增能力。
2. 在线 `ApiAssetSchema`整份 `api.yaml` 与Core拆分契约存储不同；旧迁移路径还按组名/项目名恢复，不能直接用于新快照。
3. 无脚本Collection/Suite仍强制要求脚本引擎，v1条件字符串也依赖引擎；必须拆出真实无脚本registry与受信Core脚本registry，不在共享调试进程中自动补引擎。
4. 现有 `AuthFilter`只认识用户，不能拿用户令牌当代理身份；新主体/路由必须明确分离。
5. 新包会影响干净构建、浏览器依赖闭包和Docker管理台构建，必须纳入本阶段交付，不留到CI报错再补。
6. 现有JS引擎是同步 `run(...): void`，固定3000ms，仅提供已有pm API，不能按完整第三方平台/异步脚本平台宣传。当前caseExecutor在用例前置脚本之前已物化请求，须核实并修正“前置变量用于本次模板”和直接修改 `pm.request` 的共同语义，修改必须回到共用Core。

## 2. 文件结构及责任

以下均相对仓库根；列为“新增”的路径是计划交付物，不声称当前存在。

| 交付单元 | 创建/修改文件 | 职责 |
| --- | --- | --- |
| 公共协议与配置 | 新增 `packages/execution/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`、`src/contract/{index.ts,task.ts,config.ts,messages.ts}`、`src/client/{index.ts,http.ts}` | 浏览器安全DTO/Schema、纯配置计算、HTTPS数据客户端；不载入Core Node宿主 |
| 共用执行宿主 | 新增 `packages/execution/src/host/{index.ts,prepare.ts,invoke.ts,capabilities.ts,registry.ts,credentials.ts,output.ts}`、`src/buildIdentity.ts`、`scripts/build-identity.mjs` | 固定快照/数据/材料、选择三类Core入口、可用能力及输出投影；不实现代理队列 |
| Core执行档位与配置/编解码接缝 | 修改 `packages/core/src/{index.ts,storage/contractFiles.ts,runner/runner.ts,runner/caseExecutor.ts,testing/suiteRunner.ts,workflow/runner.ts,workflow/v2Runner.ts,report/evidence.ts,sandbox/jsEngine.ts}`；新增 `runner/scriptRequirements.ts`、`plugin/executionRegistry.ts` | 同一Core内置无脚本/受信脚本registry；脚本时限工厂与前置变量语义；无脚本不要求引擎；请求设置/证据预算贯穿实际执行 |
| 代理登记/分配/配置 | 新增Java `execution/agent/{AgentController,AgentService,AgentRepo,AgentAuthFilter,AgentPrincipal}.java`、`execution/config/{ExecutionProperties,ExecutionConfigService}.java`、`execution/policy/{ScriptGrantController,ScriptGrantService,ScriptGrantRepo}.java` | 代理主体、三级管理/作用域、配置校验版本、远程受信脚本版本准入；复用现有权限服务，不实现延期运行时授权机制 |
| 资产/快照与材料 | 新增Java `execution/assets/{ProjectAssetsController,ProjectAssetsService,ExecutionSnapshotService,ExecutionSnapshotRepo}.java`、`execution/materials/{ExecutionMaterialsController,ProjectCredentialStore,ProjectCredentialService,AttachmentService}.java` | 原子资产变更、一致快照、加密凭据/文件存取；无Core业务解析副本 |
| 持久任务与控制 | 新增Java `execution/jobs/{JobController,JobService,JobRepo,RunnerController,RunnerControlService,RunnerPollWaiters}.java` | 队列/接单/开始确认、长轮询唤醒、状态/取消、结果存储与对账 |
| Java共用改动 | 修改 `auth/AuthFilter.java`、`store/FileVersionRepo.java`、`resources/{schema.sql,application.yml}`；新增 `execution/ExecutionDtos.java` | 认证分派、完整文件读取、新增表和配置、明确DTO；不改变旧内容batch语义 |
| 独立代理 | 新增 `apps/runner-agent/{package.json,tsconfig.json,vitest.config.ts}`、`src/{main.ts,bootstrap.ts,supervisor.ts,dispatch.ts,debugWorker.ts,debugSessions.ts,invocationContext.ts,taskChild.ts,slots.ts,ledger.ts,outbox.ts}`、`src/transport/{control.ts,longPolling.ts}`、`src/config.ts` | 同一全局准入器；常驻调试worker与独占任务子进程；显式会话、调用上下文、generation与退出监督；不重写Core |
| 桌面主进程与IPC | 新增 `apps/desktop/src/main/online/{projectAssets.ts,execution.ts,projectCredentials.ts}`、`src/shared/online/execution.ts`；修改 `online/{client.ts,session.ts}`、`main/{ipc.ts,main.ts}`、`shared/{channels.ts,ipc-contract.ts,types.ts}`、`preload/preload.ts` | 在线项目资产及本机/代理运行，不替换现有本地Session；令牌/凭据留main |
| 桌面项目页面 | 新增renderer `stores/onlineExecution.ts`、`components/online/{OnlineExecutionPanel.vue,OnlineProjectAssets.vue}`；修改 `stores/online.ts`、`components/OnlineApiEditor.vue`、`api/{index.ts,memory.ts,global.d.ts}`、`i18n/{zh-CN.json,en.json}` | 复用现有业务控件，项目内编辑必需环境/认证/数据/套件/工作流、位置选择、任务/结果；不建设第二套本地工作台 |
| 管理页面 | 新增admin `api/agents.ts`、`stores/agents.ts`、`views/{AgentsView.vue,ProjectAgentsView.vue}`；修改 `router/index.ts`、`main.ts`、`views/{LayoutView.vue,OrgView.vue}`、`i18n/{zh-CN.json,en.json}`、`package.json` | 全局节点、工作区池与项目分配/策略；不在Web填写被测接口密码 |
| 部署和门禁 | 新增 `Dockerfile.agent`、`deploy/runner-agent/{compose.yml,agent.env.example,README.md}`、`scripts/smoke-runner-agent.mjs`、`docs/runner-agent.md`；修改根 `Dockerfile`、`scripts/test-all.ps1`、`.github/workflows/ci.yml`、各消费者package及 `pnpm-lock.yaml` | 自托管部署、包身份、干净拓扑构建与必要门禁接线 |

Java文件目录前缀为 `server/src/main/java/com/autumnharvestc/server/`；测试对应 `server/src/test/java/com/autumnharvestc/server/execution/`。聚合DTO若变大按agent/jobs/materials责任拆分，不改动无关旧模块。

## 3. 接口、状态和配置冻结

完整路径、身份及参数表以[配置与协议清单](../specs/2026-10-26-apicc-f7b-execution-contract.md)为准。协议版本1，任务身份/提交意图/消息去重不绑定HTTP；控制通路与输入/报告通路分离。没有空槽仍收取消/配置命令。

Core调用边界在 `packages/execution/src/host/invoke.ts`，入参必须已经通过对应Schema/准入，宿主准备材料不能留给Core临时向后端获取：

```ts
type PreparedInvocation =
  | { kind: 'debug'; plan: import('@apicc/core').DebugExecutionPlan;
      run: import('@apicc/core').ProjectExecutionRun }
  | { kind: 'suite'; plan: import('@apicc/core').ResolvedSuitePlan;
      run: import('@apicc/core').ProjectExecutionRun }
  | { kind: 'workflow'; workflowId: string;
      run: import('@apicc/core').ProjectExecutionRun };
// prepare.ts产生上述判别联合；invoke.ts分别调用已有
// runDebugExecution / SuiteRunner.run / WorkflowRunner.run。
// registry、signal、workspaceRoot、evidence预算由宿主注入，结果由output.ts投影。
```

具体依赖注入签名在T1/T2作为可编译契约冻结；不复制断言、请求重试、工作流调度或报告逻辑。首次代码接线前用类型检查验证现有公开类型导出，不能依靠本文示意中的类型强转绕过。

### 3.1 混合进程策略与脚本边界（R1）

| 任务及实际依赖 | 代理执行位置 | 生命周期 |
| --- | --- | --- |
| 真正无脚本、仅内置能力的单请求调试 | 一个按需创建的常驻调试子进程；允许有界并发，不强制串行 | 空闲到配置期限且无在途调用才退出；下次调试再创建 |
| 带前置/后置脚本的调试，或调试依赖JS条件/脚本 | 完整任务独占子进程 | 任务结束、输出投影完成并确认退出后回收 |
| 测试计划/套件、工作流，无论是否含脚本 | 完整任务独占子进程 | 所有用例、循环、子流程、onError/finally在同一任务进程内，不按HTTP请求/节点再开进程 |

- **统一计数：** 设全局任务额度N、常驻worker在途调试数I、独占任务数K，必须 `I + K ≤ N`；I还受 `agent.sharedDebugMaxInFlight` 限制。默认N=1，可配置大于1；排队项不创建任务进程。一个代理的执行子进程上界是K加0或1个常驻worker，而非每个节点一个进程。准备/启动预留也占准入额度，不能以尚未running绕过上限；执行槽和进程资源账分别维护。
- **退出不提前释放：** 独占进程退出未确认、常驻调用未确认收束时仍保留相关准入/资源预留。独占任务结果可先记录，不能仅因Core返回就假定进程已死；常驻健康worker不必随一次调用退出，但调用上下文必须确认释放。报告待传不占执行槽，但仍占结果缓存预算。
- **按实际依赖分类：** 由同一Core检查已固定快照中所选请求/用例、模块/祖先目录前后置、子流程及错误/清理分支，不信客户端“无脚本”标记。外部可执行插件不进入共享worker；代理首版不自动加载。准备与启动时核对依赖摘要、材料/授权及能力；快照发生变化则重新准备或拒绝，不静默删脚本、降级或自动换执行位置。
- **状态范围：** 每次调用有自己的executionId、只读快照、变量/提取状态、凭据绑定及脱敏标记、证据预算、超时和AbortController。Cookie按明确的服务器/工作区/项目/所有者/调试会话范围管理，保留同一会话有意延续Cookie的行为，不使用进程全局CookieJar；并发请求按现有HttpSession语义处理，不虚构彼此确定的Cookie先后顺序。任务结束释放临时材料和上下文，授权会话按其显式生命周期保留。
- **会话不绑进程寿命：** `debugSessions.ts`在代理宿主内存中按上述scope持有Core已有HttpSession，只通过限定的会话IPC提供既有Cookie读写/元数据/清理操作，不执行请求或脚本；共享和独占调试都取得本次有权使用的会话句柄，不复制Cookie算法。worker空闲回收不清空调试会话，普通取消不关闭会话。会话自身有可配置空闲期限/数量上限，活跃引用不回收；代理服务重启后不恢复Cookie值，旧会话引用必须在目标请求前提示失效，不偷偷换空会话继续发送。套件/工作流仍用任务自己的会话，不默认继承人工调试登录态。
- **故障范围：** 普通取消仅Abort本调用，不销毁其他调用的会话或共享连接。若共享worker失联、卡死或无法在宽限内收束，必须终止整代worker，对其所有在途任务保留部分事实并分别标记中断/超时或状态待确认；不能假报其他任务成功/已取消。确认旧代退出后才能重建供新任务使用，不自动重发业务请求。IPC核对worker generation、executionId及scope；迟到消息不能串入下一次运行。
- **受信脚本：** 复用同一Core既有同步JS与pm API；代理节点策略允许且项目脚本版本获准才可运行。优先单脚本/单版本批准，修改失效；可显式选择信任整个项目，醒目提示该选择会覆盖未来修改。具体授予与撤销见配套清单，编辑权本身不等于远程脚本执行许可。
- **不是强安全隔离：** node:vm和同OS账号的子进程都不能作为恶意脚本安全边界；脚本可能读取已授权请求/响应中的认证值，脱敏不能阻止主动外发。同一代理只服务受信内部测试域，不作为开放多租户代码平台；不同互不信任域分代理/OS账户或容器部署。控制凭证/主密钥不作为任务材料下发，不以同账号进程隔离声称它们不可被恶意代码取得。
- **同步范围：** 不新增require/process/fs/npm/任意网络API，不补完整第三方平台 API或异步脚本生命周期。不能用关键词扫描证明脚本同步安全；现有引擎不await Promise，相关用法明确不受支持，父进程期限/监督负责兜底，不因此保证异步副作用可回滚。脚本错误如实失败，后置脚本失败仍保留已发送请求事实。
- **一致性承诺：** 两条代理路径与在线本机执行复用同一Core、脚本引擎及pm API。冻结Core构建、脚本/环境/数据/材料版本和有效配置；记录实际Node/V8与兼容档位，未知档位在请求前拒绝。以同一受控目标证明语义一致，不承诺不同网络、DNS、目标状态、时间或随机数下结果逐字相同；排队/启动/上传耗时与目标请求耗时分开。

本节不是通用脚本池、WASM运行时替换或原延期安全验收；首版只有一个无脚本常驻worker和按任务创建的独占子进程。代理压测仍留F7c，不按压测请求开进程。

## 4. 实施任务与依赖

顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11。T4登记/配置可在T2/T3期间独立设计，但本阶段默认一个开发任务连续推进，避免并行改共享入口。任务完成有检查点，不逐task再向用户申请。

每个新增行为统一按“确定有效输入/夹具 → 可加载的测试边界 → 业务断言RED → 最小实现 → 原测试GREEN/必要类型检查 → 定向审核和检查点”执行。接口声明、类型或模块壳可以作为测试脚手架，但不先接业务逻辑；若RED原因只是新字段/模块不存在，先纠正脚手架，再取得有效行为RED，不能带着它继续实现或之后补称TDD。

### Task 1 公共契约、配置及构建身份

**文件：** 本计划第2节execution包的contract/client配置与 `buildIdentity.ts`/构建脚本；测试新增 `packages/execution/tests/{contract.test.ts,config.test.ts}`；更新该包lockfile importer。

- [x] 固定配套清单中的字段、单位、默认值、继承/最大值交集、配置版本/应用状态，Task/Message Schema直接引用已有业务Schema。新增包脚手架只能建立可导入边界，不先实现业务再补测试。
- [x] 增加 `ExecutionProfile = 'no-script' | 'trusted-core-script'`、`DispatchKind = 'shared-debug' | 'dedicated-task'`，固定所选依赖摘要 `scriptPlanDigest`、`ScriptRequirement`清单、批准版本 `scriptGrantVersion`、所需能力及 `runtimeCompatibilityId`；会话句柄和后端填充的提交者身份一并校验。这些是派发校验输入/结果，不能由客户端自报后直接信任。配置含共享在途/空闲回收、调试会话期限/数量、脚本模式/时限及worker启动/失联期限；详细字段见配套清单。
- [x] 先写行为失败用例，直接检查配置有效值而非只检查字段存在：

```ts
expect(resolveEffectiveConfig({ deployment: { maxAgentConcurrentJobs: 4 },
  agent: { maxConcurrentJobs: 2 } }).agent.maxConcurrentJobs).toBe(2);
expect(() => validateAgentConfig({ ...defaultAgentConfig,
  longPollWaitMs: 45000, controlRequestTimeoutMs: 30000 })).toThrow(/timeout/i);
```

`resolveEffectiveConfig`、`validateAgentConfig`、`defaultAgentConfig`在本任务定义并从contract出口导出。RED必须是业务断言失败，不是模块缺失；无导入边界时先只建立类型/函数壳，记录为脚手架，不能算功能实现。

- [x] 运行 `pnpm -C packages/execution exec vitest run tests/contract.test.ts tests/config.test.ts --maxWorkers=2`，保留有效RED；实现最小Schema/纯函数后同命令GREEN，随后build/typecheck。
- [x] 构建身份脚本列入Core运行实现及execution宿主的确定源清单，对排序路径与字节计算指纹；不含时间、产物和本地绝对路径。构建与清单变更共同进入身份；不修改项目定义指纹含义。
- [x] 本任务检查点：浏览器只依赖contract，无Node加载；配置上下级越权覆盖拒绝；默认值均可被合法覆盖；独立定向审核。

### Task 2 同一Core的无脚本/受信脚本档位与共用宿主

**文件：** Core `runner/{runner.ts,caseExecutor.ts,scriptRequirements.ts}`、`plugin/executionRegistry.ts`、`sandbox/jsEngine.ts`、`testing/suiteRunner.ts`、`workflow/{runner.ts,v2Runner.ts}`、`report/evidence.ts`、`index.ts`；execution `host/{capabilities.ts,registry.ts,prepare.ts,invoke.ts,output.ts,index.ts}`；复用Core `tests/runner/{runner.test.ts,caseExecutor.test.ts}`、`tests/sandbox/jsEngine.test.ts`、`tests/testing/suite.test.ts`、`tests/workflow/runner.test.ts`、`tests/credentials/output.test.ts`，新增execution `tests/invoke.test.ts`。

- [x] 先在既有测试中以不注册脚本引擎的内置registry运行一个无脚本用例/套件，确认当前抛“缺少javascript引擎”的有效RED；同时保留选中脚本应拒绝且目标请求计数为0的断言。请求设置及证据预算的新增选项先声明类型/夹具，分别观察真实叶请求配置未传递、小预算未生效的行为RED，再改相应接线。
- [x] 将 `CaseExecutionDeps.scriptEngine`变为允许缺省；只有实际进入脚本操作时才要求引擎。Collection/Suite准入检查实际依赖，不因无关资产脚本拒绝整个项目，也不允许先发请求后才发现祖先/后置脚本。
- [x] Core新增 `createBuiltinExecutionRegistry({ profile, scriptTimeoutMs })`，在 `plugin/executionRegistry.ts`逐项装配既有内置HTTP/WS/SOAP、认证、断言和报告器并从Node入口导出。`no-script`不装JS引擎，`trusted-core-script`显式装既有引擎；同一工厂供两宿主使用，不复制builtinAssertOperators、不在共享worker调用默认带引擎的工厂。子工作流、onError/finally和v1 JS条件均纳入实际依赖；v1条件仅在受信脚本批准范围内使用，v2结构化条件不转成eval。
- [x] `sandbox/jsEngine.ts`增加 `createJsScriptEngine({ timeoutMs })`，复用当前实现，未传保留3000ms默认；既有导出仍保持兼容。每任务实例化有效时限，不修改进程全局单例；复用原同步超时/pm/错误测试，不做逃逸探针或OOM实验。不改变同步接口为伪异步保证。
- [x] 先用既有夹具核验前置 `pm.variables.set` 对本次URL/头模板的行为；若有缺口，记录有效行为RED后在共用Core修正物化顺序：模块/目录及用例前置变量可用于本次模板，已有直接 `pm.request` URL/头修改不能被后续重新物化覆盖；后置变量继续按现有运行范围传递。同一请求同时断言变量替换与直接请求修改，保留前后置顺序及异常事实；已满足的行为不伪造缺陷RED。若必须破坏既有脚本API语义，停止该处并集中说明，不做仅代理生效的兼容补丁。
- [x] `invoke.ts`只分派三类现有Core入口；复用数据准备、credentialBindings、按第3.1节范围装配的HttpSession与每调用独立证据收集，输出由Core已有边界投影后才出进程。失败也投影部分结果，不丢实际失败事实。注册当前pm API能力，不声称具有不存在的 `pm.sendRequest`、完整 `pm.test/expect`、加密工具或npm库。
- [x] Suite/Workflow/v2现有请求超时默认值仍有固定接线，新增可选 `requestSettings: RequestSettingsOverride` 运行选项并向叶请求传递；复用Core现有resolveRequestSettings，不另写优先级算法。未传选项保留旧行为，管理员额度在最终选中配置上校验，超额拒绝而非静默忽略用户值。
- [x] EvidenceCollector补充可选预算入口，贯穿请求正文/字段、用例、工作流元数据及最终报告投影；未传仍用原默认值，配置后的新任务必须真正在Core生效。共享总预算，不能每段重置使报告无界；不改变密钥输出规则。复用现有输出测试加一组小预算截断/配置覆盖断言，不写大内存实验。
- [x] 定向GREEN并build/typecheck：`pnpm -C packages/core exec vitest run tests/runner/runner.test.ts tests/runner/caseExecutor.test.ts tests/sandbox/jsEngine.test.ts tests/testing/suite.test.ts tests/workflow/runner.test.ts tests/credentials/output.test.ts --maxWorkers=2`；`pnpm -C packages/execution exec vitest run tests/invoke.test.ts --maxWorkers=2`。仅在相应接线变更时运行对应文件，不每个子步骤全重跑；新旧宿主复用同一套语义夹具，不复制同义测试。
- [x] 检查点：两个registry没有业务算法分叉；无脚本依赖误判不产生目标请求；带脚本现有能力如实交付，不触及WASM/新脚本安全机制、不宣称node:vm已安全。

### Task 3 在线资产原子保存与不可变快照

**文件：** Core `storage/contractFiles.ts`/`index.ts`；新增Java assets四文件、修改 `store/FileVersionRepo.java`；execution `host/prepare.ts`；新增 `packages/execution/tests/projectFiles.test.ts`、Java `ProjectAssetsApiTest.java`；复用Core `tests/assets/snapshot.test.ts`。

- [x] 先用项目夹具覆盖“API请求、独立用例、嵌套目录、模型、环境、套件和工作流编解码后身份不变”；加入同名不同实体不串项目的失败断言；建立可调用类型壳后取得业务RED。
- [x] 实现 `encodeContractProjectFiles(project)` 与 `decodeContractProjectFiles(files)`，复用同一Core内部编解码。项目相对路径剥离服务端数字前缀，不能根据项目显示名恢复路径。
- [x] 新项目资产接口以expectedVersion约束整个delta，服务端单事务写入/删除并生成完整manifest。任意冲突全部不写；不改变旧batch部分成功语义。
- [x] 快照用一致性事务读取全部受权文件与版本/hash并持久保存字节；排队后编辑源项目不会改变旧快照。Java只校验控制结构/实体权限/额度，Core解析业务格式。
- [x] 旧在线布局保持原文，不自动改写；客户端显式发布有效本地项目到新在线项目，采用新标记。既有未标记文件不能伪称可执行，诊断明确指向格式/缺失项。（T9实际host/组件及T11真实desktop E2E已补齐；本波M4仅修陈旧限制文案，不改变旧格式限制。）
- [x] RED/GREEN使用 `pnpm -C packages/execution exec vitest run tests/projectFiles.test.ts --maxWorkers=2` 和 `server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml -Dtest=ProjectAssetsApiTest test`；Maven产物用独立构建目录。
- [x] 检查点：运行准备不改用户本地Session/磁盘工作区；hash不使用rootVersion求和代替。

### Task 4 代理身份、管理员分层、脚本准入与配置持久化

**文件：** Javaagent/config/policy目录、`auth/AuthFilter.java`、`ExecutionDtos.java`、`resources/{schema.sql,application.yml}`；新增Java `AgentManagementApiTest.java`、`ExecutionConfigTest.java`，脚本批准断言复用这两组测试和T6任务准入测试，不独立铺授权矩阵。

- [x] 先写有效失败：工作区管理员不能授予本区未获批代理；项目ADMIN不能改节点全局并发；同版本冲突不覆盖；配置2任务槽实际持久，非法心跳/超时组合拒绝。
- [x] 新表保存agents、登记摘要、工作区授权、区内项目分配、项目关联、配置版本/应用确认和必要审计，复用BIGINT及字符串出参规范。新表用幂等新增DDL，不删旧库重开。
- [x] 将runner路由交给专用代理过滤器；用户AuthFilter不将代理token当用户，代理filter不能放行未知runner路径。登记入口只接受有效登记材料，不全局放开 `/api/v1/**`。
- [x] 按真实工作区成员关系+有效项目角色判断，防遗留ACL在成员移除后单独恢复执行权。超管管理代理不自动获得项目材料读取；撤销与停止接单分开。
- [x] 实现独立的远程脚本准入记录：代理节点允许 `trusted-core` 是必要条件，不自动批准所有项目；有效项目OWNER/ADMIN按代理/项目范围授予脚本ID+内容摘要的版本批准，默认优先此粒度，内容变化失效。可显式选择信任整个项目，提交时二次确认醒目风险提示；该批准覆盖本项目未来脚本修改，执行记录仍保存实际依赖摘要。导入/分享不自带批准，EDITOR编辑/执行权不能自授批准；撤销阻止新启动，已运行按显式取消处理。服务端在提交和start-permit前核对，代理按固定清单与许可复核，不信客户端的无脚本/已批准标志。
- [x] 先在既有任务准入夹具中取得行为RED：脚本版本变化/批准撤销/节点禁脚本时目标计数0；合法批准仅允许对应快照。普通无脚本任务不要求脚本批准。本项仅实现远程任务准入记录，不接回DEF-001的运行时授权/密钥句柄桥接，不称恶意代码已隔离。
- [x] 运行 `server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml -Dtest=AgentManagementApiTest,ExecutionConfigTest test`，定向RED→GREEN；复用既有权限矩阵中受影响断言，不重建全角色排列矩阵。
- [x] 检查点：配置保存/下发/已应用分开，审计不保存凭据值；后端鉴权不是隐藏按钮。

T4服务/管理部分已独审（SDD snapshot-r2）；原两条跨任务检查点由T6/T7及T11真实代理E2E补齐，风险文案由T10组件与集中页面证据承接。本波I4又以RunnerControlTest真实撤销批准RED→23/23和supervisor/transport16/16补确定拒绝收束，最终新产物同HTTPS链仍待。证据见SDD task-11-report第33–34、56–57条及stage-final-fix-report，不以T4服务测试单独冒称整体通过。

### Task 5 项目凭据、附件与运行材料

**文件：** Javamaterials目录；execution `host/credentials.ts`、client数据方法；桌面 `main/online/projectCredentials.ts`；新增Java `ExecutionMaterialsApiTest.java`、execution `tests/materials.test.ts`；复用桌面 `tests/main/execution-credentials.test.ts`受影响断言。

- [x] 先写行为断言：项目A材料不能被项目B任务解析；代理不能获取未分配任务材料；同名本机凭据不能补代理缺失；准备后凭据版本变化必须重新准备或拒绝，目标计数0。
- [x] 定义ProjectCredentialStore接口，取得上述有效RED后，首版使用JDK自带AES/GCM/NoPadding、32字节主密钥及每次加密独立12字节随机nonce，绑定项目/ref/版本作为附加认证数据；记录keyId，主密钥部署文件不落数据库。缺失/损坏/不可用明确拒绝，不保存明文，不在异常中拼认证值；替换存取策略不改变Core认证算法。
- [x] 附件固定摘要/版本，普通文件和敏感网络材料区分；代理只取得本任务所需引用。固定文件只能从任务声明映射读取，不把PC绝对路径直接传往代理。
- [x] 共享调试路径为每调用独立绑定与清理敏感材料，不将凭据放入worker全局变量或跨scope连接缓存。独占任务也不接收代理控制token/部署主密钥；脚本可接触其已授权请求/响应值的风险在批准页直接提示，不谎称既有脱敏能阻止主动外发。
- [x] 本机在线执行适配SecretStore/credentialBindings：项目材料按在线授权取得，仅本机材料沿原本地存储；运行开始绑定实际版本，不在任务持久意图中保存明文。
- [x] 运行 `pnpm -C packages/execution exec vitest run tests/materials.test.ts --maxWorkers=2` 和 `server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml -Dtest=ExecutionMaterialsApiTest test`，确认有效RED后实现/GREEN。
- [x] 检查点：配置入口仍在客户端项目；代理身份与被测接口认证不是同一类凭据，不能互用。

T5模块已独审通过（snapshot-r1）。原跨任务检查点由T6 assignment/许可、T7真实worker及T11集中HTTPS材料/个人本机凭据闭合：task-11-e2e-second、controls-2、personal-green及final-runtime-desktop原日志保留。T9入口/T10风险提示另有组件与页面证据。原两份无输出typecheck日志仍不补造；T11全src/tests类型门已实际补证。本波I5正式compose空材料默认容量缺口另有RED，最终镜像GREEN仍待，不据上述旧候选勾选掩盖。

### Task 6 持久任务、长轮询与状态对账

**文件：** Javajobs六文件、对应DB表/DTO；新增Java `ExecutionJobsApiTest.java`、`RunnerControlTest.java`。T6完成检查点：snapshot-r2，独审fix1五项均解决；真实host/目标行为仍按下述未勾项交T7/T8/T11闭合。

- [x] 先构造同一提交意图重发、同消息重复确认、相同ID不同payload、启动许可确认丢失等确定性用例；断言只生成一个执行批次，队列不按URL/参数合并两个合法提交。
- [x] 队列/接单/启动/完成摘要/取消/结果归档分别持久。数据库条件更新决定状态与占槽胜者，HTTP长轮询只唤醒；使用DeferredResult或等价异步等待，不睡眠占线程模拟长轮询。
- [x] 无空槽仍返回取消/配置；长轮询有任务即返回，超时续接不丢任务。权限撤销、额度下降、能力不兼容在启动前拒绝并给原因。
- [x] `availableSlots`计量代理总任务准入额度，不等于空闲进程数；共享在途调用与独占任务必须竞争同一预算。任务携带执行档位、依赖摘要和批准版本；开始许可绑定它们及材料版本，许可前再次核对最新批准。共享worker满额但总额度尚有余量时可领取独占任务，不把worker局部上限误报为代理整体无槽。
- [x] 结果上传幂等校验摘要/长度，完成摘要与实际收束分别对账：只有调用已结束释放上下文，或独占进程已确认退出，才释放相应本机运行预留；后端结合结束确认更新占槽。结果待传仍独立保留。查询按当前权限，连接失联不是通过/失败/取消结论。
- [x] 运行 `server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml -Dtest=ExecutionJobsApiTest,RunnerControlTest test`；用可控唤醒/时钟验证等待和状态，不靠真实30秒超时/概率重跑。
- [x] 检查点：断线不换代理、不重跑，控制重试不重试目标请求，用户可辨认已申请取消与已确认取消。

T6原跨任务检查点已由T8 recovery与T11 controls-2真实离线账本/双丢ACK补传（目标仅1）、取消及已观察PID退出补齐；原日志和失败夹具修正均保留。本波I3保留身份/ACK的结果到期、I4确定拒绝收束另有独立RED/GREEN，不改已ACK报告字节。

### Task 7 代理混合派发、统一并发槽与Core子进程

**文件：** agent包清单/tsconfig/vitest、`main.ts`、`bootstrap.ts`、`config.ts`、`supervisor.ts`、`dispatch.ts`、`debugWorker.ts`、`debugSessions.ts`、`invocationContext.ts`、`taskChild.ts`、`slots.ts`、`transport/{control.ts,longPolling.ts}`；新增 `apps/runner-agent/tests/{supervisor.test.ts,transport.test.ts}`，共享worker行为集中在supervisor测试，不为每种组合另建文件。

实施接缝细化：按配套[执行契约第7节](../specs/2026-10-26-apicc-f7b-execution-contract.md#7-t7-装配接缝补充2026-10-26)，本任务另允许必要的共享 strict Schema、Java 运行时登记/固定输入/声明映射及部署身份属性增量。客户端不自报有效策略、Java不复制Core算法；具体内部裁定和证据保留在本阶段账本，原brief不回写成“事先已有”。

- [x] 独立Node入口只依赖execution/Core，不依赖Electron和CLI交互；握手报告协议、Core身份、能力及已应用配置。
- [x] 先用deferred目标计数器取得业务RED：配置总槽2时一个共享调试和一个独占工作流可同时进入、第三任务等待；下降到1不杀在途任务。用同一组夹具验证两个无脚本调试复用同一worker但变量/绑定/证据不串，取消A不影响B；同一调试会话Cookie按显式范围延续、不同scope不串。
- [x] `dispatch.ts`根据准备后的kind/依赖档位选共享或独占，不由请求名称、UI标志或字符串关键词决定。祖先前后置、v1条件等使任务进入受信脚本准入；未批准则拒绝，不在共享worker临时载入JS。无脚本套件/工作流仍走独占；Core内部节点/循环不新开进程。
- [x] `slots.ts`实现第3.1节同一准入预算与独立进程资源账，准备时预留、收束确认后释放，丢消息不重复释放。常驻调试子进程懒启动，局部在途数有上限，仅真正空闲后按可配置期限回收；回收中停止派发，旧代确认退出后再创建下一代。默认全局槽1不额外偷开业务并发。
- [x] `invocationContext.ts`每调用装配不可变快照、变量/提取状态、credentialBindings/markers、预算、AbortController、材料目录和显式HttpSession范围。worker注册表按generation/executionId/scope核验IPC并在结束时清理；复用进程不复用一次运行的Core状态。
- [x] `debugSessions.ts`复用Core现有 `createHttpSession()` 及接口提供限定会话IPC，不增加通用宿主调用。调试会话句柄关联scope和当前执行授权，跨项目/owner拒绝；宿主仅保留内存Cookie，敏感会话IPC不进入普通日志/报告。worker回收不丢会话，服务重启/会话过期旧句柄先拒绝；套件/工作流用私有会话。复用同一Cookie夹具证明跨共享/独占调试的显式延续、作用域隔离和worker回收后仍在，不为会话新建测试矩阵。
- [x] 代理宿主领取/准备，子进程执行同一execution host；完整材料和许可齐全才开始。IPC只发送业务DTO和本次所需内存材料，不在命令行参数/环境打印凭据，不把控制身份交给任务。父进程启动/失联监督与本地期限均按配置执行，不能依赖被阻塞worker自己报告超时。
- [x] 调度逻辑只依赖AgentControlTransport；长轮询和数据fetch分开。心跳/配置/取消在满槽时持续工作；时间参数来自实际配置版本。
- [x] 运行 `pnpm -C apps/runner-agent exec vitest run tests/supervisor.test.ts tests/transport.test.ts --maxWorkers=2`，有效RED→GREEN；build/typecheck含测试文件。
- [x] 检查点：共享+独占确实共用总槽；仅单请求无脚本调试复用进程；真实多任务槽不是Core内部并发别名，不用外部平台、不建设通用脚本池、不提供未实现的长连接选项。

### Task 8 代理意图账本、结果补传与退出

**文件：** agent `ledger.ts`、`outbox.ts`、`supervisor.ts`、`debugWorker.ts`、`invocationContext.ts`、`taskChild.ts`；新增 `apps/runner-agent/tests/recovery.test.ts`。

- [x] 先写“开始后控制断线，恢复后请求计数不增加；丢结果确认重复上传但只归档一次；进程重启不从头执行；缓存到额度不领取新任务但保留未确认结果”的有效行为RED。
- [x] 稳定执行身份先持久意图，写入投影后的有界结果；SQLite若复用现有依赖则只作本地账本，不再引入新数据库产品。缓存写入原子化并检查真实剩余空间。
- [x] 子进程业务执行前后和代理重启对账区分“确定未开始、已开始、无法确定”；不将无法确定归成通过或安全重跑。
- [x] 本地单调期限独立于控制链路；独占任务先按Core取消/配置宽限收束，仍未退出则终止该进程。共享普通取消只Abort单调用；若worker无响应或单调用无法收束，只能停止整代worker，并对全部在途调用分别记录已知事实及中断/超时/待确认原因，不宣称只杀掉了一个请求。
- [x] 在同一recovery夹具增加一次受控共享worker退出：两个在途执行均有中断记录且无自动重发；旧generation迟到结果不能覆盖新调用，新任务仅在旧代确认退出后进入。独占任务不因调试worker退出而被一并取消；不能用PID相同或“已发kill”替代退出确认。无需构造引擎漏洞或真实OOM。
- [x] 服务退出先停新准入并收束两类子进程；进程组/init与监督通道丢失的退出策略一并交付，不能留下无人管理继续请求的进程。同OS账号并不构成恶意脚本隔离，部署说明明确受信域与可选外部CPU/内存限制。
- [x] 运行 `pnpm -C apps/runner-agent exec vitest run tests/recovery.test.ts --maxWorkers=2`；使用受控传输和小预算验证，不制造OOM/磁盘写满/宿主崩溃实验。
- [x] 检查点：重启恢复的是账本和待传结果，不是JS内存/业务执行；未确认结果不被普通保留期删除。

### Task 9 客户端在线项目工作区和两种执行位置

**文件：** 第2节桌面文件清单，新增 `tests/main/online/execution.test.ts`、`tests/renderer/stores/onlineExecution.test.ts`；复用 `tests/renderer/components/onlineWorkspace.test.ts`、已有认证/测试/工作流控件。

- [x] 先写有效行为断言：选代理不改环境，缺本机材料不上传；切项目/服务器/页面后迟到响应不写进另一个项目；代理任务关闭窗口后可查询，本机任务不悄悄转交后端。
- [x] 在线资产适配器读取新的项目文件格式；项目内提供本阶段必需的环境、认证、数据、套件和工作流编辑/保存，复用已有业务控件，不要求去Web填测试参数。旧格式内容显示明确限制而不被自动覆盖。
- [x] IPC显式携带server/workspace/project、运行身份和位置，main核对当前owner和在线会话，不复用本地Session根路径推断在线项目。新增频道/结果Schema、preload和内存API一起更新。
- [x] 本机直接取同一快照调用execution host，代理则提交任务并查询状态/取消。调试草稿只作用于本次快照覆盖；套件/工作流要求保存，不能静默执行旧内容。
- [x] 默认显示执行位置、环境、快照/短指纹、逻辑结论、真实请求失败、连接/归档状态和可行动错误；复用已有报告组件，原始数据默认折叠。刷新间隔可配置，只刷新可见活动任务。
- [x] 脚本任务显示现有能力范围、被拒绝的具体脚本/版本与批准入口（按权限），执行详情显示“共享无脚本调试/独占任务”、有效脚本时限及运行兼容档位。项目级信任提示覆盖未来修改及认证可见风险，不把高风险选项作为默认；不为此创建第二套脚本工作台。
- [x] 定向命令：`pnpm -C apps/desktop exec vitest run tests/main/online/execution.test.ts tests/renderer/stores/onlineExecution.test.ts tests/renderer/components/onlineWorkspace.test.ts --maxWorkers=2`，有效RED→GREEN并desktop build（包括Vue类型）。
- [x] 检查点：不破坏顶栏/项目签/独立滚动、不新增项目范围外入口、不在浏览器bundle引入Node或原生依赖。T11旧候选已完成真实布局与原生关窗/重开，见task-11-native-close-reopen及UI2证据；本波M4/M5新增文案与结果展示最终实际UI另留T11未勾，不以DOM/构建代验。

### Task 10 Web代理管理与配置页面

**文件：** 第2节admin文件；新增 `apps/admin-web/tests/views/AgentsView.test.ts`、`tests/views/ProjectAgentsView.test.ts`；复用现有API客户端与路由守卫测试。

- [x] 先写页面关键行为RED：只获项目ADMIN不能编辑全局节点；保存并发2后页面显示实际已应用/未应用状态；无权代理不能在下拉中被选用，后端拒绝原因仍直接可读。然后最小实现并定向GREEN，不为每字段新建一套页面测试。
- [x] Web完成平台节点页、工作区授权/分配、项目关联/默认代理/策略，按对应角色可见；配置表显示默认、继承、实际值、单位、冲突/未应用/需重启；不以JSON编辑器交付。
- [x] 节点页可配置受信脚本模式、共享调试在途数/空闲回收、监督期限；项目管理页维护远程脚本单版本批准或显式整项目信任及撤销，显示实际脚本版本/范围和风险。不要把管理策略搬成被测接口密码编辑器。无脚本任务无需经过脚本批准流程。
- [x] 定向命令：`pnpm -C apps/admin-web exec vitest run tests/views/AgentsView.test.ts tests/views/ProjectAgentsView.test.ts --maxWorkers=2`；随后admin build，确认实际可读标签、单位、角色和中文/English，不只检查字段存在。
- [x] 检查点：Web不出现被测接口token/密码配置；任何页面隐藏按钮之外，后端均有相同作用域约束。

T10实现/任务独审于2026-10-27完成：最终两视图10/10、Java管理组17/17、admin含src/tests类型构建通过，初审五项Important经正式fix1定向复审全部关闭；证据详见本阶段SDD task-10-report.md及task-10-fix-1-review.md。上列勾选不替代T11真实浏览器/客户端视觉、实际角色与HTTPS/Linux端到端准入验收；该集中检查点及AC01–15最终结论仍开放。

### Task 11 部署、集中验收与交付

**文件：** 第2节部署/门禁文件；新增 `apps/runner-agent/tests/e2e-server.test.ts`；复用desktop现有 `tests/main/online/server-fixture.ts`的生命周期策略，不横跨包import桌面产品代码。

- [x] 管理台新依赖需要先构建execution contract和其依赖；根Dockerfile不能继续假定admin无workspace依赖。agent镜像与运行数据卷/主密钥/CA文件/HTTPS部署示例分开，敏感值只用占位示例不写真实值。
- [x] 一份合成项目集中真实联验：无脚本调试、受信前后置脚本调试、套件、v2工作流在本机/代理共用语义夹具；请求使用固定响应、显式环境/数据及合成凭据，验证前置变量/直接改请求、后置提取/断言和失败事实，不以时间戳/随机ID逐字相等验收。记录实际Electron内嵌Node/V8与代理Node/V8，只有此受支持组合才进入兼容清单；未知组合先拒绝，不默默另装本机Node或升级Electron。
- [x] 将混合总槽、共享普通取消/会话隔离、一次共享worker受控退出、控制断线/重复确认组合进最少的现有联验流程；单脚本版本批准失效在准入夹具验证，不重复搭一套跨端安全矩阵。只用合成目标与计数，不碰真实项目。
- [x] agent镜像首版采用Node22 Debian slim系，验证现有依赖的Linux原生闭包，不默认照搬旧服务镜像的Alpine选择；不因此升级依赖。控制服务可由Spring Boot现有SSL部署配置提供HTTPS，代理独立CA文件，不引入外部托管服务。
- [x] Linux容器验证使用独立compose项目/端口/卷；联验用JDK21 keytool创建本次私有测试CA/带SAN服务证书，代理使用局部可信CA配置且保留证书校验，不通过skipVerify或全局环境关闭TLS验证。客户端关闭后代理任务继续，重新打开可查；只停止本轮自建服务，不动用户已有客户端/部署。
- [x] 定向命令：`pnpm -C apps/runner-agent exec vitest run tests/e2e-server.test.ts --maxWorkers=1`。E2E私有Maven产物、数据目录、工作目录、CA与结果都在本轮独占目录，先确认进程停稳再清理；失败必须保留真实原因，不以扩大超时或强制退出掩盖。
- [x] 集中原生/浏览器手验本阶段新增界面，工具无法证明的交互才一次请用户补验；主报告仍为可读业务视图。不能只凭DOM有字段或构建通过验收。
- [x] 最终整阶段独审一次；修正后只复审变更点。必要全门禁按第6节跑一次，打桌面目录包、控制服务包和agent镜像/Node产物并绑定SHA/构建身份，归档部署和回滚说明。

证据索引：task-11-report保留全部命令/工具版本/失败和资源归属；task-11-e2e-second、controls-2、personal-green及task-11-final-runtime-agent/desktop/admin原日志支持共用语义、总槽/取消/补传、个人材料与完整3+2+2真实E2E。task-11-native-close-reopen证明原生关窗后代理继续/重开查询；stage-final-fix-report及原日志记录最终波有效RED/聚焦GREEN，stage-final-fix-rereview为唯一修复定向复审。新I4 HTTPS、新I5正式Compose、新server镜像部署及新包实际中英视觉均已另取证，见第8节；未用旧包代替新包。Ubuntu宿主和正式GitHub CI未实跑，不外推通过。

## 5. 最小验证与AC映射

| 验收编号 | 主要任务 | 必要证据 |
| --- | --- | --- |
| AC01 | T1/T2/T7 | 唯一Core调用入口、构建身份不匹配拒绝、真实运行 |
| AC02 | T2/T3/T9/T11 | 同一合成项目三类对象的本机/指定代理结果 |
| AC03 | T5/T9 | 项目/仅本机凭据边界及缺失先拒绝 |
| AC04 | T4/T6/T10 | 管理分层、项目scope及后端拒绝 |
| AC05 | T3/T5 | 原子资产、固定快照/附件/凭据版本 |
| AC06 | T6/T7 | 异步长轮询及满槽仍收控制 |
| AC07 | T6/T8/T11 | 丢确认/重连计数不重跑、结果补传 |
| AC08 | T6/T8/T9 | 取消、期限和崩溃状态诚实、受控进程退出 |
| AC09 | T2/T8/T9 | 控制/目标网络分类，逻辑/请求/归档分别显示 |
| AC10 | T9/T10/T11 | 中文/English、实际页面截图及集中手验 |
| AC11 | T7/T11 | 自托管后端+独立代理真实产物运行、桌面关闭不影响代理 |
| AC12 | T11 | 设计/计划/报告/产物身份/部署/回滚/限制清单 |
| AC13 | T1/T4/T7/T8/T10/T11 | 配置真实生效、1/2槽、降额不杀旧任务、继承和错误组合 |
| AC14 | T1/T2/T7/T8/T11 | 混合派发、共享+独占统一总槽；调用/会话scope隔离；空闲回收；单调用取消与整代故障/迟到消息处理 |
| AC15 | T1/T2/T4/T6/T9/T11 | 受信同步前后置脚本跨宿主语义、版本批准/撤销、能力及运行档位拒绝；不宣称WASM或恶意脚本安全验收 |

有效RED只证明本次行为缺口；没有导入/环境/夹具错误后，才能进入GREEN阶段。新测试按上表风险分布：不把每个配置、消息、角色和协议做笛卡尔积；若现有同义测试可以扩展，优先复用并调整本计划的测试文件记录，不叠加重复测试数量。

## 6. 最终门禁、产物与Git边界

最终候选先按依赖顺序构建：plugin-sdk → Core → execution → agent/desktop/admin/CLI；生产者build生成dist后再做依赖其声明的typecheck，同时保证src+tests类型检查。新包build本身包含typecheck或门禁明确列出，不依赖Vitest转译代替类型验证。

全门禁复用并最小扩充 `scripts/test-all.ps1`：品牌词表自检/默认跟踪口径及显式include-untracked扫描、拓扑构建/类型、递归包测试、Java测试。测试workspace串行、每包worker最多2；真实跨端联验只启一个私有Java实例，避免并行反复编译/服务抢占电脑。根Dockerfile、agent镜像和Windows目录包做对应必要冒烟。

```powershell
# 在固定Node/pnpm/JDK子进程环境、冻结候选worktree中运行
pwsh -NoProfile -File scripts/test-all.ps1
# 新增部署冒烟是T11的实际交付脚本，不能把未创建脚本当作已验证
node scripts/smoke-runner-agent.mjs
```

没有源码变化时不在提交前、合并前、合并后各重复同一全量。若最终合并结果与已验候选不同，核对差异并针对变化补验；用户明确要求合并后全量时遵从新要求。不得用此规则省略首次最终候选全量或真实包冒烟。

交付记录至少包含：源SHA/未提交差异身份、Core构建身份与Node/V8兼容档位、命令/cwd/工具版本/退出码、失败和修正、15项AC矩阵、脚本批准/实际依赖摘要、混合调度与退出记录、页面实际证据、包路径与摘要、自建服务退出情况及开放项。不能覆盖旧证据、把后验测试冒称TDD或用历史包代替新候选。

已批准的R1规格/计划已放入 `docs/superpowers/specs/2026-10-26-apicc-f7b-online-execution-design.md` 和 `docs/superpowers/plans/2026-10-26-apicc-f7b-online-execution.md`，配置/协议清单同目录引用，本波协议/配置增量同步正式contract。SDD原日志与before/after保留完整历史，正式计划只按可核证据勾选，不提前commit或将开放AC判通过；保留本次转折和DEF-001未恢复的说明。

实际门禁按task-11-report记录：首次test-all在Core旧reporters夹具自然exit1，修后该文件19/19；SDK/Core其余已绿文件不重跑，其余包、Java279与此前排除的三个真实服务E2E随后串行分段完成，不能改称整次test-all exit0。root已做前一候选原生关窗/重开与中英布局；本波只做受影响验证、最终新产物/I4/I5及UI，仍待唯一修复定向复审。Ubuntu宿主/正式GitHub CI没有实跑，不外推通过。原AssetVersion异常/结果元素边界已在M3/M2有效RED后修；M7生命周期容量按docs/backlog.md登记未排期，去重身份不删除。chunk、unchecked/Jackson、Mockito/CDS/终端编码/SQLite实验性等原告警仍保留，不以其为由改依赖或扩大测试。

## 7. 已批准默认细则与阻塞处理

以下已列默认细则随本轮整阶段开工授权采用，不逐task再询问：

1. 首发代理Linux容器；Windows为客户端验收平台，不做Windows代理服务安装器。
2. 项目有效OWNER/ADMIN/EDITOR可执行，VIEWER只读；提交者取消本人任务，项目ADMIN+可取消项目任务。
3. 新在线可执行资产复用Core拆分契约；旧在线内容保留，不自动迁移/覆盖；可显式发布本地项目到新在线项目。
4. **已被R1确认替代，不再重复询问：** 采用混合进程策略，复用现有Core受信同步测试脚本；不自动加载外部插件，不运行不受信任意代码。脚本批准、支持API与真实运行档位按本文落实，不等于恢复DEF-001。
5. 断线继续已开始任务到本地期限，重启不自动业务续跑/重跑；配置默认与权限/生效规则按配套清单。

本轮“可以，完成F7b阶段”作为整阶段开工授权，T1–T11连续推进，沿用计划的模型与隔离方式，不逐task重开设计。只有实质设计变化、缺少必要外部材料、不可逆/范围外副作用或确需升级Sol max才集中说明阻塞和用户需要的动作。DEF-001不恢复，不能改名绕过边界；提交/合并/推送另等用户指令。
## 8. 最终验收与交付（2026-10-27）

本节为收尾时的权威状态，前文“尚待”等阶段过程文字保留历史，不据此重做已完成任务。T1–T11、唯一整分支宽审和恰好一次最终修复定向复审完成：原14项发现12项关闭，M5部分未闭合、M7延期；新增N1为Minor，剩余Critical/Important为0。没有第二波源码修复。阶段验收有明确保留，不称零缺陷、不称已合并发布。

### 8.1 验收矩阵

| AC | 已核对的证据 | 结论与限制 |
| --- | --- | --- |
| 01 | 同一Core入口/197源构建身份、schema漂移/源测试类型、Electron/Linux实际运行及未知档位拒绝 | 通过；Java未复制执行算法 |
| 02 | 统一HTTPS五语义夹具、runner完整3项、I2真实子进程/Core及新包任务39/35 | 通过；后置失败和零请求逻辑失败不再误报passed |
| 03 | 项目材料两位置、个人加密材料重开读取、代理前置拒绝/目标计数与后端无个人ref | 通过；个人材料不自动外发 |
| 04 | 分层管理作用域实际页面、真实API权限组及取消15项、唯一复审 | 通过；取消限本人或有效项目OWNER/ADMIN，遗留ACL不绕过成员门 |
| 05 | 原子资产/快照、版本/输入摘要/附件/凭据/脚本固定和实际HTTPS许可链 | 通过；不自动改旧队列材料 |
| 06 | 真实HTTPS长轮询、满槽取消/降额仍可达、独立transport边界 | 通过；长连接仅留接口未实现 |
| 07 | controls-2丢ACK/断线补传/目标一次、原生重开任务不新增 | 通过，保留M7元数据增长限制 |
| 08 | 单取消/共享整代/独占退出确认、I4新HTTPS拒绝收束及下一任务 | 通过；Windows SIGTERM不外推POSIX优雅hook |
| 09 | 逻辑结论/请求事实/资源与归档分开，新包零请求1/0/1与请求0/0/0 | 通过，保留N1到期查看交错的错误体验限制 |
| 10 | 新包中英实际观察、旧3000ms与新1250ms、毫秒时区/短指纹、轨迹局部滚动/原始数据折叠；直接HTTP管理台可读表单和角色范围 | 有保留通过：M5少数已知状态及历史证据文案未全部本地化；不称客户端零文案缺陷 |
| 11 | 新server镜像HTTP→私有CA HTTPS healthy/init、新agent正式Compose/Core、新包入口及此前真实关窗后代理继续 | 通过；首版Linux容器，未做Ubuntu宿主实跑 |
| 12 | 正式规格/计划/协议、部署回滚、分段原日志/完整hash/实际页面/开放项及24条裁决保留 | 通过；未提交/合并/推送 |
| 13 | Java279首全量及最终配置/重启/留存16项、1/2槽与降额/heap应用、历史permit值、真实Spring清理/batch/410 | 通过，N1并发下载边界仍未修 |
| 14 | 统一总槽/共享和独占、Cookie会话隔离、idle refs保护、整代故障/迟到消息 | 通过；不承诺任意脚本隔离 |
| 15 | Electron44.1/Node24.19/V8与LinuxNode22.19/V8、受信同步脚本、版本批准/撤销、实际HTTPS拒绝链 | 通过；DEF-001/WASM不恢复，非恶意脚本安全沙箱 |

### 8.2 门禁、实际页面及产物身份

- 必要全门禁采用一次首跑+失败文件修正和后续未跑包串行续跑：SDK11、Core93文件1358项及修后reporters19、execution51、CLI195、agent非Java21、desktop非Java1126、admin非Java196、Java279，三个真实服务文件3+2+2均通过。首 `test-all` 自然exit1原件保持，不能改写成单次全绿。
- 最终波只跑受影响回归：contract11/后续config-contract30、jobs15、main+panel43、RunnerControl23、supervisor/transport16、config/restart/retention16、cleanup4、workflow/session52及会话IPC23；相关原RED/夹具失误/首次可达断言、命令/cwd/固定工具和退出码见本阶段SDD原日志。源/测试类型、受影响构建、schema及品牌门禁均已核；不为本节纯文档更新再次全量或重打包。
- 新包实际视觉：`stage-final-root-ui.md`，用户只做合成登录；root正式Sky观察账户/浏览标签、引导、失败任务39/35、旧任务7历史3000ms、新1250ms、中英结论和工作流轨迹、局部滚动和默认折叠。管理台旧包之外的实际HTTP页面证据为 `task-11-root-ui-final.md`，本波视图未改不重做矩阵。
- 构建源清单1012项，SHA256 `8e892fa5ea791877956a8641d59050fff95f215a05b96f259a55b40ac0dbc261`；最终波相对父候选48项/964未变，完整before/after、patch与源manifest均保留。HEAD/base仍 `1a585a8e17deba4979d4dacd35e4fde4c5a08f26`，不是把HEAD空diff当改动。
- CoreBuildId `9b10ef20241d1f7957e80c87fe515484f616d86d21e8dc9c179d198f11a50579`；scriptApiId `4c7c797e04a8eb8769ea8d65e6248a40853e7cf1793d0e37d3e862146edac572`。

以下路径均相对开发工作树根 `C:/Users/imini/.codex/worktrees/contract-assets/apicc`：

| 产物 | 路径/标签 | SHA256 / 实际image ID |
| --- | --- | --- |
| Windows目录包EXE | local/f7b-t11/desktop-package-stage-final/win-unpacked/apicc.exe | d5ffd35630e89ec7b81d5ec46e0e2e9cbcdea41a0cd22fda9165fdc4ea17791b |
| 应用ASAR | 上述目录resources/app.asar | acc71d8a0af4ebcde09e0cdfb9df1bb17dc1cafe99ce8e0f4c069829f7d21802 |
| 服务JAR | local/f7b-t11/server-stage-final-image/app.jar | 94bb5bfa957bef20ded0be76ec1db7f184839806f3d445ec8d433bc2a6f5b47a |
| 服务镜像 | apicc-f7b-t11-server:stage-final | 84afad30ee426c75fceeeabde57e593cc0b05650c42279d5d86c2d554a643237 |
| 代理镜像 | apicc-f7b-t11-agent:stage-final | b471c8fdd87a365a5405ce917f1ae1c6e721593c08090b012b6c8f8e51b48d02 |

服务镜像是已验基础层上清空旧console后装入新jar/当前console，不冒称再次完整执行根Dockerfile构建；真实镜像内jar及完整console逐hash与本地一致。新agent按正式Dockerfile.agent构建。机器库存 `stage-final-fix-artifacts.json`及32项路径/hash/ASAR身份均root独立验证；生成当时pending文字保留历史，最后收尾见 `stage-final-closeout-manifest.json`。本节及backlog是复审结束后的纯文档状态更新，生产/测试源码与构建身份不变，不能倒改构建源manifest。

实际新I4：启动前撤批准→持久拒绝script_grant_missing→not-started/rejected/archived/released，目标0；再批准后下一任务passed，目标总1、历史1250ms。新I5：正式Compose /tmp4GiB、默认512MiB地板、空材料进入真实Core最小workflow passed。新server镜像HTTP→同卷私有CA HTTPS均healthy/init=true，Tomcat/Hikari优雅停止日志完整。

最终UI客户端12604正常Alt+F4退出、原生窗口/进程消失，无丢草稿操作；随后核Java19016/Node16844精确归属，调用本轮stop入口。Linux agent exit0/OOM=false，先复制SQLite到 `ui-stage-final-20261027/agent-final-data-resumed`再移除自己的容器和卷；目标/Java/dispatcher收束均ok，原DB/profile/报告/CA/原日志保留。Windows Java只记录SIGTERM/forcedFallback=false，不冒称POSIX优雅hook。Ubuntu宿主与正式GitHub CI未跑。

### 8.3 开放项

三项非阻塞债务在[低优先级需求池](../../backlog.md)中明确为未实现/未排期：EXECUTION-LOW-001（M7安全元数据生命周期）、002（M5少数状态与历史文案本地化）、003（N1到期下载与清理原子可见性）。不盲删去重身份、不隐藏失败、不把已登记当已修，不自动算入F7c承诺。原有bundle、SQLite实验性、unchecked/Jackson等告警及历史TDD顺序偏差仍保留原记录。

### 8.4 我作出的裁决（按原账本顺序，含判断错误的代价）

| # | 裁决 | 若判断错误的代价 |
| --- | --- | --- |
| 1 | 未获Git集成授权，保留账本并用完整冻结差异/hash审核，不自动提交或删除 | 捕获差异不完整会漏审，故逐hash核对 |
| 2 | 整阶段批准采用计划默认细则，不倒称更早获批 | 配置/角色/部署边界返工 |
| 3 | 项目/工作区删除采用同项目锁和事务回滚 | 删除语义及锁竞争/顺序返工 |
| 4 | 允许最小browser-safe提交与固定inputs Schema | DTO和装配维护 |
| 5 | Core三处wire metadata生成Java JSON Schema，固定networknt1.5.9 | 协议误拒/漏验及生成维护 |
| 6 | 补固定附件路径映射和独立runtime握手 | DTO/投影/消费者接线维护 |
| 7 | 首claim绑定host代际，固定网络配置/显式材料版本 | 输入/握手与claim时机返工 |
| 8 | 权威policy入digest，父期限从原准入起算 | 固定输入/时机接线返工 |
| 9 | 控制服务身份显式配置规范HTTPS base，不猜Host头 | 反代别名及部署绑定调整 |
| 10 | 用现有Node内置SQLite事务账本和单写者锁 | SQLite兼容及状态文件维护 |
| 11 | SQLite child读lease/epoch阻止旧子进程重入 | 锁复杂度及旧child退出前暂拒恢复 |
| 12 | 故障报告最小1KiB并逐槽预留，不追认超额 | 极小配置收紧及跨端约束维护 |
| 13 | 补项目级只读运行/能力/应用状态与有效策略投影 | DTO/路由/授权维护 |
| 14 | 管理员只读已分配未关联候选，不放宽写权限 | 两个读接缝/DTO/权限维护 |
| 15 | 在线本机每调用fresh registry复用已登记受信插件 | 可选host接缝/Core签名/桌面装配维护 |
| 16 | 本机首次异步前登记，父期限计准备耗时且终态有界 | 慢控制下更早拒绝与生命周期返工 |
| 17 | 在线工作流只用项目执行栏的单一环境选择 | 在线环境选择操作位置改变 |
| 18 | 超管有最小全工作区id/name候选目录，不改变成员列表 | 受限只读路由与投影维护 |
| 19 | 允许隔离非Web单组JUnit与UI服务同在，不启第二跨端服务 | 短时资源竞争及必要重做 |
| 20 | M7安全元数据压缩延期，不盲删历史意图/tombstone | 长用元数据开销和后续安全压缩工作 |
| 21 | expired/410、有界清理批次100上限1000、旧归档保守锚点 | 旧记录清理推迟、schema/DTO/容量调优维护 |
| 22 | strict持久start-rejected及失败回滚后短事务落拒绝 | 共享契约/Java/agent状态机维护 |
| 23 | M5少数状态映射保留Minor，不启动第二修复波 | 中文用户仍遇英文状态，后续小修/回归 |
| 24 | N1到期并发下载错误保留Minor，不启动第二修复波 | 到期边界体验/支持成本，后续原子读取和交错回归 |

完整理由、原证据与历史失败保留在本计划SDD `progress.md`，不删除工作树或stash。下一步Git集成由用户单独选择，不能从“验收收尾”推断提交/合并/推送授权。
