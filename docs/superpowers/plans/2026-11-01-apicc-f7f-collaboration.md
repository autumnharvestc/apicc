# F7f 在线协作与受控分享整阶段实施计划

> **开工确认（2026-11-01）：** 用户已明确“可以，完成F7f整阶段”。采用子代理驱动开发，按原模型配置连续执行T1–T12，任务审查与最终同候选联验保留；提交、合并、推送未授权。下方准备状态及“未实施”为开工前记录，实际进度见本计划专属SDD账本和后续阶段回执。

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。执行方式在集中开工确认时确定；本次编写计划不调度实现或审核代理。

**目标：** 在复用现有身份、ACL、执行记录和 Core 的基础上，完成团队历史、固定版本文档/报告分享和共享声明式 Mock，先补齐已核实的权限治理缺口。

**架构：** Java 是身份、权限、策略、固定副本、授权、计费和审计的唯一权威；可选私有 Node 协作运行服务只承载 Core 的纯投影、脚本变更分类和 Mock 响应。分享/Mock 使用独立固定版本授权，公开浏览器来源与管理台隔离，不依赖桌面或执行代理存活。

**技术栈：** 现有 Java 21、Spring Boot、H2、Maven wrapper；Node 22.19.0、pnpm 11.21.0、TypeScript、Zod 4、Vitest、Vue 3、Electron、Vite。不增加通用 IAM、第二套 Runner 或无关依赖升级。

**规格：** [F7f 设计 R2](../specs/2026-11-01-apicc-f7f-collaboration-design.md)、[ACL 复用评估及生命周期 A](../specs/2026-11-01-apicc-f7f-acl-reuse-assessment.md)、[页面展示规范](../../ui-presentation-guidelines.md)。三份必须完整阅读；数值依据设计 §9，不用本计划的概述代替配置表。

