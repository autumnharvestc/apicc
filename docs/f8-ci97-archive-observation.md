# F8 CI97：归档后进程证据读取修正

日期：2026-11-08。基线 `bfe133e70e8ad6ab4284f17570ad11a9ae04507d`，工作分支 `codex/f8-ci97-archive-observation`。不使用 superpowers skill，不运行本地全量或完整 CI。

## 原失败与影响范围

用户提供的 `local/ci97-test.log` 四份主日志均检出同一基线提交。Java 2197/2197、Windows 打包、品牌门禁通过；desktop 2312 通过/2 跳过。runner-agent 为 146 通过/1 失败/15 跳过，失败为 `e2e-server.test.ts` 的 `keeps Linux stress reservations through controlled derating, cancellation, worker exit and lost report ACK`，原第 333 行对 `released.processes` 调用 `toHaveLength(3)`，实际字段已被压缩移除。CLI 后续测试和依赖该步骤的部署没有本轮通过证据。

第二批已批准：只有确认退出、消息 ACK 且报告归档的进程明细可删除，永久去重身份和统计保留。原联验在读取服务端已归档报告后，又假设代理 ledger 永久保留 `processes`；同案原第 346 行在 worker 异常退出后存在相同假设。该测试前提与默认开启的压缩冲突，与 CI96 的三个桌面断言不是同一失败。

上轮补了真实 worker→归档→压缩→重启防重链路，却未把现有 Docker 联验的归档后明细读取列入受影响消费点；逐点审核仍有这项遗漏。CI97 的实际失败保留为原反例，不把后来补验冒称先前已经覆盖。

## 修正及验收条件

本次修改集中在这条联验及其相邻 worker-exit 段：

1. 运行时仍捕获真实 coordinator/两个 worker 的 PID、出生身份、作用域、父子关系和固定启动意图。
2. 取消或注入 worker 退出后，报告必须保留完整进程观测：实际启动数与退出数均为 3。
3. ACK/归档压缩后，两类明细均被移除；执行、任务、delivery 身份、执行事实及已归档状态保留，进程总体与归档报告一致。
4. 使用运行时捕获的 PID 另查 Linux `/proc`，确认整棵进程树已物理退出；取消与 worker-exit 均执行此检查。
5. 原降额排队、未启动任务不派生进程、邻近普通任务继续、丢消息/报告 ACK 后不重发业务请求等断言保留。

核对所有现有 `processes`/`processIntents` 消费时，应按运行阶段区分：活动/未归档/未 ACK 的拥有记录必须保留，已安全归档后的读取使用长期统计与独立进程身份快照。不能把可选链或空数组兜底作为已退出的证明，也不通过关闭默认压缩来回避真实部署路径。

## 验证与证据

原日志摘要与 SHA256 位于 `local/f8-ci97/ci-summary.json`。新建私有候选代理镜像 `apicc-f8-ci97-agent:candidate`，构建退出码 0；runner 类型检查退出码 0。仅执行上述一条真实 Java、桌面宿主和 Linux 代理容器联验，命令、源码 blob、输出及退出码分别保存在 `targeted-command.json`、`targeted-e2e.log`、`targeted-e2e.json`、`targeted-exit.json`。

最终定向联验 `settled-e2e.json` 为 **1 通过/5 未选，exit 0**，最终 runner 类型检查 exit 0。Windows 宿主为实际 Electron，Linux 代理为新建镜像，服务端 JAR 由本轮源码首次构建（跳过测试），随后两次具名验证复用同一产物；这是本机跨平台组合验证，不称同一提交的远端完整 CI 已通过。

过程中两次新增测试前提失误独立保留：`targeted-e2e.json` 的旧快照 fact 与终态 fact 相等假设失败；`targeted-final.json` 又发现三进程注册不保证业务已开始，实际 worker 故障终态为 not-started，但进程观测仍是完整 3/3。最终故障注入前增加该 execution 的 started 事实和本次两条目标请求到达条件，再保持 started、完整 3/3、实际物理退出等严格断言。没有通过接受任意事实或 partial 观测换绿，不将这两次测试失误当作产品缺陷。

最终原始场景数据在 `local/f7b-t11/e2e-FnqOS1/stress-control-results.json`：取消与 worker-exit 均保留 started、完整 3/3、同一长期观测；两组各 3 个原 PID 的 Linux 身份均为 null；两类明细均已压缩。丢 ACK 计数为 2，目标业务请求为 4；SQLite 完整性为 ok，代理正常 exit 0，Java 正常收束。最小汇总及原始材料哈希在 `local/f8-ci97/verification-summary.json`，原始日志仍为本机 ignored 证据。

精确最终命令（通过固定 Node 22.19.0 / pnpm 11.21.0 调用）：

```text
pnpm -C apps/runner-agent exec vitest run tests/e2e-server.test.ts -t "keeps Linux stress reservations through controlled derating, cancellation, worker exit and lost report ACK" --maxWorkers=1 --reporter=json --outputFile=../../local/f8-ci97/settled-e2e.json
pnpm -C apps/runner-agent typecheck
```

通过场景的源码与最终文件只差两行解释注释的准确性修正，行为无变化；最终类型检查在当前文件上执行，不冒称注释修正后重跑过场景。没有运行 Java 全套、整个 desktop/runner-agent、工作区测试或完整本地门禁。

## 独审与剩余边界

原 Sol xhigh 审查者集中检查归档压缩、恢复、进程观测及现有联验的所有相邻读取：其他归档消费者使用长期身份或报告，运行中/未归档的明细断言有对应前提；未发现其他同类“归档后必存明细”假设。上面两处新断言前提已按真实阶段修正。最后仅核对结果、注释、文档及冻结清单，避免重新宽审或追加测试。

生产执行内核、压缩资格、取消预算、权限和配置没有改动。KR-F7F-01 保持未定因风险，新远端 CI、CLI 后续步骤及部署结果仍待对应提交的实际运行，具名验证不代替它们。提交/合并/推送身份以本轮 `local/f8-ci97/integration-receipt.json` 为准。
| 运行 | 通过/失败/未选 | JSON SHA256 |
| --- | --- | --- |
| targeted-e2e.json | 0/1/5 | fb74bf5433b7bfd891168711ddee8212776613be885256e836d4dd1ade3c1543 |
| targeted-final.json | 0/1/5 | 0b057a4d91510896293496c67307b36f06a49b59efe129896c79881ff7ad3620 |
| settled-e2e.json | 1/0/5 | 7f22bdf423f0ed2aa1a69d8656993b6fe1c3ea13e4964f577ee8502951181608 |

最终测试文件 SHA256：`8cc046664dba4d0f77d94d247442fad6380fc2152810d0cee6509cbe7c9e104e`。
