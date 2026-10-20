# F3-B 本地声明式 Mock 实现计划

状态：整阶段已集中批准；等待计划A共享接口稳定后顺序实施，不授权Git集成。

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框跟踪。须有F3整阶段批准，且计划A共享快照/诊断接口已稳定。

**目标：** 当前项目在本机启动可解释、可复现、可停止的声明式HTTP Mock，Desktop/CLI共用内核。

**架构：** 项目文本配置与已保存快照编译成只读路由/响应计划；Node HTTP server执行计划，主进程manager持有完整上下文身份、重载状态和有界日志。没有脚本/远端转发/文件读取。

**技术栈：** 现有TypeScript、Zod、Node HTTP、Electron、Vue、Vitest；不引入另一运行时或新的Mock服务依赖。

**规格：** `docs/superpowers/specs/2026-10-18-apicc-f3-design-docs-mock-exchange-design.md`，重点§6、§8–10。测试命令/固定Node与pnpm遵循计划A全局约束。

## 全局约束

- Luna xhigh开发、Sol xhigh独立审核；不恢复DEF-001，不自动提交/合并/推送。
- Mock只用已保存快照，不读取SecretStore、本机Body文件，不执行模板/脚本，不调用真实后端。
- 仅127.0.0.1；port0或1–65535；不主动开启CORS，无LAN/共享模式。
- 请求体/单响应各1MiB、活动请求64、规则256/条件32、delay0–30000ms、生成深度16/节点1000、日志环200条、停止上限5秒。
- Desktop项目退出停止本项目实例；独立CLI进程不受桌面退出影响。CLI首版无watch/后台守护。

## 文件与职责

新增core `mock/model.ts`（版本配置schema）、`mock/compile.ts`（路由/规则/引用预检）、`mock/generate.ts`（有界值生成及当前Schema子集验证）、`mock/server.ts`（监听/延时/取消/日志）。规则数据是声明式字段，不是任意DSL。

修改`contract/workspace.ts`、`storage/contractFiles.ts`、`assets/snapshot.ts`、`assets/clone.ts`以完整往返可选`project.mock`及引用ID；`contract/model.ts`不改变ApiContract格式。新增Desktop `shared/mock.ts`、`main/mock.ts`、`stores/mock.ts`、`MockPanel.vue`；接入现有App项目上下文、session提交成功通知、IPC/preload/memory/i18n。新增CLI `commands/mock.ts`并在main注册。Node-only server只从core/index.ts导出，浏览器只能导入配置schema/DTO。

## 任务1：版本配置、生成与编译（B01/B02）

- [ ] 新增`packages/core/tests/mock/compile.test.ts`、`generate.test.ts`，复用`createContractExecutionProject`构造HTTP项目，把fixture路径明确改为`/items/{id}`，加一个固定JSON响应。使用表驱动最少样本覆盖字面/参数路由歧义、示例选择、三类组合、递归/矛盾Schema和fixed seed；不跑allocator/OOM/隔离专项。
- [ ] 定义`MockProjectConfig`：formatVersion1、seed、enabledContractIds、rules；每规则id/enabled/contractId/conditions/responseBindingId/status?/mediaType/source/delayMs。source为example ID、schema或literal文本。所有输入严格schema校验，缺省project.mock保持未配置。
- [ ] 实现`compileProjectMock(snapshot)`，成功返回`{ok:true,plan}`（plan含sourceProjectRevision/routes/固定响应字节），失败返回`{ok:false,diagnostics}`。编译时确定路由歧义、具体status、引用、媒体类型、条件及生成结果，不让网络请求到来时才无限展开模型。

```ts
const snapshot = createProjectSnapshot(project); // project为本任务上一步创建的固定HTTP夹具
const first = compileProjectMock(snapshot);
const second = compileProjectMock(snapshot);
expect(first.ok).toBe(true);
expect(second).toEqual(first); // 不含时钟、随机runId或监听地址
```

- [ ] `generate.ts`有界选择enum/default/example/标量/对象/数组候选，组合节点验证满足性；必要递归或无法生成返回字段诊断。JSON响应由JSON序列化，XML/Text只发显式文本示例；Body/head/status/Content-Length规则按规格执行。
- [ ] 在现有storage/clone/snapshot测试文件补一个配置往返和clone重映射回归（API/rule response/example引用均不指回旧项目），包括配置版本拒绝。不新建另一存储系统；计划A公共输出对Mock配置不做秘密扩散。
- [ ] 定向跑mock两文件及上述受影响已有文件，确认真实断言RED→GREEN、独立规格/质量审核后继续。

