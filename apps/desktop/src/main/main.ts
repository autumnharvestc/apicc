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

// package.json 为 type:module，编译产物是 ESM，须用 import.meta 推导 __dirname。
const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = join(__dirname);

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
  const deps = createIpcDeps({ session, pickDirectory, saveFile, online, ai });
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
