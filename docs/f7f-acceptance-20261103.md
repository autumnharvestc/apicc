# F7f 阶段交付回执

日期：2026-11-03。结论：**F7f 开发、审核、集中验收和交付收尾完成，保留用户分别接受的两项未定因已知风险。不是“全量单次全绿”或 CI 通过声明。** 未暂存、提交、合并或推送，main 未变。

## 1. 候选与交付物

- 工作树：`C:/Users/imini/.codex/worktrees/contract-assets/apicc`；分支 `codex/f7f-collaboration-design`，真实 HEAD 仍 `e071f618b95fe874a341a038a5cf12f8303fe3a3`。
- 运行时代码 rawtree：`8e6b7204a424fb4446a1caf719867d5081d3ea9d`。后续仅 session 夹具、Node 门禁和四个 Java 测试前提修正；最终联验前累计冻结树 `f5675f88b7f9debf2d355074514fdbcc29180fb5`。本回执及计划/路线图归档在联验后追加，不冒称它们参加了此前命令。
- 桌面目录包：`apps/desktop/release/f7f-final-r2-20261103/win-unpacked/apicc.exe`；实际目录构建、IPC/Core 子路径/独立 viewer 资源及启动冒烟均 exit0。
- exe SHA-256：`bb2082f9d8c7857fce15e3e687f426d6723735fec97390b6d64a47b5742d247a`；`resources/app.asar`：`444ccfdd9aec920050f67c839a1bc8e05e0105105e127c7a6b598683268169c1`。
- 服务端 Jar：`local/f7f-acceptance/final-r2-maven-20261103/apicc-server-0.1.0-SNAPSHOT.jar`，SHA-256 `b9e9927ca93c7e1709335417863911044cebb8327481a0067acabd5398352959`。该独立打包命令 skipTests，不算测试通过；测试证据另列。
- 最终镜像 `apicc-f7f-server:final-20261103-r2`：`sha256:85f770dc4691b406cb42172f88506d97db35a7129005540abc385e6dbb2ed8f3`；`apicc-f7f-collaboration:final-20261103-r2`：`sha256:9fc6aa6d6a79f5b6686e02a1a8a4e99140213a400721296b3ec796f5a9594059`。本次有实际容器验证，不仅是 build。

## 2. 审核和真实命令

T1–T12 均已有原实现者和独立任务审核；唯一整分支审核及其统一修正、用户批准的 N01/N02 两项追加产品修正已由原审查者定向复核。最后 Node 门禁修正、四文件测试前提修正也分别完成唯一原审查者定向复核，均无剩余 C/I 或新增 M。不再做第二次宽审。

精确门禁工具链为 Node 22.19.0、pnpm 11.21.0、Java 21.0.12；Core→execution→消费者按拓扑构建。Electron 自带运行时与命令行 Node 分别记录，不承诺不同宿主运行时完全相同。

| 实际范围 | 结果及边界 |
| --- | --- |
| 原根门禁 build/type/品牌/编排/Docker-agent | 已执行并通过；递归测试随后因 admin 旧 session 夹具缺少版本读取而失败，原 exit1 保留 |
| 原已到达包 | plugin11、Core2337、runtime110、viewer36、execution544 通过；admin432通过/1失败，不把该次记成433通过 |
| admin 最小夹具修正 | 拥有文件19项通过；只补真实协议所需读取，不改产品或登出断言；独审通过 |
| 未执行范围续跑 | desktop1996通过；CLI516通过/1条件跳过；agent91通过/1失败/14条件跳过。代理原失败按 KR-F7F-01 登记，不改名为通过 |
| 原 Java 全套 | 1920项：1828通过/6失败/86错误/0跳过；90份当次鲜XML保留，不拼成后续单次全绿 |
| Node 路径修正后 | 85个原未启动的 SharedMock/Audit 拥有项全部通过；真实 Java→Node 正控、维护回归和原审查者复核通过 |
| 四个测试前提修正 | ArtifactConcurrency6、CollaborationPolicy151、PublicAdmissionRace11、ProjectAssets12，共180项通过，0失败/错误/跳过；严格403/408、503→200和数据不变断言保留，产品锁/权限/ready/预算未改 |
| Schedule 有限诊断 | 五参数带观测版本通过；不是修复或恢复后的原文件再次通过，按 KR-F7F-02 单独登记 |
| 最终标准真实组合 | `node scripts/f7f-acceptance.mjs --mode=synthetic --evidence-root=local/f7f-acceptance` 实际 exit0；40 Java场景/9份鲜XML、1个真实代理组合、真实容器检查均通过且无跳过 |

最终标准组合为 `local/f7f-acceptance/run-bQsNkl`，2026-11-03 21:45:08–21:48:02（UTC+08:00）。前后源码 SHA-256 均为 `896cbe3a3b500ccc2c02f288b02551197ba59d57bdda47ce835363c859d85299`，index及Core/viewer/runtime身份一致。组合脚本的 UI/review/rootgate `pending` 是刻意留给控制者的外部义务，原机器回执不篡改；由本回执所列的独立 UI/审核/分段门禁及风险确认核销。

