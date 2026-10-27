# F7b 配置与协议清单

> 开工批准：2026-10-26，用户要求“可以，完成F7b阶段”。按R1及已列默认细则实施；下文保留的“未开工/待集中确认”等文字为此前准备记录，不构成再次询问的要求。开发与必要验证已获授权，提交/合并/推送仍未授权。实际进度以本阶段SDD账本及证据为准，不以计划文字认定已完成。

日期：2026-10-25；R1修订：2026-10-26；最终修复波细化：2026-10-27。状态：已实施并有分段验证，最终修复复审及集中交付证据仍待闭合，不据此宣布发布。依据：[首版架构](2026-10-26-apicc-f7b-online-execution-design.md)、[已确认决定](2026-10-26-apicc-f7b-decisions.md)、[本次修订记录](2026-10-26-apicc-f7b-hybrid-decision.md)。数值是初始默认建议，不是容量验收结论；配置能力不能仅在界面存在而运行时无效。

## 1. 包和装配边界

- 新增一个 `@apicc/execution` 包：`./contract` 仅含浏览器可用的DTO、Schema及纯配置计算，运行时Core Schema只从已有 `@apicc/core/schema` 引入；`./host` 是Node运行准备与Core调用；`./client` 是可注入fetch的普通HTTPS数据客户端。包根不混合导出Node宿主模块，客户端/管理端渲染器只导入 `./contract`，不能从Core根运行时入口间接带入Node模块。
- 新增 `apps/runner-agent`：独立无界面Node进程，负责任务通信、子进程监督和本地待传区，依赖 `@apicc/execution/host`；不依赖Electron，不复制Core Runner。
- Core不依赖execution包或代理协议。Java只实现控制协议、授权和持久化；跨语言DTO以同一批契约夹具校验，不引入代码生成平台。
- 首发部署建议为Linux容器；Windows可运行Node测试宿主验证公共逻辑，但不据此宣称已提供Windows原生代理服务安装器。
- 代理主进程只做控制/监督；真正无脚本的单请求调试复用一个按需启动的独立常驻子进程，其他调试、套件和工作流按完整任务独占子进程。两条路径调用同一execution host/Core，不在主进程内联执行任务、不建设通用脚本进程池。
- 全局额度N限制的是任务调用及其准备预留，不是进程数；共享调试在途I与独占任务K共同满足 `I + K ≤ N`。共享worker局部上限不能额外增加总额度，排队项不开进程。当前一代常驻worker退出未确认前不创建下一代。

## 2. 配置入口与覆盖

部署配置负责服务地址、可信CA、数据目录、密钥文件及部署能力上限；Web负责代理和对应级别管理员策略；客户端项目负责环境、接口认证、测试数据及单次运行参数。项目管理员不能修改共用代理全局参数。

默认项采用“部署默认 → 工作区 → 项目 → 本次运行”的继承；最大额度取适用限制的最小值，不允许低层扩大。代理节点配置在部署能力内独立生效。服务端回传显式值、继承来源、实际生效值、策略版本及受限原因，不能由客户端自行推测权限或有效额度。

所有时长单位为ms、容量为bytes，界面转换为秒/分钟、MiB等可读单位；计数为正安全整数，比例为有限数。下表的组合参数在配置模型中分别保存字段，不存无法校验的自由文本。

