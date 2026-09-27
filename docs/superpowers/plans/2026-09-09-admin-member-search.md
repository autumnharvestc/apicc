# 成员按用户名搜索下拉（批 2）实现计划

> **状态：** 已完成并归档。功能提交序列由 `fe408c9` 开始，最终通过 `ebad257` 合并；后续 BIGINT 改造通过 `066b637` 合并。
>
> **复验：** 2026-09-27 在 JDK 21.0.12 下完成；admin-web 15 个测试文件、185 个测试通过，admin-web typecheck 通过，服务端 `MemberApiContractTest` 16 个测试通过。
>
> **历史说明：** 下方复选框和代码片段保留原始执行计划形态，不据事后结果回填 TDD 红灯过程；当前代码与类型以仓库实现为准。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 工作区加成员/项目 ACL 加人从「手输 userId」改为「用户名/昵称远程搜索下拉选择」，内部 id 不再出现在任何输入框（规格：docs/superpowers/specs/2026-09-09-server-bigint-pks-and-member-ux-design.md 缺陷二）。

**架构：** 服务端新增 `GET /api/v1/workspaces/{id}/member-candidates?q=&limit=`（ADMIN+，排除已有成员与停用账号）；admin-web 增用户选择器 composable（成员清单 + 非成员候选合并、username 作选项 value、提交时解析为 id），MembersView 与 ProjectAclView 两个添加行同款接入。

**技术栈：** Spring Boot 3（MockMvc 契约测试）、Vue 3 + antd-vue（a-auto-complete）、Pinia、vitest（jsdom 全挂载 + fetch stub，仓库既有 harness）。

**范围说明：** 规格原文只点了 MembersView；ProjectAclView 的添加行是同一缺陷类（同样手输 userId，i18n 里第二组 userIdPlaceholder 即它），按用户「这种错误以后不准再犯」的先例级口径一并修，复用同一端点与 composable。

**环境约束（务必遵守）：**
- 服务端构建：`JAVA_HOME="C:\Program Files\Java\jdk-21.0.12" mvn -s server/.mvn/settings.xml -f server/pom.xml test`（PATH 默认 java 是 1.8，必须显式 JAVA_HOME）。
- admin-web：仓库根 `pnpm --filter @apicc/admin-web test` / `pnpm --filter @apicc/admin-web typecheck`。
- 写代码禁用 heredoc；块注释内禁出现「星号斜杠」序列。
- 测试布局注释习惯：每个测试类/文件头部注明任务来源与裁定依据；用例名英文、注释中文。

---

## 归档说明（2026-09-27）

### 最终实现与原计划差异

- 关联规格原写“桌面端”，最终功能落在现有 admin-web 管理端；关联规格已同步修正为管理端 Web，避免未来重复实现第二套成员管理 UI。
- `ProjectAclView` 与 `MembersView` 共同接入 `userPicker`，落实“用户不手输内部 id”的同类缺陷治理。
- 后续 BIGINT 改造使仓储层工作区 id 使用 `Long`；本计划中的 `String workspaceId` 示例是改造前历史形态，不可按当前代码直接复制。
- 最终实现额外包含候选请求竞态收口、作废请求后的 loading 复位、ACL 候选错误上屏、切换工作区复位添加行、Enter 提交恢复，以及候选出参形状契约测试。

### 当前 PowerShell 复验命令

```powershell
pnpm --filter @apicc/admin-web test -- client workspaces MembersView ProjectAclView
pnpm --filter @apicc/admin-web typecheck

$env:JAVA_HOME = "C:\Program Files\Java\jdk-21.0.12"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
.\server\mvnw.cmd -s server\.mvn\settings.xml -f server\pom.xml -Dtest=MemberApiContractTest test
```

2026-09-27 复验结果：admin-web `15/15` 测试文件、`185/185` 测试通过；typecheck 通过；服务端 `16/16` 测试通过。

---

## 文件结构

**创建：**
- `server/src/main/java/com/autumnharvestc/server/workspace/UserCandidateView.java` — 候选行视图 record（id/username/displayName，无 role——候选尚非成员）。
- `apps/admin-web/src/composables/userPicker.ts` — 用户选择器：成员+候选合并选项、debounce 远程搜索、username→id 解析。

