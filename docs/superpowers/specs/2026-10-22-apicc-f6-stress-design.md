# F6 可信开发阶段压测设计与验收规格

日期：2026-10-22。基线：`af71a2d30eb97c6cfd7d312995b0287c27a01e8d`，用户确认最新 CI 通过。

用户已批准 local《F6阶段设计与验收草案》的方案 A，并授权制定、归档整阶段实施计划。本规格固化该方案及实施所需的技术口径，**尚未授权产品实现或新的提交/合并/推送**。新增默认值与边界随整阶段计划一并交用户审阅，不逐任务重新审批。

后续授权（2026-10-22）：用户明确确认“完成F6任务”，已批准本规格及整阶段计划连续实施，解除上段开工等待；不授权提交/合并/推送，不恢复延期专项，不授权max模型或24h高压实验。

## 1. 目标与范围

在当前项目中，以接口用例或完整工作流为目标，提供固定并发、恒定到达率、多阶段负载、VU 生命周期、可解释指标、趋势、历史基线和离线报告。扩展现有压测引擎，共用执行、调度和聚合，不另建工作流引擎。

需求映射：完整需求 `STRESS-106/107/109`、`FLOW-008`；核心基线 `STRESS-003/004/005/006/008`、`WF-008`。已经交付的完整用例语义、连接、断言/提取、计时、错误分类、阈值、目标确认和生成器观测不得回退。

新增场景压测先支持完整 HTTP 叶子闭包及 F5 声明式控制节点；不支持的协议在准备时明确拒绝，包括生命周期场景里的叶子。普通 F5 工作流的协议范围不变，既有 CLI 单用例入口的协议行为保留；不以静默跳过替代兼容。不是远程分布式发压平台，保留并升级现有**本机**多进程入口。

## 2. 已核对的接点

- `StressRunner` 当前每 VU 一个 `StressWorkerSession`，返回单个 `CaseExecutionResult`；samples 全量保留，结束后排序。`maxRps` 是上限，不是开放到达率。
- `compileWorkflowPlan`、`workflowPlanRequests`、`validateWorkflowPlanData` 是已有准备 API；不存在 `prepareWorkflowExecutionPlan`。计划归属绑定快照对象，不能仅凭 revision 相同复用；现有 v2 root 每次调用重新编译。
- `CaseExecutionDeps.beforeSend` 已覆盖最终请求与重定向，但 CollectionRunner/WorkflowRunner 尚未完整转发。F6 补齐 v1、v2 和 child/handler 路径。
- `HttpSession` 只拥有 CookieJar，不拥有连接池；默认 registry 的 HTTP client 可全局共享。场景 VU 必须显式注入自己拥有的 managed client 和 Cookie session，不能把 fork Cookie 称为 fork 连接池。
- F4 已有私有 marker 并集/完成屏障及安全投影，F5 已有逻辑结论、真实请求事实及执行身份。现有 worker v2 传回全量 samples；需升级为有界指标协议，不能平均 shard p95。
- 桌面当前只存在内存压测表单，没有命名压测配置仓库。JSON 历史可复用，压测 HTML/趋势/基线需新增。

## 3. 计划、参数与版本

### 3.1 `StressPlan`（formatVersion=1）

纯数据字段由 `StressPlanSchema` 严格校验；只含配置、稳定引用和非敏感显式输入，不包含运行对象、输出值、私有 marker 或解密凭据。

