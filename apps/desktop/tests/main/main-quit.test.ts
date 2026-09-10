// 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）：
// 1. attachQuitGuard 编排三态（窗口 close 事件以可控 stub 驱动）：无 dirty 直关 / 有 dirty
//    取消不关 / 确认后关；close 先 preventDefault 扣住窗口（dirty 询问异步，无法同步放行）。
// 2. askRendererDirty 问答语义：应答 true 才算脏；非布尔应答/超时/发送失败一律按不脏放行
//    （渲染层崩溃时其未保存态已随之消亡，无数据可丢）。
// 3. main.ts 接线冒烟（electron 全量 mock）：whenReady 后 close 监听已挂，三态经由真实
//    main.ts 链路（dialog.showMessageBox + destroy）走到。
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { askRendererDirty, attachQuitGuard, type QuitGuardWindow } from "../../src/main/quitGuard.js";
import { IpcEvent } from "../../src/shared/channels.js";

/** 可控窗口 stub：捕获 close 监听与 dirty 应答监听（webContents 面结构同形 BrowserWindow）。 */
function stubWindow() {
  const closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
  const replyListeners: Array<(...args: unknown[]) => void> = [];
  const raw = {
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === "close") closeListeners.push(listener);
      return raw;
    }),
    webContents: {
      send: vi.fn(),
      on: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
        replyListeners.push(listener);
        return raw.webContents;
      }),
      removeListener: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
        const index = replyListeners.indexOf(listener);
        if (index >= 0) replyListeners.splice(index, 1);
        return raw.webContents;
      }),
    },
    destroy: vi.fn(),
  };
  return { win: raw as unknown as QuitGuardWindow, closeListeners, replyListeners };
}

/** 触发 close 事件（返回 event 供 preventDefault 断言）。 */
function fireClose(closeListeners: Array<(event: { preventDefault(): void }) => void>) {
  const event = { preventDefault: vi.fn() };
  for (const listener of [...closeListeners]) listener(event);
  return event;
}