| 参数 | 初始默认值 | 修改层级与校验 | 生效方式 |
| --- | --- | --- | --- |
| `deployment.maxAgentConcurrentJobs` | 32 | 部署级；正整数，仅是可调整部署策略，不保证机器能承载32项 | 重启控制服务后限制新准入 |
| `agent.maxConcurrentJobs` | 1 | Web平台级；1至部署上限；允许配置2及以上 | 新任务入槽；调低不杀旧任务 |
| `agent.sharedDebugMaxInFlight` | 4 | Web平台级；正整数，有效上限为此值与全局剩余任务额度的交集，不额外赠送4个槽 | 新共享调用；调低先排空超额在途，不杀任务 |
| `agent.sharedDebugIdleMs` | 60000 | Web平台级；正值，仅无在途调用且无未完成清理时开始计时 | 下一空闲周期；回收中停止派发 |
| `agent.debugSessionIdleMs / maxDebugSessions` | 1800000 / 64 | Web平台级；正值/正整数；只回收无活跃引用的空闲会话，容量满且无可回收项时拒绝新会话，不驱逐活跃会话 | 会话新准入/空闲回收；调小不截断在途 |
| `agent.workerStartupTimeoutMs` | 15000 | Web平台级；正值，计入任务总期限；两类worker均需初始化确认 | 新worker启动 |
| `agent.workerHeartbeatIntervalMs` | 1000 | Web平台级；子进程监督心跳，与HTTPS控制心跳分开 | 新worker/下一监督周期，原子应用 |
| `agent.workerUnresponsiveAfterMs` | 15000 | Web平台级；大于监督心跳且大于适用最大同步脚本时限加一个监督心跳间隔 | 新worker/后续监督周期；无法即时生效显示待应用 |
| `agent.scriptMode` | `deny` | Web平台级；仅 `deny / trusted-core`；开启不代替项目批准，不开放不受信代码 | 新任务准入；关闭不冒称在途已停止 |
| `policy.scriptTimeoutMs / maxScriptTimeoutMs` | 3000 / 10000 | 工作区/项目策略与单次运行；正整数，默认≤最大，单次≤适用最大，须与worker监督时限组合校验；底层计时器范围另限 | 启动前固定，每个同步脚本操作使用同一Core工厂 |
| `agent.childMaxOldSpaceMiB` | 256 | 部署引导默认、Web平台级可调；正整数，实际配置还受机器资源约束；仅V8 old-space而非进程RSS总额 | 新子进程，旧worker排空后才换配置；不为调参杀在途 |
| `deployment.agentMemoryLimitBytes / agentCpuLimit` | null / null（未设置外部硬限制） | 部署级；null或正值，通过容器memory/CPU配置生效；示例说明如何显式设置，不能把Node堆上限等同容器限额 | 重新部署代理；界面/部署诊断明确显示未配置，不声称无限资源可用 |
| `agent.longPollWaitMs` | 30000 | Web平台级；大于0，且加余量后小于控制HTTP超时 | 下一次轮询 |
| `agent.controlRequestTimeoutMs` | 45000 | Web平台级；高于长轮询等待；需匹配网关超时 | 后续请求 |
| `agent.pollTimeoutMarginMs` | 5000 | Web平台级；正值；等待+余量不超过控制超时 | 配置原子应用 |
| `agent.heartbeatIntervalMs` | 10000 | Web平台级；大于0且小于失联阈值 | 后续心跳 |
| `agent.offlineAfterMs` | 30000 | Web平台级；大于心跳间隔 | 连接状态判定；不直接结束任务 |
| `agent.reconnectMinMs / reconnectMaxMs` | 1000 / 30000 | Web平台级；0<min≤max | 下次控制重连退避 |
| `agent.reconnectJitterRatio` | 0.2 | Web平台级；0至1，抖动后等待仍封顶 | 下次重连 |
| `agent.transferTimeoutMs` | 120000 | Web平台级；正值，不占用长轮询连接 | 后续附件/结果请求 |
| `agent.transferRetryMinMs / transferRetryMaxMs` | 1000 / 30000 | Web平台级；0<min≤max | 后续补传重试 |
| `agent.transferMaxAttemptsPerCycle` | 5 | Web平台级；正整数；本轮耗尽转待补传，不能丢结果 | 新一轮传输 |
| `agent.transferRetryCycleMs` | 60000 | Web平台级；正值；停止服务后待传记录仍在 | 下一补传轮次 |
| `agent.inputCacheBytes` | 1073741824（1GiB） | Web平台级；至少能容纳单任务输入；并发准入扣除已预留输入 | 新准备任务 |
| `agent.pendingResultBytes` | 268435456（256MiB） | Web平台级；大于故障预留+至少一份报告预算 | 新准入及待传写入；已有记录不因调小删除 |
| `agent.faultReserveBytes` | 1048576（1MiB） | Web平台级；按maxConcurrentJobs为每任务至少保留1024 bytes最小故障信封，包含在待传预算内，普通结果不可占用 | 容量准入 |
| `agent.minFreeDiskBytes` | 536870912（512MiB） | Web平台级；另加未完成任务的已承诺空间预留 | 新准入和写入前复查 |
| `policy.maxQueuedJobs` | 全局1000、代理100、项目50 | 对应管理员范围；下级不大于上级适用额度；仅排队项计数 | 提交准入，调小不删队列 |
| `policy.queueTimeoutMs` | null（不因等待自动到期） | 项目默认可继承；null或正值；容量仍有限 | 提交时固定，不影响执行期限 |
| `policy.defaultJobTimeoutMs / maxJobTimeoutMs` | 1800000 / 86400000 | 工作区/项目策略；默认≤最大值，单次运行≤实际策略最大值 | 启动前固定；启动后不随策略改值 |
| `policy.cancelGraceMs` | 5000 | 工作区/项目策略；正值，不得超过任务可用收束预算 | 开始运行时固定 |
| `policy.snapshotBytes` | 67108864（64MiB） | 工作区/项目额度，受部署/网关能力约束 | 新快照 |
| `policy.singleAttachmentBytes` | 67108864（64MiB） | 工作区/项目额度；≤任务合计输入 | 新上传/准备 |
| `policy.totalInputBytes` | 536870912（512MiB） | 工作区/项目额度；含快照和本任务所需附件 | 新任务准备并预留 |
| `policy.maxAssetChangeFiles` | 2000 | 对应管理员策略；新项目资产原子变更接口的文件数，不改变旧batch接口语义 | 新资产提交 |
| `policy.bodyPreviewBytes / valuePreviewBytes` | 65536 / 4096 | 项目证据策略，沿用Core预算含义 | 开始运行时固定 |
| `policy.caseEvidenceBytes / reportBytes` | 262144 / 16777216 | 项目证据策略；value/body≤case≤report，report至少1024 bytes容纳完整故障信封，受宿主可用额度约束；降级后仍检查完整实际字节，不扩大固定预算 | 开始运行时固定 |
| `policy.workflowMetadataBytes` | 4194304（4MiB） | 项目证据策略；≤报告总预算，真实预算贯穿Core而非只限制最后上传 | 开始运行时固定 |
| `policy.resultRetentionDays` | 30 | 工作区/项目；正整数；缩短时提示清理影响 | 只清理已归档且无活动引用的结果 |
| `deployment.auditRetentionDays` | 90 | 平台策略；正整数 | 有界清理已完成审计记录 |
| `deployment.cleanupIntervalMs` | 3600000 | 部署级；正值 | 后续清理周期；不创建外部自动化 |
| `deployment.cleanupBatchSize` | 100 | 部署级；整数1–1000；结果和审计各自有界 | 每周期最多回收此数量的结果及审计，不删除去重身份 |
| `APICC_AGENT_TMPFS_SIZE` | `4g` | Compose部署；父子共用`/tmp`容量上限，非预占内存；需匹配实际内存及输入/并发额度 | 重新部署；不低于磁盘地板及父子暂存预留 |
| `deployment.enrollmentTtlMs` | 86400000 | 平台登记策略；正值 | 新登记凭证；不能延长已撤销身份 |
| `client.statusRefreshMs` | 2000 | 客户端设置；整数 1–2147483647 ms，与实际宿主定时器上限一致；仅可见活动任务刷新 | 后续状态请求；隐藏/切页停止 |
| 接口连接/响应/总超时、重定向和正文额度 | 复用现有 `RequestSettings` 默认值及校验 | 客户端项目/用例/单次运行；不新增第二套请求配置算法 | 单次运行固定 |

