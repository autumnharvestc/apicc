# F8 P5 验证记录（进行中）

2026-11-12，基线815af6ea。计划见[P5](f8-frontend-polish-p5-plan.md)。本记录先封存X03源码验证，原生联验与交付结论在本轮完成后追加；不提前标记全部完成。

## X03 原生导出语言

DesignPanel提交时捕获当前语言，经过design store、原preload、严格DesignExportInputSchema、IPC到原生确认选项。仅增加可选zh-CN/en；旧调用默认英文。固定按钮、标题、说明与余项数本地化，原诊断code/path/message不改；默认与Esc仍取消，取消返回空串且不调用保存。输出格式、身份、保存前后草稿规则不改。

34项去重定向验证通过：DesignPanel23、design store7、native design export locale4。首轮34项32过2败，后两项合法夹具修正后通过，不是单次全绿。两语言IPC都实际进入GraphQL语义损失确认；旧无locale调用仍英文；非法语言被严格schema拒绝。

原始记录在 `design/f8-frontend/p5/logs/`：

- export-locale-red：4失败/1通过/22未选。中文按钮仍英文、渲染请求缺locale、严格IPC拒绝新增locale。为避免模块不存在掩盖行为，先把原英文选项原样提取为可测函数，再实现语言分支；初始提取尚未接入main。
- export-locale-targeted：32通过/2失败。共享夹具未定义响应，被OPENAPI_RESPONSES_REQUIRED挡在确认前；不冒充已进入确认的先红。
- export-fixture-diagnosis：新增导出前提检查明确定位缺响应。补合法200响应后export-ipc-pass中4通过，仍保留取消不写断言及原结构拒绝。
- vue-check：新spy未声明参数导致mock.calls空元组的TS2493；只补两参类型。最终build-apps-desktop包含tsc、vue-tsc、renderer、electron和preload全部通过。

Core、plugin-sdk、execution、share-viewer和desktop五个必需包构建通过。只为打包闭包构建，未执行全工作区测试、Java全套或完整pre-push-ci。renderer沿用大块体积提示。

## 候选包与待办

独立目录 `local/f8-frontend-p5/package/win-unpacked` 已生成。package-smoke退出0：实际协作纯入口/查看器、物理source-host helper真实后代回收、renderer路径/标题/挂载和至少8秒存活均通过。这是单个Windows产物冒烟，不是完整CI。

待原生集中联验、包哈希、逐项矩阵收口及最终独审完成后交付。隐藏启动的窗口无法被工具枚举，已请求用户允许显示隔离窗口；不据此修改产品显示逻辑。
