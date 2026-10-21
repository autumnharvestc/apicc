# F4 测试与诊断中心设计

日期：2026-10-20，Asia/Shanghai。基线：main / origin/main `b5b88f68ae001a056d1c663d6861ffd728d42b77`；用户已告知 CI68 通过。用户审阅集中确认包后明确“确认，完成F4阶段”，本规格及配套计划现已**集中批准，进入实施**；此前“可以，开始吧”仅批准规划的历史解释不再作为实施阻塞。没有提交、合并或推送授权。

## 1. 目标与约束

用户需要本地可用、日常好用的 API 测试开发平台。本阶段把已有单接口用例、集合运行、基础场景与执行内核组织成测试闭环：可编辑和保存丰富断言/提取，复用项目数据，按套件回归，失败时直接看到证据，而非先写脚本或回机器重现。

沿用完整需求 TEST-101/104/105/106/107/108 及核心基线 TEST-001～005；不把其中涉及 AI、脚本、完整标准、趋势的整行需求全部标为完成。apicc 结构化资产仍是事实来源，不另建数据库中的第二套用例。

- 本地功能不依赖账号、网络服务、团队订阅或外部平台。测试中心绑定当前项目工作区；不从主页运行，也不提供跨项目目标选择。
- DEF-001 无限期延期，不恢复 QuickJS/WASM、替代 runtime、脚本权限/授权/密钥桥专项；既有受信脚本行为保持，不冒充新沙箱，也不静默跳过已有脚本。
- 新增的是声明式操作，不使用 eval、Function、脚本字符串或 JS 条件过滤器实现它们。现有工作流的历史条件行为不在本阶段重写。
- 沿用普通凭据加密保存、免主动解锁、宿主绑定和输出脱敏，不换存储策略。普通变量/数据集不是凭据库，不自动保存提取值为环境或项目配置。
- Node 固定 22.19.0；不升级 Electron、现有依赖或 CI 流程。唯一获准新增生产依赖为 `re2js@2.8.8`，用于新声明式正则；其余复用 zod、jsonpath-plus、xpath、xmldom、csv-parse 和现有组件。
- 开发使用 GPT-6.1 Sol high、独立审核 GPT-6.1 Sol xhigh；root 调度、核验和归档。沿用独立工作树，单产品写入者，不自动提交、合并或推送。

## 2. 现状与实施方式

本次只读核对发现：`domain/common.ts` 的 AssertionSchema 与 CasePanel 仍固定七种 op；运行注册表实际上已有 xpath，但不能经该 schema 正常保存。caseExecutor 的 JSONPath 只取首项，解析异常会变成 undefined；AssertResult 只有 pass/message。CollectionRunner 和 stress/caseSession 各自解析数据文件，校验及空数据行为不统一。Project 尚无 datasets/suites，RunResult 缺完整定位和证据。已有契约事务、快照、CaseLocator、debug 投影、报告和历史可复用。

采用 A：**渐进增强现有内核与测试导航**。A 单元补断言/提取，B 单元补项目数据与套件，C 单元补证据报告并统一交付。各单元有可验证产物，共享同一规格和最后阶段门禁。

备选 B 是重建通用资产中心/执行器，改动面和回归成本过大；备选 C 是只加界面、继续维持多份数据/断言逻辑，会继续造成执行差异。二者均不采用。现有大文件仅提取新增职责，不做无关全局重构。

## 3. 数据与接口边界

新增 browser-safe `testing/model.ts`，与 Node-only loader/runner 分离；`shared.ts`、`schema.ts` 只能导出纯类型/schema/元数据，不把 fs、keyring、HTTP 宿主带入 renderer。

