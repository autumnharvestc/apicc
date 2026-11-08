# F8 P3h 逐点验证记录

2026-11-09；基线 `faa08cf9`，工作树 `f8-frontend-polish`。按[设计](f8-frontend-polish-p3h-design.md)完成桌面设置、环境、契约和辅助入口本组接入。16个Vue组件、两语言文件；Core、store、宿主、权限、数据协议未改。独审见[回执](f8-frontend-polish-p3h-review.md)。

## 逐点对照

| 项 | 验收条件 | 已运行测试／核对 | 浏览器证据与边界 |
| --- | --- | --- | --- |
| Mock摘要与规则 | 草稿配置、条件、响应来源、延迟可读；JSON默认折叠；无效草稿错误直接可见、旧摘要消失 | zh/en `P3h exposes readable Mock rules and preserves saved execution semantics`：false原值、状态、未知constructor原因原样、编辑后摘要、非法输入；既有保存／启动／日志／只读／迟到保护／定时刷新全文件 | 01–02；窄表局部535/740，根宽640；literal响应正文属于原文，折叠查看 |
| Mock保存与执行 | 启动仍取已保存revision，不隐式保存当前草稿；端口0语义不变 | 新用例明确断言start载荷和save未调用；原全文件覆盖保存不启动、显式启动、只读和跨根迟到 | 未通过浏览器启动真实监听器；fixture主动拒绝 |
| 网络配置 | 当前草稿摘要、代理字段／证书引用、TLS禁用警告可读；高级折叠不藏错误 | zh/en `P3h projects network drafts without hiding invalid configuration`；既有project/environment选择与秘密导入分离 | 03–04；无效时summary消失，error不在details里；未保存凭据或更改网络安全配置 |
| 环境 | 长名可查、导航／变量分区、窄屏堆叠、表格局部滚动；只读保持 | EnvPanel完整现有用例；完整locator和保存路径静态复核 | 05–06；只读时3输入及保存禁用；修复标题受按钮挤断，最终06已更新 |
| 契约固定选项 | 状态与认证标签双语，但选中存储值仍published/basic等原值 | zh/en `P3h localizes contract enums without changing protocol values`，真实editor fixture；contractAssets、DesignPanel完整既有用例 | 07元数据列、08响应Schema、09模型；保留原契约编辑、引用归属与错误语义 |
| Schema／响应／资产 | 分区、窄屏排列、长名称title，专用Schema编辑仍保留原文 | contractAssets／DesignPanel既有回归；未改Schema操作逻辑 | 08响应区601/601无外溢；09嵌套模型真实类型。导出／磁盘未由截图证明 |
| 模块管理 | 模态居中限高，变量／脚本按钮具名，脚本排序身份不变 | zh/en `P3h names container script controls and retains save identity`：真实Antd portal点击页签、下移、触发Modal ok；核对完整target与操作ID／内容顺序 | 13实际下移；18在640×400下body220/303，保存／关闭可见。浏览器不保存；测试核对保存载荷 |
| 调试／缓存／插件 | 单位、边界、元信息与错误保持，控件随主题；弹窗／长表局部滚动 | OnlineExecutionCacheSettings与PluginsView完整用例；直接settings调用回归；调试绑定未改 | 10–11、14–15、19；超时10000→12000重开保留在内存，Cookie仅元信息；640×400 body220/909。没有清Cookie或真实持久化 |
| OAuth／凭据／设置抽屉 | 双语错误／风险仍可见，认证流、scope和秘密保存不变；抽屉宽不超过视口 | components/topBar所选OAuth/settings共8项；CredentialEditor仅scoped样式 | 12缺失凭据提示与OAuth表单。未实际认证／创建凭据，完整原生链待P5 |
| 导入 | 预览／显式计划／决策分区，长内容局部滚动；原确认／撤销等语义保持 | ImportWizard完整既有用例，含预览／计划／合并；只改CSS | 16–17预览与计划1新增，按钮可用但未点击导入；有内容的冲突决策仅测试覆盖 |

## 命令与原始证据

固定Node22.19.0／pnpm；日志归档 `docs/design/f8-frontend/p3h/evidence/`。

1. 新Mock2、Network2、Contract2和Container2先执行。`presentation-red.log`共8失败／10未选，其中前6项有效；Container2因teleport stub渲染对象而未达到前提，不能称有效先红。`container-fixture.log`保留诊断；改成真实portal后，在产品修改前 `container-red.log`两项因下移按钮缺少名称失败。合计有效先红为6+2，不声称每个后续断言均单独先红。
2. `pnpm --dir apps/desktop exec vitest run tests/renderer/components/{MockPanel,NetworkSettings,P3hPresentation,EnvPanel,PluginsView,OnlineExecutionCacheSettings,ImportWizard,contractAssets,DesignPanel}.test.ts`（实际逐个完整路径传入，不依赖PowerShell花括号展开）：9文件 **91通过**，62.47秒，`targeted.log`。jsdom伪元素getComputedStyle提示保留。
3. `pnpm --dir apps/desktop exec vitest run tests/renderer/components/components.test.ts tests/renderer/components/topBar.test.ts -t 'OAuth|settings'`：**8通过／75未选**，12.49秒，`callers.log`。合计 **99项去重通过**。
4. `pnpm --dir apps/desktop typecheck:vue`、`pnpm --dir apps/desktop build:renderer`通过（vue.log/build.log）。视觉检查后仅追加Env标题／操作wrap、Contract元信息grid和Import决策行wrap三处CSS；实际页面已核对，再对最终候选执行相同Vue／renderer检查通过（vue-final.log/build-final.log）。未因纯CSS重复99项行为测试。renderer既有500kB分块提示保留。
5. 最终 `git diff --check`；双语新增desktopPresentation键集合一致。未运行本地全量、Java套件、完整CI或重新打包。没有将未选项算通过。

## 视觉、失败与剩余边界

19张截图覆盖宽窄、中英、深浅、长内容、非法草稿和640×400短高。实际Vue组件，memory fixture提供API；用例中的真实memory端口和浏览器简化端口明确分开。浏览器夹具曾缺designPreview／credential状态字段、Schema模型类型不正确，后修正；文档预览根目录不一致只修fixture，最终真实预览ready。Python编码及radio定位失败也如实留在回执，不称产品缺陷或单次全绿。最终fixture的Vite SSR动态import分析warning保留在fixture-seed-final.log；这与浏览器最终error列表为空、产品构建既有分块warning分别记录。临时浏览器页已关闭、视口已恢复，测试服务停止且63577无监听。结束Vite时回收的尾段含3次ResizeObserver未交付通知（00:37:16／00:37:33／00:42:54）；实际界面未出现空白或操作阻塞，原因未定，不作全程零错误声明，P5原生窗口切换时继续核对。尾段按时间保留在browser-server-tail.log（HMR路径已简写，非全程日志）。

同组唯一独审检查产品和直接调用方、测试前提、实际可读内容、单位／本地化／布局及冻结清单。原生287px、系统缩放、实际拖动、完整在线／本机IPC与新包留P5。浏览器fixture未传Antd locale，中文No data不能作为真实App本地化结论，P5核查应用壳。共享DocumentPreview中的长指纹和生命周期码留P4公共／离线展示同组处理，明确不计本组完成。

桌面专属入口本轮接入完成；前端仍余 **3块**：管理台、公共／离线页面（含共享文档预览）、原生集中验收与新包，再进行发布收口。旧P2交付包不包含P3。按既有授权及时本地提交，未合并／推送。
