import { onlineTreeNodeKey, type OnlineTreeKind, type OnlineTreeNodeDTO } from "../tree-dto.js";
import type { OnlineTree, OnlineTreeFile } from "./contract.js";

// —— onlineTreeToDto（裁定 A：path 清单 → 侧树层级，纯函数）——
// path 实体化（2026-09-08）：内容 path 首段=项目实体 id（2026-09-09 服务端 BIGINT 化后为数字），
// 服务端已无 groups/<组>/projects/<名> 名称目录（旧形态服务端 400 path_invalid、不再产出）；
// tree.projects 行（实体表产出）携带项目名称与 groupId，分组名不再经 tree 下发——侧树项目节点
// 以 projectId 关联（id=项目 id）直接挂根。

/** 项目 id 形态：十进制数字（服务端 BIGINT 实体主键，与服务端 ContentPaths.PROJECT_ID_PATTERN 同口径）。 */
const PROJECT_ID_PATTERN = /^\d+$/;

/** path 解析产物：项目内布局逐段匹配；未匹配 = 杂散文件，不进树。 */
interface ParsedPath {
  project: string;
  collection?: string;
  folderIds?: string[];
  kind: "project-config" | "env" | "workflow" | "collection-config" | "folder-config" | "api";
  /** 叶显示名：配置文件取文件名、环境取文件名、工作流/接口取目录名。 */
  name: string;
}

function parseWorkspacePath(path: string): ParsedPath | null {
  const segs = path.split("/");
  // 首段为合法数字 id（且至少两层）即视为项目内文件；裸数字单段不归属（防文件占位目录，
  // 与服务端 parseProject 同口径）；根级仅 apicc.workspace.yaml（onlineTreeToDto 直取）。
  if (segs.length < 2 || !PROJECT_ID_PATTERN.test(segs[0]!)) return null;
  const project = segs[0]!;
  if (segs.length === 2) return segs[1] === "project.yaml" ? { project, kind: "project-config", name: "project.yaml" } : null;
  if (segs.length === 3 && segs[1] === "environments") return { project, kind: "env", name: segs[2]! };
  if (segs.length === 4 && segs[1] === "workflows" && segs[3] === "workflow.yaml") {
    return { project, kind: "workflow", name: segs[2]! };
  }
  if (segs[1] !== "collections" || segs.length < 4) return null;
  const collection = segs[2]!;
  if (segs.length === 4) return segs[3] === "collection.yaml" ? { project, collection, kind: "collection-config", name: "collection.yaml" } : null;
  const folderIds: string[] = [];
  let index = 3;
  while (segs[index] === "folders" && segs[index + 1]) { folderIds.push(segs[index + 1]!); index += 2; }
  if (folderIds.length && segs.length === index + 1 && segs[index] === "folder.yaml") {
    return { project, collection, folderIds, kind: "folder-config", name: "folder.yaml" };
  }
  if (segs.length === index + 3 && segs[index] === "apis" && segs[index + 1] && segs[index + 2] === "api.yaml") {
    return { project, collection, folderIds, kind: "api", name: segs[index + 1]! };
  }
  return null;
}

function sortTree(node: OnlineTreeNodeDTO, projectRowOrder?: ReadonlyMap<string, number>): OnlineTreeNodeDTO {
  if (node.children?.length) {
    if (node.kind === "group" && projectRowOrder) {
      // 组内按 projects 行序（服务端实体表 (created_at,id) 决定性稳定序——与组织管理面创建序
      // 一致），不按 label 字典序（计划 C 任务 3 分组层裁定）
      const rank = (id: string) => projectRowOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
      node.children.sort((a, b) => rank(a.id) - rank(b.id));
    } else {
      node.children.sort((a, b) => (a.label === b.label ? (a.id < b.id ? -1 : 1) : a.label < b.label ? -1 : 1));
    }
    for (const child of node.children) sortTree(child, projectRowOrder);
  }
  return node;
}

/**
 * 服务端 tree → 侧树根 DTO。path 实体化（2026-09-08）后项目节点 id=项目实体 id（树内唯一，
 * 名称取 tree.projects 行、缺席回退 id）；api/file 叶 id 取文件全路径（渲染层据此 getFiles
 * 取内容，OnlineApiEditor 选中机制不变）。root label 优先取工作区名。
 *
 * 分组层（计划 C 任务 3）：groupNames（groupId → 组名，session.getTreeView 经 listGroups
 * 清单反查注入）提供时，有组归属且组名可得的项目节点挂到 `group:<groupId>` 合成组节点
 * （kind="group"，label=组名；id 合成前缀 `group:`——文件路径 id 空间不含此形态，绝不重叠），
 * 组内按 projects 行序；组名不可得（groupId 缺席/清单无此组）的孤儿项目保持直挂根；未提供
 * groupNames 时项目直挂根（既有扁平口径，e2e/旧调用零破坏）。
 */
