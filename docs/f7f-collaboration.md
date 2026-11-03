# 项目历史、固定分享与共享 Mock

本阶段交付及验证边界见[F7f交付回执](f7f-acceptance-20261103.md)；另有用户确认接受的[两项未定因门禁风险](f7f-known-risks.md)，不等于已修复或保证下一次CI不再触发。

协作服务是可选部署。原来的 Java 管理服务、客户端本地执行和独立代理继续使用各自入口；不启用协作不会自动上传历史、开放外链或启用共享 Mock。Node 协作宿主只承载有限 Core 投影/静态 Mock，不持有代理令牌、控制身份、用户项目目录或任意目标请求能力。

## 使用与权限

客户端先选择一个已保存来源，预览明确列出范围、来源、遮罩、缺失和预算限制；确认后才上传/保存该单项。未选择项不会被遍历上传。报告分为“服务端代理归档”和“成员声明”；成员上传的本机结果不能变成代理执行事实。发布绑定完整来源版本和摘要；编辑项目不会改变已发布副本。同一发布意图重复提交只对账原结果，不能用新的候选替换旧意图。

真实代理归档保留完整原档的哈希和执行/项目/代理来源。Core 对现有 suite、workflow、debug、stress 及带有效 RunResult 的 failure 输出做有限严格归一；裸旧报告仍兼容，没有有效输出或不支持的格式明确失败，不补造历史 ID、时间或统计。共享历史正文与发布预览使用同一个 Core 入口。摘要分别展示执行结论、执行事实和内层报告结论；取消、超时、中断等外层非通过状态不会因内层样本通过而变成通过，内层计数仍保留原值。任意执行原因原文不进入公开摘要，显示不支持的限制并留在受控原档中；PID、原执行 ID 和进程观测不复制到公开正文。

角色、项目 ACL 和业务权限同时生效。项目 `NONE` 拒绝内容、凭据和执行；管理目录可显示该项目并不授予内容权。OWNER 的转移仍走原成员接口与双方修订校验，不存在备用提权入口。CLI/MCP 使用同一服务端权威，本机界面是否显示按钮不是授权边界。

升级采用成员生命周期 A：保留旧角色/ACL 存储，但旧非成员 ACL 仅为待确认预设；成员移除后原显式 allow 失效，显式 deny 保守保留。重新加入不会自动恢复旧 allow/外链，项目 override 必须由当前有权管理员确认新角色或确认继承。`NONE` 不因重入、升级或关闭账号自动变为继承。账号停用不等于移除成员；停用/恢复也不会恢复旧责任授权。

能力默认值按项目→工作区→内建角色解析；显式成员 deny 优先于任何下级 allow，allow 不能越过当前账号、成员关系、角色底线和 NONE。功能允许开关/额度另取部署、工作区、项目的交集。范围默认策略不是额外硬上限，也不会自动对所有成员写一份授权。

权限更新使用同一单调修订域：旧 member/ACL 与新 access-members 接口共用修订，删除后不重置。新建从0开始；修订为0–9007199254740991的 JSON 整数，实体 ID 为字符串。缺失/非法值返回400，过时修订返回409，先刷新当前状态再让用户重新确认，不能盲重试。OWNER 转移还需当前操作者修订；账号 enable/disable 则用独立 account-state 修订（初始1），不混用成员修订。角色/能力部分更新省略键保持原值，显式 inherit 只删除本地覆盖。权限冲突、不可用和结果回包丢失分别说明；回包丢失按原 intent 查询对账，绝不自动重复发布/执行。

## 分享、下载与 Mock

成员定位链接不授予陌生人权限。外部分享须部署/工作区/项目全部允许、公开 origin 就绪且发布者明确选择；文档 key、Mock key 和项目/版本互不通用。密钥仅在创建/轮换成功时回包，管理列表不保存可再次取回的明文。回包丢失先查 intent；需要转发时显式轮换，旧 key 随即失效。管理员接管是显式新授权，不复活旧链接。

撤销、到期、关开关、策略收紧或责任人失权后，下一次内容读取/下载拒绝。重入、重新授权和扩容不会恢复旧 key 或延长 expiresAt。下载或手工复制后的内容无法远程收回；界面必须保留这项提示。

