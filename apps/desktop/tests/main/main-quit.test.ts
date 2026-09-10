// 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）：
// 1. attachQuitGuard 编排三态（窗口 close 事件以可控 stub 驱动）：无 dirty 直关 / 有 dirty
//    取消不关 / 确认后关；close 先 preventDefault 扣住窗口（dirty 询问异步，无法同步放行）。
// 2. askRendererDirty 问答语义：应答 true 才算脏；非布尔应答/超时/发送失败一律按不脏放行
//    （渲染层崩溃时其未保存态已随之消亡，无数据可丢）。
//    应答接收面按真实 Electron 语义建模（2026-09-09 审查关键 1）：主进程经 per-WebContents
//    的 webContents.ipc.on(通道, (event, ...args)) 接收渲染层 ipcRenderer.send——stub 的
//    ipc.on 维护「通道 → 监听器」注册表，测试按真实事件形态派发应答（listener(event, dirty)）。
// 3. 退出标志收尾（审查次要 2）：before-quit 标志命中且窗口被销毁 → 补刀 quit（darwin
//    Cmd+Q 的既有 quit 已被 preventDefault 中止、无窗不自动 quit）；无标志（darwin 红点
//    关窗）destroy 不 quit；取消路径消费并复位标志，不劫持后续手动关窗。
// 4. main.ts 接线冒烟（electron 全量 mock）：whenReady 后 close 监听已挂，三态与退出标志
//    经真实 main.ts 链路（dialog.showMessageBox / app.quit）走到。
import { describe, expect, it, vi, beforeEach } from "vitest";
import { askRendererDirty, attachQuitGuard, type QuitGuardWindow } from "../../src/main/quitGuard.js";
import { IpcEvent } from "../../src/shared/channels.js";

/**
 * 可控窗口 stub：捕获 close 监听；webContents.ipc 按「通道 → 监听器」注册表建模（真实
 * Electron 事件分发形态），reply(...) 以 listener(event, ...args) 派发应答。
 */
