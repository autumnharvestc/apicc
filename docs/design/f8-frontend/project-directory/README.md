# 项目目录与新建接口的验收记录

[实施计划](../../../f8-frontend-polish-project-directory-plan.md) · [交互样板](../evidence/workbench-directory-actions-concept.png)

## 旧包对照

- [目录项目行和请求路径](baseline/baseline-directory-path.jpg)
- [选中接口时的目录标题菜单](baseline/baseline-directory-plus.jpg)
- [在线空项目的旧版入口](baseline/baseline-online-initial.jpg)

基线使用 `d993fda2` 对应的 Windows x64 验证包，`app.asar` SHA-256 为 `804046758431237d0fe1d88d9085e907111c51aec0e29e520591c3a59835c089`。截图来自 1097×638 原生窗口。旧包在顶栏、目录项目行和请求路径显示同一项目名。选中接口后，标题「＋」显示其父级的「新建文件夹」。夹具含名称相同的跨分组项目、长模块名、无模块的独立空项目，以及一个叫「未分类接口」的普通模块。隔离客户端正常退出，原始记录在 `local/f8-frontend-project-directory/isolated-aG10iB/`。

## 在线首写基线

旧 Java 服务和协作运行时已在独立回环服务上复现在线首写失败。项目处于版本 `0`，有效角色为 `EDITOR`，项目明确禁用 `script.edit`。提交可解析且不含脚本的首份契约文件得到 HTTP 403，复查版本与文件集合仍为 `0` 和空。只读成员写入得到 403，已有旧格式文件的项目得到 409。另以 Java-only 部署复核了分类服务未启用时的权限保护。分别记录于 `local/f8-frontend-project-directory/online-TvUl2Q/http-check-baseline-runtime.json` 和 `local/f8-frontend-project-directory/online-PHuytH/http-check-java-only.json`。两套隔离服务均已停止。

旧包同时验证了本机 HTTPS 测试入口、隔离合成账号登录和重新验活、团队空间及空项目的真实读取。使用客户端进程内的独立测试 CA，退出码为 `0`。连接记录和原图在 `local/f8-frontend-project-directory/online-yXrqPp/`。

## 默认模块兼容预验

将第一批 Core 生成的默认模块写入隔离工作区副本，使用旧 `app.asar` 提取的存储实现读取、改名并回写，新 Core 重开后仍识别原模块 UUID，接口内容一致。用的是旧包本身的严格文件读写实现，结果在 `local/f8-frontend-project-directory/old-package-compat-454Jcs/result.json`。后续将再对原生窗口实际保存的模块执行同一往返。

## 第一批原生预验

首次生产构建的隔离预览白屏，renderer 控制台报 `Uncaught TypeError: i is not a function`。日志及截图在 `local/f8-frontend-project-directory/isolated-cB6Wc5/`。该次构建仅用于复现，窗口已正常关闭。

目录组件和树投影各有一处 Core 根导入。树投影同时供在线 renderer 使用。两处改用纯入口后，生产构建没有 Node 依赖外部化告警，实际产物模块隔离测试通过，原生主页正常挂载。1097×638 隔离实窗完成以下操作：

- 从空项目打开固定的「＋」菜单，取消保存后读取工作区文件，模块数为 `0`。[空目录与菜单](preview/first-empty-directory.jpg) · [默认保存位置](preview/first-save-default.jpg)
- 保存首条接口后目录定位到新接口，模块有「默认」标记，编辑标题显示模块路径。模块操作集中在行尾「⋯」。[首条接口](preview/first-saved-interface.jpg) · [模块菜单](preview/first-module-menu.jpg)
- 通过行菜单将模块改名为「待归档接口」。从项目根级新建第二条接口时预选新名称，两条接口落入同一个模块。[改名后预选](preview/first-save-renamed-target.jpg) · [两条接口](preview/first-saved-second.jpg)

隔离窗口正常退出。对该实窗写入的工作区复制件，再用旧包存储实现改名并回写，新 Core 仍识别相同的模块 UUID，两条接口原样保留。原生预览及取消读回在 `local/f8-frontend-project-directory/isolated-Qv5IKi/`，旧包往返在 `local/f8-frontend-project-directory/old-package-compat-TRYtKR/result.json`。

