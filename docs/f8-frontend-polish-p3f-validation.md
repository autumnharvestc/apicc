# F8 P3f 逐点验证记录

2026-11-08；基于 `4eea7875`，工作树 `f8-frontend-polish`。范围为 9 个 online 组件、受限域控件样式及两种语言。没有修改 store、Core、宿主或权限协议。设计见 [本组设计](f8-frontend-polish-p3f-design.md)，最终独审见 [回执](f8-frontend-polish-p3f-review.md)。

## 需求、验收与证据

| 项 | 验收条件 | 真实行为验证 | 实际组件证据／结论 |
| --- | --- | --- | --- |
| 01 在线执行 | 执行位置、当前参数、历史事实分开；取消申请不等于释放或归档 | onlineWorkspace 的 `online execution readable projection` 12项，包含最小状态、逻辑失败／原始请求、历史运行时、报告身份及中英原因 | `execution-zh-light-wide.png`：取消已申请、资源未确认释放、无历史权限均保留；刷新输入与 ms 同行 |
| 02 在线压测 | 准入上界与历史实际限制区分，环境／确认／取消门控保持 | OnlineStressPanel 全文件，覆盖代理容量、当前环境、保存与草稿、目标确认、取消归属、固定基线和导出 | `stress-zh-light-wide.png`、`stress-zh-light-narrow-editor.png`：真实单位、当前不支持提示及子编辑器保持；没有通过浏览器启动压测 |
| 03 定时列表 | 清除只清搜索，回到搜索焦点；筛选、选中对象和未保存名称保留 | 新增 P3f zh/en 两项；最后加入全部状态下纯空格搜索反例，修正空态与过滤判定不一致 | `schedules-zh-narrow-empty.png`、`schedules-en-dark-narrow.png`；receipt 保留 `paused`、原草稿、焦点 `schedule-search` |
| 04 定时编辑 | 日期原精度、权限／配置禁用、启用／删除显式确认保持 | OnlineSchedulesPanel 全文件：原时刻精度、配置未应用、快照刷新／同意失效、凭据元数据、只读及删除版本等；新增规则／星期可访问名称 | 宽屏分栏、窄屏上下分区；长名称短显可悬停；启用／删除仍 disabled，不为视觉修改参数或主体 |
| 05 定时差异／历史 | 长表自身滚动，搜索仍可用；原报告、未采集和错过窗口不伪造 | 同文件的原报告重复查询／身份不符／切换项目迟到响应、历史及通知分页测试 | `schedules-zh-history-narrow-table.png`：容器524／内容1304px；`schedule-diff-zh-narrow.png`：484／520px；两次根宽均560／560px。旧 `schedules-en-history-narrow.png` 仅到历史按钮，不单独用作表格证据 |
| 06 通知 | 当前成员范围、已读、执行结论、归档与外投状态分开；无数据不混同加载失败 | OnlineNotificationsPanel 全文件；新增 zh/en 已加载空态／错误／未加载区分，空页有游标仍有翻页入口；既有迟到刷新、已读与独立投递状态 | `notifications-en-dark-narrow.png`、`notifications-en-empty.png`；receipt 记录点击已读再刷新后无已读按钮，投递失败仍显示 |
| 07 协作预览 | 来源、候选有效期、大小／单位、安全限制直接可读，确认上传与发布保持独立 | PublicationPreview 全文件：固定来源、双阶段确认、丢弃／超时／拒绝、缺测与逻辑／原始失败 | `collaboration-en-dark-wide.png`；默认无 JSON/pre 主视图，逻辑1/1/0与原始2/1/1分别保留 |
| 08 共享历史 | 来源／结论／完整性／运行时可读，不借用当前值；局部横滚 | SharedHistoryPanel 全文件：有界过滤、空页游标、分页保留条件、来源同ID碰撞、原引用预览 | `shared-history-en-dark-wide.png`；窄屏表491／1250px，外层545／545px，不撑坏整页 |
| 09 授权／对账 | 忙碌、失效、版本、已撤销、回执和明确复制／轮换／撤销操作保持 | CollaborationPanel 全文件：pending 切预览／原回执、不隐式重试、CAS冲突、迟到响应、权限、期限与下载限制 | `grants-en-dark-wide.png`、`grants-zh-light-narrow.png`；下载仍不可选。浏览器未执行创建、轮换、撤销或发布 |
| 10 公共样式与短高 | scoped 样式不侵入子编辑器；中英／深浅可读；导航不被正文顶出 | Vue类型、renderer构建、静态作用域复核 | 共16张实际组件图；600×360网页中详情仍122px可滚动。这不是原生287px、系统实时主题或应用缩放验收 |

