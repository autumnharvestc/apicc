# F8 P3c 逐点验证记录

日期：2026-11-08。工作树 `f8-frontend-polish`，基线 `cd0fc256`。本组只涉及 DatasetPanel、SuitePanel 与中英文文案；沿用现有 TestingStore、本地/在线调用方。没有运行本地全量、Java、完整 CI、原生完整链或重新打包。

## 需求、验收与证据

| 项目 | 验收条件 | 已执行证据与结果 |
| --- | --- | --- |
| 数据编辑分区 | 基本信息/数据表/导入导出区分，保存栏常驻；原 JSON 类型不改 | 实际组件 `dataset-zh-light.png`、`import-zh-light.png`；typed import 用例覆盖预览前不替换、应用、保存重开、100行分页 |
| 导入预览 | 按列显示前100行；0/false/null/空字符串/缺字段/对象业务值不混淆 | 新测试 `P3c renders typed import cells…`，中英逐单元比对及应用后原对象相等 |
| 字面列名 | `toString`、`constructor` 是合法数据列，缺值不从原型继承 | 独审发现后真实 `store.previewImport` 复现两空白单元；两处存在判断改 `Object.hasOwn`，`P3c treats inherited property names…` 验证预览/应用/编辑输入 |
| 行与分页操作 | 可访问名称含行号/列名；第二页删除仅对应行，只读禁用 | `P3c names page and row controls…`；101行删除第101行后前100行保留，页码自动回退；原分页回归也通过 |
| 套件配置 | 基本信息/选择/运行配置分区，条目顺序及业务名字保留 | `P3c presents suite preview facts…`：点击具名上移并验证真实数组顺序；名称 `passed` 保留，状态 draft→Draft；真实保存查询套件后 Core 预览类型/次数/ID/base保持；中英截图 |
| 套件结果 | 逻辑单位、实际用例行分开；状态/外层轮次/失败原因有标题；不丢证据 | 原两个 `localizes…suite…` 用例强化条目表；一基行号、缺轮次—、业务错误和跳过仍保留；证据后置，统计优先；`result-order.log`3项复验通过 |
| 保存/查询/迟到/取消 | 美化不改脏草稿、导出格式捕获、查询清空、项目切换取消收束 | testingCenter 原14项全部通过：包括5种切换前取消、2种保存响应期间新编辑、格式捕获、查询维度、只读及迟到导入 |
| 在线共享组件 | externalRun代替本机运行；allowDraft原值，脏/运行中禁用；本机预览/取消不错误暴露 | `P3c preserves the external suite run boundary…`通过；静态核对 OnlineProjectAssets 原调用，本组不改适配器/服务。不称真实在线端到端已验 |
| AI/证据身份 | 分区或重排不改变实际结果包、授权定位身份 | AiReportAnalysis 的 actual suite report entry，AiReviewFix1 的 Core-projected suite case evidence，两项通过 |
| 主题/长表/语言 | 不挤断表头和状态，局部滚动、焦点可见 | 7张实际组件PNG；640×760页面宽640、内容640，数据表视口575/内容832；套件表视口587，无页面横向溢出。所有表头/type/state为nowrap；900×900英文结果保留原失败原因；浏览器error为空 |

## 执行记录

命令在工作树运行，Node22工具链见已有 `f8-product-closure/apicc/local/f8-defect-closure/toolchain.json`；以下 pnpm 均通过该Node入口，不借用其他工作树的可变dist。

| 日志（`local/f8-frontend-p3c/`） | 命令范围 | 结果 |
| --- | --- | --- |
| presentation-before.log | vitest testingCenter `-t P3c` | 3失败、1通过、14未选。缺可读表、无名称按钮、状态原码各自有失败；externalRun是既有回归，不能称新增先红。首次英文缺字段预期写成Missing field，与既有文案Missing不符，在实现后纠正；不称该子断言先红 |
| testing-center.log | vitest testingCenter 单文件 | 18通过（原14+新增4），21.47s；未扩大到整个renderer |
| ai-suite.log | 两个AI文件中 `actual suite report analysis entry\|locates actual Core-projected suite case evidence` | 2通过、54未选，9.30s |
| result-order.log | 两条套件结果本地化与一条Core证据定位 | 3通过、29未选，9.00s；都是上述重复项 |
| own-field-before.log | `inherited property names` | 1失败、18未选：合法导入第二行两空白与Missing不符，实际复现 |
| own-field-after.log | `P3c\|typed import\|late imports` | 7通过、12未选，10.35s；其中1新增，其余重复 |
| vue-before-expectation-fix.log / own-field-final.log | 新反例的期望值类型修订 | 首次Vue检查发现测试字面量数组因constructor/toString触发TS2322；改为解析同一合法JSON源作期望，产品不动，单项再验1通过/18未选，5.92s |
| vue-final.log / renderer-final.log | typecheck:vue / build:renderer | 最终均通过；renderer仍有已存在的大chunk提示，不归为无告警 |

本组去重 **21 项通过**（testingCenter19 + Suite AI2）；重复运行不累加，不称单次全绿或完整TDD。最终Vue/renderer在列名边界与nowrap修正后执行。

## 视觉与范围限制

真实组件使用合成 store 数据，夹具在 `local/f8-frontend-p3c/browser/`。浏览器未发送业务请求、没有后台/IPC；截图不是原生端到端证据。首次结果夹具缺 inspectEvidence API，呈现出明确错误；修正合成只读API返回后重新检查，最终控制台无error。产品错误处理未被删除或掩盖。

截图和几何回执位于 [p3c](design/f8-frontend/p3c/)，临时页面/服务已关闭、视口已恢复。原生287px、缩放、真实在线和完整运行链留P5；外层TestSidebar及其他P3队列本组未改。P2交付zip仍只含P1/P2，本组没有更新安装包。

独审与源文件/日志/图片SHA清单分别见 [本组独审](f8-frontend-polish-p3c-review.md) 和 [清单](design/f8-frontend/p3c-evidence-manifest.json)。
