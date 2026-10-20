import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcChannel } from "../shared/channels.js";
import { createIpcDeps } from "./ipc.js";
import { createSession } from "./session.js";
import { createOnlineClient } from "./online/client.js";
import { createTokenStore } from "./online/tokenStore.js";
import { createAiKeyStore } from "./ai/config.js";
import { createDesktopDebugHistoryStore } from "./debugHistory.js";
import { attachQuitGuard } from "./quitGuard.js";
import { atomicWriteFile } from "./atomicFile.js";
import { defaultCredentialPrivateRoot, defaultNetworkPrivateRoot, defaultOAuthPrivateRoot } from "@apicc/core";

// package.json 为 type:module，编译产物是 ESM，须用 import.meta 推导 __dirname。
const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = join(__dirname);

// Cmd+Q/app.quit 的 close 会被退出守卫 preventDefault 中止既有 quit 流程——守卫放行销毁后
// 经此标志补刀 app.quit()（darwin 销毁后无窗不自动 quit，不补刀则应用无窗僵留）。取消/
// 手动关窗由守卫消费并复位标志，不继承退出意图（darwin 红点关窗保持「无窗驻留」习惯）。
let quitRequested = false;
let stopDesktopMocks: (() => Promise<void>) | undefined;
let mockShutdown: Promise<void> | undefined;
let bypassNextBeforeQuit = false;
app.on("before-quit", (event) => {
  quitRequested = true;
  if (bypassNextBeforeQuit) {
    bypassNextBeforeQuit = false;
    return;
  }
  if (!stopDesktopMocks) return;
  event.preventDefault();
  if (mockShutdown) return;
  const shutdown = Promise.resolve().then(() => stopDesktopMocks!());
  mockShutdown = shutdown;
  const continueQuit = () => {
    if (mockShutdown !== shutdown) return;
    mockShutdown = undefined;
    bypassNextBeforeQuit = true;
    void app.quit();
  };
  void shutdown.then(continueQuit, continueQuit);
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: process.env.APICC_SMOKE_HIDE_WINDOW !== "1",
    webPreferences: {
            preload: join(__dirname, "../preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../../dist-renderer/index.html"));
  // 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）：close 一律先 preventDefault 扣住窗口，
  // 经渲染层聚合 dirty 问答决定放行/确认（编排与测试面见 quitGuard.ts）。darwin 下同样生效
  // （点红关窗=同一确认流程）；window-all-closed 既有行为不变（非 darwin 才 quit）。
  // 挂在 createWindow 内：darwin activate 重建的窗口同样被守卫。
  attachQuitGuard(win, {
    confirmDiscard: async () => {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        message: "有未保存的修改",
        detail: "接口/工作流/在线编辑存在未保存的草稿，退出后将丢弃。确定退出吗？",
        buttons: ["丢弃修改并退出", "取消"],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
    shouldQuitAfterClose: () => {
      const requested = quitRequested;
      quitRequested = false;
      return requested;
    },
    quit: () => void app.quit(),
  });
  return win;
}

app.whenReady().then(() => {
  const session = createSession();
  // Explicitly injected only by the isolated packaged-host smoke. Normal startup
  // keeps Electron's user home/appData and the default credential root unchanged.
  const smokeRoot = process.env.APICC_SMOKE_ISOLATED_ROOT;
  const isolatedRoot = smokeRoot ? resolve(smokeRoot) : undefined;
  const pickDirectory = async (): Promise<string> => {
    // 冒烟/e2e 逃生口：无显示器环境无法操作原生目录选择对话框，
    // 设置 APICC_SMOKE_DIR 时直接返回该目录（不设置时走原生对话框，行为不变）。
    const smokeDir = process.env.APICC_SMOKE_DIR;
    if (smokeDir) return smokeDir;
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0]!;
  };
  const saveFile = async (
    defaultName: string,
    content: string,
    format?: "markdown" | "html" | "openapi-3.0" | "openapi-3.1",
    encoding?: "json" | "yaml",
  ): Promise<string> => {
    const filters = format === "html"
      ? [{ name: "HTML document", extensions: ["html"] }]
      : format === "markdown"
        ? [{ name: "Markdown document", extensions: ["md"] }]
        : format?.startsWith("openapi-")
          ? encoding === "yaml"
            ? [{ name: "OpenAPI YAML", extensions: ["yaml", "yml"] }]
            : [{ name: "OpenAPI JSON", extensions: ["json"] }]
          : undefined;
    const result = await dialog.showSaveDialog({ defaultPath: defaultName, ...(filters ? { filters } : {}) });
    if (result.canceled || !result.filePath) return "";
    await atomicWriteFile(result.filePath, content);
    return result.filePath;
  };
  const confirmLossyExport = async (diagnostics: readonly { code: string; path: string; message: string }[]): Promise<boolean> => {
    const visible = diagnostics.slice(0, 10).map(({ code, path, message }) => `${code} — ${path}: ${message}`);
    if (diagnostics.length > visible.length) visible.push(`… ${diagnostics.length - visible.length} more diagnostic(s)`);
    const result = await dialog.showMessageBox({
      type: "warning",
      title: "OpenAPI export may lose semantics",
      message: "The selected OpenAPI document omits or transforms some contract semantics. Continue exporting?",
      detail: visible.join("\n"),
      buttons: ["Cancel", "Export anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  };
  // 在线依赖（M3-B 任务 1，规格 §2 D9）：token 存 userData 目录（safeStorage 加密，
  // 不可用降级明文 + warn）；client 用全局 fetch（Node 22 内置），超时默认 15s。
  const online = {
    createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) =>
      createOnlineClient({ baseUrl, fetch: globalThis.fetch, timeoutMs: 15_000, onUnauthorized: hooks.onUnauthorized }),
    tokenStore: createTokenStore({ dir: app.getPath("userData"), storage: safeStorage }),
  };
  // AI 依赖（M6-C 任务 1，规格 §2 D2）：key 存 userData（safeStorage 加密，不可用降级
  // 明文 + warn）；baseUrl/model 由渲染层 localStorage 持久化（非敏感配置）。
  const ai = {
    keyStore: createAiKeyStore({ dir: app.getPath("userData"), storage: safeStorage }),
  };
  // 插件依赖（M7-B 任务 2，规格 §2 D4/D8）：main 进程建 registry 时装载用户级清单
  // （~/.apicc/plugins.json，D4）；关闭通道 = IpcDepsOptions.plugins.loadPlugins:false
  // （与 CLI --no-plugins 对齐口径的编程关闭面，桌面 MVP 无 UI 开关——启用/停用 = 编辑
  // 用户级清单，D8）。createIpcDeps 未配置 plugins 时零加载（测试零扰动），生产必须显式启用。
  const plugins = { homeDir: isolatedRoot ? join(isolatedRoot, "user-home") : app.getPath("home") };
  const deps = createIpcDeps({
    session, pickDirectory, saveFile, confirmLossyExport, online, ai, plugins,
    credentials: {
      credentialPrivateRoot: isolatedRoot ? join(isolatedRoot, "credentials") : defaultCredentialPrivateRoot(),
      networkPrivateRoot: isolatedRoot ? join(isolatedRoot, "network") : defaultNetworkPrivateRoot(),
      oauthPrivateRoot: isolatedRoot ? join(isolatedRoot, "oauth") : defaultOAuthPrivateRoot(),
      openExternal: (url) => shell.openExternal(url),
    },
    debugHistory: () => isolatedRoot
      ? createDesktopDebugHistoryStore({ privateRoot: join(isolatedRoot, "history") })
      : createDesktopDebugHistoryStore({ appDataDirectory: app.getPath("appData") }),
  });
  stopDesktopMocks = deps.stopMocks;
  for (const channel of Object.values(IpcChannel)) {
    // Preserve Electron's actual sender object through this boundary: the debugger binds
    // start/wait/cancel and renderer teardown to event.sender, never a renderer-supplied id.
    ipcMain.handle(channel, (event, ...args) => deps.handle(channel, event, ...args));
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
