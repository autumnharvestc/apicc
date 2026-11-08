# F8 P3g 逐点验证记录

2026-11-09；基线 `c1d1b69a`，工作树 `f8-frontend-polish`。按[设计](f8-frontend-polish-p3g-design.md)完成工作流／单接口用例主体。10个组件、受限域控件样式及两语言文件；未修改 Core、store、宿主、权限或执行协议。独审见[回执](f8-frontend-polish-p3g-review.md)。

## 需求、验收与证据

| 项 | 验收条件 | 已运行行为验证 | 实际组件证据与限制 |
| --- | --- | --- | --- |
| 01 工作流列表 | 长名称可查，删除有名称、预留位置、键盘可见；打开与删除确认分离 | 新 `P3g names list deletion without changing open or confirmation actions`：删除点击不打开、不提前删除，取消保留；既有创建／列表／脏草稿切换 | `workflow-list-focus.png`：键盘焦点显示图标；标题为存储规范化后的名称 |
| 02 画布与属性 | 宽屏分栏、窄屏上下；绑定、保存、只读、引用导航保持 | wfDesigner 既有 label／改绑、删除关联边、v2 创建保存重开、条件端口／循环／子流程、只读拒绝写入 | `workflow-zh-light-wide.png`、`workflow-en-dark-narrow.png`；浏览器编辑名称、保存、返回列表再打开，名称及接口／用例绑定保持；回执 `reopened`。仅内存保存，真实拖拽／磁盘仍留 P5 |
| 03 短高与只读 | 工具栏有界，内容局部滚动；只读写入关闭，引用导航可达 | 既有只读直接事件保护、发布／启用／失败／在途矩阵及运行迟到保护 | `workflow-readonly-short.png`：640×400，内容区167px／内容1419px，引用导航滚动可达；根宽640／640。未代表原生287px通过 |
| 04 工作流结果 | 逻辑结论与原始失败分开；恢复、重试、警告、轨迹直接可读；定位身份不变 | wfDesigner 嵌套调用模式、AND／OR事实、恢复结论、全部outcome、无outcome诊断、完整定位与RunsHistory；旧RunView断言适配见下 | `results-zh-light-wide.png`、`results-en-dark-narrow.png`：逻辑通过／真实2／失败1；重试两次及清理结束可读。窄表593／720px、根640／640；点击定位捕获合成事件，不宣称原生已跳转 |
| 05 用例分区与保存 | 数据、请求覆盖、断言／提取和脚本分区；scope、身份、默认请求及草稿保持 | CasePanel 全文件：保存成功／拒绝、恢复缺值、仅选中用例保存、完整目标捕获、根切换、只读 | `cases-zh-light-wide.png`：新增状态码200断言后内存保存成功；夹具首次缺端口失败单独保留，不作为产品缺陷或持久化证据 |
| 06 脚本操作 | 双语可访问名称；排序和删除保持目标ID／内容，边界及只读不变 | 新 zh/en `P3g names operation controls and preserves reorder/remove identity` 实际下移、删除、只读检查 | `cases-scripts-narrow.png`：窄屏前／后分块与操作按钮可达；原脚本内容不翻译 |
| 07 断言／提取 | 固定目标、匹配与方法本地化，协议值／插件码保留；高级默认折叠，错误不藏 | 新 zh/en `P3g translates extraction choices while retaining protocol values`；既有类型常量／XML错误清理／未知操作符／提取保存重开 | `cases-en-dark-narrow-error.png`：高级闭合时错误仍可见；修正为合法对象后错误清除。解析器原始英文错误原样保留，不宣称所有第三方错误已翻译 |
| 08 导航 | 搜索固定，空筛选可恢复；清除只清搜索并回焦，不改变pane／定位／草稿 | 新 zh/en `P3g clears only navigation search and restores full locator`：无匹配、回焦、无额外事件、显式点击携完整locator、场景长名称 | `cases-search-empty.png`及 `searchClear`：清除后接口恢复、期望值200保留，焦点回搜索；根640／640。数据集／套件空态分支静态复核，未新增专项浏览器样本 |
| 09 本地／在线调用 | 相同组件继续使用原事件和身份；主题样式不侵入子编辑器 | App 所选 rail-test／用例压测／场景／R19定位；onlineWorkspace 项目环境；AiAssertionSuggestions 选中用例入口，共6项额外直接调用回归 | 静态检查 TestView、OnlineProjectAssets 及共享组件调用；无真实在线服务／模型／请求，本轮不重复后台验证 |