- TestCase 增加 tags、extractors，未提供时统一视为空数组。新输入字段在公共类型上保持可选，集中规范化后供内部执行使用；不为了加字段批量重写无关用例/fixture。原七种断言与 requestOverride、scope、操作顺序保留；op 改为非空、有界字符串，结构保存不要求插件已安装，执行预检必须命中当前注册表。
- Assertion 保留 id/target/op/expected/headerName/path，增加 cookieName、namespaces、match（first/all，默认 first）和 options。expected 继续是字符串模板；新 typed 操作在模板解析后按各自约定解析 JSON，不改旧 eq/neq 等的既有字符串/数字比较。
- `AssertOperator.evaluate(actual, expected, context?)` 只增加可选第三参数；既有两参数插件照常调用。descriptor 为可选的纯数据元信息（目标、输入格式、是否需要 expected），无 descriptor 的已注册插件显示为手工配置项，不被 UI 或 schema 固定清单排除。完整插件 SDK/版本化仍属 F7。
- Project 增加 datasets/suites 两个空数组默认字段，公共输入类型同样可省略、加载/准备集中规范化。DatasetAsset/SuiteAsset 各有 formatVersion:1、UUID、名称；文件分别放在当前项目的 `datasets/<id>.yaml`、`suites/<id>.yaml`，project.yaml 保存顺序。顶层 formatVersion 仍为 1，此次是未发布产品的加法扩展；不恢复旧 ApiDefinition 迁移。
- 快照 revision 覆盖新资产，读写目录白名单、引用诊断、删除影响、跨项目克隆/导入的 ID 重映射均须包含新引用。外部格式不支持的测试信息继续明确诊断，不声称 OpenAPI 可以携带完整套件。
- 坏文件/新引用错误不能导致保存时静默丢弃字段。沿用当前只读诊断、revision 冲突和事务 journal；新资产保存失败不产生半套定义。

## 4. 断言与响应选择

统一 ResponseSelector：status、responseTime、header（不区分头名称大小写）、bodyText、bodyJson（JSONPath）、bodyXml（XPath）、cookie（本次最终响应设置的 Cookie，不是整个 jar）。选择结果包含 found、value、sourcePath；**缺失与 null/false/0/空字符串分开**。

JSONPath 首版支持属性、下标、通配及递归选择，禁用执行表达式的过滤和计算；不支持的语法明确 config 诊断。ResponseSelector 包含 match（first/all，默认 first）：first 取首个命中，all 返回有序数组；无匹配时 found=false，不用空数组伪造一个命中。XPath 复用当前依赖，支持显式前缀映射；格式错误/XML 不完整/未绑定前缀明确诊断。JSON/XML 解析按同一完整宿主响应缓存，不消费 UI 截断摘要；binary/不可靠文本/超限不伪造可解析响应。

新增操作的可保存、可编辑与运行语义如下；所有无效 expected/options 是 config，正常不匹配是 assertion：

| op | expected / options | 判断 |
| --- | --- | --- |
| exists / notExists | 不需要 expected | 仅看 found；明确 null 仍存在 |
| regex | expected 为模式；flags 仅 i/m/s | 对文本查找任一匹配，不隐式整串锚定 |
| length | expected 为非负整数文本 | 文本按 Unicode 码点、数组按元素计数；其它类型拒绝 |
| in / notIn | expected 为 JSON 数组 | 实际 JSON 值与候选严格深比较；不自动字符串化 |
| deepEqual | expected 为 JSON 值 | 对象键顺序无关、数组顺序相关，返回首个差异路径 |
| schema | options.schema 或 options.useContractResponse=true，二选一 | 验证所选值与同快照 SchemaNode；后者须 bodyJson 根值 |
| xpath | 沿用已有注册器 expected 语法 | 可经 bodyText 目标实际保存/运行；新 XML 字段选择优先使用 bodyXml |

原 eq/neq/contains/lt/gt/lte/gte 继续可用；missing 不因 neq/notIn 等反向操作误判成功，只有 notExists 可对 missing 成功。

Schema 只验证 apicc 已支持的 scalar/object/array/allOf/oneOf/anyOf/modelRef，以及 enum、required、additionalProperties；default/examples/description 不改变运行值。oneOf 必须恰好一个分支匹配。useContractResponse 按实际状态精确项→nXX→default 和实际 Content-Type（忽略参数、大小写归一）选定义，0 项或多项歧义报 config，不猜首个响应。模型引用来自该次不可变快照；诊断包含值路径和 schema 路径。**不宣称实现完整 JSON Schema/OpenAPI 全部关键字**。

新正则统一走 RE2JS 适配器，默认不启用 lookaround/反向引用等扩展，不承诺 JS RegExp 全语法；不支持的表达式直接诊断，不能悄悄回退原生回溯引擎。不新增脚本执行 Worker。编译结果按本次准备阶段缓存，不跨运行无限累积。

