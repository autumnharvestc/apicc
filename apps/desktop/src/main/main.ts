import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcChannel } from "../shared/channels.js";
import { createIpcDeps } from "./ipc.js";
import { createSession } from "./session.js";
import { createOnlineClient } from "./online/client.js";
import { createTokenStore } from "./online/tokenStore.js";
import { createAiKeyStore } from "./ai/config.js";
import { createDesktopAiPersonal, createLegacyAiConfirmation } from "./ai/personal.js";
import { existsSync } from "node:fs";
import type { WebContents } from "electron";
import { createDesktopDebugHistoryStore } from "./debugHistory.js";
import { attachQuitGuard } from "./quitGuard.js";
import { lossyExportDialog } from "./designExportDialog.js";
import { atomicWriteFile } from "./atomicFile.js";
import { defaultCredentialPrivateRoot, defaultNetworkPrivateRoot, defaultOAuthPrivateRoot } from "@apicc/core";
import { WindowChromeChannel, windowChromeColors, type WindowChromeTheme } from "../shared/window-chrome.js";

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

const titleBarHeight = 46;
const mainWindows = new WeakSet<BrowserWindow>();
const applicationMenuOpen = new WeakSet<BrowserWindow>();

function showApplicationMenu(win: BrowserWindow, keyboard = false): Promise<void> {
  const menu = Menu.getApplicationMenu();
  if (!menu || applicationMenuOpen.has(win)) return Promise.resolve();
  applicationMenuOpen.add(win);
  const { x, y } = win.getContentBounds();
  return new Promise<void>((done) => {
    menu.popup({
      window: win,
      ...(keyboard ? { x: x + 12, y: y + titleBarHeight } : {}),
      callback: () => { applicationMenuOpen.delete(win); done(); },
    });
  }).catch((error) => {
    applicationMenuOpen.delete(win);
    throw error;
  });
}

function windowOverlay(theme: WindowChromeTheme) {
  return nativeTheme.shouldUseHighContrastColors
    ? { color: "#000000", symbolColor: "#ffffff", height: titleBarHeight }
    : { ...windowChromeColors[theme], height: titleBarHeight };
}