**修改：**
- `server/src/main/java/com/autumnharvestc/server/store/UserRepo.java` — 增 `searchCandidates(workspaceId, keyword, limit)`。
- `server/src/main/java/com/autumnharvestc/server/workspace/MemberService.java` — 增 `candidates`（权限+校验+夹取）。
- `server/src/main/java/com/autumnharvestc/server/workspace/MemberController.java` — 增 GET 端点。
- `server/src/test/java/com/autumnharvestc/server/workspace/MemberApiContractTest.java` — 增 4 组契约测试。
- `apps/admin-web/src/api/contract.ts` — 增 `AdminUserCandidateSchema` + 类型。
- `apps/admin-web/src/api/client.ts` — 增 `searchUserCandidates`（接口声明 + 实现）。
- `apps/admin-web/src/stores/workspaces.ts` — 增 `candidates/candidatesLoading/candidatesError` 状态 + `searchCandidates/clearCandidates` actions。
- `apps/admin-web/src/views/MembersView.vue` — 添加行换 userPicker。
- `apps/admin-web/src/views/ProjectAclView.vue` — 添加行换 userPicker（原 memberOptions 直拼移除）。
- `apps/admin-web/src/i18n/zh-CN.json`、`apps/admin-web/src/i18n/en.json` — members/acl 段换占位与校验文案，删 userIdPlaceholder/userIdRequired。
- `apps/admin-web/tests/api/client.test.ts`、`apps/admin-web/tests/stores/workspaces.test.ts`、`apps/admin-web/tests/views/MembersView.test.ts`、`apps/admin-web/tests/views/ProjectAclView.test.ts` — 对应测试。

---

### 任务 1：服务端候选端点（repo → service → controller + 契约测试）

**文件：**
- 修改：`server/src/main/java/com/autumnharvestc/server/store/UserRepo.java`
- 创建：`server/src/main/java/com/autumnharvestc/server/workspace/UserCandidateView.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/workspace/MemberService.java`
- 修改：`server/src/main/java/com/autumnharvestc/server/workspace/MemberController.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/workspace/MemberApiContractTest.java`

- [ ] **步骤 1：写失败的契约测试**

在 `MemberApiContractTest` 追加（imports 补 `get`、`java.time.Instant`、`java.util.UUID`、`com.autumnharvestc.server.store.UserRepo`、`com.autumnharvestc.server.store.UserAccount`、`com.autumnharvestc.server.store.PlatformRole`、`org.springframework.beans.factory.annotation.Autowired`，Hamcrest 的 `hasItem`/`hasSize`/`not`——文件已有则不加）：

```java
// ---- GET member-candidates（规格 2026-09-09 成员搜索：ADMIN+、排除已有成员与停用账号）----

@Autowired
private UserRepo users;

@Test
void candidatesMatchUsernameOrDisplayNameExcludeMembersAndHonorLimit() throws Exception {
    String[] owner = newUser("sc-owner");
    String ws = createWorkspace(owner[1], "候选搜索工作区");
    String[] member = newUser("sc-member");
    putMember(owner[1], ws, member[0], "EDITOR"); // 已是成员 → 不入候选
    newUser("sc-alice");
    newUser("sc-bob");

    // 关键字命中 username；已成员被排除
    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + owner[1])
                    .param("q", "sc-"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[*].username", hasItem("sc-alice")))
            .andExpect(jsonPath("$[*].username", hasItem("sc-bob")))
            .andExpect(jsonPath("$[*].username", not(hasItem("sc-member"))));

    // displayName 命中（注册 displayName = "显示名-" + username）
    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + owner[1])
                    .param("q", "显示名-sc-alice"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(1)))
            .andExpect(jsonPath("$[0].id").value(member[0] == null ? "" : not(emptyString())))
            .andExpect(jsonPath("$[0].username").value("sc-alice"));

    // limit 截断（默认 10，可显式收窄）
    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + owner[1])
                    .param("q", "sc-")
                    .param("limit", "1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(1)));
}

@Test
void candidatesExcludeDisabledUsers() throws Exception {
    String[] owner = newUser("scd-owner");
    String ws = createWorkspace(owner[1], "停用候选工作区");
    users.insert(new UserAccount(UUID.randomUUID().toString(), "scd-dead",
            "$2a$10$disabledplaceholderhashdeadbeefcafebabe0000000000000000", "停用者",
            PlatformRole.USER, true, Instant.now()));

    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + owner[1])
                    .param("q", "scd-dead"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(0)));
}

@Test
void candidatesRequireWorkspaceAdmin() throws Exception {
    String[] owner = newUser("sca-owner");
    String ws = createWorkspace(owner[1], "候选权限工作区");
    String[] viewer = newUser("sca-viewer");
    putMember(owner[1], ws, viewer[0], "VIEWER");

    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + viewer[1])
                    .param("q", "sca"))
            .andExpect(status().isForbidden());
}

@Test
void candidatesValidateQuery() throws Exception {
    String[] owner = newUser("scv-owner");
    String ws = createWorkspace(owner[1], "候选校验工作区");
    String token = owner[1];

    // q 缺省 → 400 validation_failed
    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + token))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("validation_failed"));
    // 纯空白 → 400
    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + token)
                    .param("q", "   "))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("validation_failed"));
    // 超长（>32）→ 400
    mockMvc.perform(get("/api/v1/workspaces/" + ws + "/member-candidates")
                    .header("Authorization", "Bearer " + token)
                    .param("q", "x".repeat(33)))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("validation_failed"));
}
```