普通容量边界：每用例断言最多 256、提取最多 64；模式/路径最多 2 KiB、单次选择命中最多 1000。Schema 求值深度 64、访问节点 100000；超限明确失败，不对部分结果报通过。JSON/XML 从完整响应解析，原 F2 响应上限继续生效；不为此扩展对抗性故障矩阵。

## 5. 提取与变量流

ExtractionDefinition：id、name（普通变量名）、selector（复用响应选择）、method（value/regex）、pattern/flags/group/regexMatch（regex 时）、required（默认 true）、defaultValue（JSON 值，可选）、sensitive（默认 false）。value 按 selector.match 选择；regex 要求 selector.match=first 且选中单个文本，regexMatch（first/all，默认 first）控制模式命中，避免两层 all 隐式笛卡尔积。group 是非负捕获组编号、默认 0；未命中与选中组不存在都作为无值处理。

name 限普通变量名 `[A-Za-z_][A-Za-z0-9_.-]{0,127}`，不使用内置 `$` 前缀；同一用例不能重复目标。header Authorization/Cookie/Set-Cookie 及 cookie 选择的提取自动敏感；其它位置由 sensitive 和既有已知凭据标记决定。此规则只限定新增提取目标，不改动既有普通变量键保存语义。

执行顺序保持：容器/用例前置操作→请求→既有用例后置操作→**声明式提取**→断言→结果。一次用例中提取全部先计算，成功后原子发布；任一 required 无值则整批不发布，清除这些目标在运行提取层的旧值，避免后续读到上一次成功的残值。可选无值则使用显式 defaultValue，否则删除该提取层旧绑定、标记 absent；若同名低优先级配置仍存在则按变量层读取，并在预览说明。配置错误/缺响应不按 optional 跳过。若请求、既有脚本或取消已产生主失败，提取不提交并清理本批旧目标，结果注明未执行原因，不用次级提取错误覆盖原失败分类。

发布到本次执行的运行变量层，不写 YAML/环境/系统变量。字符串原样，其他 JSON 值转为紧凑 JSON 文本用于模板；all 转数组文本。变量优先级保持并明确为：本用例后置/提取写入 > 当前数据行 > 用例参数 > 之前传入的运行变量 > 环境 > 模块 > 项目；下一用例重新建立本地层。

集合内可传给后续用例；现有工作流通过 runtimeBridge 传给后续节点，不扩节点类型/条件引擎。并发运行、套件独立条目和数据轮次不共享变量；压测仅同一 VU 可携带，启动/关闭生命周期不变。

正常 required 提取无值新增 failureKind=`extraction`；格式/引用错误仍为 config，中止仍为 aborted。同步扩展工作流聚合、压测计数/当前报告校验、CLI 和 UI 标签，历史报告缺 extraction 计数按 0 读；不改变计时窗口、成功口径和压测算法。失败不能因 HTTP200 被计业务成功。

## 6. 项目数据集

DatasetAsset 保存 columns（有序、不重复的非空字段名）与 rows（记录数组，值为 JsonValue）；内联表格编辑、CSV/JSON 导入、预览及导出。CSV 单元为字符串；JSON 对象值保持原类型，进入现有字符串变量系统时字符串原样、其它值 JSON.stringify，不偷偷转成空串。空单元、缺字段和 null 不混同；缺字段不覆盖低层参数。

CSV 支持 UTF-8/BOM、标准引号和换行；重复/空列名、非对象 JSON 行、超列或坏编码均报具体行列错误。JSON 只接受记录数组，不执行远程 URL 或表达式。新数据集为空是可保存草稿，**被选择运行时拒绝**，不退化为一次无数据请求。新增数据容量上限：源内容 10 MiB、10000 行、256 列，单格编码后 64 KiB；表格分页，预览最多 100 行。

TestCase.dataDriver 支持新增 `{kind:'dataset',datasetId}`；保留已有 sourcePath/format 文件引用，二者互斥，复用同一解析和行校验。相对文件路径从 workspaceRoot 解析，绝对路径仅作为显式本机文件引用；导入不自动追读或复制来源文件。原文件分支的空数据退化行为为既有语义，本轮保留并显示 legacy-empty-fallback 提示；新项目数据集不继承它。文件数据值继续要求字符串，不以新数据集的类型转换悄悄改变旧文件分支。

