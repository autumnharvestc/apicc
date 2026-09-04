# apicc M2-D 设计规格：分布式压测、CI 工程门禁与桌面端压测视图

日期：2026-09-03
状态：已批准（用户常设授权：任务完成并通过验证后合并分支，至多 3 个并行 subagent 各自独立 worktree）
上游：`2026-09-01-apicc-m1-local-core-design.md`（M1 规格，§压测指标体系指向本文）、`2026-09-02-apicc-m2a-workflow-engine-design.md`、M2-C 计划「明确推迟」清单

---

## 1. 背景与目标

M2-C 交付了单机压测：`StressRunner`（并发池、迭代/时长双模式）、`computeReport`（nearest-rank 分位）、`run-stress` CLI。规格预留的「分布式扩展」与工程化缺口在本阶段补齐：

1. **分布式压测（M2-D1）**：多 shard 并行施压、样本汇聚成单一报告；协议可替换传输层（本地进程 → 未来跨机）。
2. **CI 工程门禁（M2-D2）**：GitHub Actions 三包门禁、品牌中立门禁（把「入库文件不含竞品品牌名」约束机器化）、打包冒烟、README。
3. **桌面端压测视图（M2-D3）**：接口级压测表单、运行/停止、报告展示——压测能力对桌面用户可见可用。

### 非目标（沿用 M2-C 推迟清单，本阶段不做）

- 断言参与采样判定、ramp-up 曲线、多目标场景编排。
- 跨机网络传输实现（仅定义协议与传输抽象）。
- 压测报告 HTML 化/图表化。
- GitHub Releases / electron-updater 自动升级（归分发准备阶段，需用户先建远端仓库）。

---

