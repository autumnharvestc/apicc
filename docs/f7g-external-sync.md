# 外部规范同步：来源、检查、人工应用与回滚

本地与在线项目可绑定 URL、Git HTTPS、Git SSH 的单个 OpenAPI 文件。检查通过共用 Core 建立稳定实体对应、固定三方候选与业务摘要；只有明确选择并应用才修改资产。在线计划只检查和生成候选，桌面关闭不影响服务端调度。普通一次性导入保持原有行为。

## 使用与诊断

在项目同步页面选择来源类型、目标模块、地址和材料引用。Git 还需明确 ref 与文件路径；不支持写入远端、任意脚本、Git LFS、多文件或远程 `$ref` 自动遍历。来源只保存引用；私钥、口令、请求头和网络材料由当前宿主的项目材料服务取得。在线缺材料不会回退到同名本机凭据。

先检查，再阅读基线 B、当前 L、来源 R 的有界业务摘要、冲突和引用影响。固定资产文档按需展开，显示字节数与完整 SHA-256；它是固定一侧的完整业务资产文档，不是实时内容或只有某字段的片段。预算不足会明确拒绝全文读取，不返回伪空文档。过期候选可以查看原因，不能应用。

逐项选择采用来源、保留当前或明确映射，再显式应用。响应丢失或状态未知时，用原 intent 查询回执；404 本身不证明没有提交，不自动重放写入。成功回执及历史持久保存，重开后可选择历史执行回滚；回滚仍检查当前资产、权限、映射和完整性。

来源保存不等于已授权定时检查。启用计划需当前操作者显式授权；修改已启用来源前先关闭计划，再重新授权。UTC 发生身份在重启后保留；重复扫描不重复创建同次检查。撤权、暂停、过期、缺材料和容量不足均按实际原因说明，不自动应用或静默补跑业务。

## 默认值与单位

| 配置 | 默认 | 合法范围 |
| --- | --- | --- |
| 计划 | 关闭；启用预填每小时 / UTC | 最小间隔 60 秒 |
| 连接 / URL 总期限 / Git 总期限 | 10 / 60 / 120 秒 | 1–60 / 5–600 / 10–1800 秒 |
| 总尝试 | 1 次 | 1–3 次 |
| 原文 | 5 MiB | 64 KiB–16 MiB |
| 比较输入 / 输出 | 16 / 8 MiB | 1–64 MiB / 256 KiB–32 MiB |
| 规范化深度 / 节点 | 128 / 100000 | 16–256 / 1000–1000000 |
| Git 采样磁盘阈值 | 256 MiB | 32 MiB–2 GiB |
| 项目 / 宿主并发 | 1 / 4 | 1–4 / 1–16 |
| 候选有效期 | 24 小时 | 5 分钟–7 天 |
| 每来源历史内容 | 30 天 / 100 条 | 1–365 天 / 1–1000 条 |

工作区和项目保存覆盖只在下一轮检查生效，页面逐字段显示默认、显式覆盖、继承、部署上限、有效来源与修订。项目不能放大上级限制，非法组合保存时拒绝。项目与宿主另有内容总字节额度；轻量幂等回执与大块历史内容保留不是同一项。规范化限制与采样阈值均不承诺解析器内存或磁盘零超量硬保证。

## 私有运行宿主部署

默认 [Compose](../deploy/docker-compose.yml) 仍只启动 Java。协作运行层沿 [既有说明](f7f-collaboration.md) 显式启用；来源获取再叠加 [来源 overlay](../deploy/docker-compose.synchronization.yml)。RPC 只在内部网络，无宿主发布端口；保留非 root、init、只读根文件系统、无新增权限和 CPU / 内存限制。

