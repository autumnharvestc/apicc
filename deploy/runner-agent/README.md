# 独立代理的 HTTPS 部署示例

从仓库根构建 `docker build -t apicc-server:local .` 与 `docker build -f Dockerfile.agent -t apicc-runner-agent:local .`。代理采用精确 Node 22.19.0 Debian bookworm slim；不能改为浮动大版本后假定仍通过准入。

控制镜像构建默认使用 npm 官方 registry。网络受限时可显式传入 `--build-arg APICC_NPM_REGISTRY=https://registry.npmmirror.com`；仍使用同一 frozen lockfile 的版本与完整性校验，不重解算或关闭 TLS。交付时记录实际来源和镜像摘要。

复制 `agent.env.example` 到部署目录的私有文件，替换占位值。凭据、32 字节原始 AES 主密钥、TLS PKCS12、独立 CA、代理登记后 token 和配置 JSON 均独立挂载，不写入镜像。`control.p12` 服务证书 SAN 须包含用户访问域名、代理访问域名和健康检查的 `localhost`；`control-ca.pem` 为签发 CA。控制服务健康检查使用该局部 CA，代理同样保留证书校验。

通过管理台创建代理并生成一次性登记材料，向 `/api/v1/runner/enroll` 提交 `{"enrollmentToken":"REPLACE"}`，将返回的 `agentToken` 保存为受限文件。登记材料只用一次，不能作为长期 token。管理台完成工作区授权、项目分配和项目关联后才可派发。

配置文件示例（机器配置允许 JSON）：

```json
{
  "baseUrl": "https://control.example.test:8443/api/v1",
  "agentId": "REPLACE_WITH_ENTITY_ID",
  "tokenFile": "/run/apicc/agent-token",
  "dataDirectory": "/data",
  "trustedCaFile": "/run/apicc/control-ca.pem"
}
```

`baseUrl` 必须与控制服务 `APICC_EXECUTION_CONTROL_BASE_URL` 完全一致；Compose 内可把服务别名配置为证书 SAN 内域名。示例端口只绑定 loopback；向团队开放时按部署网络要求设置监听和访问控制。

从本目录运行 `docker compose --project-name apicc-runner --env-file /absolute/private/agent.env up -d`。默认普通 HTTP 旧部署继续可用；本例单独覆盖 SSL 与健康检查配置。代理使用 `init:true`、独立数据卷与可写临时目录，不能复用另一个代理的账本卷。直接运行镜像时加 `--init`，由 PID 1 转发退出信号并回收子进程。

`APICC_AGENT_TMPFS_SIZE` 控制父进程和子进程共用的 `/tmp` 临时材料容量，默认 `4g`，不是预占 4 GiB 内存。实际使用计入容器/宿主内存，需按部署预算配置；不能把临时目录设得小于默认 512 MiB 可用磁盘地板。默认容量覆盖父/子两份材料暂存、1 GiB 输入缓存上限与地板余量；提高输入缓存、单次输入或并发时应重新核对同时暂存量并增配容量及内存限制。父子必须保持同一临时路径和可写挂载，不通过降低安全地板掩盖容量不足。

升级前暂停接收新任务并等待执行释放、结果归档，停止代理后备份控制数据卷、代理数据卷和单独的主密钥/证书；记录镜像摘要与 Core 构建身份。回滚使用此前同身份的镜像和匹配备份，先停稳当前实例，禁止两个进程共用代理数据目录。重启不会自动重跑业务；未确认结果由账本补传。主密钥丢失不能恢复已加密凭据。

详细能力、限制、配置单位和验证入口见 [代理说明](../../docs/runner-agent.md)。