注意：`candidatesMatchUsernameOrDisplayNameExcludeMembersAndHonorLimit` 里 displayName 用例的 `jsonPath("$[0].id")` 断言写法若 Hamcrest 组合不便，可简化为只断 `username`（形状由第一条用例覆盖）；`emptyString()` 需要额外 import，不值得——直接删掉那行，断 username 即可。

- [ ] **步骤 2：运行验证失败**

```bash
JAVA_HOME="C:\Program Files\Java\jdk-21.0.12" mvn -s server/.mvn/settings.xml -f server/pom.xml test -Dtest=MemberApiContractTest
```
预期：编译失败（`get`/`UserRepo` 等 import 已加则 404 失败——端点不存在）。

- [ ] **步骤 3：实现**

`UserRepo` 追加方法（放 `findByUsername` 之后）：

```java
/** 成员候选搜索（规格 2026-09-09 成员搜索）：username/display_name 大小写不敏感包含匹配，
 * 排除已有成员与停用账号，username 升序截前 limit 条。LIKE 通配符转义防关键字注入语义。 */
public List<UserAccount> searchCandidates(String workspaceId, String keyword, int limit) {
    String escaped = keyword.toLowerCase()
            .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    String like = "%" + escaped + "%";
    return jdbc.query("""
            SELECT u.id, u.username, u.password_hash, u.display_name, u.role, u.disabled, u.created_at
            FROM users u
            WHERE u.disabled = FALSE
              AND NOT EXISTS (SELECT 1 FROM memberships m
                              WHERE m.workspace_id = ? AND m.user_id = u.id)
              AND (LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\')
            ORDER BY u.username
            LIMIT ?
            """, MAPPER, workspaceId, like, like, limit);
}
```

创建 `UserCandidateView.java`：

```java
package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.store.UserAccount;

/**
 * 成员候选行（规格 2026-09-09 成员搜索）：添加成员/项目 ACL 搜索下拉的数据源。
 * 无 role——候选尚非成员；不含 password 哈希（出参最小化同 MemberView 口径）。
 */
public record UserCandidateView(String id, String username, String displayName) {

    public static UserCandidateView of(UserAccount user) {
        return new UserCandidateView(user.id(), user.username(), user.displayName());
    }
}
```

`MemberService` 追加（`delete` 之后；imports 补 `java.util.Integer` 不需要——直接用 `Integer`）：

```java
/** 成员候选搜索（规格 2026-09-09）：权限同添加成员（ADMIN+）；q 必填非空、trim 后 ≤32 字符，
 * limit 缺省 10、夹取 1..50。只回非成员候选（排除停用账号在 SQL 层）。 */
public List<UserCandidateView> candidates(UserAccount caller, String workspaceId, String q, Integer limit) {
    guard.requireAdmin(workspaceId, caller);
    String keyword = q == null ? "" : q.trim();
    if (keyword.isEmpty() || keyword.length() > 32) {
        throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "搜索关键字必填且不超过 32 字符");
    }
    int capped = limit == null ? 10 : Math.max(1, Math.min(50, limit));
    return users.searchCandidates(workspaceId, keyword, capped).stream()
            .map(UserCandidateView::of)
            .toList();
}
```

`MemberController` 追加（imports 补 `org.springframework.web.bind.annotation.RequestParam`）：

