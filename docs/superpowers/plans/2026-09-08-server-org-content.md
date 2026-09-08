# 服务端组织实体与内容入库（计划 B）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 分组/项目成为服务端一等实体、ACL 挂实体 UUID、内容入库（file_versions 扩 content 列、磁盘内容树退役）、连接握手、服务端默认工作区与默认分组、控制台分组/项目管理页。规格：`docs/superpowers/specs/2026-09-08-apicc-server-org-rbac-design.md` §1/§4/§5/§6/§7。

**架构：** ①`workspaces` 首启自动建唯一「默认工作区」+ 名称唯一；②新增 `groups`/`projects` 表（管理面 API：工作区 ADMIN+）；③`project_acl.project_id` 语义改实体 UUID；④`file_versions` 扩 `content` 列——元数据+字节同表同事务，`WorkspaceContentStore` 磁盘实现退役为初始化兜底删除；⑤`GET /api/v1/connect` 握手；⑥`tree.projects` 改实体表产出、内容 path 首段即 `<projectId>`。**前提依赖：计划 A 已交付的 SUPERADMIN/账号管理（main @ 493c577）。**

**技术栈：** 同计划 A（Spring Boot 3.5.5 / JdbcTemplate / H2 / Vue3+antd admin-web）。

**全局约束（审查者逐字核对项）：**
- 未发布阶段 schema 变更**不迁移**：删 server-data 重开（口径已写入 README/schema 注释/deploy.md——计划 A 发现 3）。所有内容树内既有测试数据随之失效，**服务端 e2e 与桌面端真服务端 E2E 的夹具路径必须同步改**。
- `groups.name` 同工作区唯一（409 group_name_taken）；`projects.name` **允许同名**（与客户端同名放开口径一致，冲突约束在 (group_id, name) 不设——项目以 id 为身份）。
- 服务端默认分组：名「默认分组」、不可删、不可改名（守卫同客户端语义：409/400 语义化错误码）。
- 项目名 sanitize：服务端侧接受 1-64 字符、trim；不再沿用名称制目录约束。
- 内容 path 新规则：首段必须是**存在的项目 UUID**（`<projectId>/...`）；根级文件仅允许 `apicc.workspace.yaml`（工作区配置）；path 校验不再需要禁冒号外的名称制防御，但 `..`/绝对/空段/控制字符/长度 512 校验保留。
- `project_acl.project_id` 列宽 VARCHAR(64) 容纳 UUID 不变；**历史路径哈希行不迁移**（删库重开）。
- `file_versions.content` 为 CLOB（PG 文本）；`size` 口径改「字节长度」（原为落盘 stat，现从 content 计算，列不加——TreeView.FileEntry.size 由 `content.getBytes(UTF_8).length` 得出）。
- 握手 `GET /api/v1/connect`：认证后 200 `{workspaceId, workspaceName, myRole}`；本期恒返默认工作区；工作区不存在（空库）→ 404 workspace_not_found。
- 管理面权限：分组/项目 CRUD = 工作区 ADMIN+（复用 `PermissionService.isAdmin`，守卫在 Service 层首行）。
- 控制台（admin-web）：组件内零工厂调用、store 经路由 props 注入、错误上屏不抛出、路由守卫 await sessionReady（计划 A 既有机制）。

---

## 文件结构

**服务端（创建）**
- `server/src/main/java/com/autumnharvestc/server/store/GroupRecord.java` — groups 行映像
- `server/src/main/java/com/autumnharvestc/server/store/GroupRepo.java` — groups 仓储
- `server/src/main/java/com/autumnharvestc/server/store/ProjectRecord.java` — projects 行映像
- `server/src/main/java/com/autumnharvestc/server/store/ProjectRepo.java` — projects 仓储
- `server/src/main/java/com/autumnharvestc/server/workspace/GroupService.java` — 分组管理用例（ADMIN+ 守卫/默认分组守卫）
- `server/src/main/java/com/autumnharvestc/server/workspace/ProjectService.java` — 项目管理用例（建/改名/移动/删除+内容级联）
- `server/src/main/java/com/autumnharvestc/server/workspace/OrgController.java` — 分组/项目/握手端点
- `server/src/main/java/com/autumnharvestc/server/workspace/OrgRequests.java` — 请求 record
- `server/src/main/java/com/autumnharvestc/server/workspace/ConnectView.java` — 握手响应 record
- `server/src/main/java/com/autumnharvestc/server/core/ContentPaths.java` — 创建：新 path 规则（首段=UUID 项目段解析 + 通用校验）

