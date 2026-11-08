# P3h 浏览器证据

19张实际组件截图、浏览器回执和行为／构建原始日志；不是原生新包证明。截图01–17来自过程中同一合成入口，18–19为最终短高检查。最终重新生成seed使用真实一致的临时根目录，ID与早期截图可能不同。

复用：将 fixture-entry.ts、fixture-index.html、fixture-seed.json、fixture-serve.mjs、fixture-seed.mjs 复制到仓库 local/f8-frontend-p3h/browser/，去掉 fixture- 前缀。使用锁定Node运行 serve.mjs，会以真实memory API新建合成临时目录并重建seed，然后监听127.0.0.1:63577；seed.mjs只重建种子后退出。entry中的端口仅供可读视图／内存操作，不能作为真实IPC、保存、网络授权或导入落盘证据。

日志保留原始失败和工具输出，不把夹具失败或未选测试计作业务验证。产品验证范围与后续待验详见上级P3h逐点对照。
