# apicc 服务端

在线协作服务端（Spring Boot 3 + H2）：账号、工作区、成员与 ACL 管理，工作区文件同步（推送 / 拉取）。与本地优先模式互补——工作区内容（含文件版本字节）统一存于 H2 元数据库（`file_versions.content` 列），经桌面端在线模式读写。

## 环境要求

- **JDK 21**：`JAVA_HOME` 须指向 JDK 21（Windows 示例 `set JAVA_HOME=C:\Program Files\Java\jdk-21`）。PATH 里的 `java` 若低于 21，服务端无法启动。
- **Maven**：推荐直接用仓库自带 wrapper（`server/mvnw` / `server/mvnw.cmd`，首次运行自动下载钉版的 Maven 3.9.9，无需预装）；也可使用本机自备的 `mvn`。
- **镜像**：所有 mvn 命令统一以 `-s` 指向 `server/.mvn/settings.xml`（Maven Central 一律走 Aliyun public 镜像）。wrapper 的 Maven 分发包取 Aliyun central 仓库同构件 URL（`https://maven.aliyun.com/repository/central/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip`，sha256 已钉在 `server/.mvn/wrapper/maven-wrapper.properties`）——官方 archive.apache.org 的该归档路径已 404，勿改回。

## 测试与打包

```bash
# 任意目录、本机 mvn（CI 同口径）
mvn -s server/.mvn/settings.xml -f server/pom.xml test

# 或经 wrapper（在 server 目录内）
cd server
./mvnw -s .mvn/settings.xml test          # Windows：mvnw.cmd -s .mvn/settings.xml test
```

```bash
# 打出可执行 jar（spring-boot repackage 产物：target/apicc-server-*.jar）
mvn -s server/.mvn/settings.xml -f server/pom.xml -DskipTests package
```

## 启动

默认监听 **8080** 端口。三种方式任选：

```bash
# 1. 本机 mvn 直接运行
mvn -s server/.mvn/settings.xml -f server/pom.xml spring-boot:run

# 2. wrapper 运行（server 目录内）
cd server && ./mvnw -s .mvn/settings.xml spring-boot:run

# 3. 打包后以 jar 运行
java -jar server/target/apicc-server-0.1.0-SNAPSHOT.jar
```

就绪自检：`GET /api/v1/ping` 返回 `{"status":"ok"}`。

容器化部署（Docker Compose / k8s，含首个管理员引导与数据卷说明）见 [docs/deploy.md](../docs/deploy.md)。

## 配置项

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `server.port` | `8080` | HTTP 监听端口 |
| `apicc.server.console-dir` | `./console` | 管理后台静态产物目录（相对运行目录；部署见「管理后台部署」节） |
| `apicc.server.allow-registration` | `false` | 是否开放注册；`false` 时仅已有账号可登录（部署线 D5 默认关，批量拉人时临时开启） |
| `apicc.server.admin-username` | 空 | 首个管理员用户名（部署线 D6：仅用户表为空时生效；未设则 `admin`） |
| `apicc.server.admin-password` | 空 | 首个管理员口令；未设则随机生成并以 WARN 打印日志（仅一次） |
| `apicc.server.token-ttl-days` | `30` | 登录令牌有效期（天） |
| `apicc.id-generation` | `identity` | 实体 id 生成策略；仅接受 `identity`（数据库自增，其他值启动即失败）。外部策略（如雪花）不走此开关，提供自定义 `IdGeneration` Bean 覆盖 |

覆盖方式为命令行参数 `--配置键=值`（或改 `server/src/main/resources/application.yml`）。注意：`apicc.server.*` 三项经 `@Value` 按精确键名注入，Boot 的驼峰 relaxed binding 不适用，但下划线大写风格的环境变量可用（Spring 会做 `.`/`-` → `_` 的名称翻译，如 `APICC_SERVER_CONSOLE_DIR`、`APICC_SERVER_ALLOW_REGISTRATION`、`APICC_SERVER_TOKEN_TTL_DAYS`；`SERVER_PORT` 等标准变量仅对 `server.port` 生效）：

