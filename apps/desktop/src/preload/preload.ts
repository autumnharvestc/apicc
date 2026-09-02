import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel } from "../shared/channels.js";

contextBridge.exposeInMainWorld("electronInvoke", (channel: string, ...args: unknown[]) => {
  if (!Object.values(IpcChannel).includes(channel as never)) {
    return Promise.reject(new Error(`未允许的 IPC 频道: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
});
