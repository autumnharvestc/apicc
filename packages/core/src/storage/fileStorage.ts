import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  ApiDefinitionSchema, CollectionSchema, EnvironmentSchema, FolderSchema, GroupSchema,
  ProjectSchema, TestCaseSchema, WorkspaceSchema,
} from "../domain/model.js";
import type { ApiDefinition, Collection, Folder, Group, Operation, Project, TestCase, Workspace } from "../domain/model.js";
import { WorkflowSchema } from "../workflow/model.js";
import type { LoadProblem, StorageAdapter } from "../plugin/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

function readYaml<T>(file: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: parseYaml(readFileSync(file, "utf8")) as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function zodErrorSummary(e: z.ZodError): string {
  return e.issues
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(根字段)"}: ${i.message}`)
    .join("; ");
}

/**
 * 读入 YAML 并经对应 zod schema 严格校验（规格 §6：逐文件 schema 校验，失败进 problems；
 * 校验通过后以解析结果（含 schema 默认值）构建域对象）。
 */
function loadYaml<S extends z.ZodType>(file: string, schema: S): { ok: true; data: z.output<S> } | { ok: false; error: string } {
  const raw = readYaml<unknown>(file);
  if (!raw.ok) return raw;
  const parsed = schema.safeParse(raw.data);
  if (!parsed.success) {
    return { ok: false, error: `schema 校验失败: ${zodErrorSummary(parsed.error)}` };
  }
  return { ok: true, data: parsed.data };
}

function writeYaml(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifyYaml(JSON.parse(JSON.stringify(data))));
}

/** 目录枚举统一按名称逐码点字典序排序（默认 sort 即 UTF-16 码点比较），保证跨平台加载顺序确定（规格 §6）。 */
function sortedNames(dir: string, filter?: (name: string) => boolean): string[] {
  const names = readdirSync(dir).filter((n) => (filter ? filter(n) : true));
  return names.sort();
}

function saveApiDir(aDir: string, api: ApiDefinition): void {
  writeYaml(join(aDir, "api.yaml"), {
    id: api.id, name: api.name, version: api.version, deprecated: api.deprecated,
    method: api.method, url: api.url, headers: api.headers, query: api.query,
    body: api.body, auth: api.auth,
    // M5 协议字段：非 http 时才落盘——http 接口的 yaml 形状与 M5 之前逐字节一致（零破坏）。
    // 白名单不对称（M5 终审账本口径澄清，非疏漏）：message 按值落盘——编辑器裁定③切协议
    // 保留各字段内容，切回 http 的接口残留 message 仍随值上盘（schema 对任意协议都允许可选
    // message，读回行为不变）；envelope/soapAction 仅 protocol=soap 落盘——切回非 soap 后
    // 这两字段只留内存不落盘，磁盘形状恒与协议一致（strict schema 下非 soap 接口不认这些字段）。
    ...(api.protocol && api.protocol !== "http" ? { protocol: api.protocol } : {}),
    ...(api.message !== undefined ? { message: api.message } : {}),
    ...(api.protocol === "soap" ? { envelope: api.envelope, ...(api.soapAction !== undefined ? { soapAction: api.soapAction } : {}) } : {}),
  });
  if (api.design) {
    mkdirSync(aDir, { recursive: true });
    writeFileSync(join(aDir, "design.md"), api.design);
  }
  for (const tc of api.cases) {
    const fileName = tc.scope === "base" ? `${tc.name}.yaml` : `${tc.name}.${tc.scope}.yaml`;
    writeYaml(join(aDir, "cases", fileName), tc);
  }
}

// —— M10 操作归一：旧「脚本」字段读取时转换为一条自定义脚本操作（写回只写新形态） ——
function scriptToOperation(id: string, content: string): Operation {
  return { id, type: "script", content };
}

function normalizeCaseOperations(tc: TestCase): void {
  if (tc.preScript && (tc.preOperations ?? []).length === 0) {
    tc.preOperations = [scriptToOperation(`${tc.id}-pre-legacy`, tc.preScript)];
  }
  if (tc.postScript && (tc.postOperations ?? []).length === 0) {
    tc.postOperations = [scriptToOperation(`${tc.id}-post-legacy`, tc.postScript)];
  }
}

function normalizeContainerOperations(container: Collection | Folder, legacy?: { pre?: string; post?: string }): void {
  const pre = legacy?.pre;
  const post = legacy?.post;
  if (pre && (container.preOperations ?? []).length === 0) {
    container.preOperations = [scriptToOperation(`${container.id}-pre-legacy`, pre)];
  }
  if (post && (container.postOperations ?? []).length === 0) {
    container.postOperations = [scriptToOperation(`${container.id}-post-legacy`, post)];
  }
}

