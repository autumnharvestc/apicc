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
| `SPRING_DATASOURCE_URL` | 容器内已设 `jdbc:h2:file:/data/metadata` | 元数据库地址。镜像内置为卷内绝对路径（源码默认 `./server-data/metadata` 依赖运行目录，容器内不适用） |

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

数据库 schema 为幂等 DDL（`CREATE TABLE IF NOT EXISTS`），启动时自动就位，无独立迁移步骤。
**未发布阶段（0.x）schema 变更不做迁移**：升级后启动若报结构类错误（旧版布局 / 未知列等），
删数据卷重开——compose 执行 `docker compose -f deploy/docker-compose.yml down -v`（连同卷删除，
随后照常 `up -d --build` 并重新引导管理员）；k8s 删除 PVC 中的数据或重建 PVC。

## 安全提示

- HTTPS/TLS 终结本期未含（明文 HTTP）；公网暴露请置于反代/网关之后（Ingress 支持后置）。
- `allow-registration` 保持关闭可防止陌生人自建账号；首个管理员引导仅在空库时触发，
  环境变量中的口令在部署后可从 `.env` 移除（重启不影响已建账号）。
