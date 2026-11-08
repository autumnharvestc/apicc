# F8 前端 P1 定向独审

日期：2026-11-08。工作树 `f8-frontend-polish/apicc`，分支 `codex/f8-frontend-polish`，基线 `569f7bf257b8387b51879b17512a44b080f89278`。沿用当前独审配置；未使用 superpowers 或同源别名技能，未开新 agent，未改产品/测试，未运行测试、构建或全量，只写本地审查回执。

## 当前结论

8 个产品候选文件的静态审查及本组最终证据核对完成，当前未发现有证据的新增 P0/P1/P2。修改仅为主题 token、样式和管理台样式引入；没有删除固定主页、现有功能入口，也没有修改 store、IPC、路由/角色守卫、草稿或执行逻辑。八个实际 SHA256/Git blob 与下表初审值完全一致，没有冻结后产品漂移。

本组 P1 共享基础的具名测试和实际组件证据核对通过，可继续既定 P2。此结论不表示整个第三批、P2–P5 或完整业务验收完成；样板确认没有替代产品证据。原生 287px 窗口及后续逐页验收仍按矩阵分开，不因共享 CSS 编译成功自动关闭。

已读本工作树 `AGENTS.md`、`docs/ui-presentation-guidelines.md`、设计文档特别是 §7、完整验收矩阵。样板仅作为已确认方向，未把未展开功能视为删除授权，也没有将样板 JS/CSS 当作实际产品组件。

## 共享影响与功能不变量

| 共享入口/消费者 | 已核对的实际调用方和影响 |
| --- | --- |
| desktop App/ConfigProvider | App 全局装配；所有后代 Antd 控件接收新字号/主色/尺寸/圆角。locale 和既有 themePreference→algorithm 计算保持，CSS html[data-theme] 的浅/深两组变量仍保留。 |
| desktop theme.css | 现有共享色值变量的实际消费者检索为68文件，覆盖原生表单、弹窗、编辑/响应、报告、AI、同步、协作及在线组件；另有 ModuleRail 新 rail 变量。这里只声明共享影响已枚举，不称68文件逐页视觉验收通过。新增焦点选择器使用 :where，低特异性，没有一律覆盖组件自己的焦点样式。 |
| TopBar | 唯一生产调用方为 App；ProjectTabs 唯一生产调用方为 TopBar。主入口/更多菜单的在线、管理连接、设置、迁移、退出及主题/语言绑定均未改。窄屏既有更多菜单仍保留隐藏按钮的对应入口；本次只改高度/间距/色彩及更多菜单焦点。 |
| ProjectTabs | 固定主页仍为独立首按钮、flex:none、没有关闭钮；项目区独立 overflow-x:auto。项目激活、离线重试、草稿确认、取消/确认后的关闭驱逐、键盘 Home/End/左右切签均原字节保持。关闭按钮命中区增大，没有改变 click 归属。 |
| ModuleRail | 唯一调用方为 App；SWITCH_VIEWS、disabled gate、emit 与首页显隐未改。新增 flex:none/min-height 保持按钮命中区，短高度用轨道自身 overflow-y:auto，不改禁用依据。 |
| desktop App shell | 树列仍固定宽度、min-height:0/overflow约束及内容 flex 保留；仅树壳背景/头部搜索间距、接口头分隔变化。分隔拖拽、响应面板尺寸及模块内容装配未改。 |
| admin App/ConfigProvider | 包含登录页及全部 LayoutView 子路由，因全局 theme 引入而影响所有 Antd 控件；不是新增管理台深色主题开关。原 i18n/locale 消费保留，新的原生变量还由 StressCapacityView 等消费者使用。 |
| admin LayoutView | 唯一生产装配点为认证父路由；session SUPERADMIN、workspace OWNER/ADMIN 和普通成员的菜单条件、路由参数选择、登出顺序原字节保持。策略、授权、成员、组织、代理、定时、同步、通知、协作、平台入口均仍在模板，没有为样板删项。 |

草稿与权限“代码未改”不能替代对应交互正证，但本次不存在以样式接入为名改动它们的逻辑 delta。D06 固定主页要求在实际组件中仍有完整实现；是否始终可见和可点击，还需以下浏览器检查。

