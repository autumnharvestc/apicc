// M3-B 任务 3（简报裁定 D）：迁移差异比对纯函数（shared/online/migrate.ts）与 main 侧
// 目录扫描/写盘辅助（main/online/migrate.ts）。
// 拉取 = 服务端 tree 与本地目录按 hash 比对（同 hash 跳过）；推送 = 本地文件与服务端 tree
// 比对（新文件 baseVersion=0、已存在带服务端 version，同 hash 跳过——D8 从不盲目覆盖）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chunk, parseProjectPrefix, planPull, planPush, restoreLocalPaths, toEntityPath } from "../../../src/shared/online/migrate.js";
import { hashContent, scanDirFiles, writeFiles } from "../../../src/main/online/migrate.js";
import type { OnlineTreeProject } from "../../../src/shared/online/contract.js";

const serverFile = (path: string, content: string, version = 1) => ({
  path,
  hash: hashContent(content),
  version,
  size: Buffer.byteLength(content, "utf8"),
});

describe("parseProjectPrefix / toEntityPath（计划 C 任务 2：本地名称树 ↔ 服务端实体寻址换算）", () => {
  it("groups/<组>/projects/<名>/ 前缀 → 目录二元组 + 项目内相对路径；非项目内路径 → null", () => {
    expect(parseProjectPrefix("groups/电商/projects/宠物商店/collections/c/apis/a/api.yaml")).toEqual({
      dir: { group: "电商", project: "宠物商店" },
      rest: "collections/c/apis/a/api.yaml",
    });
    expect(parseProjectPrefix("groups/电商/projects/宠物商店/project.yaml")).toEqual({
      dir: { group: "电商", project: "宠物商店" },
      rest: "project.yaml",
    });
    // groups/ 下无 projects 段的散文件不是项目内文件
    expect(parseProjectPrefix("groups/电商/散文件.txt")).toBeNull();
    // 根级文件（apicc.workspace.yaml 等）→ null
    expect(parseProjectPrefix("apicc.workspace.yaml")).toBeNull();
  });

  it("toEntityPath：<projectId>/<项目内相对路径>；非项目内路径 → null（根级文件不过映射）", () => {
    expect(toEntityPath("groups/电商/projects/宠物商店/project.yaml", "p-1")).toBe("p-1/project.yaml");
    expect(toEntityPath("groups/电商/projects/宠物商店/collections/c/api.yaml", "p-1")).toBe("p-1/collections/c/api.yaml");
    expect(toEntityPath("apicc.workspace.yaml", "p-1")).toBeNull();
  });
});

describe("restoreLocalPaths（pull 还原：<projectId>/... → 本地名称树路径，孤儿退化原样+标注）", () => {
  const serverFile = (path: string) => ({ path, hash: "h", version: 1, size: 1 });

  it("项目内文件还原 groups/<组名>/projects/<项目名>/...；根级文件原样且非孤儿", () => {
    const rows = restoreLocalPaths(
      [serverFile("p-1/collections/c/api.yaml"), serverFile("apicc.workspace.yaml")],
      [{ id: "p-1", name: "宠物商店", groupId: "g-1", myRole: "EDITOR" }],
      new Map([["g-1", "电商"]]),
    );
    expect(rows.map((r) => r.localPath)).toEqual(["groups/电商/projects/宠物商店/collections/c/api.yaml", "apicc.workspace.yaml"]);
    expect(rows.every((r) => !r.orphan)).toBe(true);
    expect(rows.map((r) => r.serverPath)).toEqual(["p-1/collections/c/api.yaml", "apicc.workspace.yaml"]);
  });

  it("孤儿 projectId（projects 无行 / groupId 缺席 / 组名不在清单）→ 原样保留实体路径 + orphan 标注", () => {
    const rows = restoreLocalPaths(
      [serverFile("p-x/a.yaml"), serverFile("p-1/a.yaml"), serverFile("p-2/a.yaml"), serverFile("apicc.workspace.yaml")],
      [
        { id: "p-1", name: "宠物商店", groupId: "g-1", myRole: "EDITOR" },
        { id: "p-2", name: "无组项目", myRole: "EDITOR" },
      ],
      new Map([["g-1", "电商"]]),
    );
    const byPath = new Map(rows.map((r) => [r.serverPath, r]));
    // projects 清单无此项目行 → 孤儿
    expect(byPath.get("p-x/a.yaml")).toEqual({ serverPath: "p-x/a.yaml", localPath: "p-x/a.yaml", orphan: true });
    // 项目行 + 组名齐全 → 正常还原
    expect(byPath.get("p-1/a.yaml")).toEqual({ serverPath: "p-1/a.yaml", localPath: "groups/电商/projects/宠物商店/a.yaml", orphan: false });
    // 项目行在但 groupId 缺席（无分组归属）→ 孤儿退化
    expect(byPath.get("p-2/a.yaml")!.orphan).toBe(true);
    expect(byPath.get("p-2/a.yaml")!.localPath).toBe("p-2/a.yaml");
    // 根级文件恒非孤儿
    expect(byPath.get("apicc.workspace.yaml")!.orphan).toBe(false);
  });

  it("同组同名项目并存（不同 projectId 还原同一条本地路径）→ 同路径后行者标 conflict（先到者得）", () => {
    // 计划 B：服务端允许同组同名项目并存——两实体还原出同一路径时后行者必须让位，
    // 否则取数换算表后行覆盖先行（先行者内容取不回）且落盘后写覆盖先写（审查发现 1）。
    // 护栏按 localPath 逐行判定（廉价护栏，非同名实体整盘合并语义）。
    const rows = restoreLocalPaths(
      [serverFile("p-1/a.yaml"), serverFile("p-2/a.yaml"), serverFile("p-2/b.yaml")],
      [
        { id: "p-1", name: "同名项目", groupId: "g-1", myRole: "EDITOR" },
        { id: "p-2", name: "同名项目", groupId: "g-1", myRole: "EDITOR" },
      ],
      new Map([["g-1", "电商"]]),
    );
    expect(rows.map((r) => r.localPath)).toEqual([
      "groups/电商/projects/同名项目/a.yaml",
      "groups/电商/projects/同名项目/a.yaml",
      "groups/电商/projects/同名项目/b.yaml",
    ]);
    // 先行者不标（toEqual 对 undefined 字段不敏感，逐键断言）
    expect(rows[0]!.conflict).toBeUndefined();
    // 同路径后行者（p-2 的 a.yaml）标 conflict；不碰撞的行（p-2 的 b.yaml）不受影响
    expect(rows[1]!.conflict).toBe(true);
    expect(rows[2]!.conflict).toBeUndefined();
  });
});