同层更新使用 `expectedVersion` 乐观并发；冲突不覆盖其他管理员修改。配置持久版本递增，代理报告 `appliedConfigVersion`；部分字段需重启时分别显示，不能“已保存”就冒称全部“已应用”。涉及本机文件路径、主密钥及代理身份凭证的部署值不在普通Web视图回显原文。

具体实现仍须遵守真实宿主边界，例如单次Node定时器的取值范围；长任务期限用单调时钟截止时间和分段等待，不把超长值直接传给溢出的setTimeout。调整预算也不等于已经测得能承载该规模。

脚本批准不是可自由填写的配置字典。有效项目OWNER/ADMIN在Web项目管理页维护：`scope`（单脚本版本/整个项目）、代理ID、脚本ID及内容摘要集合（单版本模式）、授予者、批准版本和撤销记录。默认采用单脚本/单版本；整个项目必须显式风险确认，覆盖该项目后续修改，不伪装成版本批准。一次任务的实际脚本清单必须全部满足批准，节点也必须允许 `trusted-core`；任一条件不满足在第一条目标请求前拒绝。导入资产不能携带可自动生效的批准，编辑权限不能自行授予。它是本阶段远程派发准入，不是DEF-001延期运行时授权集成的完成证明。

## 3. 资产与身份

新的在线可执行项目采用 `contract-files-v1` 存储标记：服务端前缀为真实数字项目实体ID，前缀之后复用Core现有项目相对文件格式。`api.yaml`保存ApiContract，`design.md`保存文档，`cases/index.yaml`与独立用例文件保存用例；环境/工作流在现有 `project.yaml`，模型/组件/数据集/套件沿用现有路径，不发展第二套定义。

