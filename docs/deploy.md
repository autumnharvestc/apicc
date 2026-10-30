# apicc 服务端部署

apicc 服务端为单容器架构：API 与管理后台同进程（管理后台托管在根路径 `/`），
一切状态（用户/令牌/工作区/分组/项目/ACL/文件版本含内容字节）都在 H2 元数据库
（单文件，容器内 `/data/metadata.mv.db`）。
**单副本部署**——H2 文件库不支持多实例共享，扩容选项后置。

## 前置要求

- Docker（含 compose v2）或单节点 k8s 集群（k3s / minikube / Docker Desktop 内置 k8s）。
- 桌面端（Electron 应用）用于连接与验证远程模式。

## 快速开始（docker compose）

在仓库根目录执行：

```bash
# 1. 准备环境变量（管理员口令务必修改）
cp deploy/.env.example deploy/.env

# 2. 构建并启动（首次构建含前端与 jar 编译，耗时数分钟）
docker compose -f deploy/docker-compose.yml up -d --build

# 3. 就绪探测
curl http://localhost:8080/api/v1/ping    # {"status":"ok"}

# 4. 打开管理后台
#    浏览器访问 http://localhost:8080/ ，用 deploy/.env 中的管理员账号登录
```

数据持久化在命名卷 `apicc-data` 中，`docker compose down` 不会删除数据；
需要彻底重置时执行 `docker compose -f deploy/docker-compose.yml down -v`。

## 首次登录与管理员账号

注册默认**关闭**，首个账号由服务端启动引导创建（仅在用户表为空时生效，重启不覆盖）：

- **部署 `.env` 中设置了 `APICC_SERVER_ADMIN_USERNAME` / `APICC_SERVER_ADMIN_PASSWORD`**
  → 按该凭据创建，直接登录即可。
- **未设置** → 创建用户名 `admin` + 随机口令，口令打印在容器日志（仅此一次）：

  ```bash
  docker logs apicc-server | grep 初始密码
  # 首次启动：已创建管理员账号 admin，初始密码：xxxxxxxxxxxxxxxxxxxxxx（…）
  ```

请登录后在管理后台创建工作区并妥善保管凭据。忘记口令时：临时开启注册
（`APICC_SERVER_ALLOW_REGISTRATION=true` 后重启）建新账号，再经管理后台把它加入
工作区并赋予管理角色，最后关闭注册。

## 桌面端连接远程服务器

1. 桌面端顶栏「在线模式」按钮（或主页「管理服务器」）打开连接对话框；
2. 添加服务器，地址填 `http://<服务器IP>:8080`（本机验证即 `http://localhost:8080`）；
3. 用管理员账号登录，选择团队工作区打开进入在线模式（浏览/编辑工作区内容）。

## 环境变量

