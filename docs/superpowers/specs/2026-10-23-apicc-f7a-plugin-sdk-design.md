# F7a 插件 SDK V1 与扩展接入设计

日期：2026-10-23。F7a T1–T6实施与验收完成，尚未提交、合并或推送。逐任务独审、最终宽审与必要定向复审无开放承重问题；SDK真实tarball、仓库外作者、最终Windows包、真实包来源联验及root原生中英文/作者用例成败已验。全门禁范围由首次失败后的两处原测试夹具最小修正、定向补验和未到段续跑补齐，不能称单次test-all退出0。T2/T4历史RED偏差经用户确认保留，不追认为TDD。交付与AC01–12证据见主工作区`local/F7a阶段验收与交付记录-2026-10-23.md`及本计划SDD。基线 `66e617e816e8566717b547ee2cfe3f7470e638d3`，用户确认该提交CI已通过；本阶段尚无远端CI结论。

## 1. 目标和范围

交付独立 `@apicc/plugin-sdk`、可解释的版本准入与贡献注册，以及从生成插件到 CLI/桌面实际消费的闭环。插件管理页显示成功不等于运行入口已经接入。

四个工作包：A 独立 SDK 与公开 DTO；B 加载、命名空间与原子注册；C CLI/桌面及既有执行入口；D 脚手架、作者文档与实际联验。实施按依赖拆为六个任务，不按小步骤反复找用户确认。

本阶段覆盖断言、导入器、报告器，以及现有 HTTP/WebSocket/SOAP、bearer/basic/apikey 范围内的协议/认证扩展接点；不新建协议或认证的持久化种类。新增协议种类、通用存储插件公开契约、脚本引擎公开契约不属于本次 V1。Core 内部现有存储和脚本注册面不因此删除、重写或宣称安全验收完成。

不纳入 AI 增强、在线分享/同步、服务端执行器/调度、插件市场/自动下载、在线安装、热重载、进程外不受信插件平台。DEF-001 继续无限期延期；STRESS-LOW-001 到达率 B 仍不实施。普通校验、既有输出投影、取消和真实资源关闭保持。

## 2. 依据与当前差距

- 上位需求：[产品基线 EXT-101–103](2026-09-27-apicc-api-lifecycle-platform-requirements.md)、[插件专项第 3 节/PLUG-001–006](2026-09-27-apicc-plugin-api-and-script-security-design.md)。本设计仅落实非脚本 SDK 范围，不恢复该历史文档的延期脚本章节。
- 展示遵循 [页面规范](../../ui-presentation-guidelines.md)，不能用 JSON、内部码或翻译 key 代替主视图。
- `core/src/plugins/loader.ts` 当前先 import，再只检查 name/version/setup；没有 apiVersion、宿主范围和静态贡献清单。
- `core/src/plugin/registry.ts` 当前 Map.set/单值 storage 可覆盖，setup 直接写正式注册表，没有事务。
- `cli/src/create-plugin.ts` 生成物仍导入 Core；公开插件类型引用工作区、资源句柄、内部网络和资产上下文。
- 桌面插件摘要依赖包装 register* 旁路计数；桌面压测另建 default registry，需要消除“列出了但运行不用”的接线差异。

## 3. 方案选择

采用“独立纯 SDK + Core 适配器 + 静态元数据准入 + 暂存注册后提交”。SDK 不复制执行器，不把 Core 导出换个包名原样转出。

不采用只增加 apiVersion 字段的薄补丁：它不能解决内部类型泄漏、覆盖与半注册。也不采用先重写所有协议、存储和不受信插件隔离的方案：会扩大当前产品范围并重新依赖延期专项。

## 4. 三种版本与静态清单

SDK 包首版 `0.1.0`，插件协议 `apiVersion:1`；两者和插件自身 SemVer、宿主产品版本分别表达。宿主当前版本 `0.1.0`，来自组合根的产品 package.json，不把 SDK 版本或 API 主版本当产品版本；不为满足示例范围而抬高产品版本。

每个插件包提供不执行 JavaScript 即可读取的 `apicc-plugin.json`，例如：

