# 推送前 CI 覆盖门禁

在 **已提交且干净** 的 Windows 工作区运行：

```powershell
pwsh -NoProfile -File scripts/pre-push-ci.ps1
```

前提：Node 22.19.0、pnpm 11.21.0、`JAVA_HOME` 指向 JDK 21；Docker Desktop 的 Linux engine 与 `docker compose` 可用。缺任一前提、命令非零退出或证据缺失均视为失败。

入口先校验工具版本、执行 `pnpm install --frozen-lockfile`，随后运行现有 `test-all.ps1` 和 Windows `dist:dir` / `smoke:dir`。Linux 阶段用当前已提交 HEAD 创建 git bundle，在独占 Docker volume 中分别干净检出，依次运行与 `.github/workflows/ci.yml` 同一 `scripts/ci-stage.mjs` 入口：包构建与测试、Java 组合测试、品牌门禁。Docker daemon 与测试容器共用 volume 的真实绝对挂载路径，供嵌套代理容器读取同一份本地夹具和临时夹具。随后 Windows 宿主用同一共享阶段入口构建三款 Linux 镜像并运行部署冒烟；部署脚本访问 Docker 发布在宿主 `127.0.0.1` 的端口。CI 中的 Windows 打包 job 保持仅 `main` 推送触发，本地推送前入口每次都覆盖它。

每次运行在 `local/ci88-fix/pre-push-*/` 留下候选 bundle、每阶段完整日志、结构化 `receipt.json`，以及白名单复制的 Linux Maven XML、F7f 组合结果和压测诊断。部署 JSON 从宿主 `local/` 中按冒烟前后的路径差集辨认，只有本次新生成且 `passed=true` 的文件计入 receipt。即使阶段失败也先收集现有证据，再清理本次独占容器和 volume。最终只有所有阶段、必要证据、清理和再次核对的同一干净 HEAD 均成立，receipt 才标记通过。Windows 全量的鲜 Maven XML 由 `test-all.ps1` 留在其输出的 `local/full-gate/` 路径。

此门禁覆盖 CI 的可执行阶段，但本机 Docker Linux 镜像和 GitHub runner 仍可能有 OS 补丁、网络、缓存、配额与负载差异。CI 专属的 checkout、工具安装、缓存和失败产物上传仍由 Actions 执行。失败产物只上传允许的诊断 JSON；F7f 组合仅上传 `facts.json`、`cleanup.json`、`result.json`。