describe("hashContent（§3.4 hash = sha-256 hex，与服务端同口径；main 侧 scan 专用——渲染层不 import node: 内置）", () => {
  it("对 utf8 内容取 sha-256 hex", () => {
    expect(hashContent("hello")).toBe(createHash("sha256").update("hello", "utf8").digest("hex"));
    expect(hashContent("你好")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("planPull（拉取差异：同 path 同 hash 跳过）", () => {
  it("新路径 → pulled（待取内容）、hash 不同 → updated、hash 相同 → skipped", () => {
    const server = [
      serverFile("a/new.yaml", "new-content", 3),
      serverFile("b/changed.yaml", "server-content", 5),
      serverFile("c/same.yaml", "same", 2),
    ];
    const local = [
      { path: "b/changed.yaml", content: "local-content", hash: hashContent("local-content") },
      { path: "c/same.yaml", content: "same", hash: hashContent("same") },
      { path: "d/local-only.yaml", content: "local", hash: hashContent("local") },
    ];
    const plan = planPull(server, local);
    expect(plan.toFetch).toEqual(["a/new.yaml", "b/changed.yaml"]);
    expect(plan.details).toEqual([
      { path: "a/new.yaml", action: "pulled" },
      { path: "b/changed.yaml", action: "updated" },
      { path: "c/same.yaml", action: "skipped" },
    ]);
  });

  it("本地多出的文件不删（拉取永不删除本地文件）", () => {
    const plan = planPull([serverFile("a.yaml", "x")], [{ path: "extra.yaml", content: "e", hash: "h" }]);
    expect(plan.toFetch).toEqual(["a.yaml"]);
    expect(plan.details.every((d) => d.path !== "extra.yaml")).toBe(true);
  });
});

describe("planPush（推送差异：D8 从不盲目覆盖）", () => {
  it("新文件 baseVersion=0、已存在且 hash 不同带服务端 version、相同 hash 跳过", () => {
    const local = [
      { path: "a/new.yaml", content: "brand-new", hash: hashContent("brand-new") },
      { path: "b/changed.yaml", content: "pushed-content", hash: hashContent("pushed-content") },
      { path: "c/same.yaml", content: "identical", hash: hashContent("identical") },
    ];
    const server = [serverFile("b/changed.yaml", "server-old", 7), serverFile("c/same.yaml", "identical", 2)];
    const plan = planPush(local, server);
    expect(plan.entries).toEqual([
      { path: "a/new.yaml", content: "brand-new", baseVersion: 0 },
      { path: "b/changed.yaml", content: "pushed-content", baseVersion: 7 },
    ]);
    expect(plan.skipped).toEqual(["c/same.yaml"]);
  });

  it("hash 比对直接用 scan 产出的 hash（不在渲染层重算）：hash 相同 → 跳过，与 content 字段无关", () => {
    // 关键 1 备案：planPush 不得在客户端重算 hash（渲染包无 node:crypto）——
    // 本例 content 与服务端不同但 hash 相同（如大小写差异的等价内容）→ 按契约以 hash 为准跳过。
    const local = [{ path: "x/same.yaml", content: "different-bytes", hash: hashContent("server-truth") }];
    const plan = planPush(local, [serverFile("x/same.yaml", "server-truth", 3)]);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual(["x/same.yaml"]);
  });

  it("本地空目录 → 无 entries 无 skipped", () => {
    expect(planPush([], [serverFile("a.yaml", "x")])).toEqual({ entries: [], skipped: [] });
  });
});

describe("chunk（≤200/批 的分批，§3.4 files 批量上限）", () => {
  it("按 size 切分且保序；size≥1 钳制；空输入 → 空批", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk(["a"], 200)).toEqual([["a"]]);
    expect(chunk([], 200)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("scanDirFiles（main 侧目录扫描：相对 / 路径 + hash + utf8 内容）", () => {
  it("递归扫描文本文件，跳过 .apicc/.git 生成物目录，路径以 / 分隔", () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-scan-"));
    try {
      mkdirSync(join(root, "groups", "g", "nested"), { recursive: true });
      mkdirSync(join(root, ".apicc", "runs"), { recursive: true });
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, "apicc.workspace.yaml"), "id: ws\n", "utf8");
      writeFileSync(join(root, "groups", "g", "nested", "api.yaml"), "method: GET\n", "utf8");
      writeFileSync(join(root, ".apicc", "runs", "run.json"), "{}", "utf8");
      writeFileSync(join(root, ".git", "config"), "[core]", "utf8");
      const files = scanDirFiles(root);
      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(["apicc.workspace.yaml", "groups/g/nested/api.yaml"]);
      const api = files.find((f) => f.path === "groups/g/nested/api.yaml")!;
      expect(api.content).toBe("method: GET\n");
      expect(api.hash).toBe(hashContent("method: GET\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("目录不存在 → 可读错误（不返回空清单假装成功）", () => {
    expect(() => scanDirFiles(join(tmpdir(), "apicc-not-exists-xyz"))).toThrow(/不存在|目录/);
  });

  it("扫描产物带 projectDir（groups/<组>/projects/<名> 二元组；根级/非项目内文件为 null，供映射桥载荷）", () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-scan-dir-"));
    try {
      mkdirSync(join(root, "groups", "电商", "projects", "宠物商店", "collections", "c"), { recursive: true });
      writeFileSync(join(root, "apicc.workspace.yaml"), "id: ws\n", "utf8");
      writeFileSync(join(root, "groups", "电商", "projects", "宠物商店", "project.yaml"), "name: 宠物商店\n", "utf8");
      writeFileSync(join(root, "groups", "电商", "projects", "宠物商店", "collections", "c", "api.yaml"), "method: GET\n", "utf8");
      writeFileSync(join(root, "groups", "散文件.txt"), "x\n", "utf8");
      const files = scanDirFiles(root);
      const byPath = new Map(files.map((f) => [f.path, f]));
      // 根级文件与 groups/ 散文件：projectDir=null（不过映射桥，原路径直推）
      expect(byPath.get("apicc.workspace.yaml")!.projectDir).toBeNull();
      expect(byPath.get("groups/散文件.txt")!.projectDir).toBeNull();
      // 项目内文件：提取 (组, 项目) 二元组（多层相对路径共用同一目录归属）
      expect(byPath.get("groups/电商/projects/宠物商店/project.yaml")!.projectDir).toEqual({ group: "电商", project: "宠物商店" });
      expect(byPath.get("groups/电商/projects/宠物商店/collections/c/api.yaml")!.projectDir).toEqual({ group: "电商", project: "宠物商店" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writeFiles（main 侧落盘：相对路径护栏 + 逐文件写入）", () => {
  it("按相对路径创建父目录并写入，返回写入路径清单", () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-write-"));
    try {
      const written = writeFiles(root, [
        { path: "groups/g/projects/p/collections/c/apis/a/api.yaml", content: "method: POST\n" },
        { path: "apicc.workspace.yaml", content: "id: ws\n" },
      ]);
      expect(written).toEqual(["groups/g/projects/p/collections/c/apis/a/api.yaml", "apicc.workspace.yaml"]);
      expect(readText(join(root, "groups", "g", "projects", "p", "collections", "c", "apis", "a", "api.yaml"))).toBe("method: POST\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("越界路径拒绝（.. 绝对路径 反斜杠），不落盘不部分写入", () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-write-"));
    try {
      expect(() => writeFiles(root, [{ path: "../escape.yaml", content: "x" }])).toThrow();
      expect(() => writeFiles(root, [{ path: "/abs.yaml", content: "x" }])).toThrow();
      expect(() => writeFiles(root, [{ path: "a\\b.yaml", content: "x" }])).toThrow();
      expect(() => writeFiles(root, [{ path: "ok.yaml", content: "x" }, { path: "../bad.yaml", content: "y" }])).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** node:fs 读取辅助（断言落盘内容）。 */
function readText(file: string): string {
  return readFileSync(file, "utf8");
}