function createWindow(): BrowserWindow {
  const windowsOverlay = process.platform === "win32";
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: process.env.APICC_SMOKE_HIDE_WINDOW !== "1",
    ...(windowsOverlay ? {
      titleBarStyle: "hidden",
      titleBarOverlay: windowOverlay(nativeTheme.shouldUseDarkColors ? "dark" : "light"),
      autoHideMenuBar: true,
    } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindows.add(win);
  if (windowsOverlay) {
    // Electron retains accelerators on hidden title bars but skips the native
    // menu bar. Open its application menu on a standalone Alt release.
    let standaloneAlt = false;
    // The OS consumes Alt+Space before Chromium sees the Space key. Cancel the
    // pending Alt when Windows starts initializing its system menu.
    const wmInitMenu = 0x0116;
    const wmInitMenuPopup = 0x0117;
    win.hookWindowMessage(wmInitMenu, () => { standaloneAlt = false; });
    win.hookWindowMessage(wmInitMenuPopup, () => { standaloneAlt = false; });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown") {
        standaloneAlt = input.key === "Alt" && !input.control && !input.meta && !input.shift;
      } else if (input.key === "Alt" && standaloneAlt) {
        standaloneAlt = false;
        event.preventDefault();
        void showApplicationMenu(win, true).catch(console.error);
      }
    });
    win.on("blur", () => { standaloneAlt = false; });
  }
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
  const confirmLossyExport = async (diagnostics: readonly { code: string; path: string; message: string }[], locale: "zh-CN" | "en"): Promise<boolean> => {
    const result = await dialog.showMessageBox(lossyExportDialog(diagnostics, locale));
    return result.response === 1;
  };
  // 在线依赖（M3-B 任务 1，规格 §2 D9）：token 存 userData 目录（safeStorage 加密，
  // 不可用降级明文 + warn）；client 用全局 fetch（Node 22 内置），超时默认 15s。
  const online = {
    createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) =>
      createOnlineClient({ baseUrl, fetch: globalThis.fetch, timeoutMs: 15_000, onUnauthorized: hooks.onUnauthorized }),
    tokenStore: createTokenStore({ dir: app.getPath("userData"), storage: safeStorage }),
  };
  // Personal to this desktop device. CLI uses its own root/backend; no ref sharing.
  const legacyAiRoot = isolatedRoot ? join(isolatedRoot, "legacy-ai") : app.getPath("userData");
  const legacyAi = createAiKeyStore({ dir: legacyAiRoot, storage: safeStorage });
  const confirmLegacy = createLegacyAiConfirmation({
    isAlive: owner => { const sender = owner as WebContents; return typeof sender.isDestroyed === "function" && !sender.isDestroyed(); },
    readConfiguration: async owner => (owner as WebContents).executeJavaScript(`(() => { try { const c = JSON.parse(localStorage.getItem('apicc.ai.config') || 'null'); return c && typeof c.baseUrl === 'string' && typeof c.model === 'string' ? {baseUrl:c.baseUrl,model:c.model} : null; } catch { return null; } })()`),
    confirmAddress: async (owner, originalAddress) => {
      const parent = BrowserWindow.fromWebContents(owner as WebContents);
      if (!parent) return { confirmed: false, insecureLocalTest: false };
      const result = await dialog.showMessageBox(parent, { type: "warning", title: "迁移旧 AI 配置 / Migrate legacy AI settings", message: "请核对：这个完整地址确实是旧 AI 密钥原先使用的地址吗？\nVerify that this complete address is the original address used with your legacy AI key.", detail: originalAddress,
        buttons: ["取消 / Cancel", "确认原地址并迁移 / Confirm original address and migrate"], defaultId: 0, cancelId: 0, noLink: true,
        checkboxLabel: "本次明确允许回环 HTTP 测试 / Allow insecure loopback HTTP testing this time (localhost / 127.0.0.1 / ::1)", checkboxChecked: false });
      return { confirmed: result.response === 1, insecureLocalTest: result.checkboxChecked === true };
    },
  });
  const ai = {
    keyStore: legacyAi,
    personal: createDesktopAiPersonal({ privateRoot: isolatedRoot ? join(isolatedRoot, "ai") : join(app.getPath("userData"), "ai"), storage: safeStorage,
      legacyKeyStore: legacyAi, legacyAvailable: () => existsSync(join(legacyAiRoot, "ai-key.json")), confirmLegacy }),
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
    synchronization: {
      privateRoot: join(isolatedRoot ?? app.getPath('userData'), 'synchronization'),
      confirmDestination: async (origin, addresses, locale) => {
        const result = await dialog.showMessageBox({ type: 'question', title: locale === 'en' ? 'Approve this sync connection' : '批准本次同步连接', message: origin, detail: `${locale === 'en' ? 'Only this host, port and addresses are approved for this check. Other origins are rejected.' : '本次仅批准此主机、端口与地址；跨来源重定向将拒绝。'}\n${addresses.join('\n')}`, buttons: locale === 'en' ? ['Cancel', 'Allow this check'] : ['取消', '仅本次允许'], defaultId: 0, cancelId: 0, noLink: true });
        return result.response === 1;
      },
      pickTool: async (tool, locale) => { const result = await dialog.showOpenDialog({ title: locale === 'en' ? (tool === 'git' ? 'Select installed Git' : 'Select installed OpenSSH') : (tool === 'git' ? '选择已安装的 Git' : '选择已安装的 OpenSSH'), properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
    },
    debugHistory: () => isolatedRoot
      ? createDesktopDebugHistoryStore({ privateRoot: join(isolatedRoot, "history") })
      : createDesktopDebugHistoryStore({ appDataDirectory: app.getPath("appData") }),
  });
  stopDesktopMocks = async () => { await Promise.allSettled([deps.stopMocks(), deps.stopOnlineExecutions(), deps.stopSynchronization()]); };
  for (const channel of Object.values(IpcChannel)) {
    // Preserve Electron's actual sender object through this boundary: the debugger binds
    // start/wait/cancel and renderer teardown to event.sender, never a renderer-supplied id.
    ipcMain.handle(channel, (event, ...args) => deps.handle(channel, event, ...args));
  }
  ipcMain.handle(WindowChromeChannel.SetTheme, (event, theme: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === "win32" && win && mainWindows.has(win)
        && event.senderFrame === event.sender.mainFrame && (theme === "light" || theme === "dark")) {
      win.setTitleBarOverlay(windowOverlay(theme));
    }
  });
  ipcMain.handle(WindowChromeChannel.ShowApplicationMenu, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && mainWindows.has(win) && event.senderFrame === event.sender.mainFrame) {
      return showApplicationMenu(win);
    }
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