## 样式边界核查

- TopBar 48px 与32px页签/控件、28px关闭按钮可容纳；项目区 min-width:0/flex 和原680px/900px断点保持。没有新 display:none 针对主页或业务入口。短窗口不能仅按静态高度推导通过。
- ModuleRail 按钮和logo不再纵向压缩；其滚动容器仍为独立 rail。深色轨道使用单独 text/hover/selected 变量，选中仍有背景及侧标记，不是仅颜色一项。禁用按钮保持 disabled 和 opacity。
- ProjectTabs 用内部负 offset 焦点环，避免原 overflow:hidden 直接裁掉全部轮廓；箭头/关闭/主页/项目按钮均有焦点规则。具体裁切、聚焦末尾签时固定主页是否仍可见须看实际布局，未凭源码宣称已验。
- admin sidebar 改为100dvh、sticky、overflow-y:auto，可容纳现有全部角色菜单而不把入口删掉；长菜单标题允许正常换行。已读本机安装的 Antd menu inline 样式，确认其实际使用 flex、title-content 和默认行高/高度规则，核查没有新增绝对定位或定宽替代节点。菜单高度、换行和焦点是否正确覆盖 CSS-in-JS，仍须由实际计算布局/截图证明。
- admin header 保留用户截断完整title、locale和logout；新增56px壳与32px控件不修改接口/角色。没有在P1假称整个管理配置页已接入。
- CSS 变量覆盖延续 html[data-theme=dark]；desktop Antd token未固定 colorText/colorBg，所以既有暗色 algorithm 仍负责控件文字/背景。admin固定浅色token与既有 light sider一致，不是新增产品主题决策。
- 没有新动画、JSON主视图或业务文本翻译改动；代码/请求/响应原文的既有查看入口未变。

## 最终交付证据核对

已读取 `docs/f8-frontend-polish-p1-validation.md`、矩阵和工作记录，并逐份读取本地运行日志，范围与 §7 一致：projectTabs/topBar/moduleRail/ThemeLanguageToggle/antd-linkage 五文件31/31；App选择9通过/49未选；管理台App/LayoutView两文件14/14。合计54项是三次具名运行的合计，不是整应用单轮全绿。App未选项、原生包和远端CI不计通过。

已实际打开四张产品组件截图：浅色中文末签聚焦时主页可见；暗色英文680×287中主页、窄屏入口与可滚动模块区可见；管理台1024宽英文长标题正常两行；短高菜单末项聚焦有完整轮廓并在局部滚动区域内。没有 JSON 主视图或翻译key。截图中的合成正文标识清楚，没有冒充真实编辑器或完整页面。

已读取实际浏览器夹具 entry.ts/serve.mjs，确认真实导入本工作树 TopBar（内部ProjectTabs/ThemeLanguageToggle）、ModuleRail、desktop theme.css，以及管理台真实 App/LayoutView。桌面底部内容/草稿为合成占位，桌面 ConfigProvider 是夹具同值配置；没有把它写成完整 desktop App/真实树/编辑器已视觉联验。管理台合成session/workspace props触发真实14项→2项可见性条件，不是验证后台授权。Home/End往返、更多Online管理事件、角色/语言切换及40/60px菜单度量采用主会话当次浏览器观察回执；本独审没有重新操作浏览器。实际草稿关闭/取消、角色路由/登出等由既有具名测试补充，未以占位textarea保留值替代这些业务证明。

桌面typecheck、Vue typecheck、renderer及管理台含类型检查的build日志已读，没有缺资源或编译失败尾声。保留两前端大chunk提示及admin jsdom pseudo-element提示，不将通过称为无警告。原Core首次日志明确缺@apicc/plugin-sdk产物并exit2，随后准备顺序改正；夹具子路径别名/缺problems准备问题及radio工具操作失败均按准备/工具问题记录，没有充当产品RED或隐去。

矩阵已将样板方向改为用户确认，并将P1组件、选择测试与系统主题实时变更/原生短窗口/鼠标悬停/缩放/完整业务链分别标记。此前“待用户审阅”的时点问题已消除，未发现本组文档的实质计数或覆盖夸大。P1之外的业务细节逐页接入仍在P2–P4，不为共享基础改色扩大到全站门禁。