**服务端（修改）**
- `server/src/main/resources/schema.sql` — groups/projects 表、file_versions.content 列、workspaces.name 唯一约束
- `server/src/main/java/com/autumnharvestc/server/core/ProjectPaths.java` — 退役（仅保留被 ContentPaths 替代引用的常量；或整体替换引用点）
- `server/src/main/java/com/autumnharvestc/server/content/ContentService.java` — path 解析改 ContentPaths、projects 改实体表、size 改字节长、写路径（同事务落 content 列、去磁盘 IO 与回滚补偿）
- `server/src/main/java/com/autumnharvestc/server/store/FileVersionRecord.java` — 加 `content` 字段（读返回含内容）
- `server/src/main/java/com/autumnharvestc/server/store/FileVersionRepo.java` — SQL 扩列；`readContent` 语义并入 find
- `server/src/main/java/com/autumnharvestc/server/workspace/WorkspaceService.java` — create 联动建默认分组；删除工作区级联（现状保留）
- `server/src/main/java/com/autumnharvestc/server/workspace/WorkspaceGuard.java` — 不变（requireMember 复用）
- `server/src/main/java/com/autumnharvestc/server/workspace/ProjectAclService.java` — project_id 语义改实体 UUID（put/list/delete 增加「项目存在」校验）
- 删除：`server/src/main/java/com/autumnharvestc/server/content/WorkspaceContentStore.java`（磁盘内容树退役）
- 删除：`server/src/main/java/com/autumnharvestc/server/core/ProjectPaths.java`（若 ContentPaths 全覆盖其引用）

**测试（服务端）**
- 创建：`server/src/test/java/com/autumnharvestc/server/workspace/OrgApiTest.java`（分组/项目 CRUD+守卫+握手）
- 更新：`server/src/test/java/com/autumnharvestc/server/content/ContentApiContractTest.java`（path 改 `<projectId>/...`、内容入库语义）
- 更新：`server/src/test/java/com/autumnharvestc/server/content/ContentIoFailureTest.java`（磁盘失败注入面消失——改造为事务语义测试或删除，执行者裁定后留痕）
- 更新：`server/src/test/java/com/autumnharvestc/server/workspace/ProjectAclApiContractTest.java`（projectId=实体）
- 更新：`server/src/test/java/com/autumnharvestc/server/workspace/WorkspaceApiContractTest.java`（create 建默认分组联动）

**控制台（admin-web）**
- 修改：`apps/admin-web/src/api/contract.ts` / `client.ts` — 分组/项目 CRUD + 握手 + tree 形状（projects 增 groupId）
- 修改：`apps/admin-web/src/stores/workspaces.ts` — select 后挂分组/项目清单
- 创建：`apps/admin-web/src/stores/org.ts` — 分组/项目管理 store
- 创建：`apps/admin-web/src/views/OrgView.vue` — 分组管理页（含项目清单/移动分组/删除）
- 修改：`apps/admin-web/src/views/LayoutView.vue` / `router/index.ts` — 菜单与路由
- 测试：`apps/admin-web/tests/views/OrgView.test.ts`、`tests/stores/org.test.ts`