服务端项目实体ID与契约UUID分别保存映射，不改写契约引用为数字ID。Core新增项目级内存文件编解码入口，复用现有 `contractFiles.ts` 解析和语义诊断；准备运行不迁移/覆盖用户当前本地工作区，也不要求落一个可编辑的临时项目。

旧在线整份ApiAsset或缺少元数据的内容保留原文，不自动覆盖、删除或猜测生成语义；显示不能执行的具体原因。用户可从客户端显式将现有有效本地项目发布到一个新在线项目。旧数据自动迁移和旧版ApiDefinition兼容不纳入本阶段。

新资产保存使用独立的项目原子变更接口，携带期望项目版本和变更/删除文件集合，在一个数据库事务中完成；旧通用batch的逐文件部分成功语义保持不变。快照在一致性事务内捕获完整文件/版本/hash集合并持久保存字节；Core发现不完整引用或无效定义则在第一条目标请求前拒绝。

身份字段：

```ts
type ServerProjectScope = { workspaceId: string; groupId: string; projectId: string };
type TaskTarget =
  | { kind: 'debug'; invocation: import('@apicc/core').DebugInvocation }
  | { kind: 'suite'; suiteId: string; datasetId?: string; allowDraft: boolean }
  | { kind: 'workflow'; workflowId: string; inputs?: Record<string, import('@apicc/core/schema').JsonValue> };
type ExecutionLocation = { kind: 'local' } | { kind: 'agent'; agentId: string };
type ScriptRequirement = {
  scriptId: string; contentHash: string;
  source: { filePath: string; fileHash: string };
  kind: 'pre' | 'post' | 'condition';
};
type TaskEnvelopeV1 = {
  protocolVersion: 1;
  jobId: string;
  executionId: string;
  scope: ServerProjectScope;
  submittedByUserId: string;
  contractProjectId: string;
  snapshotId: string;
  manifestHash: string;
  target: TaskTarget;
  debugSessionId?: string;
  environmentId?: string;
  policyVersion: string;
  requiredCoreBuildId: string;
  executionProfile: 'no-script' | 'trusted-core-script';
  dispatchKind: 'shared-debug' | 'dedicated-task';
  scriptPlanDigest: string;
  scriptGrantVersion?: string;
  requiredCapabilities: readonly string[];
  runtimeCompatibilityId: string;
};
```

该代码是契约结构示意，最终Zod Schema须使用现有Core公开Schema，不能对业务入参只作TypeScript强转。任务ID、执行ID、提交意图ID、快照ID及消息ID是不同身份；Java新增实体遵循数据库BIGINT/JSON字符串约定，Core业务定位保持UUID。`requiredCoreBuildId`使用实际执行实现源清单指纹，由构建生成；不能只看全部包共用的0.1.0版本号。

`scriptPlanDigest`由Core实际选中依赖的有序脚本身份/内容及条件清单生成，连同所需内置插件能力绑定快照；无脚本也有可复核的清单摘要。服务端/宿主重新校验这些字段，不能相信客户端自报。`shared-debug`仅允许kind=debug、profile=no-script且依赖全部满足共享资格；其余均独占，未批准脚本不能静默改档。`scriptGrantVersion`仅受信脚本必填，启动许可须绑定核对。运行记录同时保存Node/V8实际版本、脚本API身份和兼容档位；兼容清单来自T11受控联验，未知组合不凭版本号相近放行。

`ScriptRequirement.scriptId`是Core资产ID与操作/条件逻辑定位构成的稳定键，不用显示名或行号充当身份。客户端提供的是准备声明；代理取得固定快照后由同一Core重算实际清单，在start-request中上报；Java只核对受权快照/文件hash、批准记录和代理身份，不复制Core依赖解析器。摘要和声明不一致先拒绝/重新准备，不能接受代理只报“已批准”布尔值。

`debugSessionId`仅用于显式调试会话，scope及 `submittedByUserId`由后端按真实授权主体填充，不能由成员自选他人身份。首个调试未指定时新建会话，句柄由运行元数据返回；后续带句柄必须匹配服务器/工作区/项目/owner/代理。宿主在内存中复用Core HttpSession，经限定IPC提供既有会话操作；worker回收不清空Cookie，共享/独占调试可以使用同一授权会话。过期/服务重启后旧句柄在目标请求前明确拒绝，用户可显式开始新会话；套件/工作流不接受该调试句柄，Cookie值不进入快照或普通报告。

