// M3-B 任务 3（简报裁定 A）：onlineTreeToDto——服务端 files path 清单 → 侧树 TreeNodeDTO
// 映射纯函数。服务端不回树结构（§3.4 tree 只有 path+hash+version 清单与 projects 角色），
// 客户端按目录约定推导 projects/collections/folders/apis 层级；
// 工作流/环境/项目/集合配置等非接口文件映射为只读 file 叶（裁定 B：只读浏览，不做编辑器）。
// path 实体化（2026-09-08）：内容 path 首段=项目实体 id（2026-09-09 服务端 BIGINT 化后为数字）；
// 树节点以 projectId 关联（project 节点 id=项目 id，名称取 tree.projects 行）。
// 计划 C 任务 3 分组层：getTreeView 注入 groupNames（groupId→组名，listGroups 清单反查）时项目
// 挂 group:<groupId> 合成组节点；未注入时项目直接挂根（既有口径）。
// api/file 叶 id 仍=文件全路径（OnlineApiEditor 依赖选中后按该路径 getFiles 取内容，机制不变）。
import { describe, expect, it } from "vitest";
import { onlineTreeToDto } from "../../../src/main/online/session.js";
import type { OnlineTree } from "../../../src/shared/online/contract.js";
import type { TreeNodeDTO } from "../../../src/shared/tree-dto.js";

// 实体 id 夹具（服务端管理面创建；BIGINT 化后为数字字符串，内容 path 首段即此 id）
const P1 = "101";
const P2 = "102";
const GID = "201";

function treeOf(files: string[], projects: OnlineTree["projects"] = []): OnlineTree {
  return {
    workspaceId: "ws-1",
    rootVersion: files.length,
    files: files.map((path) => ({ path, hash: `h-${path}`, version: 1, size: 10 })),
    projects,
  };
}

/** 按 kind 在 children 里找节点（测试导航辅助）。 */
function child(node: TreeNodeDTO, kind: TreeNodeDTO["kind"], label: string): TreeNodeDTO {
  const found = (node.children ?? []).find((c) => c.kind === kind && c.label === label);
  if (!found) throw new Error(`找不到 ${kind}:${label}，实际 children: ${(node.children ?? []).map((c) => `${c.kind}:${c.label}`).join(", ")}`);
  return found;
}

