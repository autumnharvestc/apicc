# r7 后续优化的实际验收

[实施计划](../../../f8-frontend-polish-workbench-r7-followup-plan.md) · [评审样板](../evidence/workbench-r7-followup-concept.png)

## r7 基线

- [未发送时的请求与空响应区](baseline/baseline-unsent.jpg)
- [同一请求的真实 HTTP 200](baseline/baseline-200.jpg)

基线为 `32cf0b0f` 对应的已验 r7 Windows x64 包，`app.asar` SHA-256 为 `2976dfa1459858433eaaaad61b0616a3ac009bedd1c66a553c33948e2aacb773`。两图均为默认缩放的 1097×638 原生窗口捕获。未发送时的编辑卡和空响应卡各约占一半高度。回环服务记录 `GET /echo?orderId=ord_001&includeItems=true` 完成。隔离客户端正常退出。实际窗口树、请求和退出日志保存在 `local/f8-frontend-r7-followup/isolated-tXlTkx/`。

## 第一批源码预览

- [未选接口时的项目工具](batch-1/preview-project-tools.jpg) · [直接打开模型和组件](batch-1/preview-assets.jpg)
- [导入向导的固定目标项目](batch-1/preview-import-target.jpg) · [项目 Mock 运行状态](batch-1/preview-mock-running.jpg)
- [543×638 窄窗的项目工具](batch-1/preview-narrow-project-tools.jpg)

源码预览 `index-Ck4VI606.js` 显示资产、Mock、同步在同一菜单。合成 Mock 实际监听本机。关闭面板后 `GET /echo` 仍返回 `mock_001`。在未打开请求时从目录导入 cURL，经预览、计划、应用后，Core 读回证实目标项目增加 `Imported cURL` 模块，工作区仍为三个项目。完成页误用「项目已导入」，已交第一批修正。此预览早于后续定向验证及最终包。原截图、回执和客户端正常退出证据在 `local/f8-frontend-r7-followup/isolated-t4s5WJ/`。

第一次冻结后的源码预览 `index-BI2Zlfxs.js` 实际勾选合并，界面[显示已合并到明确模块](batch-1/batch1-import-merge-done.jpg)。Core 读回核对唯一 `/followup-merge` 位于预选订单模块，目标项目模块数仍为一，工作区项目数仍为三。该预览未执行撤销。窗口正常退出。回执及原图在 `local/f8-frontend-r7-followup/isolated-xQFYSH/`。

复审版 `index-BP3I4AZ1.js` 的[项目资产面板](batch-1/batch1-assets-review.jpg)显示模型编辑器与具名组件契约编辑器。实窗发现关闭资产时，退出动画会短暂显示空的 Mock 标题，已并入第二批相邻界面修正。过程图和退出回执在 `local/f8-frontend-r7-followup/isolated-bXHHow/`。

## 第二批源码预览

- [认证页与标题旁 AI 建议](batch-2/batch2-auth-preview.jpg) · [从请求直达共享认证组件](batch-2/batch2-shared-auth-located.jpg)
- [缺省参数填值后显示未保存](batch-2/batch2-parameter-dirty.jpg) · [手工清空后恢复缺省](batch-2/batch2-parameter-restored.jpg)

源码预览 `index-R3guUHnz.js` 中，认证页显示当前共享引用和 OAuth 档案操作，点击「查看组件」直接选中合成共享认证。关闭资产时保留原资产标题直至动画结束。查询参数 `optionalId` 原本缺省，填入 `42` 时页签和编辑区出现草稿提示，手动清空后两处同时消失，关闭该请求签没有弹草稿确认。预览未更新 AI 主进程构建，未用来验证缺配置路径。窗口正常退出。原图、过渡图、退出回执在 `local/f8-frontend-r7-followup/isolated-aFHAop/`。

含主进程的后续源码预览 `index-7eDQC_9a.js` 验证了未配置模型时的真实 IPC 路径。点击「AI 建议用例」后直接打开了设置，偏离评审确定的显式入口。第二批独审同时确认认证页仅显示共享组件名，缺少凭据引用和状态。首次现象及退出回执留于 `local/f8-frontend-r7-followup/isolated-tngeb8/`，集中修正后复验。

复审版 `index-BV6Dkfoa.js` 的原生预览验证了[缺模型时先显示建议抽屉](batch-2/batch2-ai-drawer-missing.jpg)，用户点击「打开 AI 设置」后[定位模型配置](batch-2/batch2-ai-settings-models.jpg)。关闭设置只按一次 Enter 即重新打开建议抽屉。未访问外部模型。源图、回焦过程及正常退出回执在 `local/f8-frontend-r7-followup/isolated-knw8LD/`。

## 第三批源码预览

- [未发送且响应收起](batch-3/batch3-preview-unsent.jpg) · [实际发送后展开 HTTP 200](batch-3/batch3-preview-200.jpg)
- [实际 HTTP 503](batch-3/batch3-preview-503.jpg) · [收起期间取消慢请求](batch-3/batch3-preview-cancel.jpg) · [认证页读取共享 Bearer 凭据状态](batch-3/batch3-preview-shared-bearer.jpg)

源码预览 `index-B7vedNIW.js` 采用与基线相同的默认缩放、1097×638 窗口、订单请求和查询参数。预览编辑区约由 251 px 增至 478 px，响应收起条约 36 px。方向键将分隔线由 y=373 移至 y=347，收起再展开回到 y=347。慢请求运行中收起，随后从原发送槽取消，约 6.6 秒时回环连接在响应未完成前关闭，收起条显示已取消。