| 字段 | 固定口径 |
| --- | --- |
| `target` | `{kind:"case",collectionId,apiId,caseId}` 或 `{kind:"workflow",workflowId,inputs?}`；均相对同一个项目 |
| `load` | `constant-vus {vus}`；`constant-arrival {rate}`（迭代/秒）；`stages {executor:"vus"|"arrival",startTarget,stages:[{id,durationMs,target}]}` |
| `maxVus` | 默认 1；新计划 1..1000。各并发阶段不超过该值；VU 池在测量前就绪，阶段降载不杀在途迭代 |
| `termination` | 常量负载至少 durationMs/maxIterations 之一，先到先停；arrival 必须有 durationMs；stages 时长唯一来源是阶段时长之和，可另设总 maxIterations |
| 时间/阶段上限 | 新计划测量时长不超过 7 天；阶段最多 32 个，ID 唯一；时长正整数，计数 safe integer，速率有限正数；积分计划槽计数须可用safe integer表达，上溢在准备时拒绝；阶段可有0目标，但整份计划不能全部为0 |
| 生命周期/节奏 | warmupMs/thinkTimeMs/pacingMs 默认 0；gracefulStopMs 默认 30000、范围 0..300000；单个 warmup/think/pacing 不超过 3600000ms |
| 请求约束 | maxRequestConcurrency 可显式配置，默认 `min(1000,maxVus×根场景并行上限)`，case 上限按 1；范围 1..1000；maxRps 仍为实际请求发起上限，不充当目标到达率 |
| 策略 | 复用项目 origin/确认/禁用/并发/速率策略。显式超过策略拒绝；缺省上限归一化后记录 requested/effective。不读取环境名称决定权限 |
| 其他 | environmentId、pooled/fresh、原请求阈值；可选生命周期引用；数据策略为 case `vu-round-robin` 或 workflow `node-selection` |

旧 CLI/`StressRunner.run` 参数通过兼容适配进入同一纯 `runStressSchedule` 内核；原正 safe integer/终止条件校验不擅自缩紧为新保存计划的 UI 上限，不保留第二套生产调度或全量 samples 路径。旧可注入createWorker接口不要求快照，不能为适配它制造假ProjectExecutionRun；新runStressPlan负责固定资产准备和报告装配，数字聚合独立于项目快照。

### 3.2 执行准备

`compileStressPlan(snapshot, plan)` 为纯预检，生成固定闭包/目标描述；宿主依此一次准备环境、凭据、网络与数据，再建立 `PreparedStressExecution`。准备与实际执行使用同一捕获快照对象。

新增 `PreparedWorkflowExecution` 与 `WorkflowRunner.runPrepared`，将捕获与编译放在创建句柄时执行一次；句柄归属通过现有快照所有权规则验证。普通 `run` 保留行为，不允许 renderer/worker 输入伪造编译句柄。各 worker 从固定定义版本和准备数据创建自己的句柄，不能跨进程序列化对象身份。

## 4. 调度、测量和停止

### 4.1 一个调度状态机

单进程直接执行 VU session，本机多进程把同一调度器的 session 替换成受控远程 VU 代理；**协调器唯一分配全局 iterationId、计划槽、阶段和预算**。worker 不独立发明一条到达率曲线或重复扣除总迭代预算。

- constant-vus：每 VU 同时最多一个迭代，目标是活跃 VU 数，不是 HTTP 并发；结束后等待 `max(thinkTimeMs, pacingMs-本次迭代耗时,0)`。
- constant-arrival：rate 为目标迭代/秒，不是 HTTP RPS；忙 VU 不重入，思考/pacing 期间也不可接新槽。无空闲容量或槽已过期则 dropped，不排队补发。
- stages：每段从上一目标线性变化到本段 target，hold 用相同起止值；vus 取向下整数，arrival 对线性速率积分生成槽。
- arrival 槽使用累计积分的半步位点 `n+0.5` 确定到期时间，仅纳入测量结束之前的槽。2026-10-23用户批准接入方案A，替代原严格1ms有效期：槽n的有效窗口为 `[due(n), min(due(n+1), 所属负载阶段结束, 本次发压窗口结束))`。每次唤醒至多接纳当前最新且尚未消费的有效槽；更早的槽批量计dropped，不排队、不突发追补，旧阶段槽不在新阶段补发。到点但无可用VU的当前槽立即消费为dropped，不能等VU空闲后重发。仅按序号/积分差计算，不能创建与时长或槽数成比例的队列。
- 到达槽准入决策保留每次运行可装配的内部策略边界，与既有clock/sleep等待机制分离；当前生产入口仅装配A。既有计划/报告/worker版本与请求门禁不变，不增加B的空实现、不可用UI选项或持久配置字段。B“严格1ms＋精细等待”仅列入低优先级需求池，未来单独排期与验收，不是F6交付条件。
- 计划总迭代上限针对正式计划槽，warm-up 不消耗该预算；报告区分 planned/started/completed/aborted/dropped、启动延迟及资源饱和。
- 项目/用户限流导致的等待单列 policy-limited，不能假记为事件循环/scheduler饱和；负载仍未达时如实报告，不偷偷突破限额来追目标。
- 非饱和完整窗口的实际启动率误差不超过 5%；不足 20 个计划槽时显示量化/样本不足，不伪称验证了 5%。有 dropped 的运行必须显著显示负载未完整达成，并阻止普通全绿结论。

