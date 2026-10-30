# 服务端定时执行与通知部署使用说明

定时计划由后端扫描，按保存的项目快照提交到既有 Job 流程，指定 Linux 代理执行。客户端关闭不停止已启用计划；重开后通过计划历史查询原 occurrence、Job、execution 和报告。它不是桌面本地定时器，也不承诺硬实时。新计划默认暂停，核对固定定义和预览后再明确启用。

## 部署与持久数据

当前部署支持单实例 H2 文件数据库；`Dockerfile` 和 `deploy/docker-compose.yml` 沿用原部署方式。将数据库与工作区内容持久化，代理 `/data` 必须持久化以保留执行账本。不要让两个 JVM 直接打开同一个 H2 文件。T8 使用的私有 H2 TCP 进程和插入屏障只是故障联验工具，不是新的生产多副本部署方案。

持久 H2 使用同步写入策略：标准 Hikari 在池和 Schema 使用前将物理 URL 的 `WRITE_DELAY` 归一为 0，并在每个新物理连接暴露前执行 `SET WRITE_DELAY 0`。这会增加写盘 I/O；自定义初始化/检测 SQL、URL `INIT` 等未支持组合会明确拒绝启动，检测应使用原生 JDBC `isValid`，即使自定义 `SELECT 1` 也须移除。内存库和非 H2 不套用文件库策略。完整部署限制见[部署说明](deploy.md)，不能据此承诺硬件或断电绝不丢失。

控制服务和代理连接使用 HTTPS；代理配置 `trustedCaFile` 指向批准的私有 CA。Webhook 生产传输使用 JVM 系统默认 TLS 信任配置；由部署者配置批准的 JVM truststore，例如 `-Djavax.net.ssl.trustStore=/run/secrets/webhook-truststore.p12` 与相应类型/受控口令配置。没有页面自定义 CA 开关；不得关闭证书、主机名验证或绕过证书警告。

凭据、附件材料和渠道地址/签名密钥沿用 `apicc.execution.materials.master-key-file`，文件内容为原始 32 字节密钥，不是密码字符串或 Base64 文本。独立挂载并按现有密钥备份策略保管，不能仅备份数据库；密钥缺失或不可读时拒绝使用密文材料，不回退个人凭据。不要把文件内容、渠道完整 URL、HMAC 密钥或业务秘密放入配置示例、普通日志或报告投影。

## 部署参数

实际 Spring 配置前缀是 `apicc.scheduler`、`apicc.notification`，两者拒绝未知字段。以下参数使用 YAML 的 kebab-case；时长单位均为毫秒，字节数为 UTF-8 字节，数量必须是整数。这些是默认策略和上限，不是压测容量。

| 参数（前缀 `apicc.scheduler.`） | 默认值 | 约束 |
| --- | --- | --- |
| `mode` | `embedded` | 仅 `embedded` / `disabled`；`external` 尚不支持 |
| `scan-interval-ms` | 1000 | 100–60000 |
| `claim-lease-ms` | 30000 | 3000–300000，至少为扫描间隔的三倍 |
| `max-schedules` | 10000 | 1–100000，包含暂停但未删除计划 |
| `batch-size` | 50 | 1–1000 |
| `evaluation-max-candidates` | 5000 | 10–100000 |

| 参数（前缀 `apicc.notification.`） | 默认值 | 约束 |
| --- | --- | --- |
| `scan-interval-ms` / `lease-ms` / `concurrency` | 1000 / 30000 / 2 | 100–60000 / 3000–300000 / 1–16；租约严格大于请求总时限加两次扫描间隔 |
| `request-timeout-ms` / `max-attempts` | 5000 / 5 | 1000–30000 / 1–20；次数含首次 |
| `retry-min-ms` / `retry-max-ms` / `jitter-ratio` | 5000 / 300000 / 0.2 | 1000–3600000、min ≤ max；比例 0–1 |
| `delivery-ttl-ms` | 86400000 | 1000–604800000；重试和 Retry-After 不延长总截止 |
| `max-payload-bytes` / `max-response-bytes` | 16384 / 8192 | 1024–65536 / 0–65536；响应有界丢弃，不保存原文 |
| `max-pending-deliveries` | 10000 | 1–100000；满时保留站内失败事实 |
| `allowed-webhook-origins` / `allowed-webhook-cidrs` / `allow-http-origins` | 空集合 | 每次连接前重新核验；HTTP origin 必须同时列在 origins 与 HTTP 许可中 |

