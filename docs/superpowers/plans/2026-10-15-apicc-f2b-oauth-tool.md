# F2b-B3 OAuth2工具与阶段集成实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。用户已集中批准整阶段，按依赖顺序执行，步骤使用复选框跟踪实际完成情况。

**目标：** 本地获取/刷新常见 OAuth2 token，加密保存后在现有 Bearer 请求中使用；交付整个 F2b 的可验证 Windows 包。

**架构：** OAuth2是宿主工具而非新契约kind。私有profile将已有Bearer SecretRef与客户端配置/刷新状态关联，运行准备协调一次刷新，再复用现有凭据绑定；浏览器回调只在主进程交互会话存在时启用。B2负责token endpoint网络，B1负责当前项目内请求签及统一主页/项目导航。主页不提供获取后直接发送项目请求的独立入口。

**技术栈：** Node http/crypto、现有undici和SecretStore、Electron shell、Vue/Pinia、Commander、Vitest。

**规格：** [F2b设计](../specs/2026-10-15-apicc-f2b-debug-workbench-design.md) §6–8。2026-10-16：B1/B2工程与独立审核完成；B3任务1经首轮修复/独立复审完成，当前接续任务2。最终G/原生/平台验收仍未完成，不自动Git集成。

## 全局约束

- 不新增 OAuth2 AuthBinding 类型，不声称完整OAuth2配置已能共享/导入导出。
- 支持 client_credentials、authorization_code＋PKCE S256、refresh_token；不用密码/隐式授权，不做OIDC。
- profile默认根 `join(homedir(), '.apicc', 'private', 'oauth', 'v1')`；桌面/CLI共用，测试注入独立根。
- 回调5分钟；token请求30秒、响应1MiB；每次运行准备至多刷新/重新获取一次，不在业务401后自动重发。
- 首次浏览器授权由用户点击；CLI无交互运行不打开浏览器；桌面关闭不影响CLI使用已持久化token/刷新。
- Luna xhigh开发、Sol xhigh独立审核、单写入者；不恢复DEF-001，不改版本/CI，不自动提交/合并/推送。

## 文件与职责

| 动作 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `packages/core/src/oauth/{model,privateStore,tokenClient,coordinator,host}.ts` | 非秘密profile/状态、私有存储、标准token交换、刷新并发及准备接线 |
| 新建 | `apps/desktop/src/main/oauth.ts` | loopback回调、浏览器动作、owner/取消/过期和状态IPC |
| 新建 | `apps/desktop/src/renderer/src/components/OAuthManager.vue` | Bearer旁的获取、刷新、解除关联和明确状态 |
| 修改 | Desktop `main/{ipc,credentialHost}.ts`、`shared/{types,channels,ipc-contract}.ts`、`preload/preload.ts` | 真实运行前协调及专用OAuth IPC |
| 修改 | Desktop `renderer/src/{components/CredentialEditor.vue,components/RequestEditor.vue,api/memory.ts,i18n/zh-CN.json,i18n/en.json}` | 正常UI与memory契约，原凭据编辑有明确关联处置 |
| 修改 | `packages/cli/src/{main,credentials}.ts` | status/list/acquire/refresh/unlink命令与非交互运行准备 |
| 修改 | `packages/core/src/{index,shared,schema}.ts` | 浏览器只有Schema/公开状态，Node端才加载宿主 |
| 新建 | `packages/core/tests/oauth/{tokenClient,coordinator}.test.ts`、`apps/desktop/tests/main/oauth.test.ts` | 一份自建OAuth fixture、交换/轮换/回调生命周期 |
| 扩展 | Core `tests/credentials/output.test.ts`、Desktop `tests/main/execution-credentials.test.ts`、CLI `tests/contract-assets.test.ts` | 输出投影、跨入口一次准备、真实CLI |
| 新建 | `apps/desktop/tests/renderer/components/OAuthManager.test.ts` | 少量真实i18n状态/按钮和部分成功反馈 |

不得往已有RequestEditor巨型组件塞完整OAuth协议；协议、协调和交互宿主分开。新增文件仅服务本轮，不抽象“万能身份平台”。

## 任务 1：私有profile与token交换

2026-10-16工程/独立复审完成：I1–I6已修正，复审无新增C/I/M；最终定向20/20、Core类型/构建通过。真实Bearer版本、Ref改绑、轮换后失败分类、局部test-auto准入、refresh scope及稳定配置指纹/expected输入有定向证据；原RED不足历史如实保留，SQLite告警、持久失败的best-effort边界及Task2协调窗口仍记账。私有配置按credential scope单文档保存各root/env所有权并统一防Bearer引用碰撞，代价是共享修订/写锁。未把producer完成等同回调/CLI/UI/真机验收。

**交付物：** 自建授权服务支持客户端凭据、授权码换取、刷新轮换，秘密不出公共结果。