```json
{
  "manifestVersion": 1,
  "id": "example.demo",
  "name": "apicc-plugin-demo",
  "version": "0.1.0",
  "apiVersion": 1,
  "engines": { "apicc": ">=0.1.0 <0.2.0" },
  "entry": "./dist/index.js",
  "capabilities": ["assert", "reporter"],
  "contributions": [
    { "kind": "assert", "id": "example.demo/assert.has-field" },
    { "kind": "reporter", "id": "example.demo/reporter.text" }
  ]
}
```

模块通过 `definePlugin({ manifest, setup })` 导出 plugin 或 default。模块内 manifest 必须与静态清单的规范化值一致；不能用模块内的新版本/贡献声明替换先前准入结果。npm package.json 的包名与版本也要和清单一致。

用户级 `.apicc/plugins.json` 保留字符串 source 条目，新增显式对象条目 `{source, enabled?, config?}`；字符串相当于 enabled=true、空 config。source 支持插件目录、静态清单文件和已安装包名。相对路径基于用户清单所在目录，不基于当前项目或 cwd；包名通过该用户目录的 Node 解析上下文定位已导出的 `apicc-plugin.json`。不安装包、不联网找清单。旧的只有 JS 入口/无清单的试验插件明确报 `manifest_missing` 并给出升级指引，不在发布前建立旧插件适配层。

元数据准入顺序固定：定位用户登记项 → 读 JSON → 校验清单、SemVer/API/宿主范围 → 校验能力/配置/贡献命名空间和冲突 → import 指定入口 → 比较模块清单 → 调用 setup 暂存 → 校验完整贡献集 → 原子提交。静态不兼容、未支持能力或贡献冲突时，既不 import 入口也不执行 setup；测试分别观察两者，而不只观察 setup。

版本范围使用标准 SemVer 判断，不手写字符串前缀比较；Core 可直接声明已有锁定依赖 `semver@7.8.5`，不得依赖未声明的传递依赖。预发布版本按该库默认规则处理，配置和诊断记录实际产品版本。API=1 内仅兼容增加可选能力，不改变字段原义；当前只接收 API=1，未来主版本兼容另行排期。

可选 `configSchema` 是 SDK 的纯数据对象表单：字段支持 string/number/boolean/enum，包含 required/default；对象仅允许声明过的字段。默认值先补齐再校验，number 必须有限，enum 候选非空且同为字符串；错误定位到字段。V1 不实现通用 JSON Schema 表单或新的密钥配置策略，config 只用于非敏感选项，不在插件列表默认展示其值。

## 5. 贡献 ID、选择和事务

插件 id 为点分小写命名空间；贡献 id 为 `<pluginId>/<kind>.<localName>`，kind 固定 `protocol|auth|assert|importer|reporter`，localName 只用小写字母、数字、点、连字符。`apicc` 及 `apicc.*` 保留。静态集合和 setup 实际集合必须完全相等，不允许漏注册、额外注册、同一贡献重复注册。

断言 op、报告 format、导入器 name 对外使用完整贡献 ID。内置旧名仍由 Core 自有注册表解析，不批量改写已保存资产；SDK 插件不能占用内置短名/命名空间。显示标签不是持久 ID。

协议/认证的派发键与贡献 ID 分开。为避免新增外部贡献悄悄替换内置行为，只有用户清单顶层 `bindings` 明确绑定才选用，例如 `protocols.http: "example.demo/protocol.http"`、`auths.bearer: "example.demo/auth.bearer"`。未绑定时保持内置；绑定目标必须已成功注册且声明支持对应现有种类。无效显式绑定在调用前报错，不静默回落为内置认证/协议。绑定属于用户本机配置，不写入 apicc 项目契约。V1 不做独立可视化配置编辑器，插件页只读显示已启用的绑定。

setup 只得到本插件的暂存注册面和已验证、脱离宿主对象的 config，不得到正式 registry、内部 workspace 或 IPC。setup 为同步；返回 Promise/thenable 明确拒绝，不为它增加异步初始化协议。setup 抛错、形状/集合校验失败或提交冲突时，正式贡献与绑定不变，贡献摘要不计失败项。注册面在 setup 结束后关闭；迟到注册不能修改正式表。静态预检和最终提交都检查冲突，以处理并发加载/复入时的变化；同一宿主默认按清单顺序串行加载。

