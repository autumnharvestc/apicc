# @apicc/plugin-sdk

apicc 本机插件的公开 SDK，包版本 0.1.0、API 主版本 1。当前宿主产品版本为 0.1.0；插件通过静态清单 `engines.apicc` 单独声明宿主兼容范围。这三个版本各有用途，不能互相替代。

本包无运行时依赖，不导入或重新导出 Core、Electron 或内部资源句柄。Node.js 要求 >=22.19.0。

## 本地作者流程

SDK 首版仅使用本地 tarball；不会自动安装或发布到 npm。在 apicc 仓库执行：

```powershell
pnpm -C packages/plugin-sdk build
pnpm -C packages/plugin-sdk pack --pack-destination ../../local/f7a-author-sdk-20261023
apicc create-plugin apicc-plugin-demo --dir C:/your/author-projects
```

在生成的作者工程中安装实际 tarball 的绝对路径，然后构建、自检：

```powershell
pnpm add -D "C:/path/to/apicc/local/f7a-author-sdk-20261023/apicc-plugin-sdk-0.1.0.tgz"
pnpm install
pnpm build
pnpm test
```

仓库的 `examples/plugin-sdk-v1` 是相同结构的完整例子。作者包保留 SDK 的 peer/dev 依赖，不需要 Core；本地安装会将 dev 依赖解析到 tarball。

## 公开入口

`@apicc/plugin-sdk` 导出纯 DTO 类型、`definePlugin`、`validatePluginManifest`、`validatePluginConfig` 和 `validatePluginContribution`。V1 贡献类型为 protocol、auth、assert、importer、reporter；既有 scriptEngine/storage 试验 API 不属于 SDK V1。

`@apicc/plugin-sdk/testing` 提供 `checkPluginContract`。它实际执行同步 setup，校验声明与注册是否对应，并返回收集到的贡献供作者调用；不会代作者执行具有副作用的 protocol/reporter。

生成包中下面的作者测试可直接执行：

```ts
import { expect } from "vitest";
import { checkPluginContract } from "@apicc/plugin-sdk/testing";
import { plugin } from "../src/index.js";

const checked = checkPluginContract(plugin, { config: {} });
expect(checked.problems).toEqual([]);
const assertion = checked.contributions.find(item => item.kind === "assert");
if (assertion?.kind !== "assert") throw new Error("示例断言未注册");
expect(assertion.evaluate({ id: 1 }, "id", { found: true, getModel: () => undefined }).pass).toBe(true);
```

## 静态清单与运行

作者包根目录需有 `apicc-plugin.json`，并通过 package exports 暴露 `./apicc-plugin.json`。其 entry 为 `./dist/index.js`，模块 manifest 必须与静态清单一致；setup 同步调用 `context.register`。生成器由同一元数据对象输出两份声明，作者测试核对一致性。

用户主动在 `~/.apicc/plugins.json` 的 plugins 中添加 `{ "source": "C:/path/to/plugin", "config": {} }`。source 支持已安装包名、本地包根目录或清单文件；相对路径以用户清单所在目录为基准。config 只容纳 configSchema 已声明的非敏感参数；未声明 schema 时只接受空对象。协议/认证仅经用户 `bindings.protocols` / `bindings.auths` 对已有 kind 显式绑定启用，默认使用内置实现。

`apicc plugins list` 显示准入诊断与贡献计数；修改后重启宿主生效。无清单的旧试验插件须补 V1 清单并迁移到公开 SDK 的 definePlugin/context.register。API、宿主范围或静态冲突在执行模块前拒绝；同步 setup 失败则撤销整次注册，诊断保留，不能回滚任意外部副作用。

文本 reporter 应读取 ReportView.rows，并分别展示可选 logical/requestFacts。逻辑恢复成功不能抹去执行行失败；输入始终来自该次运行已有 evidence 输出策略的投影，没有新增凭据 API。自由 reporter ID 当前只支持 CLI collection/workflow；suite 与桌面仍采用 html/json/junit 固定枚举，F6 压测报告链不扩展。

登记插件意味着信任其以你的本机用户权限执行，插件不是沙箱。不会从工作区自动安装或加载插件。完整说明见 apicc 仓库 `docs/plugins.md`。
