# 桌面端在线适配收官（计划 C）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复迁移向导对实体化服务端的断点（本地名称树 ↔ 服务端实体寻址的双向映射），在线侧树恢复分组层级，工作区配置叶的服务端口径对齐，admin 侧树消费面回收。规格：`docs/superpowers/specs/2026-09-08-apicc-server-org-rbac-design.md` §4/§7 的收官部分。

**架构：** 迁移断点的根因是「本地盘上名称树 ↔ 服务端实体寻址」之间缺一座映射桥。方案：**映射桥放服务端 API**——迁移推送改为「本地路径 → 先按 (分组名, 项目名) 在服务端解析/创建实体 → 换算 `<projectId>/...` 再推送」，拉取反向「`<projectId>/...` → 查实体名还原本地名称树路径落盘」。桥实现为服务端一个映射端点（批量：本地项目目录名清单 → `{目录名 → 实体 id}`），客户端不维护持久映射表（无状态、可重放）。在线侧树分组层用 tree.projects 已下发的 groupId 组树。**前提依赖：计划 B 已交付（main @ f3d4430）。**

**技术栈：** Spring Boot 服务端（映射端点）/ Electron desktop（迁移向导 + 在线会话 + OnlineApiEditor）/ admin-web（冒烟夹具叶名回收）。

**全局约束（审查者逐字核对项）：**
- 迁移的**服务端只当字节管家**语义不变：本地扫描原文直推，不经模型序列化（hash 稳定性先于形态整洁——migrate.ts 既有裁定）。
- 本地盘上布局**保持名称制不变**（用户可见的工作区目录可读性是产品原则，计划 B 只改了服务端）；映射只发生在内存/请求期。
- 同名合并规则（规格 §4）：本地同名分组推送时按名归并到同一服务端分组（`groups` 表 UNIQUE(ws,name) 天然支持「存在即取，不存在即建（ADMIN+ 时）」）；本地同名项目在服务端**并存**（各自独立实体——与计划 B「项目允许同名」一致），映射按「本地相对目录全路径」唯一化：`groups/<组名>/projects/<项目名>` → 实体 id；同一本地目录重复迁移映射到同一实体（幂等），映射缓存于迁移会话期。
- 非成员权限：无 ADMIN+ 权限时映射只解析不建（缺失 → 该项目所有文件按现有 conflict/forbidden 行呈现，不静默跳过实体创建）。
- 迁移扫描仍跳过 `.apicc/`、`.git/`；`apicc.workspace.yaml` 推送到服务端根级（服务端既有 ADMIN+ 守卫语义）。
- 在线侧树分组层：`projects[].groupId` 已下发；树组为 `分组 → 项目 → 文件`（与本地侧树层级观感一致；分组节点为纯展示层，不影响节点 id=文件路径的既有机制）。
- 桌面端 `canEdit("apicc.workspace.yaml")` 对齐服务端 ADMIN+ 口径（B-任务 7 遗留④）。
- admin-server-smoke 夹具叶名 `apicc.api.yaml` 回收为 `api.yaml`（B-任务 7 遗留①，与其新增的树消费断言配套）。

---

## 文件结构

**服务端（创建/修改）**
- 创建：`server/src/main/java/com/autumnharvestc/server/workspace/ProjectMappingController.java` — 批量项目映射端点
- 创建：`server/src/main/java/com/autumnharvestc/server/workspace/ProjectMappingService.java` — 映射用例（解析/按需建组建项目）
- 创建：`server/src/main/java/com/autumnharvestc/server/workspace/MappingRequest.java` / `MappingView.java` — 载荷与响应 record
- 测试：`server/src/test/java/com/autumnharvestc/server/workspace/ProjectMappingApiTest.java`

