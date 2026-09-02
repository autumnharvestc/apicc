import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel } from "../shared/channels.js";

const api = {
  wsOpen: (rootPath: string) => ipcRenderer.invoke(IpcChannel.WsOpen, rootPath),
  wsCreate: (rootPath: string, name: string) => ipcRenderer.invoke(IpcChannel.WsCreate, rootPath, name),
  wsPickDirectory: () => ipcRenderer.invoke(IpcChannel.WsPickDirectory),
  wsValidate: () => ipcRenderer.invoke(IpcChannel.WsValidate),
  treeGet: () => ipcRenderer.invoke(IpcChannel.TreeGet),
  nodeCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.NodeCreate, input),
  nodeRename: (kind: string, id: string, name: string) => ipcRenderer.invoke(IpcChannel.NodeRename, kind, id, name),
  nodeDelete: (kind: string, id: string) => ipcRenderer.invoke(IpcChannel.NodeDelete, kind, id),
  envCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.EnvCreate, input),
  envVarsSave: (envId: string, variables: unknown) => ipcRenderer.invoke(IpcChannel.EnvVarsSave, envId, variables),
  apiGet: (apiId: string) => ipcRenderer.invoke(IpcChannel.ApiGet, apiId),
  apiSave: (api: unknown) => ipcRenderer.invoke(IpcChannel.ApiSave, api),
  debugSend: (input: unknown) => ipcRenderer.invoke(IpcChannel.DebugSend, input),
  runCollection: (input: unknown) => ipcRenderer.invoke(IpcChannel.RunCollection, input),
  runsList: () => ipcRenderer.invoke(IpcChannel.RunsList),
  runsGet: (file: string) => ipcRenderer.invoke(IpcChannel.RunsGet, file),
};

contextBridge.exposeInMainWorld("apicc", api);
