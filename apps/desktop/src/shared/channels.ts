export const IpcChannel = {
  WsOpen: "ws:open",
  WsCreate: "ws:create",
  WsPickDirectory: "ws:pickDirectory",
  WsValidate: "ws:validate",
  TreeGet: "tree:get",
  NodeCreate: "node:create",
  NodeRename: "node:rename",
  NodeDelete: "node:delete",
  ApiGet: "api:get",
  ApiSave: "api:save",
  DebugSend: "debug:send",
} as const;
export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