**桌面端（仅契约与 E2E 夹具，全量适配留给计划 C）**
- 修改：`apps/desktop/src/shared/online/contract.ts` — tree.projects 增 `groupId`（可选字段，向后兼容）；migrate 契约不动
- 修改：`apps/desktop/tests/main/online/e2e-server.test.ts`、`apps/admin-web/tests/e2e/admin-server-smoke.test.ts` — 推送路径改 `<projectId>/...` 形态（先经握手/建项目 API 拿实体 id）

---

### 任务 1：schema 扩展 + GroupRepo/ProjectRepo + 默认工作区联动

**文件：**
- 修改：`server/src/main/resources/schema.sql`
- 创建：`server/src/main/java/com/autumnharvestc/server/store/GroupRecord.java`、`GroupRepo.java`、`ProjectRecord.java`、`ProjectRepo.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/workspace/WorkspaceService.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/workspace/WorkspaceApiContractTest.java`

- [ ] **步骤 1：编写失败的测试**

`WorkspaceApiContractTest` 追加（该类既有「create 建区」用例同款姿势）：

```java
    /** 规格 §1/§4：建区自动建「默认分组」（不可删语义在 Org 面验证）；ws.name 唯一约束。 */
    @Test
    void createSeedsDefaultGroupAndRejectsDuplicateName() throws Exception {
        String admin = loginAndGetToken("admin", "admin-pass-2026");
        mockMvc.perform(post("/api/v1/workspaces").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"ws-b\"}"))
                .andExpect(status().isCreated());
        // 同名工作区 → 409 workspace_name_taken
        mockMvc.perform(post("/api/v1/workspaces").header("Authorization", "Bearer " + admin)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"ws-b\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("workspace_name_taken"));
        // 默认分组已就位：经 detail 或清单接口断言（以 Org 面任务 2 的端点为准——此处经 DB repo 断言）
        // 实现后改为经 GET /api/v1/workspaces/{id}/groups 断言（任务 2 提供端点后回填此断言）
    }
```

（执行者注：该用例第二段在任务 2 端点落地后回填为 HTTP 断言；本任务先以注入 `GroupRepo` 断言 `groups` 表有一行 `name=默认分组`、`workspace_id` 正确。）

- [ ] **步骤 2：运行确认失败**（GroupRepo 不存在，编译失败即 RED）

运行：`JAVA_HOME="C:\Program Files\Java\jdk-21.0.12" ./mvnw -s .mvn/settings.xml test -Dtest=WorkspaceApiContractTest`（server/ 下）
预期：COMPILATION ERROR

- [ ] **步骤 3：实现**

schema.sql 追加（幂等 DDL；workspaces 表定义处加唯一约束行）：

```sql
-- workspaces 表定义（既有）追加：
--     CONSTRAINT uk_workspaces_name UNIQUE (name)

-- 分组（规格 2026-09-08 §4）：同工作区内名称唯一；默认分组 name='默认分组' 不可删改
CREATE TABLE IF NOT EXISTS groups (
    id           VARCHAR(36) NOT NULL,
    workspace_id VARCHAR(36) NOT NULL,
    name         VARCHAR(64) NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_groups PRIMARY KEY (id),
    CONSTRAINT uk_groups_ws_name UNIQUE (workspace_id, name)
);

-- 项目（规格 §4）：允许同名（身份=id）；挂分组；内容树按项目挂载
CREATE TABLE IF NOT EXISTS projects (
    id           VARCHAR(36) NOT NULL,
    workspace_id VARCHAR(36) NOT NULL,
    group_id     VARCHAR(36) NOT NULL,
    name         VARCHAR(64) NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_projects PRIMARY KEY (id),
    CONSTRAINT fk_projects_group FOREIGN KEY (group_id) REFERENCES groups(id)
);

-- groups 增默认分组标记（seeder/create 落 TRUE；改名/删除守卫判据）
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- file_versions 扩内容列（规格 §5 内容入库）：一行 = 元数据 + 字节（CLOB/PG text）
-- ALTER 形态（幂等：H2 支持 ADD COLUMN IF NOT EXISTS；新库走 CREATE TABLE 已含）：
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS content CLOB;
```