### 4.2 时间轴

全程使用单调时钟推进，wall time 只用于展示。顺序为 setup→VU 就绪→warm-up→预热排空→正式测量→自然排空→teardown/资源关闭→输出。

warm-up 使用初始负载，不消耗正式阶段时长。预热排空也受 gracefulStopMs 约束；失败不得假装正式测量已开始。正式阶段从测量 t0 推进；迭代按**实际启动**归属阶段，不随完成时刻改写。请求时间桶按实际完成时刻记录，保留其源迭代阶段；排空请求进入明确的 drain 段，不改写结束时间或归属。

请求 RPS 继续使用合格完成请求数/实际单调测量窗口，窗口包含在途自然排空、不含 setup/teardown。报告另外展示计划发压窗口及 drainDurationMs；阶段桶的 RPS 用各自真实覆盖时长，不用完整运行分母。用户停止以停止时刻截断窗口，不用预定全长稀释失败。

同机 worker 在起跑前以 IPC 往返锚点映射单调时间到协调器时间轴，记录映射不确定性；超过当前桶宽一半时，时序标为不可可靠对齐，不能当完整趋势验收通过。请求本地 duration 不受时钟偏移影响。

### 4.3 取消和资源

自然到期/预算完成先不再起新迭代，最多 gracefulStopMs 排空；超时取消在途并标记 incomplete。用户停止/root 取消立即阻止新迭代、handler 和网络 cleanup，已在途接相同取消信号。允许本地资源回收，返回 finished 前不宣称已终结。

VU managed client、Cookie session、容器生命周期分别计所有权且 close 幂等。每 VU 串行执行；HTTP 池在该 VU 所有迭代之间复用，分支 Cookie 按 F5 fork。内核在标记 requestStarted/计请求时间之前取得协议并发与初始 hop 速率许可；仅等待许可就中止不能伪造已发送样本。协议执行 finally 释放并发许可；重定向在现有认证/最终URL校验后仅再取速率许可，不嵌套申请第二个并发许可。许可等待者至多 32000，取消移除等待者。不扩脚本权限。

不承诺强杀旧同步脚本或不合作插件。无法确认收尾时维持 stopping/未完成状态，不用显示层超时冒称安全结束。

## 5. 目标与生命周期适配

`StressVuSession.execute` 产出逻辑迭代结果；真实 case/request/http/node 观察进入聚合器，不把 `WorkflowRunResult` 强转成单个 case。