- [x] **1. 先建 tokenClient.test.ts 的小型本地HTTP fixture。** 仅loopback，单 `/token` 按grant_type返回合成token；计数并检查form/客户端认证、PKCE verifier。模型固定profileId、scope、environmentId、flow、端点、clientId、认证方式、Bearer ref和clientSecret/refresh SecretRef；profile无明文秘密。token交换返回私有TokenSet，公开结果只有status/expiry/errorCode。

```ts
type OAuthTokenSet = {
  accessToken: string; refreshToken?: string;
  tokenType: "Bearer"; expiresIn?: number; scope?: string;
};
// exchangeOAuthToken({profile, grant, secrets, network, signal}) -> Promise<OAuthTokenSet>
// grant 为 client_credentials | authorization_code(code,verifier,redirectUri)
//       | refresh_token；secrets 为本次选中绑定，不是SecretStore枚举接口。
```

最小RED先测试client_credentials表单成功、错误token_type或缺access_token拒绝；再复用同服务验证code/verifier和refresh轮换。不依赖外网身份提供方。
- [x] **2. 跑最小目标确认行为RED，再实现model/privateStore/tokenClient。** 初轮仅入口缺失RED，未冒称行为验证；修复轮已保留实际失败/成功证据。profile strict/version=1；端点规则、无自动重定向、30秒/1MiB预算；业务Cookie/脚本/认证不带入token交换。锁定配置修订，取消/异常只给无秘密稳定错误。scope不被字符串trim等无声改变含义。
- [x] **3. 实现host存取并验证部分成功。** access token走既有Bearer ref；refresh/clientSecret独立加密ref；profile非秘密元数据和凭据版本对齐。注入第二步保存失败，断言真实access token已生效且公开状态为部分成功，不报全部成功；轮换refresh保存失败提示重新授权，不无限重试。
- [x] **4. GREEN与定向审核。** tokenClient目标＋Core类型门；写入后重开profile、损坏/未来版本保留不覆写；输出只含状态/合成marker未出现。不得把真正token换取响应原样写入通用调试历史。

## 任务 2：交互回调、运行前刷新与桌面/CLI一致性

2026-10-17工程/独立定向复审完成：I1–I6及M1全部闭合，新增C/I/M为0/0/0。显式动作共享交换、CLI安全结果、只读准入、同源快照、稳定终态和跨环境普通凭据拒绝有定向证据；token版本冲突明确复用Task1未变检查链的既有证据，不把文档修订冲突混记。真实CLI双命令并发合并、IPv6 wire、原生浏览器/凭据及最终G/新包仍未验收；未自动Git集成。

**交付物：** 用户主动授权后可重启使用，CLI无需桌面常驻，运行中绑定固定。

- [x] **1. coordinator.test.ts 做一次准备RED。** 注入时钟、SecretStore、exchange函数和私有profile根；两次同profile准备并发使用deferred屏障，断言exchange一次，放行后各运行固定同版本。已过期无refresh的授权码profile返回明确需要授权，不发业务请求；客户端凭据可获取一次。

```ts
// prepareOAuthBearerRefs({scope, environmentId, refs, signal}) -> Promise<void>
// 只在prepareCredentialBindings之前调用；处理本次真正选中的refs，非OAuth refs零交换。
// 每profile单一Promise；共享文件写锁协调桌面/CLI；元数据版本不匹配返回冲突。
```

更新已关联ref时原CredentialPut入口必须走同一协调端口或要求显式unlink；测试只检查正常版本冲突，不开发恶意篡改/故障日程专项。
- [x] **2. Desktop oauth.test.ts 的回调RED。** 新建真实随机loopback监听，注入openExternal替身捕获授权URL；由自建本地授权服务返回合法code/state，检查S256和token交换；正常取消/超时/owner销毁关闭监听，不访问用户浏览器登录。一个常规错误state/重复回调用例足够验证请求归属，不做攻防枚举。
- [x] **3. 实现主进程授权会话和协调器。** 先绑定监听再打开浏览器，固定本次endpoint/client/redirect；公开status/wait/cancel按原owner；终态清timer/监听。token交换使用B2的endpointorigin profile。进程间profile锁不强抢，取消/忙错误明确；成功/失败均释放自有锁。秘密和code/verifier不进入IPC/持久日志。
- [x] **4. 所有运行准备与CLI接线。** 调试/集合/流程/压测及CLI在真正选中Bearer refs之后先执行一次OAuth协调，再走既有prepareCredentialBindings，VU及节点不刷新。CLI新增 `oauth list/status/acquire/refresh/unlink`，参数只含profileId/作用域，不通过命令行打印或传递秘密；acquire仅客户端凭据，授权码首次由桌面。命令错误有非零退出且脱敏。
- [x] **5. GREEN＋独立审核。** coordinator/Desktop主进程目标和CLI真实子进程最小目标；同ref跨profile/环境登记拒绝，已启动token不随刷新改变，401不导致业务重复发包。B-12–15按实际证据记账。

## 任务 3：OAuth UI与整阶段交付

