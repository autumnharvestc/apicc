# F8 CI98：共享同步测试运行时的异常边界

日期：2026-11-08。调查基线 `6576b07640774275cbef165fc3b4cf49b6ba0840`，分支 `codex/f8-ci98-runtime-isolation`。不使用 superpowers skill，不运行本地全量或完整门禁。

## 原始结果与归因边界

CI98 的 Windows 打包、品牌门禁、Linux 各包 build/test 均通过；服务端 2197 项中 125 失败、9 错误。部署依赖失败的服务端任务，本轮没有部署通过证据。CI97 服务端 2197 项曾全部通过，因此“已通过门禁再次失败”确实发生。

125+9 全部集中在共用 `SyncCheckHttpFixture.node` 的 11 个类：调度生命周期、数据库时钟、操作回执、检查取消、应用、调度规则、回滚、候选详情、候选、保留清理和检查。独立 Node 实例的运行时客户端及多后端测试仍通过。原日志最早失败邻域是 `anOldSchedulerGenerationCannotFulfillANewOccurrence` 的调度停用、重启、取消和释放；其 finally 中的连接异常可能遮盖更早异常。

上次提交只修改 runner 联验和两份文档，未改 Java、同步运行时、共享测试辅助进程或 CI 配置。不能仅凭时间先后断言是上次修正改坏了 Java。此前审查确实漏掉了共享测试进程的请求异常边界与退出诊断；一次自然通过没有证明取消时序下的稳定性。

原 CI 未记录该 Node 的退出码和 stderr，无法追溯当时第一个触发异常。以下确定性复现证明了能够造成同类连锁的真实缺陷，不能替代缺失的原始现场证据。

## 确定性反例

原 `sync-check-process.mjs` 以裸 async HTTP 回调读取正文、解析 JSON。客户端在正文上传中途断开，异步读取抛 `aborted / ECONNRESET`，未处理 rejection 使整个 Node 退出。该进程同时承载 RPC 代理、真实 Core runtime 和合成源服务器；Java 静态实例继续持有失效端口，后续测试只能看到 `runtime-unavailable` 或拒连。

真实 TCP 复现先收到 `100 Continue`，再发送不完整 chunk 并 FIN。原进程 exit 1，后续 source/control 请求 `ECONNREFUSED`，stderr 明确包含未处理 Promise 的 ECONNRESET。独立 Java 回归在先成功真实 Core source-read 的合法前提下，分别注入中断正文和非法 JSON，原代码两项均失败。原四类自然定向运行 51 项通过，按未自然复现记录，不因日志名含 red 就称为失败证据。

## 修正边界

- 中断正文只结束当前代理请求；非法 JSON 返回 400，不终止共享进程。
- 普通调用者断开仍取消其拥有的 upstream；专门的丢响应实验仍保留已发出的读取，不自动重试。受控等待结束后，已断开的普通调用者不会再触发迟到转发。
- upstream 的请求和响应流错误均有归属；trace 写入失败与未知内部异常仍明确失败并收束进程，不能全局吞错、假成功或重启实例掩盖在途状态。
- Java owner 在初始化失败时回收已创建的进程；运行期非零退出输出有界诊断，每项用例前后检查同一实例，非零退出和强杀不能静默当正常关闭。
- 新回归要求同一进程在故障后完成下一次真实 Core source-read。另单独验证生产 RPC 的合法鉴权、不完整正文断开、后续健康调用；生产代码原有保护通过，无产品代码修改依据。

不修改同步业务重试、取消时限、额度、权限、执行事实或 CI 的通过标准。

## 逐项验证与证据

原始证据保存于 ignored 目录 `local/f8-ci98/`，可移植摘要、命令与哈希见 [证据索引](f8-ci98-validation-evidence.json)。现有失败记录不覆盖、不删除。

