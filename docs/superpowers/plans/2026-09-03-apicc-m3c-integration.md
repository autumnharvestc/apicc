# apicc M3-C 联调与工程化实现计划

> **面向 AI 代理的工作者：** 在 M3-A（服务端）与 M3-B（桌面在线模式）均已合并 main 后执行本计划。必需子技能：subagent-driven-development 或 executing-plans。

**目标：** 真服务端 × 真桌面客户端的端到端联调、CI 增加 Java job、服务端运行文档——M3 收口。

**前置：** `feature/m3-server` 与 `feature/m3-online` 已合并 main；从合并后 main 拉出分支 `feature/m3-integration`（可直接在主 worktree 操作或独立 worktree）。

**全局约束：** 品牌中立；中文 conventional commit；显式路径 git add；TS 门禁 + `mvn -s server/.mvn/settings.xml test` 双绿。

---

### 任务 1：端到端联调

- [ ] **步骤 1：失败的测试**——集成测试（desktop 包内，注入真实 onlineClient 指向测试起的服务端进程）：
  1. 测试夹具启动服务端：`mvn -s .mvn/settings.xml -q -DskipTest package spring-boot:repackage` 后 `java -jar target/apicc-server-*.jar --server.port=<随机>`（或 `spring-boot:run`；选可确定性关闭者；health = GET /api/v1/ping 轮询就绪，超时 60s）。
  2. 场景链：注册两用户（A/OWNER、B）→ A 建工作区 → B 加入 EDITOR → A 推送含两项目的文件集 → B getTree（两项目可见）→ A 将项目 P2 对 B 设 NONE → B getTree 不再含 P2、读 P2 路径 missing → B 推送 P1 修改成功、构造 baseVersion 过期 → 409 → B 拉取全量到临时目录（与推送内容一致）。
  3. 断言契约测试与 M3-B 替身形状一致（防 A/B 契约漂移——这是本任务的核心价值）。
- [ ] **步骤 2：实现**——`scripts/e2e-online.mjs`（或 ts 脚本，选与仓内脚本工具链一致者）封装服务端生命周期；vitest 集成测试文件（CI 与本地可跑；jar 不存在时给「先 mvn package」可读错误——与 cli e2e 先例一致，测试脚本前置构建）。
- [ ] **步骤 3：全量回归（TS 三包 + mvn test）+ Commit** `test(desktop): 在线模式真服务端端到端集成`

### 任务 2：CI Java job + 打包冒烟修复 + 服务端文档

> **CI 失败修复（2026-09-05 并入，用户报告首次 CI 运行失败）**：package-smoke job 红——根因已定位：`@apicc/core` 的 types 指向构建产物 `./dist/index.d.ts`（desktop 无 paths 映射），而 package-smoke 未先构建 core 就跑 `dist:dir`，fresh runner 上 core/dist 缺失 → `Cannot find module '@apicc/core'` + 连锁 implicit any（10 errors）。test/brand 两 job 绿。修复：package-smoke 在 gen:icon 前补 `pnpm --filter "!apps/desktop" -r build`（core+cli 拓扑构建，desktop 由 dist:dir 自建，避免重复构建）；本任务合并后 main push 即真实验证。

- [ ] **步骤 1：核对清单**——①**修复 package-smoke**：`gen:icon` 之前插入 `pnpm --filter "!apps/desktop" -r build` 步骤（注释注明根因：core 类型在构建产物 dist/，desktop typecheck 依赖它）；②`.github/workflows/ci.yml` 增 job `server-test`（ubuntu、actions/setup-java@v4 temurin 21、`mvn -s server/.mvn/settings.xml -f server/pom.xml test`；依赖缓存：actions/cache `~/.m2/repository` key 含 pom 哈希）；③`server/README.md`：启动（mvnw/mvn 两种 + JAVA_HOME 21 要求）、配置项表（data-dir/allow-registration/token-ttl-days/端口）、默认端口 8080、数据目录结构说明、与桌面端对接（服务器地址填法）；④根 README 开发节补 server 一行；⑤**wrapper distributionUrl 同步**：A 轨已改用 Aliyun central 仓库同构件 URL（规格原文 mirrors.aliyun.com/apache 404），README 用该实测 URL；⑥Mockito/byte-buddy 动态 agent JDK 告警：surefire 不强求处理，CI 观察后定（备案项）。
- [ ] **步骤 2：验证 + Commit**——本地干跑 job 步骤序列（mvn test 已绿即等价）；`docs(server): CI Java job 与服务端运行文档`

---

## 规格覆盖对照

| 规格（m3 spec §4 轨 3 / §5） | 任务 |
|---|---|
| 验收 3 端到端链路 | 1 |
| 验收 4 文档 | 2 |
| D3 CI 统一 settings | 2 |