公开读取与 `/download` 每次独立校验当前授权。下载 HTTP 附件仍是安全 DTO JSON，只有 viewer 完成新的下载鉴权后才调用 Core 生成无 key 的 `apicc-publication.html`。文件没有网络或脚本，通过 CSS 单选切换中英文。源/副本预算分别保护读取/保存，RPC 预算保护完整封装线路；HTML 额外复用既有 schema 的32 MiB硬上限，转义展开后超限会拒绝文件生成而不截断原事实。生成/浏览器保存失败时保留本次新鉴权事实并提示下一步，不声称已下载成功。

共享 Mock 与本地 Mock 共用 Core 规则；只支持已编译有限静态响应，不是接口代理、录制、脚本执行或任意上游 URL。敏感/控制头条件在预览中明确拒绝，不静默改写规则。关闭发布客户端或代理离线不影响独立共享服务；Mock 调用者自己的连接断开则取消该请求，保持其资源所有权直到实际收束。Node 中断/错版本/错秘密明确不可用，不重发旧业务调用；恢复后只有新的调用可加载固定计划。关闭发布不等于伪造已完成，排空/活动数反映当前收束状态。

公开 listener 采用 HttpCore async；关闭整个连接或输入 EOF 会取消待响应调用，不支持发送完请求后故意 TCP 输入半关闭而继续等待响应。已提交 HTTP200 后发生截止可能表现为连接截断，不能再给同一响应发送一个408；逻辑 deadline 记录不等于客户端收到了第二个状态码。

标准浏览器 OPTIONS 不含 Mock key。平台精确 origin 上限允许一个与资源是否存在无关、受现有限速/在途/字节限制的握手；它不读取授权/项目、不执行 Node、不写命中日志。实际业务请求仍独立核对 key、当前项目策略和 origin。没有 Cookie 凭据共享、通配来源或免 key 业务入口。

审计同事务保存权限/发布/密钥绑定来源及有限 ID/修订，不记录秘密正文。Mock 调用权不能读取管理审计/命中明细。0日志留存为关闭，不等于“没有发生请求”；有界丢旧、观测缺失、旧版未索引和任务尚未结束分别显示。旧终态任务没有 terminal_conclusion 时保留未知与原摘要，不根据私有包推断回填。

公共查看／下载在每次新鉴权后记录有限访问观测：仅范围、固定副本 ID、时间和有限动作／结果；匿名密钥持有者的操作者为实际空值，不冒充授权责任成员。不记录密钥、URL、路径、来源正文或响应正文，Mock 命中仍使用独立的原有明细。访问观测复用原协作审计 feed 与 `audit.read`，同样计入 AUDIT 和全局存储（包括既有释放预留）；额度或写入故障只造成观测缺失，不改变已获准读取结果。访问留存为0只关闭／清理访问明细，不关闭管理审计。界面区分有限留存、关闭和本服务启动以来的全局观测缺失；均不代表完整访问次数或精确丢失数。

生产清理在既有 TaskScheduler 上拥有单一可停止生命周期回调：以既有清理间隔最小值进行有限范围发现，按账户键集游标轮转，每次最多发现平台有效 `cleanupBatchSize` 个范围，各范围仍按自己的有效 `cleanupIntervalMs` 与 `cleanupBatchSize` 执行。不是一次物化所有项目或无限排队，也不承诺所有项目恰在间隔时刻完成清理。上次清理时间与该范围清理事务一同保存；活跃引用／候选／读取的已有保护继续生效，停用生命周期取消所属回调并等待本次回调结束。数据库升级以幂等列默认将旧协作审计保留类别定为 management；不修改旧权限审计域或对象的已预留释放帧。

## 配置与生效

Web 管理页显示保存值、有效值、来源、单位、范围和影响；部署地址、秘密和硬资源由运维配置，不能从业务表单更改。外部允许下级不能扩大，额度越界/跨字段非法组合拒绝而不静默改小。计费涵盖成员上传、预览、安全副本、计划、操作回执和有界日志；清理保护有效授权、候选和活动引用。