catalog 是外部贡献的唯一正式来源：Core registry 的外部解析器读取 catalog，不能在 catalog 提交后再逐项 Map.set 安装，造成第二个半注册窗口。提交前准备完整适配器及派发索引，最后同步替换一个已验证 catalog 状态；内置短名表保持原样。绑定配置先校验结构，目标缺失只在相应调用准入时报错，不阻断其他无依赖功能。

原子性只涵盖平台注册状态，不声称回滚受信模块顶层或 setup 已产生的任意文件/网络副作用。V1 插件仍是用户主动登记、拥有本机用户权限的代码，不是安全沙箱；不能以 manifest/configSchema/DTO 声称限制了它的 Node 权限。工作区、导入文件、分享资产不能声明自动加载或安装插件。

## 6. SDK 与 Core 边界

依赖方向是 Core/CLI/Desktop → SDK；SDK 不依赖 Core、Electron、Pinia 或 Node 内部资源类型。SDK 主入口包含纯类型、`definePlugin` 和纯校验帮助；`/testing` 包含可在插件工程内运行的贡献契约检查，不把它依赖到宿主运行路径。

| 扩展点 | SDK 输入/输出与宿主适配 |
| --- | --- |
| assert | JsonValue 的实际值、原 expected、found/纯 options/可选 Schema 文档；返回 pass/message 和可选稳定诊断路径。模型只按 ID 取得脱离内部对象的只读 JSON 文档，不暴露 ProjectAssetContext 或 CompiledRegex。复用 F4 descriptor，使现有编辑器能列出插件断言。 |
| importer | detect 接受文件名/文本，parse 返回 `{formatVersion:1, project:JsonObject, diagnostics,warnings}`。project 是正式 apicc 项目文档，不是驻留工作区对象；由 Core 现有 ProjectSchema、引用诊断和 F3 merge/预览/撤销链校验后消费。SDK 不 re-export 内部 Project 类型。 |
| reporter | 接收输出投影后的只读 ReportViewV1：真实行总计、可选逻辑总计、请求事实、行/诊断和版本化扩展详情。逻辑通过与原失败行分开，缺失事实不补零。保持现有写文件并返回绝对路径的受信 Node 回调用途，不给予驻留 RunResult 对象。 |
| auth | 仅支持现有 bearer/basic/apikey 的显式用户绑定；接收本次请求 DTO 与原宿主晚准备的对应认证 DTO，返回 headers/query 补丁。headers 按原宿主的 HTTP 大小写规则合并覆盖，query 追加到已有有序参数，不提供删除/整表替换。补丁只能更新这两类字段，URL/正文/协议不由认证回调改变。不新增凭据读取、枚举、解锁或存储 API；不得把认证 DTO 写入诊断/列表。 |
| protocol | 支持现有协议的显式绑定，接收脱离内部对象的 RequestViewV1、signal 和宿主 transport 委托。V1 外部协议回调通过委托调用已有客户端，宿主继续拥有文件捕获、Cookie、网络准备、逐跳观测、计时和关闭；不公开 Undici、PreparedNetworkRun、HttpSession、凭据 Provider。没有新增任意协议 transport API。 |

协议 DTO 的 body 保持 json/xml/raw/form/binary/multipart 的现有含义；文件项只给本次捕获文件的 opaque ref 和显示元数据，不给内部 CapturedRequestFiles。transport 委托只解析本次已捕获 ref，继续用原上传/响应限制和关闭路径；不自动读取新路径。SDK 标准响应保留 status、headers、bodyText/bytes、文本可用性、timeMs 和可选字节事实；没有可靠事实时保留缺失，不伪造 HTTP exchanges。

