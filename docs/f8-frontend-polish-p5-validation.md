# F8 P5 验证记录

2026-11-12，基线815af6ea。计划见[P5](f8-frontend-polish-p5-plan.md)。X03定向验证、真实Windows产物冒烟、原生集中联验及用户节点位置手验完成；实际覆盖边界见下表，最终独审另列。

## X03 原生导出语言

DesignPanel提交时捕获当前语言，经过design store、原preload、严格DesignExportInputSchema、IPC到原生确认选项。仅增加可选zh-CN/en；旧调用默认英文。固定按钮、标题、说明与余项数本地化，原诊断code/path/message不改；默认与Esc仍取消，取消返回空串且不调用保存。输出格式、身份、保存前后草稿规则不改。

34项去重定向验证通过：DesignPanel23、design store7、native design export locale4。首轮34项32过2败，后两项合法夹具修正后通过，不是单次全绿。两语言IPC都实际进入GraphQL语义损失确认；旧无locale调用仍英文；非法语言被严格schema拒绝。

原始记录在 `design/f8-frontend/p5/logs/`：

- export-locale-red：4失败/1通过/22未选。中文按钮仍英文、渲染请求缺locale、严格IPC拒绝新增locale。为避免模块不存在掩盖行为，先把原英文选项原样提取为可测函数，再实现语言分支；初始提取尚未接入main。
- export-locale-targeted：32通过/2失败。共享夹具未定义响应，被OPENAPI_RESPONSES_REQUIRED挡在确认前；不冒充已进入确认的先红。
- export-fixture-diagnosis：新增导出前提检查明确定位缺响应。补合法200响应后export-ipc-pass中4通过，仍保留取消不写断言及原结构拒绝。
- vue-check：新spy未声明参数导致mock.calls空元组的TS2493；只补两参类型。最终build-apps-desktop包含tsc、vue-tsc、renderer、electron和preload全部通过。

Core、plugin-sdk、execution、share-viewer和desktop五个必需包构建通过。只为打包闭包构建，未执行全工作区测试、Java全套或完整pre-push-ci。renderer沿用大块体积提示。

## 候选包

独立目录 `local/f8-frontend-p5/package/win-unpacked` 已生成。package-smoke退出0：实际协作纯入口/查看器、物理source-host helper真实后代回收、renderer路径/标题/挂载和至少8秒存活均通过。这是单个Windows产物冒烟，不是完整CI。

候选源码提交 `c8dc49fdcf535490d98870d76e5d7591d3166b3c`。ZIP 为 `local/f8-frontend-p5/apicc-f8-frontend-p5-candidate.zip`，180947344 字节，SHA-256 `aaea73d0c643e4cc57fb96c87427ad69f076e921a91770b62201a69a052e1617`；`resources/app.asar` SHA-256 为 `6f6e08c99c8316a3ddf7d106ea744879f15ba8f89d6cf8fbca8fd04ed328cae1`。原审查者只读核对 ZIP 的 292 项、根目录可执行文件、viewer.js/css、owned-process.exe 与 app.asar；ZIP 中的 app.asar 与已冒烟目录包一致，不含本轮 profile/user-home。

总[验收矩阵](f8-frontend-polish-acceptance.md)按 P1–P4b 逐项证据更新，明确真实在线/安全授权未重验边界。用户已允许显示隔离窗口；实际新包原生验收见下表。隐藏启动无法被工具枚举只作为工具前提记录，未修改产品显示逻辑。

## 原生集中验收（2026-11-12）

| 范围 | 本轮验收动作 | 当前证据 |
| --- | --- | --- |
| 主页、项目、接口与草稿 | 合成工作区打开；固定主页往返、第二项目切换、草稿仍在；显式保存后重开 | 01–03、29：草稿跨项目保留；显式保存接口说明后，关闭接口页签再打开仍为同文，磁盘 api.yaml 一致 |
| 请求与结果 | 回环接口返回 200/503；慢请求取消；真实结果可读且接口归属正确 | 04–06：200/通过与503/失败分别可读；慢请求取消后恢复发送按钮，AX含aborted/已取消，服务日志记录 response-close completed:false |
| 长文本与布局 | 长树行和页签、分隔与局部滚动 | 02、04、16、19–21：长行单行截断且具名操作，响应区局部滚动；初轮实际分隔调整后留存04结果图，单张截图并非前后几何对照。后续两次拖分隔未产生移动，不能把未生效尝试记为再次通过 |
| 主题、语言与缩放 | 应用浅/深/自动，中英文空态；应用缩放前后操作可达 | 08、19–25：浅/深切换，自动选项跟随当前系统为浅色；实际应用放大两档、页签横滚、Ctrl+0恢复；中文/英文测试套件空态可读。未改变OS主题，不能声称系统主题实时切换通过 |
| 极短原生窗口 | 实测高度并核对导航、设置/AI/同步关闭入口与操作可达 | 10–16：设置/AI为1087×313；主壳、导航、同步与导出为1087×280（截图逻辑像素，非CSS视口）。导出外层可滚至取消/导出，主导航滚动可访问工作流/测试；未将313冒称280 |
| 工作流与测试入口 | 原生壳加载；节点修改、保存重开；测试/报告入口 | 17–18、22–28：标签保存重开、测试/历史空态、键盘聚焦Enter打开及Esc关闭已验。工具拖动未生效后由用户手验确认“位置保留，绑定不变”；31截图和磁盘核对位置120,120→362,221，API100/case smoke保持 |
| 文档与有损导出 | 真实预览；中文/英文 GraphQL→OpenAPI 原生确认，取消不保存 | 07、09及原生AX：中文/英文标题、说明、按钮实际显示，原业务诊断保留；中文Esc、英文取消都回到设计页，未进入文件保存对话框 |
| 日志与退出 | 核对缺资源、空白、ResizeObserver；正常退出及服务收尾 | 最终stderr仅一条CSP default-src回退INFO；未观察到缺资源、致命错误或ResizeObserver。回环服务已停止；客户端Alt+F4正常退出，无丢弃提示，窗口及该隔离exe进程均消失。P4a既有ResizeObserver观察不据此宣称修复 |

截图及原生可访问树见 [native 证据索引](design/f8-frontend/p5/native/README.md)。回环服务仅提供合成数据；慢请求夹具由1.5秒改为60秒，以便人工节奏下明确点击取消，产品超时策略未变。取消实际在约6.9秒关闭响应，不能用服务端60秒自然结束冒充取消成功。

本轮不操作真实项目、账号或模型；未重复在线登录、远程代理、真实公共鉴权和安全授权链。系统主题实时变化未实测，设置/AI短高仅313px，工具拖动由用户明确手验补齐；不以已绿组件测试扩大覆盖。

## 交付核对

用户手验后再次核对ZIP及目录包app.asar，SHA-256与本记录完全一致；后续只更新文档与证据，无产品改动，因此未重复构建或冒烟。保留候选文件名便于追溯，不另造相同字节的新包。正常退出、服务关闭与保存坐标见 `native/session-status.json`、`native/workflow-manual-result.json`；早期pending记录保留为过程，不覆盖新结果。本地全量、Java全套、完整pre-push-ci和远端CI均未执行；未合并或推送。