## 实际命令与结果

使用本阶段已固定 Node 22.19.0／pnpm 工具链，在仓库根运行。原始日志封存于 `docs/design/f8-frontend/p3f/evidence/`。

1. `pnpm --dir apps/desktop exec vitest run tests/renderer/components/OnlineSchedulesPanel.test.ts tests/renderer/components/OnlineNotificationsPanel.test.ts -t P3f`：首次4项失败，原先140项未选；见 `presentation-red.log`。失败来自空态／焦点，不能声称每条后续断言各自观察到了先红。
2. 指定 `OnlineSchedulesPanel.test.ts OnlineNotificationsPanel.test.ts OnlineStressPanel.test.ts CollaborationPanel.test.ts SharedHistoryPanel.test.ts PublicationPreview.test.ts` 六个完整受影响组件文件：**298项通过**（`components.log`）。这不是工作区全量。
3. `onlineWorkspace.test.ts -t 'online execution readable projection'`：**12项通过，18项未选**（`execution.log`）。总计310项去重通过。
4. 独审修正后，`OnlineSchedulesPanel.test.ts onlineWorkspace.test.ts -t 'P3f|online execution readable projection'`：14项复验通过，130项未选（`review-fix-green.log`），不重复累加。
5. 最终 `pnpm --dir apps/desktop run typecheck:vue`、`pnpm --dir apps/desktop run build:renderer` 通过。构建原有大于500kB分块提示仍在；不冒称已解决包体积。最终日志为 `vue-typecheck-final.log`、`renderer-build-final.log`。
6. `git diff --check` 对产品／文档通过；原始日志保持原样，不清洗工具输出的空白或颜色。

## 问题、修正与证据限制

- 首次Vue检查因新增测试的 `element.value` 未声明具体DOM类型失败；仅改为 HTMLSelectElement／HTMLInputElement，最终检查通过，保留 `vue-typecheck.log`。
- 独审发现纯空格搜索与空态使用 `trim()` 的判定不一致。首次补测仍在 paused 状态，故未复现（`whitespace-red.log` 实际为2通过，不是RED）。改为 all 状态后双语2项确实失败（`whitespace-red-effective.log`），随后空态改用既有原始 search 条件；不改筛选语义。
- 实际浏览器发现刷新间隔的 ms 被列式标签放到第三行；给输入和单位增加同行 span，未改label、事件或参数；最后12项执行回归与类型／构建通过。
- 浏览器初始夹具把连接写成非协议值 ready，且压测计划未规范化。只修夹具为 connected；完整项目和计划用既有 ContractProjectSchema／StressPlanSchema 解析。未把夹具问题当产品缺陷。最终截图重新采集相关视图。
- 固定地址 `http://127.0.0.1:63575/` 只服务实际Vue组件及合成数据；端口拒绝执行、上传、发布和授权写操作。读取／已读使用内存端口，不能证明后端或原生IPC。浏览器未捕获console error。临时页／服务已关闭，视口已恢复。
- 夹具归档为 `fixture-entry.ts / fixture-serve.mjs / fixture-index.html / fixture-seed.json`。复用时复制到 `local/f8-frontend-p3f/browser/` 并去掉 `fixture-` 前缀；serve会从仓库测试夹具重新生成seed。这些文件是证据，不进入应用构建。
- [哈希清单](design/f8-frontend/p3f-evidence-manifest.json) 记录工作副本字节，用于本候选复核；不将后续Git换行规范化误认为产品变化。清单自身与独审回执不互相散列，回执随提交封存。

本轮未运行本地全量／Java／完整CI，未合并／推送，未更新P2交付zip。P5仍需原生完整业务链、287px、缩放和新包。完成本组后剩4个前端工作块，之后再发布收口。