```bash
java -jar server/target/apicc-server-0.1.0-SNAPSHOT.jar \
  --server.port=9090 \
  --apicc.server.allow-registration=false
```

## 数据目录

默认 `./server-data/`（相对 java 进程的运行目录），**只放一个文件**：

```
server-data/
└── metadata.mv.db            # H2 元数据库（单文件）：用户 / 令牌 / 工作区 / 分组 / 项目 / ACL / 文件版本（含内容字节）
```

工作区内容不再是磁盘目录树：文件字节存在元数据库 `file_versions.content` 列里，内容经桌面端在线模式读写，形态由服务端管理。

两点注意：

- 元数据库路径固定按 `jdbc:h2:file:./server-data/metadata`（相对运行目录）解析；需整体挪机时建议停服后连同运行目录一起处理，或同步改 `application.yml` 的 datasource url（或以 `SPRING_DATASOURCE_URL` 环境变量覆盖）。
- 备份 = 停服快照 `server-data/metadata.mv.db`（H2 建议停服拷贝，避免写入中途取到不一致快照；或直接备份整个 `server-data/` 目录——里面只有这一个文件）。

**未发布阶段（0.x）不做数据迁移**：schema / 数据目录结构变更均不做迁移与兼容——生产化前的破坏性变更都走「删库重开」口径。特别地，2026-09 起实体主键已由 UUID 字符串（VARCHAR(36)）改为数字（BIGINT IDENTITY，对外 JSON 字符串化）：幂等 DDL（`CREATE TABLE IF NOT EXISTS`）**不会重建已存在的旧表**，旧库直接起新版不一定在启动期报错，但运行期写入会因列型不兼容报错或产生混合形态脏数据——从旧版本升级，必须删除 `server-data/`（或换一个全新的运行目录）重开，不要沿用旧库。

## 管理后台部署

服务端自带 Web 管理后台（SPA）静态托管：同一进程同时服务 `/api/**` 与控制台页面。产物外置于磁盘目录，可独立于 jar 更新。

1. **构建控制台**（仓库根目录执行）：

   ```bash
   pnpm -C apps/admin-web install
   pnpm -C apps/admin-web build
   ```

2. **放置产物**：把构建产物放入 **jar 运行目录**的 `console/` 下（与 `server-data/` 同级，即 `apicc.server.console-dir` 默认值指向的位置）：

   ```bash
   mkdir -p console
   cp -r apps/admin-web/dist/. console/
   ```

3. **验证**：浏览器访问 `http://<主机>:<端口>/` 出现控制台页面；`/workspaces` 等 SPA 深链同样返回 `index.html`（html 响应带 `Cache-Control: no-cache`，替换产物后刷新即见新版本）。

注意：

- `console/` 缺失（目录不存在或无 `index.html`）时，`/` 与控制台深链返回 404 `{"code":"console_not_found",...}` 及引导文案；`/api/**` 完全不受影响。启动期不扫描该目录——产物在运行中放入 / 替换即时生效，无需重启。
- 产物目录可用 `--apicc.server.console-dir=<路径>`（或环境变量 `APICC_SERVER_CONSOLE_DIR`）改指向，相对运行目录或绝对路径均可。
- **开发模式替代方案**：`pnpm -C apps/admin-web dev` 启动 vite dev server，其已按约定把 `/api` 代理到本地服务端 `http://localhost:8080`——无需构建产物，本地起一个服务端即可前后端联调。
- **勿用符号链接放置产物**：静态解析的目录越界校验按 URL 路径前缀比较，`console/` 内的符号链接若指向目录之外，目标内容仍会被读出；请用普通目录复制放置，且不要让 `console/`（或其内部条目）以 symlink 指向敏感位置。

## 与桌面端对接

桌面端在线模式的「服务器地址」填 `http://<主机>:<端口>`（本机默认即 `http://127.0.0.1:8080`，末尾斜杠可省略）。注册账号 → 登录 → 创建工作区或以成员身份加入 → 即可在桌面端推送 / 拉取工作区文件。跨机部署时放行服务端端口即可，客户端无需额外配置。