协议回调返回的响应不能替换实际宿主 I/O 计时/逐跳计数为成功事实；实际观测及执行响应采用原 transport 的真实结果。每次协议 execute 必须完成恰好一次 transport 委托，零次/第二次委托以 contribution_invalid 拒绝；委托内部原有重定向仍按真实逐跳事实处理，不当作额外一次委托。V1 不借协议扩展增加辅助请求或伪造响应。请求门禁在真实 I/O 前，HTTP 耗时仍只计算原请求边界，插件回调耗时属于迭代开销。取消、重定向、连接池和每 VU Cookie 沿 F2/F6 路径，不再建第二套 HTTP 实现。插件回调可被并发调用，公开 context 含 run/VU 关联且不共享可变请求对象；需要改变此约定时由 root 先提出设计修改。

Core 适配器捕获函数引用，复制并校验数据形状；不把整个内部模型强转为 SDK DTO，也不为了 SDK 重构内置实现。公开 Schema/模型投影按本次固定快照缓存，不在每条压测请求复制整个项目。作者仍应把 V1 插件当受信代码，不承诺对恶意插件的进程隔离。

## 7. 宿主接入与运行身份

建立宿主级一次加载的插件 catalog，贡献定义与加载报告同源；移除桌面多层包装 register* 推导成功贡献的做法。无插件或关闭插件时只用内置 registry，旧调用不因缺用户清单失败。

Node host 工厂可选接收既有 `registry:PluginRegistry`，使 CLI 编程调用继续保留调用方注入的宿主能力；没有注入才创建默认底座，仍只有一个 catalog/registry 实例。worker replay 不接收该任意宿主注入，快照身份覆盖本设计的用户 SDK 插件而非所有内部宿主实现。禁用项的来源由同一次清单读取生成不含配置值的可选摘要；不能为页面再读清单或 import 禁用项，全局关闭仍不读用户目录。

Core 库不隐式读取真实用户目录：CLI/桌面组合根决定加载，MCP 的注入 registry 继续遵循现有显式调用约定，不为其新增自动加载/执行授权。CLI 的 `--no-plugins` 与编程关闭开关在任何 import 前生效。桌面“刷新”仅重取当前会话摘要，不热加载新代码；修改清单/版本/绑定须重启宿主，页面要说明。

调试、集合、套件、工作流、单用例/场景压测的断言解析共用 catalog；桌面压测不能再只创建不含用户贡献的 default registry。协议 transport 委托必须装配到每次运行/VU 的真实 managed client，不从全局单例偷用连接或绕过请求 gate。报告器按原支持的功能报告入口消费，F6 专用 JSON/HTML 压测报告仍走原报告链，不伪称新增了通用压测 reporter 插件协议。

普通 case 原路径只有显式 httpSession、没有运行级 managed transport：本阶段增加可选宿主 transport 输入，已有 run/VU owner 必须传原 client；仅当实际选择 SDK 绑定且没有该输入时，惰性创建现有 HTTP client 作为本次 case 的有界 owner，SOAP 复用既有委托适配，结束时只关闭本次自建 client。原 session/cookies、network/files/observer、重定向检查、signal/timeout 和 gate 保持；内置未绑定路径不变，不另建 HTTP 实现或 cookie jar。此默认 scope 为普通 case 粒度，不宣称跨 case 连接池复用；保留输入接缝供未来宿主级共享，而不在本阶段重构所有 runner 生命周期。WebSocket 沿用原单请求资源生命周期。

报告器的“原支持入口”具体为可按 registry 格式 ID 选择的 CLI collection/workflow 报告；套件计划与桌面选择器现有 html/json/junit 枚举不在本阶段扩成任意格式，不能宣称其中已能选择 SDK reporter。跨入口断言接入仍包含套件；SDK reporter 的实际输出投影闭环由上述可扩展入口证明。若后续扩套件格式选择，须单独调整该持久选择契约与界面，不偷偷借 F7a 改动。

本机多进程压测需要固定用户插件来源、规范化 config/bindings、插件 id/version/API、静态清单与入口文件摘要；作为内部配置传给既有 v3 prepare，worker 在 ready 前重核同一 catalog。缺失、禁用状态不一致或版本/入口变化给 `plugin_runtime_mismatch`，不以“单进程能用”代替多进程。内部配置增加必需 `pluginRuntimeVersion:1` 与插件身份字段，旧缺字段内部配置明确拒绝；外层 v3 frame、报告 v2、持久计划 v1 不变，不恢复旧 worker v2。