运行准备阶段一次读取被选择的外部文件，固定内容摘要和行快照；集合、现有场景节点、桌面单用例、CLI、压测都消费 PreparedTestData，不按每 VU 重读文件。运行中编辑、替换或删除数据不会改变已启动运行，下一次读取新 revision/摘要。

普通用例/集合/场景节点按行序运行全部行；压测沿用每 VU 从行 0 顺序循环，单迭代读取一行，报告记录真实行号。并发分配、共享游标、随机取行等新模型留 F6。报告内部 0 起始、界面 1 起始；一个数据行也保留数据源和行身份。

## 7. 套件、选择集和执行

SuiteAsset 保存名称/说明/标签、selection、environmentId（可选）、datasetId（可选）、failFast（默认 false）及报告格式偏好。selection 二选一：显式有序 entries（逻辑用例引用或已有 workflowId），或 query（模块/用例标签筛选，仅选择用例）；不混用两种顺序，也不允许套件嵌套。

逻辑用例引用含 collectionId/folderIds/apiId/caseId；环境按现有继承规则解析实际 scope，再应用标签筛选。不同筛选维度取 AND，同一 tags 列表取 OR；显式引用重复拒绝，query 按项目模块/目录/接口/用例顺序稳定去重。不能从同名资产/别的项目补齐缺失引用。预览展示解析后的条目、scope、行数及预计调用规模，运行冻结该选择集。

新增 suite runner 只调度现有 CollectionRunner/WorkflowRunner，不造第二套用例执行器。首版串行，不做并行/重试/定时/依赖图；不同条目及外层数据轮次的变量和 Cookie 会话独立。需要“登录→业务”的有序共享状态必须放在同一现有场景内，不能靠套件顺序隐式传值。

套件指定 datasetId 时，外层按每行依次运行所有条目；该次选择到的任何子用例若已有 dataDriver，在发送前整套拒绝并说明冲突，**不隐式做笛卡尔积或覆盖**。没有套件数据集时保留各用例数据行策略。总预计 executeCase 次数最多 50000，超限预检拒绝。

开始前验证全部条目/环境/数据/断言/模型引用及现有工作流结构；空选择集、悬空引用或未注册 op 都非零失败且零请求。纯选择解析不读文件：先 resolveSuitePlan 确定完整选择，再 prepareTestData 读取所选内容，最后 validateSuiteData 计算实际行数和 50000 次上限；preview 与 run 共用这些阶段，preview 可读取显式选择的数据文件，但不解析/绑定真实凭据、不刷新认证、不发请求。套件中 draft 场景默认拒绝，用户本次显式允许后可运行并记录；不自动发布。failFast 只阻止后续条目/外层轮次，当前条目的内部 failFast 也传入现有 runner；停止原因及未执行计划项以 skipped 明示，不冒充通过。取消在请求和条目边界传播，资源按原拥有者关闭。

结果保留 suiteRunId、entryId、suiteRow、真实 CaseLocator、scope、case row、nodeId 和 definitionRevision。SuiteRunResult 是独立 envelope；通过 suiteToRunResult 映射到已有 reporter 的 RunResult，并附可选 suite 元数据，旧 collectionId/name 仅作为兼容聚合容器标签，不伪称真实模块。跳过条目不制造虚假 HTTP 用例，通过/失败/跳过的条目计数与实际 case-row 计数分别展示。

CLI 增加 `test list`、`test preview <suiteId>`、`test run <suiteId>`（均显式 --project），支持 --env、--dataset、--fail-fast、--allow-draft、--reporters、--runs-dir；覆盖项只影响本次调用。运行失败/配置错误/取消返回非零，preview 绝不发送。现有 run/run-workflow/run-stress 继续可用。

## 8. 桌面体验与诊断报告