```java
/** 200 [{id, username, displayName}]（ADMIN+）；400 validation_failed；403 非管理员（规格 2026-09-09）。 */
@GetMapping("/api/v1/workspaces/{id}/member-candidates")
public List<UserCandidateView> candidates(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                          @PathVariable String id,
                                          @RequestParam(required = false) String q,
                                          @RequestParam(required = false) Integer limit) {
    return members.candidates(caller, id, q, limit);
}
```

- [ ] **步骤 4：运行验证通过**

```bash
JAVA_HOME="C:\Program Files\Java\jdk-21.0.12" mvn -s server/.mvn/settings.xml -f server/pom.xml test -Dtest=MemberApiContractTest
```
预期：PASS（全类）。403 的错误码以 `WorkspaceGuard.requireAdmin` 实际抛出为准，测试只断 status。

- [ ] **步骤 5：Commit**

```bash
git add server/src/main/java/com/autumnharvestc/server/store/UserRepo.java server/src/main/java/com/autumnharvestc/server/workspace/UserCandidateView.java server/src/main/java/com/autumnharvestc/server/workspace/MemberService.java server/src/main/java/com/autumnharvestc/server/workspace/MemberController.java server/src/test/java/com/autumnharvestc/server/workspace/MemberApiContractTest.java
git commit -m "feat(server): 成员候选搜索端点——username/displayName 匹配、排除已有成员与停用账号"
```

---

### 任务 2：admin-web 契约与 client

**文件：**
- 修改：`apps/admin-web/src/api/contract.ts`
- 修改：`apps/admin-web/src/api/client.ts`
- 测试：`apps/admin-web/tests/api/client.test.ts`

- [ ] **步骤 1：写失败的 client 测试**

`client.test.ts` 追加用例（沿用文件既有 fetch stub 模式；放置在 listMembers 相关用例后）：

```ts
it("searchUserCandidates：GET member-candidates 携 q/limit 并解析数组", async () => {
  const { client, calls } = createClientWithStub(() =>
    json(200, [{ id: "u-9", username: "dave", displayName: "Dave" }]),
  );
  await client.login("alice", "password123"); // 沿用文件既有登录铺路方式
  const rows = await client.searchUserCandidates("ws-1", "da", 10);
  expect(rows).toEqual([{ id: "u-9", username: "dave", displayName: "Dave" }]);
  const get = calls.find((c) => c.method === "GET" && c.url.includes("/member-candidates"));
  expect(get).toBeDefined();
  expect(get!.url).toContain("q=da");
  expect(get!.url).toContain("limit=10");
});
```

（若该文件的 client 构造/登录辅件名不同，以文件内既有用例为准照抄其形，只换断言体。）

- [ ] **步骤 2：运行验证失败**

```bash
pnpm --filter @apicc/admin-web test -- client
```
预期：FAIL（`searchUserCandidates` 不存在，TS 编译错）。

- [ ] **步骤 3：实现**

`contract.ts`（`AdminMemberSchema` 之后）：

```ts
/** 成员候选行（规格 2026-09-09 成员搜索）：添加成员/项目 ACL 搜索下拉数据源——无 role（候选尚非成员）。 */
export const AdminUserCandidateSchema = z.object({ id: z.string(), username: z.string(), displayName: z.string() });
```
类型导出区：`export type AdminUserCandidate = z.infer<typeof AdminUserCandidateSchema>;`

`client.ts` 接口（`listMembers` 声明后）：

```ts
/** GET /workspaces/{id}/member-candidates?q=&limit=：非成员候选（ADMIN+；400/403 由服务端裁决）。 */
searchUserCandidates(workspaceId: string, q: string, limit?: number): Promise<AdminUserCandidate[]>;
```

实现（`listMembers` 实现后；imports 补 `AdminUserCandidateSchema` 与类型 `AdminUserCandidate`）：

```ts
async searchUserCandidates(workspaceId, q, limit) {
  const query: Record<string, string> = { q };
  if (limit !== undefined) query["limit"] = String(limit);
  return (await request({
    method: "GET",
    path: workspacePath(workspaceId, "/member-candidates"),
    query,
    schema: z.array(AdminUserCandidateSchema),
  })) as AdminUserCandidate[];
},
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm --filter @apicc/admin-web test -- client && pnpm --filter @apicc/admin-web typecheck
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-web/src/api/contract.ts apps/admin-web/src/api/client.ts apps/admin-web/tests/api/client.test.ts
git commit -m "feat(admin-web): 候选搜索 client——GET member-candidates 契约解析"
```

