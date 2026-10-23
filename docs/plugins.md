# apicc 本机插件 SDK V1 与作者指南

SDK V1 开放 protocol、auth、assert、importer、reporter 五类贡献。SDK 包版本是 0.1.0，API 主版本是 1，当前宿主产品版本为 0.1.0。插件自己的 version 与 `engines.apicc` 分别声明插件版本及宿主兼容范围；不要把 API 主版本、SDK 包版本和产品版本混为一个数字。

既有内置脚本引擎、存储及其试验入口继续存在，但不属于外部 SDK V1。没有插件时本地核心功能照常工作。没有在线市场、自动安装或热重载。

## 扩展点与消费入口

| 贡献 | SDK 接口 | 实际消费 |
|---|---|---|
| protocol | ProtocolContributionV1 | 现有 http/websocket/soap；用户显式绑定后委托宿主 transport |
| auth | AuthContributionV1 | 现有 bearer/basic/apikey；用户显式绑定后生成认证补丁 |
| assert | AssertContributionV1 | 用例断言 op 使用完整贡献 ID |
| importer | ImporterContributionV1 | 现有导入入口 |
| reporter | ReporterContributionV1 | CLI collection/workflow 的 run/run-workflow --reporters 完整贡献 ID |

suite 与桌面报告选择器仍固定为 html/json/junit，F6 压测报告链不扩展。插件列表出现 reporter 不代表这些选择器可以选择它。

## 生成和构建作者工程

```powershell
apicc create-plugin apicc-plugin-demo --dir C:/your/author-projects
```

命名建议使用 apicc-plugin- 前缀，省略只警告。生成器保留包名原输入，以完整小写包名派生 `local.<包名>` 命名空间；不能构成合法 V1 命名空间的名字在写入前拒绝，不剥除字符以免撞名。目标目录存在时拒绝，不覆盖已有文件。

生成物包括 package.json、静态 apicc-plugin.json、src/index.ts、作者契约测试、tsconfig 和 README。以 apicc-plugin-demo 为例，贡献 ID 为 `local.apicc-plugin-demo/assert.has-field` 与 `local.apicc-plugin-demo/reporter.text`。单一生成元数据输出静态清单及模块 manifest；修改声明后保持二者一致。生成入口固定为 dist/index.js，不经 JSON import 改变 rootDir 或输出结构。

首版 SDK 使用本地 pack。在 apicc 仓库先执行：

```powershell
pnpm -C packages/plugin-sdk build
pnpm -C packages/plugin-sdk pack --pack-destination ../../local/f7a-author-sdk-20261023
```

然后在作者目录安装该实际 tarball 的绝对路径：

```powershell
pnpm add -D "C:/path/to/apicc/local/f7a-author-sdk-20261023/apicc-plugin-sdk-0.1.0.tgz"
pnpm install
pnpm build
pnpm test
```

SDK 的 peer/dev 版本为 ^0.1.0；本地作者 dev 依赖指向上述 tarball。构建工具沿用 TypeScript 5.9.2、Vitest 4.1.11、@types/node 26.4.0，Node >=22.19.0。本流程不执行 npm 发布。完整作者例子位于 `examples/plugin-sdk-v1`；源码只从 SDK 导入公开类型，不依赖 Core。

作者测试使用 `@apicc/plugin-sdk/testing` 的 checkPluginContract 实际执行 setup 并校验清单/注册对应，再实际调用断言。helper 不会代作者执行有副作用的 protocol/reporter；作者需自行验证回调行为。示例文本 reporter 读取 ReportView.rows，分别展示可选 logical/requestFacts；逻辑恢复通过不代表原执行行零失败。输入只来自本次运行已有 evidence 投影策略，V1 不提供新增凭据访问或输出净化算法。

## 静态清单与用户登记

包根目录必须有 apicc-plugin.json，package exports 暴露 `./apicc-plugin.json`，files 包含清单与 dist。结构示例：

```json
{
  "manifestVersion": 1,
  "id": "local.apicc-plugin-demo",
  "name": "apicc-plugin-demo",
  "version": "0.1.0",
  "apiVersion": 1,
  "engines": { "apicc": ">=0.1.0 <0.2.0" },
  "entry": "./dist/index.js",
  "capabilities": ["assert", "reporter"],
  "contributions": [
    { "kind": "assert", "id": "local.apicc-plugin-demo/assert.has-field" },
    { "kind": "reporter", "id": "local.apicc-plugin-demo/reporter.text" }
  ]
}
```

用户主动编辑用户级 `~/.apicc/plugins.json`：

```json
{
  "plugins": [{ "source": "C:/your/author-projects/apicc-plugin-demo", "config": {} }]
}
```

source 支持已安装包名、本地包根目录或 apicc-plugin.json 文件；相对路径以用户清单所在目录（通常 ~/.apicc）为基准，绝对路径按原位置使用。旧字符串登记也可指向 V1 包。只登记 dist 目录而该处没有清单会被拒绝。

config 只放 configSchema.fields 声明的非敏感 string/number/boolean/enum 参数；未声明 schema 只接受空对象，未知字段或类型不符拒绝。不要把口令、token 或私钥存入 config，凭据使用宿主已有凭据入口。停用单项可用 `{ "source": "...", "enabled": false }`。

协议/认证贡献需要用户在顶层 bindings 显式选择；键名为复数 protocols/auths（内部 registry 字段不属于用户格式）：

```json
{
  "plugins": [{ "source": "C:/your/trusted-protocol-plugin", "config": {} }],
  "bindings": {
    "protocols": { "http": "example.transport/protocol.http" },
    "auths": { "bearer": "example.transport/auth.bearer" }
  }
}
```

这段是假定已提供相应贡献的协议插件配置，不能用于只有 assert/reporter 的 demo。只支持既有协议与认证 kind，未绑定时使用内置实现；不会自动替换内置能力。

```bash
apicc plugins list
apicc run groups/<groupId>/projects/<projectId>/collections/<collectionId> --env dev --reporters local.apicc-plugin-demo/reporter.text
```

## 诊断、升级与信任

清单版本、API、宿主范围、不支持能力和静态冲突在 import/setup 前检查；plugins list 显示可读原因与诊断 code。同步 setup 必须恰好注册声明贡献，抛错、返回 Promise 或注册无效均撤销整次贡献，避免半注册。其他插件仍可加载；任意受信插件代码造成的外部副作用无法回滚。

无清单试验插件需要新增 V1 清单、公开 SDK 的 definePlugin/context.register，迁移旧 name/version/setup 与 ctx.registry 注册方式；不能继续以 Core 内部类型作为外部契约。清单和模块 manifest 必须一致。修改插件、配置或构建产物后重启 CLI/桌面生效；`--no-plugins` 可关闭加载。

登记插件表示信任它以本机用户权限运行代码。它不是沙箱，setup 及回调可访问 Node 文件系统、网络和环境。加载器只消费用户主动登记的本机插件，不从项目、导入资产或工作区自动安装/加载；团队可分享操作说明，由每个用户主动登记。包名必须已安装，source 不会触发下载；本机摘要用于运行身份核对，不等于 npm 全依赖闭包签名或权限隔离。