describe("onlineTreeToDto（裁定 A：path 集合 → 侧树层级，path 实体化形态）", () => {
  it("完整层级：<projectId>/collections/apis/folders → 项目直接挂根；api 节点 id = api.yaml 全路径；项目名取 projects 行", () => {
    const dto = onlineTreeToDto(
      treeOf(
        [
          `${P1}/collections/订单API/apis/create-order/api.yaml`,
          `${P1}/collections/订单API/folders/内部/apis/query-order/api.yaml`,
          `${P2}/collections/账户API/apis/login/api.yaml`,
        ],
        [
          { id: P1, name: "订单服务", groupId: GID, myRole: "EDITOR" },
          { id: P2, name: "账户服务", groupId: GID, myRole: "EDITOR" },
        ],
      ),
    );
    expect(dto.kind).toBe("root");
    expect(dto.id).toBe("ws-1");
    // 项目节点 id = 项目实体 id（树节点以 projectId 关联）；label = projects 行名称（非 path 段）
    const project = child(dto, "project", "订单服务");
    expect(project.id).toBe(P1);
    const collection = child(project, "collection", "订单API");
    const api = child(collection, "api", "create-order");
    expect(api.id).toBe(`${P1}/collections/订单API/apis/create-order/api.yaml`);
    const folder = child(collection, "folder", "内部");
    expect(child(folder, "api", "query-order").id).toBe(`${P1}/collections/订单API/folders/内部/apis/query-order/api.yaml`);
    // 第二个项目独立成子树（无权项目天然不在输入清单里，映射不凭空造节点）
    const other = child(dto, "project", "账户服务");
    expect(other.id).toBe(P2);
    expect(child(other, "collection", "账户API")).toBeDefined();
  });

  it("只读 file 叶（裁定 B 只读浏览）：workspace/project 配置、环境、工作流、collection/folder.yaml 挂对应父节点", () => {
    const dto = onlineTreeToDto(
      treeOf(
        [
          "apicc.workspace.yaml",
          `${P1}/project.yaml`,
          `${P1}/environments/dev.yaml`,
          `${P1}/workflows/下单流/workflow.yaml`,
          `${P1}/collections/订单API/collection.yaml`,
          `${P1}/collections/订单API/folders/内部/folder.yaml`,
          `${P1}/collections/订单API/folders/内部/apis/create-order/api.yaml`,
          `${P1}/collections/订单API/apis/create-order/api.yaml`,
        ],
        [{ id: P1, name: "订单服务", groupId: GID, myRole: "EDITOR" }],
      ),
    );
    expect(child(dto, "file", "apicc.workspace.yaml").id).toBe("apicc.workspace.yaml");
    const project = child(dto, "project", "订单服务");
    expect(child(project, "file", "project.yaml").id).toBe(`${P1}/project.yaml`);
    expect(child(project, "file", "dev.yaml").id).toBe(`${P1}/environments/dev.yaml`);
    // 工作流叶 label = 目录名（workflow.yaml 固定文件名无信息量）
    expect(child(project, "file", "下单流").id).toBe(`${P1}/workflows/下单流/workflow.yaml`);
    const collection = child(project, "collection", "订单API");
    expect(child(collection, "file", "collection.yaml").id).toBe(`${P1}/collections/订单API/collection.yaml`);
    // folder.yaml（次要 3 顺修）：与 project/collection.yaml 同口径只读叶，挂 folder 节点
    const folder = child(collection, "folder", "内部");
    expect(child(folder, "file", "folder.yaml").id).toBe(`${P1}/collections/订单API/folders/内部/folder.yaml`);
    expect(child(folder, "api", "create-order")).toBeDefined();
    expect(child(collection, "api", "create-order")).toBeDefined();
  });

  it("接口目录内的 cases/*.yaml 与 design.md 不进树（仅 api.yaml 级编辑，裁定 B）", () => {
    const dto = onlineTreeToDto(
      treeOf([
        `${P1}/collections/c/apis/a/api.yaml`,
        `${P1}/collections/c/apis/a/cases/ok.yaml`,
        `${P1}/collections/c/apis/a/cases/ok.sit.yaml`,
        `${P1}/collections/c/apis/a/design.md`,
      ]),
    );
    const api = child(child(child(dto, "project", P1), "collection", "c"), "api", "a");
    expect(api.children ?? []).toEqual([]);
  });

  it("projects 行缺席的项目（清单外杂散 id 文件）→ 项目节点回退以 id 命名，不抛", () => {
    const dto = onlineTreeToDto(treeOf([`${P1}/collections/c/apis/a/api.yaml`]));
    const project = child(dto, "project", P1);
    expect(project.id).toBe(P1);
    expect(child(project, "collection", "c")).toBeDefined();
  });

  it("children 排序确定（同层 file/project/collection/api 等按 label 字典序），输入乱序不影响输出", () => {
    const dto = onlineTreeToDto(
      treeOf(
        [
          `${P2}/collections/c/apis/a2/api.yaml`,
          `${P1}/collections/c/apis/a1/api.yaml`,
          "apicc.workspace.yaml",
        ],
        [
          { id: P2, name: "p2", groupId: GID, myRole: "EDITOR" },
          { id: P1, name: "p1", groupId: GID, myRole: "EDITOR" },
        ],
      ),
    );
    expect((dto.children ?? []).map((c) => c.label)).toEqual(["apicc.workspace.yaml", "p1", "p2"]);
  });

  it("空清单 → 只有 root（label 取工作区名入参），无 children", () => {
    const dto = onlineTreeToDto(treeOf([]), "团队空间");
    expect(dto.kind).toBe("root");
    expect(dto.label).toBe("团队空间");
    expect(dto.children ?? []).toEqual([]);
  });

  it("非项目布局的杂散路径不进树（映射只认约定层级），不抛——含实体化前旧 groups/ 形态（服务端不再产出）", () => {
    const dto = onlineTreeToDto(
      treeOf([
        "README.md",
        "groups/orphan.yaml",
        "groups/电商/projects/订单服务/collections/订单API/apis/create-order/api.yaml", // 旧名称目录形态
        `${P1}`, // 裸数字单段（与服务端同口径：不归属项目）
        `${P1}/random.txt`, // 项目内约定外文件
        "not-a-number/collections/c/apis/a/api.yaml", // 首段非数字 id
      ]),
    );
    expect((dto.children ?? []).filter((c) => c.kind !== "file")).toEqual([]);
  });
});

