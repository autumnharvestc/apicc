import { ApiDefinitionSchema, createDefaultRegistry, ProjectSchema, renderDesignMarkdown, type Importer, type RunResult, type Workspace } from "@apicc/core";
import { z } from "zod";
import { join } from "node:path";
import { IpcChannel, type IpcChannelName } from "../shared/channels.js";
import type { ApiDetail, DebugInput, DebugOutput, EnvCreateInput, ImportApplyInput, ImportPreviewInput, NodeCreateInput, NodeCreatedDTO, OpenResult, RunCollectionInput, RunSummaryDTO } from "../shared/types.js";
import { runCollection, sendDebug, workspaceRunsDir } from "./debug.js";
import { listRuns, readRun } from "./runs.js";
import type { createSession } from "./session.js";
import { toTreeNode, type TreeNodeDTO } from "./tree.js";

type Session = ReturnType<typeof createSession>;

// —— 全频道入参 zod schema（任务 8 收口，与 shared/types.ts 字段一一对应）——
// 多参频道包 tuple；对象频道沿用 core 严格 schema 的口径（import:apply 的 project
// 多余字段 fail-fast，与导入器产物一致）；其余对象为最简 z.object。
const NodeKindSchema = z.enum(["group", "project", "collection", "folder", "api", "environment"]);
const NodeCreateInputSchema = z.object({
  kind: z.enum(["group", "project", "collection", "folder", "api"]),
  parentId: z.string().nullable(),
  name: z.string(),
  method: z.string().optional(),
  url: z.string().optional(),
});
// 可选字符串字段用 nullish（修复轮 1）：渲染层「无选中」惯例是 null（App.vue 的
// string | null computed、selectedEnvId/selectedCollectionId），optional 只认 undefined，
// store 原样透传 null 会被收口误伤。envName 的 null 由 resolveEnv 的 falsy 判断归一为
// 无环境运行；extends 的 null 在 env:create 分支显式归一为 undefined（模型 strict schema
// 拒绝 null，落盘不可带回）。
const EnvCreateInputSchema = z.object({ projectId: z.string(), name: z.string(), extends: z.string().nullish() });
const DebugInputSchema = z.object({ apiId: z.string(), caseId: z.string(), envName: z.string().nullish() });
const RunInputSchema = z.object({ collectionId: z.string(), envName: z.string().nullish() });
const ImportPreviewInputSchema = z.object({ fileName: z.string(), content: z.string() });
const ImportApplyInputSchema = z.object({ groupName: z.string(), project: ProjectSchema });

/** 频道 → 入参 tuple schema 表：Record 键为全部频道名，新增频道漏配 schema 即编译错误。 */
const schemas: Record<IpcChannelName, z.ZodTypeAny> = {
  [IpcChannel.WsOpen]: z.tuple([z.string()]),
  [IpcChannel.WsCreate]: z.tuple([z.string(), z.string()]),
  [IpcChannel.WsPickDirectory]: z.tuple([]),
  [IpcChannel.WsValidate]: z.tuple([]),
  [IpcChannel.TreeGet]: z.tuple([]),
  [IpcChannel.NodeCreate]: z.tuple([NodeCreateInputSchema]),
  [IpcChannel.NodeRename]: z.tuple([NodeKindSchema, z.string(), z.string()]),
  [IpcChannel.NodeDelete]: z.tuple([NodeKindSchema, z.string()]),
  [IpcChannel.EnvCreate]: z.tuple([EnvCreateInputSchema]),
  [IpcChannel.EnvVarsSave]: z.tuple([z.string(), z.record(z.string(), z.string())]),
  [IpcChannel.ApiGet]: z.tuple([z.string()]),
  [IpcChannel.ApiSave]: z.tuple([ApiDefinitionSchema]),
  [IpcChannel.DebugSend]: z.tuple([DebugInputSchema]),
  [IpcChannel.RunCollection]: z.tuple([RunInputSchema]),
  [IpcChannel.RunsList]: z.tuple([]),
  [IpcChannel.RunsGet]: z.tuple([z.string()]),
  [IpcChannel.ImportPreview]: z.tuple([ImportPreviewInputSchema]),
  [IpcChannel.ImportApply]: z.tuple([ImportApplyInputSchema]),
  [IpcChannel.DesignExport]: z.tuple([z.string()]),
};

/** 频道入参校验辅助：失败抛带频道名的可读错误（经组合根错误通道显示）。 */
function validateArgs<T>(channel: IpcChannelName, schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "未知错误";
    throw new Error(`[${channel}] 入参校验失败: ${where}`);
  }
  return result.data;
}

export interface IpcDepsOptions {
  session: Session;
  pickDirectory: () => Promise<string>;
  /**
   * 文件保存（design:export 用，任务 8）：生产实现 = dialog.showSaveDialog + 写盘，
   * 返回保存路径（用户取消回传空串）；测试注入内存实现。
   */
  saveFile: (defaultName: string, content: string) => Promise<string>;
  /** 导入器列表（任务 7）：默认取内置注册中心的全部导入器，测试注入固定 importer 替身。 */
  importers?: Importer[];
}

