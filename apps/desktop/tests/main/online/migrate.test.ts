// M3-B 任务 3（简报裁定 D）：迁移差异比对纯函数（shared/online/migrate.ts）与 main 侧
// 目录扫描/写盘辅助（main/online/migrate.ts）。
// 拉取 = 服务端 tree 与本地目录按 hash 比对（同 hash 跳过）；推送 = 本地文件与服务端 tree
// 比对（新文件 baseVersion=0、已存在带服务端 version，同 hash 跳过——D8 从不盲目覆盖）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chunk, planPull, planPush } from "../../../src/shared/online/migrate.js";
import { hashContent, scanDirFiles, writeFiles } from "../../../src/main/online/migrate.js";

const serverFile = (path: string, content: string, version = 1) => ({
  path,
  hash: hashContent(content),
  version,
  size: Buffer.byteLength(content, "utf8"),
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