/** 微任务 + 宏任务各一拍：覆盖 attach → ask 注册 → 应答后续链的挂载时机。 */
async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("attachQuitGuard 三态（不变量 6：确认才销毁）", () => {
  it("无 dirty：渲染层应答 false → 直接销毁放行，不弹确认", async () => {
    const { win, closeListeners, replyListeners } = stubWindow();
    const confirmDiscard = vi.fn(async () => true);
    attachQuitGuard(win, { confirmDiscard });
    const event = fireClose(closeListeners);
    expect(event.preventDefault).toHaveBeenCalled(); // 询问期间扣住窗口
    await settle();
    expect(win.webContents.send).toHaveBeenCalledWith(IpcEvent.AppDirtyCheck);
    replyListeners[0]!(null, false);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("有 dirty 取消：应答 true + 确认对话框取消 → 不销毁", async () => {
    const { win, closeListeners, replyListeners } = stubWindow();
    const confirmDiscard = vi.fn(async () => false);
    attachQuitGuard(win, { confirmDiscard });
    fireClose(closeListeners);
    await settle();
    replyListeners[0]!(null, true);
    await settle();
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("有 dirty 确认：应答 true + 确认丢弃 → 销毁", async () => {
    const { win, closeListeners, replyListeners } = stubWindow();
    const confirmDiscard = vi.fn(async () => true);
    attachQuitGuard(win, { confirmDiscard });
    fireClose(closeListeners);
    await settle();
    replyListeners[0]!(null, true);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("在途守卫：确认未完成时再次 close 不重复询问（防双击关窗的重复对话框）", async () => {
    const { win, closeListeners, replyListeners } = stubWindow();
    attachQuitGuard(win, { confirmDiscard: async () => false });
    fireClose(closeListeners);
    fireClose(closeListeners); // 第一次询问在途
    await settle();
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    replyListeners[0]!(null, false);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("askRendererDirty 问答语义", () => {
  it("应答 true → true；非布尔应答（缺省/坏形状）→ false", async () => {
    const first = stubWindow();
    const p1 = askRendererDirty(first.win);
    await settle();
    first.replyListeners[0]!(null, true);
    await expect(p1).resolves.toBe(true);

    const second = stubWindow();
    const p2 = askRendererDirty(second.win);
    await settle();
    second.replyListeners[0]!(null, "yes");
    await expect(p2).resolves.toBe(false);
  });

  it("应答后移除一次性监听（不残留跨次应答器）", async () => {
    const { win, replyListeners } = stubWindow();
    const p = askRendererDirty(win);
    await settle();
    expect(replyListeners).toHaveLength(1);
    replyListeners[0]!(null, false);
    await expect(p).resolves.toBe(false);
    expect(win.webContents.removeListener).toHaveBeenCalledWith(IpcEvent.AppDirtyCheckReply, expect.any(Function));
    expect(replyListeners).toHaveLength(0);
  });

  it("超时无应答 → false（放行：渲染层无响应时无数据可丢）", async () => {
    vi.useFakeTimers();
    try {
      const { win } = stubWindow();
      const p = askRendererDirty(win, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("下行发送失败 → false（放行，不悬挂 close 流程）", async () => {
    const { win, closeListeners } = stubWindow();
    (win.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("webContents 已销毁");
    });
    const p = askRendererDirty(win);
    await settle();
    await expect(p).resolves.toBe(false);
    expect(closeListeners).toHaveLength(0);
  });
});

// —— main.ts 接线冒烟：electron 全量 mock，走真实 main.ts 的 whenReady → createWindow →
// attachQuitGuard 链路，钉住「close 监听已挂 + 三态经 showMessageBox/destroy 收口」。 ——
const electronState = vi.hoisted(() => ({
  windows: [] as Array<{
    closeListeners: Array<(event: { preventDefault(): void }) => void>;
    replyListeners: Array<(...args: unknown[]) => void>;
    destroy: () => void;
  }>,
  destroyCalls: 0,
  messageBoxCalls: 0,
  messageBoxResponse: 0,
}));

vi.mock("electron", () => {
  class BrowserWindow {
    closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
    replyListeners: Array<(...args: unknown[]) => void> = [];
    webContents = {
      send: vi.fn(),
      on: (_channel: string, listener: (...args: unknown[]) => void) => {
        this.replyListeners.push(listener);
        return this.webContents;
      },
      removeListener: (_channel: string, listener: (...args: unknown[]) => void) => {
        const index = this.replyListeners.indexOf(listener);
        if (index >= 0) this.replyListeners.splice(index, 1);
        return this.webContents;
      },
    };
    constructor() {
      electronState.windows.push(this);
    }
    loadURL() {}
    loadFile() {}
    on(event: string, listener: (event: { preventDefault(): void }) => void) {
      if (event === "close") this.closeListeners.push(listener);
      return this;
    }
    destroy() {
      electronState.destroyCalls += 1;
    }
  }
  return {
    app: {
      whenReady: () => Promise.resolve(),
      getPath: () => "/tmp/apicc-main-quit-test-userdata",
      on: () => undefined,
    },
    BrowserWindow,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => {
        electronState.messageBoxCalls += 1;
        return { response: electronState.messageBoxResponse };
      },
    },
    ipcMain: { handle: () => undefined },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (text: string) => Buffer.from(text, "utf8"),
      decryptString: (buffer: Buffer) => buffer,
    },
  };
});

describe("main.ts 退出拦截接线（electron mock 冒烟）", () => {
  let win: (typeof electronState.windows)[number];

  beforeEach(async () => {
    // 单例模块只执行一次 whenReady 链；用例共享首个窗口、各自触发 close 串行推进。
    if (electronState.windows.length === 0) {
      await import("../../src/main/main.js");
      await settle();
      await settle();
    }
    win = electronState.windows[0]!;
  });

  it("无 dirty：close 先 preventDefault，应答 false → 直接销毁（不经 showMessageBox）", async () => {
    electronState.messageBoxResponse = 0;
    const event = { preventDefault: vi.fn() };
    for (const listener of [...win.closeListeners]) listener(event);
    expect(event.preventDefault).toHaveBeenCalled(); // 询问期间扣住窗口
    await settle();
    win.replyListeners[0]!(null, false);
    await settle();
    expect(electronState.destroyCalls).toBeGreaterThanOrEqual(1);
    expect(electronState.messageBoxCalls).toBe(0);
  });

  it("有 dirty：应答 true → showMessageBox；取消（response≠0）不销毁；确认后销毁", async () => {
    const destroyedBefore = electronState.destroyCalls;
    // —— 取消分支 ——
    electronState.messageBoxResponse = 1;
    fireClose(win.closeListeners);
    await settle();
    win.replyListeners[0]!(null, true);
    await settle();
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.destroyCalls).toBe(destroyedBefore);
    // —— 确认分支 ——
    electronState.messageBoxResponse = 0;
    fireClose(win.closeListeners);
    await settle();
    win.replyListeners[0]!(null, true);
    await settle();
    expect(electronState.destroyCalls).toBe(destroyedBefore + 1);
  });
});