变量名 = `application.yml` 属性的点与连字符转下划线（Spring 宽松绑定，零代码外部化）：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVER_PORT` | `8080` | 服务端口 |
| `APICC_SERVER_CONSOLEDIR` | `./console`（容器内已设 `/app/console`） | 管理后台静态产物目录 |
| `APICC_SERVER_ALLOW_REGISTRATION` | `false` | 注册开关。公网部署保持关闭；批量拉人临时开启 |
| `APICC_SERVER_ADMIN_USERNAME` | 空 | 首个管理员用户名（仅用户表为空时生效） |
| `APICC_SERVER_ADMIN_PASSWORD` | 空 | 首个管理员口令；未设则随机生成并打印日志 |
| `APICC_SERVER_TOKEN_TTL_DAYS` | `30` | 登录令牌有效期（天） |
| `SPRING_DATASOURCE_URL` | 容器内已设 `jdbc:h2:file:/data/metadata;WRITE_DELAY=0` | 元数据库地址。镜像内置为卷内绝对路径（源码默认 `./server-data/metadata` 依赖运行目录，容器内不适用） |

### 元数据持久化边界

持久 H2（文件库及 TCP 文件库）在 schema 初始化和后台任务启动前统一使用 `WRITE_DELAY=0`。
这会增加提交时的磁盘写入 I/O，换取已确认状态在进程突然退出后不依赖默认 500 ms 延迟写入窗口；
仍需可靠的磁盘、备份和单副本部署，不承诺抵御存储设备故障。

现有 Hikari 自定义 JDBC URL 可以保留路径、其他选项及其转义值，但缺失或非零的 `WRITE_DELAY`
会明确归一为 `0`，不能继续使用延迟写入覆盖。每条新物理连接还必须成功执行 `SET WRITE_DELAY 0`
后才能交给应用，旧库保存的设置和后续扩池连接都遵循同一策略。内存 H2 不受此文件持久化策略影响。

持久库自定义非空 `spring.datasource.hikari.connection-init-sql`、`spring.datasource.hikari.connection-test-query`、URL / datasource-properties 的 `INIT`、
已启动的连接池、非 Hikari 自定义 datasource 或绕过 JDBC URL 的物理来源不受支持，启动时失败关闭；
请移除自定义初始化 SQL / INIT 和自定义连接检测 SQL（即便是 `SELECT 1` 也需移除），使用 JDBC 原生
`isValid` 及尚未启动、以 `jdbc-url` 配置的标准 Hikari datasource。检测 SQL 可能在物理连接初始化后重复执行，
因此不能依靠初始 `SET WRITE_DELAY 0` 使任意后续检测 SQL 安全；内存 H2 的自定义初始化和检测行为不变。
不要用直连工具以非零 `WRITE_DELAY` 并发连接同一 TCP 库；外部 SQL 管理员仍可改变数据库全局设置。

## k8s 部署

见 [deploy/k8s/README.md](../deploy/k8s/README.md)（ConfigMap / Secret / PVC /
单副本 Deployment + Recreate / NodePort Service，探针复用 `/api/v1/ping`）。

## 数据与备份

一切状态都在 H2 元数据库（单文件，容器内 `/data/metadata.mv.db`）：
用户 / 令牌 / 工作区 / 分组 / 项目 / ACL / 文件版本（含内容字节，`file_versions.content` 列）——
工作区内容不再落盘为目录树。
备份 = 停写状态下快照该文件 / 卷（compose 命名卷可用 `docker run --rm -v apicc-data:/data …`
打包；k8s 按 StorageClass 快照能力操作）。

## 升级

```bash
docker compose -f deploy/docker-compose.yml up -d --build   # 重建镜像并滚动到新容器
```

数据库使用幂等 DDL；它不会把任意旧表重建为新结构。历史 UUID 主键等不兼容布局不能仅凭启动
成功判定升级安全。先停写并备份旧卷和独立密钥，核对来源版本；必须启用新空库时使用新的卷名，
保留旧卷供回退和旧报告查询，不把删除卷作为日常升级步骤。

F7c 在线压测沿 F7b 控制协议扩展。服务端、客户端及 `Dockerfile.agent` 的代理需使用配套候选，
准入核对 Core 构建、scriptApi、精确 Node/V8 和能力；旧代理不自动承接新任务，也不热混用。
升级前先暂停新任务（压测可设 `maxConcurrentStressJobs=0`），等待所有任务 `executionReleased=true`
且报告已归档，确认代理所有执行后代退出，再停止代理和控制服务并备份控制库、代理账本卷及密钥。
本阶段新增预留表及列使用 `CREATE/ALTER ... IF NOT EXISTS`，旧任务/报告继续保留；这不构成对任意
旧版本数据库的自动迁移承诺。回退须恢复匹配的程序、数据备份和密钥，不能让两个代理共用一个账本目录。

容量、进程拓扑、配置默认值、降额排空及停止语义见[代理部署说明](runner-agent.md)。控制服务仍是
单副本 H2；代理数值预算不等于容器 RSS 硬上限，CPU/内存限制由 Docker/k8s 部署层单独设置。
正式代理控制链要求 HTTPS，可通过[独立代理 Compose 示例](../deploy/runner-agent/README.md)局部挂载
私有 CA，并保留 SAN/证书校验；不得关闭 TLS 校验或修改系统信任来使联验通过。

部署验证使用正式 `Dockerfile` 和 `Dockerfile.agent` 构建出的配套镜像，运行
`node scripts/smoke-runner-agent.mjs`；实际结果、源/产物摘要与限制以本次交付证据为准。
容器停止后先确认真实退出并保留合成账本/日志，再清理本场拥有的临时资源。

## 安全提示

- 普通管理页面可以使用 HTTP；独立代理要求上述 HTTPS 控制身份。公网管理入口应使用 HTTPS。
- `allow-registration` 保持关闭可防止陌生人自建账号；首个管理员引导仅在空库时触发，
  环境变量中的口令在部署后可从 `.env` 移除（重启不影响已建账号）。
