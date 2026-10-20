# F3-C 格式交换、冲突导入与阶段集成计划

状态：整阶段已集中批准；等待计划A/B接口稳定后顺序实施，不授权Git集成。

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development 逐任务实现此计划。步骤使用复选框跟踪。只有F3整阶段集中批准后执行；依赖A的范围/诊断、B的Mock配置和引用处理已稳定。

**目标：** 外部格式导入/导出有明确支持边界、损失诊断和一次性事务，不破坏当前项目数据；完成F3离线代表链及新包交付。

**架构：** 复用已有解析器/clone/事务存储，新增纯OpenAPI导出及数据型cURL解析。宿主保存预览计划，Apply只接受预览token和选择，桌面与CLI复用纯合并决策。

**技术栈：** 现有TypeScript、Zod、YAML、Commander、Electron/Vue、Vitest；不调用外部在线转换服务或shell执行输入。

**规格：** `docs/superpowers/specs/2026-10-18-apicc-f3-design-docs-mock-exchange-design.md`，重点§7–10。固定Node/pnpm和低并发测试遵循计划A。

## 全局约束

- 现有OpenAPI2/3及集合v2.1解析器仍为内置注册入口；不重写全部导入器，不变更插件SDK。
- 新OpenAPI导出3.0/3.1＋JSON/YAML，范围同A；有损默认阻止，`--allow-lossy`不允许跳过结构/引用错误。
- cURL仅单条POSIX数据解析，不执行、不读取@file、不联网取ref；未知选项明确拒绝。
- 导入局限当前工作区/当前已选项目；事务失败自动回滚；桌面一次撤销仅当前会话且revision未改变。
- 不自动commit/合并/push，DEF-001不恢复；不因阶段末门禁重复此前相同候选全部用例。

## 文件与职责

新增core `export/openapi.ts`（snapshot→规范对象/诊断）、`import/curl.ts`（有序命令数据解析）、`import/merge.ts`（候选匹配/决策/依赖clone/候选项目），复用`import/schemaMapping.ts`诊断与遮罩。`shared.ts/index.ts`按纯函数/Node宿主边界导出，`createDefaultRegistry`仅新增cURL内置导入器。

Desktop新`shared/exchange.ts`、`main/exchange.ts`持有token/候选/撤销句柄；修改既有session事务接缝、ImportWizard、importW、design导出dialog和IPC/memory/preload/i18n。CLI新增`commands/import.ts`提取旧import入口，扩展计划A的`commands/export.ts`；main删除旧重复注册，不保留绕过新预览/事务的另一条路径。

## 任务1：OpenAPI导出与语义往返（C02）

- [ ] 新增`packages/core/tests/export/openapi.test.ts`，复用既有`tests/import/contractOpenapi.test.ts`内的少量JSON/YAML夹具。一个定义同时含Path/Query/Header/Cookie、两个响应/媒体、模型和认证，表驱动3.0/3.1目标；不为排列组合建立全矩阵。
- [ ] 定义`exportOpenapi(snapshot, scope, options)`，options含version `3.0|3.1`、明确infoVersion和allowLossy；返回`{document, diagnostics, blocked}`。从已验证原契约/闭包转换并在公共边界遮罩，不能从已丢语义的Markdown或AI投影反推OpenAPI。

```ts
const project = createContractExecutionProject('http://127.0.0.1');
const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
if (asset.contract.request.protocol !== 'http') throw new Error('HTTP fixture required');
asset.contract.request.baseUrl = 'http://127.0.0.1';
asset.contract.request.path = '/items';
const snapshot = createProjectSnapshot(project);
const out = exportOpenapi(snapshot, { kind: 'project' }, {
  version: '3.1', infoVersion: '1.0.0', allowLossy: false,
});
expect(out.blocked).toBe(false);
expect(out.document.openapi).toBe('3.1.0');
const imported = parseContractOpenapi(out.document);
expect(imported.project.collections[0]!.apis.length).toBeGreaterThan(0);
```

- [ ] 往返比较协议/方法/路径/参数/Body/响应/Schema，不比较新UUID/SecretRef或被遮罩值；显式覆盖重复Path-method报错、空范围、丢失GraphQL/WS/用例/Mock信息的诊断。不支持字段必须报告，不能用私有扩展掩盖不支持。
- [ ] 接入计划A export dialog与CLI：`--format openapi-3.0|openapi-3.1 --encoding json|yaml --info-version <value> --allow-lossy`。输出前生成诊断并等待显式确认，有错误不创建成功文件。
- [ ] 定向运行core export单文件及CLI export受影响用例，JSON/YAML两种输出可由现有解析器读取；独立审核，不运行所有导入用例证明一条新增映射。

## 任务2：单条cURL声明解析（C01）

- [ ] 新增`packages/core/tests/import/curl.test.ts`，少量表驱动输入验证引号/续行/重复header/query、默认method与-X、data/form/file声明、认证遮罩、未知选项拒绝。对单条多行文本作解析测试，不实际运行输入命令。
- [ ] `parseCurlRequest(text)`返回有序声明和源位置诊断；适配为内置`curlImporter`，最终结果仍为`ContractImportResult`。支持的flag清单以规格§7.1为准，`--`后的URL与选项值按token规则处理，不能调用child_process或shell获取解析结果。

```ts
const result = parseCurlRequest("curl 'http://localhost/items?q=1&q=2' -H 'X-Test: a'");
expect(result.request.method).toBe('GET');
expect(result.request.query.filter(p => p.name === 'q').map(p => p.value)).toEqual(['1', '2']);
expect(() => parseCurlRequest('curl --unknown-option http://localhost')).toThrow();
```