**桌面端（修改）**
- 修改：`apps/desktop/src/main/online/session.ts` — 无生产改动预期（parseWorkspacePath 已实体化）；核对
- 修改：`apps/desktop/src/renderer/src/stores/online.ts` — migratePush/migratePull 编排接映射桥
- 修改：`apps/desktop/src/shared/online/contract.ts` — 映射端点契约 + 树分组层类型（如需）
- 修改：`apps/desktop/src/main/online/migrate.ts` — 扫描产物增本地项目目录分段信息（供映射载荷）
- 修改：`apps/desktop/src/renderer/src/stores/online.ts` 的 `canEdit` — apicc.workspace.yaml 对齐 ADMIN+
- 测试：`apps/desktop/tests/main/online/e2e-server.test.ts`（迁移双向真服用例）、`tests/renderer/stores/online.test.ts` / `memory` 替身补映射桩
- 迁移向导 UI（OnlineMigrateDialog.vue）：结果明细已按 path 呈现——服务端实体路径对用户无意义，**展示层改显本地名称路径**（store 换算后传给 UI）

**admin-web**
- 修改：`apps/admin-web/tests/e2e/admin-server-smoke.test.ts` — 叶名回收 `api.yaml`；若其新增树消费断言则同步
- 生产代码 `apps/admin-web/src`：无改动预期（admin 无桌面树组装消费面）

---

### 任务 1：服务端项目映射端点（迁移桥）

**文件：**
- 创建：`server/src/main/java/com/autumnharvestc/server/workspace/MappingRequest.java`、`MappingView.java`、`ProjectMappingService.java`、`ProjectMappingController.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/workspace/ProjectMappingApiTest.java`

- [ ] **步骤 1：编写失败的测试**

```java
    /** POST /api/v1/workspaces/{id}/project-mapping：
     *  entries=[{group:"电商", project:"宠物商店", createIfMissing:true}, ...]
     *  → 200 {mappings:[{group, project, groupId, projectId, created:false}, ...]}
     *  同 (group,project) 幂等返回既有实体；createIfMissing=false 且缺失 → 该行 missing:true。
     */
    @Test
    void mappingResolvesCreatesAndIsIdempotent() throws Exception {
        // 1. ADMIN 建组+项目先（既有实体）→ 映射同名目录 → 返回同一实体 id、created=false
        // 2. 新目录名 + createIfMissing=true → 建组/项目 → created=true；重放同一请求 → 同 id、created=false（幂等）
        // 3. createIfMissing=false 且缺失 → missing:true（不建）
        // 4. EDITOR + createIfMissing=true → 403 forbidden（无权创建时不得静默）
        // 5. name 超长/空白 → 400 validation_failed
    }
```

- [ ] **步骤 2：运行确认失败**（404）
- [ ] **步骤 3：实现**

语义（Service 层，守卫首行 `guard.requireMember`）：
- 逐 entry：组解析 `groupRepo.findByName` → 缺失且 `createIfMissing` 且 ADMIN+ → 建（is_default=false）；缺失否则 → `missing:true` 行。
- 项目解析：`projectRepo.listByGroup(groupId)` 内按 name 找**首个**（同名并存时映射到创建序首个，稳定）；缺失且 `createIfMissing` 且 ADMIN+ → 建。
- 响应含 `groupId/projectId/created`；批量 ≤200。

- [ ] **步骤 4：全量绿**
- [ ] **步骤 5：Commit** `feat(server): 项目映射端点——迁移桥（本地名称目录 ↔ 实体，幂等/按需建）`

---

### 任务 2：desktop 迁移双向接桥

**文件：**
- 修改：`apps/desktop/src/shared/online/contract.ts` — `OnlineMappingEntrySchema/OnlineMappingResultSchema` + `onlineProjectMapping` client 方法
- 修改：`apps/desktop/src/main/online/migrate.ts` — `scanDirFiles` 产物增 `projectDir`（`groups/<组>/projects/<名>` 二元组提取；非项目内文件——根级 `apicc.workspace.yaml` 等——projectDir=null）
- 修改：`apps/desktop/src/renderer/src/stores/online.ts` — migratePush：扫描 → 提取去重目录清单 → 调映射端点（createIfMissing=true）→ 换算 `<projectId>/<本地项目内相对路径>` → batch；migratePull：tree.files 按 projectId 反查目录名 → 落盘路径还原本地名称树形态
- 修改：`apps/desktop/src/renderer/src/components/OnlineMigrateDialog.vue` — 明细 path 显本地名称路径（store 换算后传入）
- 测试：`apps/desktop/tests/renderer/stores/online.test.ts`（memory 替身补 `onlineProjectMapping` 桩——按服务端同语义实现）、`tests/main/online/migrate.test.ts`（projectDir 提取）

