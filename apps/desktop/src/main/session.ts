import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileStorage, type ApiDefinition, type Collection, type Group, type Project, type Workspace, type LoadProblem, HttpMethod } from "@apicc/core";
import { randomUUID } from "node:crypto";

export interface ApiLocation { api: ApiDefinition; collection: Collection; project: Project; group: Group; folder: { id: string; name: string; apis: ApiDefinition[] } | null }

export type NodeKind = "group" | "project" | "collection" | "folder" | "api" | "environment";

/** 主进程工作区会话：内存模型为唯一事实源，save() 全量落盘（规格 §4）。 */
export function createSession() {
  let root: string | null = null;
  let workspace: Workspace | null = null;

  function ensureOpen(): { root: string; workspace: Workspace } {
    if (!root || !workspace) throw new Error("尚未打开工作区");
    return { root, workspace: workspace! };
  }

  function createGroup(name: string): Group {
    const { workspace: ws } = ensureOpen();
    const group: Group = { id: randomUUID(), name, projects: [] };
    ws.groups.push(group);
    return group;
  }

  function createProject(groupId: string, name: string): Project {
    const { workspace: ws } = ensureOpen();
    const group = ws.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`未找到分组: ${groupId}`);
    const project: Project = { id: randomUUID(), name, variables: {}, environments: [], collections: [] };
    group.projects.push(project);
    return project;
  }

  function createCollection(projectId: string, name: string): Collection {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const collection: Collection = { id: randomUUID(), name, variables: {}, folders: [], apis: [] };
    project.collections.push(collection);
    return collection;
  }

  function createFolder(collectionId: string, name: string): { id: string; name: string; apis: ApiDefinition[] } {
    const { workspace: ws } = ensureOpen();
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
    const folder = { id: randomUUID(), name, apis: [] };
    collection.folders.push(folder);
    return folder;
  }

  function createApi(collectionId: string, folderId: string | null, input: { name: string; method: HttpMethod; url: string }): ApiDefinition {
    const { workspace: ws } = ensureOpen();
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
    const api: ApiDefinition = {
      id: randomUUID(), name: input.name, version: "1.0.0", deprecated: false,
      method: input.method, url: input.url, headers: [], query: [],
      cases: [{ id: randomUUID(), name: "冒烟", scope: "base", parameters: {}, assertions: [] }],
    };
    if (folderId) {
      const folder = collection.folders.find((f) => f.id === folderId);
      if (!folder) throw new Error(`未找到文件夹: ${folderId}`);
      folder.apis.push(api);
    } else {
      collection.apis.push(api);
    }
    return api;
  }

  function locateApi(apiId: string): ApiLocation | undefined {
    const { workspace: ws } = ensureOpen();
    for (const group of ws.groups) {
      for (const project of group.projects) {
        for (const collection of project.collections) {
          const api = collection.apis.find((a) => a.id === apiId);
          if (api) return { api, collection, project, group, folder: null };
          for (const folder of collection.folders) {
            const fApi = folder.apis.find((a) => a.id === apiId);
            if (fApi) return { api: fApi, collection, project, group, folder };
          }
        }
      }
    }
    return undefined;
  }

  async function saveApi(api: ApiDefinition): Promise<void> {
    const loc = locateApi(api.id);
    if (!loc) throw new Error(`未找到接口: ${api.id}`);
    const list = loc.folder ? loc.folder.apis : loc.collection.apis;
    const index = list.findIndex((a) => a.id === api.id);
    list[index] = api;
    await save();
  }

  function renameNode(kind: NodeKind, id: string, name: string): void {
    const { workspace: ws } = ensureOpen();
    if (kind === "group") { const n = ws.groups.find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "project") { const n = ws.groups.flatMap((g) => g.projects).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "collection") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "folder") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).flatMap((c) => c.folders).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    if (kind === "environment") { const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === id); if (!n) throw new Error(`未找到: ${id}`); n.name = name; return; }
    const loc = locateApi(id);
    if (!loc) throw new Error(`未找到: ${id}`);
    loc.api.name = name;
  }

  function deleteNode(kind: NodeKind, id: string): void {
    const { workspace: ws } = ensureOpen();
    const removeFrom = <T>(list: T[], pred: (x: T) => boolean) => {
      const index = list.findIndex(pred);
      if (index >= 0) list.splice(index, 1);
      return index >= 0;
    };
    if (kind === "group") { removeFrom(ws.groups, (x) => x.id === id); return; }
    for (const g of ws.groups) {
      if (kind === "project" && removeFrom(g.projects, (x) => x.id === id)) return;
      for (const p of g.projects) {
        if (kind === "environment" && removeFrom(p.environments, (x) => x.id === id)) return;
        for (const c of p.collections) {
          if (kind === "collection" && removeFrom(p.collections, (x) => x.id === id)) return;
          if (kind === "folder" && removeFrom(c.folders, (x) => x.id === id)) return;
          if (kind === "api") {
            if (removeFrom(c.apis, (x) => x.id === id)) return;
            for (const f of c.folders) if (removeFrom(f.apis, (x) => x.id === id)) return;
          }
        }
      }
    }
    throw new Error(`未找到: ${id}`);
  }

  async function save(): Promise<void> {
    const { root: r, workspace: ws } = ensureOpen();
    await fileStorage.save(r, ws);
    cleanupOrphanDirs(r, ws);
  }

  /** 重命名后清理盘上旧目录（save 只写新路径；规格账本：孤儿清理在此收口）。 */
  function cleanupOrphanDirs(rootDir: string, ws: Workspace): void {
    const groupsDir = join(rootDir, "groups");
    if (!existsSync(groupsDir)) return;
    for (const gName of readdirSafe(groupsDir)) {
      const gDir = join(groupsDir, gName);
      const g = ws.groups.find((x) => x.name === gName);
      if (!g) { rmSync(gDir, { recursive: true, force: true }); continue; }
      const projectsDir = join(gDir, "projects");
      for (const pName of readdirSafe(projectsDir)) {
        const p = g.projects.find((x) => x.name === pName);
        if (!p) { rmSync(join(projectsDir, pName), { recursive: true, force: true }); continue; }
        const collectionsDir = join(projectsDir, pName, "collections");
        for (const cName of readdirSafe(collectionsDir)) {
          const c = p.collections.find((x) => x.name === cName);
          if (!c) { rmSync(join(collectionsDir, cName), { recursive: true, force: true }); continue; }
          const apisDir = join(collectionsDir, cName, "apis");
          for (const aName of readdirSafe(apisDir)) {
            if (!c.apis.find((x) => x.name === aName) && !c.folders.find((x) => x.name === aName)) {
              rmSync(join(apisDir, aName), { recursive: true, force: true });
            }
          }
          const foldersDir = join(collectionsDir, cName, "folders");
          for (const fName of readdirSafe(foldersDir)) {
            if (!c.folders.find((x) => x.name === fName)) {
              rmSync(join(foldersDir, fName), { recursive: true, force: true });
            }
          }
        }
      }
    }
  }

  return {
    get root() { return root; },
    get workspace() { return workspace; },
    async open(dir: string) {
      const storage = fileStorage;
      const loaded = await storage.load(dir);
      root = dir;
      workspace = loaded.workspace;
      return { workspace: loaded.workspace, problems: loaded.problems as LoadProblem[], root: dir };
    },
    async create(dir: string, name: string) {
      if (existsSync(join(dir, "apicc.workspace.yaml"))) throw new Error("目录已是工作区");
      mkdirSync(dir, { recursive: true });
      const ws: Workspace = { id: randomUUID(), name, variables: {}, groups: [] };
      await fileStorage.save(dir, ws);
      root = dir;
      workspace = ws;
      return { workspace: ws, problems: [] as LoadProblem[], root: dir };
    },
    async validate(): Promise<LoadProblem[]> {
      const { root: r } = ensureOpen();
      return (await fileStorage.load(r)).problems;
    },
    createGroup, createProject, createCollection, createFolder, createApi,
    locateApi, saveApi, renameNode, deleteNode, save,
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