- 可选 `setup`/`teardown`：各运行一次的同项目 workflow，使用独立 run session；可选 `vuSetup`/`vuTeardown`：在 VU 自己的会话中各执行一次。自然结束允许有界网络 teardown，用户取消全部跳过新网络 teardown。主次失败都保留。
- setup/vuSetup 输出通过显式 output→input 映射复制；case 的运行时变量须为 string，workflow 须符合已声明输入。映射不匹配在开始发压前或初始化结果校验时明确失败；不做隐式对象转字符串。
- 生命周期字段固定为 `lifecycle:{setup?,vuSetup?,vuTeardown?,teardown?}`；每步 `{workflowId,inputs?,outputs?}`，`outputs` 为sourceOutput→主目标initialInput的字典，仅setup/vuSetup允许。每VU主目标初始化值依次合并target.inputs、setup映射、该VU的vuSetup映射，同名后者覆盖；生命周期调用本身只接该步显式inputs，不隐式注入所有前阶段输出。缺少声明输出或映射后不满足主目标输入要求时明确失败。
- case 保留容器 pre/post 与现有跨迭代变量/提取行为，数据每 VU 从第 0 行循环。workflow 每次 root 使用新局部 scope，只保留其 VU Cookie 和明确的初始化输入；不隐式回灌上次 root 的所有输出。
- workflow 节点沿用其全部选中数据行；不把所有不同数据源统一锁成同一行号。F5 request/loop/branch/retry/recover/finally 和 v1/v2 判定保持，旧 child 不获得不存在的输入能力。
- 场景压测逐真实 case 观察采样；非 HTTP 控制节点只产生节点/逻辑指标。聚合身份按 workflowId/nodeId 等稳定定义维度，失败样本保留 vuId/iterationId/invocation/visit/attempt/row。
- 运行时会话/输入/marker 属于宿主私有值，不能进入保存计划、报告配置或普通事件；输出继续走 F4 统一投影。

## 6. 有界指标、结论与报告

### 6.1 聚合约束

全局分开 `iterations`、`caseRows`、`requests`、`httpExchanges`。请求合格条件沿用 requestStarted/requestCompleted/非 aborted；场景完整耗时不进入 HTTP latency。

数值事件phase固定为 `setup|vu-setup|warmup|measurement|drain|vu-teardown|teardown`；预热排空仍属warmup，正式自然排空才属drain。宿主preparing/stopping/finished不是指标phase。新requests为started/completed/eligibleCompleted/failed，其中failed仅计合格完成请求中的失败；预I/O失败和aborted保留在caseRows/失败分类，httpExchanges为started/completed hop事实。缺少可采指标用available/unavailable判别而非填0，已有generator的partial及历史兼容保持；execution/metrics/load各自保留complete及有限机器码reasons。

直方图为固定 log 桶：最小正值 0.001ms、倍率 1.01、4608 个数值桶，0 独立计数，underflow/overflow 单列；每个直方图最多暂存前 256 个**数字**，未超上限时沿用 exact nearest-rank，超出即转桶，不保留原 CaseExecutionResult。桶值使用保守上界；正常范围相对误差≤1%，小于 0.001ms 明示绝对分辨率，溢出不声称精度。min/max/avg 累积计算，合并按计数/和/桶合并，不能平均 p95。

时间桶起始宽 1000ms，最多 120 桶；超过后全局宽度翻倍合并，保留实际分辨率。阶段最多 32；节点按编译闭包中稳定排序取前 512 个 `(workflowId,nodeId)`，其余进入标记 `other`，仍保留全局和其他节点汇总计数，不创建 invocation/row/URL 维度的无限 Map。桶只保留请求直方图，节点保留请求/节点时延；数值聚合容器总预算 64MiB，耗尽时明确标记指标不可完整采集，不捏造分位数。

一个时间桶可能跨phase和源阶段，保留有限sources计数而非只标一个stageId。阶段摘要与每桶sources上限69（32measurement、32对应drain、5个stageId=null的生命周期/预热phase），不是新增69个可配置负载阶段；不为所有组合预分配三类直方图。

固定错误类别保留，扩展错误码/状态分布最多 128 个键，多余并入 other。失败证据沿用最多 20 个样本及 F4 既有预算，先采 marker、再决定保留样本；成功正文和每次完整场景结果不累计。最终公开报告只含摘要/趋势/节点汇总，不携带直方图原始桶。

### 6.2 判定

case 逻辑失败仍失败；workflow 按最终根逻辑结论判断迭代，recover 后的成功不删除真实失败请求。未配置额外请求阈值时，workflow 不能仅因已恢复 attempt 失败而改写根逻辑失败；显式 maxErrorRate/maxP95Ms 等仍根据真实请求判断，可使整个压测失败。