export function createIpcDeps(options: IpcDepsOptions) {
  const { session, pickDirectory, saveFile } = options;
  const importers = options.importers ?? createDefaultRegistry().listImporters();

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
    // 入参校验收口（任务 8）：所有频道在进入分支前统一按 tuple schema parse，
    // 形状非法即抛带频道名的可读错误，分支内不再依赖裸 as 断言兜底形状。
    const a = validateArgs(channel, schemas[channel]!, args) as unknown[];
    switch (channel) {
      case IpcChannel.WsOpen: {
        const r = await session.open(a[0] as string);
        return r satisfies OpenResult;
      }
      case IpcChannel.WsCreate: {
        const r = await session.create(a[0] as string, a[1] as string);
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
        const node = createNode(a[0] as NodeCreateInput);
        await session.save();
        return node;
      }
      case IpcChannel.NodeRename: {
        const [kind, id, name] = a as [Parameters<Session["renameNode"]>[0], string, string];
        session.renameNode(kind, id, name);
        await session.save();
        return undefined;
      }
      case IpcChannel.NodeDelete: {
        const [kind, id] = a as [Parameters<Session["deleteNode"]>[0], string];
        session.deleteNode(kind, id);
        await session.save();
        return undefined;
      }
      // 环境频道（任务 4）：session 变更操作不自动落盘，两分支均显式 save（语义备忘）。
      case IpcChannel.EnvCreate: {
        const input = a[0] as EnvCreateInput;
        // extends 显式 null 归一为 undefined：模型 strict schema 拒绝 null，不可写入后落盘。
        const env = session.createEnvironment(input.projectId, { name: input.name, extends: input.extends ?? undefined });
        await session.save();
        return env;
      }
      case IpcChannel.EnvVarsSave: {
        const [envId, variables] = a as [string, Record<string, string>];
        session.setEnvironmentVariables(envId, variables);
        await session.save();
        return undefined;
      }
      case IpcChannel.ApiGet: {
        const loc = session.locateApi(a[0] as string);
        if (!loc) throw new Error(`未找到接口: ${a[0] as string}`);
        const detail: ApiDetail = {
          api: loc.api,
          envs: loc.project.environments.map((e) => ({ id: e.id, name: e.name })),
        };
        return detail;
      }
      case IpcChannel.ApiSave: {
        // saveApi 内部已落盘（替换 + save），此处不再重复 save。
        await session.saveApi(a[0] as Parameters<Session["saveApi"]>[0]);
        return undefined;
      }
      case IpcChannel.DebugSend: {
        const result = await sendDebug(session, a[0] as DebugInput);
        return result satisfies DebugOutput;
      }
      // 运行频道（任务 6）：run:collection 走完整 Runner 并固定落盘 .apicc/runs；
      // runs:list/get 读历史（目录不存在/文件损坏已在 runs.ts 侧降级为 []/null）。
      case IpcChannel.RunCollection: {
        const run = await runCollection(session, a[0] as RunCollectionInput);
        return run satisfies RunResult;
      }
      case IpcChannel.RunsList: {
        if (!session.root) throw new Error("尚未打开工作区");
        return listRuns(workspaceRunsDir(session.root)) satisfies RunSummaryDTO[];
      }
      case IpcChannel.RunsGet: {
        if (!session.root) throw new Error("尚未打开工作区");
        return readRun(workspaceRunsDir(session.root), a[0] as string);
      }
      // 导入频道（任务 7）：preview 逐个 detect，命中即 parse（产物 id 均为新 UUID）；
      // apply 委派 session.importProject（缺分组建组、同分组重名拒绝），其内部显式落盘。
      case IpcChannel.ImportPreview: {
        const input = a[0] as ImportPreviewInput;
        const importer = importers.find((i) => i.detect(input.fileName, input.content));
        if (!importer) throw new Error("无法识别的导入格式");
        const { project, warnings } = importer.parse(input.content);
        return { importerName: importer.name, project, warnings };
      }
      case IpcChannel.ImportApply: {
        const input = a[0] as ImportApplyInput;
        await session.importProject(input.groupName, { project: input.project });
        return undefined;
      }
      // 详细设计导出（任务 8）：取接口 → core renderDesignMarkdown 渲染 → 注入的
      // saveFile（生产 = showSaveDialog + 写盘）落盘并返回路径（取消为空串）。
      case IpcChannel.DesignExport: {
        const apiId = a[0] as string;
        const loc = session.locateApi(apiId);
        if (!loc) throw new Error(`未找到接口: ${apiId}`);
        return saveFile(`${loc.api.name}.design.md`, renderDesignMarkdown(loc.api));
      }
      default:
        throw new Error(`未知频道: ${channel}`);
    }
  }

  return { handle };
}
