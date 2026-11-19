# 桌面工作台中英文旁注处置表

本表按本地项目、在线项目和全局弹层记录采样前的文字、显示条件与实际处理。初筛包含 53 个组件的 143 处长文案，另查了短文案、按钮禁用原因、原始数据投影和动态翻译键。下表中的 JSON、占位符及英文错误代码是查找线索。中英文均核过语言资源；独立实拍只覆盖所列代表场景。用户操作原理收录于[桌面工作台使用指南](../../../../../desktop-workbench-guide.md)。

原文中文取首轮组件扫描。英文从对应基线键读取，后续新增键取其首个可用版本。组件路径在 `apps/desktop/src/renderer/src` 下。每行的键和组件是可复查的源码证据，标识后括号内的数字为初筛行号。实拍按场景列在各节；一个画面只证明当时可见的状态。

## 逐页补查与键盘反馈

| 页面与模式 | 当场核对的内容与处置 | 证据 |
| --- | --- | --- |
| 主页、本地及在线工作区 | 项目列表显示真实卡片、搜索、零结果与可执行的打开/新建或登录入口。保留分组删除约束、项目不可撤销删除与退出丢弃草稿数；常规列表无需增加操作教程。 | `HomeView.vue`、`ConnectionPanel.vue`；见主页前后图。 |
| 连接管理、登录 | 空连接列表可添加连接。已登记服务器可登录、浏览、编辑与移除。保存地址校验、请求失败和会话失效就近保留；本轮没有发现需要删除的常态旁注。 | `ConnectionPanel.vue` 中的 `connections-empty`、`connections-form-error`、`connections-error`。 |
| 本地及在线环境 | 名称、变量与参数可编辑。环境未加载、读取失败、保存中、保存冲突各有不同的状态；焦点进入环境行也可发现更多操作。没有发现重复讲解底栏选环境的常驻文字。 | `EnvPanel.vue`、`env.loadFailed`、`env.loading`、`.environment-row:focus-within`。 |
| 接口、设计与调试 | 正文、契约、示例、Schema、代码片段保持原有格式。历史记录以前默认列出整个交换 DTO，现改为请求方法与地址、传输进度、HTTP 状态、耗时及采集来源；传输阶段使用界面词典，错误码保留。有响应的 503 仍显示该响应。 | `DebugHistory.vue`、`ResponseViewer.vue`、`debugLoop.rawExchange`、`responseWorkbench.stage`。 |
| 只读历史恢复 | 源丢失保留原因及需要补填的字段。历史的原始标识、正文和已遮罩的投影可按需展开；不读取原始凭据或重新发送。换到不同归档后重新定位有效交换，前次只读预览不跟随到别的记录。 | `DebugHistory.vue`；`components.test.ts` 中的 DebugHistory filters。 |
| 测试、两端各分页 | 已选用例、数据集、套件和压测所在测试标题按工作区实际写权限显示“当前项目只读，无法修改测试资产。” / “Read-only project. Test assets cannot be changed.”。说明可以 Tab 聚焦，原按钮继续使用既有权限判断。未选数据集仍有“从左侧选择”的可执行指引。 | `TestWorkbench.vue`、`testAssets.readOnly`、`test-readonly`、T04。 |
| 运行发起与归档 | R08 保留选择目标的空态；确认动作、历史位置、原始请求是否已知各按事实显示。真实任务的结论与底层请求事实可以不同。技术细节默认收起。 | `RunLaunchForm.vue`、`LocalRunRecords.vue`、`OnlineExecutionPanel.vue`、R04 / R07 / R08。 |
| 底栏执行位置与详情 | 项目环境和执行位置继续可选；当前本机位置仅列本机插件，被选代理才出现脚本批准折叠区。成员可管理时进入这个代理的批准页面，否则显示取得批准的方式。 | `OnlineExecutionDetails.vue`、`OnlineExecutionPanel.vue`、`OnlineStressPanel.test.ts` 中的双入口角色切换。 |
| 工作流节点与条件 | 节点参数、变量表达式及格式仍紧贴输入。未配置重试时没有重试风险旁注，开启后说明重复执行的影响。编辑区不再常驻子流程隔离、并发合并、循环与取消原理。 | `WfControlFields.vue`、`WfPropertyPanel.vue`、`wfDesigner.test.ts`。 |
| 项目工具、个人设置 | Mock 真实草稿和运行状态保留；缓存显示受保护数量、超限状态、各输入单位与范围。缓存清理影响可用键盘展开，原理详见使用指南。 | `MockPanel.vue`、`OnlineExecutionCacheSettings.vue`、`MockPanel.test.ts`、`OnlineExecutionCacheSettings.test.ts`。 |
| 分享和 AI 确认弹层 | 选择目标层去掉尚未外发的重复旁白，实际本地预览处保留遮罩边界与可检查的材料。AI 发送同意、预算、选择的材料、缺凭据与重新绑定的阻断仍与对应动作相邻。 | `App.vue`、`PublicationPreview.vue`、`AiOutboundPreview.vue`、`AiConnections.vue`。 |

## 条件表达式与低频详情补查

`OnlineExecutionDetails.vue` 和 `OnlineExecutionPanel.vue` 原先在模板中按执行位置动态选择下面两条文字。`OnlineExecutionCacheSettings.vue` 的四条说明共用一个列表元素。下列条目补充在首轮 143 个候选之外。

| 模式与条件 | 键 | 原中文 / English | 处置 |
| --- | --- | --- | --- |
| 在线项目，两处执行详情中的本机位置 | `onlineExecution.localLifetime` | 本机任务依赖桌面进程；关闭后不会交给后端或其他代理自动重跑。<br>Local tasks depend on this desktop process. Closing it does not hand execution to the backend or another agent. | 移出详情常态，见手册「发起、确认与查看任务」。同一项目的本机和代理记录分别按实际状态显示。 |
| 在线项目，两处执行详情中的代理位置 | `onlineExecution.agentLifetime` | 代理任务独立运行；重新打开本项目可查询。控制断开不等于执行失败，重连不会重跑目标。<br>Agent tasks run independently and can be queried after reopening this project. A disconnected control connection is not task failure; reconnecting never replays the target. | 移出详情常态，见手册「发起、确认与查看任务」。同一项目的本机和代理记录分别按实际状态显示。 |
| 全局设置中展开「清理的影响」 | `executionCacheSettings.cleanupHint` | 只释放可安全清理的非活动内存，不删除服务器历史，也不会取消或重新执行请求。<br>Releases only inactive memory that is safe to clear. It does not delete server history, cancel requests, or execute them again. | 原来常驻使用量下方，改为默认折叠；单位、保护数量及超限原因仍直接可读。 |
| 全局设置中展开「清理的影响」 | `executionCacheSettings.restoreHint` | 再次进入项目时，执行位置和环境回到默认值；旧调试可能新建会话，已完成本机结果的内存副本可能无法恢复。<br>Returning to a project uses the default execution location and environment. A later debug request may create a new session, and completed local result copies may no longer be recoverable. | 原来常驻使用量下方，改为默认折叠；单位、保护数量及超限原因仍直接可读。 |
| 全局设置中展开「清理的影响」 | `executionCacheSettings.ttlHint` | 空闲到期在上下文切换、运行结算和保存设置时检查，不是精确到时清理。<br>Idle expiry is checked on context changes, run settlement, and settings saves; it is not an exact cleanup timer. | 原来常驻使用量下方，改为默认折叠；单位、保护数量及超限原因仍直接可读。 |
| 全局设置中展开「清理的影响」 | `executionCacheSettings.estimateHint` | 按序列化载荷估算，不代表 Electron 堆内存或进程 RSS 上限。<br>Estimated from serialized payloads; this is not an Electron heap or process RSS limit. | 原来常驻使用量下方，改为默认折叠；单位、保护数量及超限原因仍直接可读。 |

