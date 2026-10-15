// 工作流绑定索引使用完整本地定位符取接口与用例，保持旧级联/竞态目的。
import { describe, expect, it } from "vitest";
import type { ApiDetail } from "../../../src/shared/types.js";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";
import type { LocalApiTreeNodeDTO, LocalCollectionTreeNodeDTO, LocalGroupTreeNodeDTO, LocalProjectTreeNodeDTO, LocalRootTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import { apiCaseKey, apiLocatorKey, buildBindIndex, createBindIndexLoader, findBindPath, type FetchApiDetail } from "../../../src/renderer/src/wf/wfBindings.js";

const project1: ProjectLocator = { workspaceId: "ws", groupId: "g1", projectId: "p1" };
const project2: ProjectLocator = { workspaceId: "ws", groupId: "g1", projectId: "p2" };
const api1: ApiLocator = { ...project1, collectionId: "col1", folderIds: [], apiId: "a1" };
const api2: ApiLocator = { ...project1, collectionId: "col1", folderIds: [], apiId: "a2" };
const api3: ApiLocator = { ...project1, collectionId: "col2", folderIds: [], apiId: "a3" };
const api4: ApiLocator = { ...project2, collectionId: "col3", folderIds: [], apiId: "a4" };

function apiNode(locator: ApiLocator, label: string): LocalApiTreeNodeDTO {
  return { source: "local", kind: "api", id: locator.apiId, key: `api:${locator.apiId}`, label, locator, protocol: "http", method: "GET" };
}

function collection(locator: ProjectLocator, id: string, label: string, children: LocalApiTreeNodeDTO[]): LocalCollectionTreeNodeDTO {
  return { source: "local", kind: "collection", id, key: `collection:${id}`, label, locator: { ...locator, collectionId: id }, children };
}

const tree: LocalRootTreeNodeDTO = {
  source: "local", kind: "root", id: "ws", key: "root:ws", label: "工作区", locator: { workspaceId: "ws" },
  children: [
    {
      source: "local", kind: "group", id: "g1", key: "group:g1", label: "分组", locator: { workspaceId: "ws", groupId: "g1" },
      children: [
        {
          source: "local", kind: "project", id: "p1", key: "project:p1", label: "项目一", locator: project1, envs: [], workflows: [],
          children: [
            collection(project1, "col1", "集合A", [apiNode(api1, "登录"), apiNode(api2, "登出")]),
            collection(project1, "col2", "集合B", [apiNode(api3, "刷新")]),
          ],
        },
        {
          source: "local", kind: "project", id: "p2", key: "project:p2", label: "项目二", locator: project2, envs: [], workflows: [],
          children: [collection(project2, "col3", "别的集合", [apiNode(api4, "他项目")])],
        },
      ],
    } satisfies LocalGroupTreeNodeDTO,
  ],
};

function detail(apiId: string, cases: Array<{ id: string; name: string }>): ApiDetail {
  return {
    locator: { workspaceId: "ws1", groupId: "g1", projectId: "p1", collectionId: "col1", folderIds: [], apiId },
    api: {
      contract: {
        formatVersion: 1,
        id: apiId,
        metadata: { name: "", description: "", tags: [], version: "1.0.0", status: "draft" },
        request: {
          protocol: "http", method: "GET", baseUrl: "", path: "/", pathParams: [], query: [], headers: [], cookies: [],
          auth: { kind: "none" }, body: { kind: "none" },
        },
        responses: [],
      },
      cases: cases.map((c) => ({ id: c.id, name: c.name, scope: "base" as const, parameters: {}, preOperations: [], postOperations: [], assertions: [] })),
      documentation: "",
    },
    sourceApiRevision: "source-api-revision",
    sourceProjectRevision: "source-project-revision",
    envs: [],
  };
}

/** 注入式取数替身仍以接口 id 配置响应，但观察接收的完整定位符。 */
function fakeFetch(casesByApi: Record<string, Array<{ id: string; name: string }>>) {
  const calls: ApiLocator[] = [];
  const fetch: FetchApiDetail = async (locator) => {
    calls.push(locator);
    const cases = casesByApi[locator.apiId];
    if (!cases) throw new Error(`未找到接口: ${locator.apiId}`);
    return detail(locator.apiId, cases);
  };
  return { fetch, calls };
}

describe("buildBindIndex", () => {
  it("构造集合→接口→用例级联，并只请求完整目标项目下的接口定位符", async () => {
    const source = fakeFetch({
      a1: [{ id: "c1", name: "手机号" }, { id: "c2", name: "邮箱" }],
      a2: [{ id: "c3", name: "冒烟" }],
      a3: [],
    });
    const index = await buildBindIndex(tree, project1, source.fetch);
    expect(source.calls).toEqual([api1, api2, api3]);
    expect(index.options).toHaveLength(2);
    expect(index.options[0]).toMatchObject({ value: "col1", label: "集合A" });
    expect(index.options[0]!.children).toHaveLength(2);
    expect(index.options[0]!.children![0]).toMatchObject({ value: "a1", label: "登录" });
    expect(index.options[0]!.children![0]!.children).toEqual([
      { value: "c1", label: "手机号" },
      { value: "c2", label: "邮箱" },
    ]);
    expect(index.options[0]!.children![1]!.children).toEqual([{ value: "c3", label: "冒烟" }]);
    expect(index.options[1]).toMatchObject({ value: "col2", label: "集合B" });
    expect(index.options[1]!.children![0]!.children).toEqual([]);
    expect(index.options.some((o) => o.value === "col3")).toBe(false);
  });

  it("按完整 API 和 case 定位符建立名称键，避免不同接口相同 caseId 串名", async () => {
    const index = await buildBindIndex(tree, project1, fakeFetch({
      a1: [{ id: "same-case-id", name: "登录成功" }],
      a2: [{ id: "same-case-id", name: "登出成功" }],
    }).fetch);
    expect(index.apiIds).toEqual(new Set(["a1", "a2", "a3"]));
    expect(index.apiNames.get(apiLocatorKey(api1))).toBe("登录");
    expect(index.apiNames.get(apiLocatorKey(api2))).toBe("登出");
    expect(index.caseNames.get(apiCaseKey(api1, "same-case-id"))).toBe("登录成功");
    expect(index.caseNames.get(apiCaseKey(api2, "same-case-id"))).toBe("登出成功");
    expect(index.caseNames.size).toBe(2);
    expect(index.apiLocatorsById.get("a1")).toEqual([api1]);
  });

  it("单接口取数失败只缺用例目录，接口仍入索引", async () => {
    const index = await buildBindIndex(tree, project1, fakeFetch({ a2: [{ id: "c3", name: "冒烟" }] }).fetch);
    expect(index.apiIds.has("a1")).toBe(true);
    expect(index.apiNames.get(apiLocatorKey(api1))).toBe("登录");
    expect(index.caseNames.has(apiCaseKey(api1, "c1"))).toBe(false);
    const col1 = index.options.find((o) => o.value === "col1")!;
    expect(col1.children!.find((o) => o.value === "a1")!.children).toEqual([]);
    expect(index.caseNames.get(apiCaseKey(api2, "c3"))).toBe("冒烟");
  });

  it("未选项目或树未开返回空索引", async () => {
    const empty = await buildBindIndex(tree, null, fakeFetch({}).fetch);
    expect(empty.options).toEqual([]);
    expect(empty.apiIds.size).toBe(0);
    expect(await buildBindIndex(null, project1, fakeFetch({}).fetch).then((x) => x.options)).toEqual([]);
  });
});

describe("findBindPath", () => {
  const options = [
    {
      value: "col1", label: "集合A",
      children: [
        { value: "a1", label: "登录", children: [{ value: "c1", label: "手机号" }, { value: "c2", label: "邮箱" }] },
        { value: "a2", label: "登出", children: [{ value: "c3", label: "冒烟" }] },
      ],
    },
    { value: "col2", label: "集合B", children: [{ value: "a3", label: "刷新", children: [] }] },
  ];

  it("命中 apiId+caseId 返回三级路径，只有 API 返回两级路径", () => {
    expect(findBindPath(options, "a1", "c2")).toEqual(["col1", "a1", "c2"]);
    expect(findBindPath(options, "a3")).toEqual(["col2", "a3"]);
  });

  it("未绑定或项目外引用返回空路径", () => {
    expect(findBindPath(options)).toEqual([]);
    expect(findBindPath(options, "a4", "c9")).toEqual([]);
  });
});

describe("createBindIndexLoader", () => {
  function gatedFetch(gated: string[]) {
    const gates = new Map<string, () => void>();
    const make = (locator: ApiLocator): ApiDetail => detail(locator.apiId, [{ id: `c-${locator.apiId}`, name: `用例${locator.apiId}` }]);
    const fetch: FetchApiDetail = (locator) => {
      if (!gated.includes(locator.apiId)) return Promise.resolve(make(locator));
      return new Promise((resolve) => gates.set(locator.apiId, () => resolve(make(locator))));
    };
    return { gates, fetch };
  }

  it("快速切换项目时只让最新请求落位", async () => {
    const { gates, fetch } = gatedFetch(["a1"]);
    const loader = createBindIndexLoader(() => tree, fetch);
    const first = loader.load(project1);
    const second = loader.load(project2);
    const current = await second;
    expect(current?.apiIds.has("a4")).toBe(true);
    expect(loader.current).toBe(current);
    gates.get("a1")!();
    expect(await first).toBeNull();
    expect(loader.current).toBe(current);
  });

  it("顺序装载后可通过 null 清空", async () => {
    const loader = createBindIndexLoader(() => tree, fakeFetch({ a1: [{ id: "c1", name: "手机号" }] }).fetch);
    const loaded = await loader.load(project1);
    expect(loaded?.apiIds.has("a1")).toBe(true);
    expect(loader.current).toBe(loaded);
    expect(await loader.load(null)).toBeNull();
    expect(loader.current).toBeNull();
  });
});
