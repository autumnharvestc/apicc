# F8 前端 P2 定向独审

日期：2026-11-08。工作树 `C:/Users/imini/.codex/worktrees/f8-frontend-polish/apicc`，分支 `codex/f8-frontend-polish`，基线 `569f7bf257b8387b51879b17512a44b080f89278`。沿用当前独审配置。未使用 superpowers 或同源别名技能，未开新 agent，未运行测试/构建/全量，未修改产品、测试或 Git 状态；只写本地审查回执。

## 最终结论

已完成七个 P2 组件的完整 delta、相关模板/样式和直接调用关系审查，以及新 ProjectCard 测试与其原始 RED 日志核对。后续只针对实际浏览器发现的 SideTree 按钮导入/新增测试和主题选中文字低对比做了定向复核；后者仅增加共享 theme.css 两条深色文字选择器，本组最终为八产品文件。最终清单、文档、日志和六张实际组件图像封存核对完成，当前没有有证据的未关闭 P0/P1/P2，P2 本组可以结项并继续既定后续批次。此结论不等于整个第三批、原生端到端或所有深色页面已验收。

已阅读本工作树 `AGENTS.md`、`docs/ui-presentation-guidelines.md`、设计 §8 与验收矩阵。没有重开已审 P1 八文件、整个分支或 P3 全面业务可读性审查。用户要求的固定主页由原 P1 ProjectTabs 保留，P2 没有修改该文件或用新导航取代主页。

## 已关闭 P2：深色选中文字对比不足

实现者集中观察到 Antd 选中页签/HTTP 单选标签为 `rgb(45,84,201)`，其背景观测为 `#1f2937`。本独审打开当前 `editor-en-dark-900.png`，确认 Path parameters、Body 与 HTTP 选中文字相对背景明显偏暗；另打开长响应滚动图核对证据语境。这些是实际组件+合成数据图，不是完整 App/native 证明。

