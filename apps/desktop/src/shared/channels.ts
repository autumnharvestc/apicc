export const IpcChannel = {
  WsOpen: "ws:open",
  WsCreate: "ws:create",
  WsPickDirectory: "ws:pickDirectory",
  WsValidate: "ws:validate",
  TreeGet: "tree:get",
  NodeCreate: "node:create",
  NodeRename: "node:rename",
  NodeDelete: "node:delete",
  EnvCreate: "env:create",
  EnvVarsSave: "env:vars:save",
  ApiGet: "api:get",
  ApiSave: "api:save",
  DebugSend: "debug:send",
  RunCollection: "run:collection",
  RunsList: "runs:list",
  RunsGet: "runs:get",
} as const;
export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
