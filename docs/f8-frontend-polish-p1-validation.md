# F8 前端 P1：共享视觉基础验证

2026-11-08。基线 `569f7bf257b8387b51879b17512a44b080f89278`，工作树 `f8-frontend-polish/apicc`，分支 `codex/f8-frontend-polish`。本记录只覆盖 P1，不表示 P2–P5 或整个 F8 完成。

## 改动与共享影响

桌面保留原 CSS 变量名称和深浅主题算法，调整配色、字体、间距、控件尺寸、焦点与模块轨道；顶栏、固定主页/项目签、树面板壳沿用原装配。管理台统一 Ant Design 主题与布局变量，侧栏固定并独立滚动，英文长菜单正常换行。

8 个产品文件：桌面 `App.vue`、`styles/theme.css`、`TopBar.vue`、`ProjectTabs.vue`、`ModuleRail.vue`；管理台 `App.vue`、`views/LayoutView.vue`、新增 `styles/theme.css`。共享变量有 68 个现有消费者，Ant Design 配置影响各后代控件；逐页验收仍按 P2–P4 进行，不把编译成功当作所有页面通过。

没有修改 store、IPC、路由守卫、权限、执行器、草稿或保存状态机。主页在真实产品中始终存在；这次是补正样板遗漏并验证既有入口，未重写主页行为。

## 定向验证

依赖按本工作树锁文件离线安装，无锁文件变更；仅构建 Plugin SDK、Core、Execution 所需依赖和两个前端。工具链为 Node 22.19.0、pnpm 11.21.0。以下命令中的 `pnpm` 使用归档工具链执行。

| 验证 | 结果 | 本地日志 |
| --- | --- | --- |
| 桌面 5 个组件测试：项目签、顶栏、模块栏、主题语言、Antd 联动 | 31/31，23.75 秒 | `local/f8-frontend-p1/desktop-components.log` |
| App 主页/项目、草稿关闭、布局/调试、主题和登录选择项 | 9 通过，49 未选，15.94 秒 | `local/f8-frontend-p1/desktop-app-selected.log` |
| 管理台 App / LayoutView | 14/14，9.51 秒 | `local/f8-frontend-p1/admin-components.log` |
| 桌面 typecheck、typecheck:vue、build:renderer | 均通过 | `local/f8-frontend-p1/desktop-*.log` |
| 管理台 build（包含 vue-tsc） | 通过 | `local/f8-frontend-p1/admin-build.log` |
| Git 空白检查 | 通过 | `git diff --check` |

合计 **54 项定向测试通过**，没有运行桌面全套、工作区全量、Java 全套或完整 CI 门禁。未执行远端 CI、Windows 打包或原生新包验收，不能据此称它们通过。

```powershell
pnpm --dir apps/desktop exec vitest run tests/renderer/components/projectTabs.test.ts tests/renderer/components/topBar.test.ts tests/renderer/components/moduleRail.test.ts tests/renderer/components/ThemeLanguageToggle.test.ts tests/renderer/components/antd-linkage.test.ts --maxWorkers=2
pnpm --dir apps/desktop exec vitest run tests/renderer/App.test.ts --testNamePattern '挂载缺省主页|唯一项目签从主页切回|主页保留本地|主页导航使迟到|关闭项目签对 dirty|App 布局.*接口模块渲染|调试子视图仍是缺省|ConfigProvider 消费侧|LOGIN-001' --maxWorkers=1
pnpm --dir apps/admin-web exec vitest run tests/App.test.ts tests/views/LayoutView.test.ts --maxWorkers=2
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop typecheck:vue
pnpm --dir apps/desktop build:renderer
pnpm --dir apps/admin-web build
```

这些既有行为测试包含主页往返、dirty 关闭确认/取消、同名不同分组身份、离线签重试、模块门控、在线退出、管理台角色入口、路由上下文及登出。没有为颜色/圆角编写镜像断言。App 未选中的 49 项不计入通过数。

## 真实组件浏览器核查

