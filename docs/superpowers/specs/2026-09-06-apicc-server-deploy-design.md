# apicc 服务端部署支持（部署线）设计

日期：2026-09-06
状态：已澄清定稿（用户拍板），本轮开工交付
范围：服务端容器化部署（本地 Docker 验证）+ 首个管理员引导 + 部署文档。桌面端批次（导入双入口 / 存储 id 布局 / 主页重构）为下一轮，另立规格。

## 1. 背景与目标

- 服务端（Spring Boot 3.5.5 / Java 21 / H2 文件库 / 本地文件存储工作区内容 / 同进程托管管理后台静态产物）目前只有「源码运行」一种形态。
- 目标：交付 `docker compose up` 一键起服，验证远程服务器模式全流程（管理后台登录、桌面端添加连接、工作区浏览）。
- 用户验收环境：本地 Docker Desktop。k8s 清单同期交付但验证从简（无集群静态审查 + dry-run）。

## 2. 决策记录（澄清拍板口径）

- **D1 单容器单副本**：H2 文件库 + 本地文件存储决定不可水平扩展；k8s 单副本 + `strategy: Recreate`（卷 RWO，避免多附挂）。数据全部落在挂载卷。
- **D2 多阶段 Dockerfile**：
  1. node 阶段：corepack pnpm 构建管理后台 dist（`apps/admin-web`，纯 vite 产物，无原生依赖）；
  2. maven 阶段：`server/.mvn/settings.xml`（阿里云镜像，Maven Central 不可达的既有约束）打服务端 fat jar；
  3. 运行阶段：`eclipse-temurin:21-jre`，非 root 用户，jar + console dist 就位，`HEALTHCHECK` 打 `/api/v1/ping`。
- **D3 镜像策略**：本期仅本地 `docker build`（compose `build: .`），不推远端仓库；仓库推送归分发阶段（与自动升级同期考虑）。
- **D4 配置外部化**：全部经 Spring 原生宽松绑定环境变量，零代码。文档主用**下划线形态**（`APICC_SERVER_ALLOW_REGISTRATION` 等；点与连字符均转下划线——服务端注入走 `@Value` + `SystemEnvironmentPropertySource`，此形态可解析；无连字符紧凑形态如 `APICC_SERVER_ALLOWREGISTRATION` 同样有效）。以 docker 真机验证结果为准回填文档。
- **D5 注册默认关**：`apicc.server.allow-registration` 默认值 true → false（`application.yml` 与 `AuthService` 的 `@Value` 兜底双改）。环境变量可随时开启（批量拉人场景），公网部署建议保持关闭（文档提示）。
- **D6 首个管理员启动引导**（幂等，`ApplicationRunner`）：
  - `users` 表非空 → 什么都不做（重启不改名不覆盖）；
  - 空表且设置了 `APICC_SERVER_ADMIN_USERNAME` / `APICC_SERVER_ADMIN_PASSWORD` → 按环境变量创建（bcrypt 与注册同一强度）；
  - 空表且未设置 → 创建用户名 `admin` + 随机密码（SecureRandom 16 字节 base64url），密码以 WARN 打印容器日志，仅此一次，提示立即登录修改；
  - 「管理员」语义 = 第一个账号：建工作区成 OWNER，工作区级角色体系（OWNER>ADMIN>EDITOR>VIEWER）已覆盖管理能力，不引入全局角色列。
- **D7 k8s 清单**（`deploy/k8s/` 纯 manifests，不用 helm）：ConfigMap（非敏感配置）+ Secret（管理员口令模板）+ PVC（RWO）+ Deployment（单副本/Recreate/探针 `/api/v1/ping`/非 root securityContext）+ Service（NodePort）。
- **D8 健康检查**：用既有 `GET /api/v1/ping`（无认证），compose healthcheck 与 k8s 探针共用；actuator 后置。
- **D9 旧工作区 fail-fast（桌面端批次预告）**：存储 id 布局改造（下一轮）落地后，旧布局工作区打开即拒绝；与本部署线无耦合，此处仅记录避免遗漏。

## 3. 交付物与受影响文件

新增：
- `Dockerfile`、`.dockerignore`
- `deploy/docker-compose.yml`、`deploy/.env.example`
- `deploy/k8s/`：`configmap.yaml`、`secret.yaml`、`pvc.yaml`、`deployment.yaml`、`service.yaml`、`README.md`
- `docs/deploy.md`（环境变量表、构建/启动、首登流程、备份说明、桌面端连接指引、k8s 小节）
- `server/src/main/java/com/autumnharvestc/server/auth/AdminBootstrap.java`
- 测试：`server/src/test/java/com/autumnharvestc/server/auth/AdminBootstrapTest.java`（env 创建 / 随机创建+日志 / 非空 no-op / 注册默认 403）

修改：
- `server/src/main/resources/application.yml`：`allow-registration: false`；注释登记 admin 引导两个键
- `server/.../auth/AuthService.java`：`@Value` 兜底默认 true → false
- `server/.../store/UserRepo.java`：新增 `long count()`
- 依赖默认注册开的既有契约测试：`AuthApiContractTest`、`ContentApiContractTest`、`ContentIoFailureTest`、`ProjectAclApiContractTest`、`WorkspaceApiContractTest`、`MemberApiContractTest`、`WorkspacePermissionMatrixTest`、`ConsoleMissingContractTest`、`ConsoleStaticHostingTest` 逐个显式 `"apicc.server.allow-registration=true"`（各自独立内存库，互不影响）
- `README.md` / `server/README.md`：部署入口链接

## 4. 测试口径

- **服务端单测**（mvn + JDK21 + Aliyun settings）：
  - 引导三分支：env 建号可登录；无 env 建 `admin` 且日志含初始密码形态；预置用户后 no-op（不建 admin、count 不变）；
  - 注册默认关：不带属性时 register → 403 registration_disabled（新默认钉住）；
  - 既有全量测试绿（显式开注册的契约测试逐个补属性）。
- **真机验证**（本地 Docker Desktop）：`docker build` → `compose up` → ping 200 → 日志/`.env` 口令登录管理后台 → 桌面端添加连接登录 → 工作区清单可见 → `compose down`。
- **k8s**：`kubectl apply --dry-run=client`（无集群则静态审查）。

## 5. 明确不做（后置清单）

- 远端镜像仓库推送、CI 镜像构建 job
- actuator / 独立 readiness 语义
- PostgreSQL 等外部数据库选项
- Ingress / TLS 终结
- 容器化 CLI / 桌面端