展开及收起时均能打开调试历史。实测选当前接口并应用筛选，三条记录缩为该接口唯一 503 记录，恢复生成请求草稿且没有新增请求。初版 Esc 后未回到历史按钮，随后修正 Ant Modal 的回焦接线。恢复草稿保留独立临时调试设置和历史来源，保存正式请求后仍有退出保护。该预览已终止其隔离进程，合成项目、历史及记录保留。原图、日志和退出码见 `local/f8-frontend-r7-followup/isolated-4zhlVg/`。

## Windows x64 候选实包

- 1097×638 中文浅色：[未发送](final/final-unsent.jpg) · [发送后 HTTP 200](final/final-200.jpg) · [切签返回仍为收起的 200 摘要](final/final-collapsed-200.jpg) · [HTTP 503](final/final-503.jpg) · [收起中取消](final/final-cancel.jpg) · [共享认证摘要](final/final-shared-auth.jpg)
- 729×577 英文暗色：[收起](final/final-en-dark-narrow.jpg) · [展开](final/final-en-dark-expanded.jpg) · [窄窗 AI 建议](final/final-en-dark-ai.jpg)
- 1097×435 中文短窗：[收起编辑区](final/final-short-collapsed.jpg) · [跳到响应详情](final/final-short-response.jpg)

两场均用 `candidate-1/win-unpacked/apicc.exe`，从 `app.asar` 加载 `index-DpNAnmXq.js`，正常退出。第一场验证常规窗默认收起、打开调试历史后 Esc 关闭和 Enter 重新打开、真实 200、切签保持、共享认证状态和英文暗色。第二场验证真实 503、运行中收起并同位取消、短窗上下跳转。`/slow` 在约 7.4 秒时提前关闭，服务端记录 `completed:false`。实包的未发送编辑区与旧包使用同一请求、窗口和缩放，高度由约 251 px 增至 478 px，空响应缩为约 36 px 的摘要条。原始捕获、窗口树、回环与退出记录分别在 `local/f8-frontend-r7-followup/isolated-fyYnYN/` 和 `isolated-nlaA7p/`。

Windows 目录包冒烟通过，实际验证了包内 IPC／Core 子路径、独立 viewer、source-host helper、应用存活和 renderer 加载。独审核对了候选中 33 个产品和测试源码路径。基线提交 `32cf0b0fde5c21cfe99e3277b13452bd0fd17e77`，包包含本轮工作树改动。ZIP 有 292 个条目，231013193 字节。ZIP 内的 `resources/app.asar` 哈希与实跑目录包一致。

用户手验目录为 `D:/workspace/project-sub/resource/F8-r7-followup/`，含验证 ZIP、已解包的客户端、`start-check.cmd`、说明、合成工作区模板及导入样例。校验了交付目录中 ZIP 和 `app.asar` 的哈希。实际启动交付目录内的客户端，打开了合成工作区，回环 `/echo` 返回 HTTP 200 和 30 条订单数据。正常退出后监听已停止，试运行会话归入 `launcher-verification/`。

| 校验对象 | SHA-256 |
| --- | --- |
| `apicc-f8-workbench-r7-followup-win-x64.zip` | `a54365c665509d77c544cde13d4a234d5400271660539d52a67ffba0cc3b4937` |
| `resources/app.asar` | `804046758431237d0fe1d88d9085e907111c51aec0e29e520591c3a59835c089` |

### 逐项验收

| 需求 | 行为验证与独审 | 实际客户端证据 |
| --- | --- | --- |
| 项目工具、模型与组件 | 第一批定向覆盖空请求区、稳定 ID 定位、草稿、刷新冲突和项目隔离，第三批做接线复查 | 第一批源码预览检查目录入口、窄窗回退与资产面板，实包抽查共享认证摘要 |
| Mock 与外部规范同步入口 | Mock 关闭、重开、草稿和轮询受影响用例通过，项目工具保留同步 | 第一批源码预览关闭面板后真实回环 Mock 仍返回 `mock_001`。本轮同步入口只做回归核对 |
| 目录导入 | 第一批定向验证当前项目与既有模块锁定、确认和撤销 | 第一批源码预览分别走新建和合并，Core 读回目标及模块数量。未在实包重跑导入写入 |
| 认证、凭据与 OAuth | 第二批验证认证页、受管凭据、共享状态、延迟保存与移除、跨项目回执和 OAuth 在途归属 | 预览能直达共享组件，实包读取真实主机返回的未保存状态。外部 OAuth 授权未实连 |
| AI 建议与模型设置 | 第二批验证宽窄和设计入口、缺模型、缺用途绑定、真实配置保存行为和回焦 | 源码预览点入口才到设置，关闭后 Enter 重开。实包英文暗色窄窗显示建议与设置入口。未实连外部模型 |
| 待保存状态 | 第二批验证原缺省、空值、非空、保留其他改动及保存后的基线 | 源码预览填值再清空缺省参数后，两个草稿提示同时消失，关闭请求签无需确认 |
| 响应栏、分隔与后台隔离 | 第三批验证实际开始、预检拒绝、前后台切换、当前交换及正文状态保留 | 实包覆盖 200、503、取消、切签、英文暗色窄窗和短窗。方向键调分隔及恢复位置在源码预览验证 |
| 调试历史 | 第三批验证展开、收起、设计入口共用原面板及回焦 | 实包 Esc 与 Enter 回焦。预览已验证按当前接口筛选和恢复草稿。合格记录分享、重放走原有接线，未在实包重新执行 |

本地验证采用受影响用例、完整桌面构建和 Windows 目录包冒烟。未执行本地全量测试或完整 CI 门禁。
