# F2b-B2 本机网络配置实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。用户已集中批准整阶段，按依赖顺序执行，步骤使用复选框跟踪。

**目标：** 本机代理、自定义 CA 和 PEM mTLS 真正进入 HTTP 请求，桌面与 CLI/集合/流程/压测共享准备语义。

**架构：** Core 定义私有配置与运行绑定端口，宿主从本机文件配置和 SecretStore 捕获一次；HttpRuntimeOptions 装配解析后的传输，不污染契约/请求设置。undici Agent/ProxyAgent 消费运行绑定，有界缓存和正常回收。

**技术栈：** TypeScript/Zod、Node fs/tls、已锁定 undici 8.10.1、现有 SecretStore、Electron/Vue、Vitest。

**规格：** [F2b 设计](../specs/2026-10-15-apicc-f2b-debug-workbench-design.md) §5、§7–8。2026-10-16 B1工程与独立复审核验通过，B2任务1/2工程与独立审核完成，接续任务3；B1真实窗口/G及已登记Minor仍未验，不以此视为关闭。

## 全局约束

- 开发 Luna xhigh，独立审核 Sol xhigh；单写入者，不自动 Git 集成。
- 私有根 `join(homedir(), '.apicc', 'private', 'network', 'v1')`，测试显式注入 owned temp；不读用户已有配置/凭据。
- 证书每文件 1 MiB、每次总量 4 MiB；代理秘密、PEM 私钥、口令用 SecretRef。
- 最多 16 个无在途租用的闲置 dispatcher；活跃请求不逐出、不新设并发上限。
- Node 22.19.0/pnpm 11.21.0；不升级依赖/CI顺序，不恢复 DEF-001。
- 不新增通用代理/PKI框架，非 HTTP 选择未支持配置时明确拒绝。

## 文件与职责

| 动作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `packages/core/src/network/{model,privateStore,prepare,host}.ts` | 严格配置、私有根/文件保存、选中配置准备和共享宿主适配 |
| 新建 | `packages/core/src/http/dispatchers.ts` | Agent/ProxyAgent 创建、键和租用/闲置关闭 |
| 修改 | `packages/core/src/http/client.ts`、`plugin/types.ts` | 每 hop 按 origin 选传输；保持观察、取消、计时和重定向 |
| 修改 | `packages/core/src/{index,shared,schema}.ts` | 类型/纯 Schema 与 Node 宿主导出分离 |
| 修改 | `packages/core/src/runner/{runner,caseExecutor}.ts`、流程/压测现有运行选项装配 | 传递固定运行绑定，不新增独立发包链 |
| 新建 | `apps/desktop/src/main/network.ts`、`src/renderer/src/components/NetworkSettings.vue` | 本机配置 IPC 宿主及项目/环境 UI |
| 修改 | Desktop `main/{ipc,debugController,stressController}.ts`、`shared/{types,channels,ipc-contract}.ts`、`preload/preload.ts` | 选中绑定准备与真实主进程端口 |
| 修改 | Desktop `renderer/src/{App.vue,components/DebugSettings.vue,api/memory.ts,i18n/zh-CN.json,i18n/en.json}` | 配置入口、来源和错误反馈 |
| 修改 | `packages/cli/src/{main,credentials}.ts` | 共用本机配置及启动快照接线，不依赖 Electron |
| 新建 | `packages/core/tests/network/profiles.test.ts`、`tests/http/network.test.ts` | 本机存储/捕获和真实代理/TLS必要集成 |
| 扩展 | Core `tests/http/client.test.ts`、Desktop `tests/main/execution-credentials.test.ts`、CLI `tests/contract-assets.test.ts` | M1/M3与已有跨入口运行 fixture |

先以 `rg` 确认当前流程/压测装配点再最小接线，报告实际路径；不重构不经手的 Runner 算法。证书 fixture 放 `packages/core/tests/fixtures/network/`，只能是专用合成私钥/证书，明显标记不能用于生产；不拷贝用户证书。

## 任务 1：私有配置、选择优先级和固定运行绑定