## 命令、结果与失败记录

使用固定 Node 22.19.0／pnpm，在本工作树执行；原始日志在 `docs/design/f8-frontend/p3g/evidence/`。

1. `pnpm --dir apps/desktop exec vitest run tests/renderer/components/CasePanel.test.ts tests/renderer/components/wfDesigner.test.ts tests/renderer/components/TestSidebar.test.ts -t P3g`：首次 **5失败／58未选**（`presentation-red.log`）；失败为脚本操作名称、空筛选和工作流名称缺失，不能说测试后续每条断言都有独立先红。
2. 追加 `CasePanel.test.ts -t 'P3g translates'`：**2失败／13未选**（`choices-red.log`）；用于固定选项的可读文本和协议值。
3. 上述3个完整受影响组件文件：**63通过／2失败**（共65，`components.log`）。工作流新样本含 `/`，memory按已有规则存成 `-`，期望改为实际 `created.name`；另一项仍断言P3a之前的RunView摘要旧文案，更新为逻辑1/1/0与原始1/0/1两卡，以及条目“结果:通过”，保留原嵌套定位和历史断言。没有改产品绕过这两项。
4. `pnpm --dir apps/desktop exec vitest run tests/renderer/components/wfDesigner.test.ts tests/renderer/components/onlineWorkspace.test.ts tests/renderer/components/AiAssertionSuggestions.test.ts tests/renderer/App.test.ts -t 'P3g names|renders v2 logical verdict|uses the project execution environment|selected CasePanel exposes|rail-test|用例行「压测」|场景用例：|R19 evidence locate'`：**8通过／136未选**（`callers.log`），含上述2项修复及6项额外调用回归。最终 **71项去重通过**，不是首次单次全绿，不将未选项记为通过。
5. `pnpm --dir apps/desktop run typecheck:vue`、`pnpm --dir apps/desktop run build:renderer`：通过（`vue-typecheck.log`、`renderer-build.log`）；既有大于500kB分块提示保留。产品冻结后只修浏览器夹具和归档，未再改产品。
6. 产品／文档 `git diff --check` 通过。原始日志不清洗输出颜色／空白。

## 浏览器、审核边界及剩余内容

- `http://127.0.0.1:63576/` 仅实际Vue组件＋合成内存端口；工作流使用真实memory API生成、既有schema保存规范化。fixture拒绝执行／删除／发布；浏览器没有真实网络任务或权限写操作。
- 初始合成edge错误用了source/target，启动schema校验拒绝；只修fixture为from/to。第一次用例保存因fixture未提供caseDraftSave失败，保留 `cases-fixture-missing-port.png` 与回执，补内存端口后重新验成功；没有改产品，也不把它称作真实持久化。浏览器DOM读取一处使用了不存在的摘要选择器，改为既有wf-logical-verdict读取；工具定位文案失配后读取实际AX名称再操作。
- 10张最终截图＋1张夹具失败截图、`browser-receipt.json`、fixture四文件封存。回执 `cases` 是失败发生时记录，`finalCaseSave` 是补齐fixture后成功记录。最终console未捕获error；业务上报的fixture错误仍保留。临时页关闭、视口复位、服务停止，监听端口已核无残留。
- fixture复用：复制四文件到 `local/f8-frontend-p3g/browser/`，移除 `fixture-` 前缀。它们只作证据，不进入应用构建。哈希清单记录工作副本字节，排除自身与独立回执，避免循环散列。
- 同组唯一独审检查产品diff、直接调用路径、测试前提及实际截图；不扩大为整个F8完成。设计器画布仍可平移／缩放，窄屏240px画布并不保证任意大小工作流一次全入镜。

本轮未运行本地全量／Java／完整CI，未合并／推送，未重新打包。下一子组P3h处理设置／环境／契约／Mock等桌面余项；之后管理台、公共／离线页、整体原生验收与新包。因此仍为 **4个前端工作块**，本次只完成第1块的主体，随后再发布收口。