function stubWindow() {
  const closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
  const ipcListeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
  const raw = {
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === "close") closeListeners.push(listener);
      return raw;
    }),
    webContents: {
      send: vi.fn(),
      ipc: {
        on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
          const list = ipcListeners.get(channel) ?? [];
          list.push(listener);
          ipcListeners.set(channel, list);
          return raw.webContents.ipc;
        }),
        removeListener: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
          const list = ipcListeners.get(channel) ?? [];
          const index = list.indexOf(listener);
          if (index >= 0) list.splice(index, 1);
          return raw.webContents.ipc;
        }),
      },
    },
    destroy: vi.fn(),
  };
  return {
    win: raw as unknown as QuitGuardWindow,
    closeListeners,
    /** 按真实事件形态派发渲染层应答（webContents.ipc 面：listener(event, dirty)）。 */
    reply(dirty: unknown): void {
      for (const listener of ipcListeners.get(IpcEvent.AppDirtyCheckReply) ?? []) listener({}, dirty);
    },
    replyListenerCount(): number {
      return (ipcListeners.get(IpcEvent.AppDirtyCheckReply) ?? []).length;
    },
  };
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
    const { win, closeListeners, reply } = stubWindow();
    const confirmDiscard = vi.fn(async () => true);
    attachQuitGuard(win, { confirmDiscard });
    const event = fireClose(closeListeners);
    expect(event.preventDefault).toHaveBeenCalled(); // 询问期间扣住窗口
    await settle();
    expect(win.webContents.send).toHaveBeenCalledWith(IpcEvent.AppDirtyCheck);
    reply(false);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("有 dirty 取消：应答 true + 确认对话框取消 → 不销毁", async () => {
    const { win, closeListeners, reply } = stubWindow();
    const confirmDiscard = vi.fn(async () => false);
    attachQuitGuard(win, { confirmDiscard });
    fireClose(closeListeners);
    await settle();
    reply(true);
    await settle();
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("有 dirty 确认：应答 true + 确认丢弃 → 销毁", async () => {
    const { win, closeListeners, reply } = stubWindow();
    const confirmDiscard = vi.fn(async () => true);
    attachQuitGuard(win, { confirmDiscard });
    fireClose(closeListeners);
    await settle();
    reply(true);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("在途守卫：确认未完成时再次 close 不重复询问（防双击关窗的重复对话框）", async () => {
    const { win, closeListeners, reply } = stubWindow();
    attachQuitGuard(win, { confirmDiscard: async () => false });
    fireClose(closeListeners);
    fireClose(closeListeners); // 第一次询问在途
    await settle();
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    reply(false);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("askRendererDirty 问答语义", () => {
  it("应答 true → true；非布尔应答（缺省/坏形状）→ false", async () => {
    const first = stubWindow();
    const p1 = askRendererDirty(first.win);
    await settle();
    first.reply(true);
    await expect(p1).resolves.toBe(true);

    const second = stubWindow();
    const p2 = askRendererDirty(second.win);
    await settle();
    second.reply("yes");
    await expect(p2).resolves.toBe(false);
  });

  it("应答经 webContents.ipc 通道面注册；应答后移除一次性监听（不残留跨次应答器）", async () => {
    const { win, replyListenerCount, reply } = stubWindow();
    const p = askRendererDirty(win);
    await settle();
    expect(win.webContents.ipc.on).toHaveBeenCalledWith(IpcEvent.AppDirtyCheckReply, expect.any(Function));
    expect(replyListenerCount()).toBe(1);
    reply(false);
    await expect(p).resolves.toBe(false);
    expect(win.webContents.ipc.removeListener).toHaveBeenCalledWith(IpcEvent.AppDirtyCheckReply, expect.any(Function));
    expect(replyListenerCount()).toBe(0);
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
    const { win } = stubWindow();
    (win.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("webContents 已销毁");
    });
    const p = askRendererDirty(win);
    await settle();
    await expect(p).resolves.toBe(false);
  });
});

describe("退出标志收尾（审查次要 2：darwin Cmd+Q 僵留）", () => {
  /** before-quit 标志位夹具（读取并复位语义，与 main.ts 接线同款）。 */
  function makeFlag() {
    let flag = false;
    return {
      fireBeforeQuit: () => {
        flag = true;
      },
      shouldQuitAfterClose: () => {
        const requested = flag;
        flag = false;
        return requested;
      },
    };
  }

  it("标志命中（Cmd+Q/app.quit）+ 无 dirty：destroy 后补刀 quit", async () => {
    const { win, closeListeners, reply } = stubWindow();
    const { fireBeforeQuit, shouldQuitAfterClose } = makeFlag();
    const quit = vi.fn();
    attachQuitGuard(win, { confirmDiscard: async () => true, shouldQuitAfterClose, quit });
    fireBeforeQuit();
    fireClose(closeListeners);
    await settle();
    reply(false);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("无标志（darwin 红点关窗）：destroy 不补刀 quit（无窗驻留语义保留）", async () => {
    const { win, closeListeners, reply } = stubWindow();
    const { shouldQuitAfterClose } = makeFlag();
    const quit = vi.fn();
    attachQuitGuard(win, { confirmDiscard: async () => true, shouldQuitAfterClose, quit });
    fireClose(closeListeners);
    await settle();
    reply(false);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it("标志命中 + 有 dirty 确认：destroy 后补刀 quit；取消：不销毁不补刀且标志被消费复位（不劫持后续手动关窗）", async () => {
    const { win, closeListeners, reply } = stubWindow();
    const { fireBeforeQuit, shouldQuitAfterClose } = makeFlag();
    const quit = vi.fn();
    let allow = false;
    attachQuitGuard(win, { confirmDiscard: async () => allow, shouldQuitAfterClose, quit });
    // —— 取消分支：标志被消费但不补刀 ——
    fireBeforeQuit();
    fireClose(closeListeners);
    await settle();
    reply(true);
    await settle();
    expect(win.destroy).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    // 标志已复位：随后手动关窗（确认丢弃）只销毁、不再 quit
    allow = true;
    fireClose(closeListeners);
    await settle();
    reply(true);
    await settle();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });
});

// —— main.ts 接线冒烟：electron 全量 mock，走真实 main.ts 的 whenReady → createWindow →
// attachQuitGuard 链路，钉住「close 监听已挂 + 三态经 showMessageBox/destroy 收口 +
// before-quit 标志经 app.quit 补刀」。 ——
const electronState = vi.hoisted(() => ({
  windows: [] as Array<{
    closeListeners: Array<(event: { preventDefault(): void }) => void>;
    replyFromRenderer(dirty: unknown): void;
    destroy: () => void;
  }>,
  destroyCalls: 0,
  messageBoxCalls: 0,
  messageBoxResponse: 0,
  beforeQuitListeners: [] as Array<() => void>,
  quitCalls: 0,
}));

vi.mock("electron", () => {
  class BrowserWindow {
    closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
    ipcListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    webContents = {
      send: vi.fn(),
      ipc: {
        on: (channel: string, listener: (...args: unknown[]) => void) => {
          const list = this.ipcListeners.get(channel) ?? [];
          list.push(listener);
          this.ipcListeners.set(channel, list);
          return this.webContents.ipc;
        },
        removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
          const list = this.ipcListeners.get(channel) ?? [];
          const index = list.indexOf(listener);
          if (index >= 0) list.splice(index, 1);
          return this.webContents.ipc;
        },
      },
    };
    constructor() {
      electronState.windows.push(this);
    }
    /** 按真实事件形态派发渲染层应答（webContents.ipc 面）。 */
    replyFromRenderer(dirty: unknown): void {
      for (const listener of this.ipcListeners.get("app:dirty-check:reply") ?? []) listener({}, dirty);
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
      on: (event: string, listener: () => void) => {
        if (event === "before-quit") electronState.beforeQuitListeners.push(listener);
      },
      quit: () => {
        electronState.quitCalls += 1;
      },
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
    win.replyFromRenderer(false);
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
    win.replyFromRenderer(true);
    await settle();
    expect(electronState.messageBoxCalls).toBe(1);
    expect(electronState.destroyCalls).toBe(destroyedBefore);
    // —— 确认分支 ——
    electronState.messageBoxResponse = 0;
    fireClose(win.closeListeners);
    await settle();
    win.replyFromRenderer(true);
    await settle();
    expect(electronState.destroyCalls).toBe(destroyedBefore + 1);
  });

  it("before-quit 标志（Cmd+Q/app.quit）：销毁后经 app.quit 补刀（退出流程被 preventDefault 中止后的收尾）", async () => {
    const quitCallsBefore = electronState.quitCalls;
    for (const listener of [...electronState.beforeQuitListeners]) listener();
    fireClose(win.closeListeners);
    await settle();
    win.replyFromRenderer(false); // 无 dirty：直接放行销毁
    await settle();
    expect(electronState.destroyCalls).toBeGreaterThanOrEqual(1);
    expect(electronState.quitCalls).toBe(quitCallsBefore + 1);
  });
});