为把该稳定诊断送回父端，v3 failure 帧的 code 允许受控的 `worker-failed|plugin_runtime_mismatch`，结构/协议版本不变；仅确切身份错误透传后一种 code，其他异常仍统一 worker-failed，不发送原消息、配置或 stack。父端保留可机器识别的 code。该内部联动要求协调器和 worker 使用同一候选，不扩为任意错误透传或跨发布版本兼容承诺。

legacy 原失败路径仍返回退出码1和 numeric-only 不完整报告，不为诊断改成抛出异常。已识别的 prepare error.code 可在原 shardErrors 的 error 字段保留完整常量 plugin_runtime_mismatch；numeric-only 投影仅额外保留这一精确字面量，其余继续 worker_incomplete_rich_output_withheld，富证据和 marker 策略不变。不能从任意原消息按包含/前缀提取内容，也不新增报告字段或版本。

Core Node 内部增加重建入口 `createUserPluginHostFromSnapshot(expected, {hostVersion, importFn?})`，返回同一 UserPluginHost 形状。hostVersion 必须由当前实际组合根传入，不能从 expected 自证；不一致在 import 前以 plugin_runtime_mismatch 拒绝。只读取 expected 固定的绝对静态清单来源、规范化 config/bindings，不读取 worker HOME/plugins.json；读取时对照清单/入口摘要，重建身份确认前不允许使用 registry。该入口复用一次 memoized 加载与 `assertPluginRuntimeSnapshot`，T4 消费者仍在 ready 前显式核对。关闭模式也固定身份且不 import；此为内部重建接缝，不改变公开 SDK 或扩为完整依赖闭包锁定。

指纹不声称冻结插件全部 npm 依赖或其运行时外部世界；V1 没有第三方包供应链锁定平台。当前运行中不热重载 catalog；若用户修改插件，应结束运行并重启后再用。跨进程执行无关数据和凭据仍走现有私有通路，不放入插件公开摘要。

## 8. 页面与错误

插件页默认中文/随界面切换英文，用列表/表格展示名称、插件版本、API 版本、宿主兼容范围、来源、状态、贡献类别/ID和绑定。失败显示“实际值、要求值、失败阶段、可采取操作”；原始清单仅作默认折叠的详情，不展示 config 值或认证材料。

共用稳定 code：`manifest_missing|manifest_invalid|api_incompatible|host_incompatible|unsupported_capability|invalid_config|contribution_conflict|definition_mismatch|setup_failed|registration_closed|binding_invalid|plugin_runtime_mismatch|contribution_invalid`。SDK/CLI 可消费 code，页面有对应本地化文本；原异常沿既有输出边界处理，不把 stack 或对象 JSON 当用户提示。错误继续关联 source/pluginId/contributionId（取得时），重复显示名称不作为行 key。

单个插件失败不阻止无依赖功能和其他成功插件启动；用例引用了未加载的贡献或显式绑定无效时必须拒绝/配置失败，不能跳过断言或无认证发送。失败注册项不出现在可选断言/导入器/报告器里。

## 9. 作者工具与离线使用

`create-plugin` 一次生成 package.json、apicc-plugin.json、源码、SDK 契约测试、tsconfig、README。自动生成的 namespace 为 `local.` 加完整小写包名，避免每个新插件都沿用同一个演示 ID；例如 apicc-plugin-demo 得到 local.apicc-plugin-demo。点/连字符按现有包名规则保留，遇到不能形成合法 ID 的输入在写文件前拒绝。示例贡献为该 namespace 下的 assert.has-field 和 reporter.text，零 Core 导入，package exports 明确导出静态清单。上文 example.demo 是手写说明样本，不是生成器对所有名字写死的默认值。发布前不要求真实 npm 发布。