## 4. HTTP与任务协议

以下路径均位于 `/api/v1`。成员端与代理端使用不同认证主体；代理身份仅能操作分配给自身的任务，不能借用户令牌或获得任意项目文件读取接口。

| 接口组 | 具体入口 | 主要约束 |
| --- | --- | --- |
| 平台代理管理 | `GET/POST /agents`、`PATCH /agents/{id}`、`POST /agents/{id}/revoke`、`POST /agents/{id}/enrollments` | 平台超管；登记凭证单次显示，存储摘要，过期/撤销拒绝；不记录原值 |
| 工作区授权 | `GET/PUT /agents/{id}/workspace-grants` | 平台超管；授予工作区池，不授予项目数据读取 |
| 工作区分配 | `GET /workspaces/{ws}/available-agents`、`PUT /workspaces/{ws}/agent-project-allocations` | 工作区OWNER/ADMIN分配；只在已授权池内 |
| 项目代理与策略 | `GET/PUT /workspaces/{ws}/projects/{project}/execution-settings` | 查询按项目可见性；写按有效项目OWNER/ADMIN，不能扩大工作区分配 |
| 项目执行代理投影 | `GET /workspaces/{ws}/projects/{project}/execution-agents` | 先核项目可见性，仅返回本项目仍满足工作区授权、项目分配与项目关联的代理；普通项目执行者可读，不扩大平台或工作区管理权限 |
| 项目远程脚本批准 | `GET/PUT /workspaces/{ws}/projects/{project}/script-grants` | 有效项目OWNER/ADMIN授予/撤销，PUT带expectedVersion；限制到本项目已关联代理及脚本版本/显式项目信任；不授予主机API或密钥管理权限 |
| 项目原子资产 | `GET/PUT /workspaces/{ws}/projects/{project}/assets` | GET完整清单与文件；PUT带expectedVersion及delta，EDITOR+；作用域由后端实体确认 |
| 快照/本机材料 | `POST /workspaces/{ws}/projects/{project}/execution-snapshots`、`POST /execution-snapshots/{id}/local-materials` | 最新执行权限；只返回当前用户有权使用的材料，凭据不混入普通快照 |
| 附件/项目凭据 | `/workspaces/{ws}/projects/{project}/attachments`、`/workspaces/{ws}/projects/{project}/credentials` | 专用上传/引用/状态/删除接口；凭据值通过专门授权解析入口交付，不提供通用列表明文 |
| 成员任务 | `POST/GET /workspaces/{ws}/projects/{project}/jobs`、`GET /jobs/{id}`、`POST /jobs/{id}/cancel`、`GET /jobs/{id}/report` | 提交意图去重、固定目标；详情/结果重新鉴权，不泄露其他项目任务 |
| 代理登记 | `POST /runner/enroll` | 仅凭有效短期登记材料交换代理身份；不是公开注册管理员或成员会话 |
| 代理控制 | `POST /runner/poll`、`POST /runner/heartbeat`、`POST /runner/messages` | 代理主体；领取、开始、取消确认、完成摘要/结果确认是业务消息，不从HTTP成功推导 |
| 代理数据 | `GET /runner/jobs/{id}/inputs`、`POST /runner/jobs/{id}/materials`、`PUT /runner/jobs/{id}/report` | 核对agentId/executionId及当前分配；独立于长轮询连接；摘要与内容校验，补传幂等 |

`execution-agents` 是项目执行者的只读运行投影，不是管理接口的替代权限。响应包含默认代理、项目权威策略及版本、脚本管理权限提示，以及关联代理的运行身份、在线/陈旧/撤销等可用状态、配置已应用状态、脚本许可与批准版本/范围。它不返回登记令牌、管理密钥、凭据值或全局部署配置；脚本批准写入仍只允许有效项目 OWNER/ADMIN。投影为当前状态，实际提交和开始前仍须重新鉴权及检查固定输入。

传输接口由代理宿主依赖：