- [ ] **步骤 1：失败的测试**：替身桩下迁移 push 断言 batch 路径已换算为 `<projectId>/...`；pull 断言落盘路径为 `groups/<组>/projects/<名>/...` 本地形态；映射缺失行（桩返回 missing）→ 该项目文件计 failed。
- [ ] **步骤 2：RED**（现 push 直发名称路径必 400）
- [ ] **步骤 3：实现**（编排照上文架构；`apicc.workspace.yaml` 根级文件直推不过映射）
- [ ] **步骤 4：全量绿（desktop vitest 全量）**
- [ ] **步骤 5：Commit** `feat(desktop): 迁移向导接实体映射桥——本地名称树与服务端实体寻址双向换算`

---

### 任务 3：真服 E2E 迁移双向用例 + 在线侧树分组层

**文件：**
- 修改：`apps/desktop/tests/main/online/e2e-server.test.ts` — 新增迁移双向场景（真服）：造本地临时名称树 → push → tree 断言实体行/文件可见 → 改本地文件 → 再 push → 409/同 hash 跳过语义 → pull 到另一空目录 → 断言落盘为本地名称树形态且内容一致
- 修改：`apps/desktop/src/main/online/session.ts` — onlineTreeToDto 增分组节点层（groupId → 组名需要映射数据源：**沿用任务 1 映射端点反向**不可行（那是名称→实体）；改为树消费时经 `orgListGroups`（desktop client 已有？核对——无则补只读 client 方法）取组名建 `{groupId → 组名}` 表）
- 测试：onlineTree.test.ts 分组层断言更新

- [ ] **步骤 1：失败的测试**（迁移双向真服用例 RED——当前 push 名称路径 400；树分组层断言 RED——当前扁平）
- [ ] **步骤 2：实现**（如上；分组节点 id 用 `group:<groupId>` 合成前缀，**绝不与文件路径 id 空间重叠**）
- [ ] **步骤 3：全量绿（desktop + 两真服 E2E）**
- [ ] **步骤 4：Commit** `feat(desktop): 迁移双向真服验证 + 在线侧树分组层`

---

### 任务 4：工作区配置叶口径对齐 + admin 侧回收

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/online.ts` — `canEdit("apicc.workspace.yaml")` 收紧为 ADMIN+（读当前工作区 myRole）
- 修改：`apps/admin-web/tests/e2e/admin-server-smoke.test.ts` — 叶名 `apicc.api.yaml` → `api.yaml`
- 测试：online store 相关断言更新

- [ ] **步骤 1：失败的测试**（EDITOR 角色下 canEdit("apicc.workspace.yaml") 期望 false——现状 true）
- [ ] **步骤 2：实现 + GREEN**
- [ ] **步骤 3：全量绿（desktop + admin-web）**
- [ ] **步骤 4：Commit** `fix(desktop,admin-web): 工作区配置叶 ADMIN+ 口径对齐 + admin 冒烟叶名回收`

---

### 任务 5：收尾验证

- [ ] **步骤 1：五包全量**：server mvn test / admin-web vitest+typecheck+build / desktop vitest+typecheck / core+cli vitest——全绿。
- [ ] **步骤 2：真机链路**（起真服 + 打包桌面端 CDP 或 curl 直驱）：connect → 本地名称树 push（新组新项目自动建）→ 改文件再 push（同 hash 跳过）→ pull 到空目录 → 断言本地名称形态还原 → 在线侧树分组层可见（CDP 截图或 DTO 断言）。
- [ ] **步骤 3：品牌门禁 + git status 干净核对。**

## 明确不做（归后续）

在线编辑面扩展（环境/工作流/用例——规格 §9.4 下一轮）；在线树节点选中后的分组级操作（分组管理走控制台）；服务端多工作区握手参数（规格 §1 未来扩展）。