运行镜像包含 execution 的实际构建闭包、Git、OpenSSH 和系统 CA。工具绝对路径只来自可信部署配置，项目 DTO 不能选可执行文件或私有目录。复制 [配置样例](../deploy/collaboration-source.example.json)，只批准所需的精确 origin 与目的 CIDR；默认两者均空，拒绝来源出网。专用出网网络提供传输能力，应用批准仍同时生效；RPC 私网不因此公开。

来源临时材料、对象库和桥接器在 `/var/lib/apicc-sources` 的私有 tmpfs；不进入普通契约分享、执行快照或发布副本。固定自有 SSH bridge / askpass 需要显式 `exec` 挂载，保留 `nosuid,nodev,uid=1000,gid=1000,mode=0700`；只省略 `noexec` 仍可能继承 Docker 的默认 `noexec`。不确定占用不自动清空或假装回收；先停止并核实真实进程生命周期，再由部署者处理保留现场。

受支持拓扑为单个 Node 进程独占同一物理 `privateRoot`，不能跨进程或副本共享该根；现有协调不是分布式锁，未知占用没有自动 reaper，须证明真实收束后人工处理。

tmpfs 实际计入容器内存。来源部署必须明确区分三个数值：既有应用预算分区、私有 tmpfs 容量、实际 cgroup 总内存。例如应用 `805306368` 字节、tmpfs `536870912` 字节，容器至少 `1342177280` 字节；较大的外部内存上限没有扩大既有 RPC 可用预算。以下命令中的既有在途与余量也必须按协作说明显式设置：

```powershell
$env:APICC_COLLABORATION_IN_FLIGHT_BYTES='134217728'
$env:APICC_COLLABORATION_HEADROOM_BYTES='201326592'
$env:APICC_SYNC_PRIVATE_TMPFS_BYTES='536870912'
$env:APICC_SYNC_RUNTIME_MEMORY_BYTES='1342177280'
$env:APICC_COLLABORATION_SOURCE_CONFIG_FILE='C:/deployment/owned-source-config.json'
node scripts/check-source-deployment.mjs -f deploy/docker-compose.yml -f deploy/docker-compose.collaboration.yml -f deploy/docker-compose.synchronization.yml --profile collaboration --up
```

同一启动入口和部署冒烟都先检查真实渲染后的 Compose 容量及挂载边界。该算术检查不保证任意输入吞吐或整个进程 RSS；真实运行还受内存、tmpfs 硬限与其他部署配额约束。tmpfs 是临时空间，重建后不保留对象；应用历史在 Java 受保护存储中持久化。

私有 CA、SSH known-host 权威只作用于项目材料与隔离进程。保持证书链、SAN、主机钥核对；不关闭 TLS、不修改系统全局信任。缺少已安装工具须明确诊断，不自动下载工具安装器。

## 验证与交付边界

Linux 两个全新 CI 作业各自准备受版本控制的 Git / SSH 合成夹具并检查同步 wire。Windows 打包冒烟随候选分支、PR 和 main 的既有工作流触发，实际包探测物理 helper 与真实子进程收束；它不依赖 Windows runner 提供 Linux Docker daemon。

定向入口为 `scripts/tests/f7g-acceptance.test.mjs`、`scripts/tests/ci-stage.test.mjs`、桌面 `tests/main/sync/f7g-acceptance.test.ts` 和 `node scripts/smoke-synchronization.mjs`。部署冒烟宿主仅依赖 Node 内建模块与 Docker，支持没有 pnpm install 的实际部署作业。`--keep` 保留同一合成服务供集中原生 / 浏览器验收，直到回执列出的停止文件出现；只清理本次拥有的容器、卷和进程。

这些命名验证不等于完整本地 CI。每次全量须用户另行明确确认；Git 提交、合并、推送和远端 CI 同样按当次授权。真实视觉验收由集中原生与浏览器检查记录，不用 DOM 或构建结果替代。实际候选、产物与结果见 [2026-11-06 回执](f7g-acceptance-20261106.md)。[F7f 已知风险](f7f-known-risks.md)、F7b 三项后续工作及其余延期继续保留。