首轮冻结构建进一步核对了[普通同名模块和现有工作流](preview/same-name-module-and-workflow.jpg)、[模块及文件夹路径](preview/nested-request-breadcrumb.jpg)、[容器菜单预选](preview/nested-preferred-save-target.jpg)和[保存后的接口](preview/nested-saved-interface.jpg)。切到 English 后，选中接口时仍显示[固定的标题菜单](preview/existing-project-en-menu.jpg)，Esc 关闭后 Enter 可重开。「未分类接口」普通模块可以与[默认位置分别选择](preview/existing-project-en-targets.jpg)。磁盘复查接口写入预期文件夹和普通模块，同名的另一个项目仍为空，普通模块项目没有创建默认模块。

该轮也复现了保存到目录下方后接口虽已选中却未滚入视口，以及切语言后上一条即时成功消息停留在旧语言。截图、落盘读回和退出记录在 `local/f8-frontend-project-directory/isolated-mWLivd/`。

第二次冻结通过[保存后自动定位](preview/automatic-reveal-selected.jpg)和[真实切换语言后的成功提示](preview/localized-saved-feedback.jpg)。只滚动了目录，正文顶部、响应条及菜单位置保持可用。隔离窗口退出码为 `0`，原记录在 `local/f8-frontend-project-directory/isolated-u0XEeN/`。

## 在线服务端实测

使用候选 Java JAR 和同源构建的 Node 协作运行时，独立 H2、回环地址以及五个不同权限的合成账号，完成 21 个真实 HTTP 请求。候选 JAR SHA-256 为 `9706a8a415631fab1011650130fc26243513435884e3af16801407404041eb29`。

| 场景 | 核对结果 |
| --- | --- |
| 禁用 `script.edit` 的项目 EDITOR 保存无脚本接口 | HTTP 200，默认模块和接口一起到版本 1，只读成员可读回，模块改名后到版本 2 |
| 禁用 `script.edit` 的 EDITOR 提交实际脚本 | HTTP 403，版本仍为 0，文件仍为空 |
| 普通 VIEWER 或项目 ACL 仍为 VIEWER | HTTP 403。工作区 VIEWER 经单项目 ACL 提升为 EDITOR 后，可以在该项目首次写入 |
| 已有旧版布局 | HTTP 409 `legacy_project_layout` |
| 无效内容、文件内外契约 UUID 不匹配 | HTTP 400 `invalid_project_assets`，版本仍为 0，文件仍为空 |
| 两名编辑者同时从版本 0 写入 | 获得 HTTP 200 和 409。读取获胜快照后按版本 1 重试，版本 2 仍只有一个默认模块，两条接口均保留 |

本节是服务端及配套运行时联验。另有桌面首存、目录刷新及写入结果不确定时的原生或定向验收。原始请求结果与停止记录在 `local/f8-frontend-project-directory/online-tJXZWs/`。

同一候选 JAR 的 Java-only 场又核对 11 个请求。禁用 `script.edit` 的编辑者在分类服务未启用时仍得 403，版本无变化，见 `local/f8-frontend-project-directory/online-isQCIS/http-check-java-only.json`。Linux 协作镜像从 Dockerfile 安装锁定依赖并构建，核对了实际 Core 构建指纹与 Java 边界文件。在无外部网络的临时容器内启动并关闭运行时。镜像构建和启动日志在 `local/f8-frontend-project-directory/batch-2/`。

## 第二批桌面预验

实际 Electron 通过回环 HTTPS 打开候选服务。无 `script.edit` 权限的编辑者从[在线空项目的「＋」](online-preview/online-empty-menu.jpg)创建接口。测试代理只丢弃一次已成功的 PUT 回执，客户端随后读取服务器资产，确认是本次接口，结束草稿并[定位已保存接口](online-preview/online-first-write-recovered.jpg)。服务端只收到一次 PUT，版本 1 中只有一个默认模块和一条接口。通过行菜单[改名](online-preview/online-default-renamed.jpg)后版本为 2，模块 UUID 和接口保持。另一个空项目[显式创建普通模块](online-preview/online-explicit-module.jpg)，版本 1 中只有该模块，且没有默认标记。原生日志、截图和资产读回在 `local/f8-frontend-project-directory/online-SMHyMx/`。

预验发现空目录文案仍指整个工作区，且既有执行设置挤占新接口编辑器首屏。两项并入本批收尾，随最终候选复验。

## Windows 候选包复验

