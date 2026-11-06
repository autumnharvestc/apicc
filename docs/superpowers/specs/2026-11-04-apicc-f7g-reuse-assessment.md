# F7g 外部规范同步：现有能力复用评估

日期：2026-11-04。检查基线：本地 main `b31b6b1a06d5b1d0788414e92c39e982b8824b5c`；产品修正基线 `26063656` 的 CI89 五项任务通过。本文记录代码阅读结果，不代表新增同步能力已经实现或测试通过。

用户已确认 F7g 包含 URL／Git 手动同步、在线后台定时检查并生成人工确认的变更，以及 Git HTTPS 和 SSH，并已批准按 [R0 设计](2026-11-04-apicc-f7g-external-sync-design.md)及[整阶段实施计划](../plans/2026-11-04-apicc-f7g-external-sync.md)开工，包含候选分支／PR Windows 打包 CI 调整。

## 1. 复用结论

| 现有能力 | 证据入口 | 复用程度与需要补充的部分 |
| --- | --- | --- |
| OpenAPI 转为 apicc 契约、结构与语义损失诊断 | `packages/core/src/import/contractOpenapi.ts`、`schemaMapping.ts`、`diagnostics.ts` | 复用解析和诊断；当前导入为项目、接口、模型、参数与响应等生成随机 ID，不能把重复导入直接当成稳定同步。需新增外部实体映射和版本化基线。 |
| 导入合并候选、依赖检查 | `packages/core/src/import/merge.ts`、`packages/core/src/assets/context.ts` | 复用资产图、引用校验和候选构造经验；现有合并主要按路由匹配、显式跳过／改名／覆盖，并非三方比较。覆盖保留目标接口 ID 和用例，但会替换契约内部内容；有 Mock 引用时还会拒绝覆盖，不能据此承诺同步已保全全部子实体引用。 |
| 导入预览、计划令牌、上下文过期保护 | `apps/desktop/src/main/ipc.ts`、`renderer/src/stores/importW.ts` | 复用预览与提交分离、禁止迟到结果污染新工作区、提交后刷新失败不重试写入等交互约束；同步候选还需跨重启持久化并绑定来源版本、上游快照、项目版本和映射版本。 |
| 本地写入事务与恢复 | `packages/core/src/storage/writeJournal.ts`、`contractFiles.ts`、`apps/desktop/src/main/session.ts` | 复用写入日志、文件集合与 `expectedRevision` 保护；现有导入撤销句柄保存在主进程内存，且要求当前工作区未变化，不是持久同步历史。需将来源状态、映射、基线、资产变更及回滚记录纳入同一提交。 |
| 在线资产版本、锁与最终授权检查 | `server/.../execution/assets/ProjectAssetsService.java`、`access/AssetMutationGuard.java` | 复用短事务读取、锁外 Core 分类、提交前重读和版本／脚本权限检查。需新增同步来源、候选、回执与历史的事务协调，不能在外部下载或 Core RPC 期间长期持有项目锁。 |
| 单一 Core 与可选私有 Node 运行服务 | `apps/collaboration-runtime/src/protocol.ts`、`handlers.ts`、`server/.../collaboration/runtime/CollaborationRuntimeClient.java` | 复用有限操作白名单、输入／输出摘要、Core 身份、期限和字节边界；现有协议没有同步操作，需要正式扩展。Java 保留授权与持久化职责，不另写一套 OpenAPI 合并内核。 |
| 本机及项目凭据存取 | `packages/core/src/credentials/types.ts`、`server/.../execution/materials/ProjectCredentialStore.java`、`ProjectCredentialService.java` | 复用本机 SecretStore 与服务端加密信封；需补同步用途的授权与解析入口，以及 Git 私钥、口令、已确认主机密钥和 CA 材料。不能伪造测试任务来领取同步凭据，也不能回退成员机器上的同名凭据。 |
| 在线角色、能力与无秘密审计 | `server/.../access/ProjectAccessService.java`、`Capability.java`、`AssetMutationGuard.java` | 复用 F7f 授权机制与原成员生命周期；需要明确来源管理、网络检查、应用和回滚的权限，不能把项目只读权限等同于可使用凭据出站访问。 |
| 定时规则、时钟与触发防重 | `server/.../execution/scheduling/ScheduleRuleCalculator.java`、`ScheduleTimeSource.java`、`EmbeddedScheduleDriver.java`、`ScheduledJobSubmission.java` | 复用规则求值、时钟及触发身份约束；现有提交器绑定测试 Job／执行快照／代理，不能原样塞入规范检查。同步检查需要独立的有界领取、结果与失效代次，不改变旧测试计划语义。 |

表中 `server/.../` 均指 `server/src/main/java/com/autumnharvestc/server/` 下的真实源码位置。

## 2. 本阶段新增的主要交付物

1. 来源绑定、外部实体与 apicc ID 的持久映射、已确认上游基线。
2. 共享 Core 三方比较及引用完整性校验，区分上游变化、本地变化和真正冲突。
3. 有界 URL／Git HTTPS／Git SSH 只读来源适配器，以及可核对的来源版本。
4. 持久候选、版本化决策、幂等应用回执与有条件回滚。
5. 在线后台检查、来源授权失效与取消、检查历史，以及可读的客户端和管理入口。

## 3. 不能直接沿用的捷径

- 定时重复现有导入，会产生新的随机 ID，不能据此保证用例、工作流、模型和响应引用稳定。
- 用当前导入向导的“覆盖”代替三方合并，会混淆本地编辑和上游变化。
- 用内存 undo token 代表跨重启回滚，或回滚时恢复整个旧工作区，会丢失其他编辑。
- 借用任意前后置脚本、成员 SSH 配置或外部仓库钩子抓取来源，会突破本阶段固定只读操作的边界。
- 将同步检查伪装成执行测试计划，会混淆执行权限、代理容量、测试报告和同步审计。

## 4. 本轮工作与验证界限

本轮仅阅读已有源码、路线图、需求池及官方 Git／OpenSSH 文档，并在 R0 确认后编写整阶段实施计划；未启动产品开发、外部仓库抓取、真实账号操作或测试。本地全量及重跑均须先取得用户对本次运行的明确确认。
