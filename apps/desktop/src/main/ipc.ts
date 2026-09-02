import type { IpcChannelName } from "../shared/channels.js";

export interface IpcDeps {
  handle(channel: IpcChannelName, event: unknown, ...args: unknown[]): Promise<unknown>;
}

// 任务 1 占位实现：仅保证主进程可编译、窗口可启动；
// 完整处理器（session/tree/debug 接线）由计划任务 4 的 src/main/ipc.ts 重写覆盖。
export function createIpcDeps(): IpcDeps {
  return {
    async handle(channel) {
      throw new Error(`IPC 处理器尚未实现: ${channel}`);
    },
  };
}