交付 SDK tarball 和示例的本地安装/构建/测试指令；用隔离临时作者工程消费 pack 结果，而不只验证 monorepo workspace 链接。加载前要求用户自行准备插件依赖；加载器无联网补齐行为。“离线使用”是依赖已准备后无需在线服务，不承诺一台没有 Node/构建依赖的新机器能凭一个 tarball 开发全部插件。

SDK `/testing` 检查清单/声明集、setup 注册结果、各类纯 DTO 形状和指定 fixture 的真实回调结果；不是只测字段存在，也不把插件回调放进新的不受信沙箱。

## 10. 验收矩阵

| ID | 必须满足的结果 | 最小证据/责任任务 |
| --- | --- | --- |
| AC01 | SDK pack 的主入口、声明、testing 入口可由外部作者工程消费，无 Core/内部宿主依赖 | T1/T5：包消费与实际编译 |
| AC02 | API/宿主不兼容、未知能力、静态冲突在 import/setup 前拒绝，兼容样本真实加载 | T3：复用 loader 夹具，观察 import/setup 副作用计数 |
| AC03 | 重复 ID/保留命名空间拒绝，原贡献保持 | T2：registry 原用例扩展 |
| AC04 | setup 中途失败、声明不符/异步 setup 后无残留，正常后续插件可用 | T2/T3：同一暂存事务夹具 |
| AC05 | 五类 DTO 的真实适配可消费，非适用数据明确诊断，不向插件泄漏内部宿主对象 | T1/T2：一组五类 fixture，不按排列扩矩阵 |
| AC06 | 缺用户清单、disabled/no-plugins、打开含插件字段的项目均不自动 import/install | T3/T4：原关闭/工作区夹具，零真实用户配置修改 |
| AC07 | 自定义断言真实参与调试/功能运行/场景/压测；多进程与父进程身份一致，不一致 ready 前拒绝 | T4：共用一份合成 fixture，重点覆盖桌面压测和真实 child |
| AC08 | 导入器经过 F3 预览/提交/撤销，报告器见安全视图；显式 auth/protocol 绑定实际参与一次 loopback 请求并保留取消/资源归属 | T2/T4/T6：已有测试扩展及低负载真实闭环 |
| AC09 | 桌面/CLI 名称、三版本、失败原因、贡献和绑定一致且可读，失败贡献不可被选择 | T4：既有 store/组件/IPC 测试和最终集中视觉检查 |
| AC10 | 生成→本地 pack SDK→外部安装→build/test→CLI/新包加载→执行真实贡献完整走通 | T5/T6：唯一作者工程和合成项目 |
| AC11 | 无插件时 F1–F6 默认行为保留，运行中的关闭、请求事实、逻辑统计与脱敏不退化 | T4/T6：受影响原用例和最终一次集成门禁 |
| AC12 | 文档、已验/未验范围、包与证据归档；DEF-001/B及在线增强不被静默带回或记完成 | T6：root 逐项核验与新包交付记录 |

不增加安全对抗矩阵、极端耗尽实验、长稳/高并发压测、所有协议/格式笛卡尔积或全页面快照。协议/认证以既有 kind 的一个代表性委托闭环加原有协议回归为主；不为每个标签新建测试。

## 11. 调度和完成边界

root 调度；独立 worktree 中 Sol high 开发，另一个 Sol xhigh 审核；需要 max 时先找用户申请。阶段内按已冻结任务连续推进，仅范围/公开接口重大变化、新授权、延期依赖或确切阻塞才找用户；说明已完成、未完成和需要用户做什么。

最终一次候选本地门禁按 SDK→Core build→Core 含测试 typecheck→其他包 build→包测试（串行/每包 2 workers）执行，Java 由同一整合门禁覆盖；随后唯一新 Windows 包/冒烟和集中新增交互手验。若用户要求合并后全量，则把这一次全量移到合并后，不在前后各跑一次。同源码已经通过的定向组不由审核者重复运行；必要修复后只复验影响面。

本设计不授予提交、合并、推送、npm 发布、操作真实用户插件清单或删除旧证据的授权。用户已在归档后另行确认整阶段开工；这不扩大上述授权边界。
