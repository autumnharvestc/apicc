# 独立执行代理

生产入口为 `node dist/main.js <部署配置绝对路径>`，需要 Node 22.19.0 和已构建的同一 Core/execution 实现。配置包含规范 HTTPS `/api/v1` 地址、代理实体 ID、受限身份文件和独立持久数据目录；可选可信 CA 和引导配置。身份文件、数据目录仅授予代理服务账号访问。控制 token、凭据、私钥和 Cookie 不写入执行账本。不要将身份文件放进普通待传区或日志目录。

`dataDirectory` 必须是本机支持 SQLite 文件锁及持久事务的独立数据卷。启动时在 `execution-owner.sqlite` 持有独占事务，第二个宿主会拒绝启动；正常退出和异常进程退出由 SQLite/操作系统释放锁，不按历史 PID 清锁或杀进程。`execution-ledger.sqlite` 绑定规范服务端地址及代理身份，不允许另一部署接管。启动失败不会退回内存模式。迁移、备份及删除目录前必须停止该代理；运行中备份请使用 SQLite backup，而非普通文件复制。

`execution-children.sqlite` 另外保存宿主 epoch。子进程在 ready/业务执行前核对 epoch，并持有共享读事务直到 OS 退出；新宿主必须以独占事务更新 epoch，旧子进程仍活时会拒绝启动并保留旧账。旧 epoch 的迟到 initialize 也会拒绝。该库必须保持 DELETE journal，不能自行切为 WAL。父进程正常监督仍等待真实 ChildProcess exit，不以租约替代退出事件。异常重启被旧子进程阻挡时，让服务管理器在旧进程已退出后重新启动，不能按 PID 猜测清除锁或直接删除数据文件。

账本保存执行身份、接收命令的身份、稳定控制消息以及同一 Core 投影后的有界结果字节。开始派发前记录“无法确定”，子进程进入执行边界后记录“已开始”；尚未派发则为“确定未开始”。重启后，未完成记录分别以 `execution-start-unconfirmed`、`agent-restarted-after-start`、`agent-restarted-before-start` 标记中断，恢复不会重建 JS 内存、Cookie 或重发目标请求。已完成结果按原字节及摘要补传，只有 `archived=true` 且摘要、字节数完全匹配才解除待传预算。控制完成 ACK 与结果归档 ACK 是两件事；未归档结果不按普通保留期删除。

待传预留达到容量、持久化失败或真实可用磁盘不足时停止新准入。写事务还复查最小磁盘余量、在途已承诺空间、SQLite 回滚日志和数据库增长空间。已有记录不会因配置调小而删除。任务资源收束后可释放执行槽，未归档结果继续占用结果预算。失败报告不代表能够断言已执行了多少次目标请求；没有 Core 结果时保持请求事实未知，不把中断标成通过。

## Linux 服务及退出

容器中以 init 管理进程组，例如将最终启动命令配置为：

```sh
tini -g -- node /opt/apicc/apps/runner-agent/dist/main.js /run/apicc/deployment.json
```

采用 Docker 内置 init 时可使用 `docker run --init`，并确保编排器将停止信号交给 Node 主进程。所有执行子进程沿用该服务进程组，不分离成后台服务。停止宽限应覆盖实际配置的任务取消宽限及 worker 退出等待；到期后的容器强制停止应作用于整个容器。不可只停止父进程而把子进程留在独立宿主服务中。

主进程收到 SIGTERM/SIGINT 后先停止新准入，对每个调用发送 Core Abort，在固定取消宽限后仍不能收束的 worker 会被终止，并等待真实 exit/调用清理；共享 worker 被终止时所有在途调用分别记中断，不宣称只杀掉一个请求。独占任务不随共享调试 worker 退出而取消。子进程失去 IPC 监督通道时取消所有调用并强制退出；该兜底不依赖控制 HTTPS 的连通性。

同 OS 账号和 `node:vm` 不构成恶意脚本安全隔离。`trusted-core` 只适用于已批准的受信项目及脚本，不能授予任意 npm、宿主文件/进程 API。V8 `childMaxOldSpaceMiB` 仅限制 old-space，并非进程 RSS 或容器资源总量。外部 CPU/内存硬限制默认均未设置；部署时按需求设置容器 `--memory`、`--cpus` 或编排器等价限制，例如 `--memory=1g --cpus=1`，并按实际并发验证。此处是部署约束和启动方式，Linux 容器实证由后续部署验收完成；Windows Node 测试不能替代该实证。