示例仅表示配置格式，必须替换为部署批准的出口地址和网段：

```yaml
apicc:
  scheduler:
    mode: embedded
    scan-interval-ms: 1000
    claim-lease-ms: 30000
  notification:
    allowed-webhook-origins: ["https://hooks.example.com"]
    allowed-webhook-cidrs: ["192.0.2.0/24"]
    allow-http-origins: []
```

许可 origin 使用小写 ASCII DNS 名、IPv4 或规范化 IPv6（方括号）；省略默认端口，非默认端口必须精确匹配。例如 `https://hooks.example.com`、`https://hooks.example.com:8443`、`https://[2001:db8::1]`。origin 不含路径、查询、片段或用户信息；完整端点路径/查询仍保存在渠道密文中。当前通知端点不支持 IDN 或 punycode，包括合法国际化域名；这是通知渠道实现边界，不是判定合法 IDN 不安全，也不限制 Core 的普通业务请求。DNS 解析出的地址也须在允许 CIDR 内；重定向不能借原地址许可跳向新地址。

## 管理与客户端配置

工作区管理员在“调度策略”“通知渠道”配置对应范围；项目管理员可进入项目策略与独立调度授权，平台管理员使用调度控制页面。平台身份不自动取得工作区调度权。额度采用适用上限中的最小值，下层不能放宽上级安全规则或最大值；策略表显示默认值、各范围显式值、生效值、来源及版本。空输入不会自动等同恢复继承，恢复继承是独立动作。保存使用 `expectedVersion`，冲突后重新读取权威版本。

| Web / 计划参数 | 默认与范围 | 生效事实 |
| --- | --- | --- |
| `maxSchedules` | 工作区 1000、项目 100；1–100000 | 包含暂停计划；调小不删除存量，超额不可新建 |
| `minIntervalMs` | 60000；1000–86400000 | 新增、更新、启用重检，Cron 精度为秒 |
| `enabled` / `timeZone` | false / Asia/Shanghai | 保存后暂停，时区按 ZoneId 验证 |
| `lateToleranceMs` | 10000；1000–300000 | 不小于有效扫描间隔两倍；判定固定 |
| `misfire` / `catchupWindowMs` | skip / 300000；窗口 1000–86400000 | 默认跳过缺口；显式 catch-up-one 最多补一份 |
| `overlap` | skip | 可选 queue-one；不替换在途执行，不无限积压 |
| `queueTimeoutMs` / `maxQueueTimeoutMs` | 300000 / 3600000；1000–86400000 | 每次新触发按原计划UTC加保存值与当前最大值较小者固定；调低上限也约束旧启用计划的未来触发；已封存截止不改写、重试不续期 |
| `maxPendingDeliveries` | 工作区 1000、项目 100；1–100000 | 新发件箱准入，下级不高于上级 |
| `historyRetentionDays` / `notificationRetentionDays` | 30 / 30；1–3650 | 仅清已结束且无活动/待投递引用详情；防重摘要、水位和 Job 身份保留 |

任务、脚本期限和请求/证据预算继续使用既有执行配置。策略调小不强杀已经开始的任务。规则、快照、主体或材料绑定更新形成新修订，并取消旧修订未提交项；名称或通知渠道编辑不改变运行定义，也不在同一 UTC 时刻生成第二个身份。停用/删除停止新触发，取消未提交等待；已形成 Job 的取消是另一个明确操作。

客户端项目“定时任务”页选择 suite/workflow、指定代理、保存快照、材料策略及规则。编辑项目不自动更换旧定义；使用显式快照刷新检查目标、环境、脚本、数据、材料、网络、运行时七区差异并确认。`current-at-trigger` 每次触发固定实际材料版本；`fixed-version` 要求版本不变。排队后材料或授权撤销仍会在业务请求之前拒绝，不换代理、不使用个人材料。