/** 载入单个接口目录；relDir 为相对工作区根的目录路径，problem 的 file 一律用它拼接（规格 §8 可定位）。 */
async function loadApiDir(relDir: string, dir: string, problems: LoadProblem[]): Promise<ApiDefinition | null> {
  const apiFile = join(dir, "api.yaml");
  const relApiFile = join(relDir, "api.yaml");
  if (!existsSync(apiFile)) {
    problems.push({ file: relApiFile, message: "接口目录缺少 api.yaml，该目录已跳过" });
    return null;
  }
  const res = loadYaml(apiFile, ApiDefinitionSchema);
  if (!res.ok) {
    problems.push({ file: relApiFile, message: res.error });
    return null;
  }
  const api: ApiDefinition = res.data;
  const designFile = join(dir, "design.md");
  if (existsSync(designFile)) api.design = readFileSync(designFile, "utf8");
  api.cases = [];
  const casesDir = join(dir, "cases");
  if (existsSync(casesDir)) {
    for (const f of sortedNames(casesDir, (n) => n.endsWith(".yaml"))) {
      const cRes = loadYaml(join(casesDir, f), TestCaseSchema);
      if (!cRes.ok) {
        problems.push({ file: join(relDir, "cases", f), message: cRes.error });
        continue;
      }
      const tc = cRes.data;
      normalizeCaseOperations(tc);
      api.cases.push(tc);
    }
  }
  return api;
}

