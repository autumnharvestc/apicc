import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  ApiDefinitionSchema, CollectionSchema, EnvironmentSchema, FolderSchema, GroupSchema,
  ProjectSchema, TestCaseSchema, WorkspaceSchema,
} from "../domain/model.js";
import type { ApiDefinition, Collection, Folder, Group, Project, Workspace } from "../domain/model.js";
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
      api.cases.push(cRes.data);
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
              const foldersDir = join(collDir, cName, "folders");
              if (existsSync(foldersDir)) {
                for (const fName of sortedNames(foldersDir)) {
                  const fDir = join(foldersDir, fName);
                  const fRes = loadYaml(join(fDir, "folder.yaml"), FolderSchema);
                  if (!fRes.ok) {
                    problems.push({ file: join(pRel, "collections", cName, "folders", fName, "folder.yaml"), message: fRes.error });
                    continue;
                  }
                  const folder: Folder = { ...fRes.data, apis: [] };
                  const fApisDir = join(fDir, "apis");
                  if (existsSync(fApisDir)) {
                    for (const aName of sortedNames(fApisDir)) {
                      const api = await loadApiDir(
                        join(pRel, "collections", cName, "folders", fName, "apis", aName),
                        join(fApisDir, aName),
                        problems,
                      );
                      if (api) folder.apis.push(api);
                    }
                  }
                  collection.folders.push(folder);
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
    writeYaml(join(root, WORKSPACE_FILE), { id: ws.id, name: ws.name, variables: ws.variables });
    for (const g of ws.groups) {
      const gDir = join(root, "groups", g.name);
      writeYaml(join(gDir, "group.yaml"), { id: g.id, name: g.name });
      for (const p of g.projects) {
        const pDir = join(gDir, "projects", p.name);
        writeYaml(join(pDir, "project.yaml"), { id: p.id, name: p.name, variables: p.variables });
        for (const e of p.environments) {
          writeYaml(join(pDir, "environments", `${e.name}.yaml`), {
            id: e.id, name: e.name, extends: e.extends, variables: e.variables,
          });
        }
        for (const wf of p.workflows ?? []) {
          writeYaml(join(pDir, "workflows", wf.name, "workflow.yaml"), {
            id: wf.id, name: wf.name, status: wf.status, nodes: wf.nodes, edges: wf.edges,
          });
        }
        for (const c of p.collections) {
          const cDir = join(pDir, "collections", c.name);
          writeYaml(join(cDir, "collection.yaml"), {
            id: c.id, name: c.name, variables: c.variables, scripts: c.scripts,
          });
          for (const api of c.apis) {
            saveApiDir(join(cDir, "apis", api.name), api);
          }
          for (const f of c.folders) {
            const fDir = join(cDir, "folders", f.name);
            writeYaml(join(fDir, "folder.yaml"), { id: f.id, name: f.name });
            for (const api of f.apis) {
              saveApiDir(join(fDir, "apis", api.name), api);
            }
          }
        }
      }
    }
  },
};