（执行者注：groups 表定义含 `is_default BOOLEAN NOT NULL DEFAULT FALSE`；H2 的 `ADD COLUMN IF NOT EXISTS` 语法在 2.x 可用，若版本不支持，改用「启动时查 information_schema 再 ALTER」的幂等初始化器，落决定于报告。另外原草稿中 groups 定义缺 is_default——以本版为准：**新库 CREATE TABLE 直含 is_default 列，ALTER 仅服务既有测试库重建前的兼容**；统一约定：未发布阶段直接删库重开，ALTER 语句仅作双保险。）

`GroupRecord/ProjectRecord`（record，字段即表列）；`GroupRepo`：`insert/find/listByWorkspace/findByName(workspaceId,name)/updateName/delete`；`ProjectRepo`：`insert/find/listByWorkspace/listByGroup/updateName/moveGroup/delete/countByGroup`。默认工作区+默认分组种子：`WorkspaceService.create` 在事务内建区 + 建「默认分组」行（`groups` 表）；对**已存在的库**由启动幂等初始化器（新增 `workspace/workspace/DefaultWorkspaceSeeder.java`，ApplicationRunner：无任何 workspaces 行时建「默认工作区」+「默认分组」；有则 no-op）补位——与 AdminBootstrap 同款幂等纪律。

- [ ] **步骤 4：运行确认通过 + 全量绿**
- [ ] **步骤 5：Commit**

```bash
git add server/src/main/resources/schema.sql server/src/main/java/com/autumnharvestc/server/store/ server/src/main/java/com/autumnharvestc/server/workspace/
git commit -m "feat(server): groups/projects 实体表 + 默认工作区与默认分组种子 + file_versions 扩 content 列"
```

---

### 任务 2：组织管理 API（分组/项目 CRUD + 握手）

**文件：**
- 创建：`server/src/main/java/com/autumnharvestc/server/workspace/OrgRequests.java`、`ConnectView.java`、`OrgController.java`、`GroupService.java`、`ProjectService.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/workspace/OrgApiTest.java`（创建）

- [ ] **步骤 1：编写失败的测试**

`OrgApiTest`（独立 H2 `apicc-org-api-test`；夹具：admin token、普通成员 alice 入区 EDITOR——经计划 A 的 `PUT /api/v1/admin/users/{id}/workspace-role`，或直接 repo 插 memberships）：

```java
    // 分组：ADMIN+ 才可建；默认分组守卫；重名守卫
    @Test
    void groupCrudGuards() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);
        // EDITOR 建分组 → 403 forbidden
        String alice = loginToken("alice", "password123");
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups").header("Authorization", "Bearer " + alice)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"研发\"}"))
                .andExpect(status().isForbidden());
        // ADMIN 建分组 → 201 {id, name}
        var created = postGroup(admin, wsId, "研发");
        // 同名 → 409 group_name_taken
        postGroup(admin, wsId, "研发").andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("group_name_taken"));
        // 改名 → 200；与另一分组撞名 → 409
        renameGroup(admin, wsId, groupId(created), "平台组");
        String other = groupId(postGroup(admin, wsId, "后端组"));
        renameGroup(admin, wsId, other, "平台组").andExpect(status().isConflict());
        // 默认分组：改名/删除 → 400 default_group_immutable
        String defaultId = defaultGroupId(admin, wsId);
        renameGroup(admin, wsId, defaultId, "改").andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("default_group_immutable"));
        deleteGroup(admin, wsId, defaultId).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("default_group_immutable"));
        // 非空分组删除 → 409 group_not_empty；空分组 → 204
        createProject(admin, wsId, other, "项目甲");
        deleteGroup(admin, wsId, other).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("group_not_empty"));
    }

    // 项目：建/改名/移动/删除；同名允许；删除级联内容
    @Test
    void projectCrudAndCascade() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        String wsId = defaultWorkspaceId(admin);
        String g = groupId(postGroup(admin, wsId, "g1"));
        // 同名项目并存 → 均 201，id 不同
        var p1 = createProject(admin, wsId, g, "同名项目");
        var p2 = createProject(admin, wsId, g, "同名项目");
        assertThat(idOf(p1)).isNotEqualTo(idOf(p2));
        // 项目名空白/超长 → 400 validation_failed
        // 移动分组 → 204；目标分组不存在 → 404 group_not_found
        // 推一个文件进 p1 再删除 p1 → 204；文件行随之消失（file_versions 按 project_id 前缀删除）
        putFile(admin, wsId, idOf(p1) + "/apis/a/api.yaml", "hello");
        deleteProject(admin, wsId, idOf(p1));
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree").header("Authorization", "Bearer " + admin))
                .andExpect(jsonPath("$.projects[?(@.id=='" + idOf(p1) + "')]").isEmpty());
    }

    // 握手：认证后返回默认工作区
    @Test
    void connectReturnsDefaultWorkspace() throws Exception {
        String admin = loginToken("admin", "admin-pass-2026");
        mockMvc.perform(get("/api/v1/connect").header("Authorization", "Bearer " + admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceName").value("默认工作区"))
                .andExpect(jsonPath("$.myRole").value("ADMIN"));
    }
```