- [ ] 明确处理`--data`/raw/binary/urlencode/form的不同语义；含`@file`保留待重绑文件引用并给诊断，不读取文件；含u/header认证生成空SecretRef/遮罩提示。不能把不支持的curl选项当普通URL或静默略过。
- [ ] 在现有Importer注册、Desktop导入向导中加入粘贴cURL入口，主页/项目落点继续由原入口确定，不新建全局请求发送器。CLI import接受cURL文本文件，沿同一解析/预览逻辑。
- [ ] 定向跑curl单文件和既有ImportWizard/store相关目标，独立审核。没有请求发送/文件读取才是该导入入口的正确行为，禁止为验证它执行用户粘贴内容。

## 任务3：冲突计划、预览绑定、原子提交与一次撤销（C01/C03/C04/C05）

- [ ] 新增core `tests/import/merge.test.ts`及Desktop `tests/main/exchange.test.ts`，扩展既有`tests/renderer/stores/importW.test.ts`和`contract-ipc.test.ts`最少相关场景。先证明旧Apply可脱离预览提交项目的行为差距；保留真实session/storage fixture，不用只检查按钮存在代替事务。
- [ ] `buildImportMergePlan(targetProject, importedProject, decisions)`生成候选项目/变更摘要/诊断：限制选中模块、歧义显式选择、默认跳过、重命名新增、覆盖保持目标contractId/原用例/说明，依赖资产通过既有clone映射。涉及现有用例/Mock引用破坏即报错，不自动扩大覆盖范围。
- [ ] 主进程保存解析结果与candidate计划，发短预览token；确认目标及策略后重新绑定token到完整locator/current revision/source摘要。renderer只发token/决策；缺token、错误root、过期revision/readOnly一律拒绝。插件导入结果也先验证，不信任其直接文件写权限。
- [ ] Apply通过session队列克隆工作区并预检，再一次调用storage.save；成功后才替换active session。复用journal自动回滚；事务失败既无半项目也无“成功”结果。对导入成功后树刷新失败返回`committed:true`的明确结果，UI禁用重复Apply并允许仅刷新。
- [ ] 为Desktop保存当前会话内opaque undo句柄（导入前工作区、导入后revision、本批新增定义路径）；undo复核当前revision再一次事务恢复，仅删除该批新增定义。根切换/再次修改/重启后失效，给明确提示；不做持久undo服务。CLI保证同一事务失败回滚，成功撤销不伪装支持。
- [ ] ImportWizard展示新增/覆盖/跳过数量、逐项损失与冲突、引用破坏，危险覆盖需显式确认。module模式不另选项目；project模式仍只在当前workspace选group。保留取消无写盘及同名新增旧语义。
- [ ] CLI import复用相同解析/合并决策；默认预览，`--yes`仍不能替代`--allow-lossy`有损确认；信息/遮罩诊断不是实际语义损失。新合并模式显式target collection和policy，不根据项目名猜目标。旧`--group`新增项目入口保留。
- [ ] 合并为少量fixture验证：四策略＋歧义；一个存盘中途失败完整回滚；过期token拒绝；成功后一次撤销及后续修改拒绝撤销；刷新失败不重复Apply。分别运行明确目标，补CLI import单文件。独立审核后移交root做阶段G。

## 阶段G：一次集成、实际包与归档（G01/G02）

- [ ] root确认规格A01–A07、B01–B06、C01–C05逐行有证据，独立Sol审核规格/质量与跨单元数据流；首次集中报告问题后只交同一开发者修对应批次，不每修一个点重审全部F3。
- [ ] 对冻结候选一次顺序低并发门禁：Core当前主线（明确排除延期专项）、CLI、Desktop；新增/既有相关文件先去重。保留原始cwd/argv/stdout/stderr/exit，修复后只重跑受影响目标，不能误称已重跑整套。
- [ ] Core构建后再CLI/Desktop（已验证同字节构建可复用）；Desktop完整build含tsc/vue-tsc/renderer/main/preload。品牌中立同时检查新文件，`git diff --check`与暂存后检查分别记录，防止新文件漏检；不改CI顺序来藏错误。
- [ ] 一个隔离合成项目完成：不发请求设计→保存→文档→本地Mock→当前项目自由请求实际命中→导出HTML/OAS→新模块再导入→诊断/冲突→撤销。纯JSON/文本数据，不使用真实外部账号，不接回DEF-001。
- [ ] 只打一次最终Windows目录包，包内字节与已构建candidate绑定。真实Chromium检查长设计/文档/Mock日志、正常及代表短高度、操作栏与独立滚动；在同一夹具加入长接口名/模块名/嵌套目录名的真实hover，比较前后行、名称、徽标bounds（容差1 CSS px），确认单行、tooltip及更多菜单可用，无需另出包。OS原生滚轮单独代表检查，不把CDP数值称为原生输入。
- [ ] 归档到主仓库local：实际支持矩阵、未支持语言/协议/格式、继承开放项、raw索引、审查结论、测试实际范围、包路径/指纹。明确平台/工具缺失，不因无本机宿主而静默删除语言验收要求。
- [ ] 给用户验证包；此刻不自动提交、合并或推送。用户另行授权后执行Git集成；不删除原包、旧stash和延期专项工作树。

## 自检与移交

- [ ] 规格A01–G02全部映射上述任务；暂无产品实现或验收完成勾选。
- [ ] 公共类型/端口与A/B一致；旧DesignExport/ImportApply/CLI入口没有旁路；Mock配置不会在clone/导入时静默消失。
- [ ] 阶段内既定任务由root连续调度；只有新增权限、重大范围变化、确切无法推进或涉及DEF-001才暂停并明确需要用户做什么。