| 验证项 | 实际结果 | 证据 |
| --- | --- | --- |
| 原代码 TCP 中断正文 | Node exit 1，后续拒连 | `probe-abort-result.json` |
| 原代码四类自然组合 | 51 通过；未自然复现 CI 首异常 | `java-red.log`、`java-red-exit.json` |
| 新 Java 真实网络反例，修正前 | 2 错误 | `transport-red.log`、`red-reports/transport.xml`、`transport-red-stderr.json` |
| Windows 修正后新反例及相邻取消、调度、归属 | 67 通过，exit 0 | `java-candidate.log`、`java-candidate-exit.json` |
| Windows 生产 RPC 不完整正文单项 | 1 通过、35 未选，exit 0 | `runtime-partial.json`、`runtime-partial-exit.json` |
| 同 CI Linux 15 类组合 | 174 项中 173 通过、1 项后端启动超时，exit 1；没有共享 Node 退出 | `linux-targeted.sh`、`linux-targeted.log`、`linux-targeted-exit.json` |
| Linux 生产 RPC 不完整正文单项 | 1 通过、35 未选 | `linux-runtime-partial.json` |
| 上述启动场景，改为 Linux 原生存储 | 1 通过，exit 0；原源码、18 秒时限不变 | `linux-native-final.log/xml`、`linux-native-final-exit.json` |

Linux 使用 Node 22.19.0、Temurin Java 21.0.13+9，与原 CI 相同。隔离快照由基线 Git archive 加本轮四个明确候选文件组成，重新构建该链路的 SDK、Core、execution、collaboration runtime；仅执行具名受影响测试，不运行 `ci-stage`、全 Java、全工作区或完整本地 CI。

本轮 Linux 设置有一项环境前提疏漏：最初将编译产物和 Maven 依赖放在 Windows bind mount，后端日志显示启动 23.619 秒，超过原 18 秒 readiness 时限。保留这一失败，将相同候选和依赖复制到容器原生目录后，仅重跑原失败方法；两次真实后端启动分别为 4.44/4.008 秒，跨重启保留去重游标、两次 occurrence、三次 check、零自动应用等原断言全部通过。没有改源码或放宽时限，不将 173/1 与单项通过拼成一次 174 全绿。以后 Linux 验证的 classes/JAR/cache 使用原生目录，只将封存证据复制回宿主。

原生目录首次命令因 PowerShell 未引用带点的 Maven 参数而在生命周期解析阶段退出，未执行测试；命令修正后才取得上述有效结果。该次复制的旧 XML 不作新证据，原命令失败日志保留在 `linux-native-readiness.log`。

原归档后压缩 runner 联验没有再改；CI98 各包任务已验证它通过。此次新增产物身份通过 Windows、Linux 四个候选文件逐一 SHA256 比对，31 份原始材料和具名 Maven XML 均已索引。测试结束后容器内无 Node/Java 子进程，四份共享 Node stderr 均为 0 字节；隔离容器按本轮 ID 清理，证据保留。

## 审查与剩余限制

原 Sol xhigh 审查者独立核查原日志、共享资源 owner、生产边界和受控复现，并完成四个冻结源码候选的代码独审，未发现阻塞 P0/P1/P2。随后仅核最终 Linux 结果、文档与哈希清单，不重开宽泛审核。初始化异常清理等非触发路径属于本轮静态核查；不能将正常关闭和前后存活的实测扩大为所有 OS 终止失败都已注入验证。

今后这类修正的影响分析须覆盖请求进入、取消、等待恢复、实际流关闭、共享进程退出及下一次合法操作，不能只核业务断言结果。此次固定传输反例进入常规 Java 测试，新退出诊断进入原 Java 日志，不增加全量前置要求。

CI98 首个异常的原始现场仍缺失；修正后的远端 CI 待对应提交验证。KR-F7F-01 代理取消偶发项保持原有未定因状态，与本次 Java 共享夹具问题分开，不能借本次通过将其关闭。