（`postGroup/renameGroup/deleteGroup/createProject/putFile/defaultWorkspaceId/defaultGroupId/groupId/idOf` 为类内夹具方法；`myRole` 断言按 admin 在该区实际角色——种子建区者=ADMIN，若建区走 seeder 则经 workspace-role 设为 ADMIN，执行时按夹具实际对齐。）

- [ ] **步骤 2：运行确认失败**（404，端点不存在）
- [ ] **步骤 3：实现**

`OrgRequests.java`：

```java
public final class OrgRequests {
    public record CreateGroupRequest(@NotBlank @Size(max = 64) String name) { }
    public record RenameGroupRequest(@NotBlank @Size(max = 64) String name) { }
    public record CreateProjectRequest(@NotBlank @Size(max = 64) String name) { }
    public record RenameProjectRequest(@NotBlank @Size(max = 64) String name) { }
}
```

`GroupService`（守卫首行 `permissions.isAdmin(guard.requireMember(...))`）：
- `create`：ADMIN+ → 重名 409 `group_name_taken`（含 `DuplicateKeyException` 兜底）→ 插行。
- `rename`：默认分组（`name.equals("默认分组")` 且为该区初始分组——以「区内的默认分组行」判定，实现上 `groups` 表加 `is_default BOOLEAN DEFAULT FALSE` 列更稳，**采用加列**：schema 的 groups 定义加 `is_default BOOLEAN NOT NULL DEFAULT FALSE`，seeder/create 落 TRUE）→ 400 `default_group_immutable`；撞名 409。
- `delete`：默认分组 400；`projects.countByGroup(id) > 0` → 409 `group_not_empty`；删行。

`ProjectService`：
- `create(groupId, name)`：分组须属于该工作区（404 `group_not_found`）；**不查重名**；插行。
- `rename/move`：move 目标分组存在性 404；改名不查重（同名允许）。
- `delete(projectId)`：先 `fileVersions.deleteByProjectPrefix`（新增 repo 方法：`DELETE FROM file_versions WHERE workspace_id=? AND path LIKE '<projectId>/%'`——UUID 无 SQL 通配字符，安全）与 `project_acl.deleteByProject`（新增），再删实体行。
- `connect(caller)`：取唯一工作区（无 → 404 `workspace_not_found`）→ `{workspaceId, name, myRole: guard.requireMember(...).toDb()}`。

`OrgController`：`GET/POST /api/v1/workspaces/{id}/groups`、`POST /api/v1/workspaces/{id}/groups/{gid}/rename`、`DELETE .../groups/{gid}`、`POST .../projects`、`POST .../projects/{pid}/rename`、`POST .../projects/{pid}/move {groupId}`、`DELETE .../projects/{pid}`、`GET /api/v1/connect`。