本次只核证据与冻结字节，不重开产品宽审，未跑新测试/构建或修改产品。审查时点验证文档 SHA256 为 `4182f6d6de8936b426db902ac349bd89a76a352ecfceb0355f50daf04e3da33d`，矩阵 SHA256 为 `613c56f782553446b1de8004ca0074f3ff80e8da33abb044fab6ae4240e2c4ad`。四份实际组件图像如下；样板主页补位图另属样板，不计为第五份实际产品组件验收。

| 实际组件截图 | SHA256 |
| --- | --- |
| docs/design/f8-frontend/p1-evidence/desktop-light-tabs.jpg | 7bca5c919a61b8cdf2b1cf48835e686dd6c3a29d2bacf824d960688feeb93f76 |
| docs/design/f8-frontend/p1-evidence/desktop-dark-short.jpg | 6e40f3b29788d5a490e05f720bc56e4bb9eb382b2b746cea83b2d9289835fd12 |
| docs/design/f8-frontend/p1-evidence/admin-english.jpg | ef3ab93c2dbcb624fe57106daf5317d451ea39ac2724ec14617728698d335b5e |
| docs/design/f8-frontend/p1-evidence/admin-short-focus.jpg | e7f96d8cba1cb46094c8b22c1275056c9857de3397c05afe8aea07a62c6b5768 |

追加索引封存：`docs/design/f8-frontend/p1-evidence-manifest.json` 自身SHA256为 `29a2d16697f1896f9b2ff5872845f7734983d23dac5047403f67c15b505f7c62`。已逐项比对8产品、7日志、5图像全部实际字节，无不一致；其中第五张名为prototype-home-restored，仅为样板主页补位，不扩大四张实际组件证据的范围。54通过、App49未选、未跑全量字段与原日志和文档一致。本组P1可结项并继续P2，整个第三批和后续原生/业务逐页验收仍未完成。

## 本次已审产品字节

| 路径 | SHA256 | Git blob |
| --- | --- | --- |
| apps/admin-web/src/App.vue | 113416d719c459d2797ac5f55a3f5d3e3192234f8a994b7bf938c7e451e6249c | 3e17a1ed0881d1536c7c15574acceea1975c8a51 |
| apps/admin-web/src/views/LayoutView.vue | cc19948c77e7822b517eb31b7880353ff31ebacc27e7a736ae902c37bcb9f64c | 84846ae8362d1a50009ebab0b8ac0c25272e8035 |
| apps/admin-web/src/styles/theme.css | a6504fda34e99fc002b46d30865a8cd6e6c6535cddb431f7f478a9aa3d687a20 | 2dc8ff7fdd4fc3662117554d71ef0cb415ad4099 |
| apps/desktop/src/renderer/src/App.vue | 6178702108d1163efa44c0ab41af02ba6b3ba479c5c4c10123812f033830b26e | 44848d440dc24f9627da93689597fe6586bed992 |
| apps/desktop/src/renderer/src/styles/theme.css | 5cc2153a38b3b6d9e9db527d81a1c74e51f46dbc785b12f4cd9d61e75e4d1755 | d4cb1c52ab7f29b4e2a8a1a3d377dd266f317f64 |
| apps/desktop/src/renderer/src/components/ModuleRail.vue | cef53748d42b9cf95fab3d90bc461aaeb6fbf6a62985cf55f2926919585fe9ff | b44652f7dbee9d452c67a8424321222a6a8993df |
| apps/desktop/src/renderer/src/components/ProjectTabs.vue | 4407abf0995ceffdfea9fbaf5dd2aa4da8f7ff772a8806f5d2dd72a0b9ff05c8 | 8b32894a13c29097280043ea93df053e9dfd13a7 |
| apps/desktop/src/renderer/src/components/TopBar.vue | e5747254dc9b84e6bba402de371ca3dabcc57df536f6043c435975ad0bb02aa8 | e4d4a2730fe059ea69d82f3596c15b76e893ec17 |

后续若只有证据/文档收口，不重开本次宽审；如果产品修订，仅复核具体delta及必要相邻影响。
