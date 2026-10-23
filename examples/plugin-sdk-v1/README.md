# apicc-plugin-demo

SDK V1 本地作者包：断言 `local.apicc-plugin-demo/assert.has-field` 与文本报告器 `local.apicc-plugin-demo/reporter.text`。
API 主版本为 1；SDK 包为 0.1.0；宿主产品当前为 0.1.0，兼容范围由清单 engines.apicc 声明。

## 构建与测试

先在 apicc 仓库构建 SDK 并本地 pack（不发布）：

```powershell
pnpm -C packages/plugin-sdk build
pnpm -C packages/plugin-sdk pack --pack-destination ../../local/f7a-author-sdk-20261023
```

在本作者目录安装该实际 tarball 的绝对路径；SDK 尚未发布时不要依赖 npm 下载：

```powershell
pnpm add -D "C:/path/to/apicc/local/f7a-author-sdk-20261023/apicc-plugin-sdk-0.1.0.tgz"
pnpm install
pnpm build
pnpm test
```

源码只导入公开 SDK，无需 Core。build 保持入口 dist/index.js；静态清单与源码 manifest 必须一致，作者测试会比较二者并实际调用断言。

## 本地登记与执行

由用户主动在用户级 `~/.apicc/plugins.json` 登记包根目录（包含 apicc-plugin.json）：

```json
{ "plugins": [{ "source": "C:/path/to/apicc-plugin-demo", "config": {} }] }
```

source 也可为已安装包名或 apicc-plugin.json 文件；相对路径以用户清单所在目录为基准。
本例未声明 configSchema，只接受空 config；自定义配置仅用于已声明的非敏感参数，凭据沿宿主的既有凭据入口。
修改清单/配置/构建产物后重启 CLI 或桌面生效。不会自动安装或从工作区加载插件。

```bash
apicc plugins list
apicc run groups/<groupId>/projects/<projectId>/collections/<collectionId> --env dev --reporters local.apicc-plugin-demo/reporter.text
```

reporter 的自由格式 ID 目前仅支持 CLI collection/workflow（run/run-workflow）；suite 与桌面选择器仍固定 html/json/junit，F6 压测报告链不扩展。
文本分别展示执行行、可选逻辑结果及请求事实；逻辑恢复通过不会抹掉执行行失败。输入是宿主按本次运行策略投影的 ReportView，不是私密凭据访问入口。
协议/认证贡献仅在用户 bindings.protocols / bindings.auths 显式绑定现有 kind 后启用，默认保持内置。

登记表示信任插件以本机用户权限执行；它不是沙箱。SDK V1 只开放 protocol/auth/assert/importer/reporter，不包含既有 scriptEngine/storage 试验入口。
加载器在执行前检查静态清单、API/宿主范围和冲突；不兼容或缺清单会在 plugins list 给出诊断。setup 必须同步，失败会撤销本次贡献，避免半注册；无法回滚插件任意外部副作用。
旧无清单试验插件须迁移到 V1 静态清单、definePlugin 和 context.register；不再直接注册 Core registry。可用 --no-plugins 关闭本机插件。
本流程只本地构建、pack 和主动登记，不执行 npm 发布或自动安装。更多见 apicc 仓库 docs/plugins.md。