2026-10-16 工程与独立复审完成：准备端口保留冻结 credentialVersions，完整材料carrier拒绝JSON/structured clone；8项定向测试及Core类型/构建通过，I1/I2闭合，无新增C/I。初轮RED为缺入口，修复轮有实际版本/clone行为RED，报告分别记账。SQLite实验性告警保留。仅端口层完成，不代表真实代理/TLS/运行入口已验收。

**交付物：** 桌面/CLI 共用的纯端口和文件适配器，网络运行材料在准备阶段捕获。

- [x] **1. 新 profiles.test.ts 的最小 RED。** 定义端口并以 owned temp 实测保存重开、expectedRevision 冲突不覆写；profile 模型用判别联合禁止 inactive 分支混入字段。最小公开边界：

```ts
type NetworkScope = {
  canonicalRoot: string;
  project: { workspaceId: string; groupId: string; projectId: string };
  environmentId?: string;
};
interface NetworkProfileStore {
  load(scope: NetworkScope): Promise<{ revision: string; configuration: NetworkConfiguration }>;
  save(scope: NetworkScope, next: NetworkConfiguration, expectedRevision: string): Promise<string>;
}
// NetworkConfiguration: formatVersion=1，命名 profiles、项目/环境选择及精确 origin TLS 项。
// PreparedNetworkRun: readonly revision + resolveForOrigin(URL)；含材料，严禁序列化/IPC。
// prepareNetworkRun({scope, store, secretStore, selection?, signal?}) -> PreparedNetworkRun。
```

选择测试用内存配置给 direct/环境/项目三层：环境显式 direct 必须覆盖项目代理，无绑定才继承；两个同 projectId 不同 group/root 不串。证书准备只读被选中路径，保存后改文件不改变已准备字节；缺文件/非法 PEM/超额拒绝。SecretStore 用已有替身且核对调用次数，无须重跑原生凭据后端准入。
- [x] **2. 跑 `tests/network/profiles.test.ts` 取得最小行为 RED。** 不先安装依赖或构造全部 TLS 服务。
- [x] **3. 实现 model/privateStore/prepare/host。** 保存用临时文件＋原子替换及自有写锁，未知版本/坏配置原件保留且拒绝使用；无 profile 时 lazy，不创建全局 singleton。公开证书/CA按预算捕获，私钥从选中 SecretRef读取。错误只含稳定码、profile标识、无秘密的字段说明。
- [x] **4. GREEN＋Core 类型门和审核。** 保存/重开、修订、完整作用域、优先级、准备固定和一次读取合并成少量测试；不做全组合枚举。记录 B-09/B-10/B-15 的端口层证据，尚非真实代理/TLS验收。

## 任务 2：真实 HTTP 传输与连接池

2026-10-16 工程与独立复审完成：HTTP运行绑定逐hop消费；真实CA/mTLS、跨origin Client A/B、HTTPS代理CONNECT/转发、命名HTTP代理转发及lookup通过，连接池闲置16/活跃租用/close与M3来源标签有定向证据。审核I1代理lookup丢失已修复，复审无新增C/I。最终修复后network1/1与Core类型/构建通过；此前HTTP37/37在最后key补全前，最终key有池/network定向证据，不混称最终全文件重跑。HTTP代理→HTTPS线路未实测、IP-SNI告警及准备后变化的wire层证据仍记G，尚不代表运行入口/UI/全平台验收。

**交付物：** 通过真实本地代理/CA/mTLS 网络服务收到正确请求，缓存/取消不串身份。