Core build identity：`52607053fec3afe77428f9a1ebe935cde7a9c829b2801bc14a4162b0cf46b656`。执行包 identity：`b24f401344f4983b3db2a1a370b9a3d1cc09c0730a16ebaba596fdecdb8d6fe8`；真实归档中的执行身份按其所属包记录，不混作Core纯协作投影身份。

## 3. AC01–14 验收核对

各项是批准范围内的有限验收，不是全角色×端点×页面矩阵、HA、长期高负载或绝无缺陷保证。

| AC | 已核实事实 |
| --- | --- |
| AC01 | 真实 agent stress/debug 归档与安全历史/预览，server-archive 来源及执行身份；原生单项上传另标 member-claim、明确确认后固定版本，二者不混淆 |
| AC02 | T3/T9 选择单项/脱敏/只读与确认门禁、当前Core/execution/desktop验证；真实原生预览→独立上传→固定发布，未默认外发其他项目资料 |
| AC03 | 真实固定源、同意图幂等、源/权限/策略/额度拒绝、清理交错；最终180含真实等待后撤权拒绝，授权代次修复经原审核与受影响验证 |
| AC04 | OWNER、成员/NONE、能力和旧写入口接统一权威；真实权限/CAS/回滚及CLI/MCP受控通路；最终180保留停用/撤权后403和资产/修订不变 |
| AC05 | GrantApi/Directory/Lifecycle及实际浏览器用途/来源拒绝，文档只读key与Mockkey不互通，独立公开origin无管理身份入口 |
| AC06 | 失权/轮换/撤销后新读取拒绝，实际已打开页再次下载清空旧内容；最终真实重启仍410、TTL原值不延长；下载后文件不能收回的限制保留 |
| AC07 | 引用/计费与保留事务及真实受控交错，完整正文或明确拒绝；生产有界清理接线和当前共享生命周期拥有范围通过 |
| AC08 | 复用Core依赖闭包与安全文档；实际中英搜索/零结果恢复/锚点/原业务复制/9516B离线下载，脚本文字不执行；未冒称工具打开了被禁的file URL |
| AC09 | 同一有限规则在本地/共享产生真实响应，敏感/控制条件预览拒绝；当前SharedMock拥有范围及最终组合通过 |
| AC10 | 最终真实发布宿主退出、代理离线后共享Mock仍200；Node中断无重放、真实调用断连/超时释放/满额429，恢复只接新调用。另保留与旧代理取消有关的KR-01，不称其修复 |
| AC11 | 实际双origin、CSP、无管理API/身份cookie、受控fragment/header；下载不含key，用户HTML/脚本不执行；HTTPS策略未因HTTP自验放宽 |
| AC12 | 同事务管理审计、独立日志权限、有限访问观测和保留；当前Audit35及最终权限场景通过。匿名身份未采集/有界明细/观测缺失如实显示，不冒称完整统计 |
| AC13 | 原生/管理台/公开页面实际中英文及局部滚动；期限带可读天数与精确ms、毫秒时区/展开指纹、逻辑失败与原始请求通过分列，元数据不是JSON主视图 |
| AC14 | 当前实际Java-only无Node启动、Java→私有Node成功；错secret/不兼容封装503、Node离线明确408且无回退；实际私网/非root/只读/CPU/RSS/heap检查通过 |

容器实测配置：CPU1 vCPU、内存上限768MiB、heap384MiB、uid1000、只读根及secret挂载、内部网络且RPC无宿主公开端口。RSS采样约81MiB是瞬时观测，不是性能承诺；管理台只显示外部配置，不把保存值当作OS已执行证明。本次外部执行证据来自真实 Docker 检查。

## 4. 清理、风险和下一步边界

所有本轮原生/UI/TLS/HTTP、最终组合的Java/Node/agent/宿主进程及容器已实际收束；目录包正常退出，没有使用旧的丢弃草稿批准。最终组合收束记录无失败，容器退出143为该轮受控停止。仅本轮合成卷在先保存数据后移除；持久报告、资产、DB/profile、截图、下载和原失败证据保留，不涉及真实项目。

[两项已知风险](f7f-known-risks.md)分别获用户确认；原断言和预算不改。未触及部分长单行维护债及原工具链告警保留，不进行全模块格式化或无关依赖升级。F7b三项仍排F7g之后，调度B/到达率B/团队AI/DEF-001等延期不恢复。

完整本地证据根为 `.superpowers/sdd/2026-11-01-apicc-f7f-collaboration/`：`controller-final-ui-receipt.md`、`controller-final-synthetic.json/log`、`controller-current-ac-evidence-map.md`、`final-review.md`及各定向复核、`controller-known-risk-approvals-20261103.md`、`rulings-evidence-index.md`。裁决索引保留全部71处历史原文快照及后续补充裁决、理由与错判代价，未删除重写历史。

使用/运维入口见 [F7f说明](f7f-collaboration.md)、[部署说明](deploy.md)、[整阶段计划](superpowers/plans/2026-11-01-apicc-f7f-collaboration.md)。下一项安全操作是用户验证新包或另行授权Git集成；没有自动开始F7g、合并、推送、发布或修改真实项目。
