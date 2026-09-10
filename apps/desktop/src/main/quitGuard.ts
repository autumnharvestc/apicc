import { IpcEvent } from "../shared/channels.js";

/**
 * 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）：main 进程没有渲染层状态，聚合 dirty
 * 只有渲染层知道——采用「关窗时下行询问 + 一次性上行应答」的最简问答（webContents.send +
 * ipcRenderer.on，无预存快照的陈旧风险；取舍记录见 task-6 报告）。
 *
 * 接收侧通道面（2026-09-09 审查关键 1）：渲染层 `ipcRenderer.send` 在主进程只有两个接收面
 * ——`webContents.on("ipc-message", (event, channel, ...args))` 或 per-WebContents 的
 * `webContents.ipc.on(通道, (event, ...args))`；以通道名为 webContents 事件注册不存在、
 * 永不发射（真机后果：应答永不到达 → 超时 fail-open + 关窗白等超时）。本模块选
 * `webContents.ipc` 面（通道级注册、免逐事件过滤 channel；preload 的 `ipcRenderer.send`
 * 恰与其配对）。
 *
 * 结构取舍：main.ts 的 whenReady 闭包内联装配不利「窗口 close 事件可控 stub 驱动」的测试，
 * 本模块把拦截编排抽成 electron 仅作 type import 的纯编排（运行时零 electron 依赖，vitest
 * node 环境可直载），main.ts 只保留 attach + 确认对话框/退出标志两行接线。
 */

/** close 事件与 dirty 问答所需的窗口面（BrowserWindow 结构子集；测试传可控 stub）。 */
export interface QuitGuardWindow {
  on(event: string, listener: (event: { preventDefault(): void }) => void): unknown;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    /** 渲染层 ipcRenderer.send 的主进程接收面（per-WebContents 的 IpcMain 同形子集）。 */
    ipc: {
      on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
      removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
    };
  };
  destroy(): void;
}

export interface QuitGuardDeps {
  /** 原生确认对话框：true = 确认丢弃退出。 */
  confirmDiscard: () => Promise<boolean>;
  /**
   * 当次 close 是否由 app 退出流程触发（main 传 before-quit 标志位的「读取并复位」）。
   * 取标志位而非 platform 判定：Cmd+Q/app.quit 在任何平台都精确命中；darwin 红点关窗
   * （无 before-quit）不误退，保留 macOS「无窗驻留」习惯。
   */
  shouldQuitAfterClose?: () => boolean;
  /** 标志位命中且窗口被销毁后的收尾（main 传 () => app.quit()）：darwin 销毁后无窗不自动 quit，须补刀。 */
  quit?: () => void;
}

/**
 * 向渲染层询问聚合 dirty：下行 AppDirtyCheck，等 AppDirtyCheckReply 一次性应答。
 * 应答非 true（false/缺省/坏形状）与超时/发送失败一律按「不脏」放行——渲染层已崩溃/无响应
 * 时其未保存态已随之消亡，本地无数据可丢（已保存数据此前均已落盘）。
 */
export function askRendererDirty(win: QuitGuardWindow, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const listener = (_event: unknown, ...args: unknown[]) => finish(args[0] === true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(dirty: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.ipc.removeListener(IpcEvent.AppDirtyCheckReply, listener);
      resolve(dirty);
    }
    win.webContents.ipc.on(IpcEvent.AppDirtyCheckReply, listener);
    try {
      win.webContents.send(IpcEvent.AppDirtyCheck);
    } catch {
      finish(false);
    }
  });
}

/**
 * 窗口 close 拦截编排：close 先 preventDefault 扣住窗口（dirty 询问是异步的，无法同步决定
 * 放行）→ 询问渲染层聚合 dirty → 无草稿直接销毁放行；有草稿弹确认（confirmDiscard 返回
 * true = 确认丢弃）→ 确认才销毁，取消不关（同时消费并丢弃退出标志，防滞后标志劫持后续
 * 手动关窗）。destroy() 不触发 close 事件，无重入回路；在途守卫防双击关窗的重复询问/对话框。
 * 退出标志命中且窗口被销毁 → 补刀 deps.quit()（Cmd+Q 的既有 quit 流程已被 preventDefault
 * 中止；darwin 销毁后无窗不自动 quit，不补刀则应用无窗僵留）。
 */
export function attachQuitGuard(win: QuitGuardWindow, deps: QuitGuardDeps): void {
  let guarding = false;
  win.on("close", (event) => {
    event.preventDefault();
    if (guarding) return;
    guarding = true;
    void (async () => {
      try {
        let destroy = false;
        if (!(await askRendererDirty(win))) destroy = true;
        else if (await deps.confirmDiscard()) destroy = true;
        if (destroy) {
          win.destroy();
          if (deps.shouldQuitAfterClose?.()) deps.quit?.();
        } else {
          deps.shouldQuitAfterClose?.();
        }
      } finally {
        guarding = false;
      }
    })();
  });
}