---

### 任务 3：workspaces store 候选状态与 actions

**文件：**
- 修改：`apps/admin-web/src/stores/workspaces.ts`
- 测试：`apps/admin-web/tests/stores/workspaces.test.ts`

- [ ] **步骤 1：写失败的 store 测试**

`workspaces.test.ts` 追加 describe（沿用文件既有 client stub 工厂；三个用例）：

```ts
describe("searchCandidates（规格 2026-09-09 成员搜索）", () => {
  it("关键字搜索落 candidates；空关键字不发请求并清空", async () => {
    // stub：GET …/member-candidates?q=da → [{id,username,displayName}]
    const store = useWorkspacesStore();
    await store.searchCandidates("ws-1", "da");
    expect(store.candidates).toEqual([{ id: "u-9", username: "dave", displayName: "Dave" }]);
    calls.length = 0;
    await store.searchCandidates("ws-1", "   ");
    expect(store.candidates).toEqual([]);
    expect(calls.filter((c) => c.url.includes("member-candidates"))).toHaveLength(0);
  });

  it("失败置 candidatesError 并清空候选（下拉场景就地呈现，不入 membersError 通道）", async () => {
    const store = useWorkspacesStore();
    await store.searchCandidates("ws-1", "da"); // stub 此用例返回 403 {code,message}
    expect(store.candidates).toEqual([]);
    expect(store.candidatesError).toBeTruthy();
  });

  it("clearCandidates 复位候选与错误", async () => {
    const store = useWorkspacesStore();
    await store.searchCandidates("ws-1", "da");
    store.clearCandidates();
    expect(store.candidates).toEqual([]);
    expect(store.candidatesError).toBeNull();
  });
});
```

（`calls`/stub 变量名以该文件既有模式为准；403 用 stub 返回 `json(403, { code: "forbidden", message: "无权" })`。）

- [ ] **步骤 2：运行验证失败**

```bash
pnpm --filter @apicc/admin-web test -- workspaces
```
预期：FAIL（actions/状态不存在）。

- [ ] **步骤 3：实现**

`workspaces.ts`：

- 模块级序号（`treeSeq` 旁）：`/** 候选搜索请求序号：乱序完成的旧结果丢弃（selectSeq 同口径）。 */` `let candidateSeq = 0;`
- state（`memberSubmitting` 后）：

```ts
/** 非成员候选（GET member-candidates；规格 2026-09-09 成员搜索）——搜索下拉数据源。 */
candidates: [] as AdminUserCandidate[],
/** 候选搜索在途。 */
candidatesLoading: false,
/** 候选搜索失败文案（添加行就地呈现，不入成员面顶部通道）。 */
candidatesError: null as string | null,
```

- imports 补 `AdminUserCandidate` 类型。
- actions（`addMember` 后）：

```ts
/** 候选搜索（规格 2026-09-09）：空关键字不发请求直接清空；limit 固定 10（服务端上限 50）。 */
async searchCandidates(workspaceId: string, q: string): Promise<void> {
  const keyword = q.trim();
  const seq = ++candidateSeq;
  if (!keyword) {
    this.candidates = [];
    this.candidatesError = null;
    return;
  }
  this.candidatesLoading = true;
  try {
    const rows = await client.searchUserCandidates(workspaceId, keyword, 10);
    if (seq === candidateSeq) {
      this.candidates = rows;
      this.candidatesError = null;
    }
  } catch (e) {
    if (seq === candidateSeq) {
      this.candidates = [];
      this.candidatesError = errorMessage(e);
    }
  } finally {
    if (seq === candidateSeq) this.candidatesLoading = false;
  }
},

/** 添加成功后由视图调用复位候选区。 */
clearCandidates(): void {
  candidateSeq += 1; // 在途响应作废
  this.candidates = [];
  this.candidatesError = null;
},
```

- [ ] **步骤 4：运行验证通过**

```bash
pnpm --filter @apicc/admin-web test -- workspaces && pnpm --filter @apicc/admin-web typecheck
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-web/src/stores/workspaces.ts apps/admin-web/tests/stores/workspaces.test.ts
git commit -m "feat(admin-web): workspaces store 候选搜索状态与 actions（竞态序号防护）"
```