按 sRGB 相对亮度公式，这组前景/背景的对比为2.25297656:1。若采用当前源码 theme.css 的 `--bg:#1c2636`，仍只有2.33577961:1，结论不因背景差别消失。这些13px标签不是 disabled，也不是大号文字；[W3C 普通文字参考值为至少4.5:1](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。当前 App 的亮/暗共用 `colorPrimary:'#315fe9'`，实际安装的 Antd Tabs active 直接取 token.colorPrimary，Radio checked/solid 共用由 colorPrimary 派生的 radioCheckedColor，因而这不是仅靠业务组件已有 `--accent` 就能修复的问题。

最小安全方向：仅 dark 模式调整 Tabs 及非 solid Radio 的选中标签文字，覆盖对应 hover/active，保留 disabled 与浅色。Tabs 可用组件级 alias token；Radio 若直接覆盖组件 colorPrimary，需要同时考虑 solid 变体，最窄可仅对非 solid 的可用选中文字使用现有浅蓝 `--accent:#9ab8ff`。不要把全局 colorPrimary 一律改成该浅蓝：白色文字对 #9ab8ff 只有1.96736040:1，会把问题转移到主按钮。最后读取真实 computed 文本/叠加后背景、必要两处状态及白字按钮即可，不因此重跑70项或重新宽审共享主题。

定向复核：实现者确认此前 `#1f2937` 是粗读误差，最终 computed 背景为源码一致的 `#1c2636`；真实初始对比应为2.33577961:1，仍为有效缺口。本次 theme.css 只对 `html[data-theme=dark]` 下有效 active tab 的 btn、非 solid group 下 checked 且非 disabled 的 radio wrapper 指定 `color:var(--accent)`。其特异性高于已读取的 Antd checked:hover/:active，保留 disabled 和 solid，完全不改 seed、背景或主按钮文字。因此实际 hover 的浅蓝得以保持；pressed 只按选择器静态核对，没有冒称浏览器按下态实测。

已打开更新后的 `editor-en-dark-900.png`，Path parameters/Body/HTTP 选中文字清晰；另打开实际 Antd 边界夹具 `theme-boundaries-dark.png`，可见 disabled 仍灰、solid 与 primary 仍为白字蓝底。夹具 entry.ts 真实导入 Radio/Button 和当前 theme.css，没有用手画色块代替控件。独立重算对比：Tabs #9ab8ff/#1c2636 为7.73555077:1，outlined Radio #9ab8ff/#141414 为9.36408808:1，primary 白字/#2d54c9 为6.51543329:1；与实现者最终 computed 回执一致。本独审没有重操浏览器，实际 hover/颜色值采用主会话当次观察，图像只证明其捕获状态。

已读 `build-renderer-contrast.log` 的完成记录和原 chunk 警告。本项可以关闭，无新阻塞；不将本次两处修复称为所有深色页面完整验收。当前源码 theme.css 已有 P2 增量，原 P1 包及其旧清单保持原归属，最终文档不能继续声称当前全部八个 P1 源码与旧清单一致。

## 调用关系与功能边界

| 候选 | 直接调用/共享影响与已核对不变量 |
| --- | --- |
| HomeView | App 的主页装配；内部 ProjectCard/ConnectionPanel。分组、目录打开/新建、项目新增/导入、服务器选择/登录、在线刷新及只读卡片仍在原分支和原事件绑定上；完整 locator 与只读门控未改。长名称增加 title，布局/动作显隐改变，未改变 workspace 或 connections store 逻辑。 |
| ProjectCard | HomeView 本地卡片和在线 plain 卡片。项目名成为原生 type=button，`@click.stop` 恰好发一次 open，卡片空白处仍由原根 click 打开。更多触发器保留父层 stop、增加 click trigger 和本地化可访问名称；菜单 rename/clone/move/remove 绑定原字节保持，plain 仍不渲染本地管理动作。没有在 button 中嵌套另一个 button。 |
| ConnectionPanel | HomeView 连接管理视图。新增 conn-info/conn-actions 只是无事件包装 div，所有按钮仍绑定原 edit/login/browse/remove 方法，未新建表单提交。保存目标同一性、重复地址验证、原身份更新、登录 setActive、browse refresh/emit 与删除逻辑未改。 |
| SideTree | App 的本地/在线树，含 scoped 项目根和只读模式。CSS 同时影响旧分组/项目/工作流动作与现有接口/目录动作轨道；树数据、过滤、选中、展开、增删改、more 菜单及 readonly 分支不变。没有因新的显隐策略删除按钮或改事件归属。 |
| RequestTabs | App 的接口/自由请求页签。完整项目过滤、关闭前草稿确认、关闭取消、激活及新自由请求门控不变；标题增加完整 title。页签自身横向滚动、关闭按钮 flex:none，项目外的同名请求没有被本次 CSS 重新纳入。 |
| RequestEditor | App 的调试编辑区。修改仅 scoped CSS；协议/认证/脚本、元数据/组件绑定、正文/文件、发送/取消、恢复阻断、资产与自由请求保存分支未改。参数行允许换行，Schema 独占一行，checkbox/button 保持自身尺寸，没有把控件包装成新的提交/取消目标。 |
| ResponseViewer | App 调试结果、TestView 单接口结果，以及 OnlineExecutionPanel 的 debug 结果共享同一组件。结果选择、tab/交换次序、搜索/格式、剪贴板、下载、断言与错误事实未改；api 可选仍保持，未假设另外两个调用方都提供下载 IPC。既有请求/响应原文查看继续允许 JSON，本轮没有宣称已解决结果控制台等 P3 可读性项目。 |

## 样式和操作可达性

- HomeView 的分组动作与 SideTree 旧动作由 display:none 改成保留布局、opacity/pointer-events 控制。按钮仍可通过 Tab 获焦；所在行的 focus-within 同时恢复可见与 pointer-events；hover:none 规则显示动作。卡片也支持 focus-within 和 hover:none。未发现新的只依赖鼠标悬停的入口。
- 卡片的项目名按钮和更多按钮是独立操作，长名称仍 ellipsis/title。ProjectCard 更多按钮原来已有父层 stop，本轮不是修复一个已证实的旧菜单冒泡 bug；新的 name.stop 则保护新增原生按钮不向卡片根重复发 open。
- ConnectionPanel 的 field/conn-row/actions 均允许换行，文字区 min-width:0，URL 的既有断词保留；新增 action 包装没有引入 overflow:hidden。是否在实际英文窄窗正常换行仍须看组件证据。
- RequestTabs 页签项 flex:none，内部名字省略与关闭按钮保留；横向滚动边界在 list，不把新请求按钮挤入滚动列表。焦点采用内部 offset，不凭静态 CSS 声称末签聚焦实测通过。
- RequestEditor 保留 header flex:none、内容 min-height:0/overflow:auto；响应区域保留自身 overflow:auto。元数据改自适应列，参数行子项 min-width:0；正文和 Schema 的业务输入规则不变。极短窗口时非滚动头部可占高度，不能仅据这些约束宣称 287px 原生窗口已验收。
- 已读取当前安装的 Antd Tabs 样式：nav 为 flex:none，nav-wrap flex:auto/overflow:hidden，extra-content flex:none，content-holder min-width/min-height:0。本次响应区允许 nav 换行并限制 extra-content 宽度，没有覆盖内部 tab-list 的位移逻辑或直接隐藏标签；实际窄宽度下 extra/标签可达、sticky 工具条与大正文滚动仍需要实际组件观察。

## 测试与证据边界

已读取新增 `ProjectCard.test.ts` 及 `local/f8-frontend-p2/project-card-red.log`。三个用例真实挂载 ProjectCard 并使用 i18n：非 plain 名称按钮点击一次、更多按钮不打开卡片、plain 仍可键盘入口且无管理按钮。旧实现的 RED 是两项没有原生名称 button、另一项没有 aria-label；日志没有证明旧菜单 click 曾向卡片根冒泡，因为该用例在缺少 aria-label 处已先失败。这里没有把测试数量或 RED 的含义扩大为触摸、真实键盘和浏览器布局已通过。

本审查不运行测试。已读取实现者本地六份首轮日志：ProjectCard+ConnectionPanel 两文件13通过；components 47通过/26未选；contractAssets 5通过/14未选；App 5通过/53未选。合计70是四轮具名选择运行的通过数，不是单轮全应用测试。Vue 类型检查日志和 renderer 构建完成日志已读；保留 jsdom pseudo-element 提示与大 chunk 构建警告，不称无警告。最终具名命令/选择范围、浏览器回执及清单已按下节收口。

P1 原 54 项及已交付 P1 包不作为 P2 新验证。最终需区分真实组件+合成 props 与真实后台/IPC/原生包，窄/短窗口、长名称、键盘焦点、动作显隐及共享 ResponseViewer 应按本组实际覆盖如实记录。未要求因此扩大测试或重跑全量。

### SideTree 实际发现后的定向复核

实现者在实际浏览器发现未 scoped 的树根部“新建分组”没有导入 AButton。本独审核对 `main.ts` 确实没有全局 Antd 注册，旧组件只导入 ATree/ATooltip，真实模板在 `!scoped && !isReadOnly` 分支直接使用 a-button。因此不能把旧自定义 A-BUTTON 元素当作原生可聚焦按钮。此为既有缺口，并非本组 CSS 引入；初次静态结论没有提供该入口已真实可聚焦的证明。

产品修订只有现有 ant-design-vue 导入增加 `Button as AButton`，与模板根部唯一 a-button 对应，没有修改创建/权限/readonly 条件。新增 components 测试通过实际 SideTree+内存 API/store+i18n 装配，没有全局 Button stub：断言 BUTTON、type=button、可见中文名，点击打开真实 ConfirmDialog 并取消，再断言 readonly 不显示入口。它没有仅检查 resolve 警告是否消失。`tree-button-red.log` 原始失败明确为 A-BUTTON≠BUTTON，确证前提有效；`tree-button-green.log` 为 SideTree 整组18通过/56未选，未把新旧重叠用例合计成88个不同通过项。最终 Vue/renderer 复验及修订后截图已核，不把旧树图冒充已修按钮图。当前代码和新增测试不构成新的阻塞发现。

## 最终证据封存

已读取最终 validation、design §8、acceptance 和工作记录的 P2 追加内容。首轮70通过/93未选，树复验18通过/56未选且其中17重复，因此去重71项成立；没有合并称为单轮71全绿。首轮其他分组没有因树 import 或纯 CSS 修正重跑，也没有被伪称在最后源码上全部重新执行。树修正后的 Vue/renderer 日志和选中文字修正后的 renderer 日志均有相应完成记录，主会话记录退出0；本独审没有自行执行这些命令。未执行全量/完整CI/Java全套的限制清楚。

实际打开六张 PNG，内容与本组目标一致：主页卡片的名称按钮/焦点与长名省略、连接管理长 URL 与四操作、中文编辑区/参数 Schema/响应、900px 英文深色换行、长响应工具栏/搜索，以及 disabled/solid/primary 主题边界。正文/Schema 是明确允许的业务原文，未用其 JSON 主张配置/状态可读性已全面完成。树行/按钮尺寸、末请求签横向滚动/Enter/关闭、名称 Enter 一次与更多菜单隔离、连接编辑及发送/保存计数采用主会话当次浏览器观察回执；本独审没有重新操作浏览器，也没有把截图当作完整交互轨迹。

已读取本地 Vite 夹具，别名从该夹具所在本工作树推导，导入实际 HomeView（内部 Card/Connection）、SideTree、RequestTabs、RequestEditor、ResponseViewer、主题与真实 Antd 边界控件。它的内存 props/store、计数、固定分区和镜像 ConfigProvider 是明确合成装配，不是实际 desktop App、真实连接认证、落盘/网络发送或可拖拽原生布局的证明。其局部布局证据没有取代那些后续验收。

浏览器控制台原始记录包含历史 AButton 未解析、既有 Tabs 插槽弃用（工具 level=error，但消息明确为 Warning）以及边界 h() 字符串 slot 性能提示。最终文档保留这些来源与历史时点，没有清空历史日志冒充零错误。最终浏览器回执分别记录 Tabs 初始2.336→7.736、Radio 在自身 #141414 背景初始2.828→9.364；更早按工作区背景2.34的描述不应理解为 Radio 自身实际背景。两者均低于4.5的原结论及修复后关闭结论不受影响。

最终 `p2-evidence-manifest.json` 共33项：8产品、2测试、13日志、6PNG+1浏览器回执、3夹具，逐项实际 SHA256 全部匹配；10源码/测试与本报告已审哈希均一致。P1 清单另核七个未修订产品仍一致，theme.css 的 P2 增量已单独归属；旧 P1 清单/交付包不被当前源码冒充更新。本次没有重新核230MB交付zip或运行包，仍只按此前交付事实与本组文档边界引用。

剩余边界保持：原生287px极短窗口、缩放、拖动分隔及真实后台/IPC完整新包链留P5；鼠标/触摸全部状态、所有错误/离线/只读组合未逐页复验；P3复杂结果/报告/AI/同步/工作流和P4管理台/公共查看/离线报告仍未完成。P2可结项不关闭这些项目。封存后仅文档/证据变化不重开源码宽审，产品变化仅复核具体delta。

| 本次最终文档/清单 | SHA256 |
| --- | --- |
| docs/design/f8-frontend/p2-evidence-manifest.json | 71ef6914db725c6a35b9e33eb47b5188b2a8dd9192e2f9f793482c8959319872 |
| docs/f8-frontend-polish-p2-validation.md | 30ffeb034b5ddf389f1d1bc3fc84fc2e468bc16e984ea7e90e24cc01fb772e0e |
| docs/f8-frontend-polish-design.md | d520a18e6f0b3a53b59042e20a8fcbbd81a962c8e1a7031785444e0189bf6cb2 |
| docs/f8-frontend-polish-acceptance.md | 8340466ec025a0d01c1fdb3c899cd8f7926c6050ff64e71602b3adb914fb961b |
| docs/f8-frontend-polish-worklog.md | 3b9adf62f141aa4674bb2a0870cef4f05ce410ebb9f90a5dc47a67d09a4e3abd |

## 已审源码和测试字节

| 路径 | SHA256 | Git blob |
| --- | --- | --- |
| apps/desktop/src/renderer/src/components/HomeView.vue | de31d4c2d63f071123cd42ddc36df664f402649a789861c0f0ad1a74cc322735 | b9a8117a4c2e215295992086cf486993be5d7367 |
| apps/desktop/src/renderer/src/components/ProjectCard.vue | 1b4c1947d2e0b4ee5879c04be42aa6396287930d88e50a2c1460d7bc9bd513bc | c0ccedac28d74fbf2ca6925d03629298ce543715 |
| apps/desktop/src/renderer/src/components/ConnectionPanel.vue | d5e6b3ad328d299892bb78eb8f3038dce23db10697e94a1ea4cb5bef00005b33 | 59a2ff5df2f51bbde7baf9e3036704eec39949a2 |
| apps/desktop/src/renderer/src/components/SideTree.vue | e019410965ac2051c6c7c1f4334c4f570363f9d7ce46c7ccf735413a4b26ba04 | 601013eb1fdafd0d6ab34c13a82f16ae168e7bbd |
| apps/desktop/src/renderer/src/components/RequestTabs.vue | 7fc66552a69f068452f954e9da9f9b0f107561d336b7bb9b7be6b6687b714876 | bc7310520c80bf525e97e83e2153cb78c58ea473 |
| apps/desktop/src/renderer/src/components/RequestEditor.vue | 4d5f928f2370501522f28d5aa1b3cdb6c096efa3a12b7f6ac3ca147db8839585 | f48860d56cb8486d9c17022c5056cf7033e32514 |
| apps/desktop/src/renderer/src/components/ResponseViewer.vue | 0fa393bf52cb34d224840f4ecb8459049a600743ca8ee2158142c3611766b68c | ec2e360b5aaae80982317fe7e57ba10d464029ef |
| apps/desktop/tests/renderer/components/ProjectCard.test.ts | c0e24d16179b157de7b93e301fa1aa61636f73aec0dabc93919a40261f01ae38 | 85d8ab9ba5454683478b6068b93ae2974a251377 |
| apps/desktop/tests/renderer/components/components.test.ts | ae12b6d425ce0d94f97a6709f8b87e601951695368d06e4d940c6add46ae5402 | 67b1b287445c341e71212ecbec175bd7717cd720 |
| apps/desktop/src/renderer/src/styles/theme.css（仅定向复核 P2 两条深色选择器；P1 部分沿用前审） | 32985afdd8163ae714ca058eb238ff1589f93fb848e1717d5eda17fd3d4d768f | 495ea3ef9bbb2cfb5e968c28e1aa7c19d3ad8f9d |

如果以上产品字节冻结，后续只核本组证据/文档及清单，不重新宽审；若修订，针对具体 delta 及必要相邻影响复核。
