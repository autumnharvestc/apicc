import { contextBridge, ipcRenderer } from "electron";
import { IpcChannel, IpcEvent } from "../shared/channels.js";
import type { IpcChannelName } from "../shared/channels.js";
import type { IpcArgsMap, IpcResultMap } from "../shared/ipc-contract.js";
import type { ApiccApi } from "../shared/types.js";
import { CredentialMutationResultSchema, CredentialStatusResultSchema } from "../shared/credentials.js";
import { createStressPreloadApi } from "./stressBridge.js";

function invoke<Channel extends IpcChannelName>(channel: Channel, ...args: IpcArgsMap[Channel]): Promise<IpcResultMap[Channel]> {
  return ipcRenderer.invoke(channel, ...args).then((result: unknown) => result as IpcResultMap[Channel]);
}

const stressApi = createStressPreloadApi(ipcRenderer);

const api: ApiccApi = {
  wsOpen: (rootPath) => invoke(IpcChannel.WsOpen, rootPath),
  wsCreate: (rootPath, name) => invoke(IpcChannel.WsCreate, rootPath, name),
  wsPickDirectory: () => invoke(IpcChannel.WsPickDirectory),
  wsValidate: () => invoke(IpcChannel.WsValidate),
  treeGet: () => invoke(IpcChannel.TreeGet),
  nodeCreate: (input) => invoke(IpcChannel.NodeCreate, input),
  nodeRename: (node, name) => invoke(IpcChannel.NodeRename, node, name),
  nodeDelete: (node) => invoke(IpcChannel.NodeDelete, node),
  envCreate: (input) => invoke(IpcChannel.EnvCreate, input),
  envVarsSave: (locator, variables) => invoke(IpcChannel.EnvVarsSave, locator, variables),
  envBaseUrlsSave: (locator, baseUrls) => invoke(IpcChannel.EnvBaseUrlsSave, locator, baseUrls),
  globalsSave: (locator, globals) => invoke(IpcChannel.GlobalsSave, locator, globals),
  stressPolicySave: (locator, policy) => invoke(IpcChannel.StressPolicySave, locator, policy),
  containerSave: (input) => invoke(IpcChannel.ContainerSave, input),
  containerGet: (target) => invoke(IpcChannel.ContainerGet, target),
  globalsGet: (locator) => invoke(IpcChannel.GlobalsGet, locator),
  apiGet: (locator) => invoke(IpcChannel.ApiGet, locator),
  apiSave: (locator, asset) => invoke(IpcChannel.ApiSave, locator, asset),
  caseSave: (locator, testCase) => invoke(IpcChannel.CaseSave, locator, testCase),
  caseDelete: (locator) => invoke(IpcChannel.CaseDelete, locator),
  modelList: (locator) => invoke(IpcChannel.ModelList, locator),
  modelGet: (locator) => invoke(IpcChannel.ModelGet, locator),
  modelCreate: (locator, input) => invoke(IpcChannel.ModelCreate, locator, input),
  modelSave: (locator, model) => invoke(IpcChannel.ModelSave, locator, model),
  componentList: (locator) => invoke(IpcChannel.ComponentList, locator),
  componentGet: (locator) => invoke(IpcChannel.ComponentGet, locator),
  componentCreate: (locator, input) => invoke(IpcChannel.ComponentCreate, locator, input),
  componentSave: (locator, component) => invoke(IpcChannel.ComponentSave, locator, component),
  assetReferences: (locator, assetId) => invoke(IpcChannel.AssetReferences, locator, assetId),
  debugSend: (input) => invoke(IpcChannel.DebugSend, input),
  runCollection: (input) => invoke(IpcChannel.RunCollection, input),
  runsList: () => invoke(IpcChannel.RunsList),
  runsGet: (file) => invoke(IpcChannel.RunsGet, file),
  stressRun: stressApi.stressRun,
  stressStop: stressApi.stressStop,
  credentialPut: (input) => ipcRenderer.invoke(IpcChannel.CredentialPut, input).then((result: unknown) => CredentialMutationResultSchema.parse(result)),
  credentialRemove: (input) => ipcRenderer.invoke(IpcChannel.CredentialRemove, input).then((result: unknown) => CredentialMutationResultSchema.parse(result)),
  credentialStatus: (input) => ipcRenderer.invoke(IpcChannel.CredentialStatus, input).then((result: unknown) => CredentialStatusResultSchema.parse(result)),
  importPreview: (input) => invoke(IpcChannel.ImportPreview, input),
  importApply: (input) => invoke(IpcChannel.ImportApply, input),
  projectClone: (locator) => invoke(IpcChannel.ProjectClone, locator),
  projectMove: (source, target) => invoke(IpcChannel.ProjectMove, source, target),
  designExport: (locator) => invoke(IpcChannel.DesignExport, locator),
  wfList: (locator) => invoke(IpcChannel.WfList, locator),
  wfGet: (locator) => invoke(IpcChannel.WfGet, locator),
  wfCreate: (input) => invoke(IpcChannel.WfCreate, input),
  wfDelete: (locator) => invoke(IpcChannel.WfDelete, locator),
  wfRename: (locator, name) => invoke(IpcChannel.WfRename, locator, name),
  wfSave: (locator, workflow) => invoke(IpcChannel.WfSave, locator, workflow),
  wfSetStatus: (locator, next) => invoke(IpcChannel.WfSetStatus, locator, next),
  wfImpact: (input) => invoke(IpcChannel.WfImpact, input),
  wfRun: (input) => invoke(IpcChannel.WfRun, input),
  authConfig: (baseUrl) => invoke(IpcChannel.OnlineAuthConfig, baseUrl),
  onlineRegister: (input) => invoke(IpcChannel.OnlineRegister, input),
  onlineLogin: (input) => invoke(IpcChannel.OnlineLogin, input),
  onlineLogout: () => invoke(IpcChannel.OnlineLogout),
  onlineResume: (input) => invoke(IpcChannel.OnlineResume, input),
  onlineMe: () => invoke(IpcChannel.OnlineMe),
  onlineWorkspaceList: () => invoke(IpcChannel.OnlineWorkspaceList),
  onlineWorkspaceCreate: (input) => invoke(IpcChannel.OnlineWorkspaceCreate, input),
  onlineTreeGet: (workspaceId) => invoke(IpcChannel.OnlineTreeGet, { workspaceId }),
  onlineFilesGet: (input) => invoke(IpcChannel.OnlineFilesGet, input),
  onlineFilePut: (input) => invoke(IpcChannel.OnlineFilePut, input),
  onlineFilesBatch: (input) => invoke(IpcChannel.OnlineFilesBatch, input),
  onlineFileDelete: (input) => invoke(IpcChannel.OnlineFileDelete, input),
  onlineWorkspaceOpen: (input) => invoke(IpcChannel.OnlineWorkspaceOpen, input),
  onlineWorkspaceActivate: (workspaceId) => invoke(IpcChannel.OnlineWorkspaceActivate, { workspaceId }),
  onlineWorkspaceClose: (input) => invoke(IpcChannel.OnlineWorkspaceClose, input),
  onlineTreeView: (workspaceId) => invoke(IpcChannel.OnlineTreeView, { workspaceId }),
  onlineMigrateScan: (dir) => invoke(IpcChannel.OnlineMigrateScan, { dir }),
  onlineMigrateWrite: (input) => invoke(IpcChannel.OnlineMigrateWrite, input),
  onlineProjectMapping: (input) => invoke(IpcChannel.OnlineProjectMapping, input),
  onlineGroupsList: (workspaceId) => invoke(IpcChannel.OnlineGroupsList, { workspaceId }),
  aiSaveConfig: (input) => invoke(IpcChannel.AiSaveConfig, input),
  aiGetConfig: () => invoke(IpcChannel.AiGetConfig),
  aiSuggest: (input) => invoke(IpcChannel.AiSuggest, input),
  aiTestConfig: (input) => invoke(IpcChannel.AiTestConfig, input),
  pluginsList: () => invoke(IpcChannel.PluginsList),
  onDirtyCheck: (handler) => {
    ipcRenderer.on(IpcEvent.AppDirtyCheck, () => ipcRenderer.send(IpcEvent.AppDirtyCheckReply, handler()));
  },
};

contextBridge.exposeInMainWorld("apicc", api);