- [ ] **步骤 4：运行确认通过 + 全量绿**（149+新增）
- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/workspace/ server/src/test/java/com/autumnharvestc/server/workspace/OrgApiTest.java server/src/main/resources/schema.sql
git commit -m "feat(server): 分组/项目管理 API + 连接握手 + 默认分组守卫"
```

---

### 任务 3：内容入库（file_versions.content）+ ContentService 去磁盘化

**文件：**
- 修改：`server/src/main/java/com/autumnharvestc/server/store/FileVersionRecord.java`、`FileVersionRepo.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/content/ContentService.java`
- 删除：`server/src/main/java/com/autumnharvestc/server/content/WorkspaceContentStore.java`
- 测试：更新 `ContentApiContractTest`、改造/删除 `ContentIoFailureTest`

- [ ] **步骤 1：编写失败的测试**

`ContentApiContractTest` 核心新断言（既有契约形状不变，数据来源变）：

```java
    /** 规格 §5 内容入库：PUT 后 file_versions.content 即有字节；盘上无文件。 */
    @Test
    void putPersistsContentInDbWithoutDiskTree() throws Exception {
        // putFile(...) 201 → 注入 JdbcTemplate 断言
        //   SELECT content FROM file_versions WHERE workspace_id=? AND path=? → 内容一致
        //   且 Files.notExists(数据目录/workspaces/<wsId>/<path>)（磁盘内容树退役）
    }

    /** 读回：GET files 批量取的内容来自 content 列（与 PUT 内容逐字一致）。既有断言保持。 */
```

`ContentIoFailureTest`：磁盘失败注入不再存在——**删除该测试类**，其「回滚对称性」的并发语义由既有 `deleteIfVersion/restoreAfterBump` 单元面保留（这些 repo 方法中磁盘回滚相关者一并删除），在报告中留痕。

- [ ] **步骤 2：运行确认失败**
- [ ] **步骤 3：实现**

- `FileVersionRecord` 加 `String content`；repo 的 SELECT/INSERT/bump 全部扩列（`bumpVersion` 加 `content` 参数——版本推进与内容写入同一条 UPDATE，天然同事务）；`insertNew` 同理。`sumVersions/listByWorkspace/find` 返回含 content（tree 面不需要 content，列表 SQL 可仍不带列——按两套 SQL 处理：`listByWorkspace`（无 content，tree 用）与 `find`（含 content，读面用），避免 tree 全量拉内容）。
- `ContentService`：`readFiles` 的字节改 `row.content().getBytes(UTF_8)`；`TreeView.FileEntry.size` 改 `row` 无 content 时不可得——**改为 files 列表 SQL 也带 content？否**：tree 面 size 需要 content 长度——在 `listByWorkspace` 上带 `OCTET_LENGTH(content)` 作 `content_size` 列（H2/PG 皆可），`FileVersionRecord` 加 `long contentSize`（仅列表 SQL 填充），tree 的 size 取该值。`putChecked`：删 `contentStore.writeFile` 与全部回滚补偿分支（版本行+content 同事务，无「库旧盘新」撕裂）；`deleteFile`：删删盘分支。`contentStore` 字段与构造参数移除；`WorkspaceContentStore.java` 删除。
- `ProjectPaths` 引用切到新 `ContentPaths`（任务 4 一并做则本任务暂保 ProjectPaths.validate 复用——**执行顺序调整为任务 4 先行**：先落 ContentPaths，再改 ContentService。两个任务在同一分支连续提交，报告里说明顺序）。
- 既有「同名项目按 path 定位」的 ACL 判定：`effectiveRoleFor(path)` 改从 path 首段取 projectId（任务 4 的 ContentPaths 提供），其余不变。

- [ ] **步骤 4：运行确认通过 + 全量绿**
- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/content/ server/src/main/java/com/autumnharvestc/server/store/ server/src/test/java/com/autumnharvestc/server/content/
git commit -m "feat(server): 内容入库——file_versions.content 列承载字节，磁盘内容树退役"
```

