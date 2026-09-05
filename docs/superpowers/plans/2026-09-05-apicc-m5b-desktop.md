# apicc M5-B 桌面端协议适配实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** 桌面端调试视图支持 WebSocket 与 SOAP 接口：协议选择、按协议字段显隐、ResponseViewer 语义复用（D3 保证）；与 M5-A 内核的中段同步集成。

**工作目录：** `D:\workspace260609\project-2\apicc-m5-desktop`（worktree，分支 `feature/m5-desktop`）。**基线：desktop 450 全绿（main @ 25f5e74）。**

**两阶段执行（M4-A 先例）：** T1 在 main 基线上按**规格契约 fixture** 开发（protocol 字段形状以 M5 规格 D2 为准——`protocol: "http"|"websocket"|"soap"`、ws `message`、soap `envelope`/`soapAction`；本阶段 desktop 的本地 fixture 自建，不依赖新 core）；A 轨合并后 T2 同步 main 做真集成（保存链路过新 schema）。

**全局约束：** 品牌中立；中文 conventional commit（`feat(desktop): ...`）；门禁 = desktop typecheck 双跑 + desktop 全量 + core 全量；i18n zh/en 成对；组件零工厂调用；data-testid 契约保留。

---

### 任务 1：协议选择与字段适配（fixture 阶段）

- [ ] **步骤 1：失败的测试**
  1. RequestEditor：协议选择控件（三选：HTTP/WebSocket/SOAP）→ 切换时字段显隐（WS 隐藏 query/body 区、显示 message 文本域；SOAP 隐藏 query 显示 envelope/soapAction；HTTP 原样）；既有 HTTP 编辑回归不受扰。
  2. 编辑缓冲：protocol/message/envelope/soapAction 进 dirty 快照（切协议保留各自字段内容）；保存载荷携带新字段（fixture 断言）。
  3. ResponseViewer：WS 响应（status=101/bodyText=首帧）与 SOAP 响应（HTTP 语义）按既有渲染零分支工作——fixture 断言。
  4. 新建接口默认协议 http；WS 新接口 method 缺省处理与规格 D2 一致（UI 不显示 method 选择或显示但禁用，选实现干净者并报告注明）。
- [ ] **步骤 2：实现**——editor store 扩展（protocol 等字段进编辑缓冲与快照）、RequestEditor 分区显隐、i18n `protocol.*` zh/en。
- [ ] **步骤 3：门禁 + Commit** `feat(desktop): 调试视图协议选择与字段适配（契约 fixture）`

### 任务 2：内核集成与收口（同步 main 后）

- [ ] **前置**：`git merge main`（M5-A 已合并——协议字段经 core schema 校验生效）。
- [ ] **步骤 1：失败的测试**
  1. 保存链路：WS/SOAP 接口经 api:save → session.saveApi → 新 schema 校验落盘往返（真 core）。
  2. 调试链路：WS/SOAP 接口 sendDebug → 真执行（本地 ws/http server 夹具，复用 desktop e2e-server 的夹具思路）→ ResponseViewer 呈现断言。
  3. 打包冒烟回归。
- [ ] **步骤 2：实现**——同步后暴露的集成缝（若有）；ResponseViewer 对 SOAP fault（HTTP 4xx/5xx + XML 体）呈现核验。
- [ ] **步骤 3：全量 + 打包冒烟 + Commit** `test(desktop): 多协议保存与调试链路集成`

---

## 规格覆盖对照

| 规格（m5 spec §2/§3） | 任务 |
|---|---|
| D8 协议选择/字段显隐 | 1 |
| D3 ResponseViewer 零分支 | 1 |
| D2 保存链路 schema 集成 | 2 |
| D7/D9 调试链路 | 2 |

**明确推迟**：WS/SOAP 压测视图适配（压测面复用 runner，桌面压测面板仅 HTTP——备案）；协议级高级配置（子协议/每消息超时）。
