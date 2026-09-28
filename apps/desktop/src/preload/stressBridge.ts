import { IpcChannel } from "../shared/channels.js";
import type { IpcChannelName } from "../shared/channels.js";
import { StressRunResultSchema, type StressRunInput, type StressRunOutput, type StressRunResult } from "../shared/types.js";

export interface StressIpcInvoker {
  invoke(channel: IpcChannelName, ...args: unknown[]): Promise<unknown>;
}

/** The same invoke/clone boundary used by preload, kept pure for an IPC-equivalent test seam. */
export function createStressPreloadApi(ipcRenderer: StressIpcInvoker) {
  return {
    async stressRun(input: StressRunInput): Promise<StressRunResult> {
      return StressRunResultSchema.parse(await ipcRenderer.invoke(IpcChannel.StressRun, input));
    },
    async stressStop(): Promise<StressRunOutput> {
      const result = StressRunResultSchema.parse(await ipcRenderer.invoke(IpcChannel.StressStop));
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
  };
}