setup/收尾失败、未通过阈值、逻辑迭代失败、无有效数据、worker 缺失、指标不完整、dropped 或中止不显示普通“通过”；分别保留 verdict、execution/metrics/load 完整性原因。CLI 非成功非零，UI/JSON/HTML 同口径。details 被有界合并的提示与执行数据丢失区分。

### 6.3 报告和配置

新报告 `formatVersion:2`，保留旧汇总字段的含义并增加 plan、目标/环境/定义/数据身份、iterations、caseRows、httpExchanges、phases、timeline、nodes、load、statistics、lifecycle、completeness。旧无版本报告保持可读，不补零伪造 F6 数据；未知版本明确拒绝。旧 `StressRunner` 兼容返回包含统计精度元数据，不能把桶结果冒充 exact。

命名配置存于 `.apicc/stress-plans/<scopeKey>/<id>.json`，scopeKey 为实际 root＋完整 ProjectLocator 的稳定散列，ID 由宿主生成；严格 schema、原子写入和 project 围栏，不改 ContractProject。`SavedStressPlan` 包含 formatVersion=1、id、name、updatedAt、plan；CLI 计划文件可为严格原始 StressPlan 或该保存信封，项目由独立 projectPath 参数定位。只保存可共享的引用/配置，任何运行确认都只属于本次运行，不随计划持久化成“永久已确认”。

JSON 历史、趋势/阶段/节点、基线比较、离线 HTML 与桌面一致。比较要求同项目；目标类型/ID、环境、负载、连接/数据/统计口径差异明示；revision 变化是正常回归输入，不因 revision 不同一律拒绝。旧/无数据/零基线的百分比为不可计算，展示绝对差而非 Infinity 或伪 0%。基线必须显式选择，不自动覆盖。

2026-10-23用户HTML手验后批准的展示修正：独立HTML默认简体中文并可页内切换English；配置、统计/时延、阶段/来源、节点、生命周期和失败证据以可读表格/详情展示，原始JSON默认折叠。数字格式/单位和缺失、不可计算、不适用须明确区分，长表局部滚动而非逐字挤断表头。趋势有坐标/图例，只有0或1个真实时间桶时说明限制、不伪造点。报告原数据/统计口径不变，业务JSON正文保留原格式，不依赖在线资源；复用已有真实报告和必要定向测试，不重新压测。

同日用户进一步批准的显示优化：摘要开始/结束时间使用保留毫秒的可读日期并标明导出端实际时区，HTML固化该显示、不随接收者时区重算，原始时间戳悬停可查；元数据definitionRevision显示名为“定义指纹”，长值默认短显、完整值可展开。原JSON及比较仍使用完整时间值和指纹，不改为自增序号，不新增发布版本体系。

实施澄清：桌面新报告由宿主以独立`<file>.scope`旁证绑定实际root、完整项目定位和最终安全文件内容SHA256，不污染共享报告。比较/导出核旁证和实际字节；旧无证明或搬迁root后报告仍可读，但不静默认领为当前项目。CLI显式文件参数不要求桌面旁证。“模型”在本节指负载模型及相关配置，不新增未采集的网络/契约模型指纹；同环境ID不证明定义内容一致。legacy已知无合格样本的RPS/p95在比较中不可计算，旧原始文件不被改写。

F2实施澄清：项目工作台通过`stressRunsList/Get`读取经同一旁证/fullscope/hash核验的历史，不能仅凭projectId或缺字段归入当前项目；未证明旧数据仍由全局历史阅读并在工作台明示。plan调用单独携带捕获root/invocationId，准备前核实际根并返回真实runId/generation、canonical root与已核sourceRoot，公开target不带inputs；UI完整核身份，停止/finished等待实际宿主收尾。配置迟到读取不能替换已捕获运行计划；近似统计有上溢时不承诺分位精度，下溢说明绝对分辨率。以上不改变保存plan/CLI raw plan、Core算法或延期范围。

## 7. 本机 worker 协议

运行协议升级为 v3，v2 与未知 worker 混用明确拒绝；旧报告的读取兼容不等于旧运行协议准入。保留现有定义/凭据版本/网络身份/准备数据校验、退出码一致性与私有 marker 屏障。