```ts
interface AgentControlTransport {
  exchange(input: { sessionId: string; appliedConfigVersion: string;
    availableSlots: number; availableSharedDebugSlots: number;
    acknowledgements: string[] }, signal: AbortSignal): Promise<ControlBatchV1>;
  send(messages: readonly AgentMessageV1[], signal: AbortSignal): Promise<{ acknowledged: string[] }>;
}
type ControlBatchV1 = { deliveries: TaskDeliveryV1[]; commands: AgentCommandV1[] };
type TaskDeliveryV1 = { messageId: string; task: TaskEnvelopeV1 };
type JobMessageIdentity = { messageId: string; jobId: string; executionId: string };
type AgentCommandV1 =
  | (JobMessageIdentity & { kind: 'cancel'; reason: string })
  | (JobMessageIdentity & { kind: 'start-rejected'; reasonCode: StartRejectionReason })
  | (JobMessageIdentity & { kind: 'start-permit'; permitId: string; policyVersion: string;
      effectivePolicy: Readonly<Record<string, number | string | null>>;
      scriptPlanDigest: string; scriptGrantVersion?: string;
      executionProfile: 'no-script' | 'trusted-core-script'; runtimeCompatibilityId: string;
      credentialVersions: Readonly<Record<string, string>> })
  | { messageId: string; kind: 'apply-config'; configVersion: string;
      config: Readonly<Record<string, number | string | boolean | null>> };
type AgentMessageV1 = JobMessageIdentity & (
  | { kind: 'accepted' }
  | { kind: 'start-request'; inputsDigest: string; policyVersion: string;
      scriptPlanDigest: string; scriptGrantVersion?: string;
      scriptRequirements: readonly ScriptRequirement[];
      executionProfile: 'no-script' | 'trusted-core-script'; runtimeCompatibilityId: string;
      credentialVersions: Readonly<Record<string, string>> }
  | { kind: 'started'; permitId: string; startedAt: string }
  | { kind: 'progress'; sequence: number; phase: string; observedAt: string;
      completedRequests: number; failedRequests: number }
  | { kind: 'completed'; verdict: 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted' | 'rejected';
      finishedAt: string; executionReleased: true; evidenceComplete: boolean;
      reportHash?: string; reportBytes?: number; reasonCode?: string }
  | { kind: 'cancel-confirmed'; finishedAt: string; executionReleased: true; evidenceComplete: boolean });
```

配置和策略Record字段在T1分别按第2节字段清单实现strict Schema，不接受任意字典直接驱动运行。线上Schema按kind收窄命令/阶段/完成摘要；文件、凭据和报告不放进控制消息列表。`start-request`确认只表示消息已入库，后端持久启动许可后通过控制批次投递 `start-permit`；丢确认重投同一permit，不能将ack直接当作启动许可。将来长连接只替换transport装配，不修改业务调度/幂等及Core。

`POST /runner/messages` 的正文为消息根数组。对格式、固定输入和当前分配身份验证通过后的确定启动业务拒绝，失败许可事务先回滚，再在短事务重锁同一分配；仅无已发permit及无冲突receipt时持久`start-rejected`和消息receipt后ACK。同身份/内容重试返回原决定，并发已发permit或receipt不覆盖、不收回。`StartRejectionReason`是strict安全码集合：`submitter_unavailable / forbidden / project_forbidden / agent_unavailable / agent_not_associated / script_mode_denied / script_grant_missing / script_grant_changed / credential_version_conflict / credential_missing / policy_changed / agent_capacity / shared_capacity / resource_capacity / debug_session_expired`。未知错误、身份/固定输入不符不转为业务ACK；HTTP错误只传安全结构化code，不传原异常秘密。ACK拒绝事实不是释放确认；代理不调用Core，实际清理后持久`completed(rejected)`，服务端收到收束确认才释放占槽。网络或ACK不确定仍按原身份对账，不能自动重放或静默重新准备。

成员任务的`canCancel`由后端当前有效权限和提交者身份计算；只有提交者本人或有效项目OWNER/ADMIN可取消，平台身份不自动越权。历史`scriptTimeoutMs`仅投影该任务持久permit.effectivePolicy中的实际值，缺失则未采集，不借当前策略补历史，不改已ACK报告字节。逻辑结论消费debug.error/failureKind、suite.verdict与Core.reportingUnits；物理case/请求计数独立保留。结果进入viewer前校验实际消费元素及嵌套结构，坏报告局部报错，不发布坏结果或崩整页。

`availableSlots`含准备预留后的代理全局剩余额度；`availableSharedDebugSlots`是其中可接受共享调试的数目，不能与前者相加，也不是进程数。服务端原子领取仍核对全局/项目额度及任务档位；局部worker忙不妨碍有全局余量时领取独占任务。每个执行批次的消息/账本身份独立于worker generation；内部IPC另带generation/executionId/scope，不用进程复用更改业务身份。完成/取消确认的 `executionReleased=true`只在调用收束清理、独占进程退出、或确定未启动后发送；此前保留finalizing进度/资源占用，报告上传可独立进行，不能先报释放再留下活进程。

