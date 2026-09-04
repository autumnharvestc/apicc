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
  importPreview: (input: unknown) => ipcRenderer.invoke(IpcChannel.ImportPreview, input),
  importApply: (input: unknown) => ipcRenderer.invoke(IpcChannel.ImportApply, input),
  designExport: (apiId: string) => ipcRenderer.invoke(IpcChannel.DesignExport, apiId),
  // 工作流频道（M2-B 任务 1）：多参方法在 preload 侧包对象，主进程按对象 schema 校验。
  wfList: (projectId: string) => ipcRenderer.invoke(IpcChannel.WfList, { projectId }),
  wfGet: (workflowId: string) => ipcRenderer.invoke(IpcChannel.WfGet, { workflowId }),
  wfCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.WfCreate, input),
  wfDelete: (workflowId: string) => ipcRenderer.invoke(IpcChannel.WfDelete, { workflowId }),
  wfRename: (workflowId: string, name: string) => ipcRenderer.invoke(IpcChannel.WfRename, { workflowId, name }),
  wfSave: (workflow: unknown) => ipcRenderer.invoke(IpcChannel.WfSave, { workflow }),
  wfSetStatus: (workflowId: string, next: string) => ipcRenderer.invoke(IpcChannel.WfSetStatus, { workflowId, next }),
  wfImpact: (input: unknown) => ipcRenderer.invoke(IpcChannel.WfImpact, input),
  wfRun: (input: unknown) => ipcRenderer.invoke(IpcChannel.WfRun, input),
  // 压测频道（M2-D3 任务 1）
  stressRun: (input: unknown) => ipcRenderer.invoke(IpcChannel.StressRun, input),
  stressStop: () => ipcRenderer.invoke(IpcChannel.StressStop),
  // 在线频道（M3-B 任务 1）：单参频道包对象，主进程按 online 契约 schema 校验
  onlineRegister: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineRegister, input),
  onlineLogin: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineLogin, input),
  onlineLogout: () => ipcRenderer.invoke(IpcChannel.OnlineLogout),
  onlineMe: () => ipcRenderer.invoke(IpcChannel.OnlineMe),
  onlineWorkspaceList: () => ipcRenderer.invoke(IpcChannel.OnlineWorkspaceList),
  onlineWorkspaceCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineWorkspaceCreate, input),
  onlineTreeGet: (workspaceId: string) => ipcRenderer.invoke(IpcChannel.OnlineTreeGet, { workspaceId }),
  onlineFilesGet: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineFilesGet, input),
  onlineFilePut: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineFilePut, input),
  onlineFilesBatch: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineFilesBatch, input),
  onlineFileDelete: (input: unknown) => ipcRenderer.invoke(IpcChannel.OnlineFileDelete, input),
};

contextBridge.exposeInMainWorld("apicc", api);