export const fileStorage: StorageAdapter = {
  async load(root: string) {
    const wsFile = join(root, WORKSPACE_FILE);
    if (!existsSync(wsFile)) {
      throw new Error(`工作区根目录缺少 ${WORKSPACE_FILE}: ${root}`);
    }
    const problems: LoadProblem[] = [];
    // workspace.yaml 自身失败保持抛错语义（不进 problems 隔离）：没有它整个工作区无法定位。
    const wsRes = loadYaml(wsFile, WorkspaceSchema);
    if (!wsRes.ok) throw new Error(`${WORKSPACE_FILE} 解析失败: ${wsRes.error}`);
    const workspace: Workspace = wsRes.data;
    workspace.groups = [];

    const groupsDir = join(root, "groups");
    if (!existsSync(groupsDir)) return { workspace, problems };

    for (const gName of sortedNames(groupsDir)) {
      const gDir = join(groupsDir, gName);
      const gRel = join("groups", gName);
      const gRes = loadYaml(join(gDir, "group.yaml"), GroupSchema);
      if (!gRes.ok) {
        problems.push({ file: join(gRel, "group.yaml"), message: gRes.error });
        continue;
      }
      const group: Group = { ...gRes.data, projects: [] };
      const projectsDir = join(gDir, "projects");
      if (existsSync(projectsDir)) {
        for (const pName of sortedNames(projectsDir)) {
          const pDir = join(projectsDir, pName);
          const pRel = join(gRel, "projects", pName);
          const pRes = loadYaml(join(pDir, "project.yaml"), ProjectSchema);
          if (!pRes.ok) {
            problems.push({ file: join(pRel, "project.yaml"), message: pRes.error });
            continue;
          }
          const project: Project = { ...pRes.data, environments: [], collections: [], workflows: [] };

          const envDir = join(pDir, "environments");
          if (existsSync(envDir)) {
            for (const f of sortedNames(envDir, (n) => n.endsWith(".yaml"))) {
              const eRes = loadYaml(join(envDir, f), EnvironmentSchema);
              if (!eRes.ok) {
                problems.push({ file: join(pRel, "environments", f), message: eRes.error });
                continue;
              }
              project.environments.push(eRes.data);
            }
          }

          const workflowsDir = join(pDir, "workflows");
          if (existsSync(workflowsDir)) {
            for (const wfName of sortedNames(workflowsDir)) {
              const res = loadYaml(join(workflowsDir, wfName, "workflow.yaml"), WorkflowSchema);
              if (!res.ok) {
                problems.push({ file: join(pRel, "workflows", wfName, "workflow.yaml"), message: res.error });
                continue;
              }
              project.workflows.push(res.data);
            }
          }

          const collDir = join(pDir, "collections");
          if (existsSync(collDir)) {
            for (const cName of sortedNames(collDir)) {
              const cFile = join(collDir, cName, "collection.yaml");
              if (!existsSync(cFile)) {
                // 与 apis 孤儿目录语义对齐：目录存在但缺 collection.yaml 必须留痕，不静默丢弃。
                problems.push({
                  file: join(pRel, "collections", cName, "collection.yaml"),
                  message: "集合目录缺少 collection.yaml，该目录已跳过",
                });
                continue;
              }
              const cRes = loadYaml(cFile, CollectionSchema);
              if (!cRes.ok) {
                problems.push({ file: join(pRel, "collections", cName, "collection.yaml"), message: cRes.error });
                continue;
              }
              const collection: Collection = { ...cRes.data, folders: [], apis: [] };
              normalizeContainerOperations(collection, collection.scripts);
              const foldersDir = join(collDir, cName, "folders");
              if (existsSync(foldersDir)) {
                // M10：文件夹可嵌套——递归读取（folder.yaml 的 folders 字段由 parse default 兜空）
                const loadFolder = async (relBase: string, dir: string): Promise<Folder | null> => {
                  const fRes = loadYaml(join(dir, "folder.yaml"), FolderSchema);
                  if (!fRes.ok) {
                    problems.push({ file: join(relBase, "folder.yaml"), message: fRes.error });
                    return null;
                  }
                  const folder: Folder = { ...fRes.data, folders: [], apis: [] };
                  const fApisDir = join(dir, "apis");
                  if (existsSync(fApisDir)) {
                    for (const aName of sortedNames(fApisDir)) {
                      const api = await loadApiDir(
                        join(relBase, "apis", aName),
                        join(fApisDir, aName),
                        problems,
                      );
                      if (api) folder.apis.push(api);
                    }
                  }
                  const subDirs = join(dir, "folders");
                  if (existsSync(subDirs)) {
                    for (const subName of sortedNames(subDirs)) {
                      const sub = await loadFolder(join(relBase, "folders", subName), join(subDirs, subName));
                      if (sub) folder.folders!.push(sub);
                    }
                  }
                  return folder;
                };
                for (const fName of sortedNames(foldersDir)) {
                  const folder = await loadFolder(join(pRel, "collections", cName, "folders", fName), join(foldersDir, fName));
                  if (folder) collection.folders.push(folder);
                }
              }
              const apisDir = join(collDir, cName, "apis");
              if (existsSync(apisDir)) {
                for (const aName of sortedNames(apisDir)) {
                  const api = await loadApiDir(
                    join(pRel, "collections", cName, "apis", aName),
                    join(apisDir, aName),
                    problems,
                  );
                  if (api) collection.apis.push(api);
                }
              }
              project.collections.push(collection);
            }
          }
          group.projects.push(project);
        }
      }
      workspace.groups.push(group);
    }
    return { workspace, problems };
  },

  async save(root: string, ws: Workspace) {
    // M10：workspace 级 globals 弃用——不再写入（字段仅为旧文件读兼容保留在 schema）。
    writeYaml(join(root, WORKSPACE_FILE), { id: ws.id, name: ws.name, variables: ws.variables });
    for (const g of ws.groups) {
      const gDir = join(root, "groups", g.name);
      // M10：默认分组标记落盘（自建分组 undefined 不写键）
      writeYaml(join(gDir, "group.yaml"), { id: g.id, name: g.name, ...(g.default ? { default: true } : {}) });
      for (const p of g.projects) {
        const pDir = join(gDir, "projects", p.name);
        // M10：项目级全局参数随 project.yaml 落盘（全局变量 = variables 字段本身）
        writeYaml(join(pDir, "project.yaml"), {
          id: p.id, name: p.name, variables: p.variables, globals: p.globals,
        });
        for (const e of p.environments) {
          writeYaml(join(pDir, "environments", `${e.name}.yaml`), {
            id: e.id, name: e.name, extends: e.extends, variables: e.variables, baseUrls: e.baseUrls,
          });
        }
        for (const wf of p.workflows ?? []) {
          writeYaml(join(pDir, "workflows", wf.name, "workflow.yaml"), {
            id: wf.id, name: wf.name, status: wf.status, nodes: wf.nodes, edges: wf.edges,
          });
        }
        for (const c of p.collections) {
          const cDir = join(pDir, "collections", c.name);
          // M10：只写新形态操作（旧 scripts 已在 load 归一，内存模型不再携带）
          writeYaml(join(cDir, "collection.yaml"), {
            id: c.id, name: c.name, variables: c.variables,
            preOperations: c.preOperations, postOperations: c.postOperations,
          });
          for (const api of c.apis) {
            saveApiDir(join(cDir, "apis", api.name), api);
          }
          const saveFolder = (folder: Folder, baseDir: string): void => {
            const fDir = join(baseDir, "folders", folder.name);
            writeYaml(join(fDir, "folder.yaml"), {
              id: folder.id, name: folder.name,
              preOperations: folder.preOperations, postOperations: folder.postOperations,
            });
            for (const api of folder.apis) {
              saveApiDir(join(fDir, "apis", api.name), api);
            }
            for (const sub of folder.folders ?? []) {
              saveFolder(sub, fDir);
            }
          };
          for (const f of c.folders) {
            saveFolder(f, cDir);
          }
        }
      }
    }
  },
};
