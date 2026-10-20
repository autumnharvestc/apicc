# F3-A 契约设计、文档与代码片段实现计划

状态：用户“可以开始”已集中批准F3（含侧树补充），从任务1实施；未完成项保持未勾选，不授权Git集成。

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框跟踪。没有用户对 F3 整阶段的集中批准，不得开始实现。

**目标：** 当前项目内设计契约、实时查看文档并导出脱敏离线文档。

**架构：** 既有 editor session 是唯一可写契约，主进程在同项目快照上生成只读文档投影。三种片段及两种文档消费同一投影，存储与请求发送链不重建。

**技术栈：** 现有 TypeScript、Vue/Pinia、Ant Design Vue、Electron、Zod、Vitest；本轮不要求新增依赖或升级版本。

**规格：** `docs/superpowers/specs/2026-10-18-apicc-f3-design-docs-mock-exchange-design.md`，重点§4–5、§8–10。

## 全局约束

- 基线3990739，用户确认CI通过；开发Luna xhigh、独立审核Sol xhigh；root调度。
- 整阶段已批准实施；提交/合并/推送另行请求。DEF-001不恢复。
- Node下限22.19.0，固定工具链和现有依赖；renderer不引入Node运行时依赖。
- 文档预览可含明确标注的当前草稿；导出与Mock只用已保存快照。
- 不读取SecretStore/引用文件；真实秘密、SecretRef ID、本机绝对路径不进入文档/片段。
- 首批cURL POSIX、PowerShell 7、JS fetch；未支持协议/语言明确提示，不伪造成功。
- 执行命令中的`NODE22`指现有`local/toolchains/node-v22.19.0-win-x64/node.exe`，`PNPM`指现有缓存`C:/Users/imini/AppData/Local/node/corepack/v1/pnpm/11.21.0/bin/pnpm.cjs`；启动时验证存在，不重装。
- 目标测试一律`NODE22 PNPM -C <package> exec vitest run <明确路径> --maxWorkers=2`，不用`test --`，不隐式跑整包。

## 文件与职责

新增 core `design/projection.ts`（范围/解析/脱敏DTO）、`design/document.ts`（Markdown/HTML）、`design/snippets.ts`（有序请求IR和三语言生成）。修改 `design/export.ts` 以适配原入口，保留原导出含说明/用例的行为；旧`contractMarkdown.ts`不再演变成第二套解析器。

新增 Desktop `shared/design.ts`（DTO/严格输入schema）、`main/design.ts`（快照/草稿验证、generation边界、输出），以及 `ContractDesigner.vue`、`DocumentPreview.vue`、`CodeSnippetPanel.vue`。修改既有 `DesignPanel.vue`、`stores/design.ts`、`stores/editor.ts`必要接缝、App接线及现有共享IPC/preload/memory/i18n。新CLI入口置 `commands/export.ts`，`main.ts`只注册，原`export-design`兼容。

新公共类型放浏览器可安全消费的模块/`shared.ts`；Node宿主只由`index.ts`导出。旧MCP/AI消费者仍可调用原Markdown入口，不要求提前改SDK。

用户追加的侧树稳定交互同时修改既有`components/SideTree.vue`及其现有`tests/renderer/components/components.test.ts`内侧树场景，必要的tooltip文案复用中英文tree命名；纳入任务2，不另建专项/计划或测试框架。

## 任务1：同快照文档投影与预览端口（A02/A03）

- [ ] 在现有`packages/core/tests/design/export.test.ts`和`contractMarkdown.test.ts`复用`createContractExecutionProject`，新增`design/projection.test.ts`。先验证模型/响应解析、循环有限、缺引用路径、源revision和遮罩；不是仅断言输出包含标题。

```ts
import { createProjectSnapshot } from '../../src/assets/snapshot.js';
import { createContractExecutionProject } from '../helpers/contractExecutionFixtures.js';
import { buildDocumentProjection } from '../../src/design/projection.js';
const snapshot = createProjectSnapshot(createContractExecutionProject('http://127.0.0.1'));
const view = buildDocumentProjection(snapshot, { kind: 'project' });
expect(view.sourceProjectRevision).toBe(snapshot.definitionRevision);
expect(view.apis).toHaveLength(1);
expect(JSON.stringify(view)).not.toContain('credential-ref-1');
```

- [ ] 定义`DocumentScope`四分支（project、collectionIds、contractIds、tags任一命中）和`DocumentProjection`：formatVersion、sourceProjectRevision、项目身份、apis、diagnostics；每个api含元数据、协议请求、解析后响应/模型及说明。编写`buildDocumentProjection(snapshot, scope)`；过滤空范围报错误，不扩展为全部，按项目原顺序输出。
- [ ] 给主进程`designPreview`端口定义locator/sourceProjectRevision/assetDraft输入；在已有项目副本替换该API，严格校验后生成投影，返回草稿来源/诊断。不用renderer对象作为文件路径或项目根。
- [ ] 在`apps/desktop/tests/main/contract-ipc.test.ts`扩展现有locator夹具：错根/旧revision拒绝、同ID不同项目隔离，原资产不因预览被保存；同步修改channels、ipc-contract、types、preload、memory，所有新端口schema输入输出成对接线。
- [ ] 定向运行core上述3文件及Desktop contract-ipc；确认行为RED→GREEN，交独立审核。模块尚未创建的加载错误不冒充字段行为RED；最小接口可加载后检查实际断言。通过后不重复该候选整套。

## 任务2：正式设计视图、草稿及侧树交互（A01/A02/A06/A07）