// —— 计划 C 任务 3：在线侧树分组层（groupNames 提供 → 项目挂 group:<groupId> 合成组节点）——
describe("onlineTreeToDto 分组层（计划 C 任务 3：groupNames → group:<groupId> 合成节点）", () => {
  // 排序用例的可分辨性设计：文件清单 P2 在前（懒建序 [P2, P1]）；label 字典序「乙(U+4E59) <
  // 甲(U+7532)」也是 [P2, P1]；唯有「组内按 projects 行序」（P1 行在前）产出 [P1, P2]——三序可分辨。
  it("项目节点挂 group:<groupId> 合成组节点（label=组名，id 前缀 group: 不与文件路径 id 空间重叠），组内按 projects 行序", () => {
    const dto = onlineTreeToDto(
      treeOf(
        [
          "apicc.workspace.yaml",
          `${P2}/collections/账户API/apis/login/api.yaml`,
          `${P1}/collections/订单API/apis/create/api.yaml`,
        ],
        [
          { id: P1, name: "甲项目", groupId: GID, myRole: "EDITOR" },
          { id: P2, name: "乙项目", groupId: GID, myRole: "EDITOR" },
        ],
      ),
      "团队空间",
      new Map([[GID, "电商组"]]),
    );
    // 根层：根配置叶 + 组节点（根层仍按 label 序混排）；组节点 id 带合成前缀 group:
    expect((dto.children ?? []).map((c) => c.id)).toEqual([
      "apicc.workspace.yaml",
      `group:${GID}`,
    ]);
    const group = child(dto, "group", "电商组");
    // 组内按 projects 行序：[P1, P2]（懒建序与 label 序均为 [P2, P1]，行序是唯一正解）
    expect(group.children!.map((c) => c.id)).toEqual([P1, P2]);
    // api 叶 id = 文件全路径（OnlineApiEditor 选中链路在新层级下不变）
    const api = child(child(child(group, "project", "甲项目"), "collection", "订单API"), "api", "create");
    expect(api.id).toBe(`${P1}/collections/订单API/apis/create/api.yaml`);
  });

  it("孤儿项目保持直挂根：groupId 缺席 / projects 行缺席；清单中无项目的组不造空组节点；不抛", () => {
    const P3 = "103";
    const dto = onlineTreeToDto(
      treeOf(
        [
          `${P1}/collections/c/apis/a/api.yaml`,
          `${P2}/collections/c/apis/b/api.yaml`,
          `${P3}/collections/c/apis/c/api.yaml`,
        ],
        [
          { id: P1, name: "有组项目", groupId: GID, myRole: "EDITOR" },
          { id: P2, name: "无组项目", myRole: "EDITOR" }, // groupId 缺席
          // P3 行缺席 → 项目节点回退 id 命名
        ],
      ),
      undefined,
      new Map([
        [GID, "电商组"],
        ["g-empty", "空组"], // 清单中存在但无项目文件引用 → 不造节点
      ]),
    );
    expect(dto.children!.some((c) => c.kind === "group" && c.id === `group:${GID}`)).toBe(true);
    expect(dto.children!.some((c) => c.kind === "group" && c.id === "group:g-empty")).toBe(false);
    expect(dto.children!.some((c) => c.kind === "project" && c.id === P1)).toBe(false); // 有组项目已入组
    expect(dto.children!.some((c) => c.kind === "project" && c.id === P2)).toBe(true);
    expect(dto.children!.some((c) => c.kind === "project" && c.id === P3)).toBe(true);
  });

  it("组名可得但组内无文件的项目（projects 行在、内容清单空）→ 不造空项目节点（文件驱动口径不变）", () => {
    const dto = onlineTreeToDto(
      treeOf([`${P1}/collections/c/apis/a/api.yaml`], [
        { id: P1, name: "有文件", groupId: GID, myRole: "EDITOR" },
        { id: P2, name: "空项目", groupId: GID, myRole: "EDITOR" },
      ]),
      undefined,
      new Map([[GID, "电商组"]]),
    );
    const group = child(dto, "group", "电商组");
    expect(group.children!.map((c) => c.id)).toEqual([P1]);
  });

  it("未提供组清单（第三参缺席）→ 项目直挂根（既有扁平口径不变，既有调用零破坏）", () => {
    const dto = onlineTreeToDto(
      treeOf([`${P1}/collections/c/apis/a/api.yaml`], [{ id: P1, name: "订单服务", groupId: GID, myRole: "EDITOR" }]),
    );
    expect(dto.children!.some((c) => c.kind === "group")).toBe(false);
    expect(dto.children!.some((c) => c.kind === "project" && c.id === P1)).toBe(true);
  });
});