测试侧栏保留“接口用例、场景”，加入“测试套件、数据集”；限定当前项目，搜索/操作栏固定，列表和编辑/结果区各自滚动，不恢复整页拉长问题。沿用项目签/接口编辑会话，项目切换或 dirty 草稿离开沿用确认，不暗中保存其它接口。断言/提取用结构化行编辑，按 descriptor 显示输入与验证；数据集分页；套件有选择预览、引用缺失/空选提示、运行/取消。

新增安全证据 DTO：执行定位、快照 revision/数据摘要、请求与响应摘要、每个断言的 id/op/selector/actual/expected/差异路径、提取状态及安全值、失败阶段/代码、各段耗时。失败后选中具体 case-row，可跳转当前项目的接口/用例；资产已改或删除时提示而非定位到同名对象。用例失败重跑按当前资源和当前凭据执行，明确 revision 已变化；工作流失败重跑整个原条目，不单独重跑需要前置变量的节点。

证据复用/抽取 debug 投影和认证输出边界的纯函数，不将原始 credentialBindings、Cookie jar 或 native 对象放进 IPC/结果。所有新增输出（断言 expected/actual、提取值、错误、复制、JSON/HTML/JUnit）都纳入同一边界。sensitive 提取显式遮罩；Authorization、Cookie 和已知凭据标记继续遮罩。未知业务字段不承诺自动识别为密钥，UI 对 token 提取提供敏感勾选。后发现标记时在输出前重新投影已收集证据，不能只遮住最新一条。

证据默认全部保留定位元数据，正文仅保留失败样本，选项可为 none/failures/all（默认 failures）。单正文预览最多 64 KiB，每值预览 4 KiB，单 case-row 证据 256 KiB，单次报告证据总预算 16 MiB；预算含证据附件中的正文、值和诊断文本，不包含已有结果容器的定位键/数字汇总，后者受执行数量上限约束。先完整脱敏再截断，预算用尽显示 omitted/truncated，不更改判定。压测只保留最多 20 个失败证据样本和聚合，不存每请求正文，样本同样计入预算；性能模型优化留 F6。

JSON 先安全落盘，HTML/JUnit 后渲染，渲染失败不丢原始结果且给出非零执行状态/明确警告。HTML 可离线按失败/接口/行筛选和展开证据，JUnit 用 testcase 身份+failure/system-out 承载有界信息；HTML/XML 统一转义。旧历史缺证据仍可查看，标“旧记录未采集”，不从当前接口伪造历史请求。suite、collection、workflow、stress 历史按 kind/project 隔离展示。只消费宿主当前实际可采集的既有脚本诊断，不为完整脚本控制台新建运行时/日志桥；缺失明确未采集，不能据此把原 TEST-001 的完整脚本日志要求标绿。

## 9. 验收与任务映射

| 编号 | 可观察验收 | 归属 |
| --- | --- | --- |
| F4-01 | 新字段/schema/分文件保存重开一致；旧七 op、有效插件 op 和 xpath 可往返；坏文件不被静默擦除 | A1 |
| F4-02 | 数据集/套件/模型/用例引用纳入诊断、删除影响和 ID 重映射；事务冲突无半写入 | A1 |
| F4-03 | exists/notExists 区分 missing 与 null/false/0/空串；JSONPath all、XPath 前缀和 Cookie 来源符合约定 | A2 |
| F4-04 | 所有新增 op 有真实正负例，坏 expected/语法为 config；插件两参数实现仍可调用 | A2 |
| F4-05 | SchemaNode 匹配、首差异路径、oneOf/模型引用/响应选择；不支持语义不伪报成功 | A2 |
| F4-06 | 提取后断言及下一用例/节点可用；失败原子不发布、旧目标清理，默认值/可选缺失明确 | A3 |
| F4-07 | 单用例、集合、已有场景、单 VU 单迭代的请求/断言/提取分类一致；两个 run/VU 不串值 | A3/B1 |
| F4-08 | CSV/JSON 导入、编辑、重开、导出及类型转换正确；空新集拒绝，旧文件分支提示而不改既有空行为 | B1 |
| F4-09 | 所选文件一次准备，运行中替换文件不影响当前；单行数据也有行身份，压测游标规则不变 | B1 |
| F4-10 | 套件显式/query选择稳定、环境scope正确；空/悬空/数据冲突/超规模在任何请求前拒绝 | B2 |
| F4-11 | 混合用例/场景套件、外层数据、failFast、取消和跳过汇总正确；独立条目/轮次会话不串 | B2 |
| F4-12 | CLI list/preview/run 与桌面同选择计划；preview 零请求，失败非零、不依赖在线服务 | B2/B3 |
| F4-13 | 当前项目内结构化编辑/保存重开/dirty隔离/只读保护/分页与内部滚动可用，无跨项目操作外溢 | B3 |
| F4-14 | 每失败行显示安全请求响应、actual/expected/路径/提取阶段；定位/重跑有精确身份与版本提示 | C1 |
| F4-15 | 所有输出先脱敏后限额，已知凭据与显式 sensitive 不出现在 IPC/文件/复制；预算标记不改结论 | C1 |
| F4-16 | JSON/HTML/JUnit 汇总一致，渲染失败原始结果仍在；旧报告缺新字段可读 | C1 |
| F4-17 | extraction 失败经场景/压测聚合和当前报告校验，不算业务成功；压测证据有界 | A3/C1 |
| F4-18 | 一个本地合成项目完成编辑→数据→套件预览/运行→失败定位→重跑→导出；Windows 新包可验证 | G |

