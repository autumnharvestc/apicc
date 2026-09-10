import { IpcEvent } from "../shared/channels.js";

/**
 * 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）：main 进程没有渲染层状态，聚合 dirty
 * 只有渲染层知道——采用「关窗时下行询问 + 一次性上行应答」的最简问答（webContents.send +
 * ipcRenderer.on，无预存快照的陈旧风险；取舍记录见 task-6 报告）。
 *
 * 结构取舍：main.ts 的 whenReady 闭包内联装配不利「窗口 close 事件可控 stub 驱动」的测试，
 * 本模块把拦截编排抽成 electron 仅作 type import 的纯编排（运行时零 electron 依赖，vitest
 * node 环境可直载），main.ts 只保留 attach + 确认对话框两行接线。
 */

/** close 事件与 dirty 问答所需的窗口面（BrowserWindow 结构子集；测试传可控 stub）。 */
export interface QuitGuardWindow {
  on(event: string, listener: (event: { preventDefault(): void }) => void): unknown;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, listener: (...args: unknown[]) => void): unknown;
    removeListener(channel: string, listener: (...args: unknown[]) => void): unknown;
  };
  destroy(): void;
}

/**
 * 向渲染层询问聚合 dirty：下行 AppDirtyCheck，等 AppDirtyCheckReply 一次性应答。
 * 应答非 true（false/缺省/坏形状）与超时/发送失败一律按「不脏」放行——渲染层已崩溃/无响应
 * 时其未保存态已随之消亡，本地无数据可丢（已保存数据此前均已落盘）。
 */
export function askRendererDirty(win: QuitGuardWindow, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const listener = (...args: unknown[]) => finish(args[1] === true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(dirty: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener(IpcEvent.AppDirtyCheckReply, listener);
      resolve(dirty);
    }
    win.webContents.on(IpcEvent.AppDirtyCheckReply, listener);
    try {
      win.webContents.send(IpcEvent.AppDirtyCheck);
    } catch {
      finish(false);
    }
  });
}

/**
 * 窗口 close 拦截编排：close 先 preventDefault 扣住窗口（dirty 询问是异步的，无法同步决定
 * 放行）→ 询问渲染层聚合 dirty → 无草稿直接销毁放行；有草稿弹确认（deps.confirmDiscard
 * 返回 true = 确认丢弃）→ 确认才销毁，取消不关。destroy() 不触发 close 事件，无重入回路；
 * 在途守卫防双击关窗的重复询问/对话框。darwin 语义：拦截同样生效（点红关窗走同一确认流程）。
 */
export function attachQuitGuard(win: QuitGuardWindow, deps: { confirmDiscard: () => Promise<boolean> }): void {
  let guarding = false;
  win.on("close", (event) => {
    event.preventDefault();
    if (guarding) return;
    guarding = true;
    void (async () => {
      try {
        if (!(await askRendererDirty(win))) {
          win.destroy();
          return;
        }
        if (await deps.confirmDiscard()) win.destroy();
      } finally {
        guarding = false;
      }
    })();
  });
}
