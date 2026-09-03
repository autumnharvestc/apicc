import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ApiDetail } from "../../../shared/types.js";

/**
 * 接口/用例绑定级联数据层（M2-B 任务 4）：树 DTO 只携带接口 id 与名称，不含用例——
 * 用例目录由组合根注入式取数（api.apiGet）补齐。产物同时服务三处消费：
 * - 属性面板 a-cascader 的 options（集合→接口→用例）；
 * - 画布节点 data 预注入的 apiName/caseName（WfNodeData 契约，画布不做查找）；
 * - toFlowElements 的 apiIds 集合（request 节点 missing 红框检测）。
 * 全部为纯数据运算：取数失败（接口已被删除）跳过该接口的用例目录，不阻塞其余索引。
 */

/** a-cascader 选项形状（value=对应层级 id，label=展示名）。 */
export interface BindOption {
  value: string;
  label: string;
  children?: BindOption[];
}

/** 单项目的绑定索引（绑定目录 + 名称解析 + missing 检测集合）。 */
export interface WfBindIndex {
  /** 当前项目全部接口 id：toFlowElements({ apiIds }) 的 missing 检测数据源。 */
  apiIds: Set<string>;
  /** apiId → 接口名（画布节点预注入）。 */
  apiNames: Map<string, string>;
  /** caseId → 用例名（画布节点预注入）。 */
  caseNames: Map<string, string>;
  /** 集合→接口→用例 级联选项（属性面板改绑）。 */
  options: BindOption[];
}

/** 用例目录取数函数（组合根绑定为 api.apiGet）。 */
export type FetchApiDetail = (apiId: string) => Promise<ApiDetail>;

/** 树投影：项目下「集合→接口」平铺条目（保持深度优先顺序）。 */
interface TreeApiEntry { collectionId: string; collectionLabel: string; apiId: string; apiLabel: string }

function collectProjectApis(node: TreeNodeDTO | undefined, out: TreeApiEntry[], col?: { id: string; label: string }): void {
  if (!node) return;
  if (node.kind === "collection") col = { id: node.id, label: node.label };
  if (node.kind === "api" && col) {
    out.push({ collectionId: col.id, collectionLabel: col.label, apiId: node.id, apiLabel: node.label });
    return;
  }
  for (const child of node.children ?? []) collectProjectApis(child, out, col);
}

/**
 * 构建单项目绑定索引。projectId 为 null（未选项目）或树未开 → 空索引；
 * 单个接口取数失败 → 只跳过该接口的用例目录（已删接口不阻塞面板，引用它的
 * 节点由 missing 标注兜底），接口本身仍进 apiIds/apiNames。
 */
export async function buildBindIndex(
  tree: TreeNodeDTO | null,
  projectId: string | null,
  fetchCases: FetchApiDetail,
): Promise<WfBindIndex> {
  const empty: WfBindIndex = { apiIds: new Set(), apiNames: new Map(), caseNames: new Map(), options: [] };
  if (!tree || !projectId) return empty;
  const project = (tree.children ?? [])
    .flatMap((g) => g.children ?? [])
    .find((p) => p.kind === "project" && p.id === projectId);
  if (!project) return empty;

  const entries: TreeApiEntry[] = [];
  collectProjectApis(project, entries);

  // 用例目录缓存：apiId → 用例选项（取数失败为空数组）
  const caseNames = new Map<string, string>();
  const casesByApi = new Map<string, BindOption[]>();
  await Promise.all(
    entries.map(async (e) => {
      try {
        const detail = await fetchCases(e.apiId);
        casesByApi.set(
          e.apiId,
          detail.api.cases.map((c) => ({ value: c.id, label: c.name })),
        );
        for (const c of detail.api.cases) caseNames.set(c.id, c.name);
      } catch {
        casesByApi.set(e.apiId, []);
      }
    }),
  );

  const apiIds = new Set(entries.map((e) => e.apiId));
  const apiNames = new Map(entries.map((e) => [e.apiId, e.apiLabel] as const));
  const options: BindOption[] = [];
  for (const e of entries) {
    let collection = options.find((o) => o.value === e.collectionId);
    if (!collection) {
      collection = { value: e.collectionId, label: e.collectionLabel, children: [] };
      options.push(collection);
    }
    collection.children!.push({ value: e.apiId, label: e.apiLabel, children: casesByApi.get(e.apiId) ?? [] });
  }
  return { apiIds, apiNames, caseNames, options };
}

/**
 * 在级联选项中反查当前绑定路径（cascader 受控 value）：命中 apiId+caseId 返回三级
 * 路径；只绑了接口（无 caseId 或 caseId 不在选项内）返回两段；未绑定或引用不在
 * 选项内（如他项目接口）返回空数组。
 */
export function findBindPath(options: BindOption[], apiId?: string, caseId?: string): string[] {
  if (!apiId) return [];
  for (const collection of options) {
    for (const api of collection.children ?? []) {
      if (api.value !== apiId) continue;
      const path = [collection.value, api.value];
      if (!caseId) return path;
      const hit = (api.children ?? []).some((c) => c.value === caseId);
      return hit ? [...path, caseId] : path;
    }
  }
  return [];
}

/**
 * 绑定索引装载器（组合根用，审查修复）：递增序号守护异步竞态——快速切换项目时，
 * 先发起的构建若后完成即视为过期（结果丢弃、不落位），只有最新请求的结果落进
 * `current`。projectId 为 null 视为显式清空（同样参与序号竞争）。
 */
export interface BindIndexLoader {
  /** 当前已落位的索引（仅在最新请求完成后更新）。 */
  readonly current: WfBindIndex | null;
  /** 发起一次装载；返回 null = 被更新的请求过期，或入参为空/树未开。 */
  load(projectId: string | null): Promise<WfBindIndex | null>;
}

export function createBindIndexLoader(getTree: () => TreeNodeDTO | null, fetchCases: FetchApiDetail): BindIndexLoader {
  let seq = 0;
  let current: WfBindIndex | null = null;
  return {
    get current() {
      return current;
    },
    async load(projectId: string | null): Promise<WfBindIndex | null> {
      const mine = ++seq;
      if (!projectId || !getTree()) {
        if (mine !== seq) return null;
        current = null;
        return null;
      }
      const index = await buildBindIndex(getTree(), projectId, fetchCases);
      if (mine !== seq) return null; // 过期：期间又发起了新的装载
      current = index;
      return index;
    },
  };
}