## 10. 执行、验证与退出

实施顺序 A1→A2→A3→B1→B2→B3→C1→G。每交付任务独立审核；同一问题交原开发者整批修正，复审只看增量。阶段末一次跨模块审核，不反复重启宽审。

按用户要求，把设计和计划作为一个集中确认包；不为每 task 重问继续。复用旧测试/夹具，只有新资产/新 runner 缺承载点时新建小型测试文件；优先参数化合并，不增加重复全量、故障穷举或无关安全测试。各任务只跑受影响文件的 RED/GREEN 和必要类型门，保留真实并发。阶段末顺序跑受影响 Core/CLI/Desktop 一次，maxWorkers=2；失败定位后只重跑相关文件，不增加 timeout、不 skip/删失败项求绿。

跨包测试按需先构建已变更的 producer（Core/CLI 的 package exports 指向 dist），同源码哈希产物复用，不把陈旧 dist 的通过/失败当新代码证据。最终按 Core→CLI→Desktop 依赖关系收口，Desktop 完整 build 一次，renderer 与 Electron/preload 都验证；目录打包直接复用构建，不走会重复 build 的包装命令。使用合成项目和本机回环服务，不读用户真实凭据/业务文件；浏览器/原生不支持的交互如实交用户验证，不换通道规避。交付 fresh Windows 包和验收记录，用户之后另行决定 Git 集成。

仅重大范围/接口裁定、新授权、延期依赖或确切阻塞才暂停，必须说明已完成、剩余以及用户需要做什么。F3 四项低优先级观察（保存提示精度、局部固定文案、极短窗口、撤销成功文案）继续保留，不作为本阶段隐式必修项；不混入 F5 并行/循环/重试、F6 负载模型/趋势/基线、F7 SDK/在线深化。

## 11. 事实来源

- [完整需求](2026-09-27-apicc-api-lifecycle-platform-requirements.md)、[核心基线](2026-09-27-apicc-core-capability-baseline-design.md)、[DEF-001 裁定](2026-10-07-apicc-script-runtime-indefinite-deferral.md)。
- [F1 契约/凭据边界](2026-10-07-apicc-contract-assets-design.md)、[F2 调试闭环](2026-10-13-apicc-f2-debug-loop-design.md)、[F3 设计/文档/Mock/IO](2026-10-18-apicc-f3-design-docs-mock-exchange-design.md)。
- 源码核对：common.ts、assert/operators.ts、caseExecutor.ts、runner.ts、caseSession.ts、snapshot.ts、contractFiles.ts、debug/projection.ts、report/types.ts，桌面 CasePanel/TestSidebar/RunView 与 CLI main.ts（均基线 b5b88f6）。
- [RE2JS 官方项目](https://github.com/le0pard/re2js)：纯 JavaScript、线性匹配、支持编译/匹配/捕获组。2026-10-20 读取发布元数据确认 2.8.8、MIT、Node≥20、无生产 dependencies；本轮没有安装。新语法仅按本规格的子集开放，不跟随上游默认扩展变更。