---

### 任务 4：ContentPaths（新 path 规则）+ ContentService 实体化

**文件：**
- 创建：`server/src/main/java/com/autumnharvestc/server/core/ContentPaths.java`
- 删除：`server/src/main/java/com/autumnharvestc/server/core/ProjectPaths.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/content/ContentService.java`（tree 的 projects 改实体表；ACL 判定改 path 首段）
- 测试：更新 `ContentApiContractTest`、`ProjectAclApiContractTest`

- [ ] **步骤 1：编写失败的测试**

```java
    /** 新 path 规则：首段必须是存在的项目 UUID；根级仅允许 apicc.workspace.yaml。 */
    @Test
    void pathFirstSegmentMustBeExistingProjectId() throws Exception {
        // PUT "not-a-uuid/apis/a.yaml" → 400 path_invalid
        // PUT "<未存在UUID>/x" → 404 project_not_found（项目不存在，非路径非法）
        // PUT "apicc.workspace.yaml" → 既有 ADMIN+ 语义保持
        // GET tree：projects 来自实体表（建 2 个同名项目各推 1 文件 → projects[] 2 行、id 各异、groupId 在列）
    }
```

- [ ] **步骤 2：运行确认失败**
- [ ] **步骤 3：实现**

`ContentPaths`：
- 保留 `ProjectPaths` 的通用校验（长度/空段/../绝对/控制字符；**移除禁冒号**——id 段无冒号风险，名称不再上盘）。
- `parseProject(path)` → `Optional<String>`：首段为 UUID 形态即返回；根级 `apicc.workspace.yaml` 特判。
- `validate(path, projectIdExists)`：首段非 UUID → 400 path_invalid；首段 UUID 但项目不存在 → 404 project_not_found（由 ContentService 查实体表判定）。

`ContentService.tree`：`projects` 改 `projectRepo.listByWorkspace(workspaceId)` 产出（`{id, name, groupId, myRole}`——`myRole` 仍走 `permissions.effectiveRole(workspaceId, userId, projectId)`，NONE 行不出现）；`files` 遍历版本行、按 path 首段 projectId 过滤读权。`effectiveRoleFor(path)`：首段解析（非 UUID 的根级路径按工作区角色）。`ProjectPaths` 删除，全仓 grep 引用清零（测试里的路径常量一并改）。

