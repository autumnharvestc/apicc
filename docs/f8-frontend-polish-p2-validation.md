# F8 前端 P2 验证记录

日期：2026-11-08。分支 `codex/f8-frontend-polish`，基线 `569f7bf257b8387b51879b17512a44b080f89278`。P2 为桌面高频页一组改动；没有运行本地全量、完整 CI、Java 全套，没有提交、合并或推送。

## 1. 范围与不变量

七个产品组件：HomeView、ProjectCard、ConnectionPanel、SideTree、RequestTabs、RequestEditor、ResponseViewer；另有桌面 theme.css 的深色选中文字小修正，共八个产品文件。详见 [设计 §8](f8-frontend-polish-design.md#8-p2-桌面高频页接入)。不修改 store、IPC、认证、执行器、草稿归属、统计或脱敏逻辑。P1 的旧清单与交付包保持原样；除下述 theme.css 追加外，其余 P1 七文件字节仍相同，未重跑 P1 全组。

ProjectCard 新增原生名称按钮、完整 title 和更多按钮名称；其他修改为样式和无事件包装。更多入口改为点击展开，菜单内容及动作保持。独审同时核对 ResponseViewer 在 App、TestView、OnlineExecutionPanel 的调用关系。

## 2. 定向测试与构建

以下命令从工作树根目录运行，使用本轮已记录的 Node 22.19.0 / pnpm 11.21.0，`pnpm` 表示相应工具链入口。每份日志只对应所列选择，未选用例不计通过。

| 命令（`pnpm --dir apps/desktop` 后接） | 结果 | 本地日志 |
| --- | --- | --- |
| `exec vitest run tests/renderer/components/ProjectCard.test.ts`，实现前 | 3 失败 | `local/f8-frontend-p2/project-card-red.log` |
| `exec vitest run tests/renderer/components/ProjectCard.test.ts tests/renderer/components/ConnectionPanel.test.ts` | 13 通过 | `local/f8-frontend-p2/card-connections.log` |
| `exec vitest run tests/renderer/components/components.test.ts --testNamePattern '^(SideTree\|RequestEditor\|ResponseViewer\|HomeView)' --maxWorkers=1` | 47 通过、26 未选 | `local/f8-frontend-p2/components-selected.log` |
| `exec vitest run tests/renderer/components/contractAssets.test.ts --testNamePattern 'saves a request-only\|edits inline parameter\|all eight HTTP body\|every ApiAsset metadata\|round-trips HTTP' --maxWorkers=1` | 5 通过、14 未选 | `local/f8-frontend-p2/contracts-selected.log` |
| `exec vitest run tests/renderer/App.test.ts --testNamePattern '当前项目可打开 free\|关闭项目签对 dirty\|唯一项目签从主页切回\|顶栏在线入口\|主页在线区活跃工作区下项目卡片' --maxWorkers=1` | 5 通过、53 未选 | `local/f8-frontend-p2/app-selected.log` |
| `typecheck:vue` | 退出 0 | `local/f8-frontend-p2/typecheck-vue.log` |
| `build:renderer` | 退出 0 | `local/f8-frontend-p2/build-renderer.log` |

合计 70 项定向通过、93 项未选；不是整个桌面测试通过。新卡片测试的 RED 两项缺原生名称按钮、一项缺更多按钮 aria-label，不能声称旧更多菜单发生过冒泡错误。实际新增 name.stop 的一次打开行为由 GREEN 及浏览器验证。

浏览器日志另发现 SideTree 顶部新建分组的旧组件导入缺口。追加同文件用例先单跑 `--testNamePattern '新建分组提供原生可聚焦按钮' --maxWorkers=1`，得到 `A-BUTTON` 而非 `BUTTON` 的有效 RED；随后仅增加 `Button as AButton` 导入。最终用 `--testNamePattern '^SideTree' --maxWorkers=1` 跑树组件选择，18 通过、56 未选，日志为 `tree-button-red.log` / `tree-button-green.log`。其中17项与首轮重复，去重后本组 **71项** 已验证，不能相加成88项。修正后 Vue 类型检查和 renderer 构建再次通过，最终日志为 `typecheck-vue-final.log` / `build-renderer-final.log`。

保留既有 jsdom `getComputedStyle(...pseudo-elements)` 提示和 renderer 大 chunk 警告。没有删断言、修改预算或用快照更新代替行为检查。

## 3. 真实组件浏览器核查

使用 Vite 加载上述实际 Vue 组件与本工作树主题；合成 props/store 仅驻内存，不接后台、不调用 IPC、不发送网络请求，不载入真实凭据。夹具为 `local/f8-frontend-p2/browser/`，带明确横幅。不能将它称为完整 App、真实持久化或原生端到端验收。

| 检查 | 实际观察 | 证据 |
| --- | --- | --- |
| 主页/项目卡片 | 1440×900 中文浅色；名称按钮 Enter 恰好增加一次打开计数；更多菜单正常展开，打开计数不变；长名省略但有完整 title，焦点可见 | `home-zh-1440.png` |
| 连接管理 | 900×720 中文浅色；长 URL 在信息区换行、四个动作可见；编辑昵称保存后仍两行、原地址保留。本项仅验证组件调用和布局；真实身份更新/重复拒绝由 ConnectionPanel 测试覆盖 | `connections-zh-900.png` |
| 编辑/结果分区 | 1440×900 中文浅色；协议、发送、保存、元数据、参数 Schema 与结果入口保留；参数区独立滚动，主窗口无横向外溢 | `editor-zh-1440.png` |
| 英文深色/窄窗 | 900×720；顶部操作换行，元数据减列，结果统计换行；Send、Save request 分别增加一次合成事件计数。业务原文不翻译 | `editor-en-dark-900.png` |
| 树行焦点 | 同一长接口行聚焦前后均约 245.43×30 px；Tab 到 Rename，两个动作仍各 24×24 px、opacity=1；未用静态 CSS 代替该次测量 | `browser-checks.md` |
| 请求页签溢出 | 8 个长签各保留约 194 px 名称按钮和固定关闭区；滚动轨道宽约 462 px、内容约 1797 px；末签 Enter 后选中，scrollLeft 约 1308.57，签在视口内；关闭后剩 7 个，新建入口仍在 | `browser-checks.md` |
| 长响应常驻工具栏 | 英文深色 900×720，响应区滚动约 1302.86 px 后工具栏仍在约 y=80.57；输入 SKU-49 显示 1 个匹配，清除按钮可用；页面宽仍为 900 px，无整体水平溢出 | `response-en-dark-scrolled.png`、`browser-checks.md` |

图像位于 [P2 证据目录](design/f8-frontend/p2-evidence/)。响应正文和 Schema 是业务原文/专用编辑器，允许直接显示 JSON；结果控制台等复杂元信息的全量可读性盘点仍属 P3，不混称已整改。

夹具首轮启动有一个缺失对象闭括号，已在本地夹具修正；定位昵称时曾把可访问名称误作 placeholder，主题原生 radio 的直接 check 未触发控件，随后依实际 DOM 用对应 label 点击。这些是夹具/操作错误，没有据此修改产品或伪称首次全部成功。最终显示与主题选择已实测。

SideTree 缺导入属于真实旧产品问题，未归为夹具错误。修正后浏览器显示原生 New Group 按钮，Enter 可打开实际 ConfirmDialog。两张 editor 图已在修正后重新截图，旧图留在 `local/f8-frontend-p2/before-tree-button/`。日志仍保留 Antd `tabBarExtraContent` 旧插槽弃用提示，不称控制台零警告。

### 深色文字对比追加

实际 P2 组件中，Antd 选中页签和 HTTP 描边单选文字由主色派生为 `#2d54c9`，与实际合成背景 `#1c2636` 对比约 2.34:1，存在可读性不足。初步粗读背景曾写成 `#1f2937`；最终以 DOM 最近不透明祖先计算，纠正为 `#1c2636`。没有以截图印象代替最终数值。

仅在深色主题下，将启用的选中页签、非 solid 单选按钮文字设为既有 `--accent: #9ab8ff`，包括 hover/active 覆盖；不抬亮全局主色、不修改实心按钮或禁用态。最终浏览器实测：页签对比约7.74:1；单选标签背景 `#141414`，对比约9.36:1；点击后指针 hover 状态文字不变。pressed 的一致性来自选择器及本机 Antd 样式核查，未声称抓取了按住瞬间截图。

真实 Antd 边界夹具确认：disabled outline 保持 `rgba(255,255,255,0.25)` 文字；solid 和 primary 保持白字/`#2d54c9` 蓝底，对比约6.52:1。见 `theme-boundaries-dark.png`；最终 `editor-en-dark-900.png` 已更新。此纯 CSS 修改后 renderer 构建通过（`build-renderer-contrast.log`），未重跑业务测试或完整门禁；由原独审者仅复核该 delta。

最终浏览器日志另外保留边界夹具的 RadioButton 普通字符串插槽性能提示；它来自本地 h() 样例，并非产品新异常。`browser-console.log` 含本轮历史警告，未清除旧缺导入记录或将整份日志称为零错误。

## 4. 明确未完成

- 原生 287 px 极短窗口、应用缩放和拖动分隔，以及完整新包真实后台/IPC 操作，保留给 P5 集中验收。
- 本组未逐页覆盖所有错误/离线/只读组合；组件既有选择测试、静态不变量和浏览器布局各自记录，不能互相替代。
- P3 测试/报告/AI/同步/工作流等复杂功能，P4 管理台业务页/公共查看/离线报告尚待接入。没有称整个前端已优化完成。
- 本轮 P1 验证包不含 P2；P2 只完成源码、定向测试和真实组件检查，未生成第二个包。

最终源码、日志、截图及夹具哈希见 [P2 证据清单](design/f8-frontend/p2-evidence-manifest.json)，独审回执单独归档。