---

### 任务 4：userPicker composable

**文件：**
- 创建：`apps/admin-web/src/composables/userPicker.ts`

（纯函数级 composable，单测并入任务 5/6 的视图测试覆盖——两视图分别 exercising，避免只测实现的重复铺路。本任务先建类型与实现，供两个视图接入。）

- [ ] **步骤 1：实现 composable**

```ts
/**
 * 用户选择器（规格 2026-09-09 成员搜索）：内部 id 不许手输（先例级教训）——成员管理/项目 ACL
 * 两处添加行共用。选项 = 工作区现有成员（store.members，进页已载）+ 非成员候选（searchCandidates
 * 远程搜索，debounce 300ms）按 username 去重合并；users.username 全局唯一（uk_users_username）
 * 作选项 value 与解析键，提交时解析为 id——id 全程不进输入框。
 */
import { computed, onBeforeUnmount, ref, type Ref } from "vue";
import type { WorkspacesStore } from "../stores/workspaces.js";

/** 搜索 debounce（规格口径 ~300ms；导出供测试对照）。 */
export const SEARCH_DEBOUNCE_MS = 300;

export interface UserPickerOption {
  value: string;
  label: string;
}

export interface UserPicker {
  /** 选中/输入的用户名（选项 value；v-model 到 a-auto-complete）。 */
  username: Ref<string>;
  /** 成员在前、候选在后的合并选项。 */
  options: Ref<UserPickerOption[]>;
  /** a-auto-complete @search 透传（内置 debounce；空关键字即清）。 */
  onSearch: (keyword: string) => void;
  /** 解析当前用户名为 id；未命中（手输任意文本）返回 null。成员取 userId、候选取 id。 */
  resolveId: () => string | null;
  /** 复位输入与在途 debounce（添加成功/切上下文）。 */
  reset: () => void;
}

export function createUserPicker(workspaces: WorkspacesStore, workspaceId: Ref<string>): UserPicker {
  const username = ref("");
  let timer: ReturnType<typeof setTimeout> | null = null;

  const optionLabel = (u: { username: string; displayName: string }): string => `${u.username}（${u.displayName}）`;

  const options = computed<UserPickerOption[]>(() => {
    const byName = new Map<string, UserPickerOption>();
    for (const m of workspaces.members) {
      byName.set(m.username, { value: m.username, label: optionLabel(m) });
    }
    for (const c of workspaces.candidates) {
      if (!byName.has(c.username)) byName.set(c.username, { value: c.username, label: optionLabel(c) });
    }
    return [...byName.values()];
  });

  function onSearch(keyword: string): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void workspaces.searchCandidates(workspaceId.value, keyword);
    }, SEARCH_DEBOUNCE_MS);
  }

  function resolveId(): string | null {
    const name = username.value.trim();
    if (!name) return null;
    const member = workspaces.members.find((m) => m.username === name);
    if (member) return member.userId;
    const candidate = workspaces.candidates.find((c) => c.username === name);
    return candidate ? candidate.id : null;
  }

  function reset(): void {
    username.value = "";
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  onBeforeUnmount(() => {
    if (timer !== null) clearTimeout(timer);
  });

  return { username, options, onSearch, resolveId, reset };
}
```

- [ ] **步骤 2：typecheck**

