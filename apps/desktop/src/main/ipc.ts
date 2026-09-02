import { type ApiDefinition, type Collection, type Folder, type Group, type Project } from "@apicc/core";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import type { ApiDetail, DebugInput, DebugOutput, NodeCreateInput, OpenResult } from "../shared/types.js";
import { sendDebug } from "./debug.js";
import type { createSession } from "./session.js";
import { toTreeNode, type TreeNodeDTO } from "./tree.js";

type Session = ReturnType<typeof createSession>;
type CreatedNode = Group | Project | Collection | Folder | ApiDefinition;

export interface IpcDepsOptions {
  session: Session;
  pickDirectory: () => Promise<string>;
}

export function createIpcDeps(options: IpcDepsOptions) {
  const { session, pickDirectory } = options;

  function createNode(input: NodeCreateInput): CreatedNode {
    switch (input.kind) {
      case "group": return session.createGroup(input.name);
      case "project": return session.createProject(input.parentId!, input.name);
      case "collection": return session.createCollection(input.parentId!, input.name);
      case "folder": return session.createFolder(input.parentId!, input.name);
      case "api": return session.createApi(input.parentId!, null, {
        name: input.name,
        method: (input.method ?? "GET") as Parameters<Session["createApi"]>[2]["method"],
        url: input.url ?? "/",
      });
    }
  }

  // 返回值用 any：各频道返回各自 DTO（关键形状已在分支内 satisfies 校验），
  // 测试与渲染层按频道直取属性，统一 unknown 会迫使每处断言。
  async function handle(channel: IpcChannelName, _event: unknown, ...args: unknown[]): Promise<any> {
    switch (channel) {
      case IpcChannel.WsOpen: {
        const r = await session.open(args[0] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsCreate: {
        const r = await session.create(args[0] as string, args[1] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsPickDirectory:
        return pickDirectory();
      case IpcChannel.WsValidate:
        return session.validate();
      case IpcChannel.TreeGet: {
        const ws = session.workspace;
        if (!ws) throw new Error("尚未打开工作区");
        return toTreeNode(ws) as TreeNodeDTO;
      }
      case IpcChannel.NodeCreate: {
        // 返回新建节点本体（含 id；api 还含 url/cases），渲染层据此定位与续操作。
        const node = createNode(args[0] as NodeCreateInput);
        await session.save();
        return node;
      }
      case IpcChannel.NodeRename: {
        const [kind, id, name] = args as [Parameters<Session["renameNode"]>[0], string, string];
        session.renameNode(kind, id, name);
        await session.save();
        return undefined;
      }
      case IpcChannel.NodeDelete: {
        const [kind, id] = args as [Parameters<Session["deleteNode"]>[0], string];
        session.deleteNode(kind, id);
        await session.save();
        return undefined;
      }
      case IpcChannel.ApiGet: {
        const loc = session.locateApi(args[0] as string);
        if (!loc) throw new Error(`未找到接口: ${args[0] as string}`);
        const detail: ApiDetail = {
          api: loc.api,
          envs: loc.project.environments.map((e) => ({ id: e.id, name: e.name })),
        };
        return detail;
      }
      case IpcChannel.ApiSave: {
        // saveApi 内部已落盘（替换 + save），此处不再重复 save。
        await session.saveApi(args[0] as Parameters<Session["saveApi"]>[0]);
        return undefined;
      }
      case IpcChannel.DebugSend: {
        const result = await sendDebug(session, args[0] as DebugInput);
        return result satisfies DebugOutput;
      }
      default:
        throw new Error(`未知频道: ${channel}`);
    }
  }

  return { handle };
}