- [ ] **步骤 4：运行确认通过 + 全量绿**
- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/ server/src/test/java/com/autumnharvestc/server/
git commit -m "feat(server): 内容 path 实体化（首段=项目 UUID）+ tree.projects 改实体表产出"
```

---

### 任务 5：ACL 挂实体 + ProjectAclService 实体校验

**文件：**
- 修改：`server/src/main/java/com/autumnharvestc/server/workspace/ProjectAclService.java`
- 测试：更新 `ProjectAclApiContractTest`

- [ ] **步骤 1：编写失败的测试**：对不存在项目设 ACL → 404 `project_not_found`；对实体项目 set/list/delete 既有断言保持（projectId 用真实实体 UUID）。
- [ ] **步骤 2：RED**（现状任意 id 可预设 → 404 断言失败）
- [ ] **步骤 3：实现**：put/list/delete 前查 `projects.find(workspaceId, projectId)`（404）。语义说明（报告留痕）：历史「任意 id 可预设」是为支持先设 ACL 后推内容；实体化后项目必先经管理面创建，语义收紧合理。
- [ ] **步骤 4：全量绿**
- [ ] **步骤 5：Commit** `feat(server): 项目 ACL 挂实体 UUID（预设改校验项目存在）`

---

### 任务 6：控制台——组织管理页（分组/项目 CRUD）

**文件：**
- 修改：`apps/admin-web/src/api/contract.ts`、`client.ts`
- 创建：`apps/admin-web/src/stores/org.ts`、`apps/admin-web/src/views/OrgView.vue`
- 修改：`apps/admin-web/src/views/LayoutView.vue`、`router/index.ts`
- 测试：`apps/admin-web/tests/views/OrgView.test.ts`、`tests/stores/org.test.ts`

- [ ] **步骤 1：失败的测试**（fetch 桩，模式同 UsersView）：分组清单渲染/建分组载荷断言/重名 409 上屏不关窗/默认分组删除禁用与 400 上屏/项目清单按分组过滤/建项目/移动分组/删除项目确认。
- [ ] **步骤 2：RED**（OrgView 不存在）
- [ ] **步骤 3：实现**：client 方法（`orgListGroups/orgCreateGroup/orgRenameGroup/orgDeleteGroup/orgListProjects/orgCreateProject/orgRenameProject/orgMoveProject/orgDeleteProject`——与服务端任务 2 端点逐字对齐）；org store（workspaces 模式：error 上屏不抛出）；OrgView（左分组清单+右项目卡片网格，操作走 a-modal 确认——**沿 UsersView/ConnectionPanel 既有受控 modal 模式**）；菜单「组织管理」（所有成员可见，操作按钮按 `workspace.myRole` ADMIN+ 显隐——`/me`+detail 已有 role）；路由 props 注入。
- [ ] **步骤 4：GREEN + typecheck + 全量绿**
- [ ] **步骤 5：Commit** `feat(admin-web): 组织管理页（分组/项目 CRUD，ADMIN+ 操作）`

---

### 任务 7：桌面端契约与 E2E 夹具适配（计划 C 的先行最小集）

**文件：**
- 修改：`apps/desktop/src/shared/online/contract.ts`（tree.projects 增可选 `groupId`；path 规则禁冒号约束放开——服务端已无名称目录）
- 修改：`apps/desktop/tests/main/online/e2e-server.test.ts`、`apps/admin-web/tests/e2e/admin-server-smoke.test.ts`

- [ ] **步骤 1：失败的测试**：两个真服务端 E2E 现状推 `groups/demo/projects/svc/...` 路径 → 服务端 400 path_invalid（首段非 UUID）→ 必然失败。
- [ ] **步骤 2：RED 确认**（跑 e2e-server.test 单文件）
- [ ] **步骤 3：实现**：
  - contract：`OnlineTreeProjectSchema` 增 `groupId: z.string().optional()`；`OnlinePathSchema` 移除 `:` 禁令（其余保留）。
  - E2E 夹具改造：先 `GET /api/v1/connect` → `POST /api/v1/workspaces/{id}/groups`（默认分组已存在，可直接用清单取 id）→ `POST .../projects` 建项目取实体 id → 推送路径改 `<projectId>/apis/...`；batch/tree 断言同步。两文件同改。
  - `apps/desktop/src` 生产代码**不动**（OnlineApiEditor 等对 path 透明；migrate 面在计划 C 全面适配——其「本地名称树→在线」扫描在计划 B 后会失败，**在报告中标注为已知断点，计划 C 任务 1 首先修复**）。
- [ ] **步骤 4：两个 E2E 绿 + desktop 全量绿**
- [ ] **步骤 5：Commit** `fix(desktop,e2e): 真服务端 E2E 适配内容 path 实体化（先建实体项目再推送）；tree 契约增 groupId`

---

### 任务 8：收尾验证

- [ ] **步骤 1：全量**：server mvn test / admin-web vitest+typecheck+build / desktop vitest / core+cli vitest——全绿。
- [ ] **步骤 2：真机链路**（curl）：起真服 → connect 握手 → 建分组 → 建项目 ×2（同名）→ 推文件进两项目 → tree 断言 2 实体行 → ACL 对项目乙设 NONE → 丙账号 tree 不可见项目乙 → 删项目甲级联 → 非空分组删除 409。
- [ ] **步骤 3：推送前核对**：品牌门禁 `node scripts/check-brand-neutral.mjs`；`git status` 干净。
