# apicc 服务端

在线协作服务端（Spring Boot 3 + H2）：账号、工作区、成员与 ACL 管理，工作区文件同步（推送 / 拉取）。与本地优先模式互补——数据仍以 Git 友好的文本文件存于服务端数据目录。

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

## 配置项

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `server.port` | `8080` | HTTP 监听端口 |
| `apicc.server.data-dir` | `./server-data` | 工作区内容根目录（相对 java 进程的运行目录） |
| `apicc.server.allow-registration` | `true` | 是否开放注册；`false` 时仅已有账号可登录 |
| `apicc.server.token-ttl-days` | `30` | 登录令牌有效期（天） |

覆盖方式为命令行参数 `--配置键=值`（或改 `server/src/main/resources/application.yml`）。注意：`apicc.server.*` 三项经 `@Value` 按精确键名注入，不支持环境变量的 relaxed binding（`SERVER_PORT` 等 Spring 标准变量仅对 `server.port` 有效）：

```bash
java -jar server/target/apicc-server-0.1.0-SNAPSHOT.jar \
  --server.port=9090 \
  --apicc.server.data-dir=D:/apicc-data \
  --apicc.server.allow-registration=false
```

## 数据目录

默认 `./server-data/`（相对 java 进程的运行目录）：

```
server-data/
├── metadata.mv.db            # H2 元数据库：用户 / 工作区 / 成员 / ACL / 文件版本
└── workspaces/<工作区id>/     # 工作区内容：与本地工作区同构的文本树（纯文本、可 Git）
```

两点注意：

- 元数据库路径固定按 `jdbc:h2:file:./server-data/metadata`（相对运行目录）解析，**不随** `apicc.server.data-dir` 迁移；需整体挪机时建议停服后连同运行目录一起处理，或同步改 `application.yml` 的 datasource url。
- 备份即备份 `server-data/`（H2 建议停服拷贝，避免写入中途取到不一致快照）。

## 与桌面端对接

桌面端在线模式的「服务器地址」填 `http://<主机>:<端口>`（本机默认即 `http://127.0.0.1:8080`，末尾斜杠可省略）。注册账号 → 登录 → 创建工作区或以成员身份加入 → 即可在桌面端推送 / 拉取工作区文件。跨机部署时放行服务端端口即可，客户端无需额外配置。
