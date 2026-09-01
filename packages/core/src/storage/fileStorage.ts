import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ApiDefinition, Collection, Group, Project, Workspace } from "../domain/model.js";
import type { LoadProblem, StorageAdapter } from "../plugin/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

function readYaml<T>(file: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: parseYaml(readFileSync(file, "utf8")) as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function writeYaml(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifyYaml(JSON.parse(JSON.stringify(data))));
}

async function loadApiDir(dir: string, problems: LoadProblem[]): Promise<ApiDefinition | null> {
  const apiFile = join(dir, "api.yaml");
  if (!existsSync(apiFile)) return null;
  const res = readYaml<ApiDefinition>(apiFile);
  if (!res.ok) {
    problems.push({ file: relative(dir, apiFile), message: res.error });
    return null;
  }
  const api = res.data;
  const designFile = join(dir, "design.md");
  if (existsSync(designFile)) api.design = readFileSync(designFile, "utf8");
  api.cases = [];
  const casesDir = join(dir, "cases");
  if (existsSync(casesDir)) {
    for (const f of readdirSync(casesDir).filter((n) => n.endsWith(".yaml"))) {
      const cRes = readYaml<ApiDefinition["cases"][number]>(join(casesDir, f));
      if (!cRes.ok) {
        problems.push({ file: join("cases", f), message: cRes.error });
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
    const wsRes = readYaml<Workspace>(wsFile);
    if (!wsRes.ok) throw new Error(`${WORKSPACE_FILE} 解析失败: ${wsRes.error}`);
    const workspace = wsRes.data;
    workspace.groups = [];

    const groupsDir = join(root, "groups");
    if (!existsSync(groupsDir)) return { workspace, problems };

    for (const gName of readdirSync(groupsDir)) {
      const gDir = join(groupsDir, gName);
      const gRes = readYaml<{ id: string; name: string }>(join(gDir, "group.yaml"));
      if (!gRes.ok) {
        problems.push({ file: join("groups", gName, "group.yaml"), message: gRes.error });
        continue;
      }
      const group: Group = { ...gRes.data, projects: [] };
      const projectsDir = join(gDir, "projects");
      if (existsSync(projectsDir)) {
        for (const pName of readdirSync(projectsDir)) {
          const pDir = join(projectsDir, pName);
          const pRes = readYaml<Omit<Project, "environments" | "collections">>(
            join(pDir, "project.yaml"),
          );
          if (!pRes.ok) {
            problems.push({ file: join("groups", gName, "projects", pName, "project.yaml"), message: pRes.error });
            continue;
          }
          const project: Project = { ...pRes.data, environments: [], collections: [] };

          const envDir = join(pDir, "environments");
          if (existsSync(envDir)) {
            for (const f of readdirSync(envDir).filter((n) => n.endsWith(".yaml"))) {
              const eRes = readYaml<(typeof project)["environments"][number]>(join(envDir, f));
              if (!eRes.ok) {
                problems.push({ file: join("environments", f), message: eRes.error });
                continue;
              }
              project.environments.push(eRes.data);
            }
          }

          const collDir = join(pDir, "collections");
          if (existsSync(collDir)) {
            for (const cName of readdirSync(collDir)) {
              const cRes = readYaml<Omit<Collection, "apis">>(
                join(collDir, cName, "collection.yaml"),
              );
              if (!cRes.ok) {
                problems.push({ file: join("collections", cName, "collection.yaml"), message: cRes.error });
                continue;
              }
              const collection: Collection = { ...cRes.data, apis: [], folders: [] };
              const apisDir = join(collDir, cName, "apis");
              if (existsSync(apisDir)) {
                for (const aName of readdirSync(apisDir)) {
                  const api = await loadApiDir(join(apisDir, aName), problems);
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
        for (const c of p.collections) {
          const cDir = join(pDir, "collections", c.name);
          writeYaml(join(cDir, "collection.yaml"), {
            id: c.id, name: c.name, variables: c.variables, scripts: c.scripts,
          });
          for (const api of c.apis) {
            const aDir = join(cDir, "apis", api.name);
            writeYaml(join(aDir, "api.yaml"), {
              id: api.id, name: api.name, version: api.version, deprecated: api.deprecated,
              method: api.method, url: api.url, headers: api.headers, query: api.query,
              body: api.body, auth: api.auth,
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
        }
      }
    }
  },
};