日期：2026-11-01。状态：**计划归档，等待整阶段开工确认**。基线 main `e071f618b95fe874a341a038a5cf12f8303fe3a3`，用户确认 CI86 通过；隔离工作树 `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，分支 `codex/f7f-collaboration-design`。T1–T12均未实施，文末准备自检与产品任务分开，不把先前诊断或文档检查称为 F7f 产品通过。

## 全局约束

- 已确认范围 A：团队协作＋受控外部分享。生命周期 A：移除后旧显式角色/allow 失效，重入需管理员确认；显式 NONE 不被删除而回退放宽。无旧覆盖的项目按新工作区角色和当前策略计算。
- 保留 `Role/AclRole`、稳定 ID、项目覆盖可提级/降级、NONE 与继承的区别；工作区管理、项目管理、内容读取分别计算。超级管理员不是所有项目的默认内容读者。
- 旧账号/数据库原地兼容升级；新能力默认保留既有 EDITOR 的脚本/凭据/执行行为。部署/工作区/项目三层外部开关默认关闭，Mock 默认关闭；不自动上传、发布、创建密钥或启用 Mock。
- 个人历史只对显式选定的一项执行本机安全投影、预览和确认；确认前无上传。服务端再校验，成员上传只代表成员声明，不能伪造代理身份或真实执行证据。
- 发布内容不可变；访问授权独立。新版本不替换旧链接。密钥只展示创建/轮换当次，数据库只保存摘要；失去返回值时对账原操作，再由用户明确轮换，不能自动创建第二份授权。
- 外部资格失效、撤销和换钥不得因重入/重新启用自动复活旧秘密。撤销约束后续准入，不声称收回已下载文件、截断已发出的字节或取消已准入业务。
- 不执行脚本或转发真实目标；Node 不装配 Runner、插件加载器、任意 fetch 或文件路径读取。固定私有 RPC 地址不能来自项目/用户 URL，禁止重定向。
- 配置/统计/权限/审计/轨迹主视图必须直接可读、中英本地化、有单位及来源；原始安全数据仅次级折叠。正文/Schema 的 JSON 例外不扩大到元数据。
- F7b EXECUTION-LOW-001/002/003 仍排 F7g 后；新分享读取独立解决自身原子可见性，不改旧 `JobService.report` 或声称关闭旧 LOW-003。不实施 F7g、团队共享 AI、独立调度 B、到达率 B、DEF-001、多副本 HA 或高负载/长稳实验。
- 新增配置逐项具备默认、范围、单位、修改权限、来源、版本和生效方式。采用设计 §9 全表；下级不能扩大上级能力/额度，敏感字段规则取并集。错误组合明确拒绝，不静默修值。
- 实现和独审沿既有 Sol high／Sol xhigh 配置；需要 Sol max 时先申请。一个任务一个实现责任人、一个定向审查责任人，不并行修改共享文件、不派生重复宽审。
- 任务内保留实际 RED/GREEN、分支清单和累计源码身份；模块不存在/404/导入错误不是业务 RED。每条新拒绝、预算和授权分支先有目标断言失败，再写逻辑。后补验证不能改称先红，历史偏差不构成新例外。
- 本轮准备不安装依赖、不启动新服务、不运行产品全量。开工后最终候选集中一次必要全量、一次整分支独审及集中新包/页面验收；后续修正按影响补验并保留历次失败。
- 任务检查点保存 diff、累计清单和证据，不自动 commit。提交、合并、推送须用户另行授权；主工作树与旧阶段证据不删除、不重置。

## 1. 文件责任和任务依赖

下面路径均以本计划所在仓库为根。`{a,b}.ts` 代表逐个列出的同职责文件，不代表可随意扩展目录。现有文件保持业务职责，新增模块不得把所有逻辑塞进一个控制器。

| 任务 | 新建的主要文件/职责 | 复用或修改的现有文件 | 依赖与验收 |
| --- | --- | --- | --- |
| T1 OWNER 不变量 | 无新子系统 | `server/.../admin/AdminService.java`；现有管理员/成员 API 测试 | 无；ACL-E04 |
| T2 统一授权与生命周期 A | `server/.../access/{ProjectAccessService,AccessMutationService,AccessRepo,ProjectAccessView,Capability,AccessRequests,AccessController}.java` | `store/{MembershipRepo,AclRepo}.java`、`workspace/{MemberService,MemberController,SetMemberRoleRequest,MemberView,ProjectAclService,ProjectAclController,SetAclRequest,AclEntryView}.java`、`admin/{AdminService,AdminController,AdminRequests}.java`、`schema.sql` | T1；ACL-E01/E02/E05/E06 |
| T3 Core 派生与共用 Mock 响应 | `packages/core/src/collaboration/{types,shared,projection,report,mutation,policy,index}.ts`、`mock/evaluate.ts` | `design/{projection,document}.ts`、`mock/{compile,server}.ts`、Core exports | 无产品依赖；AC02/08/09 |
| T4 私有 Core 运行服务 | `apps/collaboration-runtime/{package.json,tsconfig.json,tsconfig.build.json}`、`src/{main,server,protocol,handlers,cache,limits}.ts`；`server/.../collaboration/runtime/{CollaborationRuntimeClient,RuntimeProtocol,RuntimeProperties}.java` | workspace lock、Java 配置与测试属性 | T3；AC14 |
| T5 旧权威入口接线 | `server/.../access/AssetMutationGuard.java`、`AccessEntryPointsTest.java` | 内容/资产/代理/任务/凭据/调度/通知真实服务及客户端权限 DTO | T2/T4；AC04、ACL-E03/E06 |
| T6 固定副本与项目历史 | `server/.../collaboration/artifacts/{ArtifactService,ArtifactRepo,ArtifactController,ArtifactRequests,ArtifactViews,SourceSnapshotReader,ArtifactCleanup}.java`、`collaboration/policy/{CollaborationPolicyService,CollaborationPolicyRepo,CollaborationPolicyController}.java` | `JobRepo.java` 新独立固定读取方法、`schema.sql`、策略配置 | T2/T4/T5；AC01/03/07 |
| T7 独立授权和公开入口 | `server/.../collaboration/grants/{GrantService,GrantRepo,GrantController,GrantRequests}.java`、`collaboration/publicapi/{PublicOriginFilter,PublicShareController,PublicAdmissionService}.java` | `auth/AuthFilter.java`、`console/ConsoleHostingConfig.java`、schema/config | T6；AC05/06/11 |
| T8 共享 Mock 与无秘密日志 | `server/.../collaboration/mock/{SharedMockService,SharedMockController,MockGateway,MockLogRepo}.java`、`collaboration/audit/{CollaborationAuditService,CollaborationAuditController}.java` | T4 RPC/T6 artifacts/T7 grants、已有 execution 审计只读接缝 | T7；AC09/10/12 |
| T9 客户端协作与单项发布 | `packages/execution/src/client/collaboration.ts`；`apps/desktop/src/{main/online/collaboration.ts,shared/online/collaboration.ts}`；renderer `stores/collaboration.ts`、`components/online/{CollaborationPanel,PublicationPreview,SharedHistoryPanel}.vue` | IPC/preload、在线客户端/执行面板、本机历史/报告入口、语言文件 | T5–T8；AC01/02/13 |
| T10 Web 权限/分享/审计 | `apps/admin-web/src/{api/collaboration.ts,views/CollaborationView.vue,components/CollaborationPolicyTable.vue,components/AccessCapabilityTable.vue}` | ACL/成员页、路由/项目入口、api contract/client、语言文件 | T2/T5–T8；ACL-E03、AC12/13 |
| T11 独立公开只读页面 | `apps/share-viewer/{package.json,tsconfig.json,index.html,vite.config.ts}`、`src/{main,client,fragment,i18n}.ts`、`src/{App,DocumentView,ReportView}.vue`、`src/style.css` | T3 安全 DTO browser 导出、Java 独立静态资源装配 | T3/T7；AC08/11/13 |
| T12 集中联验和交付 | `Dockerfile.collaboration`、`scripts/f7f-acceptance.mjs`、`scripts/tests/f7f-acceptance.test.mjs`、`docs/f7f-collaboration.md`、本阶段证据账本 | `deploy/docker-compose.yml`、`Dockerfile`、CI、根门禁、包资源冒烟、部署文档 | T1–T11；AC01–14 |

`server/.../` 指 `server/src/main/java/com/autumnharvestc/server/`；Java 测试同包位于 `server/src/test/java/com/autumnharvestc/server/`。新文件在所属任务创建；本表不是本次已创建文件。T3 可独立测试，但实施按 T1→T12 串行整合，避免脚本分类与权限接线形成依赖环。

## 2. 数据和接口合同

### 2.1 授权权威与生命周期

T2 的 `ProjectAccessService.resolve(userId, workspaceId, projectId)` 返回内部 `ProjectAccessView`：`accountEnabled`、`member`、`workspaceRole`、`projectOverride`、`overrideState`、`effectiveRole`、`capabilities`、`accessRevision`、`membershipEpoch`、`responsibilityEpoch`、`reasonCode`。实体 ID 使用 Long，HTTP 输出字符串；修订/代次使用非负 long，初始 0，成功变更加 1。没有成员或被停用时没有内容/业务能力；`PermissionService` 继续负责基础角色映射，不再被新入口直接当完整准入门。

权限枚举固定为 `history.read/history.publish/script.edit/credential.manage/task.execute/publication.manage/mock.manage/mock.logs.read/audit.read`。默认和角色下限逐项采用设计 §6.1：前五项按旧角色兼容，发布/Mock 管理默认 ADMIN+ 可授 EDITOR，日志/审计默认 ADMIN+ 可授 VIEWER。成员覆盖优先于项目默认、工作区默认；所有 allow 仍须满足有效项目角色下限和上级能力开关。NONE/待确认状态先拒绝，不被业务 allow 覆盖。

新增持久单元：`access_subjects` 保留被删除成员的代次和修订；`project_acl` 补 `state=active|pending-confirmation`、`membership_epoch`、`revision`、actor/time；`capability_overrides` 保存范围、主体、权限点、`inherit|allow|deny`、状态和修订；`access_authority` 保存项目/成员的权限修订与责任代次。不得只依赖会被删除的 membership 行或进程内缓存。

- 现存有效成员的 ACL 回填 active 并绑定当前代次；现存非成员的旧正向预设 ACL 回填待确认，不能在新加入时自动激活；NONE 保留。升级幂等，不重写既有 ID/角色。
- 移除：同事务递增成员代次、使旧正向 ACL 待确认、旧成员特定 allow 失效、保留 NONE/deny，删除成员关系，写审计并使发布责任代次失效。重入不撤销这些状态。有旧正向覆盖的项目，在管理员确认前有效角色为空；不能回落工作区角色而意外放宽。无旧覆盖项目继承新的工作区角色，但旧 allow 不恢复。
- 管理员使用 `confirm-override`（明确新角色）或 `confirm-inheritance`（明确清除旧覆盖）处理待确认；显式 NONE 保持，只有正常明确管理动作可变更。不能把普通 GET 或一次重新登录当确认。
- 停用账号使责任代次失效，重启账号不恢复旧秘密；角色/能力/上级策略改变导致失去发布/Mock 管理资格时，持久递增对应责任代次。丢失资格后再获准，旧授权仍持有旧代次。
- `AccessMutationService` 统一当前目标/OWNER 保护、CAS、事务、前后资格比较、必要审计。成员/ACL/超管写入口均调用。角色/成员修改采用 `expectedRevision`，新增对象以 0 创建；旧无版本写请求返回明确的版本必填错误，不保留无版本旁路，桌面/管理台同步升级调用。
- PUT 在请求体传期望修订，成员/ACL DELETE 在 query 传 `expectedRevision`；成员列表与 ACL 列表返回各条修订。真正从未存在的主体新增修订为0，已移除主体从access_subjects读取保留修订，不能因membership行不在就重置为0。转让仍复用成员 PUT role=OWNER，额外携带调用者/目标的期望修订；不是新造一条未接线的转让 API。超级管理员列表/入区表单可取得对应目标成员修订，不假定一律为 0。
- 工作区 OWNER 转让仍是原专门动作，但升新 OWNER、降旧 OWNER、审计和代次更新同事务；回滚不得出现半转让。工作区管理员即使项目 NONE 仍能恢复 ACL；项目 ADMIN 不获得工作区成员管理。

T2 同时定义权限读取及管理 API：项目 `/access` 返回本人安全能力；工作区 `/access-projects` 返回有权管理的项目 ID/名称与 `contentReadable`；工作区 `/access-members/{userId}` 与项目 `/access-members/{userId}` GET 返回角色、覆盖、状态、修订和可管理权限表，PUT 提交版本化角色/能力变更；已有成员/ACL URL 保留并接同一权威。管理目录不返回内容/源文件。

### 2.2 Core 与 RPC 合同

T3 在 `collaboration/types.ts` 导出严格 schema/同名类型：

```ts
export type ArtifactKind = 'document' | 'report' | 'debug-history' | 'mock';
export type SourceTrust = 'server-archive' | 'member-claim' | 'saved-contract';
export interface ProjectionPolicy {
  revision: number; includeEvidence: boolean;
  maxFieldBytes: number; maxEvidenceBytes: number; maxArtifactBytes: number;
  extraSensitiveHeaders: readonly string[]; extraSensitiveQuery: readonly string[];
  extraSensitiveFields: readonly string[]; extraSensitivePointers: readonly string[];
}
export interface PublicArtifactDto {
  formatVersion: 1; kind: Exclude<ArtifactKind, 'mock'>; title: string;
  source: { trust: SourceTrust; revision: string; digest: string };
  summary: readonly { labelCode: string; value: string | number | boolean | null; unit?: string }[];
  limitations: readonly { code: string; path?: string }[];
  document?: DocumentViewDto; report?: ReportViewDto;
}
```

T3 定义 `DocumentViewDto` 为选定接口/依赖模型、参数/响应/Schema/安全示例和片段的结构化投影，复用已有文档投影类型；`ReportViewDto` 为来源、时间、逻辑结论、不同总体计数、失败类别、节点/轨迹/阶段/趋势/比较及带状态的可选安全证据。两者严格字段白名单，不含通用 `unknown/raw/project` 字段；内部 ID/文件根不作为对外定位。缺失、遮罩、预算截断和不支持是不同 limitation。T3 定义 `PublicationInput` 判别输入：固定在线文件清单＋范围；服务端归档正文；或已在本机清理的单项上传 DTO。T6 决定可信来源，客户端不能自称 server-archive。

T3 的纯派生边界：`projectPublication(input: PublicationInput, policy: ProjectionPolicy): Promise<PublicArtifactDto>`、`classifyAssetMutation(beforeFiles, afterFiles): Promise<{ scriptChanged: boolean; locations: readonly string[] }>`（输入均为已有 `contract-files-v1` 文件清单；解析失败抛稳定错误），以及同步 `validateSharedMock(plan, policy)`（输入已有 `CompiledMockPlan`，返回有定位的诊断）。分别由 `projection.ts/report.ts/mutation.ts/policy.ts` 承载，不重复契约解码/报告算法。开工核对发现现有 `decodeContractProjectFiles` 本身异步，故投影/分类统一 await；“纯派生”约束是无目标请求/脚本/任意路径I/O，不要求假装同步或重写已有解码器。

其中 `validateSharedMock` 的policy类型为T3定义的 `SharedMockPolicy`，含 `maxResponseBytes/maxDelayMs/requestDeadlineMs` 和继承的额外敏感字段；禁止控制头、脚本和转发是不可关闭的规则，不提供管理员解除按钮。`Capability.TASK_EXECUTE` 映射固定业务码 `task.execute`，其他Java枚举采用相同大写下划线到业务码的一一映射。

T3 在 `mock/evaluate.ts` 导出 `MockEvaluationInput={method:string; target:string; headers:Readonly<Record<string,string>>; body:Uint8Array}`，`evaluateMock(plan,input)` 返回匹配响应 `{status,mediaType,headers,body,delayMs,ruleId?,routeTemplate?,reason}`；只做规范化/匹配/选响应，不监听、不 sleep、不 fetch。HTTP 宿主负责有界读体、延时/取消、在途和日志；本地与 RPC 共用它。

T4 `RuntimeProtocol` 对 TS/Java 固定 envelope：`protocolVersion=1`、`operation`、`requestId`、`inputDigest`、`deadlineEpochMs`、`outputBudgetBytes`、严格操作 payload；成功绑定相同身份、Core 构建身份、输出摘要和实际线路字节。操作仅 `project-document/project-report/classify-asset-mutation/compile-mock/respond-mock/health`。统一错误 `{code,requestId,retryable:false}` 不附原始正文/路径/秘密。秘密经部署文件读取，恒定时间校验专用头；请求身份不能替代秘密。

T3 的 `collaboration/shared.ts` 仅导出 browser 安全 schema/类型；`@apicc/core/collaboration/shared` 不导入 Node index、投影宿主或 `node:buffer`。T4 从 T3 同一严格 schema 导出版本化 JSON Schema，Java 校验真实 RPC 输入/输出，Node 与 Java 对同组合法/非法 fixture 均判定一致，不手写第二份宽松业务模型。TS `server.ts` 导出 `startCollaborationRuntime(options)`，options 包含 secret、host、port、cache/bytes/deadline 限制；返回 `{url:string,close():Promise<void>}`，测试只用合成 secret/回环端口0，生产入口从秘密文件构造 options。

### 2.3 发布与访问 HTTP 合同

成员前缀 `/api/v1/workspaces/{ws}/projects/{project}/collaboration`：

| 操作 | 路径/方法和关键输入 | 返回/权限 |
| --- | --- | --- |
| 策略 | GET/PUT `/policy`，PUT 带 expectedRevision | 已保存/有效/来源/限制；对应范围管理员 |
| 历史 | GET `/history`，稳定 cursor/limit/来源/结论；GET/DELETE `/history/{id}` | 安全元数据/正文；history.read，删本人上传或管理员；真实 job 不被上传删除 API 删除 |
| 上传预览 | POST `/previews`，`source.kind=member-upload`＋严格安全单项 | history.publish＋源范围，不替代分享管理 |
| 在线源预览 | POST `/previews`，document/mock 的 revision+scope，或 server-report 的 jobId | 源读权＋对应 publication/mock 管理权 |
| 确认 | POST `/publications`，`previewId/candidateDigest/publicationIntentId/expectedPolicyRevision` | 同意图同结果；不能替换候选正文；仅成员历史上传可不创建外链 |
| 状态/取消 | GET/DELETE `/previews/{id}`；GET `/operations/{intentId}` | 本人或有权管理者，查询/取消不自动重做 |
| 版本 | GET `/publications`、GET/PATCH/DELETE `/publications/{id}` | 固定摘要、版本、来源、状态及 CAS，不返回源私有快照 |
| 授权 | POST `/publications/{id}/grants`；POST `/grants/{id}/rotate`；DELETE `/grants/{id}` | 受众/用途/下载/expiry/intent/expectedRevision；密钥仅本次返回 |
| Mock | POST `/publications/{id}/enable` 或 `/disable`；GET `/publications/{id}/mock-logs` | mock.manage 与 mock.logs.read 分开；新 Mock 默认停用 |
| 审计 | GET `/audit`，cursor/limit/object/actor/time | audit.read；拒绝越界过滤/无限分页 |

公共 origin 只托管 `/s/{publicId}` 页面和 `/share-api/{publicId}` GET、`/share-api/{publicId}/download` GET、`/mock/{publicId}/{业务相对路径}`；不托管 `/api/v1/**`、管理台 bundle 或认证 cookie。查看认证头为 `X-Apicc-Share-Key`；Mock 为 `X-Apicc-Mock-Key`。成员范围 Mock 还需当前成员认证，仅在 Java 消费，绝不转发 Core。`members` 页面是正常成员 API 定位，不生成可转发外部秘密。

公开错误合同：未知ID、缺key、错key、跨用途/版本密钥统一 `404 share_unavailable`，不说明对象是否存在；密钥验证成功后才可返回 `410 share_inactive` 并带安全原因 `expired/revoked/responsibility_changed/policy_changed/publication_disabled`。成员认证缺失/失权为 `401/403`，容量为429，Node不可用为503；以上均不返回候选正文或秘密。API测试固定具体状态/原因，不用“任一4xx”代替要求。

T7 授权持久字段：固定 artifact/version、用途/受众、责任人及责任代次、keyHash、generation、expiresAt、状态/不可逆失效原因、下载开关、revision、operationIntent。重发相同创建操作只返回非秘密原记录；不持久化明文供重放。状态/策略/当前责任资格每次准入核对，资格丢失代次永久不匹配。

### 2.4 测试与命令约定

先在本阶段 `.superpowers/sdd/2026-11-01-apicc-f7f-collaboration/` 记录 task-status、branch-manifest、RED/GREEN、累计源码清单和最终候选身份；忽略目录，不代替正式测试。沿用现有 F7e `tools.ps1` 的精确工具路径与 shim，核实后在新阶段复制其路径逻辑而非改全局环境。下列命令从隔离仓库根运行，前置 dot-source 当前阶段 tools；所有退出码单独记录。

Java 命令统一模板：

```powershell
./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=测试类列表' test
```

各任务实际替换为下面明确给出的类列表，不把模板本身当可执行测试。新测试先写；若确实需要加载骨架才能执行，骨架不得包含保护、默认或算法分支，再观察业务断言。已有 API 先写直接行为回归。Java 新集成测试用独立 H2 mem 名；受控交错用 latch/显式屏障，不用 `Thread.sleep` 猜顺序。TS 使用现有 Vitest/临时目录夹具，不访问真实服务/付费模型。

每个任务测试目录内的 `fixtures.ts` 或 Java `CollaborationApiFixture.java` 是该任务正式测试的一部分：通过真实注册/登录/建区/建项目/保存资产操作生成合成数据，返回 token/ID/revision，不用绕过守卫的“万能管理员”替身。跨任务只能复用已存在 fixture，若扩展须写清新输入和行为。下面测试片段展示核心断言，步骤中的边界清单也必须逐批留有效 RED，不能只跑片段就声称整个任务先红。

## 3. 任务步骤

### 任务 1：先关闭已复现的 OWNER 备用入口缺口（T1）

**文件：** 修改 `server/src/main/java/com/autumnharvestc/server/admin/AdminService.java`；测试 `server/src/test/java/com/autumnharvestc/server/admin/{AdminUsersApiTest,AdminServiceTest}.java`、`workspace/MemberApiContractTest.java`。不改 OWNER 转让产品语义。

- [x] **1. 先写真实 API 失败测试。** 在 `AdminUsersApiTest` 复用其已定义的 `createWorkspaceAsAdmin/superadminToken/adminId/mockMvc`，新增独立测试（不依赖其他测试顺序）：

  ```java
  String ws = createWorkspaceAsAdmin();
  mockMvc.perform(put("/api/v1/admin/users/" + adminId() + "/workspace-role")
      .header("Authorization", "Bearer " + superadminToken())
      .contentType(MediaType.APPLICATION_JSON)
      .content("{\"workspaceId\":\"" + ws + "\",\"role\":\"VIEWER\"}"))
      .andExpect(status().isForbidden());
  ```

  再经成员 GET 核对唯一 OWNER 未变；测试独立工作区，不能碰诊断库或真实工作区。路由/载荷按既有 controller 契约核对后落测试，不能用错误路由 404 算失败。
- [x] **2. 运行 RED。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=AdminUsersApiTest' test`；目标观察现实现 204、期望 403，并保留 OWNER 从 1 变 0 的断言证据。先前私有 probe exit1 仅作定位依据，不替代本轮正式 RED。
- [x] **3. 最小修复。** 在 `AdminService.setWorkspaceRole` 写入前核对目标当前角色，当前 OWNER 拒绝，新增角色 OWNER 仍拒绝；普通非 OWNER 超管入区操作不变。不要以阻止所有 admin 写入代替正确保护。T2 再把目标检查纳入统一事务权威。
- [x] **4. 边界先红再补。** 当前 OWNER→ADMIN/EDITOR/VIEWER 均拒绝；非 OWNER 合法入区仍成功；普通成员 API 和专用 OWNER 转让保持原规则。`AdminServiceTest` 核对仓储未收到非法降级写入。
- [x] **5. GREEN 和检查点。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=AdminUsersApiTest,AdminServiceTest,MemberApiContractTest' test`。定向独审只看当前目标 OWNER 保护及旧合法路径，不扩大为平台重构；保存 diff/日志，不提交。

T1回执（2026-11-01）：正式RED-v2为16项/6个预期失败/0错误；GREEN三类32/32通过。仅AdminService及两份测试变更，累计产品/测试树5defa54b…；独审规格/质量通过，C0/I0/M1（既有日志噪声，留最终审查）。RED-v1同名夹具失败另存且未计业务先红；并发事务及全局ACL结论留T2/阶段验收，不冒称整个OWNER并发不变量或F7f已完成。详细证据见本计划SDD的task-1-report.md与task-1-review.md。未提交。

### 任务 2：版本化统一授权、能力与成员生命周期 A（T2）

**文件：** 新建责任表中的 `access/*.java`；修改 schema、MembershipRepo/AclRepo，以及责任表列出的成员/ACL/管理员 controller、请求与响应；测试新增 `access/{ProjectAccessServiceTest,AccessMutationApiTest,AccessLifecycleTest}.java`，保留旧角色/仓储测试。旧客户端协议调用迁移分别在T9/T10交付，阶段未集成时不单独发布仅服务端破坏性变更。

- [x] **1. 先固定实际旧行为和新口径。** HTTP 序列：VIEWER＋项目 ADMIN→移除→以 VIEWER 重入→内容拒绝且状态待确认→管理员带当前 revision 确认 EDITOR→仅恢复 EDITOR。另一个无旧覆盖项目继承新 VIEWER；NONE 项仍拒绝。断言不是仅“字段出现”，而是 tree/assets 的 403/200 和可写边界。

  核心断言置于该序列的重入后（`access` 为注入的 ProjectAccessService，三个ID来自本测试的真实建号/建区/建项目）：

  ```java
  var decision = access.resolve(userId, workspaceId, projectId);
  assertThat(decision.overrideState()).isEqualTo("pending-confirmation");
  assertThat(decision.effectiveRole()).isEmpty();
  assertThat(decision.capabilities()).doesNotContain(Capability.TASK_EXECUTE);
  ```
- [x] **2. RED。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=ProjectAccessServiceTest,AccessMutationApiTest,AccessLifecycleTest' test`；保留“重入错误恢复 ADMIN”、非成员预设被直接权威误放行、旧无版本并发覆盖三个独立业务失败。
- [x] **3. 实现 §2.1 合同和幂等 schema 升级。** 当前账号/成员→项目归属→pending/NONE→有效角色→能力/对象守卫；保留覆盖提级/降级。用版本 CAS 的影响行数区分成功/冲突，事务内写审计和代次，不沿用 `AclRepo` 先插入捕获冲突再更新的事务陷阱。现有行回填与新建 0→1 明确区分，合法字段被严格校验。

  CAS 的关键写入形状如下；0行必须冲突，不得继续审计为成功。新增行唯一键冲突在该事务整体回滚，不能在已失败事务内捕获后继续UPDATE：

  ```sql
  UPDATE project_acl SET role=?, state=?, membership_epoch=?, revision=revision+1,
    actor_id=?, updated_at=?
  WHERE workspace_id=? AND project_id=? AND user_id=? AND revision=?;
  ```
- [x] **4. 分批先红后实现以下保护。** 无版本拒绝；相同 revision 两写仅一成功；审计失败角色/epoch 全回滚；转让中第二写失败不半转让；超管停用/入区不能绕过 OWNER/失效处理；非成员旧正向预设加入后仍待确认。账号 re-enable、成员 rejoin 和重新授予能力均不回退 epoch。能力下限基于有效项目角色：工作区 VIEWER＋项目 ADMIN 可管理项目但不能改工作区成员；工作区 ADMIN＋项目 VIEWER 无内容写权但可恢复 ACL。
- [x] **5. 验证与定向独审。** 同新增三类＋`PermissionServiceTest,AclRepoTest,MembershipRepoTest,MemberApiContractTest,ProjectAclApiContractTest,AdminUsersApiTest,AdminServiceTest,WorkspacePermissionMatrixTest`。明确更新旧“重入恢复”的有意变更断言，不删除 NONE/继承/越区覆盖。独审逐项核角色、代次、CAS、事务和升级，保存实际结果，不称已修完新分享。

**T2 执行回执（2026-11-01）：** 累计候选树 `f06ae51d936e1f32125618839cb1e4dfe50f2734`。24 类定向 341/341，完整 Maven BUILD SUCCESS 与 24 份 XML 保留；该次 shell 最终退出对象未取回，不冒称独立观察 exit0。最终生命周期控制 1/1；独审两项 Important 先复现后修复，同集 21/21、受影响回归 161/161 均观察 exit0，原审查者定向复核 I1/I2 均 ADDRESSED，无新 C/I。H2 加法升级、真实二次启动、审计/转让回滚和原撤销 204→快照 403 验证保留。成员 CAS/删除后持久身份实际放在新 `AccessRepo/AccessMutationService`，`MembershipRepo` 保留旧 primitives，接受此文件责任位置偏差，不制造无意义 hunk。DELETE 非法数值入口缺独立先红的局部顺序偏差已获用户接受，8 项后验与独审完成，仍不称先红。既有工具链日志噪声延期；详细树/日志/裁决在本计划专属 SDD 账本。T5/T7/T9/T10 及整阶段交付仍待执行，强制版本协议不单独发布；未提交、合并或推送。

### 任务 3：Core 安全派生、脚本变更分类和可复用 Mock 求值（T3）

**文件：** 新建 `packages/core/src/collaboration/{types,shared,projection,report,mutation,policy,index}.ts`、`src/mock/evaluate.ts`、`tests/collaboration/fixtures.ts`、`tests/collaboration/{projection,report,mutation,policy}.test.ts`、`tests/mock/evaluate.test.ts`；修改 `mock/{compile,server}.ts`、必要的文档纯投影/exports。不修改执行器。

- [x] **1. 先写严格输出和相同语义测试。** 使用现有契约/报告夹具派生，标题放中文长名及 `<img onerror>` 字面值，输入含 Authorization/Cookie、已知私有标记、Windows/POSIX 路径。对 `projectPublication` 断言严格 schema、敏感值不在 DTO、统计逻辑通过与原失败数分别保留。不得扫描内部原始快照然后据此删必要材料。

  Mock求值最小测试直接调用同一新边界，不启动第二套实现：

  ```ts
  expect(evaluateMock({ sourceProjectRevision: 'r1', routes: [] }, {
    method: 'GET', target: '/not-present?q=1&q=2', headers: {}, body: new Uint8Array(),
  })).toMatchObject({ status: 404 });
  ```
- [x] **2. RED。** `pnpm -C packages/core exec vitest run tests/collaboration tests/mock/evaluate.test.ts tests/mock/server.test.ts --maxWorkers=2`。新加载骨架可抛未实现，但必须继续取得各目标输出/拒绝断言失败，再实现对应逻辑。
- [x] **3. 按 §2.2 实现纯函数。** 文档复用范围依赖闭包；报告复用现有解析和证据输出边界，原始正文默认不含，显式证据仍有强制遮罩/预算/状态。公开节点定位使用投影内 ID，不带文件路径。脚本分类比较旧/新解码树，包含祖先目录/模块、用例、子流程和旧 JS 条件，以及删除含脚本祖先的实际变化。

  将当前编译器写死的响应字节保护改为显式可选参数 `compileProjectMock(snapshot, options?: { maxResponseBytes?: number })`；省略仍为本地原默认1MiB，共享宿主传当前有效额度并校验1KiB–8MiB，不绕过限制或改本地默认。求值始终使用编译后固定正文；宿主延时取消的核心形状是 `await` 可取消定时器，而非在纯匹配函数中sleep。
- [x] **4. 逐批行为 RED→实现。** 非选定历史从未读取；缺脱敏依据旧格式只保留摘要/原因；恶意未知字段和超字节拒绝；中文 UTF-8 字节不是字符数。Mock 从旧 server 提取匹配，重复 query/路径参数/HEAD/未命中/固定种子不漂移；延时由宿主执行。共享 policy 拒绝依赖敏感头、Set-Cookie/Location/安全或 CORS 覆盖、脚本/转发/附件材料；给规则/字段定位，不静默删规则。
- [x] **5. GREEN/构建/独审。** 同定向命令＋`pnpm -C packages/core build`、`pnpm -C packages/core typecheck`。`@apicc/core/collaboration` 仅公开纯派生与类型的子路径；browser 输出不引入文件系统、密钥库或整个 Node index。独审重点实际安全 DTO 和本地 Mock 兼容，而不是“字段已显示”。

**T3 执行回执（2026-11-01）：** 最终累计树 `9e3289bc1c2dacaae9d86e864de637ecec469acb`。原候选定向 251/251、直接兼容回归 152/152 通过；两轮独审修正分别先取得 8 项和 15 项有效业务失败，再修正敏感 Schema 注释/指针派生值泄漏及结构码碰撞。最终受影响投影/报告 136/136、Core build/typecheck 均实际 exit0，原审查者第二轮定向复核 C0/I0/M0；旧 251/152/121 只作为其各自源码上的历史结果，不冒称最终树重跑全套。副本超额夹具曾使用非法预算，导致该分支缺有效先红；已获用户接受如实记录，以合法预算补验并独审，不把后验验证称先红。T4 必须补固定文件到 snapshot 的窄装配、实际共享 Mock policy/禁用头来源和 Java/Node 严格 schema 对照；T8 负责实际网关消费，T9/T11/T12 负责页面可读性和真实视觉验收。详细证据见本计划 SDD 的 task-3-report.md、task-3-review.md 与两份定向复审。未提交、合并或推送，整阶段尚未完成。

### 任务 4：可选、有限操作的私有协作运行服务（T4）

**文件：** 新建 `apps/collaboration-runtime` 责任表文件、`tests/{protocol,server,cache,limits}.test.ts`；新建 Java `collaboration/runtime/*.java` 及 `CollaborationRuntimeClientTest.java`；修改 `application.yml` 和 pnpm lock（只因新 workspace 引用重算）。

- [x] **1. 先写真实回环 HTTP 拒绝测试。** 新服务 package scripts 使用 `build=tsc -p tsconfig.build.json`、`typecheck=tsc --noEmit`、`test=vitest run`、`start=node dist/main.js`；依赖限 Core、Zod、现有 Node 工具。实际监听端口 0，测试错误 secret、operation、inputDigest、过期 deadline、超线路字节均不进入 handler。包可启动不等于上述分支已 RED。

  在 `startCollaborationRuntime` 合成夹具取得 `runtime.url` 后，第一条边界断言不携正确秘密：

  ```ts
  const response = await fetch(new URL('/rpc', runtime.url), {
    method: 'POST', headers: { 'X-Apicc-Collaboration-Key': 'wrong' }, body: '{}',
  });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('synthetic-secret');
  ```
- [x] **2. RED。** Core build 后运行 `pnpm -C apps/collaboration-runtime exec vitest run tests/protocol.test.ts tests/server.test.ts tests/cache.test.ts tests/limits.test.ts --maxWorkers=2`；Java `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=CollaborationRuntimeClientTest' test`，用真实回环替身分别给错版本/摘要/构建身份/过量输出，不打真实代理。
- [x] **3. 实现固定协议和装配。** six-operation allowlist、专用秘密文件、严格 schema、限长流式读体、绝对 deadline/AbortSignal、固定远端且 redirect=never；普通 Java RPC 不持有 DB 事务锁。缓存仅安全已编译计划，按摘要＋Core 身份隔离，字节 LRU 有界；收到响应再核实际封装大小，不只信响应 length 声明。

  RPC路径固定 `/rpc`，秘密头固定 `X-Apicc-Collaboration-Key`；先恒定时间核秘密、再有限读体/解码，不能先读无限body。读体累计保护关键代码为：

  ```ts
  receivedBytes += chunk.byteLength;
  if (receivedBytes > maxWireBytes) {
    controller.abort();
    throw new Error('RPC_MESSAGE_TOO_LARGE');
  }
  ```

  `receivedBytes/maxWireBytes/controller` 为单请求局部状态，不跨请求复用；错误经协议映射而非原始Error堆栈出网。
- [x] **4. 逐批先红→实现生命周期。** 无秘密/坏秘密文件启动拒绝；配置未启用不创建监听；截断/超限请求停止读取并释放；取消延时不返回迟到成功；重启丢缓存后从固定已存计划加载，新调用成功但旧请求不重放。Node 不接受用户路径/URL/eval；日志只有 requestId/code/size/duration，无源/secret/header/body。Java 未配置时旧服务仍启动，新能力给明确 unavailable。
- [x] **5. GREEN/构建和独审。** 同测试及 Node build/typecheck；Java 构建验证配置绑定。配置项和默认/范围直接实现设计 §9（含 32 MiB 实际消息、64 MiB 缓存、3s/10s RPC 与所属剩余期限）。独审依赖图和运行入口不能装配 Runner/JS/任意网络能力；不是宣称 OS 强隔离。

**T4 执行回执（2026-11-01）：** 最终累计树 `341155feb7626258f2dbe66fe9b6d8b16f9fa14d`。有限 Core 宿主、专用认证、真实字节/摘要/构建身份、期限/取消收束、策略感知计划缓存、默认关闭及 Spring 配置绑定已实现并定向验证。原候选全 runtime 90 项、Core 边界 34 项及后续 HTTP/Java 检查各有独立证据；最后的 legacy wire 缺口经先红修复，最终 Node 30/30、Core 36/36、Java 53/53，以及 Core/runtime build、runtime typecheck、schema 检查均实际 exit0，原审查者定向复核 I1 ADDRESSED、无新增 C/I/M。旧本地解析器兼容性保留；原 M1 预期负向测试日志噪声延期，不称零遗留。请求正文转换有一处用户接受的历史夹具证据缺口，真实编译计划后验验证与独审已完成，仍不称先红。协议使用固定 `sha256-json-tree-v1`；真实 UTF-8 线路字节独立校验，当前 Core 构建身份为 `4c07a310cb518183c5a33b487fd0f6626f5ba1ba002a8d8db13ae587835a99dc`。专用部署秘密去首尾 ASCII 空白后须至少 32 个 ASCII 可打印字符，建议随机 hex/base64url；不涉及成员凭据。详细命令、候选区分、裁决和精确消费合同在本计划 SDD 的 task-4-report.md、task-4-review.md、task-4-rereview-1.md。T8 真实网关消费、T12 Java→Node/独立部署/CI/资源/页面及整阶段门禁仍未完成，未提交、合并或推送。

### 任务 5：把业务权限接到现有真实入口，堵住旧写入旁路（T5）

**文件：** 新建 `access/AssetMutationGuard.java` 和测试 `access/{AccessEntryPointsTest,ScriptMutationRaceTest}.java`；修改 `content/ContentService.java`、`execution/assets/ProjectAssetsService.java`、`execution/agent/AgentService.java`、`execution/jobs/JobService.java`、`execution/materials/ProjectCredentialService.java`、`execution/scheduling/ScheduleGrantService.java`、`execution/notifications/NotificationEventService.java`；客户端同步 `packages/execution/src/client/{memberHttp,memberTypes}.ts`、`apps/desktop/src/shared/online/execution.ts` 及实际受影响的上游类型测试。

- [x] **1. 列真实入口清单并逐项先红。** EDITOR 保留契约编辑但 script.edit=deny：结构化 delta、旧单 PUT、batch 单条、delete/祖先删除修改脚本均拒绝；非脚本改动成功。credential.manage=deny：写/删拒绝，绝无取原文权限；task.execute=deny：prepare/submit/start/material/cancel 拒绝，旧独立脚本/调度批准仍必须通过。MCP/CLI 走原成员通路返回同稳定错误，不新增工具执行权。

  分类屏障放开后直接读取真实存储，而非只核前端按钮（`beforeFiles/afterFiles` 是同源固定清单，`revisionBefore/revisionAfter` 是提交前后真实修订）：

  ```java
  assertThat(writeResponse.getStatus()).isEqualTo(403);
  assertThat(afterFiles).isEqualTo(beforeFiles);
  assertThat(revisionAfter).isEqualTo(revisionBefore);
  ```
- [x] **2. RED。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=AccessEntryPointsTest,ScriptMutationRaceTest' test`。每批核对请求真实到达授权分支而非夹具未授权/404。用实际契约 payload，而不是把 JSON 中出现 script 单词视为脚本。
- [x] **3. 接 §2.1 权威及 T4 分类。** 在没有 script.edit 的写路径，固定旧/新版本送纯分类；无脚本变化才允许写。事务外异步分类后取得原项目提交锁，重核账号、能力和 revision，再提交；旧 batch 保留逐项部分成功且每项独立授权。未知布局/运行服务不可用且缺 script.edit 时明确拒绝；完整既有编辑权不因可选服务未部署而全面失效。

  完整编辑权且未配置Node的兼容写路径仍写“资产变更”位置/修订审计，并明确脚本分类未启用，不能伪称已完成脚本分类或记录原脚本正文。配置Node的路径补真实分类位置/摘要；分类服务不可用不能让受限编辑者绕过检查。
- [x] **4. 先红→实现读/取消/竞态。** history.read=deny 后任务列表、完整报告、通知/调度结果正文均拒绝；仍有 task.execute 的人可看本人未结束任务最小状态及按旧本人/管理员规则取消，不能取他人历史。受控屏障暂停分类或等待项目锁，撤销权限再放行，提交拒绝且资产字节不变。越区/无成员/停用不得由旧 parser 放行。凭据变更与审计同事务且审计无值/密文。
- [x] **5. GREEN 和兼容独审。** 同两新类＋`ContentApiContractTest,ProjectAssetsApiTest,ExecutionMaterialsApiTest,ExecutionJobsApiTest,ScheduleAuthorizationTest,ScheduleApiTest,ScheduleNotificationsTest`；Node 只跑实际受影响 `memberHttp`/MCP 执行测试。核完整入口清单及权限错误提示，不重写任务账本、不修延期旧 report 读取。

**T5 执行回执（2026-11-02）：** 最终产品累计树 `eacee9efa515791070a72487f934c6e984237cc8`，唯一独审 Spec 合规、Quality Approved，C0/I0/M2。脚本、凭据、任务准入和历史权限接入真实共享服务；固定前后文件分类在事务外进行，提交锁内重核当前资格与修订，旧 PUT/batch/delete 同受约束。本人活跃状态及成功命令回执使用严格九字段最小 DTO，安全 scope 来自已存任务；完整历史列表仍需 history.read，客户端保留原范围和固定输入证明，不伪造历史或自动重跑。最后同源 Node/DOM 336 项及三个类型、四个构建命令实际 exit0；另有 18 项无关 UI 未选入。Java 278 项是此前有限兼容结果，随后 scope 12 项实际通过，最终 server 子树与该候选等价；不拼成最终整树 278 全绿。夹具/前置失败、后验事务故障验证、过时八字段及最小列表假设等证据限制按原 SDD 记录保留，不倒称有效先红。M1 renderer 体积提示与 M2 工具链 advisory 非阻断保留；T8 可读审计消费、T9/T10 完整权限 UI、T12 实际 Java→Node/原生视觉和整阶段门禁仍待执行。旧 F7b LOW-003 未修；未提交、合并或推送。详细合同及证据在本计划专属 SDD task-5-report.md、task-5-review.md。

### 任务 6：固定版本副本、显式成员上传、项目历史及原子额度（T6）

**文件：** 新建责任表的 `collaboration/artifacts/*.java`、`collaboration/policy/*.java`；测试 `collaboration/{CollaborationApiFixture,ArtifactApiTest,ArtifactRetentionTest,ArtifactConcurrencyTest,CollaborationPolicyTest}.java`；修改 `JobRepo.java` 新增独立读取方法、`schema.sql`、`application.yml`。新增 policy repo/controller 的请求/响应 record 定义在同包，不复用执行代理策略 JSON 当 UI 合同。

- [x] **1. 先建立真实来源和固定性测试。** fixture 注册 owner/editor/viewer，建两个项目，按现有在线资产 API 保存合成契约，按既有任务归档协议建立一份报告。请求文档预览后再改项目；确认旧 preview 必须冲突而非取新源，已正式发布的旧版本则保持字节不变。成员上传伪造 agentId/creator/server-archive 等未知字段先拒绝，不信任“已脱敏”布尔值。

  同一intent两次POST的关键断言（`first/replayed` 是真实HTTP返回的JSON树；查询同项目发布列表核数量）：

  ```java
  assertThat(replayed.path("id").asText()).isEqualTo(first.path("id").asText());
  assertThat(replayed.path("digest").asText()).isEqualTo(first.path("digest").asText());
  assertThat(publicationsForIntent).hasSize(1);
  ```
- [x] **2. RED。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=ArtifactApiTest,ArtifactRetentionTest,ArtifactConcurrencyTest,CollaborationPolicyTest' test`；依次观察跨项目源错误放行、重复 intent 产生两版本、超额后部分写入、清理交错空正文等实际业务失败，不将新 URL 的初始 404 算这些分支先红。
- [x] **3. 实现固定读取→派生→预览→提交。** `SourceSnapshotReader` 的文档读取返回同一版本文件清单和哈希；报告通过 `JobRepo` 新单次一致性读取取得归档状态/摘要/正文并验证哈希，绝不组合旧 `report()` 两次读取。成员上传只接 T3 安全单项 schema 并标 member-claim。T4 投影在事务外，候选保存在服务端，预览绑定 actor/scope/source/access/policy/candidate/deadline；提交重新核全部修订，不接受客户端正文替换。
- [x] **4. 先红→实现原子计费、意图和保留。** 项目/部署计费行按固定顺序锁定，检查发布/上传/预览/计划/日志实际字节及数量，写正文/元数据/计费/审计同事务；失败不能残留孤儿正文。相同 intent 同候选返回原记录，更换内容冲突；网络断开查询操作状态，不自动再投影/重发。读副本时事务内核状态并取得完整受限 byte[] 后释放锁，清理只能在无有效授权/候选/活动引用后删；屏障交错验证“完整正文或明确拒绝”，不返回 200 空值。源报告清理后已有副本仍按自身策略可读。T7/T8 消费同一计费和引用接口补真实授权、调用与日志所有者，不能以当前枚举预先宣称这些后续产品已交付。
- [x] **5. GREEN 和独审。** 同四测试；策略表逐项断言设计 §9 默认/范围/跨字段/继承/当前有效来源。历史列表区分 server report 与 member upload，分页 50/max200 稳定游标；pending/expired/unsupported 给准确原因。独审固定源、事务锁顺序/配额和新清理路径，明确旧 LOW-003 未改；不新启清理真实数据。

**T6 执行回执（2026-11-02）：** 最终产品累计树 `a891381df0ef84a956fbfcf7ae07f4d959ebdb13`。固定源、服务端候选、显式成员单项上传、独立安全副本、分层策略、稳定分页和原子计费/审计/清理已完成任务关卡；旧工作区删除沿用原事务补接新所有者释放，旧 LOW-003 未改。策略表 150 项及直接受影响路径曾在 `f1f4376` 集中 458 项通过；入口预算修正后 196 项通过，独审三项缺陷再经有效 RED 10 项和最终四组 246 项通过，均保留实际退出码与鲜 XML，不拼成最终全仓全绿。原唯一审查者定向复核三项均 ADDRESSED、无新增 C/I/M；原四项 Minor 分别归 T10 的显示约束、T12/最终审核的可维护性、部署示例与工具告警，不静默丢弃。默认值及配置绑定实际位于 `PolicyDefaults`/`DeploymentPolicyProperties`，原文件计划中的 `application.yml` 示例等价移至 T12 交付，不删配置能力。旧终态未索引明确 unknown/legacy-unindexed，保留原摘要；真实 Node/压测身份/资源恢复和三端页面验收仍归后续任务。详细合同、分来源证据和原审查/复核在专属 SDD 的 task-6-report.md、task-6-review.md、task-6-rereview-1.md。下一步 T7；未提交、合并或推送。

### 任务 7：访问授权、不可复活失效和公共来源隔离（T7）

**文件：** 新建责任表的 `collaboration/grants/*.java`、`collaboration/publicapi/*.java`；测试 `collaboration/{GrantApiTest,GrantLifecycleTest,PublicOriginBoundaryTest,PublicAdmissionRaceTest}.java`；修改 AuthFilter、ConsoleHostingConfig、schema/config。公共静态页在 T11 装配，当前用固定合成壳验证路由和安全头，不能借壳放开管理 API。

- [x] **1. 先写独立用途和资格测试。** 创建 document/view 与 mock/call 两份固定版本授权，交叉密钥/项目/版本全拒绝；members 不因裸 key 成为匿名可读。三层外部开关缺一拒绝；源读权不足但 publication.manage=allow 仍拒绝。lost-response 后查原 intent 只有一条记录且不回放 plaintext。

  轮换后的实际读取使用原key，不只读取DB状态；`publicUrl/oldKey` 来自该测试首次创建授权：

  ```java
  var response = java.net.http.HttpClient.newHttpClient().send(
      java.net.http.HttpRequest.newBuilder(java.net.URI.create(publicUrl))
          .header("X-Apicc-Share-Key", oldKey).GET().build(),
      java.net.http.HttpResponse.BodyHandlers.ofString());
  assertThat(response.statusCode()).isEqualTo(404);
  assertThat(response.body()).doesNotContain(oldKey);
  ```

  测试再核 `share_unavailable` 和未返回正文；另一个“原key未轮换但责任人移除/重入”的用例应固定为410＋`responsibility_changed`，不能用任一4xx掩盖错误分支。
- [x] **2. RED。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=GrantApiTest,GrantLifecycleTest,PublicOriginBoundaryTest,PublicAdmissionRaceTest' test`。用注入 Clock 控制到期，用真实状态修改控制撤销，不通过缩短全局 TTL 或真实等待获得偶然结果。
- [x] **3. 实现摘要密钥和每次准入。** `SecureRandom` 32 bytes、base64url 无 padding，公开 ID 与内部 ID 分离，恒定时间验证 keyHash；明文只在创建/轮换响应中。版本化 revoke/rotate 原子废止旧秘密；跨 intent 不共用 secret。每次读/下载核固定 artifact、用途/受众、状态/expiry/epoch、当前责任人源读权和管理资格、当前三层策略，再按新副本路径取得正文。异步响应前清理与撤销的准入顺序可记录，不宣称撤回已发字节。

  创建新秘密的有界实现核心：

  ```java
  byte[] bytes = new byte[32];
  new java.security.SecureRandom().nextBytes(bytes);
  String key = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  byte[] hash = java.security.MessageDigest.getInstance("SHA-256")
      .digest(key.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
  ```

  校验用 `MessageDigest.isEqual`；SQL/日志/审计只接hash或非秘密ID，不能接key。
- [x] **4. 逐批先红→实现防复活和隔离。** 移除重入/停用启用/失去后重获权限，旧 key 仍拒绝；管理员接管只创建新授权。策略收紧导致旧投影不合规时锁定失效，放宽不能原地重新启用秘密。独立 public listener/origin 不托管 `/api/v1` 或管理静态资源，管理 listener 不接受公开数据/Mock 路由；只信部署配置 origin/受信入口转发规则，不用任意 Host 拼链接。无效随机 ID/错误 key 一般性拒绝，只有已验证授权可解释失效原因。download 默认关且内容不含访问秘密。
- [x] **5. GREEN 和定向独审。** 同四测试＋原 AuthFilter/控制台 hosting 受影响测试。核 CSP/no-store/nosniff/no-referrer/frame-ancestors，控制密钥不出现在 URL query/path、审计、日志或下载。Origin/CORS 不代替 key 鉴权；生产 HTTPS、本机双端口 HTTP 验收区分。独审检查真路由而非只搜索配置字段。

**T7 执行回执（2026-11-02）：** 最终累计产品树 `e5eba739a1003993c9a374f587aaf0b82b29e034`。独立用途/受众授权、一次性秘密和非秘密回执、持久失效与原子引用/计费/审计、双来源隔离和读取限额已完成任务关卡。原唯一独审三项缺陷经有效 RED 12 项、最终受影响 133 项（实际 exit0、6 份鲜 XML）及原审查者定向复核全部关闭，无新增 C/I/M；先前 139 项与撤除未要求优化后的 18 项属于各自历史树，不拼成最终全仓通过。原两处测试顺序偏差获用户接受，四项补验仍称后验；合成失败证据带出秘密的工具输出历史保留，不重复原值、不据此宣称产品日志无秘密。过期 grant 在真实 deadline 结束，正常副本清理不再破坏策略/启动；终态 GRANT/操作回执继续计费至既有 scope 删除，不凭修复新增 TTL。公开路由隔离等价实现在新前置边界及独立 JDK listener，未制造旧 AuthFilter/hosting 的无意义 hunk。原日志 Minor 留 T12/最终审核；实际 Mock 返回仍明确 unavailable，真实执行归 T8，viewer/fragment/受控 HTML 归 T11，完整配置展示及部署/原生联验归 T10/T12。证据和接口在专属 SDD 的 task-7-report.md、task-7-review.md、task-7-rereview-1.md。继续 T8；未提交、合并或推送。

### 任务 8：共享 Mock 网关、取消/容量和可读无秘密审计（T8）

**文件：** 新建责任表的 `collaboration/mock/*.java`、`collaboration/audit/*.java`；测试 `collaboration/{SharedMockApiTest,SharedMockLifecycleTest,CollaborationAuditTest}.java`；T4 增补必要 `respond-mock` 行为测试。保持本地 `MockPanel/mockManager` 默认回环和测试代理出站模式。

- [x] **1. 先写同规则跨宿主对照。** T3 同一保存配置，Core 本地 Mock 和 Java→真实 Node 共享 Mock 对比 status/mediaType/headers/body/命中规则；只比较两者实际支持的语义。`Authorization/Cookie/Proxy-Authorization/X-Apicc-Mock-Key` 不进入 Node、日志或规则可见输入；依赖这些头的规则在 T3 发布预览拒绝而非运行时被静默删除。

  最小对照中两个响应均是实际HTTP结果，夹具为固定JSON示例，去除控制头不改变业务响应：

  ```java
  assertThat(shared.statusCode()).isEqualTo(local.statusCode());
  assertThat(shared.body()).isEqualTo(local.body());
  assertThat(shared.headers().firstValue("Content-Type"))
      .isEqualTo(local.headers().firstValue("Content-Type"));
  assertThat(recordedRuntimeHeaders).doesNotContainKeys("authorization", "cookie", "x-apicc-mock-key");
  ```
- [x] **2. RED。** `./server/mvnw.cmd -s server/.mvn/settings.xml -f server/pom.xml '-Dtest=SharedMockApiTest,SharedMockLifecycleTest,CollaborationAuditTest' test`，以及 `pnpm -C apps/collaboration-runtime exec vitest run tests/server.test.ts tests/limits.test.ts --maxWorkers=2`。生命周期集成使用真实短命进程/回环端口，不用真实环境发送业务请求。
- [x] **3. 实现首版有界网关。** 只把前缀后的业务 request-target 按 T3 同一规范处理，拒绝绝对 URI、隧道方法、越界/畸形编码，保留重复 query 不二次解码。Java 校验独立 Mock grant，成员受众同时验证账号/成员。新 Mock 默认停用，开启需期望版本；响应 Set-Cookie/Location/hop-by-hop/CORS/CSP 覆盖严格禁止，主动 HTML 正文按独立 origin＋sandbox 处理，不能读管理身份。
- [x] **4. 逐批先红→实现生命周期/限额。** 每项目/全局 RPS 与在途取交集，读体前准入，满额 429、不后台排队、不重试；限制请求/响应/头长度、延时与期限组合。取消读体/延时/调用、Node 重启/超时、停用和服务停止均真实收束后释放槽，不能假释放积累后台工作。桌面关闭/代理离线仍可调用，Node 中断旧调用失败且不补发，下一新调用可装载固定计划。
- [x] **5. 审计先红→实现并 GREEN。** 管理事件与权限/凭据/发布/授权变更同事务，脱敏字段白名单；只记脚本位置/摘要，不记内容。Mock 命中只留元数据，0 条关闭与留存丢旧说明不同于“无访问”；mock key 不可读日志，mock.logs.read 不自动授 audit.read。Java 同三类 GREEN；独审核无秘密真实 HTTP/DB/日志样本、取消与计费，不用源码字符串检查代替行为。

**T8 执行回执（2026-11-02）：** 最终产品树 `34e136d099be0cb1d35f607fe683e878d17978ea`。真实本地/共享 HTTP、Java→Node/Core、有限日志计费及三域可读审计合同已实现。原 Java 95 项在 `71fd3478` 通过，Node 51 项及构建/类型在无后续运行时代码差异的 `caa7f6c7` 通过；独审的发送阶段超期提前释放缺口先复现后修复，受影响 5 项通过，再对新增连接登记清理缺口先复现后修复，最终受影响 4 项通过，均有实际 inner exit0、对应新 XML 和前后树。原审查者两轮定向复核关闭 I1/I2，新增 C/I/M 为 0/0/0；这些分来源结果不拼成最终单次全绿。用户批准仅公共监听器内部复用既有 HttpCore 异步传输及资源无关精确来源预检，真实调用鉴权不变；输入半关闭连接不保留、已发送响应不能改写为第二个 408。游标局部顺序偏差按用户接受如实记录，未宣称先红；时间过滤溢出和工具链提示两项 Minor 留最终审核。T9/T10 页面、T11 查看器及 T12 实际浏览器、桌面关闭/代理离线、CI 前提、同候选门禁与打包仍待完成。未提交、合并或推送。

### 任务 9：客户端项目协作与上传前可见确认（T9）

**文件：** 新建 `packages/execution/src/client/collaboration.ts`、`tests/collaboration-client.test.ts`，并从 `client/index.ts` 导出；新建桌面 main/shared/stores/components 责任表文件、`tests/main/online/collaboration.test.ts`、`tests/renderer/components/{CollaborationPanel,PublicationPreview,SharedHistoryPanel}.test.ts`。修改 `src/main/ipc.ts`、`src/shared/ipc-contract.ts`、`src/preload/preload.ts`、`src/main/online/client.ts`、`src/shared/online/contract.ts`、`src/renderer/src/App.vue`、`components/online/{OnlineProjectAssets,OnlineExecutionPanel}.vue`、`components/{DebugHistory,RunsHistory,RequestEditor}.vue`及中英语言文件；组件路径均以`src/renderer/src`为前缀。更新 `tests/main/online/{client,contract,ipc-online}.test.ts` 的受影响调用；当前renderer没有调用旧成员/ACL管理方法，不为迁移虚造新管理页面。

- [x] **1. 先写不外发、只选一项的宿主测试。** 本机临时历史库有 selected 与 non-selected 两项，监视真实受控网络替身；只打开预览时网络请求数 0，选项变化令候选失效；确认才发安全单项，non-selected 未读取。切地址/账号/项目/本地来源后旧 binding 不可提交。关闭界面不能取消已准入 Mock/服务端任务。

  `uploads` 是网络替身收到的body数组，`unselectedReads` 是历史库未选项读取计数；在确认前核对：

  ```ts
  expect(uploads).toHaveLength(0);
  expect(unselectedReads).toBe(0);
  expect(previewText).not.toContain('synthetic-private-cookie');
  ```
- [x] **2. RED。** `pnpm -C packages/execution exec vitest run tests/collaboration-client.test.ts --maxWorkers=2`；`pnpm -C apps/desktop exec vitest run tests/main/online/collaboration.test.ts tests/renderer/components/CollaborationPanel.test.ts tests/renderer/components/PublicationPreview.test.ts tests/renderer/components/SharedHistoryPanel.test.ts --maxWorkers=2`。先通过业务断言再扩 UI，不以组件渲染空壳作红绿证据。
- [x] **3. 接统一成员 client 与安全 IPC。** client 明确方法 `readPolicy/listHistory/readHistory/preview/commitPublication/queryOperation/listPublications/createGrant/rotateGrant/revokeGrant/setMockEnabled/readAudit/readMockLogs`，输入/响应按 §2.3 严格 schema；绑定 sessionBase/workspace/project/actor，不接受 renderer 任意 URL/路径。main 调 Core 先安全投影再上传，renderer 仅用不透明 candidateId；IPC 校验 sender、schema、期限、字节与当前来源，持久化不保存密钥。

  旧 `manageMembers/manageAcl` 改为携带T2返回的实际期望修订；DELETE query 同步，冲突保留未保存输入并提示刷新，不自动读新revision再重放写。旧成员/ACL视图与管理台同候选升级，协议拒绝旧无版本客户端时显示需升级的明确原因，不静默新增/覆盖配置。
- [x] **4. 逐批先红→实现可读交互。** 在线项目“协作与分享”展示共享历史来源、结论/原失败/完整性；发布预览展示范围/大小/遮罩/独立保留/受众/TTL/下载，契约或规则修改需先保存。候选过期/预算拒绝/权限冲突/Node 不可用给原因及安全下一步；缩小选择重新预览不能残留旧候选或点击回调。创建回包丢失先对账只显示已建/密钥未取得，用户点轮换才新密钥；取消预览不发布、不删本地历史。公开链接仅用户明确复制，主列表不常驻秘密。
- [x] **5. GREEN/类型和独审。** 同定向测试；按 Core→execution 构建，再 `pnpm -C packages/execution typecheck`、`pnpm -C apps/desktop build`。新增中英文文案以可见内容断言，表格/折叠/时间单位/短指纹可查；实际新包视觉统一留 T12，不称 jsdom 即视觉通过。独审 main 外发边界和切源拒绝，保证原本机能力不被在线策略反向锁住。

**T9 执行回执（2026-11-03）：** 最终累计产品树 `722e5b877ee0a12ed6b3c1cde2e9c2174641c7a7`。统一成员 client、安全单项预览/两次明确确认、会话和来源绑定、非秘密授权恢复、共享历史及中英可读交互已完成任务关卡。唯一独审五项缺陷经真实复现及两轮定向修复全部关闭，无新增 C/I/M；本机已知敏感 header 回显复用 Core 遮罩，改选发布版本隔离迟到回包，真实失活原因和额度/CAS 下一步可读。授权新增同路由可选相对期限，由服务端起算，保留旧绝对/默认意图指纹和无秘密、不延期重放；冲突刷新不覆盖用户期限。各源码上的 Core 139、client 113、renderer 109、host/preload 129、Java 35 及变更单例 1，最后 Panel 61 和桌面构建均有实际 exit0；这些重叠及不同源码结果不拼成最终单次全量。三处用户分别接受的局部顺序缺口及失败历史仍在 SDD 报告，不倒称全部严格先红。工具告警 M1 留 T12/最终审核；管理台、公共查看器、实际原生/浏览器与组合部署、全量和打包仍待 T10–T12。未提交、合并或推送。

### 任务 10：管理台可恢复的 ACL、分层策略及分享/审计管理（T10）

**文件：** 新建责任表的 admin `api/collaboration.ts`、`CollaborationView.vue`、两张配置表组件；测试 `apps/admin-web/tests/{api/collaboration.test.ts,views/CollaborationView.test.ts}`、扩展 `views/{ProjectAclView,MembersView}.test.ts`与`stores/workspaces.test.ts`。修改 `src/{api/client.ts,api/contract.ts,stores/workspaces.ts,router/index.ts,views/ProjectAclView.vue,views/MembersView.vue,views/OrgView.vue,views/LayoutView.vue,i18n/zh-CN.json,i18n/en.json}`；已有client的超管入区写方法同步带期望修订，当前未接该方法的UsersView不虚造额外业务表单。

- [x] **1. 先写三种不同管理视角。** 工作区 ADMIN 被项目 NONE：管理下拉仍可见该项目并能请求恢复，内容入口明确不可读；项目 ADMIN 不能改工作区成员；重入待确认有准确状态与两个显式确认动作，不能仅选择项目就恢复。Mock 调用者不能因卡片可见而查询日志。

  在 `ProjectAclView` 使用管理目录的wrapper上（fixture设 contentReadable=false、待确认），核真实可见含义而非内部字段：

  ```ts
  expect(wrapper.text()).toContain('不可读内容');
  expect(wrapper.text()).toContain('待重新确认');
  expect(wrapper.text()).toContain('确认恢复继承');
  expect(mutations).toHaveLength(0); // 仅打开页面或选择项目不得自动确认
  ```
- [x] **2. RED。** `pnpm -C apps/admin-web exec vitest run tests/api/collaboration.test.ts tests/views/CollaborationView.test.ts tests/views/ProjectAclView.test.ts tests/views/MembersView.test.ts --maxWorkers=2`。UI stubs 只验证交互；真实服务端权限由 T2/T5/T7 覆盖，不能用 stub200 冒充鉴权正确。
- [x] **3. 实现入口与策略。** 项目管理下放协作权限/策略、发布与分享、共享 Mock、审计；工作区可见继承上级限制和管理目录，平台可见运行服务/公开来源就绪。配置用字段表/表单展示默认/覆盖/有效/来源/单位/生效范围，角色覆盖 NONE/继承/待确认分开。敏感字段列表为可编辑条目，不把 schema 或序列化策略当表单。
- [x] **4. 逐批先红→实现防误操作与布局。** stale revision 冲突保留草稿并重新加载差异，不自动重试写；移除成员明确影响及旧链接不可复活，确认继承不悄悄消去 NONE。列表不泄露 key；创建/轮换一次性提示，可撤销但不宣称收回下载；策略收紧提示影响。长名称/完整摘要、毫秒＋时区、真实零/未采集/不可计算、中英语言持久切换可读；横向表在自身滚动，不挤断表头或撑坏管理顶栏。
- [x] **5. GREEN/构建和独审。** 同四份定向测试＋`pnpm -C apps/admin-web build`。逐项核设计 §9 新配置可修改和有效来源、权限冲突及现有入口兼容；实际 HTTP 页面集中 T12。审计分为管理记录与不完整/关闭的访问明细，原始安全记录默认折叠，关键原因直接可读。

**T10 执行回执（2026-11-03）：** 最终累计产品树 `03ddbf8664effeceb88a351772a52eb4a2d4605b`。管理目录与内容权分开、已见修订写入、待确认恢复、分层可读策略、非秘密授权恢复及三域审计已完成任务关卡。唯一独审 I1–I8 经第一轮定向复核全部关闭，修复新增的无协议地址解析问题 N1 经两个真实入口先复现、最小共享解析器修正、原审查者第二轮定向复核关闭，无新增 C/I/M。原 229 项及后续 API/store/Members、ACL22、View58、构建、Java Deployment8 与最终受影响3项均按各自源码和实际退出码保存，不拼成单次新全量；§9 默认期限范围及六行硬资源元数据有生产者验证，外部 OS 执行并未因此证明。用户接受历史成功样本前提缺口的如实记录、后验补验及独审，不追认为历史先红。旧列表形状保留，修订来自授权 access-members 显示前读取，不声称列表已加字段。工具告警、候选状态文案两项 Minor 及已披露的旧 CAS 缓存调用不确定性留 T12/最终审核；真实服务端管理链、浏览器/原生视觉、组合部署、整阶段全量与打包仍未完成。未提交、合并或推送。

### 任务 11：独立公开只读页面，默认中文、固定导航和可读报告（T11）

**文件：** 新建责任表的 `apps/share-viewer` 文件、`tests/{fragment,client,views}.test.ts`；package 使用现有 Vue/Vite/Vitest，无 admin/desktop 私有依赖；Java 增补 `PublicOriginBoundaryTest` 的实际资源检查。修改 Java 独立资源打包装配，管理 bundle 保持原位置。

- [x] **1. 先写 fragment/key 与锚点交互失败测试。** 输入 `/s/public-id#key=synthetic-secret&section=api-2`；搜索/目录跳转/刷新保持本次访问且不把 key 变成 query/path；同一页 key 只在内存和专用 header，任何日志/localStorage/sessionStorage/download/DOM 不含 key。没有 key 给通用提示，不从管理员 storage 借 token。

  抓取viewer的真实fetch输入，断言专用头存在但URL不带秘密，fragment不被HTTP传输：

  ```ts
  const outgoing = new URL(request.url);
  expect(outgoing.hash).toBe('');
  expect(outgoing.href).not.toContain('synthetic-secret');
  expect(request.headers.get('X-Apicc-Share-Key')).toBe('synthetic-secret');
  expect(document.body.textContent).not.toContain('synthetic-secret');
  ```
- [x] **2. RED。** `pnpm -C apps/share-viewer exec vitest run tests/fragment.test.ts tests/client.test.ts tests/views.test.ts --maxWorkers=2`。用真实 DTO fixture，包括逻辑4/4通过＋请求10/失败6、单趋势桶、未采集证据、长名/指纹/毫秒时区、被转义脚本文字。不能通过 fixture 删掉失败或限制再称可读。
- [x] **3. 实现受控 fragment 与严格只读 client。** 静态入口只请求本 public origin 的 share-api，不接受任意 URL/重定向、不发送成员凭据。固定脚本只渲染安全 DTO；用户 HTML/Markdown 内嵌 HTML/远程图片不执行，不用 `v-html`；复制片段不发送真实接口请求。数据刷新/下载重新鉴权，失败清理过期正文状态，不显示缓存成功。
- [x] **4. 逐批先红→实现实际展示。** 默认中文、English 切换；侧栏顶端常驻搜索、目录自身滚动，右栏直接呈现命中；章节点定位与 key 分开管理。报告默认结论/时间/逻辑总体/真实请求/失败类别/完整性/节点轨迹，不是 JSON 主视图；趋势0/1点解释限制，数值精度适读但原值可查。下载未允许时不出现伪可用按钮；新数据缺失、到期/撤销、容量/服务不可用分别给安全下一步。
- [x] **5. GREEN/构建和定向独审。** 同测试及 `pnpm -C apps/share-viewer build`、`pnpm -C apps/share-viewer typecheck`（scripts 明确 `build=vue-tsc --noEmit && vite build`、`typecheck=vue-tsc --noEmit`、`test=vitest run`）。Java 真实 GET 公开资源可用但 admin资源/API 不可用；下载离线 HTML 通过 Core 受控生成器无 key。独审只读安全边界和可见内容，视觉集中 T12，不能只证明语言 key 或字段存在。

**T11 执行回执（2026-11-03）：** 最终累计产品树 `505826c99cd3ce13d8f2199d58f45b05df6491f1`。独立只读 Vue 阅读器和 Core 安全 DTO 薄展示/离线生成器、受控 fragment、固定公开资源与重新鉴权下载已实现。唯一独审三项展示缺口先复现后修正，原审查者定向复核全部关闭，无新增 C/I/M。初版同源 viewer35/Core9、Java35及构建/类型均有实际退出0；修正后受影响 Core11/views16及构建/类型通过，Java/授权/锁文件源码未变，但重建 JS 字节已变，旧 Java35不冒称验证新 JS 的实际浏览器执行。锁文件仅新增阅读器 importer，无关五项临时依赖升级已回退并在原锁版本上最终验证。资源采用独立外置 `APICC_SHARE_VIEWER_DIR`，不混管理台或增加 Maven 前端步骤；HTTP 下载仍是新鉴权安全 JSON，阅读器随后生成无密钥 HTML。转义后 HTML 保守复用既有32MiB硬上限，可能拒绝合法大副本的导出，明确提示且不截断或伪称成功。原工具/编码噪声留最终审核，真实双来源/CSP、中文/English 视觉、原生、部署、整阶段门禁和打包仍由 T12 完成。未提交、合并或推送。

### 任务 12：同候选集中联验、可选部署和可验证打包（T12）

**文件：** 新建责任表的 Dockerfile.collaboration、验收脚本/测试、使用文档；修改 `Dockerfile`、`deploy/docker-compose.yml`、`.github/workflows/ci.yml`、`scripts/test-all.ps1`、`docs/deploy.md`、`server/README.md`、`apps/desktop/scripts/smoke-dir.mjs`及`apps/desktop/tests/smoke-readiness.test.ts`受影响资源清单。公开viewer采用外置独立资源目录，由Docker/本地交付脚本复制，不要求将其混入管理台资源或新增Maven前端下载步骤。新计划当前只定义这些工作，未启动实际部署。

- [x] **1. 先写交付路径失败测试。** `node --test scripts/tests/f7f-acceptance.test.mjs` 校验验收编排只用合成根、随机端口、固定预算、退出清理、同候选身份；真实测试未启动/先决条件缺失必须明确失败或已声明条件跳过，不能打印假通过。现有包资源测试补“新协作 IPC/纯 Core子路径可加载、公开 viewer 在独立资源目录”，先观察有效失败。

  测试先约束不合法运行模式不启动任何合成资源，脚本用稳定错误码并非底层堆栈；`spawnSync` 从 `node:child_process` 导入，cwd为仓库根：

  ```js
  const result = spawnSync(process.execPath,
    ['scripts/f7f-acceptance.mjs', '--mode=production'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SYNTHETIC_ONLY/);
  ```
- [x] **2. 装配可选部署并真实启动。** `Dockerfile.collaboration` 按当前锁构建 Core 与有限 Node 宿主；Compose `collaboration` profile 只在内网暴露 RPC，挂只读 secret、只读根/非 root/CPU/RSS/heap等真实限额，不把 agent token 交给它。Java public listener 用不同端口或受信不同 origin，公开资源不挂 admin bundle。旧 Java-only 启动和原 agent 回路仍可用；启用组合实际启动、bad-secret/bad-version/Node未配置/中断都给可读 unavailable，而非静默回落。

  viewer构建复制到单独 `share-viewer` 资源目录，不能复制进现有 `console-dir` 的SPA回退目录。Java新listener由T7 public路由/过滤器显式装配，同一Java进程共享授权/副本仓储；管理listener先拒绝public路由，不依赖路径同名碰巧命中不同bundle。Docker及本地启动文档都显式传独立资源路径和公开BaseURL，未配置不开放public端口。
- [x] **3. 一份累计候选上集中联验。** `node scripts/f7f-acceptance.mjs --mode=synthetic --evidence-root=local/f7f-acceptance`，脚本使用本机真实 Java＋Node＋现有 agent 的合成资源，记录进程/容器/端口/候选摘要。以5组场景覆盖下方矩阵；任何本机原生 UI 先问显示权限（原计划时未获授权，执行时另有用户明确显示批准），不碰旧客户端/真实项目。不要求用户反复登录不同短命服务；同一地址集中完成，非TLS行为用隔离HTTP双origin自验，TLS特有检查保留真实证书验证。
- [x] **4. 一次整分支独审和范围化修正。** 冻结累计产品/正式测试完整清单和源码身份，原有任务审查结果供唯一整分支审查者复用，不重新派多个宽审。新问题先复现，记录范围和责任人，只对修正项定向复核。用户未确认的安全/权限范围扩张停止并集中提问；不把以前流程偏差当批准。
- [x] **5. CI 等价构建与一次全量。** 新两包加入 CI 显式 build/typecheck，递归测试保持单 workspace／maxWorkers2；依赖拓扑 Core先、execution次、消费者后，公开资源构建先于Java打包。更新根门禁保证它与CI都覆盖两新包、Java全套、品牌门禁。精确工具链下运行 `./scripts/test-all.ps1`，保留实际 stdout/exitcode/数量/条件跳过；之前定向通过不拼成单次全绿。若用户在集成时要求合并后全量，则将这一最终全量放到已授权本地合并后的同候选，只补验合并差异，不默认前后各跑一次。
- [x] **6. 目录包和公共页面实际验收。** `pnpm -C apps/desktop dist:dir`、`pnpm -C apps/desktop smoke:dir`，核原生资源和实际启动日志。获显示批准后集中检查新增中英入口、单项上传确认、版本固定、预览缩小/重试、共享历史可读、未配置/拒绝提示。浏览器双origin真实检查目录/搜索/复制/下载、撤销后新读取、HTML不执行、长表本区滚动和常驻搜索；不重新手验所有旧功能。工具不能验证的离线HTML只留最小新增手验请求，不能伪称已看过。
- [x] **7. 封存交付与清理。** 使用文档包含部署可选性、配置表入口、生命周期A升级影响、发布/成员声明/下载风险、密钥丢回包对账、权限冲突/不可用下一步、备份与恢复、旧遗留范围。复验升级/重启不延长TTL、不恢复撤销、不丢计费/正文关联。停止本轮合成监听/进程并列出已结束资源，保留报告/保存资产/证据；丢弃内存草稿另取即时批准。交付包及其源码身份/日志/AC事实，阶段完成不等于已提交/合并/推送或CI通过。

## 4. 配置落地和范围化验证清单

下表将设计 §9 分配给实现责任，数值不重新设计。普通业务配置在 Web 可读管理，发布本次选择在客户端；部署秘密/地址/硬限制在部署入口。每个 schema/解析器实际测试默认、最小/最大、越界和至少一组跨字段冲突；不为每个数字新增多宿主组合运行。

| 配置组 | 必须落实的默认/范围要点（完整依据设计 §9） | 责任 |
| --- | --- | --- |
| 开关/继承 | 外部三层关闭、历史发布开启但不自动上传、Mock关闭、下载关闭；下级不能扩大能力 | T2/T6/T7/T10 |
| TTL/预览 | 分享7天/最大90天、单次至少1分钟、部署max至365天；预览10分钟(1–60)、待确认5/20/100(各1–1000)、总期限60秒(5–300) | T6/T7/T9 |
| 字节/证据 | 源16MiB(1–64)、副本8MiB(64KiB–32MiB)；详情off；字段8KiB(256B–64KiB)、报告1MiB(4KiB–8MiB)、字段≤报告≤副本 | T3/T4/T6 |
| 数量/存储 | 每项目版本1000(1–100000)/256MiB(8MiB–10GiB)；外部授权每项目100(1–10000)、全站1000(1–100000)；全站1GiB(64MiB–100GiB) | T6/T7 |
| 保留/分页 | 非活动副本30天(1–365)；成员历史30天/1000(1–365/1–100000)；分页50/max200；清理100/小时(1–1000/1分钟–24小时) | T6/T8 |
| 公共/Mock准入 | 读取每授权10RPS/8在途，Mock每项目20RPS/16在途，范围1–1000RPS/1–256；两者各全局100RPS/64在途，范围1–10000/1–1024 | T7/T8 |
| Mock正文/延时/日志 | 请求响应各1MiB(1KiB–8MiB)；最大延时30秒为Core硬限，调用35秒(1–120且留余量)；日志200条/24小时(0–10000/1小时–30天)，0关闭留存 | T3/T4/T8 |
| 遮罩/CORS/审计 | 额外敏感规则0–200项/每项≤256字符，无任意regex；CORS0–50精确origin/≤512字符；管理90天(7–3650)、访问7天(0–90，0关闭明细) | T3/T6/T7/T8/T10 |
| RPC/运行资源 | 连接3秒(0.1–30)/普通调用10秒(1–300)且不超剩余期限；缓存64MiB(8MiB–1GiB)；实际封装消息32MiB(1–128MiB)；CPU1(0.25–8)、RSS768MiB(256MiB–8GiB)、heap384MiB(128MiB–4GiB) | T4/T12 |

CPU 可小数，其他数量/字节/毫秒整数；heap、缓存和在途必须为RSS留余量，未配外部硬限制不能宣称已限制RSS。保存值/有效值/来源/是否需重启可读；限流与资源数值是保护边界，不是吞吐承诺。

## 5. 集中验收映射与停止条件

| 验收组 | 所需真实事实 | 对应任务/AC |
| --- | --- | --- |
| G1 权限与生命周期 | OWNER备用入口拒绝；非成员旧ACL不放行；移除重入需确认、NONE保持；无覆盖继承；权限冲突/回滚；旧文件与MCP/CLI无旁路；有权执行者可观察本人最小在途状态 | T1/T2/T5/T10；ACL-E01–06，AC04/AC12/AC13 |
| G2 来源、发布与清理 | 真归档/成员声明分别可读；未确认不上传且只读所选单项；两项目不能混源；编辑不改变旧副本；同intent不重复；源清理不删副本；交错只有完整内容或明确拒绝 | T3/T6/T9；AC01/AC02/AC03/AC07 |
| G3 授权与公开origin | 只读key/Mockkey不通用；关闭/失权/到期/轮换后下一读拒绝；重入/重新授权不复活；管理员接管新key；独立origin无admin身份/API；无秘密URL/日志/下载；XSS字面显示 | T7/T9/T11；AC05/AC06/AC11 |
| G4 Mock语义与故障 | 本地/共享同规则同响应；敏感头条件预览拒绝；桌面关/代理离线仍可调用；Node中断不补发；取消释放；满额429；日志权限/观测缺失准确 | T3/T4/T8；AC09/AC10/AC12/AC14 |
| G5 真实页面和交付 | 客户端/管理台/公开页中英文可读，无JSON元数据主视图；固定搜索/目录、长表局部滚动；同候选包/Java-only/Java+Node启动，错secret/version明确拒绝；重启不延TTL | T9–T12；AC08/AC13/AC14，复核AC01–12可见结论 |

每条验收记录实际输入、来源/候选身份、命令或操作、退出码/状态及限制；不要求全角色×端点×页面矩阵，不主动启动24小时/高负载。以下是本阶段阻塞：OWNER或NONE保护可绕过、旧授权/秘密复活、未确认即外发、跨项目/来源错配、公开DTO泄密、公开源读到管理身份、200空正文、真实业务被意外执行、关键UI仍用JSON代替可读展示。不能把这些降为“以后优化”交付。

## 6. 准备自检与执行交接

- [x] **规格覆盖自检：** 已逐条对照设计 §1–13、AC01–14、ACL-E01–06 和生命周期 A，映射见任务表及G1–G5；本表不代表产品通过。
- [x] **计划一致性自检：** 已核对文件责任/依赖和§2定义；补齐旧成员/ACL调用的修订迁移、移除主体不可重置修订、browser纯类型出口与独立viewer资源装配；无空占位。
- [x] **准备验证：** 2026-11-01，四份文档51个本地文件链接无缺失，代码围栏成对，无尾随空白；T1–T12顺序及每任务至少五步/具体代码或断言已检查，产品步骤全部未勾选，AC01–14均明确映射。首次静态检查发现AC03仅以简写出现，已补完整映射后重验通过。`git diff --check`通过（路线图仅有LF/CRLF提示）；实际变更仅四份文档，main干净且与origin/main同为e071f61。未重复此前225项Java和25项管理台基线、未运行未实现测试、未开产品服务或派发代理。
- [x] **集中开工确认：** 2026-11-01，用户明确“可以，完成F7f整阶段”；按原模型配置、子代理开发及独审连续执行T1–T12，不逐任务重问已确认产品口径；Git集成仍另授权。

计划和设计归档完成不等于获得开发批准；OWNER现有缺口仍未修复。最终回执只在产品实现、必要测试/独审、集中联验和包真实完成后追加，不能提前勾任务或套用F7e的CI结论。

## 阶段最终回执（2026-11-03）

T1–T12、唯一整分支审核、批准范围内的修正及原审查者定向复核、集中原生/浏览器验收、r2目录包真实冒烟和最终真实Java/agent/container组合均已完成。完整AC01–14、实际命令/数量/源码身份/制品哈希/清理记录见[交付回执](../../f7f-acceptance-20261103.md)。最终组合 `run-bQsNkl` 实际exit0，40 Java场景、1个真实代理场景和实际容器验证均通过，前后候选身份一致。

第5步表示全量义务已真实执行和后续有界处置完成，**不表示原全量单次通过**：原Java1920的6失败/86错误、代理1失败、admin夹具失败及条件跳过均保留。Node路径/85补验、四个测试前提修正180项及独审已完成；代理取消和旧调度拒绝的两项偶发失败未定因、未修复，用户分别同意[登记已知风险](../../f7f-known-risks.md)后收尾，不能用后验通过抹掉原失败。历史测试顺序偏差仍按各任务回执如实保留，未经补写先红历史。

exe/asar和实际容器与最终运行时代码一致；此后只追加归档文档，不因此重复已绿全包或重开宽审。所有本轮合成进程/容器收束，保存资产、报告和证据保留，无真实项目操作。未暂存/提交/合并/推送，main未变，也没有本轮CI通过结论；F7g或Git集成仍需另行授权。