使用 `local/f8-frontend-p1/browser/` 夹具挂载真实 TopBar、ProjectTabs、ModuleRail、ThemeLanguageToggle、管理台 App / LayoutView；合成 props，无后端、无 IPC，正文占位明确标注。这个夹具验证 CSS 布局与实际组件事件，不代替完整应用状态机或原生验收。

| 核查 | 实际观察 | 截图 |
| --- | --- | --- |
| 中文浅色、9 个项目签、长标题及 End 键 | 末签获得焦点/选中；项目区 scrollLeft 约 1285 px，主页仍固定可见，页面无横向溢出 | [浅色项目签](design/f8-frontend/p1-evidence/desktop-light-tabs.jpg) |
| Home / End 往返 | Home 选中主页，末签可再返回；无主页关闭按钮。真实草稿保证由上述 App/项目签测试验证，夹具正文不冒充真实编辑器 | 同上及测试日志 |
| 暗色 + English + 680×287 浏览器视口 | 模块栏独立滚动到 Environments，主页仍在；焦点轮廓清晰，原窄屏更多菜单含项目、在线、设置和主题/语言 | [暗色短窗口](design/f8-frontend/p1-evidence/desktop-dark-short.jpg) |
| 更多菜单 Online | 真实组件发出管理连接事件，夹具显示已触发；未访问服务 | 浏览器现场核查 |
| 管理台英文长菜单 | 1024 宽时长标题自然排为两行，菜单 40/60 px 高，无表头/文字挤断、无整页横向溢出 | [英文管理台](design/f8-frontend/p1-evidence/admin-english.jpg) |
| 管理台 680×287 浏览器视口 | 聚焦末项后侧栏 scrollTop 约 509 px，末项在 y=213–273 px，焦点可见 | [管理台短窗口](design/f8-frontend/p1-evidence/admin-short-focus.jpg) |
| 管理台角色与语言 | OWNER/SUPERADMIN 显示 14 项；切换合成 VIEWER/USER 后仅 Workspaces / Organization；切回中文恢复 14 项 | 组件现场 + LayoutView 测试 |
| 样板主页补位 | 当前 DOM 为“主页”，提示明确为固定主页且样板未展开主页内容 | `docs/design/f8-frontend/preview.js`；现场核查 |

浏览器视口控制在验证后已恢复。组件截图含合成夹具标识，不是发布包截图。原生 287 px、鼠标悬停、完整业务内容、全页面缩放及系统主题实时变更未由本组实机覆盖；相关矩阵项不提前关闭。

## 准备失败与证据限制

- 新工作树首次 Core 构建因 Plugin SDK 尚未构建失败；随后按 Plugin SDK → Core → Execution 的依赖顺序构建成功。只修准备顺序，未改产品代码，原失败日志 `build-core.log` 保留。
- 浏览器夹具首次启动存在 Ant Design 子路径别名错误、遗漏 `workspace.problems` 合成属性；修正夹具后重新加载完成核查。原浏览器日志保留，不称首次启动无错误，也不作为产品缺陷或 TDD 证据。
- 管理台 jsdom 测试有 pseudo-element getComputedStyle 未实现提示；两个前端构建均有大 chunk 提示。测试/构建通过不等于无警告；本组不扩展为拆包专项。
- radio 的自动 setChecked 工具操作未成功，改用实际可见“暗色”标签点击后 checked 和 html data-theme 均正确；不因工具操作失败改产品。

## 独立审核

原审查者已对 8 个产品文件、共享消费者和不变量完成静态独审，并核对测试日志、4 张实际组件截图和哈希索引；产品字节无漂移，未发现新增阻塞问题，P1 本组可结项。完整 [独审记录](f8-frontend-polish-p1-review.md) 含 SHA256 / Git blob 和证据边界；[证据索引](design/f8-frontend/p1-evidence-manifest.json) 区分实际组件截图与样板补位图。只有文档收口，未重开产品宽审。

后续 P2 从桌面高频操作链接入：先列旧入口与新位置、选定行为回归，再集中改样式与验证；不把 P1 的共享配色等同于业务页面已完成。