## 任务2：真实HTTP服务、状态和有界停止（B03/B04/B05）

- [ ] 新增`packages/core/tests/mock/server.test.ts`，每个fixture监听port0且finally关闭。一个真实本机服务场景串联状态/头/body/条件命中、未命中404/501、HEAD/204、更新revision与停止释放端口，不为同一路由每个字段再建服务。
- [ ] `startMockServer(plan, options)`返回handle：address、status、reload(nextPlan)、invalidate(diagnostics)、logs()、stop()；options含port和signal，无任意handler插件。传输层只消费编译计划，记录requestId/规则ID/revision/结果码，不把实际query/header/body写入日志。
- [ ] 实现明确状态`starting/running/reloading/invalid/stopping/stopped`；reload期间新请求503，在途请求捕获旧plan，成功后原子替换；编译失败由manager调用invalidate，新请求503，不悄悄继续旧契约。端口占用给稳定错误，无隐式改端口成功（只有显式port0可系统分配）。
- [ ] 请求体1MiB限制返回413，活动请求超过64返回429，不另排无限队列；日志最多200；延时由取消感知计时器实现。stop取消延时并在5秒内关闭余下连接。只用单个有界代表断言验证各限制，不做容量/压测矩阵。
- [ ] 真实测试断言两个不同revision请求、一个停止中的延时请求、日志无合成Authorization/Cookie原文；禁止以延长Vitest timeout使挂起连接变绿。运行server单文件并交独立审核。

## 任务3：Desktop项目生命周期与CLI入口（B04/B05/B06）

- [ ] 新增`apps/desktop/tests/main/mock.test.ts`，复用session完整locator与本机server fixture：同projectId不同物理root、切工作区的迟到start、重复start/stop、相关保存后reload；只检查当前manager资源，不杀全系统同名进程。
- [ ] 主进程MockManager按root＋workspace/group/projectId＋generation持有handle。先捕获上下文再启动，结束前复核，不属于当前上下文的迟到实例立刻停止。session写盘成功后通知受影响实例重编译；监听退出/项目关闭/工作区切换并等待停止，不在renderer清理生命周期。
- [ ] MockPanel在当前项目提供配置、保存/启动/停止/重载、具体地址、状态/失效诊断、内存日志及复制/新建自由请求入口。控制不另选项目；新建自由请求复用B1创建入口，不自动发送，不改原baseUrl。不动全局topbar/ModuleRail布局，入口置既有项目工作区工具区。
- [ ] 新增`shared/mock.ts`严格端口契约：配置读/存、start/stop/reload/status/logs，完整locator及sourceProjectRevision；所有channels/IPC/preload/memory同时装配，memory模拟行为不冒充真实server验证。对应新增`components/MockPanel.test.ts`验证状态/失败/只读及项目切换；日志不开放任意文件读取端口。
- [ ] CLI `mock <projectPath> --port <n> --seed <value>`启动同一core server；默认port0，seed省略取保存配置。输出实际地址和revision，不打印配置/秘密；SIGINT/SIGTERM有界stop，正常退出0，启动失败非0。mock命令只读工作区，不修改默认持久seed。
- [ ] `packages/cli/tests/mock.test.ts`用现有CLI子进程模式建立一个隔离项目和一项真实请求；关闭自己的Desktop或其fixture时CLI仍工作，再关闭CLI确认监听释放。没有真实Desktop可运行时只标CLI独立宿主已验，完整代表链留阶段G，不伪装已验。
- [ ] 定向运行main mock、MockPanel、CLI mock；只在CLI需要时构建一次core/CLI。独立审核并把B01–B06证据交root，再进入计划C。

## 交付检查

- [ ] 新项目字段在加载/保存/快照/clone中均有消费，不因为没有Mock而改变全部旧夹具。
- [ ] 保存导致规则失效时明确invalid/503；不遗留按旧资产响应的幽灵实例。
- [ ] 不加入远程服务、脚本、后台守护、文件监控框架或额外性能专项。只运行已批准的声明式Mock代表链。
