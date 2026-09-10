import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcChannel } from "../shared/channels.js";
import { createIpcDeps } from "./ipc.js";
import { createSession } from "./session.js";
import { createOnlineClient } from "./online/client.js";
import { createTokenStore } from "./online/tokenStore.js";
import { createAiKeyStore } from "./ai/config.js";
import { attachQuitGuard } from "./quitGuard.js";

// package.json 为 type:module，编译产物是 ESM，须用 import.meta 推导 __dirname。
const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = join(__dirname);

// Cmd+Q/app.quit 的 close 会被退出守卫 preventDefault 中止既有 quit 流程——守卫放行销毁后
// 经此标志补刀 app.quit()（darwin 销毁后无窗不自动 quit，不补刀则应用无窗僵留）。取消/
// 手动关窗由守卫消费并复位标志，不继承退出意图（darwin 红点关窗保持「无窗驻留」习惯）。
let quitRequested = false;
app.on("before-quit", () => {
  quitRequested = true;
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  const pickDirectory = async (): Promise<string> => {
    // 冒烟/e2e 逃生口：无显示器环境无法操作原生目录选择对话框，
    // 设置 APICC_SMOKE_DIR 时直接返回该目录（不设置时走原生对话框，行为不变）。
    const smokeDir = process.env.APICC_SMOKE_DIR;
    if (smokeDir) return smokeDir;
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0]!;
  };
  const saveFile = async (defaultName: string, content: string): Promise<string> => {
    // design:export（任务 8）：原生保存对话框（defaultPath = <接口名>.design.md），
    // 取消回传空串；选择路径后写盘并返回完整路径。
    const result = await dialog.showSaveDialog({ defaultPath: defaultName });
    if (result.canceled || !result.filePath) return "";
    await writeFile(result.filePath, content, "utf8");
    return result.filePath;
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
  const plugins = { homeDir: app.getPath("home") };
  const deps = createIpcDeps({ session, pickDirectory, saveFile, online, ai, plugins });
  for (const channel of Object.values(IpcChannel)) {
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