| 配置 | 默认 | 范围 / 生效 |
| --- | --- | --- |
| 外部分享 / 历史发布 / Mock / 下载 | 关 / 开 / 关 / 关 | 分享三层允许；不自动上传或开启对象；关闭阻止后续访问 |
| 分享期限 默认 / 最大 | 7天 / 90天 | 单次≥1分钟；部署最大1分钟–365天；默认≤最大；创建时固定，缩小可暂停超限授权，扩容不延长旧授权 |
| 预览期限 / 待确认数 | 10分钟；个人5/项目20/全站100 | 1–60分钟；各1–1000；新预览按当前权限/额度，提交取消释放 |
| 发布总期限 | 60秒 | 5–300秒，含固定读取/Core/保存，超时不自动重发 |
| 单源 / 单副本 | 16 MiB / 8 MiB | 源1–64 MiB；副本64 KiB–32 MiB；实际 UTF-8/二进制字节分别检查 |
| 额外证据 / 字段 / 报告 | 不含；8 KiB / 1 MiB | 字段256 B–64 KiB；报告4 KiB–8 MiB；字段≤报告≤副本；布尔允许仍需单次确认 |
| 项目版本数 / 存储 | 1000 / 256 MiB | 1–100000 / 8 MiB–10 GiB；原子计费，满额拒绝，不淘汰有效分享 |
| 有效外部授权 项目 / 全站 | 100 / 1000 | 1–10000 / 1–100000；创建/轮换时当前限制 |
| 非活动副本 / 成员历史 | 30天；30天/1000条 | 各1–365天；成员记录1–100000；无引用后清理，不随源历史一起误删副本 |
| 分页 默认 / 最大 | 50 / 200 | 1–200，默认≤最大，稳定游标，无无限列表 |
| 公共读取 每授权速率 / 在途 | 10次/秒 / 8 | 1–1000次/秒 / 1–256；无突发补偿，受全站余量 |
| Mock 每项目速率 / 在途 | 20次/秒 / 16 | 1–1000次/秒 / 1–256；不是吞吐承诺 |
| 公共读取、Mock各全站速率 / 在途 | 各100次/秒 / 64 | 1–10000次/秒 / 1–1024；分别取全局/项目交集 |
| Mock 请求 / 响应 | 各1 MiB | 各1 KiB–8 MiB，头/正文有界；受总在途保护 |
| Mock 最大延时 / 调用期限 | 30秒 / 35秒 | 延时0–30秒（Core硬限）；期限1–120秒，须大于启用规则延时并留处理余量 |
| Mock 日志数 / 保留 | 每版本200 / 24小时 | 0–10000 / 1小时–30天；0关闭命中留存 |
| 额外敏感规则 / CORS | 空 / 空 | 0–200项、每项≤256字符；字段名/JSON Pointer，无任意 regex；CORS 0–50个精确 origin、每项≤512字符，无通配/口令 |
| 管理 / 访问审计 | 90天 / 7天 | 7–3650天 / 0–90天；访问0关闭明细，必要管理审计不能随意关闭 |
| 清理批次 / 间隔 | 100 / 1小时 | 1–1000 / 1分钟–24小时；新周期生效，保护有效引用 |
| 全站存储 | 1 GiB | 64 MiB–100 GiB，含上述所有计费对象 |
| RPC 连接 / 普通调用 | 3秒 / 10秒 | 0.1–30秒 / 1–300秒；不超过所属操作剩余期限；Mock单独预算 |
| Node缓存 / 完整RPC消息 | 64 MiB / 32 MiB | 8 MiB–1 GiB / 1–128 MiB；消息含 JSON/base64 与成功封装，不只计算 payload |
| 外部CPU / 总内存 / Node old-space | 建议1 vCPU / 768 MiB / 384 MiB | CPU0.25–8（可小数）；RSS256 MiB–8 GiB；old-space128 MiB–4 GiB；部署重启生效 |

