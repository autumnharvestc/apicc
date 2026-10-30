# F7d 服务端定时任务与通知实施计划

> **最终交付状态（2026-10-30）：T1–T8 实现及必要验收完成，尚未集成 Git。** 以文末[阶段最终回执](#阶段最终回执2026-10-30)为最新状态；下文失败检查点保留为历史。两次根全量 exit1 与最后经批准的 Java 全套 923/923 分开记录，不称单次全绿或 CI 通过。

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 逐任务实施；每任务一位 Sol high 实现者、一轮 Sol xhigh 任务独审，最后整阶段独审。步骤复选框记录执行状态，证据另存本计划专属 SDD 目录。

**目标：** 已保存在线套件和工作流可在桌面退出后按计划交由指定代理执行，并提供可追溯历史、站内通知和安全的通用 Webhook。

**架构：** 内嵌 `ScheduleDriver` 只唤醒持久 `ScheduleOccurrenceService`，后者通过 `ScheduledJobSubmission` 复用原 `JobService`，代理继续使用同一 Core。数据库事务、唯一约束、水位和代次是权威；通知使用独立持久事件与 outbox。未来独立驱动只替换适配器，不创建第二套任务内核。

**技术栈：** Node 22.19.0、pnpm 11.21.0、JDK 21.0.12、Spring Boot 3.5.5、JdbcTemplate/H2、Spring 六字段 CronExpression、Vue 3/Zod；新增通知传输 HttpClient classic 5.6.5 / HttpCore 5.4.4。

**规格：** [已批准设计](../specs/2026-10-29-apicc-f7d-scheduling-design.md)。用户批准继续完成 F7d；文中默认值/边界不再重复征询。Git 集成和真实用户计划不在本次授权内。

## 全局约束

- 复用隔离工作树 `C:/Users/imini/.codex/worktrees/contract-assets/apicc`，分支 `codex/f7d-scheduling-design`，基线 `8e2c6f259004ae3e129b4d5c1329e3b2f0012e84`；保留现有文件，不在 main 实施，不提交/合并/推送。
- 设计第 7 节是参数默认值、范围、配置归属与生效时机的完整权威表；每位实现者必须完整阅读，不把可配置项写成仅 UI 常量。单位为毫秒、UTF-8 字节和整数数量。上限取适用最小值，最小间隔取适用最大值，低层不得扩大授权。
- 调度只接受 suite/workflow、dedicated-task；默认暂停、Asia/Shanghai、misfire=skip、overlap=skip、queueTimeoutMs=300000。不实现 debug/stress 调度、独立 B 服务、整任务自动重试、邮件/IM 专用插件或 F7g 后延期项。
- ID/版本为 BIGINT 对应 JSON 字符串；业务 UUID 不变。同计划同 UTC 时刻唯一；固定快照、修订、材料引用和执行主体，不能保存登录令牌、凭据值或个人本机材料。
- 生产时间与租约通过数据库 UTC `ScheduleTimeSource`；测试注入同接口，不让驱动自报时间。持久水位不得因修订、暂停、重启、回拨或清理重置。已存在的 pending 以 ID 恢复。
- 提交 job、occurrence 关联及游标更新同事务；不得绕过原 JobService 身份/材料/脚本/运行时/容量/许可校验。队列截止从计划时刻固定，普通 Submit 不增加可任意传入的提权字段。
- Ruling46：每次新准入deadline=原planned UTC+min(计划保存queueTimeoutMs,当前有效maxQueueTimeoutMs)，旧启用计划未来触发无旧额度豁免；保存值/修订与已经封存的occurrence/Job/permit/水位/身份不改写，waiting/catch-up不续期。
- 站内事件持久、读取重新鉴权、已读按成员；Webhook 只发安全摘要，完整 URL/secret 加密，默认拒绝出站，每次实际连接 DNS/IP 受限，TLS 校验不关闭。通知重试绝不调用执行提交。
- 修改客户端/Web 前读 [页面规范](../../ui-presentation-guidelines.md)。配置、状态、统计、轨迹与历史使用可读主视图；中文/English、单位、毫秒时区、短指纹可查完整值。JSON 只作默认折叠次级详情，不能塞入表格冒充展示。
- 先有效业务 RED 后实现。缺模块、编译失败、坏夹具不是 RED；新 API 可以已运行的合法认证请求返回 404 而非预期业务响应作为首次失败证据。每个随后新增行为分别先红；发生顺序偏差立即如实上报，不制造历史。
- 每批生产修改前，先在任务证据草稿列出“新增行为/保护分支 → 测试用例 → 已观察 RED 日志”的小表；同类边界可参数化同跑。不能用首次路由 404 覆盖随后全部保护分支；GREEN 中发现额外保护需求时，先给该分支补有效 RED，再改实现。此检查在本地推进，不增加逐项人工审批。
- 每次只跑受影响最小集。真实服务/Docker/打包串行、JS maxWorkers=2。保留 CI80 的真实启动事件同步和 CI81 短账本读探针、停机副本完整性检查，绝不放宽生产账本锁/延长超时替代修复。
- 工作报告含 RED/GREEN 命令、前后输出及日志路径、自审和变更文件；不自动 commit，不派自己的子代理。审查者只读，不重复运行同树已有绿证据。

## 文件责任与依赖

| 工作包 | 创建或修改位置 | 单一责任及依赖 |
| --- | --- | --- |
| T1 | `packages/execution/src/contract/scheduling.ts`、`contract/index.ts`；Java `execution/scheduling/{ScheduleDtos,SchedulerProperties,NotificationProperties,SchedulePolicyValues,SchedulePolicyService,ScheduleRuleCalculator,ScheduleController,ScheduleTimeSource,DatabaseScheduleTimeSource,NotificationConfigurationBoundary}.java`；复用 `execution_configs` | 跨端 DTO、配置继承、规则预览、公共时间边界。T2–T7 使用同一字段/端点，不在 UI 重算 Cron；实际单一职责文件见 T1 报告 |
| T2 | 同包 `{ScheduleRepo,ScheduleService,SchedulePlanController,ScheduleGrantService}.java`；`schema.sql`；execution client `scheduling.ts/index.ts`；desktop `main/online/scheduling.ts` | 固定定义 CRUD、独立授权、客户端真实准备；只保存计划，不触发目标。复用已有 snapshot/materials/prepare |
| T3 | 同包 `{ScheduleOccurrenceRepo,ScheduleOccurrenceService,ScheduleDriver,EmbeddedScheduleDriver,ScheduleControlService,ScheduleControlController}.java`；`schema.sql` | 持久到期裁定、代次/租约/唯一键/水位/错过窗口；T4 通过公共权威领取，不在驱动提交 job |
| T4 | 同包 `ScheduledJobSubmission.java`；既有 `jobs/{JobService,JobRepo,RunnerControlService}.java`、`schema.sql`、材料校验边界 | job 原子关联、截止、重叠和恢复；不复制执行状态机，不增加回调反向锁 |
| T5 | `execution/notifications/` 内按事件、渠道、加密、outbox、传输、控制器拆分；`schema.sql`、`pom.xml`、公共 cipher；contract/client 通知 DTO | 观察 T3/T4 持久来源，安全摘要、成员已读与有界投递；不依赖客户端，不触发业务 |
| T6 | desktop `shared/online/scheduling.ts`、`main/online/scheduling.ts`、现有 IPC/online 路由；renderer `stores/onlineSchedules.ts`、`components/online/{OnlineSchedulesPanel,OnlineNotificationsPanel}.vue`、`OnlineProjectAssets.vue`、zh-CN/en | 项目业务调度、预览、固定快照差异、历史、通知；消费 T1/T2/T5，不增加 Web 业务编辑器 |
| T7 | admin-web `api/scheduling.ts`、`stores/scheduling.ts`、`views/{SchedulePolicyView,NotificationChannelsView,ProjectScheduleGrantsView}.vue`、router、Layout/Org 接入、zh-CN/en | 对应级别策略/渠道/授权，展示实际值与来源；项目选项不需工作区管理员权限 |
| T8 | `scripts/f7d-acceptance.mjs` 及测试 helper、最小联验测试、部署说明/本计划回执 | 四类受控故障与实际 UI、同候选制品、一次全仓门禁、最终审查；不修改真实数据 |

依赖顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8。T5 理论可在 T3 后独立，但本轮实现者不并行写共享文件。各工作包可在自身命名空间内增补单一职责文件，报告准确列出；不单方面重构已有执行内核。

### 任务 1：调度契约、配置和规则预览

**状态：已完成。** 初审 I1 经一轮修复及定向复审关闭，无遗留阻塞；初次 Java 48 / TS 23、构建/类型检查通过，修复后规则 14 项单独通过，不拼称重跑全仓。完整证据在本计划专属 SDD 的 task-1-report.md、task-1-review.md 和 task-1-rereview-1.md。

**文件：** 上表 T1；测试 `packages/execution/tests/scheduling-contract.test.ts`、`server/src/test/java/com/autumnharvestc/server/execution/ScheduleRulesApiTest.java`、`SchedulePolicyTest.java`。复用 `AgentManagementApiTest.java` 中 `ExecutionManagementFixture`（不是独立同名文件），认证、项目和真实 H2 均保持有效。

**先读：** 设计第 2、5、7、8、10 节；`ExecutionDtos.java` 严格 decode、`ExecutionProperties.java`、`ExecutionConfigService.java`、`contract/{task,config,jobs,materials}.ts`。新配置前缀分别 `apicc.scheduler`、`apicc.notification`，不改变原执行配置/任务契约。

- [x] 先增加合法认证的预览 API 测试；在实现新路由前运行并保存预期 200、实际 404 的业务 RED。随后逐个增加非法规则/频率/时区/配置继承行为的 RED，不拿导入失败替代。

```java
var f=fixture();
mvc.perform(post(f.url()+"/schedules/preview").header("Authorization","Bearer "+f.token())
  .contentType("application/json").content("""
  {"rule":{"kind":"cron","expression":"0 0 9 * * *","timeZone":"Asia/Shanghai","dstOverlap":"first"},
   "afterUtc":"2026-10-29T00:00:00Z"}
  """))
  .andExpect(status().isOk()).andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2026-10-29T01:00:00Z"))
  .andExpect(jsonPath("$.candidates[0].offset").value("+08:00"));
```

- [x] 实现跨端严格契约。`ScheduleRule` 是 `{kind:'once',atUtc,timeZone}` 或 `{kind:'cron',expression,timeZone,dstOverlap:'first'|'both'}`；时间均 ISO Instant，Cron 六字段。`SchedulePolicies` 为 `{lateToleranceMs,misfire,catchupWindowMs,overlap,queueTimeoutMs}`。`ScheduleCredentialBinding` 为 `{refId,mode:'current-at-trigger'}` 或 `{refId,mode:'fixed-version',version}`，禁止值字段。

```java
public interface ScheduleTimeSource { Instant now(); }
// DatabaseScheduleTimeSource 从当前 JdbcTemplate 连接读取 H2 引擎端实时时钟；
// 固定非 DETERMINISTIC alias 调用 java.lang.System.currentTimeMillis，再由 SQL 转为 UTC。
// 不能使用事务内冻结的 CURRENT_TIMESTAMP、应用本机时间或驱动自报时间。
public record PreviewRequest(ScheduleDtos.Rule rule, String afterUtc) {}
public record Candidate(String plannedAtUtc,String localTime,String offset) {}
public record Preview(List<Candidate> candidates,List<String> notices,Map<String,Object> limits) {}
// 由 ScheduleRuleCalculator.preview(rule, after, minIntervalMs, maxCandidates) 返回。
```

- [x] 预览 `POST .../projects/{project}/schedules/preview` 权限只读项目，不写 DB、不发目标请求；afterUtc 仅用于纯预览，不能用于生产触发权威。返回后五次或一次性剩余候选。Spring CronExpression 负责日期，明确 first/both 的 DST 重复语义与缺口提示；预算用尽返回安全码，不无限循环。最小间隔校验不能仅靠样本五点，T3 每次准入复核。
- [x] 实现严格部署配置、workspace/project 乐观策略持久继承与 `GET/PUT .../schedule-policy` 管理端点，字段 default/explicit/effective/source/version；权限沿现行工作区/项目有效角色。上限不得放宽，minInterval 下界不得降低，跨字段关系真实拒绝。完整默认/边界用设计第 7 节，不新增任意参数。notification 部署参数和额度也在本次类型里冻结，T5 消费；渠道实际配置 T5 才保存。
- [x] 覆盖 once、非法/过密 Cron、上海五次、纽约 `2026-11-01 01:30` first/both、`2027-03-14 02:30` gap、UTC 回拨不影响纯输入、未知 external 配置拒绝、lease/scan、lateness/scan、通知 lease/timeout、readonly/editor/admin/crossproject、expectedVersion 冲突和继承边界。
- [x] GREEN：固定 JAVA_HOME 后 `mvn -f server/pom.xml -Dtest=ScheduleRulesApiTest,SchedulePolicyTest test`；固定 Node/pnpm 后 `pnpm --filter @apicc/execution exec vitest run tests/scheduling-contract.test.ts --maxWorkers=2`，再 execution build/typecheck。不 commit；写任务报告和实际命令输出。

### 任务 2：固定计划、材料与独立授权

**状态：已完成。** 初审 I1/I2 经一轮修复及定向复审关闭，遗留两项 Minor 留最终审查甄别。材料保护分支缺独立先红已获用户本次明确接受，6 项后验验证单列、不冒称 TDD。初次 Java55/TS38/desktop8/Core11 与修复后 desktop20/Java54/Core22 分别有证据，不拼称一次全量。task-2-report.md、task-2-review.md、task-2-rereview-1.md 为完整回执。

**文件：** Java `server/src/main/java/com/autumnharvestc/server/execution/scheduling/{ScheduleRepo,ScheduleService,SchedulePlanController,ScheduleGrantService}.java`（T1 已有 ScheduleController，不覆盖其预览/策略）；`server/src/main/resources/schema.sql`；`packages/execution/src/contract/scheduling.ts`、`packages/execution/src/client/{scheduling.ts,index.ts}`；`apps/desktop/src/main/online/scheduling.ts`。测试 Java `server/src/test/java/com/autumnharvestc/server/execution/{ScheduleApiTest,ScheduleAuthorizationTest}.java`，execution `packages/execution/tests/scheduling-client.test.ts`、desktop `apps/desktop/tests/main/onlineScheduling.test.ts`。新增表命名 `execution_schedules`、`execution_schedule_revisions`、`execution_schedule_grants`；使用现行 IdGeneration，所有查询带 workspace/project 条件。

**先读：** 设计第 3、4、7、8、10 节，页面规范，T1 实际报告、`JobDtos/ExecutionDtos`、snapshot/material/permission 服务及 desktop 既有 `main/online/execution.ts` 准备流程。

- [x] 在已有认证、snapshot、准备声明夹具上新增 `POST .../schedules` 期待 201 且暂停的 RED；不发送真实目标。独立复现 EDITOR 无授权拒绝、有授权允许、VIEWER 即使写 grant 也拒绝。
- [x] 冻结保存输入/视图，Java `ScheduleDtos` 与 TS `scheduling.ts` 完全一致。复用 `JobDtos.Submit` 中 agentId/snapshotId/target/environmentId/runConfig/preparation/network，**不包含 intentId/debugSessionId**；materials 固定附件及路径、凭据换成 ScheduleCredentialBinding。保存是 `{name,rule,policies,execution,notifications}`；更新另含 `{expectedVersion,enabled,reauthorize,refreshExecution}`，未出现字段不修改。通知选择 `{inApp:boolean,eventKinds:string[],channelIds:string[]}`，首版枚举为设计列明事件，不接受模板正文。

```ts
// 导出 ScheduleSaveSchema / ScheduleUpdateSchema / ScheduleViewSchema / ScheduleOptionsSchema。
// ScheduleView 至少：id,workspaceId,projectId,name,version,revision,enabled,subjectUserId,
// rule,policies,execution,snapshotVersion,manifestHash,notifications,pausedReasonCode,nextPlannedAtUtc。
// options 至少：canManageSchedules,schedulerAvailable,policy,sources,policyVersion,channels(id/name/kind)。
```

- [x] 创建暂停计划；校验 suite/workflow、dedicated-task、无 stressSettings/debugsession/个人本机引用，验证 snapshot 作用域与完整准备声明、代理/材料/脚本/运行时、名称长度与频道作用域。新增/启用/刷新和重新授权均预检；不因为仅保存就发目标请求。修订是不可变 row，名称/通知更新不改 execution revision；定义/规则/身份/材料变化创建新修订。计划另存单调 `cancellationVersion`：停用、软删除、执行定义/规则/主体/材料修订在同事务递增，名称/通知不递增；无需冗余 cancelBeforeRevision。T2证明屏障持久与停用再启用不回退；T3接线后据屏障裁定旧未提交记录，不在T2空取消seam冒称已改不存在的occurrence。水位永不回退。
- [x] 新建数量准入在数据库内串行核对全局/工作区/项目 maxSchedules，含暂停未删除计划；不能只在普通 SELECT COUNT 后插入以致并发越额。使用独立的全局容量锁行，先容量锁、再项目权限/项目行锁，不复用 scheduler control 锁。删除只减少数量，不在持项目锁后反向申请全局容量锁；并发边界用真实事务测试。
- [x] `ScheduleGrantService` 提供 `requireRead/requireManage/requireSubject` 及有效投影，OWNER/ADMIN 默认，EDITOR 显式且仍具 execute 权；平台身份不自动执行。`GET/PUT .../schedule-grants` 只有效项目管理员、expectedVersion；读取/修改跨项目绝不越权。
- [x] desktop Node `prepareOnlineSchedule` 从已保存在线版本创建 snapshot，用真实 `prepareProjectFiles` 和同一 build identity 固定实际依赖。复用选择凭据的实际 Core 闭包与网络认证引用，但只读元数据，不加载秘密、不运行目标；attachments 必须已有显式上传/hash，禁止随意路径上传。输出上述 execution 和可读 snapshot diff 数据，供 T6 显式刷新。抽取与现有 run 共用的纯准备片段时保持原行为。
- [x] 快照差异从真实旧固定快照构造，区分脚本单独变化与数据单独变化，不把整体 manifest 改变冒称数据变化，也不采用临时客户端 summary 作为历史事实。允许最小新增项目作用域固定快照 GET，复用 `ExecutionSnapshotService.loadAuthorized` 并严格核对 URL workspace/project；覆盖当前失权和跨项目读取拒绝，不解密或发送目标。
- [x] Java 调度边界严格验证网络声明的 Core profile/SecretRef/selection 允许字段及约束，拒绝未知 password/value、URL userinfo 与未声明路径；保留合法 username/passwordRef 配对。正向真实 Core 兼容样本与负向绕过须验证，不改变原 Job 传输，也不扩大 Core wire-schema 生成器重构。
- [x] 新增项目鉴权 `GET .../schedules/material-options` 只返回 credential/attachment 元数据；通过材料服务/仓储边界读取，不调用现有会解密的 list/resolve/loadLocal。credential 用 registered/present 等诚实状态，非“已验活available”。保存/启用只检可判定 ref/version/非墓碑/作用域/keyId及部署密钥可用性/字节预算，不解密或构造CredentialValue；损坏密文、格式合法但错误密钥由原提交/材料/permit通路在目标请求前严格拒绝，不假称保存已发现。网络纯依赖收集若与秘密/文件步骤耦合，可在 `packages/core/src/network/prepare.ts` 最小提取并让原路径复用，先行为RED及受影响网络回归，不手写第二套简化选择器，不改变传输/执行语义。
- [x] 到期材料封装接口 `sealMaterials(subject,ws,project,execution)` 返回原 `MaterialSelection`，current 模式读当时元数据版本、fixed 严格核对；服务端不在数据库复制明文，后续 JobService/permit 校验保持。
- [x] 实现分页 GET 列表/detail/options、版本化 PUT、软 DELETE；停用/删除只撤销未提交候选，不能顺带取消已运行 job。授权丢失可读码、审计仅身份/版本，不用 raw 异常。options 是项目成员读投影，不能逼 EDITOR 调管理员 API。
- [x] GREEN：Java 两类测试；execution 客户端 tests；desktop Node 准备测试，包含真实前/后置脚本、网络凭据、版本变化、无秘密和零目标请求断言。受影响 packages build/typecheck。报告与独审后前进，不 commit。

### 任务 3：持久触发与内嵌驱动

**状态：已完成。** 初审 R1/R2 经一轮修复及定向复审关闭，H1/H2 接口口径已同步，工具链告警 Minor 留最终审查。初次五类 Java172/客户端24 与修复后 T3两类97/客户端28分别有源码身份及真实日志；不拼称全仓通过。完整回执见 task-3-report.md、task-3-review.md、task-3-rereview-1.md。

**文件：** Java `server/src/main/java/com/autumnharvestc/server/execution/scheduling/{ScheduleOccurrenceRepo,ScheduleOccurrenceService,ScheduleDriver,EmbeddedScheduleDriver,ScheduleControlService,ScheduleControlController}.java`、`server/src/main/resources/schema.sql`；历史/控制跨端契约和成员历史客户端在 `packages/execution/src/{contract,client}/scheduling.ts`，对应测试 `packages/execution/tests/scheduling-client.test.ts`；Java 测试 `server/src/test/java/com/autumnharvestc/server/execution/{ScheduleOccurrencesTest,ScheduleDriverFencingTest}.java`；表 `execution_schedule_occurrences`、`execution_schedule_missed_windows`、`execution_scheduler_control`，必要索引和来源观察字段。

**先读：** 设计第 2、3、5、6、7、11 节及 T1/T2 实际接口；生产时间只能是 T1 ScheduleTimeSource，测试 fake 时钟放 test 源码。

- [x] 已保存启用的合法计划，在注入到期时间并调用公共权威后期待一条 occurrence 的有效 RED；并发测试用真实事务/屏障，不用 sleep 抢时序。首次缺类可仅建立可编译接口壳，只有行为断言的失败计 RED，壳不包含分支实现。
- [x] 控制自动定时边界，避免新增后台tick在既有共享Spring测试上下文里随机提交T2夹具计划。测试夹具可替换外层timer/自动唤醒入口，手动双驱动/扫描仍调用真实权威和数据库；不mock业务结果，不加生产测试开关/匿名故障路由。真实正式服务的自动唤醒与客户端关闭验收由T8覆盖，不能只证明mock被调用。
- [x] 内嵌 `ScheduleDriver.tick()` 只调用 `ScheduleOccurrenceService.scan(ownerId)`；依赖 T1 scanInterval/batch。`ScheduleControlService` 读取持久 mode/generation/version，首次启动种子来自部署，普通重启不覆盖。平台 `GET/PUT /api/v1/scheduler/control` 使用 expectedVersion 控制 embedded/disabled 和递增 generation；不注册 external。
- [x] 部署 mode 与已存在数据库 mode 不一致时明确拒绝启动并说明先做版本化控制变更；不能重启偷偷覆盖共用 mode。每个实例能力仍仅 embedded/disabled；停新触发不影响已提交 job。后续 B 的适配器接口仍为同一权威，不提前做远程接口。
- [x] 真实事务内验证数据库时钟前进，修正 H2 `CURRENT_TIMESTAMP` 的事务冻结：固定非确定性 SQL alias 读取数据库 JVM 实时时钟、同连接换算 UTC，不增加额外连接或应用时钟回退。调度专用绝对时间列使用 `TIMESTAMP(9) WITH TIME ZONE` 并兼容已有列，先用合法纳秒 once 的实际到期/身份 RED，不能只断言 DDL 文本。

```java
public interface ScheduleDriver { void tick(); }
// scanner 按 due 索引分页，事务内锁 control → project → schedule → occurrence。
// project 锁必须早于 schedule：既有 AgentService.requireProject 已锁 project，CRUD 复用该顺序。
// unique(schedule_id,planned_at_utc)；claim(owner,generation,leaseUntil) 条件更新；
// 领取/提交均重核 control generation、mode、lease、revision、enabled 和 row 状态。
// Occurrence 的状态：pending,waiting-overlap,submitted,skipped,rejected,expired。
```

- [x] 每计划 `evaluatedThroughUtc`、`lastAdmittedPlannedAtUtc` 持久；创建 occurrence/错过窗口和水位推进原子。准入间隔复核，预算不足暂停 schedule-evaluation-limit。默认跳过超容差；catch-up-one 仅补窗内最后一条，旧区间封存不虚构数量。暂停恢复以 now/watermark 以后起算；一次性结束可读，不重置旧水位。DST 与预览同算法。
- [x] 运行时窗口复用 `ScheduleRuleCalculator.java` 已有有界展开结果；允许局部提取私有共用结果及新增内部 `boundedDue(rule,after,through,minInterval,maxCandidates)`，窗口为 `(after,through]`。保持公开 preview 的签名/五条 DTO/DST/UTC 前缀关闭语义，未证明窗口完整时明确求值上限，不能反复 preview 扩大预算或推进未判定水位。through 由内部数据库时间确定，不开放自报时间接口；先覆盖超过五候选的最后一条/窗口预算边界 RED，再实现并跑 T1 规则最小回归。
- [x] 到期记录含 execution revision、sealed material 版本、原计划时刻+观察时刻+固定 queueDeadline。权限丢失暂停后续并记可读拒绝；期满/失效记录不会借租约重建。先恢复已有 pending，再扫描新时刻；缺口记录受 batch/evaluation 预算，不在长停机时生成无限明细。
- [x] DST 缺口可在下一次合法到期求值时观察并记录真实范围/观察时间，不新增独立 gap-day 唤醒。内部 `evaluation_anchor_utc` 与永久水位分开，正常求值保留两合法时刻之间实际 gap；首次启用/恢复/改变求值基准的新修订使用当前数据库 after，名称/通知不重置。只消费窗口内已发生 notice，故障长缺口仍有界、不虚构次数。按实际状态分批先红：正常 gap 能力，再在该能力存在后验证恢复/新规则不追补旧 gap；原本已通过的否定场景只记回归，不为造 RED 破坏正确保护。相关 T2 生命周期与仓储接线同属本任务。
- [x] occurrence 固定 T2 的 revision 与 cancellationVersion，领取/提交前重核当前屏障和enabled。屏障变化将原未提交pending/waiting裁为skipped并给安全取消原因，旧记录不能在停用再启用后复活；不重建同UTC身份。T3将这条权威接入T2的停用/修订语义；已提交job不受该屏障自动取消。
- [x] 暴露 T2 history 分页端点，返回原计划、延迟、原因、material metadata、jobId 和 missed windows（不回传秘密/内部 JSON）；租约字段不是业务状态。历史保留清理只终态/无有效租约/无活动任务/无待通知引用，墓碑/水位/来源去重标记持续保留。
- [x] 历史端点由 T3 同步冻结 Java/TS 严格 DTO 与成员客户端分页方法；控制 DTO 也冻结供 T7 消费。先用真实历史响应及严格 schema 的业务 RED，再实现，不把内部 row 或字符串化 JSON 直接交给 T6 猜字段。历史显示所需状态分层与不可用值须准确，T4 后续填充原 job 投影，不伪造已运行事实。受影响 execution build/types 与最小客户端契约测试随本任务通过。
- [x] GREEN：真实 H2 两扫描实例一条、旧租约和旧代次拒绝、同刻跨修订不重复、时钟回拨、重启恢复pending、水位清理后不重建、skip/catchup/DST/interval/budget、暂停恢复与默认间隔边界。跑两类 Java 最小测试和相关 T1/T2 回归，报告不得声称 T4 尚未接入的业务请求已验收。

### 任务 4：原子提交、重叠和恢复

**状态：已完成任务关卡。** 独审 Critical 0 / Important 0 / Minor 1（测试告警/编码噪声并入最终审阅）；当前四类 Java 137 项通过。此前 234 项中的旧占位断言失败及修正后单例通过分别保留，不拼称一次全绿。此处恢复验证为真实 Spring/H2 事务与 runner 消息路径；真实进程重启、共享数据库跨进程时间、代理和目标请求计数、通知引用及制品/UI 仍由 T5/T8 验收。详见专属 SDD 的 task-4-report.md、task-4-review.md。

**文件：** `server/src/main/java/com/autumnharvestc/server/execution/scheduling/ScheduledJobSubmission.java`、T3 扫描/权威/历史接缝、同前缀的 `jobs/{JobService,JobRepo,RunnerControlService}.java`、`server/src/main/resources/schema.sql`，必要材料校验边界在 `execution/materials/`；测试 `server/src/test/java/com/autumnharvestc/server/execution/{ScheduledJobsTest,ScheduledRecoveryTest}.java`，复用真实 jobs/runner fixtures，必要 production seam 单独聚焦类，不向生产类加测试 cleanup 方法。

**先读：** 设计第 3、4、6、11 节；T3 锁序与 claims；既有 JobService.submit、JobRepo/status/queue、RunnerControlService.prepare/permit、材料严格版本逻辑。

- [x] 先复现 pending 被扫描后没有 job/关联的 RED，再实现；原子失败测试用事务检查点/spy 在既有权威真正 insert 后、提交前抛错，assert job 和 occurrence 关联都回滚，不能只测 mock 调用次数。
- [x] 适配器遵循 T3 的无外层事务前置条件：`ScheduledJobSubmission` 外层不加事务、不先持项目/控制锁；在事务边界外转交完整 Claim（含 leaseUntilUtc）给 occurrence 权威，原 JobService 同步回调加入其内部事务。不得用 REQUIRES_NEW/NOT_SUPPORTED 静默挂起仍持锁的调用者，避免回滚后补记重新加入失败外层；精确接缝以 T3 最终报告冻结。参见 SDD task-4-preflight.md 的原启动许可锁序/持久拒绝检查。
- [x] 新 `ScheduledJobSubmission` 转交完整 T3 Claim（含 leaseUntilUtc），由 T3 权威按 control→project→schedule→occurrence 加锁，重核有效 lease/主体/版本/截止/材料，直接使用 `context.intentId`（权威生成的 `scheduled-occurrence-{occurrenceId}`），构造原 Submit，调用同一 JobService，再在同事务写 job/execution 一对一和 cursor。不得在适配器另拼字符串。保持人工 Submit 摘要/幂等语义；字符串前缀不能把既有人工任务重标为调度来源。CRUD 先项目锁再计划锁；控制变更只锁 control、不反向进入项目/计划，预览/只读投影不持 control 锁。
- [x] JobService 新增仅内部调度使用的受权方法（package/service 有界调用），接收绝对截止+来源身份；最终 expiresAt 为已有适用期限与原计划绝对截止最小值，普通 HTTP Submit schema 不放开字段。开始前再次检查 schedule subject 最新授权（仅 schedule-origin job），不让退权后的旧已排队任务开始；原 job permit/agent/script/material/version 校验仍执行。
- [x] 仅调度来源以 `ScheduleTimeSource` 的数据库 now 计算既有相对队列上限，并在新 permit 及原 Runner poll/expireQueued/claim 的排队过期比较处复用同源 helper；不能依赖 API host Clock 与共享数据库同步。普通人工 Job 原时钟/算法不变，已有 permit 快捷恢复仍在该新检查之前，不增加回调反向锁或第二套队列状态机。先真实应用时钟落后/超前的行为 RED，再接线，保留安全拒绝及原人工回归。
- [x] 调度来源使用 `execution_jobs` 的 server-only 可空 BIGINT 列 `schedule_occurrence_id / schedule_id / schedule_revision`，在同一原提交事务完整固定，occurrence 来源唯一；随原 Job 身份保留，不加阻碍 occurrence 详情清理的外键。通过 JobRepo 专用类型查询，不进入严格 TaskEnvelope/runner DTO，不在适配器另建执行状态。先复现人工同 intent 不可被重标/复用、内部来源完整性与普通人工幂等回归。
- [x] 开始许可核验原已提交job/原修订的主体当前权限，不因后来计划改名、换修订、停用或重新授权，就自动取消或改写原已提交job；cancellationVersion只阻断尚未形成job的触发。主体确实失去当前权限/账号禁用仍在请求前拒绝，区别于计划编辑，不借当前计划主体冒充原提交者。
- [x] 同计划前次 pending/queued/preparing/running/未物理释放均重叠。skip 记原因；queue-one 只一条 waiting，固定 deadline 不续期；待前次 executionReleased 后再提交。报告尚未归档但释放后可继续；cancel requested/offline 不能当释放。job 回调不反向锁 schedule，扫描观察状态。
- [x] 提交回调抛错完全回滚后，经包内完整 Claim 围栏的 `recordSubmissionFailure` 记录：`queue_capacity` 保持原 pending/waiting 状态、封存材料、租约及原截止有界等待，不制造新任务；其他实际提交拒绝只终结该次并记安全码。current 材料单次版本冲突不自动暂停未来触发；主体失权仍沿原授权暂停路径。复用 T3 围栏/锁序，不吞 rollback-only，不存 raw message。
- [x] 现有有界扫描观察 submitted 关联的真实原 Job，仅 state=ended 且 executionReleased=true 时首次写 terminalAt（数据库观察时刻，不冒充业务结束时刻），未释放不写、重复不续期。观察不触发任务，disabled 后仍可收敛在途事实；不从 Job 回调反向加锁。提供真实 activity/release/source 查询供 T5 完成引用证明和清理，T4 不冒称通知引用已验证。
- [x] 已提交记录恢复只查原 job，不因后端重启、未知响应、agent offline 或 lease 到期重建。未开始掉线在同队列有界等、过期以后恢复不得启动；已 permit 的执行沿现行账本对账，不重置 queued/不换代理。
- [x] GREEN：真实事务重入、driver 对象重建前后持久身份、late stale generation、同 intent 重复、queue deadline 等于 planned+值、expiry前后、queue-one 第三次跳过、释放/归档差异、权限/凭据/脚本撤销在实际启动许可前阻断。已运行两类测试与受影响原 jobs/runner/materials 测试；真实后台进程重启及目标请求次数继续由 T8 验证，不以对象重建冒充进程联验。

### 任务 5：持久通知与安全投递

**文件：** `server/src/main/java/com/autumnharvestc/server/execution/notifications/` 的专注类 `NotificationEventService/Repo`、`NotificationChannelService/Repo`、`NotificationOutboxService/Repo`、`NotificationTransport`、`ApacheWebhookTransport`、`NotificationController`、`ChannelCipher` 及成员通知历史投影；`server/src/main/resources/schema.sql`、`server/pom.xml`；公共 cipher `execution/crypto/DeploymentCipher.java` 与既有 `execution/materials/ProjectCredentialService.java`；contract/client 为 `packages/execution/src/{contract,client}/scheduling.ts`。测试 `server/src/test/java/com/autumnharvestc/server/execution/{ScheduleNotificationsTest,NotificationChannelsTest,WebhookTransportTest,NotificationDeliveryTest}.java`。公共 cipher 提取时保留 ProjectCredentialService 旧 AAD。

**先读：** 设计第 7–10 节、T3/T4 来源状态、现有 ProjectCredentialService/材料主密钥配置、页面规范。Apache API 查官方文档/实际 jar，不按记忆假设安全默认值。

- [x] 先在真实 occurrence/job 终态夹具复现通知 GET 没有安全事件的 RED；cipher/出站/投递每新增分支先测。不得将实现后变异检查叫先红。
- [x] 稳定事件唯一 `(sourceId,eventKind,sourceVersion)`，来源 processedVersion 持久，独立成员 read 标记。来源包括真实 occurrence/job 终态及计划暂停；求值预算不足只暂停、不伪造 occurrence，仍由计划的真实暂停版本产生安全原因事件。用户 GET 按最新项目权限过滤；独立 verdict/evidence/report/notification 状态，report pending 不是成功。默认事件 failed/abnormal/expired/paused；success/skipped 显式选。
- [x] 事件 schema 只允许受限名称、ID、时间、版本/定位、投影结论、安全原因码与相对应用链接。assert 全正文无原始错误/秘密/请求响应/脚本/数据/env。状态观察与事件/outbox 写入事务去重；容量不足也终态记录拒绝，不靠下一轮创建新事件补投递。
- [x] 渠道 CRUD 仅工作区 OWNER/ADMIN，expectedVersion，metadata GET 不回完整 URL/HMAC secret。AES-GCM 复用32字节主密钥，nonce12字节，新 AAD `notification/v1/{workspaceId}/{channelId}/{version}`，旧凭据 AAD 逐字保持 `ws+"\0"+project+"\0"+ref+"\0"+version`；错域/坏密钥拒绝。无 key 仅 Webhook 不可用，站内与无秘密计划可用。改地址/key/停用停止旧版未确认投递并显示 channel-changed，不自动测试发送。
- [x] 在 pom 指定 client5 5.6.5 + core5/core5-h2 5.4.4，保存实际依赖树。实现受控 DnsResolver，完整IPv4/v6集合先校验再直接交实际连接；精确 origin 和 CIDR 部署许可默认空，HTTP额外精确allowHttpOrigins；userinfo/fragment/redirect禁止。每渠道短生命周期连接，禁自动retry/redirect/auth/cookies/systemproxy/compression，保持TLS证书/hostname，私有CA仅部署级。

```java
// 以下 record 均在 T5 创建；DeliveryChannel 仅发送期内存数据，不是 GET 或持久化明文 DTO。
public record DeliveryChannel(String id,String version,java.net.URI uri,byte[] hmacSecret) {}
public record NotificationLimits(long requestTimeoutMs,int maxAttempts,long retryMinMs,long retryMaxMs,
                                 double jitterRatio,long deliveryTtlMs,int maxPayloadBytes,int maxResponseBytes) {}
public record DeliveryResult(String reasonCode,Integer status,Instant retryAfter,boolean acknowledged) {}
public interface NotificationTransport {
  DeliveryResult send(DeliveryChannel channel, byte[] fixedBody, String eventId,
                      Instant deliveryTimestamp, NotificationLimits limits);
}
// DeliveryResult 仅安全分类、status 和允许的 Retry-After 时间，不含 URI/响应/原始异常。
// outbox 领取事务结束后才网络发送；回写时再次 lease/version fencing。
```

- [x] outbox 固定 eventId/bodyHash/channelVersion/总截止/次数预算；HMAC-SHA256 timestamp+固定正文，接收ACK丢失允许同身份重复。网络/timeout/408/429/5xx有界退避jitter，其他非2xx终态，Retry-After不得越过TTL；通知不能触发JobService。并发/租约/容量/retention使用T1配置，终态详情清理不删source marker，不存响应正文。
- [x] 给 T6 触发历史冻结真实通知状态与安全原因的成员端投影：采用 `GET .../projects/{project}/schedules/{schedule}/notification-history` 返回实际 source/event 固定头、outbox 状态、安全 reasonCodes/detailState，保留原 `/history` DTO 与 T4 捕获不改。Java/严格TS schema/client 与真实响应测试同步。站内关闭但 Webhook 容量拒绝、改址或耗尽仍须从有权历史查到，不能靠通知中心 list 缺失来猜“无通知/成功”；未观察、未选、站内状态与各投递状态区分，不泄露 URL/secret、不借 report 状态推断送达。先有效 API RED；详情保留期后必要头仍可查，实际 DTO 以本任务报告冻结，不加第二状态机。
- [x] 原来源观察投影只读取实际 occurrence 消费标记、真实事件头和计划暂停来源元数据，分页/游标有界；已删未选来源不重建影子头。暂停来源新增独立的内部版本，在真实初始暂停/启用转暂停/自动暂停/删除原因形成时于原权威事务固定；普通名称/通知修改、已暂停重复停用不推进该来源或覆盖真实暂停原因，已消费后改通知不补旧事件。允许最小修改 ScheduleRepo/OccurrenceRepo 与 schema，不修改 Job、调度锁序或公开 ScheduleView。先实际 HTTP/真实权威变更 RED，再接 Java/严格TS/client/捕获；新旧可恢复事实如实区分，不为迁移编造未知来源。
- [x] 生产 outbox 唤醒使用配置 concurrency 内的有界调度，不在定时执行扫描使用的共享 scheduler 唤醒线程上等待网络或整批投递；不增加无限线程/等待队列。先复现缺失真实后台投递的 RED，再用阻塞合成发送验证唤醒可推进/并发有界。尚无网络接线时已有非阻塞特性可记正确基线，不装错误阻塞实现制造额外 RED；实际已有饥饿缺陷才作独立先红。网络无 DB 事务及完整回写围栏不变。
- [x] 接齐 T3 的 fail-closed 历史清理接缝：依据 T4 原 job 活动/释放事实和本任务真实通知/outbox 引用给出完整证明后，才启用有界自动清理。来源已观察版本随实际通知消费者落在必要来源元数据，不预建永久全量 UTC 影子库；已清正文/旧详情不会再发同一事件或重建旧触发。先真实活动任务/待投递阻止删除、结束且无引用允许有界清理的 RED，再接线；T3 的测试专用引用决定不当作最终验收。
- [x] GREEN：真实本地合成接收端覆盖lostACK、429/500、302、响应回显secret、超长正文、有界总时限、停止/改址后旧记录不出站；受控DNS拒绝任一非法地址、字面IP、IPv6、重绑定、坏CA/host；明文磁盘/GET/日志检查，retention后不再生成。跑四类Java测试与旧credential回归、execution契约/client测试和依赖树。报告哪些测试需要T8真实代理，不能用spy代替业务不重跑事实。

### 任务 6：客户端项目调度与通知

**状态：已完成任务关卡。** 初审 I1–I4 经一轮修复与独立定向复审全部关闭，新增 Critical/Important/Minor 0/0/0。当前受影响五文件170项、原 inspect 定向1项及 types/build通过；原131项和旧22文件身份保留为历史候选，不拼称全仓通过。B5c顺序偏差按用户本次明确接受记录并补行为验证，I2三项无效按钮定位如实更正、只计共享路径后补回归。模板可维护性与构建体积两项 Minor留最终审查；实际新包、视觉滚动和真实服务端端到端仍由T8承担，未以DOM代替验收。完整回执见专属SDD的 task-6-report.md §10、task-6-review.md、task-6-rereview-1.md。

**文件：** `apps/desktop/src/shared/online/scheduling.ts`、`src/main/online/scheduling.ts`、既有 `src/shared/{online/execution,ipc-contract,channels}.ts` 与 preload/main 注册边界；renderer `src/renderer/src/stores/onlineSchedules.ts`、`components/online/{OnlineSchedulesPanel,OnlineNotificationsPanel,OnlineProjectAssets}.vue`，现行 zh-CN/en。上述 src 均以 apps/desktop 为根。测试 `apps/desktop/tests/main/onlineScheduling.test.ts`、`tests/renderer/stores/onlineSchedules.test.ts`、`tests/renderer/components/{OnlineSchedulesPanel,OnlineNotificationsPanel}.test.ts`，后两者也以 apps/desktop 为根，复用既有测试目录约定。

**先读：** 页面规范、设计第 4、5、7、8、10 节；T1/T2/T5 contract/client 和真实部署投影。必须先看 existing IPC 注册，不给 renderer token或Node权限，不将raw传给服务端跳过schema。

- [x] 先在真实在线项目组件断言可见“定时任务”页和暂停保存行为的RED；未保存草稿、local-only、未选agent阻断各自先红。接口响应fake必须完整镜像真实schema，不断言mock本身。
- [x] 项目新增业务页，不在主页跨项目操作。创建目标suite/workflow、指定agent/environment/run settings，默认暂停；每日/每周/高级六字段Cron与once控件，显式IANA时区、只用服务器五次预览。显示错过/重叠/队列截止的真实语义；启用前可读风险摘要/能力原因。
- [x] 主进程真实prepare固定已保存在线snapshot，无隐式本机文件/秘密上传；刷新生成前后目标、env、data、scripts、材料绑定差异的可读列表，显式确认后版本化更新，不默默保存最新；仅名称/通知不重准备执行。重新授权明确主体变化且暂停，不自动继承他人token。
- [x] 列表/search/navigation常驻，details/history独立滚动。历史分别显示 planned(ms+TZ)、delay、queue、actual、verdict、released/report、notification 和安全原因；长fingerprint短显/展开，完整原值可查。用户能由同job原历史读报告，重开不能重新run。
- [x] 通知中心读取当前有权项目、独立成员已读，站内与Webhook状态分列，不把通知失败显示成测试失败。权限以canManageSchedules，EDITOR授权不被现有readOnly推断遮蔽；context变化清理旧数据、终止晚回包，防跨连接/项目泄漏。
- [x] GREEN：上述四类组件/Store/Node最小测试、sharedIPC协议回归、desktop typecheck/build；中英切换真实可见文本、秒/毫秒转换、长名称、禁用原因、版本冲突不覆盖、清除搜索保留其他条件。实际新包视觉验收集中T8，不能仅以DOM通过结项。

### 任务 7：Web 策略、渠道和调度授权

**状态：已完成任务关卡。** 初审 I1（三类表单保存期间新草稿丢失）经一轮最小修复与定向复审关闭，无新增 Critical/Important/Minor。初次同候选 Java58、strict/client93、admin119、类型/构建及修后受影响83、admin类型/构建分别保留，不拼称一次全仓。授权 options 的特定独立先红缺口已获用户明确接受，14项真实后验及独审单列，不冒称 prior RED。完整证据 task-7-report.md、task-7-review.md、task-7-rereview-1.md；两项 Minor 留最终宽审。实际页面、服务和制品仍由 T8 验收；下列实施清单以本状态及报告的逐项证据为准，原始先红措辞保留其具体例外记录。

最终清单的勾选表示该项交付及必要验证已完成；涉及授权资格的原“先 RED”措辞受上段明确的人类专项接受限制，不追溯改写历史为所有分支严格先红。T8 实际页面验收与最后门禁结果见最终回执。

**文件：** `apps/admin-web/src/api/scheduling.ts`、`stores/scheduling.ts`、`views/{SchedulePolicyView,NotificationChannelsView,ProjectScheduleGrantsView}.vue`、`router/index.ts`、`views/{LayoutView,OrgView}.vue`、`i18n/{zh-CN,en}.json`（相对 src 的路径均属于 admin-web），必要的组合根 `src/main.ts`；显式 reset 与授权/策略只读投影限定现有 scheduling 服务/控制器和 execution contract/client；渠道独立材料状态只读投影限定现有 NotificationChannelService.Metadata/metadata 与共享严格 schema/capture，具体边界见本任务步骤，不改加密/出站/投递逻辑。测试 `apps/admin-web/tests/{scheduling,SchedulePolicyView,NotificationChannelsView,ProjectScheduleGrantsView}.test.ts`（实际已有 `tests/views/`、`tests/stores/`、`tests/api/` 约定）；可复用Agents/Org已有入口而不复制编辑器。

**先读：** 页面规范、设计第 7–10 节；T1/T2/T5 server/API实际路由与schema；管理台当前router/session语言持久选择，保留项目卡片长名称修复。

- [x] 先从现有工作区导航进入“调度策略”并期望显示默认/显式/生效来源的RED，再实现。频道保存不触发测试消息、secret不会回显、权限拒绝各自先红。
- [x] workspace管理员维护schedule-policy、notificationchannels，project管理员维护项目下限/额度和EDITOR独立授权；平台controlmode只platform可见。表单按单位分组，不给不可用external按钮，不因平台角色自动显示项目executor能力。
- [x] 策略表显示default/工作区/项目explicit/effective/source/version、何时生效；留空保持与显式重置继承分开，expectedVersion冲突重载并保留用户草稿，不暗中覆盖。上下级约束由服务端权威拒绝，错误码可读。
- [x] 补齐该表实际缺少的上级显式只读投影：在原授权后的 policy view 中增加 `explicitByScope:{workspace,project}`，各为既有严格策略 patch，工作区 view 的 project 为空；保留原 `explicit`/effective/source/version 字段及算法，Java/TS 严格响应同步。项目管理员无需额外请求仅工作区管理员可读的 policy 入口；不要由 effective/source 反推显式值。先真实项目级管理员 API RED，再实现同一授权内投影。
- [x] 为显式“恢复继承”同步扩展 `ScheduleDtos.PolicyUpdate`、TS `SchedulePolicyUpdateSchema` 和 `SchedulePolicyService.save`，新增可选 `resetKeys:string[]`（默认空）；只允许已知策略字段、去重，同字段不得同时 patch 与 reset。保持旧请求/调用兼容。服务端在同一 expectedVersion 事务中移除对应显式值再重新求有效值；不把 null 或空输入当重置。先真实 API RED，再实现：项目改为显式值→reset→父策略变化时随父变化，其他字段保持且版本冲突不能部分修改。前端每字段“继承上级”只加入待保存 reset，不立即落库。该接口在 T7 与对应管理动作同交付，不假称 T1 已有此操作。
- [x] 渠道只显示脱敏origin、可用/启停/key状态、版本和安全失败码；URL/secret写入字段留空表示不变，轮换显式确认旧待投递停止。默认关闭，保存不自动发测试通知。部署出站许可不可被普通表单放宽，HTTP限制直接说明。初始仅普通ASCII DNS与IPv4/IPv6，IDN/Punycode暂不支持，须中英帮助直接说明；origin为null时显示“来源不可用”，不能渲染null/JSON或推断用户已清空地址，available仍要求非null规范来源。
- [x] 补该主视图实际缺少的独立只读材料投影：现有 NotificationChannelService.Metadata/metadata 与共享严格 NotificationChannelSchema 增加 `keyState:available|unavailable|not-checked`、`reasonCodes:(unsupported-origin|channel-key-unavailable)[]`。停用时未解密，显示not-checked；启用时沿现有cipher.open结果，来源不支持独立判定。密钥状态只表示既有加密材料可读性，不能从普通status推断，更不泄露URL/secret或编造密钥文件具体故障。先实际GET各状态/原因组合的缺失字段RED，再最小投影与严格真实capture/UI；原启停/规范来源/出站/加密/发送权限及算法不变，不新增状态机或测试发送。
- [x] grants按成员与资格可读选择，VIEWER不可授予；project计划仍在客户端，Web只管理权限/策略。语言切换中文/English没有key/英文硬编码，表头不挤断，长表局部横滚、名称悬停可查；禁止rawJSON主视图。
- [x] 为该成员资格选择提供项目管理员专用 `GET .../projects/{project}/schedule-grants/options` 元数据投影，复用现有账号/成员/effectiveRole/执行资格权威，仅有效本项目 EDITOR 可选，返回可读名称与资格/安全原因，不开放工作区 ACL 管理、全局用户搜索或平台冒用。现有 grants GET/PUT 与权限不变；共享严格 schema/client 先冻结，UI不依据工作区 role 猜项目资格。先真实 ACL 差异/停用/无权行为 RED；列表检索/分页如有必要按既有约定有界，实际 DTO 在本任务报告记录。
- [x] GREEN：四类最小测试及受影响路由/session回归、admin-web typecheck/build。集中浏览器截图/交互T8，记录新增实际路径，不为旧页面另开全矩阵。

### 任务 8：受控故障、实际页面与阶段交付

2026-10-30 检查点：同候选 `candidate-BrowNN` 的 JAR、server/agent 镜像及 Windows 目录包已构建并实际冒烟，实际原生/HTTP 页面和唯一整分支独审已完成；六项发现及排队上限规则经唯一统一修复/定向复审 7/7 关闭，原四组 Minor 保留。冻结安装已通过；随后唯一根全量命令实际 exit1，普通代理 E2E 的第二压测任务排队原因断言失败，CLI/最后 Java 全套未跑到，故 T8/整阶段仍未完成。当前只读追查前例重启后旧任务槽残留及持久化疑点，不增超时、不删测试、不拼全绿。历次 profile/ready/UI 归档失败及旧11业务断言与恢复1条分别保留，不追改历史结果。完整逐 AC、命令/源码/制品/清理见专属 SDD `task-8-report.md`、`task-8-commands.md`、`final-fix-root-ui.md`、`final-rereview.md`、`root-gate-report.md`；部署说明为[调度与通知使用说明](../../f7d-scheduling.md)。下列组合项不因部分通过打勾，Git/真实数据边界不变。

**文件：** `scripts/f7d-acceptance.mjs` 及 `apps/runner-agent/tests/` 必要联验测试/helper，部署使用说明在 `docs/`，本计划/roadmap/backlog最终回执；新增acceptance脚本及测试助手必须用apply_patch。报告保存 `local/f7d-acceptance/`，不得覆盖F7b/c、CI80/81证据。阶段日志wrapper记录cwd/完整argv/HEAD+dirtydiffhash/制品identity/开始结束/exit。

**先读：** 设计第 11 节AC1–9、最终当前SDD账本、现有runnerE2E fixture、`scripts/test-all.ps1`、Dockerfiles与实际打包脚本。联验助手/产品源码冻结、受影响运行及页面验收完成后，在最终全仓门禁前进行仅一次完整分支独审，统一修复波次及定向复审；修后补验受影响行为并使用同候选制品。不在 T8 助手尚未纳入时提前做宽审，之后又重复最终宽审；不留重要缺口再靠 CI 发现。

- [x] 增加有效故障行为RED后补必要缺口；保持合成项目，四类受控验证复用一套私有Java+Linuxagent+target+webhook，不能并发高负载。HTTPS控制私有CA；非TLS UI/sink用HTTP，用户已允许工具合成认证。脚本退出与失败均finally清理私有资源并检查实际运行状态。
- [x] AC1/7：保存固定snapshot后编辑项目，查看旧定义不变；current/fixed材料轮换、主体/权限/脚本/agent撤销在请求前阻断，查看安全原因。AC2：新包创建启用后真实关闭隔离客户端，后端按时运行；重开只查询同occurrence/job/report。
- [x] AC3：到期前、job事务前/后、agent开始后重启后端；assert skip或恢复同一ID，事务前rollback零job，提交后只一个job，开始后对账/补传不重放。AC4：agent离线在截止前/后恢复，以及已启动控制断线，assert有限排队/过期/原身份无换代理；使用真实启动事件屏障。
- [x] AC5/6：双扫描重复/旧代次/租约/回拨、interval/misfire/queue-one/DST/预算的真DB证据；业务启动计数与suite本身多请求分开。AC8：lostACK通知重试eventId/body固定而target计数不增加；实际DNS/CA/redirect/秘密回显与retention边界证据。
- [x] AC9：新包与HTTP管理台集中实际交互，中文/English、长名称、ms+TZ、指纹、上下级/禁用原因、显式快照diff、历史和通知。浏览器/原生截图逐页核对业务可读性，不以selector存在当视觉通过。如工具无法操作原生必需手势，只请求受影响最小手验，不复验已通过旧项。
- [x] 冻结候选后先 `pnpm install --frozen-lockfile`，记录精确工具链；执行根 `scripts/test-all.ps1` 一次（顺序包、maxWorkers2），保存所有退出码与测试摘要。失败先定位具体因果并最小修复，不提高超时/删测试；如后续改生产代码，说明受影响补验与全量身份，不拼称同次全绿。
- [x] 构建同候选server/agent镜像和Windows目录包/约定分发包，运行真实启动冒烟、运行时/脚本API身份一致核对、只读ledger短probe与stop/copy完整性检查；打包源码必须含最终修复，不能复用旧F7c产物。全仓门与真实联验分时串行，控制本机负载。
- [x] 最终回执更新本计划、roadmap/backlog与部署使用说明：实现范围、实际命令/日志/制品、独审结论、AC矩阵、已知次要项、裁决与未授权Git边界。不称CI已通过、不自动提交/合并/推送。保留未提交工作和完整SDD证据等待用户集成指令。

## 规格覆盖与最终检查

| 设计章节 | 承担任务 |
| --- | --- |
| 1 范围、2 分层/切换 | T1、T3、T8 |
| 3 持久身份/水位/保留 | T2、T3、T4、T5 |
| 4 快照/材料/主体 | T2、T4、T6 |
| 5 时间/错过、6 重叠/队列 | T1、T3、T4、T6 |
| 7 配置与默认、8 权限 | T1、T2、T5、T6、T7 |
| 9 通知与出站 | T5、T8 |
| 10 API与页面 | T1、T2、T3、T5、T6、T7 |
| 11 AC1–9/门禁、12 原配置 | T8及每任务测试/独审 |

最终只有实际验证通过的条目标完成；当前 T1–T7 通过任务关卡，T8 的实际页面/制品及修复复审已验收，但根全量失败，T8/整阶段未完成。计划自检已核对规格映射、共享字段与目录；每任务精确新增接口以本计划和报告冻结，不使用不存在模块报错作为 RED。

## 阶段收尾检查点（2026-10-30，未完成）

- 人类追加批准：针对下述首次全量失败，允许纳入 H2 持久化默认值及实际生效校验的有界修复，补真实应用 ACK 后突然停止/同库重启回归，经定向独审和验证后再执行一次根全量门禁；接受增加写盘开销。不扩为第二次整分支宽审，不增超时、不删测试、不操作真实数据，仍无提交/合并/推送授权。实施与证据在专属 SDD `root-gate-repair-brief.md`、`root-gate-repair-report.md`，首次失败及诊断不追改。

- 审核：唯一完整分支审查后完成一轮统一修复，最终定向复审 I1–I6、Q1 全部 ADDRESSED，无新增 Critical/Important/Minor；原工具链告警、边界/模板可读性、包体积、管理台旧错误提示残留四组 Minor 仍开放，不自动归入 F7b 排在 F7g 后的三项。
- 真实验收：AC1–9 采用原真实进程联验、真 DB/网络测试及实际页面的分层证据，不声称每轮重跑全部矩阵。新候选另验证真实通过/失败各一原 Job、失效渠道可安全暂停、新准入取当前排队上限、真实 HTTP302 双语原因。九张新唯一截图已经 root 与独审实际查看；旧六张重复图仍无效。开始时间未采集时不编造，原始详情默认折叠。
- 工具链与候选：Node22.19.0、pnpm11.21.0、JDK21.0.12、Maven wrapper3.9.9。`local/f7d-acceptance/candidate-BrowNN` 冻结清单 SHA256 `eec8488ac08f9d8c3796070f37a981de7ce9ef3f5a23ebe1fa1b4d9348b25b02`；门禁前后 1193 源码、144 制品 raw SHA 均匹配，659 产品输入无漂移，真实 index 为空。server/Windows JAR 分别构建、分别记 SHA，不冒称跨平台同字节。本检查点文档回写发生在该身份核对后，不把新文档字节追认为旧制品输入。
- 门禁：`t8-g01-frozen-install`、`t8-g02-toolchain-and-identity` exit0；`t8-g03-root-full-gate` 仅执行一次，UTC05:25:21–05:38:10，exit1。构建/类型/生成契约/品牌门通过；plugin11、Core1397、execution337、admin289、desktop1415通过，runner91通过/1失败/13跳过。合计3540通过不是整仓成功；CLI测试与最后Java全套未跑到。实际asar分支运行通过，私有F7d矩阵13项按显式环境开关跳过，原联验证据不被当作本次重跑。
- 失败：`tests/e2e-server.test.ts:300` 期望第二压测任务 `queued + capacityWaitReason`，实际最终 `running`。停机证据表明前例 Job39/execution40 仍占总槽，而代理账本认为已完成归档；总槽满分支先于压测容量原因分支。上游持久化机制仍在受控诊断，未宣称已修或并发超额。保留完整 g03 日志 SHA256 `58fae5650bc241bb6c410151eac995f847bad422ad3deaf7253c3a6cc32a75dd`。
- 清理：`t8-g04-post-failed-gate-identity-cleanup` exit0；新普通 E2E 的 Java/Node/native、准确容器/卷均不存在，停机 ledger integrity_check=ok，原 H2/SQLite 保留。源码未改、未再次全量、不扩大为第二次宽审；下一步以具体根因和权限边界决定，不以固定等待、提高超时或删除失败测试收尾。
- 过程：T2 材料元数据保护、T5 暂停来源投影、T6 代理配置禁用、T7 授权资格四处人类专项接受的顺序偏差及后验/独审分别保留，不包装成先红，也不外推为新缺陷例外。47项裁决与错误代价在专属 SDD `rulings-through-t8.md`（第47项仅准许修正失效对照后的有界诊断实验，不授权产品修复），最终交接仍须逐项给用户。
- 权限：全部产品工作仍未提交、未暂存、未合并、未推送、未发布；main 未变。本轮不创建真实计划、不启动高负载或未来 B。

## 阶段最终回执（2026-10-30）

T1–T8 的阶段实现、独立审核、必要行为验证、实际页面和同候选制品验收完成。上节“未完成”保留原检查点及锚点；以下 supersede 其当前状态，不把后来的成功倒写为早先一次全绿。当前仍无提交、暂存、合并、推送或发布授权。

### 范围和验收

- 内嵌 A、共享触发权威、既有 Job/Core、固定快照/材料版本、UTC 水位与代次、队列/错过/重叠、独立授权、通知/outbox、安全 Webhook、客户端和管理台均按批准范围交付。未来 B 只留替换接缝，不实现服务/网络协议或不可用按钮；F7b 三项仍排 F7g 后。
- AC1–9 使用原真实进程集中联验、真 DB/网络测试和原生/HTTP 页面的分层证据。精确映射为专属 SDD `task-8-report.md` §4/§5、`final-fix-root-ui.md` 与 `completion-audit.md`；不称每次都重跑全矩阵。旧 B12 的 11 个业务断言通过但 afterAll 失败仍为 exit1；后续恢复/清理与受影响补验各自记账。旧六张重复截图仍无效，最终九张唯一截图已实际核读并独审。
- 唯一整分支独审原 I1–I6/Q1 经一轮统一修复与定向复审全部关闭；全量后新 H2 持久化问题另获人类批准，任务独审 I1/I2 修正后关闭；最后旧清理任务测试的有界修正经新的任务级规格/质量独审通过，无新增阻塞项。不重复进行整分支宽审。
- H2 安全物理初始化归一为 `WRITE_DELAY=0`，拒绝未支持的初始化/检测 SQL；有 25 项真实生命周期保护及 2 项既有重启回归。真实 ACK 后突然停止/同库重启使用原 Job39/ex40，报告 SHA/5196B 不变、目标调用一次，最终释放/归档正常。同步 I/O 和不支持自定义 SQL 的限制已载入部署说明；不承诺硬件/断电绝对耐久。

### 实际命令、结果与边界

命令均记录完整 executable/argv、cwd、HEAD/dirty 源身份、起止和退出码，日志及 metadata 位于专属 SDD `logs/`。Node22.19.0、pnpm11.21.0、JDK21.0.12、Maven wrapper3.9.9。实际命令原文及每包计数见 `root-gate-report.md`，不是把下表各次结果拼成一个命令。

| 命令/回执 | 实际结果 |
| --- | --- |
| `t8-g01-frozen-install` / `t8-g02-toolchain-and-identity` | frozen-lockfile 安装、工具链和原候选身份均 exit0 |
| `t8-g03-root-full-gate` | 首次根 `scripts/test-all.ps1` exit1；到达的3540通过/1失败/13跳过；CLI/最后Java未跑到。H2 ACK 状态丢失根因及有界修复另留证据 |
| `gate-root03-fixed-server-image` / `gate-root04-fixed-server-smoke` | 新服务器镜像构建 exit0；真实 API ping ok/console200；全部11 Docker命令0，容器/卷清理确认 |
| `gate-root07-additional-full-gate` | 经批准的追加根全量 exit1；构建/类型/生成契约/品牌门通过，全部7包3736通过/13私有验收跳过，含真实普通E2E和Windows包内worker；Java923运行/922通过/1旧断言失败 |
| `retention-t01-focused-class` / `retention-t02-wrapper-aware-class` | 首次修正的 Spring 包装识别假设失败保留，非产品 RED；精确目标/方法/唯一注册/1234ms修正后单类1/1通过，原行为断言完整保留 |
| `root-gate-retention-test-review.md` | 最小修正规格合规/质量均通过；没有生产修改、删除测试或改产品间隔 |
| `retention-root01-java-full` | 独审后16:04:23–16:06:18（UTC+08:00）执行未筛选 Maven `test`，exit0；62份Surefire XML独立汇总923/0failure/0error/0skip；原日志SHA256 `75de10093d011c17ba5fb6464ca9c3f296d8f6577a85f5caf9445fb8b18ad7a2` |

3736 项前端/Node 没有在最后 Java 补验时重跑；两次全量的 exit1 永久保留，不称单次全量绿色或本轮 CI 通过。最后一次修改仅测试，未改变已经验收的生产输入，不为此重新打包/重做 UI。

### 制品、身份与清理

- 最终运行候选为 `local/f7d-acceptance/root-gate-repair-candidate-fix1-6f08470b/`，不可变 canonical `root-gate-freeze.json` SHA256 `fbd00b04ad9bad76e386193914bbc7d279c80f53a354a042e08cd99c5a7db443`，1196源/144制品。最后测试和本次4份回执文档的差异单列到同目录 `final-stage-receipt.json`；不伪称旧全源清单包含新字节。
- 新服务器镜像 `apicc-f7d-server:root-gate-repair-candidate-fix1-6f08470b` / ID `7df5bc9b06e91d4d6a14f7dc74c00c6857e28aefe02cd71c9eb0b076e9d340b1`；实际镜像JAR SHA `75449aaf47a527501e090296abc99e663468f795fbe1a06aee82827b365677ad`，新私有JAR SHA `395fdde71ed3e50e68b3c2089ba6c439ddfac4f8421643d394ee07c890bd9fae`，分别构建，不冒称同字节。
- 客户端目录包复用 `local/f7d-acceptance/candidate-BrowNN/windows/win-unpacked/apicc.exe`，SHA `3c7e219b28eff21552938edb80cb95d812e459d2c188ca603457ffd5398a7472`；asar SHA `a5a2393b7129ff52d311587c1276855755ef3111eac085e06801ad4dfd99328e`。代理镜像 ID `50edb11c834641998df50eaa648da7a573e92c4afac63725f74ab15148dad995`；输入及制品 raw SHA 确认未变，Core/script API 身份保持一致，未复用过期服务器镜像。
- `gate-root08-post-fullgate-identity`、`gate-root09-post-fullgate-cleanup` 与 `retention-root00-reviewed-inputs` 均 exit0。实际 Java13712→24732、Job39/ex40/报告不变；本轮容器/卷和自有原生/Node/Java进程均不存在，3个包内子进程断开后均退出，停机 ledger integrity_check=ok。所有历史 DB/账本/失败日志保留，最终精确 SHA 与 Java报告索引另入最终回执。

### 剩余项与交接

5组 Minor 继续开放：工具链/日志告警、压缩边界/模板可维护性、包体积告警、管理台成功删除后旧错误提示、预期负向启动栈噪声；不自动归入 F7b 在 F7g 后的三项。T2材料元数据、T5暂停来源、T6代理禁用、T7授权资格四处人类专项接受的顺序偏差及真实后验/独审均保留，不称每分支严格 TDD。

全部51项裁决及错误代价在专属 SDD `rulings-through-t8.md`，最终用户交接逐项列出。完整原始证据与 SDD 保留，不清理未提交工作；main/HEAD `8e2c6f259004ae3e129b4d5c1329e3b2f0012e84` 未变，真实 index 为空。下一阶段 F7e 尚未开工，提交/合并/推送、真实任务及高负载仍须另获明确授权。
