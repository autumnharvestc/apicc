// M3-B 任务 3（简报裁定 A）：onlineTreeToDto——服务端 files path 清单 → 侧树 TreeNodeDTO
// 映射纯函数。服务端不回树结构（§3.4 tree 只有 path+hash+version 清单与 projects 角色），
// 客户端按 M1 §6 目录约定推导 groups/projects/collections/folders/apis 层级；
// 工作流/环境/项目/集合配置等非接口文件映射为只读 file 叶（裁定 B：只读浏览，不做编辑器）。
import { describe, expect, it } from "vitest";
import { onlineTreeToDto } from "../../../src/main/online/session.js";
import type { OnlineTree } from "../../../src/shared/online/contract.js";
import type { TreeNodeDTO } from "../../../src/shared/tree-dto.js";

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

describe("onlineTreeToDto（裁定 A：path 集合 → 侧树层级）", () => {
  it("完整层级：groups/projects/collections/apis + folders/api.yaml → 四层树；api 节点 id = api.yaml 全路径", () => {
    const dto = onlineTreeToDto(
      treeOf([
        "groups/电商/projects/订单服务/collections/订单API/apis/create-order/api.yaml",
        "groups/电商/projects/订单服务/collections/订单API/folders/内部/apis/query-order/api.yaml",
        "groups/用户中心/projects/账户服务/collections/账户API/apis/login/api.yaml",
      ]),
    );
    expect(dto.kind).toBe("root");
    expect(dto.id).toBe("ws-1");
    const group = child(dto, "group", "电商");
    const project = child(group, "project", "订单服务");
    const collection = child(project, "collection", "订单API");
    const api = child(collection, "api", "create-order");
    expect(api.id).toBe("groups/电商/projects/订单服务/collections/订单API/apis/create-order/api.yaml");
    const folder = child(collection, "folder", "内部");
    expect(child(folder, "api", "query-order").id).toBe(
      "groups/电商/projects/订单服务/collections/订单API/folders/内部/apis/query-order/api.yaml",
    );
    // 第二个分组独立成子树（无权项目天然不在输入清单里，映射不凭空造节点）
    const other = child(dto, "group", "用户中心");
    expect(child(child(other, "project", "账户服务"), "collection", "账户API")).toBeDefined();
  });

  it("只读 file 叶（裁定 B 只读浏览）：workspace/group/project 配置、环境、工作流、collection/folder.yaml 挂对应父节点", () => {
    const dto = onlineTreeToDto(
      treeOf([
        "apicc.workspace.yaml",
        "groups/电商/group.yaml",
        "groups/电商/projects/订单服务/project.yaml",
        "groups/电商/projects/订单服务/environments/dev.yaml",
        "groups/电商/projects/订单服务/workflows/下单流/workflow.yaml",
        "groups/电商/projects/订单服务/collections/订单API/collection.yaml",
        "groups/电商/projects/订单服务/collections/订单API/folders/内部/folder.yaml",
        "groups/电商/projects/订单服务/collections/订单API/folders/内部/apis/create-order/api.yaml",
        "groups/电商/projects/订单服务/collections/订单API/apis/create-order/api.yaml",
      ]),
    );
    expect(child(dto, "file", "apicc.workspace.yaml").id).toBe("apicc.workspace.yaml");
    const group = child(dto, "group", "电商");
    expect(child(group, "file", "group.yaml").id).toBe("groups/电商/group.yaml");
    const project = child(group, "project", "订单服务");
    expect(child(project, "file", "project.yaml").id).toBe("groups/电商/projects/订单服务/project.yaml");
    expect(child(project, "file", "dev.yaml").id).toBe("groups/电商/projects/订单服务/environments/dev.yaml");
    // 工作流叶 label = 目录名（workflow.yaml 固定文件名无信息量）
    expect(child(project, "file", "下单流").id).toBe("groups/电商/projects/订单服务/workflows/下单流/workflow.yaml");
    const collection = child(project, "collection", "订单API");
    expect(child(collection, "file", "collection.yaml").id).toBe(
      "groups/电商/projects/订单服务/collections/订单API/collection.yaml",
    );
    // folder.yaml（次要 3 顺修）：与 group/project/collection.yaml 同口径只读叶，挂 folder 节点
    const folder = child(collection, "folder", "内部");
    expect(child(folder, "file", "folder.yaml").id).toBe(
      "groups/电商/projects/订单服务/collections/订单API/folders/内部/folder.yaml",
    );
    expect(child(folder, "api", "create-order")).toBeDefined();
    expect(child(collection, "api", "create-order")).toBeDefined();
  });

  it("接口目录内的 cases/*.yaml 与 design.md 不进树（仅 api.yaml 级编辑，裁定 B）", () => {
    const dto = onlineTreeToDto(
      treeOf([
        "groups/g/projects/p/collections/c/apis/a/api.yaml",
        "groups/g/projects/p/collections/c/apis/a/cases/ok.yaml",
        "groups/g/projects/p/collections/c/apis/a/cases/ok.sit.yaml",
        "groups/g/projects/p/collections/c/apis/a/design.md",
      ]),
    );
    const api = child(child(child(child(dto, "group", "g"), "project", "p"), "collection", "c"), "api", "a");
    expect(api.children ?? []).toEqual([]);
  });

  it("children 排序确定（同层 file/collection/api 等按 label 字典序），输入乱序不影响输出", () => {
    const dto = onlineTreeToDto(
      treeOf([
        "groups/b/projects/p/collections/c/apis/a2/api.yaml",
        "groups/a/projects/p/collections/c/apis/a1/api.yaml",
        "apicc.workspace.yaml",
      ]),
    );
    expect((dto.children ?? []).map((c) => c.label)).toEqual(["a", "apicc.workspace.yaml", "b"]);
  });

  it("空清单 → 只有 root（label 取工作区名入参），无 children", () => {
    const dto = onlineTreeToDto(treeOf([]), "团队空间");
    expect(dto.kind).toBe("root");
    expect(dto.label).toBe("团队空间");
    expect(dto.children ?? []).toEqual([]);
  });

  it("非 M1 §6 布局的杂散路径不进树（映射只认约定层级），不抛", () => {
    const dto = onlineTreeToDto(treeOf(["README.md", "groups/orphan.yaml", "groups/g/projects/p/random.txt"]));
    expect((dto.children ?? []).filter((c) => c.kind !== "file")).toEqual([]);
  });
});