首次封包的 `app.asar` SHA-256 为 `9b25aa17d9e49a370731507811c6ecf6c42957f25d659ea1a52a3a910ba0af9d`。真实包通过启动、renderer 挂载、Core 纯入口、独立查看器和外部同步子进程收束检查。另在隔离窗口复验：

- [在线空项目文案](packaged-online/online-empty.jpg)指向当前项目，[新接口草稿](packaged-online/online-editor-priority.jpg)直接占据首屏。
- 模拟丢失资产成功回执，[目录选中新接口](packaged-online/online-recovered-save.jpg)。代理只记录一次成功 PUT，读回版本 1、一个默认模块和一条合成接口。[只读成员](packaged-online/online-viewer.jpg)能读到同一接口，目录没有可写入口。
- 本地已有接口完成[真实回环请求并显示 HTTP 200](packaged-local/local-request-response.jpg)。选中接口时，[目录标题菜单](packaged-local/local-directory-menu.jpg)仍显示固定三项。

Windows 窗口缩到 847×638 后，[目录覆盖层挡住草稿字段](packaged-online/candidate-1-narrow-overlay.jpg)，与独审发现一致。这次原始日志在 `local/f8-frontend-project-directory/candidate-1/`、`online-dEOk1f/` 和 `isolated-EwVMLH/`。该候选留作复验对照。

## 修正复验

| 交互或边界 | 验收证据 |
| --- | --- |
| 本地固定目录动作、空项目、同名模块和容器预选 | [第一批原生预验](#第一批原生预验)与第一批 102 项去重定向。覆盖本地导入、项目操作、自由请求和已有入口。 |
| 在线权限、首写与并发 | [真实 Java/Node 服务](#在线服务端实测)及[首个包的遗失回执实测](#windows-候选包复验)。兼容旧布局、真实脚本拒绝、无脚本编辑者首存和只读成员。 |
| 在线写入只改所需资产 | 修正构建在真实服务中[改名默认模块](packaged-online/online-rename-precise.jpg)。版本从 2 升到 3，原 `project.yaml` 注释、内容、文件版本保持，仅 `collection.yaml` 变更。读回记录为 `online-dEOk1f/noncanonical-project-file-result.json`。 |
| 已有 API 草稿和工作台草稿 | 定向测试经原有下拉 A→B→A 确认保留独立 API 草稿。真实窗口显示压测方案[原输入](packaged-online/stress-before-directory.jpg)、[取消后](packaged-online/stress-after-cancel.jpg)及[保存新接口后](packaged-online/stress-after-save.jpg)一致。版本 4 的服务端读回确认同一默认模块下有两条接口。 |
| 迟到的读写响应 | 定向复现普通 assets GET、整项目保存及原增量保存的较旧回执，同作用域里保持已确认的较新版本。整项目冲突提示和下一步覆盖中英文。 |
| English 窄窗 | 使用最终 Windows 包在 814×638 窗口验证[两项创建菜单](packaged-online/final-narrow-menu.jpg)、[自动离开覆盖层并聚焦名称](packaged-online/final-narrow-editor.jpg)、[取消后按 Enter 重开目录](packaged-online/final-narrow-keyboard-return.jpg)。实际窗口正常退出。 |

## 交付包及验证范围

Windows x64 目录包和 ZIP 位于 `D:/workspace/project-sub/resource/F8-project-directory/`，同目录可用 `start-check.cmd` 启动合成工作区，附导入样本和手动验证说明。ZIP SHA-256 为 `51e3e9806e6f92b9e14204c7a4db16ed9547c12e95691635cfa6514a78b8dece`。原目录、交付副本及 ZIP 内 `app.asar` 的 SHA-256 均为 `7f768040dadbcb5e7aed07a23f1d1980a1fa38074340336106998ff14cbe40e6`。

第二批 88 项去重桌面定向、Core 11 项、协作运行时 20 项、最新首写 Java 4 项通过。复审核对了 37 个第二批文件和 60 个合批文件的内容哈希。完整桌面构建和 Windows 目录包冒烟通过。其他独立平台证据为真实 Java/Node、Java-only 和 Linux 协作镜像运行时启动及收束。最终包与独审记录分别在 `local/f8-frontend-project-directory/candidate-2/` 和 `batch-2/`。完整本地门禁及远端 CI 未运行。在线首写由同版服务端与协作运行时共同提供。