## 5. 持久状态及失败边界

- 后端：任务、执行批次、提交去重键、接单/启动许可、待确认控制命令、结果摘要/归档状态和配置版本存数据库；队列等待不占用Java轮询线程等待业务执行。
- 代理：独立数据卷中记录执行意图、已接收命令和有界投影后待传结果；不保存普通快照中的认证原值。代理身份凭证以受限部署文件保存，不混入结果缓存。
- 控制服务原子执行 `queued → preparing → running → ended`，只有指定代理能够推进；重复相同消息返回同一确认，同身份不同内容拒绝。取消申请和报告上传另列状态。
- 启动许可丢确认可重新取得相同许可，但代理持久执行意图表明已经进入业务执行后不得再次调用Core。无法确认是否已执行则标记中断/待确认，不伪造恰好一次业务副作用。
- 已开始任务控制断线可继续到本地期限；未完整准备或未获许可不得开始。后端重启不换代理重跑；代理/执行进程崩溃不恢复Core内存，不自动重发目标请求。
- 每个调用有独立取消控制器、变量/提取状态、材料、凭据绑定/markers与证据；Cookie显式按服务器/工作区/项目/所有者/调试会话作用域延续，不能做进程全局Jar，也不能每次无条件清空破坏会话。共享进程内的Core调用不可共用运行可变状态。
- 普通共享调用取消不杀worker或其他调用；worker无响应/崩溃或调用无法收束时，终止整代并将全部受影响执行分别记中断/超时或待确认，保留已知请求事实，不自动重试。确认旧代退出前不创建新代；迟到IPC不覆盖新运行。独占任务不随共享worker故障一并结束。
- Linux容器采用进程组/init回收和子进程失去监督连接后的收束策略；不能只按历史PID或已发kill认定停止。准入资源释放必须有收束证据；若无法确认旧执行已停止，则不当作已释放容量或可安全重跑。
- 待传区先应用Core既有证据投影/脱敏，再写本地和上传。空间不足停止接新任务；未确认结果不会因保留期或重连轮数到期删除。缓存耗尽保留有界故障摘要并如实标不完整。
- 取消只有代理确认收束或确定尚未开始才显示完成。缩短超时/并发策略不改已开始任务，使用管理操作显式取消。
- 结果清理只处理已结束、执行已释放、已归档且无未ACK控制引用的过期payload。按当前有效结果保留期、归档保留锚点及有界批次回收BLOB和重输入，状态变为`expired`，授权下载返回410/`report_expired`，UI不再声明可下载。旧归档时间未知时在首次有界观察建立保守新锚点，重启不重置/倒推创建时间。审计按独立90天默认和同批次上限清理；公共snapshot不在此消费者删除。
- job提交去重键/intent_hash、任务身份、permit、消息receipt、完成/归档ACK摘要、报告hash及bytes持续保留。已过期报告重复上传仍先核实际内容hash/长度，再复用历史receipt，不恢复BLOB或改写ACK字节。代理未确认结果不受此服务端保留期回收。
- 本机显式调试会话同样按活动引用计数保护；只有最后release后才开始idle计时，启动其他调试不能驱逐仍在途的会话。

远程报告在main边界将已知output结构错误转为稳定`invalid-core-output`，IPC前缀下仍显示本地化失败原因，不把Schema issues JSON当主错误视图；未知错误不伪装成已知码。`report_expired`同样显示到期原因，普通expired状态不再触发下载。

## 6. 执行档位、受信脚本与版本

Core的 `CollectionRunner`、`validateSuiteExecution` 和 `CaseExecutionDeps` 已支持按实际依赖选择同一Core的 `no-script` 与 `trusted-core-script` 两种registry档位；v1工作流条件字符串仍属于引擎依赖。前者不装引擎，无脚本请求/声明式断言/提取及v2结构化条件正常执行，实际脚本依赖先拒绝；后者显式复用现有同步JS及pm API。不能装吞脚本的假引擎，也不复制一套代理脚本算法。

两种档位均仅注册内置且支持的协议/认证/断言/报告器；共享worker绝不调用自动带旧jsEngine的默认工厂。所选依赖含模块/目录继承前后置、用例脚本、子流程、onError/finally及v1条件，未选中的无关脚本不影响项目浏览。带脚本任务只进入已批准的独占进程，缺批准/缺能力在请求前说明定位与原因；不自动安装插件，不从脚本关键词猜测其安全或同步性。

