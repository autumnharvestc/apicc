# F8 P4b 公共与离线阅读逐点验证

2026-11-12，基线 `6a8ea89e`，工作树 `f8-frontend-polish`。按[P4b设计](f8-frontend-polish-p4b-design.md)完成六类阅读入口；报告模型、执行逻辑、统计算法、权限和宿主未改。仅本地提交，未合并／推送。独立审核见[回执](f8-frontend-polish-p4b-review.md)。

## 逐点对照

| 需求点 | 验收条件 | 具名测试与代码证据 | 实际页面证据／边界 |
| --- | --- | --- | --- |
| 公共查看器 | 当前语言可辨；无结果、清除、焦点明确；工具与目录分开滚动 | views 18项：新增双语空态、清除仅影响搜索；保留真实viewer fetch、fragment、重新授权下载、迟到响应、复制拒绝和输出超额 | 01–03：中文宽屏、英文空态、640×400；clear回焦publication-search。浏览器用safe DTO props，不冒充真实服务认证 |
| 公共离线导出 | 无脚本双语导航、唯一锚点；原文和完整指纹默认折叠 | public-html 11项＋views新增导航：safe DTO拒绝私有字段、转义、容量、统计总体与零基线要求保持；scripts为0 | 04–05：中文默认、English→Comparison跳至#en-comparison；原CSP与字节检查保持，无远程资源 |
| API文档 | 固定搜索与目录；默认中文、英文、命中计数及复制保留；长表局部滚动 | document 7项＋offline-readers文档测试：搜索/复制真实生成HTML，任意环境名即使为Description等也不翻译；Markdown仍原序列化 | 06–08、15：22条筛至/orders/22剩1条；英文复制反馈Copied；短高搜索不再被表头覆盖。15只强制实际暗色CSS分支，不宣称OS切换已验 |
| 运行报告 | 常驻筛选；逻辑结果与原执行失败分列；非请求错误直接可读、身份折叠；原始业务文本保留 | reporters 21项＋offline-readers：统计、行号、两个清除独立、证据、转义和容量保持；新增未知constructor/__proto__不崩溃、已知节点类型可读 | 09–10、16：逻辑1/1/0与真实12/失败2分列；仅失败＋行1时清接口保留另两项并回焦；无请求诊断原因无需展开JSON |
| 压测报告 | 固定语言/搜索；目录与结果同步筛选；空态可清除 | stress/report 5项＋offline-readers：比较、原始失败、缺数据、真实零、时间、精度不变；新增双语空态/清除回焦 | 11–12：10区块→未命中时目录与内容均0→清除恢复10；640×400时控制区保留。此布局夹具仅1次逻辑/请求，复杂比较仍由现有行为测试覆盖 |
| 桌面共享预览 | 修订短显、完整值可展开；生命周期/组件类型本地化；未知码保留；深浅主题和Schema原文 | DesignPanel 22项：新增双语指纹/生命周期/未知码；原草稿、冲突、复制和模型引用保持；既有翻译复用于组件kind | 13–14、17：中文/英文、真实主题切换、完整指纹展开；组件契约默认折叠，Schema/正文按规范允许直读；深色引用链接使用主题色 |

## 运行记录与失败说明

日志在[P4b证据目录](design/f8-frontend/p4b/logs/)。最终 **97项去重受影响测试通过**：Core 44（document 7、reporters 21、stress/report 5、public-html 11），share-viewer 31（views 18、offline-readers 7、fragment 6），桌面DesignPanel 22。不是单次全绿，不累计复验为额外覆盖。

- `red-readers.log`、`red-preview.log`：新增行为缺失先失败；后续原型键、环境名、节点类型和Markdown分别有 `red-unknown.log`、`red-scope-kinds.log`、`red-markdown.log` 记录。
- `core-tests.log`：首轮43项37过6败；其中未受后续修正影响的stress/public 16项已过。文档/运行原断言把裸英文或纯文本表头当成完整HTML，新增双语span后须按可见语义核对；没有删统计或安全要求。`core-recheck.log`、`core-final.log`保留后续失败。最后发现等待前缀实际遗漏，恢复“等待/Wait”，不是放宽断言。
- `readers-tests.log`：27项26过1败，新复制测试只等待一个微任务，未等到异步反馈；改为等可见反馈。`preview-tests.log`：22项20过2败，新夹具为空却断言存在Schema，改为真实未知生命周期场景。两者不记作产品缺陷或有效先红。
- 独审发现本次字典未限own-key，`constructor`可取到继承函数导致渲染崩溃；任意环境名会碰到固定标签；已知节点种类未覆盖；以及Markdown组件定义被广泛替换。均保留针对性失败，修后验证。暗色文档分支、独立搜索label及默认折叠也经复核恢复/修正。
- 最终Core文档/报告28项：`core-affected-pass.log`；viewer/offline 25项：`viewer-final-pass.log`；桌面22项：`preview-final-pass.log`。末尾复用组件枚举标签后，受影响2项再次通过：`preview-label-recheck.log`，不计20项skip为通过。Core未受影响16项及fragment 6项不重复运行。
- 最终构建/类型：`core-build-final-pass.log`、`share-build-pass.log`（含vue-tsc）、`vue-label-pass.log`、`renderer-final-pass.log`。早期缺少jsdom类型、Element.hidden类型、模板类型和文档label引用错误记录分别保留于share-build、share-build-final、vue-check等日志；早期core-build.log曾复用文件写入，不能据此声称保留了该次失败全文。renderer原有大块体积警告仍在。
- 以上为8个具名受影响测试文件；没有运行全工作区、Java全套、完整本地CI或新打包。代码和文档的 `git diff --cached --check`通过；原始日志含工具输出的尾空行/行尾空格，整份暂存检查会提示，未为了消除提示改写日志。文件名含final不代表成功，具体以以上列出的成功日志为准。

## 页面与证据边界

20张图片包括17张最终图及3张过程图；实际像素尺寸见 `image-metadata.json`。工具视口设置与截图像素可能不同，不能把1280×900覆盖说成截图也为1280×900。最终截图均检查了实际图片。`before-document-short-overlap`为真实短高遮挡：工具区从约234px压至168px并升层至5，表头层1。`before-preview-dark-link`为默认蓝链接在暗色中的对比问题，修后为rgb(154,184,255)。`before-viewport-transition`为刚改变视口时的暂态旧帧，03稳定后重拍，不记产品缺陷。

生成文件直接由本机HTTP返回原字节，不经Vite注入；公共页/DocumentPreview加载真实组件、桌面i18n及主题，数据均为合成。文档暗色样例只将媒体查询条件改为all以检查原暗色CSS，未更改产品媒体查询或系统主题。非HTTP样例最初误继承请求12，已改夹具为0且重新核查；不涉及统计产品修正。JSON只保留在契约/Schema/正文以及默认折叠原始详情，不取代结论和失败原因。

浏览器读取页面后再操作；首次复制定位命中隐藏API、一次中文组件标题名称不匹配、一次主题radio操作和body快捷键失败均属工具操作未完成，换实际可见元素后验证，不计为功能通过。没有读取真实剪贴板或访问接口目标；复制内容由行为测试验证。未声称所有页面控制台全程零错误。

临时浏览器页已关闭、视口恢复；合成服务进程已停止，63579无监听。无真实项目写入、认证或网络授权变更。

P4b结项后剩 **1环：P5原生集中联验与统一新包**。原生287px、系统缩放/主题自动切换、真实拖动/完整IPC，以及P3h/P4a的ResizeObserver观察项仍待验。旧P2包不含P3/P4，不能作为本批新包交付。
