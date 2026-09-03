// 用例绑定级联数据层（任务 4，TDD）：从树 DTO + 逐接口详情构造「集合→接口→用例」
// 级联选项与名称索引（画布 data 预注入、属性面板改绑、missing 检测共用）。
// 纯数据运算 + 注入式取数（fetchCases 由组合根绑定 api.apiGet），不依赖组件与 store。
import { describe, expect, it } from "vitest";
import type { ApiDetail } from "../../../src/shared/types.js";
import type { TreeNodeDTO } from "../../../src/shared/tree-dto.js";
import { buildBindIndex, findBindPath } from "../../../src/renderer/src/wf/wfBindings.js";

const tree: TreeNodeDTO = {
  kind: "root", id: "ws", label: "工作区",
  children: [
    {
      kind: "group", id: "g1", label: "分组",
      children: [
        {
          kind: "project", id: "p1", label: "项目一",
          children: [
            {
              kind: "collection", id: "col1", label: "集合A",
              children: [
                { kind: "api", id: "a1", label: "登录", method: "POST" },
                { kind: "api", id: "a2", label: "登出", method: "GET" },
              ],
            },
            {
              kind: "collection", id: "col2", label: "集合B",
              children: [{ kind: "api", id: "a3", label: "刷新", method: "GET" }],
            },
          ],
        },
        {
          kind: "project", id: "p2", label: "项目二",
          children: [
            { kind: "collection", id: "col3", label: "别的集合", children: [{ kind: "api", id: "a4", label: "他项目", method: "GET" }] },
          ],
        },
      ],
    },
  ],
};

/** 注入式取数替身：apiId → 用例名表。 */
function fakeFetch(casesByApi: Record<string, Array<{ id: string; name: string }>>) {
  return async (apiId: string): Promise<ApiDetail> => {
    const cases = casesByApi[apiId];
    if (!cases) throw new Error(`未找到接口: ${apiId}`);
    return {
      api: {
        id: apiId, name: "", version: "1.0.0", deprecated: false, method: "GET", url: "/",
        headers: [], query: [],
        cases: cases.map((c) => ({ id: c.id, name: c.name, scope: "base" as const, parameters: {}, assertions: [] })),
      },
      envs: [],
    };
  };
}

describe("buildBindIndex", () => {
  it("构造 集合→接口→用例 三级级联选项（限定目标项目）", async () => {
    const index = await buildBindIndex(tree, "p1", fakeFetch({
      a1: [{ id: "c1", name: "手机号" }, { id: "c2", name: "邮箱" }],
      a2: [{ id: "c3", name: "冒烟" }],
      a3: [],
    }));
    expect(index.options).toHaveLength(2);
    expect(index.options[0]).toMatchObject({ value: "col1", label: "集合A" });
    expect(index.options[0]!.children).toHaveLength(2);
    expect(index.options[0]!.children![0]).toMatchObject({ value: "a1", label: "登录" });
    expect(index.options[0]!.children![0]!.children).toEqual([
      { value: "c1", label: "手机号" },
      { value: "c2", label: "邮箱" },
    ]);
    // 无用例接口：用例层为空数组（面板可选到接口层即回写，允许无 case 引用）
    expect(index.options[0]!.children![1]!.children).toEqual([{ value: "c3", label: "冒烟" }]);
    expect(index.options[1]).toMatchObject({ value: "col2", label: "集合B" });
    expect(index.options[1]!.children![0]!.children).toEqual([]); // a3 无用例
    expect(index.options.some((o) => o.value === "col3")).toBe(false); // 他项目不混入
  });

  it("名称索引：apiIds / apiNames / caseNames 供画布预注入与 missing 检测", async () => {
    const index = await buildBindIndex(tree, "p1", fakeFetch({ a1: [{ id: "c1", name: "手机号" }] }));
    expect(index.apiIds).toEqual(new Set(["a1", "a2", "a3"]));
    expect(index.apiNames.get("a1")).toBe("登录");
    expect(index.caseNames.get("c1")).toBe("手机号");
    expect(index.caseNames.has("c9")).toBe(false);
  });

  it("单接口取数失败只缺用例目录（missing 以树为准），接口仍入索引", async () => {
    const index = await buildBindIndex(tree, "p1", fakeFetch({ a2: [{ id: "c3", name: "冒烟" }] }));
    expect(index.apiIds.has("a1")).toBe(true); // 树上存在即入索引
    expect(index.apiNames.get("a1")).toBe("登录");
    expect(index.caseNames.has("c1")).toBe(false); // 用例目录缺失不阻塞
    const col1 = index.options.find((o) => o.value === "col1")!;
    expect(col1.children!.find((o) => o.value === "a1")!.children).toEqual([]);
    expect(index.caseNames.get("c3")).toBe("冒烟"); // 其余接口照常
  });

  it("projectId 为 null（未选项目）或树未开 → 空索引", async () => {
    const empty = await buildBindIndex(tree, null, fakeFetch({}));
    expect(empty.options).toEqual([]);
    expect(empty.apiIds.size).toBe(0);
    const none = await buildBindIndex(null, "p1", fakeFetch({}));
    expect(none.options).toEqual([]);
  });
});

describe("findBindPath", () => {
  const options: Parameters<typeof findBindPath>[0] = [
    {
      value: "col1", label: "集合A",
      children: [
        { value: "a1", label: "登录", children: [{ value: "c1", label: "手机号" }, { value: "c2", label: "邮箱" }] },
        { value: "a2", label: "登出", children: [{ value: "c3", label: "冒烟" }] },
      ],
    },
    { value: "col2", label: "集合B", children: [{ value: "a3", label: "刷新", children: [] }] },
  ];

  it("命中 apiId+caseId → 完整三级路径", () => {
    expect(findBindPath(options, "a1", "c2")).toEqual(["col1", "a1", "c2"]);
  });
  it("只有 apiId（未绑用例）→ 集合+接口两段路径", () => {
    expect(findBindPath(options, "a3")).toEqual(["col2", "a3"]);
  });
  it("未绑定/引用不在选项内 → 空路径", () => {
    expect(findBindPath(options)).toEqual([]);
    expect(findBindPath(options, "a4", "c9")).toEqual([]); // 他项目接口不可选
  });
});