```bash
pnpm --filter @apicc/admin-web typecheck
```
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add apps/admin-web/src/composables/userPicker.ts
git commit -m "feat(admin-web): userPicker composable——成员+候选合并下拉与 username→id 解析"
```

---

### 任务 5：MembersView 接入 + i18n + 视图测试

**文件：**
- 修改：`apps/admin-web/src/views/MembersView.vue`
- 修改：`apps/admin-web/src/i18n/zh-CN.json`、`apps/admin-web/src/i18n/en.json`
- 测试：`apps/admin-web/tests/views/MembersView.test.ts`

- [ ] **步骤 1：写失败的视图测试**

`MembersView.test.ts` 追加 describe（挂载铺路照抄文件内既有「直达 URL 进成员页」辅助；fetch handler 需同时兜底 members/workspace 详情请求——复制既有用例的 handler 再扩 member-candidates 分支）：

```ts
describe("添加成员：用户名搜索下拉（规格 2026-09-09，id 不再手输）", () => {
  it("输入触发候选搜索（debounce 后）；选中 username 提交解析为 id", async () => {
    // handler：GET …/member-candidates?q=dav → [{id:"u-9",username:"dave",displayName:"Dave"}]
    const wrapper = await mountAtMembersPage(); // 文件既有铺路；候选分支挂进其 handler
    const input = wrapper.find('[data-testid="members-add-user"] input');
    await input.setValue("dav");
    // debounce 300ms（真实定时器，轮询等 fetch 调用出现）
    await until(() => calls.some((c) => c.url.includes("member-candidates")));
    await input.setValue("dave"); // 模拟从下拉选中（v-model=username）
    await wrapper.find('[data-testid="members-add-submit"]').trigger("click");
    await flushPromises();
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/members/u-9"));
    expect(put).toBeDefined();
  });

  it("手输未命中文本提交 → 校验错误、不发 PUT", async () => {
    const wrapper = await mountAtMembersPage();
    const input = wrapper.find('[data-testid="members-add-user"] input');
    await input.setValue("ghost-name");
    await flushPromises();
    await wrapper.find('[data-testid="members-add-submit"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="members-add-error"]').exists()).toBe(true);
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/members/"))).toBe(false);
  });
});
```

`until` 辅助（文件内新增，放 waitForBody 旁）：

```ts
/** 轮询等待条件成立（真实定时器，供 debounce 落地；120×25ms 上限 3s）。 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
    await flushPromises();
  }
  throw new Error("条件未在时限内满足");
}
```

（若既有用例把 wrapper/calls 定义在 describe 内部，按其作用域习惯调整引用。）

- [ ] **步骤 2：运行验证失败**

```bash
pnpm --filter @apicc/admin-web test -- MembersView
```
预期：FAIL（`members-add-user` 不存在）。

- [ ] **步骤 3：实现视图与 i18n**

`MembersView.vue` script 改动：

```ts
import { createUserPicker } from "../composables/userPicker.js";

// —— 添加成员（规格 2026-09-09：用户名搜索下拉，id 不再手输——先例级教训）——
const picker = createUserPicker(props.workspaces, workspaceId);
const addRole = ref<AdminRole>("VIEWER");
const addError = ref("");

async function onAdd(): Promise<void> {
  const userId = picker.resolveId();
  if (!userId) {
    addError.value = t("members.selectUserRequired");
    return;
  }
  const ok = await props.workspaces.addMember(workspaceId.value, userId, addRole.value);
  if (ok) {
    picker.reset();
    props.workspaces.clearCandidates();
    addRole.value = "VIEWER";
    addError.value = "";
  }
}
```

删除旧 `addUserId` ref 与其校验。template 添加行：

```vue
<div class="add-row" data-testid="members-add">
  <a-auto-complete
    v-model:value="picker.username"
    class="add-userid"
    data-testid="members-add-user"
    :options="picker.options.value"
    :placeholder="t('members.searchPlaceholder')"
    @search="picker.onSearch"
  />
  <!-- 角色 select 原样保留 -->
</div>
<div v-if="workspaces.candidatesError" class="form-error" data-testid="members-candidates-error">{{ workspaces.candidatesError }}</div>
```

（`picker` 是普通对象非响应式解包——template 里用 `picker.username`（ref 自动解包不适用于嵌套属性，需 `picker.username.value`？**不要**：v-model 到 ref 属性请改为解构：`const { username: addUserName, options: candidateOptions, onSearch: onSearchUser, resolveId, reset: resetPicker } = createUserPicker(...)`，template 用 `v-model:value="addUserName"`、`:options="candidateOptions"`、`@search="onSearchUser"`——composable 返回的 refs 在 script 顶层解构后保持响应式，template 自动解包。data-testid 用 `members-add-user`。）

i18n `zh-CN.json` members 段：删 `userIdPlaceholder`、`userIdRequired`，增：

```json
"searchPlaceholder": "搜索用户名或昵称",
"selectUserRequired": "请从下拉中选择用户",
```
`en.json` 对应：`"searchPlaceholder": "Search by username or display name"`, `"selectUserRequired": "Pick a user from the dropdown"`。

- [ ] **步骤 4：运行验证通过**

```bash
pnpm --filter @apicc/admin-web test -- MembersView && pnpm --filter @apicc/admin-web typecheck
```
预期：PASS（含文件内既有用例全绿——旧 addUserId 相关用例已随步骤 1 改写/删除）。

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-web/src/views/MembersView.vue apps/admin-web/src/i18n/zh-CN.json apps/admin-web/src/i18n/en.json apps/admin-web/tests/views/MembersView.test.ts
git commit -m "feat(admin-web): 成员添加改用户名搜索下拉——userPicker 接入，id 不再手输"
```

---

### 任务 6：ProjectAclView 接入 + 全量验证

**文件：**
- 修改：`apps/admin-web/src/views/ProjectAclView.vue`
- 修改：`apps/admin-web/src/i18n/zh-CN.json`、`apps/admin-web/src/i18n/en.json`（acl 段，同任务 5 键名）
- 测试：`apps/admin-web/tests/views/ProjectAclView.test.ts`

- [ ] **步骤 1：写失败的视图测试**

`ProjectAclView.test.ts` 追加用例（铺路照抄文件既有「选工作区+选项目」辅助；fetch handler 增 member-candidates 分支）：

```ts
it("ACL 添加行：候选搜索选中非成员 → PUT acl 携解析后的 id", async () => {
  // handler：GET …/member-candidates?q=dav → [{id:"u-9",username:"dave",displayName:"Dave"}]
  // 铺路：进 ACL 页 → 选项目 → 输入 dav → until 候选 fetch → 输入设为 dave → 点 acl-add-submit
  await until(() => calls.some((c) => c.url.includes("member-candidates")));
  const input = wrapper.find('[data-testid="acl-add-userid"] input');
  await input.setValue("dave");
  await wrapper.find('[data-testid="acl-add-submit"]').trigger("click");
  await flushPromises();
  expect(calls.some((c) => c.method === "PUT" && c.url.includes("/acl") && JSON.stringify(c.body ?? {}).includes("u-9"))).toBe(true);
});
```

（端点路径以文件既有 acl PUT 断言为准照抄；旧「手输 userId 直添」用例删除或改写为下拉路径。）

- [ ] **步骤 2：运行验证失败**

```bash
pnpm --filter @apicc/admin-web test -- ProjectAclView
```
预期：新用例 FAIL（候选分支尚未接入）。

- [ ] **步骤 3：实现**

`ProjectAclView.vue`：与任务 5 同款——`createUserPicker(props.workspaces, workspaceId)` 解构接入 `a-auto-complete`（data-testid 保持 `acl-add-userid` 不变，减小测试面扰动）；删除 `memberOptions` computed 与旧 `addUserId`；`onAdd` 改 `resolveId` 路径；acl 段 i18n 键与任务 5 同名（searchPlaceholder/selectUserRequired，删 userIdPlaceholder/userIdRequired——先确认该键仅 ACL 在用）。上下文切换复位处（两个 watch 里的 `addUserId.value = ""`）改 `picker.reset()` + `workspaces.clearCandidates()`。

- [ ] **步骤 4：运行验证通过（本批全量）**

```bash
pnpm --filter @apicc/admin-web test && pnpm --filter @apicc/admin-web typecheck
JAVA_HOME="C:\Program Files\Java\jdk-21.0.12" mvn -s server/.mvn/settings.xml -f server/pom.xml test
```
预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add apps/admin-web/src/views/ProjectAclView.vue apps/admin-web/src/i18n/zh-CN.json apps/admin-web/src/i18n/en.json apps/admin-web/tests/views/ProjectAclView.test.ts
git commit -m "feat(admin-web): 项目 ACL 添加行同款接入 userPicker——统一消除手输 userId"
```

---

## 自检记录

- 规格覆盖：候选端点（权限/匹配/排除/limit/校验）→ 任务 1；契约与 client → 任务 2；store → 任务 3；MembersView 下拉 + id 不可见 → 任务 4/5；ACL 同缺陷类 → 任务 6（范围扩展已注明）；mock 替身不涉及（desktop 不在本批）。
- 类型一致性：`UserCandidateView.of` / `AdminUserCandidate` / `candidates` state / `searchCandidates(workspaceId, q)` / `resolveId()` 各任务签名已互相对齐；member 用 `userId`、candidate 用 `id` 的差异在 `resolveId` 内消化。
- 已知风险：antd AutoComplete 在 jsdom 的下拉惰性渲染——测试不依赖下拉展开，直接以 setValue 置 username 驱动 v-model（下拉渲染不进断言）。