除CPU外数值用整数/毫秒。完整配置及依据见[批准设计§9](superpowers/specs/2026-11-01-apicc-f7f-collaboration-design.md#9-配置默认值和生效)。这些是保护范围，不是容量保证。

## 本机 Java-only 与双 origin

Java-only 仍可单独 `java -jar server/target/apicc-server-*.jar`，两个协作开关默认false，不读取秘密、不打开公开端口。管理台静态资源仍按原 console-dir 安装。启用 public 页面时先构建 Core/runtime（生成契约检查）及 viewer，再安装独立目录：

```powershell
pnpm -C packages/plugin-sdk build
pnpm -C packages/core build
pnpm -C packages/execution build
pnpm -C apps/collaboration-runtime build
node apps/collaboration-runtime/scripts/generate-java-boundary.mjs --check
pnpm -C apps/share-viewer build
node scripts/assemble-share-viewer.mjs ./share-viewer
$env:APICC_SHARE_VIEWER_DIR = (Resolve-Path ./share-viewer).Path
$env:APICC_COLLABORATION_PUBLIC_ENABLED = 'true'
$env:APICC_COLLABORATION_PUBLIC_BIND_ADDRESS = '127.0.0.1'
$env:APICC_COLLABORATION_PUBLIC_PORT = '9081'
$env:APICC_COLLABORATION_PUBLIC_BASE_URL = 'http://127.0.0.1:9081'
java -jar server/target/apicc-server-0.1.0-SNAPSHOT.jar --server.address=127.0.0.1 --server.port=8080
```

9081仅为示例端口，必须与管理8080不同且可绑定；0表示实际随机监听，但对外 base URL仍需与实际可达 origin一致。HTTP仅接受 loopback公开origin及loopback绑定，且端口不同。`host.docker.internal` 不是自动允许的 HTTP public origin。远程部署使用不同 HTTPS公开/管理origin并显式配置 `APICC_COLLABORATION_MANAGEMENT_BASE_URL`；反向代理转发到内部 listener。请求Host/Forwarded头不能提供授权 origin。保留证书/SAN校验，不修改系统CA或关闭TLS校验。

外置 viewer 使用 `apicc.collaboration.public-access.viewer-dir` / `APICC_SHARE_VIEWER_DIR`，默认 `./share-viewer`；只安装 `index.html`、`viewer.js`、`viewer.css`。不能放进console SPA目录，没有Maven前端下载、classpath或管理bundle回退。缺固定资源503 `share_viewer_unavailable`。管理origin先拒绝public路径；公开origin只提供固定viewer及独立授权数据，不能读取管理身份/API。

## 可选 Docker 组合与真实预算

默认命令 `docker compose -f deploy/docker-compose.yml up -d --build` 继续只启动Java服务。可选组合另加overlay和profile。为两侧准备同一个独立RPC秘密文件：去除文件外围ASCII空白后至少32字符，内部只允许可打印ASCII 0x20–0x7E；末尾换行允许，多行/Tab/NUL/非ASCII拒绝。推荐随机hex/base64url。它不是成员key、外链key、材料主密钥或agent token；不要复用。

以下是操作者明确选择的示例，并非新增默认：总内存768 MiB，old-space384 MiB，cache64 MiB，在途线路128 MiB，剩余192 MiB为宿主余量。两侧使用相同字节值；overlay要求显式填写在途和余量，未填写即配置失败，原Java-only不受影响。

```powershell
$env:APICC_COLLABORATION_SECRET_FILE = 'C:/private/apicc/collaboration-rpc'
$env:APICC_COLLABORATION_CPU_VCPU = '1'
$env:APICC_COLLABORATION_MEMORY_BYTES = '805306368'
$env:APICC_COLLABORATION_HEAP_BYTES = '402653184'
$env:APICC_COLLABORATION_CACHE_BYTES = '67108864'
$env:APICC_COLLABORATION_IN_FLIGHT_BYTES = '134217728'
$env:APICC_COLLABORATION_HEADROOM_BYTES = '201326592'
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.collaboration.yml --profile collaboration up -d --build
```

RPC没有host端口，Node仅接内部网络。secret为只读挂载，Node非root、只读根文件系统、丢弃capabilities并禁止提权，Compose实际施加CPU/RSS限额；绝不挂agent token。公开listener默认仍关闭；远程公开入口另显式配置合法不同HTTPS origin/端口和代理，不能把HTTP绑定规则放宽来图省事。

Java部署字段为 `apicc.collaboration.policy.resources.{cpu-vcpu,total-memory-bytes,node-heap-bytes,in-flight-bytes,headroom-bytes}` 和 `policy.deployment.node-cache-bytes`；Node别名为 `APICC_COLLABORATION_RUNTIME_{HEAP_BYTES,TOTAL_MEMORY_BYTES,IN_FLIGHT_BYTES,HEADROOM_BYTES,CACHE_BYTES}`。原RPC env还包括 `ENABLED/BASE_URL`（Java）、`HOST/PORT`（Node）、`SECRET_FILE/MAX_WIRE_BYTES`。RPC连接/普通/Mock调用配置分别 `apicc.collaboration.runtime.{connect-timeout-ms,call-timeout-ms,mock-timeout-ms}`。

Node在认证和固定路由通过后、读取正文前，以2×maxWireBytes保守预留请求与响应线路缓冲。余额不足返回已有429 `RPC_BUSY`，不会排队补发；显式0即零容量，未设置仍显示“未配置”。预留直至handler/读取收束且响应真实finish或close，取消意图不能提前释放。count64上限同时存在，字节预算可令实际准入数更少；上述示例32 MiB消息最多允许2个完整双向预留。

这是线路缓冲预算，不是解析对象/进程内存的精确计量，也不保证免于OOM。完整组校验 `heap + cache + inflight + headroom ≤ totalMemory`。Node old-space参数将字节向下取整为MiB；old-space384 MiB不等于V8总heap上限（Windows Node22.19.0曾观测432 MiB，Linux镜像同参数观测396 MiB，以实际平台为准），更不等于RSS。其余开销由余量和外部容器硬限保护。只写Java声明不证明Node健康；页面external-unverified保持真实，需启动/容器inspect/行为证据验证applied。未配置外部RSS硬限时不得声称已限制总RSS。

私网POST `/rpc` 使用严格有限操作/协议1及 `sha256-json-tree-v1` 树摘要。该摘要是传输身份，不是发布内容/存储哈希；实际wire长度另算。Core实际JS身份和生成schema由 `node apps/collaboration-runtime/scripts/generate-java-boundary.mjs --check` 校验，变更后通过同生成器刷新并评审，不能改期望常量绕过。RPC地址固定、拒绝重定向、总期限有界；错误秘密/协议/Node断开只给稳定不可用，不静默回落到本机、代理或真实接口。

## 备份、升级、恢复与验收边界

暂停新任务/发布并等待已拥有请求和代理执行收束，确认报告归档和子进程退出，再停Java/Node并备份完整H2数据卷、代理账本以及独立材料主密钥/部署RPC秘密（密钥与数据分开存取）。不要只备份发布正文：副本、引用、额度、授权哈希、撤销、固定expiresAt、回执和审计都必须与元数据一致。Node缓存是可重建的，不是权威备份。

恢复匹配程序与整份停写快照及其独立密钥；验证旧授权仍撤销、到期时刻未延长、正文关联/计费一致，之后才开放写入。H2仍单副本，不让两实例同时写同一卷。DDL幂等不等于任意旧库自动兼容，旧不兼容主键布局需先核对版本并保留旧卷供回退；不以删卷作为升级操作。恢复的旧下载文件无法收回，备份访问同样需受控。

自动合成集中入口为 `node scripts/f7f-acceptance.mjs --mode=synthetic --evidence-root=local/f7f-acceptance`。只允许synthetic，非法mode在启动任何资源前稳定 `SYNTHETIC_ONLY` 失败。固定工具链Node22.19.0/pnpm11.21.0/Java21、已构建Core/execution/runtime/viewer/agent/desktop是明确前提，缺失不能打印组合通过。脚本保留源码/产物身份、真实进程/端口、命令退出、owning XML和清理事实；结果中的视觉/原生/CSP/最终全量pending不能用HTTP200、DOM或build替代。

阶段交付不表示Git提交/合并/推送或远程CI通过。本阶段未包含F7g、团队AI/AI-FUTURE-001–005、调度B、到达率B、分布式压测/DEF-001、多副本HA或高负载/24小时长稳。F7b的EXECUTION-LOW-001/002/003仍在F7g之后；新分享生命周期保护不宣称修复旧报告下载到期并发缺陷。
