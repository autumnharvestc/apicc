import { type RunResult, type Workspace } from "@apicc/core";
import { join } from "node:path";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import type { ApiDetail, DebugInput, DebugOutput, EnvCreateInput, NodeCreateInput, NodeCreatedDTO, OpenResult, RunCollectionInput, RunSummaryDTO } from "../shared/types.js";
import { runCollection, sendDebug, workspaceRunsDir } from "./debug.js";
import { listRuns, readRun } from "./runs.js";
import type { createSession } from "./session.js";
import { toTreeNode, type TreeNodeDTO } from "./tree.js";

type Session = ReturnType<typeof createSession>;

export interface IpcDepsOptions {
  session: Session;
  pickDirectory: () => Promise<string>;
}

export function createIpcDeps(options: IpcDepsOptions) {
  const { session, pickDirectory } = options;

  /**
   * api 分支父解析（宽审查 C1）：parentId 可能是文件夹 id——先在工作区中按文件夹命中
   （取其所属集合 id 作 collectionId、文件夹 id 作 folderId）；未命中再按集合 id 解析
   （folderId=null，挂集合根）。此前直接把 parentId 当集合 id 传给 createApi，
   侧树文件夹行上的「新建接口」一按就抛「未找到集合」。
   */
  function resolveApiParent(ws: Workspace | null, parentId: string): { collectionId: string; folderId: string | null } {
    if (ws) {
      for (const group of ws.groups) {
        for (const project of group.projects) {
          for (const collection of project.collections) {
            const folder = collection.folders.find((f) => f.id === parentId);
            if (folder) return { collectionId: collection.id, folderId: folder.id };
          }
        }
      }
    }
    return { collectionId: parentId, folderId: null };
  }

  // 返回统一瘦 DTO（宽审查 I2）：与 memory 替身同构，渲染层无需感知原生节点形状。
  function createNode(input: NodeCreateInput): NodeCreatedDTO {
    switch (input.kind) {
      case "group": {
        const g = session.createGroup(input.name);
        return { kind: "group", id: g.id, label: g.name };
      }
      case "project": {
        const p = session.createProject(input.parentId!, input.name);
        return { kind: "project", id: p.id, label: p.name };
      }
      case "collection": {
        const c = session.createCollection(input.parentId!, input.name);
        return { kind: "collection", id: c.id, label: c.name };
      }
      case "folder": {
        const f = session.createFolder(input.parentId!, input.name);
        return { kind: "folder", id: f.id, label: f.name };
      }
      case "api": {
        const parent = resolveApiParent(session.workspace, input.parentId!);
        const a = session.createApi(parent.collectionId, parent.folderId, {
          name: input.name,
          method: (input.method ?? "GET") as Parameters<Session["createApi"]>[2]["method"],
          url: input.url ?? "/",
        });
        return { kind: "api", id: a.id, label: a.name, method: a.method };
      }
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
        // 返回统一瘦 DTO（kind/id/label[/method]，宽审查 I2），渲染层据此定位与续操作。
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
      // 环境频道（任务 4）：session 变更操作不自动落盘，两分支均显式 save（语义备忘）。
      case IpcChannel.EnvCreate: {
        const input = args[0] as EnvCreateInput;
        const env = session.createEnvironment(input.projectId, { name: input.name, extends: input.extends });
        await session.save();
        return env;
      }
      case IpcChannel.EnvVarsSave: {
        const [envId, variables] = args as [string, Record<string, string>];
        session.setEnvironmentVariables(envId, variables);
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
      // 运行频道（任务 6）：run:collection 走完整 Runner 并固定落盘 .apicc/runs；
      // runs:list/get 读历史（目录不存在/文件损坏已在 runs.ts 侧降级为 []/null）。
      case IpcChannel.RunCollection: {
        const run = await runCollection(session, args[0] as RunCollectionInput);
        return run satisfies RunResult;
      }
      case IpcChannel.RunsList: {
        if (!session.root) throw new Error("尚未打开工作区");
        return listRuns(workspaceRunsDir(session.root)) satisfies RunSummaryDTO[];
      }
      case IpcChannel.RunsGet: {
        if (!session.root) throw new Error("尚未打开工作区");
        return readRun(workspaceRunsDir(session.root), args[0] as string);
      }
      default:
        throw new Error(`未知频道: ${channel}`);
    }
  }

  return { handle };
}
