import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage } from "@apicc/core";
import type { Workspace } from "@apicc/core";
import { runCli } from "../src/main.js";

let server: Server;
let baseUrl = "";
let root: string;
let prevCwd = "";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  root = mkdtempSync(join(tmpdir(), "apicc-e2e-"));
  const ws: Workspace = {
    id: "w1", name: "e2e", variables: {},
    groups: [{
      id: "g1", name: "demo", projects: [{
        id: "p1", name: "svc", variables: {},
        environments: [{ id: "e1", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "c1", name: "api", variables: {}, folders: [],
          apis: [
            {
              id: "a1", name: "ok", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              design: "# 设计",
              cases: [{ id: "t1", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
            },
            {
              id: "a2", name: "bad", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              cases: [{ id: "t2", name: "fails", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "500" }] }],
            },
          ],
        }, {
          id: "c2", name: "xapi", variables: {}, folders: [],
          apis: [{
            id: "a3", name: "xok", version: "1", deprecated: false, method: "GET",
            url: "{{baseUrl}}/x", headers: [], query: [],
            cases: [{ id: "t3", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
          }],
        }],
      }],
    }, {
      id: "g2", name: "demo2", projects: [{
        id: "p2", name: "svc", variables: {},
        environments: [{ id: "e2", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "c3", name: "api", variables: {}, folders: [],
          apis: [{
            id: "a4", name: "ok2", version: "1", deprecated: false, method: "GET",
            url: "{{baseUrl}}/x", headers: [], query: [],
            cases: [{ id: "t4", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
          }],
        }],
      }],
    }],
  };
  await fileStorage.save(root, ws);
  // 注：CLI 的 run/export-design 按“从 cwd 向上查找 apicc.workspace.yaml”定位工作区；
  // 临时工作区无法从测试 cwd 上溯可达，故模拟真实用户“在工作区内执行 CLI”（用后还原）。
  prevCwd = process.cwd();
  process.chdir(root);
});
afterAll(() => {
  process.chdir(prevCwd);
  return new Promise<void>((r) => server.close(() => r()));
});

describe("CLI 端到端", () => {
  it("validate 正常工作区退出码 0", async () => {
    const code = await runCli(["validate", root], createDefaultRegistry());
    expect(code).toBe(0);
  });

  it("run 执行集合并产出报告，失败用例使退出码为 1", async () => {
    const runsDir = join(root, "runs");
    const code = await runCli(
      ["run", "groups/demo/projects/svc/collections/api", "--env", "dev", "--reporters", "html,junit", "--runs-dir", runsDir],
      createDefaultRegistry(),
    );
    expect(code).toBe(1);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(runsDir).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("run 传正斜杠相对路径正确定位，不误匹配 xapi、重名集合取首个", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["run", "collections/api", "--env", "dev", "--reporters", "html"],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(1);
    // 仅 demo/svc/collections/api（2 用例：1 过 1 败）应被运行；
    // xapi 与 demo2 下重名 api 均 1 用例全过——命中其一则“总计/退出码”皆不符。
    expect(logs.join("\n")).toContain("总计 2 · 通过 1 · 失败 1");
  });

  it("export-design 输出 Markdown 到 stdout", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["export-design", "groups/demo/projects/svc/collections/api/apis/ok"],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("# 设计");
  });
});