当前同步pm API仅以Core现有类型和行为为准，包括变量读写、环境读取、请求/响应与assert；不承诺环境写入、任意npm库、完整第三方平台 API、通用网络/文件/进程API或Promise生命周期。脚本时限通过同一Core工厂按任务固定，原本未配置路径仍为3000ms；父进程期限和监督不等于安全沙箱。前置变量影响本次模板且直接修改pm.request不丢失的行为在共用Core验证/修正，禁止只修代理而让本机不同。

受信脚本可能接触授权请求/响应中的认证数据；输出投影在IPC/持久化前执行，但不能防止脚本主动外发。node:vm不是恶意代码安全机制；同OS账号子进程也不提供强租户隔离。只用于受信内部测试，互不信任域拆分部署；主密钥/代理控制凭证不作为任务输入。未实现异步支持、强安全隔离、延期运行时/密钥桥接均不得宣传为通过。

首版协议版本1（仍是未发布设计）；Core构建指纹、脚本API身份及能力由同一构建生成。快照固定输入，运行记录保存Node/V8及已验兼容档位，不匹配时提前拒绝。共同受控输入和响应下验证语义一致，不承诺真实远程网络、目标状态、时间/随机值一致；不提供自动升级。DEF-001仍无限期延期，此次受信脚本复用不是替代运行时准入或原安全专项闭合。

## 7. T7 装配接缝补充（2026-10-26）

本节将原有“完整材料、真实握手、会话重启失效”要求落实为可传输边界；属于未发布首版的实施细化，不表示已验证完成。实际字段以同源 strict Schema 和任务报告为准。

| 接缝 | 约定 | 固定或应用时机 |
| --- | --- | --- |
| 普通附件路径 | `materials.attachmentPaths` 可省略；是逻辑项目相对路径到已选 `refId/version/hash` 的映射，同附件可对应多个路径 | 随提交持久，进入固定 inputsDigest；每个落盘副本计预算。没有声明不能猜名或读取开发机文件 |
| 运行时握手 | 独立代理鉴权 `POST /runner/runtime`；报告当前 host session、协议、Core/script API 指纹、实际 Node/V8、兼容档位、能力及完整配置应用状态 | 真实登记后才领取/启动；配置保存版本、实际应用版本及待应用/需重启字段分别报告，不改变 poll/control 的严格边界 |
| 控制服务身份 | 部署 `apicc.execution.control-base-url` / `APICC_EXECUTION_CONTROL_BASE_URL` 为规范 HTTPS API base（含 `/api/v1`），不从 Host/Forwarded 或业务数据猜测 | runtime 返回服务端权威值供代理比对；未配置只拒代理准入。修改身份视为新 scope，旧会话不自动迁移；T11 配置并实证 |
| 调试会话授权 | 固定 inputs 可带现有 DebugSessionHandle 和 hostSessionId；范围沿用服务器/实体项目/提交者/代理 | 第一次 claim 事务绑定当前已登记 host 并最终固定 digest；queued 输入原本不可获取，业务快照/目标/材料不变。绑定后 GET/重投不改，新 host 不自动接管旧 Cookie 句柄 |
| 网络准备 | 提交及固定 inputs 可带 `network` 的 revision、Core NetworkConfiguration 与可选 NetworkSelection | 使用同一 Core Schema/prepareNetworkRun；网络凭据版本与请求认证版本合并核许可，私钥和口令仍走 SecretRef，不作为普通附件 |
| 有效策略 | 固定 inputs 包含服务端权威 `policy: PolicyConfig`，客户端不在 Submit 中提供该字段 | 与 task.policyVersion 一致并纳入 digest，首次 claim 最终固定，permit 重检。代理按实际值准备，父期限从原准入/准备的单调起点计，不在取得许可时重置 |

网络 Schema 原有绝对路径校验保持不变。在线公共证书路径使用虚拟声明前缀 `/apicc-declared/<logicalPath>`，这不是可直接读取的宿主路径：宿主先核对精确前缀及项目相对路径规则，再通过本次显式附件映射转换到任务自有目录。禁止按原配置绝对路径读取、不声明时回退、静默关闭 TLS 或忽略缺失文件；客户端和代理复用同一转换入口。无 network 项保持原有默认行为。

上述目录必须存活覆盖同一次 Core 调用的所有数据/上传/网络消费者。Task 7 交付真实执行装配；Task 8 另交持久意图、待传结果与故障恢复；两者不等于重新开启 DEF-001。