站内通知与 Webhook 投递分开显示。默认外部事件为 failed、abnormal、expired、paused；成功与跳过需显式选择。渠道默认禁用，不自动发送测试通知；启用后的 keyState=available 只说明材料可读，不代表出口获准或投递成功。禁用渠道的 not-checked 是尚未检查，不能解释为健康；origin 不可用/不支持也会显示具体原因。

## 重启、故障与验收

代理离线时仅在固定排队截止内等待，恢复后沿用原 Job/执行身份；截止后明确过期。后端重启后查询持久状态并对账，提交前事务必须原子回滚，提交后不能重建旧 Job；已经开始的任务只能对账和补传，不能自动重放。通知接收端收到后丢失 ACK 时可能收到相同 eventId 和正文的重复投递，不能因此新增业务 Job 或调用；接收端可按 eventId 去重。

本阶段集中验收入口为 `scripts/f7d-acceptance.mjs`。固定 Node 22.19.0、pnpm 11.21.0、JDK 21，通过阶段 `Invoke-F7dCommand.ps1` 记录完整 argv、cwd、源码身份、时间及退出码；唯一证据目录位于 `local/f7d-acceptance/candidate-*`。脚本使用合成数据、独立数据库/CA/代理账本，停止代理并复制账本后才做只读完整性检查，最终停止所有自有资源。实际包与浏览器的可读性检查另外记录；构建或 DOM 测试不能代替窗口、滚动、关闭重开验收。

T8 的实际验收矩阵、制品 SHA、命令退出码、宽审结论和最终全仓门禁状态以 `.superpowers/sdd/2026-10-29-apicc-f7d-scheduling/task-8-report.md` 为准。未完成项不得从既往 CI 或分段测试推断通过。当前工作不授权提交、真实 staging、合并、推送、发布或创建真实用户任务。

2026-10-30 当前检查点：实际页面、同候选制品和最终修复定向复审已通过；唯一根全量命令 `t8-g03-root-full-gate` exit1，普通代理 E2E 的第二压测任务排队原因断言失败，正在追查前例重启后的旧任务槽残留及持久化疑点。最后 Java 全套与 CLI 测试未跑到，不能据此称阶段/CI完成。门禁前后候选源/制品身份一致且测试资源已清理；完整边界见[实施计划检查点](superpowers/plans/2026-10-29-apicc-f7d-scheduling.md#阶段收尾检查点2026-10-30未完成)及专属 SDD `root-gate-report.md`。本段是状态归档，不修改数据库部署默认值或以等待掩盖未定位问题。

### 最终交付更新（2026-10-30）

上段为首次失败的历史检查点，以下为最终状态。持久化修复已通过真实应用 ACK/突然停止/同库重启回归及独审；同一 Job/execution、报告摘要和长度保留，目标请求只执行一次。受影响服务器镜像已重建并真实冒烟，客户端与代理因输入未变按原 SHA 复用，不把旧服务器镜像冒充新镜像。

追加根全量实际 exit1：前端/Node 3736 通过，13 项显式私有验收按设计跳过，普通真实代理 E2E 与 Windows 包内 worker 分支通过；Java 922 通过、1 项旧测试错误地要求不同定时器采用同一间隔。仅修正测试的清理任务目标/方法/唯一注册和 1234 ms 校验，保留全部真实清理、ACK、意图和保留期断言，经独审后运行未筛选 Java 全套，923 通过、0 失败/错误/跳过。原两次全量失败与补验分别留存，不称单次全绿或 CI 通过。

阶段实现与必要验收完成；完整 [最终回执](superpowers/plans/2026-10-29-apicc-f7d-scheduling.md#阶段最终回执2026-10-30)记录 AC1–9 分层证据、制品、命令、清理、5 组非阻塞项和 51 项裁决。最终测试/文档字节与不可变运行制品清单分开归档在工作树 `local/f7d-acceptance/root-gate-repair-candidate-fix1-6f08470b/final-stage-receipt.json`。本轮没有提交/合并/推送授权，未发布或操作真实任务。