## 2. 关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 汇聚模型 | shard 上报**原始样本批**，协调端合并全部样本后一次 `computeReport` → 跨 shard 分位精确（避免分位数不可合并问题）；样本量级（10 万条 ≈ 6MB）与 M2-C 单机口径一致，内存可控 |
| D2 | 传输抽象 | 协调器依赖注入 `spawnWorker(spec) → Promise<ShardOutcome>`；M2-D1 提供本地子进程传输（stdio 单行 JSON）；未来跨机传输（HTTP/长驻 agent）按同一 schema 实现新 transport，core 不感知 |
| D3 | 分配语义 | `iterations` 均分（余数给前 r 个 shard，保证总数守恒）；`duration` 模式各 shard 同截止各自跑满；总 `concurrency` 均分（每 shard `max(1, floor(C/n))`，余数给前 r 个） |
| D4 | 失败语义 | 任一 shard 失败（非零退出/超时/协议坏输出）→ 报告仍落盘（成功 shard 样本合并 + `distributed.shardErrors` 记录），**exit 1**；全部失败也落盘（空样本报告）并 exit 1。口径：分布式下「数据不完整」比「部分成功」更值得暴露 |
| D5 | 协议 schema | 消息 schema 全部 zod、strict、入 core 并导出：`StressWorkerSpec`（下发：定位/变量/份额/时限）、`ShardResult`（`ok:true` + shardId + samples）、`ShardFailure`（`ok:false` + error）；`protocolVersion: 1` 字段前向兼容锚点 |
| D6 | 报告演进 | `StressReportSchema` 增可选 `distributed` 段（shards/perShard/shardErrors）；optional 字段保证旧报告（含 M2-C 产物）继续可解析 |
| D7 | CI 形态 | GitHub Actions 单 workflow 三 job：①三包 typecheck+build+test（ubuntu、Node 22、pnpm 11.21.0、`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 免下载二进制）②品牌中立门禁（脚本扫描 git 跟踪文件）③Windows 打包冒烟（仅 main push，electron-builder 缓存）。最小权限 `contents: read`；action 锁 major tag + 显式版本注释（SHA 锁定列为后续加固项） |
| D8 | 品牌门禁词表 | 竞品工具名清单（大小写不敏感、词边界扫描），**以分段字符串运行时拼接入库**——字面品牌名不落仓库（品牌中立约束对代码同样成立）；`swagger`/`openapi`/`collection` 为开放标准命名不在词表（`swagger: "2.0"` 是 OpenAPI 2.0 规范字段键，导入解析必须保留）；脚本内置 `--self-check`（正负样本同样运行时构造）保证词表本身被门禁覆盖 |
| D9 | README | 新建根 README.md（中文为主）：定位、特性、快速开始（Node ≥ 22.19 / pnpm ≥ 9）、CLI 与桌面端上手、目录结构、MIT；CI badge 留注释占位（远端仓库未建，路径未知） |
| D10 | 桌面压测执行位置 | 压测在 **main 进程**执行（长任务不阻塞渲染层）；session 持单活动 run + AbortController，`stress:stop` 触发 abort；并发二次启动报「已有压测进行中」 |
| D11 | 桌面报告落盘 | 复用运行产物目录，文件名 `stress-` 前缀（与 CLI 约定一致）；`runs:list` 按文件名/内容判别 `kind: "stress" | "collection"`，runs:get 对 stress 文件返回 StressReport——修复 2B 账本遗留「listRuns 对非运行 JSON 产出 undefined 摘要」缺口 |
| D12 | 桌面压测入口 | 接口级视图：现有视图切换区新增「压测」视图（表单：用例/环境/并发/迭代或时长二选一 + 开始/停止 + 报告摘要卡 + 分位表 + 状态/错误分布），不新增顶层导航 |

### 沿用不变量

- 品牌/许可/包名三约束（竞品名不入库；素材许可合规；`com.autumnharvestc` / `@apicc`）。
- Node ≥ 22.19、TS ^5.9、zod ^4 strict、中文 conventional commit、显式路径 `git add`。
- CLI 破坏性口径：全部请求失败且总数 > 0 → exit 1（分布式下叠加 D4）。
- IPC：channels 单源 + zod Record 校验 + preload contextBridge + memory 替身同构。
- Store：每调用 `createPinia()` 隔离、显式依赖注入、IPC 载荷深拷贝。

---

## 3. 子项目划分（3 条并行轨，各自独立 worktree/分支，基线 main @ e191131）

### 轨 1 — M2-D1 分布式压测（core + CLI）

分支 `feature/m2-dist`，worktree `apicc-m2-dist`。

- **core** `src/stress/distributed.ts`：
  - schema：`StressWorkerSpecSchema`（shardId、定位 apiPath/caseId/envName、份额 iterations/concurrency、durationMs、protocolVersion）、`ShardResultSchema`、`ShardFailureSchema`（判别联合 `ShardOutcomeSchema`）；
  - `planShards(spec, shards)`：D3 分配纯函数（可独立单测）；
  - `DistributedStressCoordinator`：注入 `spawnWorker`，聚合成功 shard 样本 → `computeReport` + `distributed` 段；超时（默认 300s，可配）kill 视为 shard 失败；
  - `mergeStressReport(samples, {shards, perShard, shardErrors}, meta)`：报告组装。
- **CLI**：`stress-worker` 子命令（stderr 走日志、stdout 末行 JSON 结果）；`run-stress` 增 `--shards <n>`（默认 1 = 现行为，进程内不 spawn）；shards > 1 时 coordinator spawn `process.execPath + [dist/bin.js, "stress-worker", ...]`。
- **测试**：core 分配数学（守恒/余数/并发拆分）、coordinator 注入替身（成功/部分失败/全失败/超时/坏 JSON）、旧报告兼容；CLI 真实子进程端到端（2 shards × 8 iterations 打本地 server，验证合并总数与 exit 码；cli 测试脚本前置 `pnpm build` 以保证 dist/bin.js 存在）。

### 轨 2 — M2-D2 CI 工程门禁

分支 `feature/m2-ci`，worktree `apicc-m2-ci`。

- `.github/workflows/ci.yml`（D7 三 job + 触发 push/pull_request + 权限收敛）。
- `scripts/check-brand-neutral.mjs`：读 `git ls-files`（排除 `pnpm-lock.yaml`），D8 词表大小写不敏感词边界扫描，命中即非零退出并列出 file:line。
- `README.md`（D9）。
- 验证：actionlint（若可得）或 yaml 解析 + 本地跑 brand 脚本 + 干跑复现 job 步骤（typecheck/build/test 序列与 `smoke:dir` 本地已验证）。

### 轨 3 — M2-D3 桌面端压测视图

分支 `feature/m2-stress-ui`，worktree `apicc-m2-stress-ui`。

- IPC：`stress:run`（载荷 apiId/caseId/envName/concurrency/iterations?/durationMs? → 最终 StressReport）、`stress:stop`；session 单活动 run + AbortController（D10）；报告落盘 runs 目录（D11）。
- 渲染层：`stressStore`（pinia 工厂）+ `StressPanel.vue`（表单 + 运行态 + 报告摘要/分位/分布展示 + 停止）；`App.vue` 接口视图切换区新增压测视图（D12）；`RunsHistory.vue` 按 kind 区分两类报告行；i18n zh/en 补键。
- 测试：session（运行/停止/并发拒绝/落盘判别）、ipc 校验、组件（表单交互/运行态/报告渲染/历史 kind 区分）。

### 冲突面分析（并行安全性）

轨 1 只动 `packages/core|cli`；轨 2 只动 `.github`、`scripts/`、`README.md`；轨 3 只动 `apps/desktop`。三方无共享文件；轨 3 消费的 `StressRunner/buildStressRequest` 在 main @ e191131 已存在，不依赖轨 1。合并顺序任意，合并后跑全量门禁。

---

## 4. 验收

1. 三轨各自：任务级 TDD 三绿 + 分支级最终审查修复闭环 + 分支全量测试绿 + 打包冒烟（涉及 desktop 的轨）。
2. 合并后 main：core/cli/desktop 全绿、`pnpm -r build`、`dist:dir + smoke:dir` 过、`node scripts/check-brand-neutral.mjs` 过。
3. 演示路径：`apicc run-stress <api> --case <id> --concurrency 4 --iterations 20 --shards 2` 产出含 `distributed` 段的单份报告，分位数与单机等价口径一致；桌面端对任一接口发起压测、停止、在历史中看到 stress 行。