2026-10-18：Task3/G工程、独立审核和本机代表链交付完成，停止在Git集成前。最终工程检查对失败的旧fixture仅作受影响复验，不宣称新一轮全量全绿。新包发现的Windows SQLite journal长路径缺陷已最小修正，现有凭据文件23/23、Core构建/类型0，独立Sol增量审核无新增C/I/M；原I4实际cleanup已确认。新包f2b-2026-10-18-r2实际dirty/free/history/save、CA+OAuth、重启持久Bearer、桌面关闭后的显式共享根runCli链及精确自有凭据清理全部native0。原生唯一项目返回、并列签、两正式＋两自由、工作流顶栏/暗色已观察；英文、native picker、真实IdP等仍未验。完整逐项证据、原始失败和边界见SDD stage-evidence.md及主工作区local/F2b阶段验证结果-2026-10-18.md；不将代表链外推为所有平台或交互验收。

**交付物：** 用户能操作/理解状态，并收到可测试的完整F2b验证包。

- [x] **1. OAuthManager最小组件RED。** 复用真实中英文i18n，断言Bearer已关联profile的状态、获取/刷新/解除关联，以及“token保存成功但refresh保存失败”的明确提示；不新增每按钮一套重复测试。打开面板不自动授权，点击获取才调用IPC。
- [x] **2. 实现UI和取消/切签隔离。** 当owner/tab/generation变化，迟到状态不改另一请求；授权成功显示过期时间/未知，不展示secret/refresh原文。解除profile不远程撤销授权、不擅自删被引用Bearer值；删除凭据使用已有明确动作。改为普通Bearer须显式解除管理。
- [x] **3. 一次最终工程门。** 按下方顺序执行并分开保留退出码，失败只补修和复验受影响范围，不无意义重跑全部轮数。不要将单任务target累计数当成最终suite数。
- [x] **4. 一次整阶段独立Sol xhigh审核。** B1/B2/B3共享边界＋全部差异；任务已审内部不重复逐行开新轮，重点身份/来源、真实接线、敏感输出、端口和生命周期，以及唯一项目从主页返回/主页不外溢项目操作。C/I问题修复并定向复审，所有未解决Minor/平台边界报告列明。
- [x] **5. Windows新包与验收归档。** 新独立目录，不覆盖F2a旧包；记录exe/asar和运行时文件绑定、隔离appData/privateRoot真实启动、自由请求→历史→保存接口→CLI消费，及本地proxy/TLS/OAuth主链。原生选择器、外部浏览器和视觉检查没有跑就标未验，不以memory/jsdom替代。将路径交用户验证，停止在Git集成前。

## 最终命令与通过标准

先记录固定Node、pnpm和候选Git/diff；运行cwd始终明确，不在仓库根裸跑Vitest。沿B1固定环境后，包编译顺序为：

```powershell
pnpm -C packages/core build
if ($LASTEXITCODE -ne 0) { throw 'Core build failed' }
pnpm -C packages/core typecheck
if ($LASTEXITCODE -ne 0) { throw 'Core typecheck failed' }
pnpm -C packages/cli build
if ($LASTEXITCODE -ne 0) { throw 'CLI build failed' }
pnpm -C apps/desktop build
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
```

测试分别以对应package cwd执行固定Node＋`node_modules/vitest/vitest.mjs run`，Core沿现有本地主线口径显式排除 `tests/sandbox/**`，CLI/Desktop不新增排除；报告注明这一排除，不能声称本地命令等于不排除的CI全量入口。包顺序Core→CLI→Desktop，不并发轰炸本机。Admin/Java未改则不额外跑，若真实改动影响公共接线，列明原因再补相应测试。pnpm CLI的test脚本本身包含build；已建产物时直接Vitest，避免无意义重复构建。

```powershell
Push-Location $f2bRoot
& $f2bNode scripts/check-brand-neutral.mjs --self-check
if ($LASTEXITCODE -ne 0) { throw 'Brand self-check failed' }
& $f2bNode scripts/check-brand-neutral.mjs
if ($LASTEXITCODE -ne 0) { throw 'Tracked brand scan failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Diff whitespace check failed' }
Pop-Location
```

新未跟踪源码/文档须额外用相同词表逻辑覆盖，不能只扫git ls-files就宣称新文件也通过；不为扫描擅自stage。打包复用 `pnpm -C apps/desktop dist:dir` 的已有builder及smoke脚本，预先指定新的阶段输出目录和隔离宿主根，日志中写实际完整命令，不复用旧包证据。

交付文档包含：B-01–18逐行结果、命令/退出码、测试集合、包路径/指纹、实际人工检查、未验证平台、全部开放项；B-16–18新增唯一项目返回、导航上下文与顶栏布局验收，不能用B1请求签测试替代。只有用户另行要求时再提交/合并/推送。后续F3需另开文档/Mock/兼容IO设计，不能把本轮本机OAuth profile冒充完整可共享OAuth契约。
