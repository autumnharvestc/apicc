import { createPinia, defineStore } from "pinia";
import type { LoadProblem, StressTargetPolicy } from "@apicc/core";
import type { ApiccApi, OpenResult } from "../../../shared/types.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) throw new Error(`无效 HTTP(S) origin: ${value}`);
  const authority = value.slice(value.indexOf("://") + 3);
  if (!/^[^/?#\s]+\/?$/.test(authority) || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`无效 HTTP(S) origin: ${value}`);
  return parsed.origin;
}

function normalizePolicy(policy: StressTargetPolicy): StressTargetPolicy {
  const trustedOrigins = [...new Set((policy.trustedOrigins ?? []).map(normalizeOrigin))];
  const deniedOrigins = [...new Set((policy.deniedOrigins ?? []).map(normalizeOrigin))];
  const denied = new Set(deniedOrigins);
  if (policy.maxConcurrency !== undefined && (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency <= 0)) throw new Error("maxConcurrency 必须为正整数");
  if (policy.maxRps !== undefined && (!Number.isFinite(policy.maxRps) || policy.maxRps <= 0)) throw new Error("maxRps 必须为正数");
  return { trustedOrigins: trustedOrigins.filter((origin) => !denied.has(origin)), deniedOrigins,
    ...(policy.maxConcurrency === undefined ? {} : { maxConcurrency: policy.maxConcurrency }),
    ...(policy.maxRps === undefined ? {} : { maxRps: policy.maxRps }) };
}

/**
 * 工作区 store 工厂：接受依赖 api 参数（测试传新实例即天然隔离）。
 * 每次工厂调用绑定独立 Pinia 实例，得到互不共享状态的工作区 store。
 */
export function useWorkspaceStore(api: ApiccApi) {
  return defineStore("workspace", {
    state: () => ({ opened: false, name: "", root: "", tree: null as TreeNodeDTO | null, problems: [] as LoadProblem[] }),
    actions: {
      async open(rootPath: string) {
        const r = await api.wsOpen(rootPath);
        this.apply(r);
        await this.refresh();
      },
      async create(rootPath: string, name: string) {
        const r = await api.wsCreate(rootPath, name);
        this.apply(r);
        await this.refresh();
      },
      async refresh() {
        this.tree = await api.treeGet();
      },
      projectIdForApi(apiId: string): string | null {
        const owners: string[] = [];
        for (const group of this.tree?.children ?? []) {
          for (const project of group.children ?? []) {
            const collect = (node: TreeNodeDTO): void => {
              if (node.kind === "api" && node.id === apiId) owners.push(project.id);
              for (const child of node.children ?? []) collect(child);
            };
            for (const child of project.children ?? []) collect(child);
          }
        }
        return owners.length === 1 ? owners[0]! : null;
      },
      /** Save only the active project's safety policy; never persist one-run confirmations. */
      async saveStressPolicy(projectId: string, policy: StressTargetPolicy): Promise<StressTargetPolicy> {
        const normalized = normalizePolicy({
          ...policy,
        });
        const overlap = new Set(normalized.deniedOrigins ?? []);
        normalized.trustedOrigins = (normalized.trustedOrigins ?? []).filter((origin) => !overlap.has(origin));
        const saved = await api.stressPolicySave(projectId, normalized);
        if (this.tree) {
          const project = this.tree.children?.flatMap((group) => group.children ?? []).find((node) => node.id === projectId);
          if (project) project.stressPolicy = saved;
        }
        return saved;
      },
      /** Add an exact canonical target to this project policy. */
      async trustStressOrigin(projectId: string, origin: string): Promise<StressTargetPolicy> {
        const project = this.tree?.children?.flatMap((group) => group.children ?? []).find((node) => node.id === projectId);
        const current = project?.stressPolicy ?? { trustedOrigins: [], deniedOrigins: [] };
        return this.saveStressPolicy(projectId, {
          ...current,
          trustedOrigins: [...(current.trustedOrigins ?? []), normalizeOrigin(origin)],
        });
      },
      apply(r: OpenResult) {
        this.opened = true;
        this.name = r.workspace.name;
        this.root = r.root;
        this.problems = r.problems;
      },
      /** 关闭工作区（不与 main 交互）：M3-B 任务 3 裁定 E 模式互斥——打开在线工作区前
       *  先关本地目录工作区会话（渲染层上下文复位；main 侧由 ws:open/ws:create 链清理）。 */
      reset() {
        this.opened = false;
        this.name = "";
        this.root = "";
        this.tree = null;
        this.problems = [];
      },
    },
  })(createPinia());
}
