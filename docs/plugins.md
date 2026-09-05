# apicc 插件市场索引与发布指南

apicc 的一切能力（协议客户端、认证器、断言操作符、脚本引擎、报告器、导入器、存储适配器）都是插件。本文档是去中心化插件生态的 MVP 索引：命名约定 + 精选索引 + 发布指南。**中心化市场服务与在线安装明确推迟**（M7 规格 §4）——安装（`npm install`）由用户自行执行，加载器只认已安装的包名或本地路径。

## 插件能扩展什么

经 `PluginDefinition { name, version, setup(ctx) }` 契约（M1 规格 §5），插件可在 `setup` 内注册：

| 扩展点 | 注册 API | 消费面 |
|---|---|---|
| 协议客户端 | `registerProtocol` | 接口执行按协议分发 |
| 认证器 | `registerAuth` | 请求认证 |
| 断言操作符 | `registerAssert` | 用例断言 `op` |
| 脚本引擎 | `registerScriptEngine` | 脚本断言/前置后置 |
| 报告器 | `registerReporter` | `--reporters <格式>` |
| 导入器 | `registerImporter` | `apicc import` |
| 存储适配器 | `registerStorage` | 工作区读写 |

## 命名约定

- npm 包名以 **`apicc-plugin-`** 为前缀（如 `apicc-plugin-junit-extended`）；`apicc create-plugin` 生成的脚手架已遵循，未带前缀仅警告不阻断（约定非强制）。
- package.json **keywords 包含 `apicc-plugin`**——npm 检索 `keywords:apicc-plugin` 即为事实上的插件目录。
- 包默认导出或具名导出 `plugin` 满足 `PluginDefinition` 形状（name/version 字符串、setup 函数），加载器经形状校验后注册。

## 精选索引（首发）

| 插件 | 说明 | 获取 |
|---|---|---|
| `create-plugin` 官方脚手架模板 | 示例断言操作符 `hasField` + 纯文本报告器，开箱可开发 | `apicc create-plugin apicc-plugin-demo --dir <目录>` 本地生成（未发布 npm） |

收录标准（后续按此扩表）：遵循命名约定、契约测试自检通过、README 完整、维护者可联系。

## 发布指南

```bash
apicc create-plugin apicc-plugin-<你的插件> --dir .
cd apicc-plugin-<你的插件>
pnpm install      # 拉取 @apicc/core（peer）与构建/测试工具
pnpm build        # tsc 编译 src → dist
pnpm test         # 契约自检：PluginDefinition 形状校验，发布前必须通过
npm publish
```

发布后，使用方在**用户级清单**登记包名（或在发布前用本地路径试用）：

```json
{ "plugins": ["apicc-plugin-<你的插件>"] }
```

本地路径试用时登记构建产物（如 `D:/path/to/apicc-plugin-demo/dist`），相对路径相对清单文件所在目录解析。用 `apicc plugins list` 验证已加载与贡献计数；用 `--no-plugins` 可随时禁用加载（逃生开关）。单个插件加载失败（包损坏、形状不符、setup 抛错）会被隔离为诊断信息，不阻断启动，也不会影响其余插件。

## 信任模型（务必阅读）

- **登记插件 = 在本机以你的用户权限运行其代码。** 插件不是沙箱：`setup` 与后续回调拥有 Node 进程的完整能力（文件系统、网络、环境变量）。只安装与登记你信任的插件，如同信任任何 npm 依赖。
- **清单仅支持用户级 `~/.apicc/plugins.json`，不支持工作区级。** 这是明确的安全边界（M7 规格 D1）：工作区文件随 Git 仓库分发，若支持「克隆即加载」，攻击者可在仓库里放入恶意清单，让任何克隆者在启动 apicc 时执行任意代码——这是典型的供应链陷阱。团队需要共享插件配置时，请把登记步骤写入项目 README，由开发者自行完成用户级登记。
- npm 包名解析走标准 Node 解析链（须已安装）；本地路径插件不做任何校验和/签名（M7 规格 §4 明确推迟），路径即信任。