## 首页与连接

[本地首页前图](before-home-local.png)与[后图](after-home-local.png)、[在线首页前图](before-home-online.png)与[后图](after-home-online.png)、[返回原有在线工作区](../batch-1/viewer-accessible-list.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 主页（本地／在线）；连接与会话为在线<br>`components/HomeView.vue` (822) | `home.deleteGroupHint`<br>确认删除本地分组 | 仅空分组可删除；默认分组不可删除。<br>Only empty groups can be deleted; the default group cannot. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 主页（本地／在线）；连接与会话为在线<br>`components/HomeView.vue` (823) | `home.deleteProjectHint`<br>确认删除本地项目 | 将删除该项目及其全部模块、接口与环境，不可恢复。<br>The project with all modules, APIs and environments will be deleted. This cannot be undone. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 主页（本地／在线）；连接与会话为在线<br>`components/OnlineLoginDialog.vue` (349) | `online.logoutConfirmDesc`<br>退出登录确认 | 退出登录将关闭全部在线项目签，以下 {count} 个签的未保存草稿将丢弃。<br>Signing out closes all online project tabs; unsaved drafts in the following {count} tab(s) will be discarded. | 条件成立时就地保留原因、影响或恢复动作。 |
| 主页（本地／在线）；连接与会话为在线<br>`components/OnlineMigrateDialog.vue` (133) | `online.migrateDoneHint`<br>迁移拉取操作成功 | 迁移完成。退出在线模式后可打开本地目录继续使用。<br>Migration finished. Leave online mode and open the local directory to continue. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |

## 应用入口与跨项目操作

[权限失效的实际页面](../batch-1/viewer-project-access-revoked.png)、[返回可访问工作区](../batch-1/viewer-access-recovery.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 全局；按在线会话、退出或本地分享条件<br>`App.vue` (2583) | `online.sessionErrors.online-workspace-session-missing`<br>在线工作区会话丢失，签页等待重新登录 | 在线工作区会话不存在（可能已退出登录），项目签已标记离线。请重新登录后重试。<br>The online workspace session is unavailable (you may have signed out). The project tab is offline. Sign in again and retry. | 条件成立时就地保留原因、影响或恢复动作。 |
| 全局；按在线会话、退出或本地分享条件<br>`App.vue` (2827) | `online.exitConfirmDesc`<br>成员确认退出工作区 | 将关闭该工作区的 {count} 个项目签，其中的未保存草稿将丢弃。<br>The {count} project tab(s) of this workspace will be closed; unsaved drafts in them will be discarded. | 条件成立时就地保留原因、影响或恢复动作。 |
| 全局；按在线会话、退出或本地分享条件<br>`App.vue` (2850) | `collaboration.localNoNetwork`<br>选择发布目标或生成本机外发预览 | 此阶段尚未发送任何网络请求；强制遮罩仍有效。不承诺识别所有业务秘密，请核对安全内容。<br>No network request has been sent at this stage. Mandatory masking remains active. Not all business secrets can be detected; review the safe content. | 移除选择目标抽屉中的重复说明；在真正的本地外发预览保留遮罩范围与人工核对提示。 |
| 全局；按在线会话、退出或本地分享条件<br>`App.vue` (2850) | `collaboration.connectTarget`<br>本机材料选择发布目标，但没有已登录的可选项目 | 请连接并打开在线工作区后选择目标；本机设计、执行和报告仍可使用。<br>Connect and open an online workspace to choose a target. Local design, execution and reports remain available. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |

## 接口与调试

[同一历史记录的前图](before-local-debug-history-exchange.png)与[后图](after-local-debug-history-exchange.png)、[HTTP 503 交换](history-503.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 接口设计、生成片段或共享凭据编辑器<br>`components/CodeSnippetPanel.vue` (35) | `design.snippetPlaceholderHelp`<br>生成代码片段带有占位符 | 运行前请替换 API_KEY 等模板值和用户提供的文件路径。不会读取凭据或本地文件。<br>Replace template values such as API_KEY and user-supplied file paths before running. Credentials and local files are never read. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 接口设计、生成片段或共享凭据编辑器<br>`components/CredentialEditor.vue` (147) | `contract.credentialWarning`<br>凭据编辑区处理认证值 | 重要提示：普通测试凭据可能会被本地脚本读取；这不是严格的机密隔离边界。<br>Important: ordinary test credentials may be readable by local scripts; this is not a strict secrets-isolation boundary. | 条件成立时就地保留原因、影响或恢复动作。 |
| 接口设计、生成片段或共享凭据编辑器<br>`components/CredentialEditor.vue` (148) | `contract.credentialOAuthManaged`<br>选择由 OAuth 管理的凭据 | 该 Bearer 由 OAuth 档案管理。请先在此处解除档案关联；解除关联会保留凭据值，之后可在此删除。<br>This Bearer is managed by an OAuth profile. Unlink the profile here first; unlinking keeps the credential value. You can remove it here afterward. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 接口设计、生成片段或共享凭据编辑器<br>`components/CredentialEditor.vue` (149) | `contract.credentialOAuthUnknown`<br>OAuth 凭据记录不完整 | OAuth 档案状态不可用。确认归属前已暂停凭据修改。<br>OAuth profile status is unavailable. Credential changes are paused until ownership can be checked. | 条件成立时就地保留原因、影响或恢复动作。 |
| 接口设计、生成片段或共享凭据编辑器<br>`components/CredentialEditor.vue` (155) | `contract.credentialRemoveImpact`<br>删除被引用的凭据前 | 引用此凭据的契约将失去绑定；再次运行前需要重新绑定。<br>Contracts that reference this credential will lose their binding; rebind it before running them again. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地接口或自由请求<br>`components/DebugHistory.vue` (385) | `debugLoop.sourceUnavailable`<br>恢复历史时原接口已不存在 | 原接口当前不可用；历史仍可查看，但不能借用其他接口执行。<br>The original API is unavailable. This history can be viewed but not run against another API. | 保留只读恢复阻断与补输入字段，只显示当前归档和交换的预览。完整来源标识与已投影请求放入折叠。 |
| 本地接口或自由请求<br>`components/DebugHistory.vue` (421) | `debugLoop.historyPreferencesNote`<br>调试历史偏好开关 | 设置仅保存在本机应用，不属于项目。关闭历史不会删除已有记录。<br>These settings are local to this app, not the project. Disabling history keeps existing records. | 缩短，仅关闭保存新历史时说明已有记录仍保留。<br>现文 关闭后保留已有记录。 / Turning off history keeps existing records. |
| 本地接口或自由请求<br>`components/DebugSettings.vue` (105) | `debugLoop.settingsNote`<br>调试设置中的数值覆盖项 | 设置作为本次调试调用覆盖项；默认连接超时 10 秒，其余超时 30 秒。响应上限最高 128 MiB，上传上限最高 1 GiB。<br>Settings override this invocation. Defaults are 10 seconds for connect and 30 seconds for other timeouts. Response limit caps at 128 MiB and upload at 1 GiB. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地接口或自由请求<br>`components/DebugSettings.vue` (130) | `debugLoop.cookiesNote`<br>调试设置的 Cookie 管理区 | 仅显示 Cookie 元数据，不展示值。Jar 属于当前主进程会话，不随用例保存或写入历史。<br>Cookie values are never shown. The jar belongs to the main-process session and is not saved with cases or history. | 缩短为实际可见字段，Cookie 会话归属见「从调试请求建立用例」。<br>现文 仅显示 Cookie 名称与属性。 / Only cookie names and attributes are shown. |
| 本地接口或自由请求<br>`components/OAuthManager.vue` (453) | `oauth.note`<br>用户打开该配置或认证管理页 | 档案归属于当前项目和所选环境。打开面板不会自动授权或发送请求。<br>Profiles belong to this project and selected environment. Opening this panel never authorizes or sends a request. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 在线接口<br>`components/OnlineApiEditor.vue` (155) | `online.pullGuide`<br>在线接口编辑器无所选接口 | 有效项目（contract-files-v1）支持在本机或已授权代理上调试接口、运行套件和工作流，请先选择项目及执行位置。旧格式内容仍可浏览或迁移拉取，不能直接执行。<br>Valid contract-files-v1 projects support debugging, suites and workflows on this computer or an authorized agent. Select a project and execution location. Legacy-format content remains available for browsing and migration (pull); it cannot execute directly. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地接口或自由请求<br>`components/RequestEditor.vue` (822) | `editor.invalidFullUrl`<br>自由请求 URL 草稿无效 | 请先修正完整 URL 草稿，再保存为正式接口。<br>Fix the full URL draft before saving it as a formal API. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地接口或自由请求<br>`components/RequestEditor.vue` (831) | `projectWorkbench.afterMigration`<br>从已有调试环境迁移到底栏时 | 本次发送使用所选环境。之后的请求跟随项目底栏。<br>This request uses the environment you choose here. Subsequent requests use the project status bar selection. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地接口或自由请求<br>`components/RequestEditor.vue` (854) | `debugLoop.freeSaveInheritanceNote`<br>将自由请求保存到正式模块前 | 保存后，该接口后续请求会按所选模块继承设置与前后置操作。<br>After saving, future requests inherit settings and pre/post operations from the selected module. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |

## 测试资产

[Viewer 只读与键盘焦点](viewer-readonly-focus.png)、[本地用例](../batch-2/T02-local-case.png)、[在线用例](../batch-2/T01-online-case.png)、[数据集未选状态](../batch-3/T04-online-unselected.png)、[套件预览](../batch-3/T05-expanded-preview.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 本地及在线测试页的共享编辑器<br>`components/AssertionEditor.vue` (86) | `testing.unknownOperator`<br>遇到既有未识别断言操作符 | 操作符 {op} 未注册，已保留配置；执行预检会失败。<br>Operator {op} is not registered. Configuration is preserved; execution preflight will fail. | 保留旧操作符与改绑入口，防止不兼容断言被静默改写。 |
| 本地及在线测试页的共享编辑器<br>`components/AssertionEditor.vue` (87) | `testing.manualOperator`<br>已知操作符没有结构化编辑器 | 已注册插件未提供描述，可手工配置 expected/options。<br>Registered plugin has no descriptor. Configure expected/options manually. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线测试页的共享编辑器<br>`components/AssertionEditor.vue` (89) | `testing.regexHint`<br>选择正则提取或匹配 | 使用 RE2 兼容正则，仅支持 i/m/s；不支持环视和反向引用，不回退 JavaScript 正则。<br>RE2-compatible patterns with i/m/s flags only. Lookaround and backreferences are unsupported; no JavaScript regex fallback. | 只在对应匹配/提取方式显示所支持的语法。 |
| 本地及在线测试页的共享编辑器<br>`components/CaseEvidencePanel.vue` (30) | `caseEvidence.changed`<br>当前源与原证据不一致 | 资源定义已变化；定位和重跑使用当前资源与当前凭据<br>The asset definition changed. Locate and rerun use the current asset and credentials. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地及在线测试页的共享编辑器<br>`components/CaseEvidencePanel.vue` (55) | `caseEvidence.timings`<br>已选用例的采集耗时明细 | 请求 {request} ms · 脚本 {script} ms · 迭代 {iteration} ms<br>Request {request} ms · Script {script} ms · Iteration {iteration} ms | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线测试页的共享编辑器<br>`components/CasePanel.vue` (500) | `testing.externalFileHint`<br>用例选择已有文件数据引用 | 外部 JSON 单元仍须为字符串；相对路径从工作区根目录解析。旧空文件按一次无数据执行。<br>External JSON cells must remain strings. Relative paths resolve from the workspace root. Legacy empty files execute once without data. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线测试页的共享编辑器<br>`components/CasePanel.vue` (513) | `debugLoop.cookiesNotSavedWithCase`<br>当前编辑的用例支持应用调试草稿 | Cookie Jar 是主进程会话状态，不会随用例保存。<br>Cookie jar is main-process session state and is not saved with a case. | 迁入「从调试请求建立用例」第 2 步，移除用例操作行常驻说明。 |
| 本地及在线测试页的共享编辑器<br>`components/CasePanel.vue` (529) | `ai.selectedObservationRow`<br>从选定采集行创建 AI 建议 | 已选报告第 {index} 行；仅用于同一已保存用例，观测不代表契约许可。<br>Report row {index} selected; use only with the same saved case. An observation is not contract permission. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线测试页的共享编辑器<br>`components/DatasetPanel.vue` (79) | `testing.typedCellHint`<br>数据集逐单元编辑 | 单元使用 JSON：字符串请加双引号；空白表示缺字段，"" 表示空字符串，null 保留空值。<br>Cells use JSON: quote strings. Blank means missing; "" means empty string; null preserves a null value. | 第三批以列类型选择、当前单元校验取代整列 JSON 教程；保留具体错误和输入草稿。 |
| 本地及在线测试页的共享编辑器<br>`components/DatasetPanel.vue` (84) | `testing.emptyDraft`<br>已选数据集没有数据行 | 空数据集可保存为草稿；选择它运行时会拒绝执行。<br>An empty dataset can be saved as a draft, but cannot be executed. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线测试页的共享编辑器<br>`components/DatasetPanel.vue` (90) | `testing.importRows`<br>数据导入预览返回行数 | 已解析 {count} 行，预览前 100 行；确认后替换草稿表格。<br>Parsed {count} rows; showing the first 100. Apply to replace the draft table. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线测试页的共享编辑器<br>`components/DatasetPanel.vue` (92) | `testing.csvHint`<br>展开 CSV 导入导出 | JSON 保留类型和缺字段；CSV 将值转成文本，缺字段与空字符串均导出为空单元。<br>JSON preserves types and missing fields. CSV converts values to text; missing fields and empty strings both export as empty cells. | 保留在导入/导出折叠区，避免将 CSV 文本列误作带类型 JSON。 |
| 本地及在线测试页的共享编辑器<br>`components/ExtractionEditor.vue` (71) | `testing.regexHint`<br>选择正则提取或匹配 | 使用 RE2 兼容正则，仅支持 i/m/s；不支持环视和反向引用，不回退 JavaScript 正则。<br>RE2-compatible patterns with i/m/s flags only. Lookaround and backreferences are unsupported; no JavaScript regex fallback. | 只在对应匹配/提取方式显示所支持的语法。 |
| 本地及在线测试页的共享编辑器<br>`components/ExtractionEditor.vue` (80) | `testing.extractionHint`<br>测试用例的响应提取编辑器 | 提取只写入本次运行变量；敏感头和 Cookie 自动遮罩。可选缺失且无默认值时会清除本层旧值，低优先级变量仍可能生效。<br>Extractions only update this run's variables. Sensitive headers and cookies are masked automatically. Optional missing values without a default clear the local binding; lower-priority variables may still apply. | 迁入「从调试请求建立用例」第 3 步；字段名称、提取路径和样例留在编辑器。 |
| 本地及在线测试页的共享编辑器<br>`components/SuitePanel.vue` (95) | `testing.queryHint`<br>套件选择模块或标签的动态筛选 | 模块与标签条件取 AND；同组标签取 OR；空筛选代表当前项目所有适用用例。<br>Module and tag dimensions use AND; tags within one group use OR. Empty filters select all applicable cases in this project. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线测试页的共享编辑器<br>`components/SuitePanel.vue` (101) | `testing.suiteIsolation`<br>配置套件及数据驱动方式 | 套件条目和外层数据轮次隔离变量与 Cookie；有序共享状态请使用现有场景。外层数据与子用例数据驱动冲突会在发送前拒绝。<br>Each entry and outer data round has independent variables and cookies. Use a scenario for shared ordered state. Outer data conflicts with case data drivers are rejected before sending. | 第三批从常态编辑区移出，隔离与数据驱动规则见「数据集、测试套件与工作流」。 |
| 本地及在线测试页的共享编辑器<br>`components/SuitePanel.vue` (107) | `run.reportingUnits`<br>套件执行证据选项或结果统计 | 逻辑报告单位 {total}（失败 {failed}）· 非请求诊断 {diagnostics}<br>Logical reporting units {total} ({failed} failed) · Non-request diagnostics {diagnostics} | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线测试页的共享编辑器<br>`components/SuitePanel.vue` (108) | `testing.scale`<br>已预览套件的条目数、轮数与执行数 | {entries} 个条目，{rows} 轮，预计 {executions} 次用例执行<br>{entries} entries, {rows} rounds, {executions} planned case executions | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线测试页的共享编辑器<br>`components/SuitePanel.vue` (109) | `testing.caseCounts`<br>已有套件执行结果 | 实际用例行：{total} 总计 / {passed} 通过 / {failed} 失败<br>Actual case rows: {total} total / {passed} passed / {failed} failed | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |

## 工作流

[从工作流失败记录查阅归档](../batch-5/R07-local-record.png)。节点属性的权限和重试确认由定向挂载核对。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfControlFields.vue` (140) | `wf.control.callIsolation`<br>工作流选择子流程节点 | 子流程变量隔离；仅成功的显式输出发布。远端副作用与 Cookie 不回滚。v1 子流程保留原脚本依赖。<br>Child variables are isolated; only successful explicit outputs publish. Remote effects and cookies do not roll back. v1 children retain existing script dependencies. | 子流程输出及变量隔离迁入「数据集、测试套件与工作流」。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfControlFields.vue` (149) | `wf.control.loopHint`<br>工作流选择循环节点 | 0 次合法且不发布输出；while 用尽预算仍为真会失败。数据行与循环轮次独立，套件外层行不隐式递增。<br>Zero iterations publish no outputs. A true while predicate after the limit fails. Data rows and loop iterations are independent; suite rows do not advance implicitly. | 循环轮次、条件与预算规则迁入「数据集、测试套件与工作流」。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfControlFields.vue` (158) | `wf.control.parallelHint`<br>工作流选择并行节点 | AND 输出目标不可冲突；OR 仅发布实际胜出者的输出，取消落败分支并等待收尾。分支变量与 Cookie 隔离，Cookie 不回灌父会话。<br>AND output targets must not conflict. OR publishes only the recorded winner, cancels losers and waits for drain. Branch variables and cookies are isolated; cookies never merge into the parent. | 并行分支合并和 Cookie 隔离迁入「数据集、测试套件与工作流」。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfControlFields.vue` (170) | `wf.control.retryHint`<br>请求节点启用重试策略 | 每次重试重新执行整个请求节点的全部选中数据行及原容器操作；远端副作用和 Cookie 不回滚。非 GET/HEAD/OPTIONS 必须确认；即便 GET 也可能有副作用，不代表请求未到服务端。<br>Every retry repeats all selected data rows and original container operations for this request node. Remote effects and cookies do not roll back. Non GET/HEAD/OPTIONS requires confirmation; even GET may have side effects and a failure does not prove the server received nothing. | 缩短后仍在开启重试的字段旁提示行范围、重复副作用与服务端可能已经处理。高风险方法确认照常生效。<br>现文 重试将再次执行全部选中数据行。远端操作和 Cookie 会保留，服务端可能已处理上一次请求。 / A retry repeats all selected rows. Remote effects and cookies persist. The server may already have handled the request. |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfControlFields.vue` (181) | `wf.control.cancelCleanupHint`<br>配置工作流节点的错误/收尾处理器 | 用户/祖先取消、总期限耗尽或 OR 落败后不再新启网络错误处理或 finally；已启动调用等待实际收尾。局部超时使用独立有界处理器，不能延长流程期限。<br>User/ancestor cancellation, root deadline or OR loss starts no new network handler or finally. Started calls must drain. Local timeout handlers have independent bounded signals and cannot extend the root deadline. | 收尾、取消与局部超时的行为迁入「数据集、测试套件与工作流」。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfDesigner.vue` (592) | `workbenchPosition.unavailable`<br>之前选中的项目对象已不可用 | 原先查看的项目内容已删除或权限已变更，请从列表重新选择。<br>This item was removed or you no longer have access. Choose another item from the list. | 保留在失效位置；允许选择仍可访问的对象。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfDesigner.vue` (709) | `wf.control.legacyHint`<br>工作流仍为旧执行版本 | 旧 v1 语义：串行、多入 OR、原字符串条件保留；不自动转换为 v2。<br>Legacy v1 retains sequential execution, OR incoming edges and string conditions; no automatic v2 conversion. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfPropertyPanel.vue` (129) | `wf.varsHint`<br>打开条件表达式编辑器 | 可用变量：prev.passed（上一节点是否通过）、vars.*（集合/项目变量）、env.*（环境变量）<br>Available variables: prev.passed (previous node passed), vars.* (collection/project variables), env.* (environment variables) | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfPropertyPanel.vue` (130) | `wf.syntaxHint`<br>编辑工作流条件表达式 | 条件为 JS 表达式；求值异常按不通过处理<br>Condition is a JS expression; evaluation errors count as not passed | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线工作流设计；历史报告按已有执行范围<br>`components/WfResultDrawer.vue` (127) | `wf.control.currentAssetHint`<br>从报告定位当前工作流资产 | 定位到当前资产，不重放历史快照。<br>Locates the current asset; no historical snapshot replay. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |

## 运行与压测

[本地未选目标](../batch-4/R08-local-empty.png)、[在线未选目标](../batch-4/R08-online-empty.png)、[确认后改变目标](../batch-3/T06-changed-target.png)、[查看本次任务](../batch-5/R04-online-record.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 本地工作台<br>`components/LocalRunLaunch.vue` (257) | `stress.targetConfirmation`<br>实际目标需要额外授权 | 目标 {origin} 尚未确认。是否仅为本次运行放行？<br>Target {origin} is not confirmed. Allow it for this run only? | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地工作台<br>`components/LocalRunLaunch.vue` (258) | `stress.targetConfirmationRisk`<br>确认本次或持久目标授权前 | 请确认你拥有该目标的压测授权；loopback 目标也需要明确确认。<br>Confirm that you are authorized to stress this target; loopback targets also require explicit confirmation. | 保留在本次/项目目标批准操作旁，避免绕过授权。 |
| 本地工作台<br>`components/LocalRunRecords.vue` (156) | `wf.control.truncated`<br>归档的历史轨迹已截断 | 轨迹已截断：展示 {shown} / 共 {total} 事件<br>Trace truncated: showing {shown} / {total} events | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线归档、报告或压测配置<br>`components/RunSummaryView.vue` (35) | `reportPresentation.populationHint`<br>查看归档的逻辑汇总与请求统计 | 保留重试等实际执行记录；逻辑通过不代表原始请求没有失败。<br>Includes actual executions such as retries. A logical pass does not erase raw request failures. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线归档、报告或压测配置<br>`components/RunSummaryView.vue` (38) | `reportPresentation.requestFacts`<br>报告含真实请求统计 | 已开始请求 {requestStarted} · 已完成请求 {requestCompleted} · HTTP 交换 {httpExchanges}<br>Requests started {requestStarted} · Requests completed {requestCompleted} · HTTP exchanges {httpExchanges} | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线归档、报告或压测配置<br>`components/RunSummaryView.vue` (39) | `reportPresentation.incomplete`<br>采集到的明细不完整 | 报告详情不完整或已省略；统计保留采集时的总数，当前明细不一定覆盖全部执行。<br>Report details are incomplete or omitted. Captured totals are retained; the visible details may not cover every execution. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地工作台<br>`components/SideTree.vue` (705) | `tree.impactWarning`<br>将删除的用例存在工作流引用 | 该用例被以下工作流引用，删除后对应节点将标记为缺失（可改绑恢复）<br>This case is referenced by the following workflows; after deletion the affected nodes will be marked as missing (rebind to restore) | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地工作台<br>`components/SideTree.vue` (712) | `projectDirectory.deleteProjectDrafts`<br>待删除项目有草稿或活动请求 | 这个项目有未保存的草稿或正在运行的请求，删除项目会关闭相关请求签。<br>This project has unsaved drafts or requests in progress. Deleting it will close those request tabs. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线归档、报告或压测配置<br>`components/StressExecutionSummaryView.vue` (14) | `stressPresentation.recordedSources`<br>归档没有代码实际采用的限额来源 | 本次限制来源未采集；当前准入上界不代表本次 Core 最终来源。<br>Recorded limit sources not collected; current admission bounds do not prove recorded Core limit sources. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线归档、报告或压测配置<br>`components/StressExecutionSummaryView.vue` (18) | `stressPresentation.budgetHint`<br>压测资源预算/容量详情 | 拓扑与预留是预算，不是实际观测；数值内存预算不是 RSS 硬上限。<br>Topology and reservations are budgets, not observations; numeric memory is not an RSS hard limit. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地及在线归档、报告或压测配置<br>`components/StressLoadEditor.vue` (106) | `stress.workbench.invalidInputs`<br>压测目标输入格式或映射不可用 | 输入必须是合法 JSON，名称与映射不可重复或为空。<br>Values must be valid JSON; names and mappings must be unique and nonempty. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地工作台<br>`components/StressPanel.vue` (271) | `stress.targetPolicyRisk`<br>配置压测授权策略时 | 可信目标允许真实压测流量；禁用目标始终优先，且不会被本次确认覆盖。<br>Trusted targets permit real stress traffic; denied targets always win and cannot be overridden by one-run confirmation. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地工作台<br>`components/StressPanel.vue` (278) | `stress.targetConfirmation`<br>实际目标需要额外授权 | 目标 {origin} 尚未确认。是否仅为本次运行放行？<br>Target {origin} is not confirmed. Allow it for this run only? | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地工作台<br>`components/StressPanel.vue` (279) | `stress.targetConfirmationRisk`<br>确认本次或持久目标授权前 | 请确认你拥有该目标的压测授权；loopback 目标也需要明确确认。<br>Confirm that you are authorized to stress this target; loopback targets also require explicit confirmation. | 保留在本次/项目目标批准操作旁，避免绕过授权。 |
| 本地及在线归档、报告或压测配置<br>`components/StressReportView.vue` (140) | `stress.generatorSaturated`<br>报告记录发生器达到容量上限 | 压测生成器可能已饱和；该资源边界独立于业务失败结论，请谨慎解读。<br>The stress generator may be saturated; this resource boundary is independent from business failures. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionDetails.vue` (41) | `projectWorkbench.noScriptApproval`<br>已选代理缺少项目脚本批准 | 所选代理没有受信脚本批准，需要受信脚本的任务无法运行。<br>This agent has no trusted script approval. Tasks requiring trusted scripts are blocked. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionDetails.vue` (42) | `onlineExecution.scriptCapability`<br>执行详情显示脚本能力 | 现有同步 Core pm API：变量读写、环境读取、请求/响应和断言；不支持任意 npm 模块或异步脚本生命周期。<br>Existing synchronous Core pm API: variables, environment reads, request/response and assertions. Arbitrary npm modules and async script lifecycles are unsupported. | 能力范围迁入「代理脚本、项目工具与个人设置」；实际批准状态就近显示。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionDetails.vue` (43) | `onlineExecution.projectTrustRisk`<br>已选代理信任整个项目 | 此代理信任整个项目，批准会覆盖未来脚本修改，且脚本可能读取授权认证材料。<br>This agent trusts the entire project, including future script changes. Scripts can access authorized authentication data. | 保留在获项目级信任的实际代理详情，明确未来脚本也受此批准。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionDetails.vue` (46) | `onlineExecution.scriptRisk`<br>已选代理的脚本批准详情 | 仅运行受信内部脚本；脚本可能接触授权请求中的认证材料并主动外发。node:vm 不是安全沙箱。<br>Run trusted internal scripts only. Scripts can access authorized authentication data and send it externally. node:vm is not a security sandbox. | 仅实际选择代理时在脚本批准折叠区显示，与凭据暴露风险同处。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionDetails.vue` (48) | `onlineExecution.askAdmin`<br>已选代理且当前成员不能管理其脚本审批 | 需要项目 OWNER / ADMIN 批准所需脚本版本。<br>A project OWNER / ADMIN must approve the required script versions. | 仅实际选择代理且成员不能管理脚本时保留。可管理成员看到该代理的批准入口。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionDetails.vue` (50) | `onlineExecution.pluginDifference`<br>切换目标位置后的插件能力说明 | 本机保留用户已登记的受信插件；代理只使用内置执行能力。含插件的本机任务不承诺与代理语义等价。<br>Local execution preserves registered trusted plugins. Agents use built-in execution capabilities only. Plugin-based local tasks do not promise equivalent agent semantics. | 两处重复的执行位置原理移出详情，配置与运行能力见「代理脚本、项目工具与个人设置」。实际加载的本机插件只在本机位置展示。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (160) | `onlineExecution.scriptCapability`<br>执行详情显示脚本能力 | 现有同步 Core pm API：变量读写、环境读取、请求/响应和断言；不支持任意 npm 模块或异步脚本生命周期。<br>Existing synchronous Core pm API: variables, environment reads, request/response and assertions. Arbitrary npm modules and async script lifecycles are unsupported. | 能力范围迁入「代理脚本、项目工具与个人设置」；实际批准状态就近显示。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (160) | `onlineExecution.projectTrustRisk`<br>已选代理信任整个项目 | 此代理信任整个项目，批准会覆盖未来脚本修改，且脚本可能读取授权认证材料。<br>This agent trusts the entire project, including future script changes. Scripts can access authorized authentication data. | 保留在获项目级信任的实际代理详情，明确未来脚本也受此批准。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (160) | `onlineExecution.scriptRisk`<br>已选代理的脚本批准详情 | 仅运行受信内部脚本；脚本可能接触授权请求中的认证材料并主动外发。node:vm 不是安全沙箱。<br>Run trusted internal scripts only. Scripts can access authorized authentication data and send it externally. node:vm is not a security sandbox. | 仅实际选择代理时在脚本批准折叠区显示，与凭据暴露风险同处。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (160) | `onlineExecution.askAdmin`<br>已选代理且当前成员不能管理其脚本审批 | 需要项目 OWNER / ADMIN 批准所需脚本版本。<br>A project OWNER / ADMIN must approve the required script versions. | 仅实际选择代理且成员不能管理脚本时保留。可管理成员看到该代理的批准入口。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (161) | `onlineExecution.pluginDifference`<br>切换目标位置后的插件能力说明 | 本机保留用户已登记的受信插件；代理只使用内置执行能力。含插件的本机任务不承诺与代理语义等价。<br>Local execution preserves registered trusted plugins. Agents use built-in execution capabilities only. Plugin-based local tasks do not promise equivalent agent semantics. | 两处重复的执行位置原理移出详情，配置与运行能力见「代理脚本、项目工具与个人设置」。实际加载的本机插件只在本机位置展示。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (174) | `onlineExecution.noTasks`<br>最近一页没有代理任务 | 当前页没有代理任务；只查询最近 20 条，不拉取全部历史。<br>No agent tasks on this page. Only the latest 20 tasks are requested. | 保留真实分页范围和空结果在任务表旁。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (229) | `onlineExecution.logicalTotals`<br>归档已采集逻辑执行结果 | 逻辑执行：共 {total}，通过 {passed}，失败 {failed}<br>Logical executions: {total} total, {passed} passed, {failed} failed | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineExecutionPanel.vue` (230) | `onlineExecution.requestTotals`<br>归档已采集请求事实 | 真实请求事实：已开始 {started}，已完成 {completed}，HTTP 交换 {exchanges}<br>Observed requests: {started} started, {completed} completed, {exchanges} HTTP exchanges | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineProjectAssets.vue` (324) | `onlineExecution.publishEmpty`<br>可向尚空的在线项目显式发布 | 可将有效本地项目显式发布到空的新在线项目；项目凭据值不会随定义上传。<br>Explicitly publish a valid local project into an empty new online project. Credential values are not uploaded with definitions. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineProjectAssets.vue` (344) | `onlineExecution.authInProject`<br>维护正式接口认证方式 | 接口认证在本项目维护。项目凭据默认加密保存在服务端；勾选仅本机后，只供本次本机运行使用。<br>Maintain authentication in this project. Project credentials are encrypted on the server. Local-only credentials are used only for local execution. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineProjectAssets.vue` (379) | `onlineExecution.attachmentHint`<br>选择运行所需附件或证书 | 仅上传普通文件或公共证书；私钥和口令必须使用凭据引用。未声明的文件不会从开发机路径补取。<br>Upload ordinary files or public certificates only. Private keys and passwords must use credential references. Undeclared files are never read from developer-machine paths. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (130) | `onlineStress.loopback`<br>计划目标为 loopback 或配置其执行位置 | loopback / localhost 指执行位置所在机器；切换本机或代理后必须重新确认目标。<br>loopback / localhost means the machine at the execution location. Confirm targets again after switching location. | 第三批移除无条件说明；本机地址的含义见「打开项目与选择环境」，实际目标需要授权时仍要求明确确认。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (133) | `onlineStress.agentUnavailable`<br>已选代理实际不能运行当前压测 | 所选代理当前不支持或不能运行压测，请明确选择可用位置。<br>The selected agent cannot run stress tasks now. Explicitly choose an available location. | 条件成立时就地保留原因、影响或恢复动作。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (134) | `onlineStress.environmentMismatch`<br>计划环境与当前选择不一致 | 项目执行环境与已保存计划不同，请重新选择计划环境并保存。<br>The project execution environment differs from the saved plan. Select and save the plan environment again. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (135) | `onlineStress.localMaterials`<br>计划含只供本机运行的材料 | 本次包含仅本机材料，不能在代理运行；请明确配置项目材料。<br>This run includes local-only materials and cannot use an agent. Explicitly configure project materials. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (137) | `stressPresentation.admissionHint`<br>打开当前压测准入配置 | 当前配置仅用于后续准入；不是所选历史任务的实际 Core 最终限制。<br>Current configuration applies to future admission; it is not the recorded run’s final Core limits. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (142) | `stressPresentation.budgetHint`<br>压测资源预算/容量详情 | 拓扑与预留是预算，不是实际观测；数值内存预算不是 RSS 硬上限。<br>Topology and reservations are budgets, not observations; numeric memory is not an RSS hard limit. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (149) | `stressCapacity.workerIntersection`<br>压测配置取得真实的进程数交集 | 当前总容量与策略交集：最多 {count} worker；不会自动改变本次选择。<br>Current total-capacity/policy intersection: up to {count} workers; the selected run is not changed automatically. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 在线项目，在本机或所选代理执行<br>`components/online/OnlineStressPanel.vue` (152) | `onlineStress.confirmationRequired`<br>尚未取得匹配此计划目标和位置的确认 | 本次目标尚未确认；切换位置、环境、计划、版本或 worker 数量后须重新确认。<br>Confirm targets again after changing location, environment, plan, version or worker count. | T06 操作行用“确认目标与执行位置”及按钮状态表达；运行发起页与目标变更时的阻断继续指向确认步骤。 |

## 在线计划与通知

[计划](../batch-5/R05-online-schedule.png)、[服务器预览](../batch-5/R05-server-preview.png)、[通知](../batch-5/R06-online-notification.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 在线项目<br>`components/online/OnlineNotificationsPanel.vue` (50) | `scheduleNotifications.scope`<br>打开成员通知 | 仅显示当前成员有权项目的通知；已读状态属于当前成员。<br>Only notifications from projects accessible to the current member are shown. Read state belongs to this member. | 第五批移出常态通知页；按成员读取的原行为和已读/未读操作保留。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (123) | `scheduleRun.refreshHint`<br>已保存的计划，用户展开或因目标修改展开快照刷新 | 目标、代理、环境、运行设置和材料变更需先刷新快照并明确确认。<br>Target, agent, environment, run settings and material changes require an explicitly confirmed snapshot refresh. | 只在“刷新快照”展开区保留一次，避免高级配置重复相同提示。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (124) | `scheduleRun.materialHint`<br>定时计划选择材料引用/版本 | 仅选择引用与版本，不上传秘密值；实际已保存依赖闭包由主进程核对。<br>Only references and versions are selected; no secret values are uploaded. The saved dependency closure is verified in main. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (134) | `scheduleEditor.previewHint`<br>服务器返回触发候选时 | 仅展示服务器返回的后五次候选；计划时刻不保证等于实际启动时刻。<br>Only the next five server candidates are shown; planned time does not guarantee actual start time. | 第五批改为“服务器预览”、真实候选时刻与时区，动作完成后定位到返回结果。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (139) | `scheduleEditor.queueHint`<br>展开计划排队及过期行为 | 新触发按原计划时刻加计划值与当前最大值较小者固定截止；调低上限也约束旧启用计划。已准入截止不改写，重试不续期。暂停期间不创建触发记录。<br>Each new occurrence fixes its original planned time plus the lower saved timeout/current cap, including existing enabled plans. Sealed deadlines never change or renew. Paused plans create no occurrences. | 保留在低频队列策略中，防止误读在途任务行为。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (147) | `scheduleEditor.riskHint`<br>核对计划自动触发的影响 | 计划会按固定快照发出出站请求；授权、代理、材料与运行时仍在触发时复核。<br>The fixed snapshot sends outbound requests. Authorization, agent, materials and runtime are checked again when triggered. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (147) | `scheduleEditor.scriptRisk`<br>保存或重新授权使用脚本的计划 | 受信脚本可能读取授权认证材料并主动外发；更新不会取消已经形成的任务。<br>Trusted scripts may read authorized credentials and send them externally. Updates do not cancel existing jobs. | 保留在计划授权的低频风险确认内。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (148) | `scheduleEditor.subjectHint`<br>人员授权主体需要重新授权 | 仅有效项目 OWNER / ADMIN 可将执行主体明确改为自己；重新授权后保持暂停。<br>Only an effective project OWNER / ADMIN can explicitly bind execution to themselves. Reauthorization keeps the schedule paused. | 保留在更换计划执行主体的确认处。 |
| 在线项目<br>`components/online/OnlineSchedulesPanel.vue` (149) | `scheduleRun.deleteHint`<br>删除定时计划前 | 删除会停止新触发及未提交项；取消已形成任务是另一项显式操作。<br>Deletion stops new triggers and unsubmitted occurrences. Cancelling an existing job is a separate action. | 保留在删除操作旁，区分计划及已经形成的任务。 |

## 项目工具与同步

[本地项目工具前图](before-project-tools-local.png)与[后图](after-project-tools-local.png)、[在线项目前图](before-project-tools-online.png)与[后图](after-project-tools-online.png)、[Mock 停止状态](mock-stopped.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 本地项目工具或本地磁盘操作<br>`components/ImportWizard.vue` (312) | `import.planSummary`<br>生成导入计划后，核对具体变更数量 | 新增 {added} · 覆盖 {overwritten} · 跳过 {skipped}<br>Added {added} · Overwritten {overwritten} · Skipped {skipped} | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地项目工具或本地磁盘操作<br>`components/MockPanel.vue` (224) | `mockPanel.simulated`<br>Mock 当前为仿真状态 | 当前为内存仿真状态；此处不会启动 HTTP 服务。<br>Simulated in-memory state; no HTTP server is started here. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地项目工具或本地磁盘操作<br>`components/MockPanel.vue` (226) | `mockPanel.unsaved`<br>Mock 配置草稿有修改 | 配置草稿尚未保存。启动和重载使用最近一次保存的快照。<br>Unsaved draft. Starting and reloading use the last saved snapshot. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地项目工具或本地磁盘操作<br>`components/MockPanel.vue` (227) | `mockPanel.savedSemantics`<br>已读取 Mock 状态 | 启动和重载使用已保存项目快照，不会使用此编辑框中的草稿。<br>Start and reload use the saved project snapshot, not edits in this box. | 迁入「代理脚本、项目工具与个人设置」。有未保存草稿时单独告知启动和重载实际采用的快照。 |
| 本地项目工具或本地磁盘操作<br>`components/MockPanel.vue` (228) | `mockPanel.staleDraft`<br>Mock 已保存快照与本地草稿不一致 | 编辑期间已保存项目发生变化。草稿已保留；请先切换到已保存版本再继续编辑。<br>The saved project changed while this draft was edited. Your draft is preserved; use the saved version before editing again. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地项目工具或本地磁盘操作<br>`components/MockPanel.vue` (245) | `mockPanel.noConfiguration`<br>项目尚无可用 Mock 配置 | 尚无已保存的 Mock 配置，请先保存后再启动。<br>No saved Mock configuration yet. Save one before starting. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地项目工具或本地磁盘操作<br>`components/ProjectAssetsPanel.vue` (259) | `projectTools.assetChanged`<br>当前编辑的工具资产在磁盘已变更 | 已保存的资产发生变化。载入最新版本后可以继续编辑。<br>The saved asset changed. Load the latest version to continue editing. | 保留在受影响的资产编辑区，重新载入最新版本后才可继续。 |
| 本地项目工具或本地磁盘操作<br>`components/ProjectAssetsPanel.vue` (282) | `projectTools.assetChanged`<br>当前编辑的工具资产在磁盘已变更 | 已保存的资产发生变化。载入最新版本后可以继续编辑。<br>The saved asset changed. Load the latest version to continue editing. | 保留在受影响的资产编辑区，重新载入最新版本后才可继续。 |
| 本地项目工具或本地磁盘操作<br>`components/WorkspaceDiskUpdates.vue` (39) | `diskUpdate.previewStale`<br>打开磁盘变更预览后收到新版本 | 打开预览后磁盘又有变化，请核对最新变更后再应用。<br>The disk changed after you opened this preview. Review the latest changes before applying. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncDiffView.vue` (23) | `sync.fixedSummary`<br>打开固定候选的变更摘要 | 以下是固定候选的有界业务摘要；原文不会因预览截断而改变。<br>These bounded summaries describe a fixed candidate; preview truncation does not alter source bytes. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncDiffView.vue` (33) | `sync.fixedDocumentNote`<br>展开对应变更的完整文档 | 这是该变更所属固定资产文档的全文，并非仅包含此字段。字段位置：<br>This is the complete fixed asset document for the change, not only this field. Field location: | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncHistory.vue` (11) | `sync.rollbackConfirm`<br>从同步历史申请创建回滚版本前 | 确认按此持久历史创建回滚版本？后续编辑或引用变化可能使其拒绝。<br>Create a rollback version from this durable history? Later edits or reference changes may prevent it. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncPanel.vue` (44) | `sync.approvalScope`<br>确认本次同步的网络目标 | 每次检查仅批准当前主机、端口与 IP 地址；跨来源重定向将拒绝。<br>Only the approved host, port and IP addresses are allowed for this check; other origins are rejected. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncPanel.vue` (65) | `sync.nextCheck`<br>修改同步获取配置 | 配置修改从下一轮检查生效；在途检查保留原配置。<br>Changes apply to the next check; active checks keep their captured configuration. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncPanel.vue` (65) | `sync.diskThreshold`<br>同步设置页的磁盘阈值说明 | Git 磁盘值为采样监测阈值，不是操作系统零超量硬配额。<br>The Git disk value is a sampled threshold, not a zero-overrun operating-system quota. | 采样阈值的原理移至「代理脚本、项目工具与个人设置」。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncPanel.vue` (65) | `sync.projectBytes`<br>同步设置页的字节预算说明 | 内容总字节额度仍按项目与宿主计算，不按来源拆分。<br>Total content bytes remain bounded per project and host, not per source. | 项目与宿主的预算计量范围移至「代理脚本、项目工具与个人设置」。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncPanel.vue` (65) | `sync.invalidPolicy`<br>实际发现上级策略使已保存配置无效 | 同步策略无效：上级限制已变化，请由管理员修复已保存值后再检查。<br>Synchronization policy is invalid: upper limits changed. An administrator must repair saved values before checking. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncPanel.vue` (66) | `sync.sshMissing`<br>找不到可用的 SSH 工具 | 未找到 OpenSSH，请选择已安装的受支持工具。<br>OpenSSH is not installed; select an installed supported tool. | 条件成立时就地保留原因、影响或恢复动作。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncSourceForm.vue` (55) | `sync.referencesOnly`<br>维护外部来源认证与工具绑定 | 来源仅保存引用。密钥与本机工具路径由主进程保管。<br>Sources store references only. Keys and native tool paths stay in main. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地及在线来源按对应项目权限<br>`components/sync/SyncSourceForm.vue` (55) | `sync.editEnabled`<br>修改仍已启用定时检查的来源 | 请先明确关闭已启用的计划，再编辑来源并重新授权。<br>Disable the enabled schedule before editing its source and explicitly reauthorizing it. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |

## 分享与 AI 弹层

以组件实际条件、已有受权预览及脱敏测试为证据。本轮没有为表中每一种授权条件单独拍图。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/AiConfigDialog.vue` (40) | `aiSettings.offline`<br>打开 AI 配置，核对保存、连接测试与模型发现的影响 | 保存仅更新本机配置；连接测试与发现需显式触发，可能产生费用，不发送项目资料。<br>Saving updates local settings only. Explicit tests and discovery may incur charges; no project data is sent. | 条件成立时就地保留原因、影响或恢复动作。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/AiSuggestionsDrawer.vue` (56) | `ai.selectionNotice`<br>AI 建议选择材料与候选条目时 | 默认保留完整证据；正文默认关闭。改变选择会使旧预览失效，必须重新预览后再确认外发。正文变化后须重新勾选证据。<br>All evidence is retained initially; bodies are off by default. Changes invalidate the old preview. Prepare and review a new preview before confirming. Body changes require selecting evidence again. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/AiSuggestionsDrawer.vue` (60) | `ai.catalogCounts`<br>目录已返回候选数量 | 共 {total} 项 · 可选择 {selectable} 项 · 目录省略 {omitted} 项<br>{total} total · {selectable} selectable · {omitted} omitted from catalog | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/AiSuggestionsDrawer.vue` (61) | `ai.catalogIncomplete`<br>AI 可用目录被截断或不完整 | 此选择目录不完整；原报告及超出目录的证据均保留，未自动发送或恢复正文。<br>This selection catalog is incomplete. The original report and evidence beyond the catalog remain intact; bodies are not automatically sent or restored. | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/AiSuggestionsDrawer.vue` (127) | `ai.scriptTrustWarning`<br>建议采用脚本时 | 脚本采用后可执行受信代码。请完整审阅源码并确认信任后再采用。<br>Adopted scripts can execute trusted code. Review the complete source and confirm trust before adopting. | 保留在使用建议脚本的授权上下文。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/ai/AiAssertionSuggestions.vue` (18) | `ai.judgmentRequired`<br>AI 仅有观测建议，需人工判断断言 | 此观测建议需要人工判断，不能将失败响应自动解释为契约允许值。<br>This observed suggestion requires human judgment. A failed response does not automatically become an allowed contract value. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/ai/AiConnections.vue` (104) | `aiSettings.rebind`<br>模型端点或认证发生变化 | 地址或鉴权已修改；保存后须显式重新绑定凭据，再进行测试。<br>Address or authentication changed. Save and explicitly rebind credentials before testing. | 条件成立时就地保留原因、影响或恢复动作。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/ai/AiConnections.vue` (109) | `aiSettings.secureUnavailable`<br>系统安全存储实际不可用 | 安全存储不可用。请显式选择仅本次会话，不能持久化或降级为明文。<br>Secure storage unavailable. Explicitly select session-only use; persistence and plaintext fallback unavailable. | 条件成立时就地保留原因、影响或恢复动作。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/ai/AiOutboundPreview.vue` (38) | `aiSettings.budgetNotice`<br>核对 AI 外发预览中费用与预算 | 预算是限额，不是精确费用或实际用量；输入 Token 计数与上下文窗口用量仍未确认。<br>Budgets are limits, not exact cost or actual usage. Input token counts and context-window usage remain unconfirmed. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 应用模型设置、受对应材料权限约束的 AI 操作<br>`components/ai/AiOutboundPreview.vue` (49) | `ai.heuristicRedaction`<br>提交外发预览前核对材料 | 已使用启发式脱敏；不能保证识别所有敏感内容，请在外发前审阅。<br>Heuristic redaction cannot identify all sensitive content. Review before sending. | 保留在发出前的材料预览，允许用户检查实际外发内容。 |
| 本地材料发布至在线项目、在线分享与授权<br>`components/online/CollaborationPanel.vue` (41) | `collaboration.durationRange`<br>设置共享授权的有效期 | 最短 60,000 ms；当前最长 {maximum} ms<br>Minimum 60,000 ms; current maximum {maximum} ms | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 本地材料发布至在线项目、在线分享与授权<br>`components/online/PublicationPreview.vue` (23) | `collaboration.reselectHint`<br>发布候选来源已失效 | 重新选择来源并预览，不自动重发<br>Select a source and preview again; no automatic retry | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 本地材料发布至在线项目、在线分享与授权<br>`components/online/PublicationPreview.vue` (29) | `collaboration.localNoNetwork`<br>选择发布目标或生成本机外发预览 | 此阶段尚未发送任何网络请求；强制遮罩仍有效。不承诺识别所有业务秘密，请核对安全内容。<br>No network request has been sent at this stage. Mandatory masking remains active. Not all business secrets can be detected; review the safe content. | 保留在本机候选的材料预览，让用户检查已遮罩的实际内容；目标选择层已去重。 |
| 本地材料发布至在线项目、在线分享与授权<br>`components/online/PublicationPreview.vue` (34) | `collaboration.policyNotAuthority`<br>进入发布的服务端预览阶段 | 策略允许不等于本人成员权限，也不代表公开服务已就绪；发布与授权仍会重新核对当前权限、预算和版本。<br>Policy allowance is not your member permission or public-service readiness. Publication and grants recheck current authority, budgets and revisions. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 本地材料发布至在线项目、在线分享与授权<br>`components/online/PublicationPreview.vue` (37) | `collaboration.retentionIndependent`<br>核对分享复制与授权的保留时间 | 成员上传历史和固定副本独立保留；授权另有到期时间。关闭预览不会撤销已有授权、停用独立服务或取消服务端任务。<br>Member upload history and fixed copies have independent retention; grants expire separately. Closing preview does not revoke existing grants, disable an independent service or cancel a server task. | 保留在服务端分享核对中，手册「代理脚本、项目工具与个人设置」补充后续停止分享入口。 |

## 个人设置

[设置前图](before-settings.png)与[后图](after-settings.png)。

| 模式、组件和原行号 | 原键与显示条件 | 原中文 / English | 处置与现文 |
| --- | --- | --- | --- |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/NetworkSettings.vue` (286) | `networkSettings.note`<br>用户打开该配置或认证管理页 | 配置保存在本机并仅用于当前项目的新运行任务；运行中的任务继续使用启动时捕获的配置。<br>Stored locally for this project and applied to future runs. Running jobs keep their captured settings. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/OnlineExecutionCacheSettings.vue` (60) | `executionCacheSettings.localOnly`<br>打开本机在线执行缓存设置 | 仅保存在本机，保存后对可安全清理的非活动缓存生效。<br>Saved on this device only. Saving applies to inactive caches that are safe to release. | 保留在该操作或状态旁，供用户核对当前对象、权限或变更的影响。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/OnlineExecutionCacheSettings.vue` (66) | `executionCacheSettings.range`<br>数量、时长、容量三项设置的输入字段 | 默认 {default} {unit}；范围 {min}–{max} {unit}<br>Default {default} {unit}; range {min}–{max} {unit} | 保留实际数量、限额、单位或明细边界，随当前数据更新。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/OnlineExecutionCacheSettings.vue` (68) | `executionCacheSettings.zeroHint`<br>配置最大缓存个数时 | 0 表示不保留可安全清理的非活动上下文。<br>0 keeps no inactive contexts that are safe to release. | 保留在对应字段或操作边，提供填写方法、格式或生效范围。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/OnlineExecutionCacheSettings.vue` (81) | `executionCacheSettings.overLimit`<br>实际用量超过预算且含保护记录 | 当前占用超过缓存边界，受保护记录仍会保留，不会被强制释放。<br>Current usage exceeds the cache boundary. Protected records are retained and will not be forcibly released. | 保留实际超限与保护状态，不因移出清单而丢失原因。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/OnlineExecutionCacheSettings.vue` (82) | `executionCacheSettings.protection`<br>打开缓存使用量区 | 当前上下文、在途本机请求、未释放或待归档代理任务，以及结果不确定的记录会保留；受保护记录可能使总占用超过设置，不能为达标强制驱逐。<br>The current context, pending local requests, agent tasks awaiting release or archive, and uncertain results are retained. Protected records may exceed these settings and are never forcibly evicted to meet them. | 保护清单迁入「代理脚本、项目工具与个人设置」。使用量、受保护数量及超限原因仍在设置页。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/PluginsView.vue` (35) | `plugins.refreshHint`<br>打开本机插件页 | 刷新仅重新查看当前进程的加载结果，不会热加载；修改清单后请重启。<br>Refresh shows the current process loading result. Changes require a restart; plugins are not hot reloaded. | 刷新原理迁入手册「代理脚本、项目工具与个人设置」，页面保留实际加载结果。 |
| 桌面本机设置；缓存统计对应已打开的在线上下文<br>`components/PluginsView.vue` (39) | `plugins.emptyGuide`<br>插件清单为空 | 在用户级清单 ~/.apicc/plugins.json 登记插件后重启即加载，失败不阻断且在此展示原因；开发与发布指南见 docs/plugins.md<br>Register plugins in the user-level manifest ~/.apicc/plugins.json and restart to load them; failures never block startup and their reasons are shown here. See docs/plugins.md for authoring and publishing. | 缩短至安装位置、重启及插件指南；已加载、失败原因仍按插件报告。<br>现文 在 ~/.apicc/plugins.json 登记插件后重启。安装方法见 docs/plugins.md。 / Register plugins in ~/.apicc/plugins.json and restart. See docs/plugins.md. |