- [x] **1. 在 network.test.ts 建最小 owned fixture。** 一个 HTTP 代理支持测试所需转发/CONNECT，一个 HTTPS服务使用合成 CA 和客户端证书；随机 loopback 端口，finally 收请求/socket/server。用一组表驱动验证 direct失败/配置CA成功/缺客户端证书失败/正确mTLS成功，以及代理收到预期认证但业务服务无 Proxy-Authorization。
- [x] **2. 跑目标确认 RED。** 有正确本地服务但现有 client 尚不消费配置才算行为 RED；TLS fixture 过期/端口绑定失败记测试设施问题，不当产品失败。
- [x] **3. 实现 dispatchers.ts 并装配 client。** 使用已安装 ProxyAgent 的 `requestTls/proxyTls`，目标与代理各用自己的证书配置。每 hop 重新按 origin 选择绑定，CONNECT/重定向继续走原目标保护；验证默认开启，自定义 CA 追加运行时默认 CA，关闭校验只作用明确 profile。保持 headers/body/total timeout、上传预算、Cookie 和取消链不变。
- [x] **4. 用现有 client.test.ts 小型定向用例处理 M1/M3。** 通过创建/关闭计数替身验证 17 组闲置配置关闭最旧闲置项、在途租用不被关闭、client.close 全部回收；不做 OOM/FD 探针。client保留跨origin认证剥离的wire断言；来源标签实际在DebugExchangeCollector，最小纠正debug/projection并在既有debug/service测试断言，不新增HTTP事件API。两个不同mTLS origin验证不沿用原客户端身份。
- [x] **5. GREEN＋独立审核（边界见上）。** `tests/http/network.test.ts` 与修改到的原 client 目标；准备固定期间修改文件/配置不能改变已在途请求，新运行可生效。普通替身证明池策略，真实 HTTPS证明握手，两类证据不混称。Task1固定材料/版本证据已关联；旧/新运行变化的wire场景仍记G，不视为已实测。

## 任务 3：桌面/CLI/所有运行入口接线

2026-10-16 工程与独立复审完成：最终协议重新准入、保存后刷新失败的结果表达、私钥选择异常稳定出口均已修正；代表Desktop四入口及CLI collection经本地代理到达目标且启动准备一次，stress两迭代仍一次。修复轮Core41项、UI/主进程/CLI定向证据及Core类型/构建、Desktop完整构建通过；原Sol复审I1–I4全部闭合，无新增C/I/M。原生窗口/系统存储、全部child shard与TLS组合不由代表证据外推；翻译、既有告警及旧/新运行wire证据仍留G，细节及中间fixture错误保存在任务报告/账本，不自动Git集成。

**交付物：** 用户能配置并保存，真实运行入口实际消费，压测不增加逐次授权/文件 IO。

- [x] **1. 扩展已有 execution-credentials 与 CLI contract-assets fixture 做接线 RED。** 固定同项目/环境/代理配置，观察单次、集合、流程、压测、CLI 各自服务端到达及一次准备计数。复用一份本地代理服务和合成配置；不为每个入口复制整套TLS测试。
- [x] **2. 实现同一宿主 network adapter。** 桌面和 CLI 在各自运行启动捕获 selected配置；传入 immutable run context，VU/node只消费。已有 protocol plugin 不支持且选择了 HTTP-only 配置时给 config；默认 direct 时既有WS/SOAP不退化。除HTTP适配器外不得把解密材料交到插件/renderer。
- [x] **3. 接通 NetworkSettings UI/IPC/memory。** 项目/环境选择、direct/代理、目标originCA/校验警告/PEM mTLS及状态。私钥文件选择由宿主读取并调用 SecretStore.put，不把全文传回渲染器；失败分别显示秘密保存与配置保存结果。重启读同本机根；新配置不修改已启动任务。
- [x] **4. 定向 GREEN＋构建。** 先Core build/typecheck，再CLI build、Desktop build；受影响 store/component/main目标，以及上一步最小跨入口目标。代理/CA/证书秘密不出现在fixture项目文件/历史/报告的断言复用既有输出测试。
- [x] **5. B2 独立审核。** B-07–11/B-15 核对，M1/M3结论分别记；不把其他历史Minor或真实系统跨平台后端算通过。交给 [B3 OAuth2计划](2026-10-15-apicc-f2b-oauth-tool.md)，不提前 Git 集成。

## 执行命令

沿 B1 固定 `$f2bRoot/$f2bNode` 和 PATH；每次 `Push-Location` 到实际 package，显式目标，取原生退出码。新增Core定向入口：

```powershell
Push-Location (Join-Path $f2bRoot 'packages/core')
& $f2bNode node_modules/vitest/vitest.mjs run tests/network/profiles.test.ts tests/http/network.test.ts
$f2bExit = $LASTEXITCODE
Pop-Location
if ($f2bExit -ne 0) { throw "B2 Core target failed: $f2bExit" }
```

集成分组按任务逐项跑，不在每次保存重复整组。最终一次阶段门禁由 B3/G 负责。报告给出实际路径、测试名/结果、fixture服务关闭、候选版本及未验证平台。
