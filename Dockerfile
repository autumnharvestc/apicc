# apicc 服务端镜像（部署线 D2，规格 docs/superpowers/specs/2026-09-06-apicc-server-deploy-design.md）
# 多阶段：node 构建管理后台 dist → maven 打服务端 fat jar → jre-alpine 非 root 运行。
# 构建上下文 = 仓库根：docker build -t apicc-server:local .

# —— 阶段 1：管理后台静态产物（pnpm 与仓库同版本，pnpm-workspace.yaml 的 allowBuilds 同步生效）——
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS console
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
# 拷贝全部工作区清单（pnpm-lock 记账含各 importer，缺包目录会使 --frozen-lockfile 失败），
# 经 --filter 只安装 admin-web 依赖链，桌面端/CLI 依赖不落入本阶段
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/ apps/
COPY packages/ packages/
COPY server/src/main/resources/execution-input-boundary.json server/src/main/resources/execution-input-boundary.json
ENV npm_config_verify_deps_before_run=false
ARG APICC_NPM_REGISTRY=https://registry.npmjs.org
RUN --mount=type=cache,id=apicc-pnpm11,target=/root/.local/share/pnpm/store pnpm --config.verify-deps-before-run=false --filter @apicc/admin-web... install --frozen-lockfile --registry="$APICC_NPM_REGISTRY" \
 && pnpm --config.verify-deps-before-run=false -C packages/plugin-sdk build \
 && pnpm --config.verify-deps-before-run=false -C packages/core build \
 && pnpm --config.verify-deps-before-run=false -C packages/execution build \
 && pnpm --config.verify-deps-before-run=false -C packages/execution check:java-input-schema \
 && pnpm --config.verify-deps-before-run=false -C apps/admin-web build

# —— 阶段 2：服务端 fat jar（settings.xml 为阿里云镜像——Maven Central 不可达环境约束）——
FROM maven:3.9-eclipse-temurin-21 AS server
WORKDIR /build
COPY server/pom.xml ./
COPY server/.mvn/ .mvn/
RUN mvn -s .mvn/settings.xml -B -q dependency:go-offline
COPY server/src ./src
RUN mvn -s .mvn/settings.xml -B -q package -DskipTests

# —— 阶段 3：运行镜像（固定 uid/gid 10001，k8s securityContext/fsGroup 对齐）——
FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S -g 10001 apicc && adduser -S -u 10001 -G apicc apicc \
 && apk add --no-cache curl ca-certificates \
 && mkdir -p /data /app/console && chown -R apicc:apicc /data /app
COPY --from=server /build/target/apicc-server-*.jar /app/app.jar
COPY --from=console /build/apps/admin-web/dist/ /app/console/
USER apicc
ENV SERVER_PORT=8080 \
    APICC_SERVER_DATADIR=/data \
    APICC_SERVER_CONSOLEDIR=/app/console \
    # 元数据库 url 原为相对运行目录的 ./server-data/metadata（server/README「数据目录」节），
    # 容器内固定为卷内绝对路径，不依赖进程 cwd
    SPRING_DATASOURCE_URL=jdbc:h2:file:/data/metadata
# H2 文件库 + 工作区内容全在此卷；单容器单副本（D1）
VOLUME /data
EXPOSE 8080
# 健康探测复用无认证 ping 端点（D8）；shell 形态使 SERVER_PORT 运行时展开
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD url="${APICC_HEALTHCHECK_URL:-http://127.0.0.1:${SERVER_PORT}/api/v1/ping}"; if [ -n "$APICC_HEALTHCHECK_CA_FILE" ]; then curl --fail --silent --show-error --cacert "$APICC_HEALTHCHECK_CA_FILE" "$url"; else curl --fail --silent --show-error "$url"; fi
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