export function onlineTreeToDto(tree: OnlineTree, workspaceName?: string, groupNames?: ReadonlyMap<string, string>): OnlineTreeNodeDTO {
  const root: OnlineTreeNodeDTO = {
    source: "online",
    kind: "root",
    id: tree.workspaceId,
    key: onlineTreeNodeKey(tree.workspaceId, "root", tree.workspaceId),
    label: workspaceName ?? tree.workspaceId,
    children: [],
  };
  const containers = new Map<string, OnlineTreeNodeDTO>();
  const ensure = (kind: OnlineTreeKind, id: string, label: string, parent: OnlineTreeNodeDTO): OnlineTreeNodeDTO => {
    const existing = containers.get(id);
    if (existing) return existing;
    const node: OnlineTreeNodeDTO = { source: "online", kind, id, key: onlineTreeNodeKey(tree.workspaceId, kind, id), label, children: [] };
    containers.set(id, node);
    parent.children!.push(node);
    return node;
  };
  const leaf = (id: string, label: string): OnlineTreeNodeDTO => ({
    source: "online", kind: "file", id, key: onlineTreeNodeKey(tree.workspaceId, "file", id), label, children: [],
  });

  // 根配置：apicc.workspace.yaml（工作区级"项目配置"只读叶）
  if (tree.files.some((f: OnlineTreeFile) => f.path === "apicc.workspace.yaml")) {
    root.children!.push(leaf("apicc.workspace.yaml", "apicc.workspace.yaml"));
  }
  const projectRows = new Map(tree.projects.map((p) => [p.id, p]));
  // 分组节点懒建（有项目文件挂入才存在——清单中无项目的组不造空组节点）
  const groupNode = (groupId: string): OnlineTreeNodeDTO | null => {
    const name = groupNames?.get(groupId);
    if (name === undefined) return null; // 组名不可得 → 孤儿项目直挂根
    const id = `group:${groupId}`;
    const existing = containers.get(id);
    if (existing) return existing;
    return ensure("group", id, name, root);
  };
  // 项目节点的挂载父节点：组归属 + 组名可得 → 合成组节点；否则根
  const projectParent = (projectId: string): OnlineTreeNodeDTO => {
    const groupId = projectRows.get(projectId)?.groupId;
    return (groupId !== undefined ? groupNode(groupId) : null) ?? root;
  };
  for (const projectRow of tree.projects) {
    const project = ensure("project", projectRow.id, projectRow.name, projectParent(projectRow.id));
    project.myRole = projectRow.myRole;
  }
  for (const file of tree.files) {
    if (file.path === "apicc.workspace.yaml") continue;
    const parsed = parseWorkspacePath(file.path);
    if (!parsed) continue;
    const projectRow = projectRows.get(parsed.project);
    const project = ensure("project", parsed.project, projectRow?.name ?? parsed.project, projectParent(parsed.project));
    if (projectRow) project.myRole = projectRow.myRole;
    if (parsed.kind === "project-config") {
      project.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    if (parsed.kind === "env" || parsed.kind === "workflow") {
      project.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    const collection = ensure(
      "collection",
      `${parsed.project}/collections/${parsed.collection}`,
      parsed.collection!,
      project,
    );
    if (parsed.kind === "collection-config") {
      collection.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    let folderNode = collection;
    for (const folder of parsed.folderIds ?? []) folderNode = ensure("folder", `${folderNode.id}/folders/${folder}`, folder, folderNode);
    if (parsed.kind === "folder-config") {
      // folder.yaml 只读叶挂在 folder 节点（folder 仅为 folder.yaml 存在时也建容器，与 collection-config 同口径）
      folderNode.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    // api 叶 id = api.yaml 全路径：选中后渲染层按该路径 getFiles 取内容（裁定 B）
    folderNode.children!.push({
      source: "online",
      kind: "api",
      id: file.path,
      key: onlineTreeNodeKey(tree.workspaceId, "api", file.path),
      label: parsed.name,
      children: [],
    });
  }
  // 组内排序的行序表（projects 行下标）：仅注入了组名表时启用组内行序
  return sortTree(root, groupNames ? new Map(tree.projects.map((p, i) => [p.id, i])) : undefined);
}