- [ ] 扩展现有`apps/desktop/tests/renderer/components/DesignPanel.test.ts`的`mountDesignPanel`和`stores/design.test.ts`的`seeded`夹具；测试无发送编辑保存/重开、无效输入保留、切接口迟到预览忽略、readOnly拒绝更新。复用已有同签晚保存场景，不另建同类框架。
- [ ] `ContractDesigner.vue`编辑真实`editor.api.contract`；按参数/Body/认证结构复用低层字段控件，复用SchemaEditor和ResponseEditor。保存调用原editor.save；保留documentation说明草稿及旧导出入口，不调用发送或凭据解密。
- [ ] DesignPanel组织“契约/文档”，新增预览状态`idle/loading/ready/invalid/conflict`及请求generation。`DocumentPreview`显示草稿/已保存/sourceProjectRevision；invalid/conflict不展示无标记旧结果。切调试只是切视图，不发送。
- [ ] 保留固定操作栏与有界内容滚动；预览状态属于完整editor session，不覆盖B1 request-tab草稿/历史。仅抽取当前所需控件，不重构整个RequestEditor或所有标签。
- [ ] 同一任务先收口用户侧树反馈：`SideTree.vue`将接口名置于独立单行ellipsis元素，方法徽标/箭头/层级图标不收缩，动作使用固定尺寸图标及预留操作区；显隐不改变名称/整行bounds。重命名/删除tooltip在hover/focus显示文字，不恢复行内文字；模块/目录同样处理，管理/新建等多项功能放固定更多菜单。保持既有data-testid/完整locator、只读行为、原确认/影响提示，操作点击不冒泡为选择/折叠。
- [ ] 复用components.test.ts现有侧树夹具，合并一个参数化功能场景证明图标可访问名称/tooltip、原重命名/删除确认、模块/目录更多入口和只读状态；已有断言若基于行内操作文字，改为用户要求的新可访问语义，不删除其行为验证。真实hover前后几何归阶段G，jsdom不承担尺寸正确性。
- [ ] 定向运行上述DesignPanel/design两文件、components.test.ts中的受影响侧树目标和必要的既有App单个相关用例。此处不加jsdom尺寸测试；阶段G用真实包检查长内容/代表短高及三类侧树行hover稳定性。独立审核后继续，不要求用户逐task确认。

## 任务3：可读文档与三种片段（A03/A04）

- [ ] 新增`packages/core/tests/design/snippets.test.ts`，和现有Markdown夹具共享一组HTTP定义：重复query/禁用header、path编码、引号/换行、三类认证占位、JSON及文件Body各一代表。用表驱动覆盖语言差异，避免复制三套输入矩阵。
- [ ] 实现`generateRequestSnippet(documentApi, language)`，language固定`curl-posix|powershell|javascript-fetch`，返回`{code, diagnostics}`。从投影建立有序参数/body中间值，之后仅语言序列化不同；不得实例化HTTP client/SecretStore。
- [ ] Markdown从投影渲染字段表、多个响应和模型引用，保留原说明与既有用例摘要。HTML文档同样使用投影；不依赖请求真实执行结果生成定义。
- [ ] CodeSnippetPanel支持语言选择、复制、占位符及协议限制提示；在现有DesignPanel测试追加一个“切换语言不改契约且不读取凭据”场景。延迟Java/Python/Go在结果矩阵明确保留，不创建占位按钮伪装完成。
- [ ] 定向运行core snippets/export/contractMarkdown及受影响DesignPanel目标。JS片段可用现有Node语法检查和本机捕获fetch参数验证；cURL和PowerShell在可用原生宿主对同一合成HTTP服务各一次请求等价验证。宿主缺失时标未验，不声称仅字符串快照等于执行正确，也不擅自安装工具。

## 任务4：范围导出与离线HTML（A05/A06）

- [ ] 新增`design/document.test.ts`：四范围/依赖闭包/同名锚点、转义说明、合成秘密不出现；HTML结构测试与一项真实浏览器离线搜索检查合用，不给每个字段单独加e2e。
- [ ] 实现`renderDocumentMarkdown(projection)`和`renderDocumentHtml(projection)`。HTML内嵌固定CSS和自有搜索代码，用户字符串转义，模型循环用ID锚点；说明首版文本展示，不自行实现通用Markdown解释器。
- [ ] 新增设计导出格式/范围dialog，沿用原生保存入口，dirty时提示导出已保存内容；主进程先完成生成再原子替换目标文件，取消无输出。文件名不充当资产身份。
- [ ] CLI `export <projectPath> --format markdown|html --output <path>`，`--collection <id...>`/`--api <id...>`/`--tag <tag...>`互斥，无过滤即项目范围；保留`export-design`。在新`packages/cli/tests/export.test.ts`复用原CLI子进程宿主，验证成功/无匹配/取消不适用CLI/写入失败退出码，stdout不输出原始秘密。
- [ ] 运行document及CLI export单文件；依赖构建仅确需子进程时一次。真实脱网HTML搜索/跳转和设计滚动与阶段G合并做，不再单独重复最终打包。独立审核通过后进入计划B。

## 本计划交付检查

- [ ] A01–A07逐行关联实际命令/退出码/未验边界；原MCP/AI Markdown回归仍通过。
- [ ] 不新增产品依赖/全标签架构/网络执行器；没有把含秘密的原契约当公共投影返回。
- [ ] 未获Git授权时只报告候选和diff，不自行commit。阶段范围重大变化集中报告，正常错误处理不反复询问用户。