v3 控制消息分为 prepare/ready/start、execute/result、request-permit/release、stop/drained；runId、workerId、vuId、iterationId、stageId 由协调器赋值并校验。新的起跑 ready 不能复用 F4 **执行结束**的 marker READY。全局请求门禁与迭代预算在协调器，worker 不各自复制整个上限。

worker 只保留有界 case/http/node 聚合状态；iteration/load计数及iteration时延由协调器收到execute/result后唯一采集，不再从worker snapshot重复加入。进度为可替换的累计摘要（默认最多 4Hz），最终有界 snapshot 经 IPC 交接，按 sequence 去重合并，不把进度重复加进最终计数。最终直方图合并与阈值在协调器；任一缺失/重复或不兼容快照导致不完整，不能补零通过。内部指标单次传输最多 64MiB，分块收发，不能拼接无限 stdout。

marker仍只走已有私有通道；worker资源drained后，协调器完成自己的teardown（未取消时），再将所有worker与协调器setup/teardown的晚marker一并纳入UNION，最后才允许富公开报告。控制/指标与marker使用独立判别消息，不向argv/stdout/report搬运marker。运行中进度仅公开稳定身份、状态、数字和固定机器码，不广播业务文本/证据/setup输出来等待事后脱敏。停止需要worker实际drained/退出后终结；不扩远程agent/跨主机时钟同步。

## 8. 验收与工程约束

| AC | 验收 | 主责任 |
| --- | --- | --- |
| 01 | 同一 case 普通运行与一 VU/一迭代语义一致，连接/时间/失败不回退 | C |
| 02 | 多 VU 场景 Cookie/变量/数据隔离，root 一次迭代，无重复项目准备 | D |
| 03 | retry/OR/recover 逻辑与原始失败、节点/HTTP 事实同时正确 | D、B |
| 04 | 并发/到达率/阶段、5%窗口及 dropped/饱和诚实显示 | C、E |
| 05 | 预热/思考/pacing/生命周期不污染 HTTP 延迟或分母 | C、D |
| 06 | 自然结束/用户停止、迟到结果与真实收尾一致 | C、E |
| 07 | 大量合成数字证明有界、分位精度和可合并，不发百万真实请求 | B |
| 08 | 桶/节点/错误基数与溢出、降采样、完整性明确 | B、F2 |
| 09 | 本机单/多进程预算守恒、合并/阈值一致、脱敏通路保留 | E |
| 10 | 同配置/不匹配/零/旧报告比较和导出一致 | F1 |
| 11 | 当前项目配置保存重开、切页、运行/停止、报告滚动和基线可用 | F2 |
| 12 | 最终独审、必要门禁、新 Windows 包、隔离组合联验及集中手验 | G |

开发 GPT-6.1 Sol high、独立审核 GPT-6.1 Sol xhigh；max 必须另批。单开发写者、独立 worktree；用户确认整阶段计划后连续推进，仅实质变更、新权限/模型或真实阻塞时说明用户需要做什么。

Node 22.19.0、pnpm 11.21.0、JDK 21 根目录保持；不升级依赖、不扩 CI 范围。浏览器只导出纯模型/算法，Node/凭据/磁盘装配不能进入 renderer bundle。开发最小定向 RED/GREEN，最终一次 Core→CLI→Desktop 必要完整包门禁，包间顺序、每包2workers；同 tree 不重复全量、不加 timeout/skip 求绿。未改 admin/Java 不另起一套独立宽测，Desktop 原集成测试依赖保持。

保留 1000 连接配置表达和 24h 持续能力门槛；不在用户电脑自动跑 24h 高压，未有长稳证据时发布容量项明确开放，短跑/虚拟时钟不冒充长稳实测。

DEF-001 无限期延期，STRESS-108 相关脚本 Worker/授权专项不完成；不扩脚本能力、远程平台、F7、FLOW-007 断点/历史重放。F3 四项/F5 G-UI-01/02及旧冒烟 fatal 采样观察继续记账，不默认为 F6 必修或已修。
