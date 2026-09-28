import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage } from "@apicc/core";
import type { ShardOutcome, Workspace } from "@apicc/core";
import { runCli } from "../src/main.js";

let server: Server;
let baseUrl = "";
let root: string;
let prevCwd = "";
const receivedPaths: string[] = [];
type ObservedRequest = { method: string; url: string; headers: Record<string, string | undefined>; body: string };
const receivedRequests: ObservedRequest[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      receivedPaths.push(req.url ?? "");
      receivedRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: {
          "x-pre-script": typeof req.headers["x-pre-script"] === "string" ? req.headers["x-pre-script"] : undefined,
          "x-pre-operation": typeof req.headers["x-pre-operation"] === "string" ? req.headers["x-pre-operation"] : undefined,
        },
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  root = mkdtempSync(join(tmpdir(), "apicc-e2e-"));
  const ws: Workspace = {
    id: "00000000-0000-4000-8000-000000000001", name: "e2e", variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000002", name: "demo", projects: [{
        id: "00000000-0000-4000-8000-000000000004", name: "svc", variables: {},
        stressPolicy: { trustedOrigins: [baseUrl] },
        workflows: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000006", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "00000000-0000-4000-8000-000000000008", name: "api", variables: {}, folders: [],
          apis: [
            {
              id: "00000000-0000-4000-8000-000000000011", name: "ok", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              design: "# 设计",
              cases: [{ id: "00000000-0000-4000-8000-000000000015", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
            },
            {
              id: "00000000-0000-4000-8000-000000000012", name: "bad", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              cases: [{ id: "00000000-0000-4000-8000-000000000016", name: "fails", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "500" }] }],
            },
          ],
        }, {
          id: "00000000-0000-4000-8000-000000000009", name: "xapi", variables: {}, folders: [],
          apis: [{
            id: "00000000-0000-4000-8000-000000000013", name: "xok", version: "1", deprecated: false, method: "GET",
            url: "{{baseUrl}}/x", headers: [], query: [],
            cases: [{ id: "00000000-0000-4000-8000-000000000017", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
          }],
        }, {
          id: "00000000-0000-4000-8000-000000000021", name: "credibility", variables: {}, folders: [],
          apis: [{
            id: "00000000-0000-4000-8000-000000000022", name: "rich", version: "1", deprecated: false, method: "POST",
            url: "{{baseUrl}}/credibility/{{item}}", headers: [], query: [],
            body: { kind: "json", content: '{"payload":"{{payload}}"}' },
            cases: [{
              id: "00000000-0000-4000-8000-000000000023", name: "rich-case", scope: "base",
              parameters: { item: "parameter-item", payload: "parameter-payload" },
              dataDriver: { sourcePath: join(root, "credibility.csv"), format: "csv" },
              preScript: 'pm.request.headers["X-Pre-Script"] = "from-script";',
              preOperations: [{ id: "rich-pre", type: "script", content: 'pm.request.headers["X-Pre-Operation"] = "from-operation"; pm.request.url += "?marker=operation";' }],
              postOperations: [{ id: "rich-post", type: "script", content: 'pm.assert(pm.response.status === 200, "post operation");' }],
              postScript: 'pm.assert(pm.response.text().includes("\\"ok\\":true"), "post script");',
              assertions: [
                { id: "rich-status", target: "status", op: "eq", expected: "200" },
                { id: "rich-body", target: "bodyJson", op: "eq", path: "$.ok", expected: "true" },
              ],
            }],
          }],
        }],
      }],
    }, {
      id: "00000000-0000-4000-8000-000000000003", name: "demo2", projects: [{
        id: "00000000-0000-4000-8000-000000000005", name: "svc", variables: {},
        workflows: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000007", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "00000000-0000-4000-8000-000000000010", name: "api", variables: {}, folders: [],
          apis: [{
            id: "00000000-0000-4000-8000-000000000014", name: "ok2", version: "1", deprecated: false, method: "GET",
            url: "{{baseUrl}}/x", headers: [], query: [],
            cases: [{ id: "00000000-0000-4000-8000-000000000018", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
          }],
        }],
      }],
    }],
  };
  writeFileSync(join(root, "credibility.csv"), "item,payload\nrow-item,row-payload\n");
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

  it("run 未指定 --runs-dir 时产物默认写入 <workspaceRoot>/.apicc/runs，数据树零污染（回归 I1）", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["run", "groups/demo/projects/svc/collections/xapi", "--env", "dev", "--reporters", "html,junit"],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    const { readdirSync, existsSync } = await import("node:fs");
    const defaultRunsDir = join(root, ".apicc", "runs");
    const produced = readdirSync(defaultRunsDir);
    expect(produced.some((f) => f.endsWith(".json"))).toBe(true);
    expect(produced.some((f) => f.endsWith(".html"))).toBe(true);
    expect(produced.some((f) => f.endsWith(".xml"))).toBe(true);
    // 数据树内不留任何运行产物（id 布局：xapi 集合目录名为其 id）
    expect(existsSync(join(root, "groups", "00000000-0000-4000-8000-000000000002", "projects", "00000000-0000-4000-8000-000000000004", "collections", "00000000-0000-4000-8000-000000000009", "runs"))).toBe(false);
    // 产物落盘后重新加载工作区，validate 语义不受影响
    const { problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    expect(logs.join("\n")).toContain("报告已生成");
  });

  it("import --yes 导入 OpenAPI 样例退出码 0，重开工作区断言项目存在；重复导入同名并存（轨一同名放开）", async () => {
    const { writeFileSync } = await import("node:fs");
    const sample = join(root, "openapi-sample.yaml");
    writeFileSync(sample, [
      "openapi: 3.0.0",
      "info:",
      "  title: 宠物样例",
      "  version: 1.0.0",
      "servers:",
      "  - url: http://127.0.0.1:1",
      "paths:",
      "  /pets:",
      "    get:",
      "      operationId: listPets",
      "      responses:",
      "        '200':",
      "          description: ok",
    ].join("\n"));
    const logs: string[] = [];
    const code = await runCli(["import", sample, "--group", "imported", "--yes"], createDefaultRegistry(), (l) => logs.push(l));
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("已导入项目「宠物样例」到分组「imported」");
    // 重开工作区断言项目存在（分组不存在时由 import 创建；含导入集合与接口）
    const { workspace } = await fileStorage.load(root);
    const group = workspace.groups.find((g) => g.name === "imported");
    expect(group).toBeDefined();
    const project = group!.projects.find((p) => p.name === "宠物样例");
    expect(project).toBeDefined();
    expect(project!.collections[0]!.apis.map((a) => a.name)).toContain("listPets");
    // 重复导入同名项目：同名放开（轨一）后并存，不再拒绝——两个同名项目 id 不同
    const code2 = await runCli(["import", sample, "--group", "imported", "--yes"], createDefaultRegistry());
    expect(code2).toBe(0);
    const { workspace: ws2 } = await fileStorage.load(root);
    const same = ws2.groups.find((g) => g.name === "imported")!.projects.filter((p) => p.name === "宠物样例");
    expect(same).toHaveLength(2);
    expect(same[0]!.id).not.toBe(same[1]!.id);
  });

  it("import 不带 --yes 只打印预览不写入工作区", async () => {
    const { writeFileSync } = await import("node:fs");
    const sample = join(root, "preview-sample.yaml");
    writeFileSync(sample, ["openapi: 3.0.0", "info:", "  title: 预览项目", "  version: 1.0.0", "paths: {}"].join("\n"));
    const logs: string[] = [];
    const code = await runCli(["import", sample, "--group", "preview-group"], createDefaultRegistry(), (l) => logs.push(l));
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("预览：将导入项目「预览项目」");
    expect(logs.join("\n")).toContain("--yes");
    const { workspace } = await fileStorage.load(root);
    expect(workspace.groups.some((g) => g.name === "preview-group")).toBe(false);
  });

  it("import 无法识别的格式抛「无法识别的导入格式」", async () => {
    const { writeFileSync } = await import("node:fs");
    const sample = join(root, "unknown-format.txt");
    writeFileSync(sample, "既不是 OpenAPI 也不是 v2.1 集合的普通文本");
    await expect(runCli(["import", sample, "--group", "g"], createDefaultRegistry())).rejects.toThrow(/无法识别的导入格式/);
  });

  it("run-workflow 按条件流转执行并产出报告", async () => {
    // 夹具：三节点条件工作流 one --prev.passed--> two --false--> three，workflow.yaml 手写落盘
    // （nodes 引用既有夹具接口：a1/t1 通过、a3/t3 通过、a2/t2 失败——three 若被错误流转执行会致失败）。
    const { mkdirSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    // id 布局（轨一）：工作流目录名=工作流 id；apiId/caseId 引用夹具接口的 UUID id
    const wfDir = join(root, "groups", "00000000-0000-4000-8000-000000000002", "projects", "00000000-0000-4000-8000-000000000004", "workflows", "00000000-0000-4000-8000-000000000019");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"), [
      "id: 00000000-0000-4000-8000-000000000019",
      "name: 条件流",
      "status: enabled",
      "nodes:",
      "  - id: one",
      "    kind: request",
      "    apiId: 00000000-0000-4000-8000-000000000011",
      "    caseId: 00000000-0000-4000-8000-000000000015",
      "    label: one",
      "  - id: two",
      "    kind: request",
      "    apiId: 00000000-0000-4000-8000-000000000013",
      "    caseId: 00000000-0000-4000-8000-000000000017",
      "    label: two",
      "  - id: three",
      "    kind: request",
      "    apiId: 00000000-0000-4000-8000-000000000012",
      "    caseId: 00000000-0000-4000-8000-000000000016",
      "    label: three",
      "edges:",
      "  - id: e1",
      "    from: one",
      "    to: two",
      "    condition: prev.passed",
      "  - id: e2",
      "    from: two",
      "    to: three",
      '    condition: "false"',
    ].join("\n"));
    const logs: string[] = [];
    const code = await runCli(
      ["run-workflow", "groups/demo/projects/svc/workflows/条件流", "--env", "dev", "--reporters", "junit"],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    // 报告生成：默认落 <root>/.apicc/runs；原始结果 JSON（workflow-*.json）与报告同目录
    const runsDir = join(root, ".apicc", "runs");
    const produced = readdirSync(runsDir);
    expect(produced.some((f) => f.endsWith(".xml"))).toBe(true);
    expect(logs.join("\n")).toContain("报告已生成");
    const raws = produced.filter((f) => f.startsWith("workflow-") && f.endsWith(".json"));
    expect(raws.length).toBeGreaterThan(0);
    // three 节点被条件边挡下 → skipped；失败用例 t2 未被执行，退出码仍为 0
    const wfr = JSON.parse(readFileSync(join(runsDir, raws[raws.length - 1]!), "utf8")) as {
      failed: number;
      nodeResults: Array<{ nodeId: string; state: string }>;
    };
    expect(wfr.nodeResults.find((n) => n.nodeId === "three")?.state).toBe("skipped");
    expect(wfr.failed).toBe(0);
    expect(logs.join("\n")).toContain("跳过 1");
    expect(logs.join("\n")).toContain("条件不满足");
  }, 30000);

  it("run-workflow 草稿默认拒绝，--force-draft 放行；未知路径报「未找到工作流」", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const wfDir = join(root, "groups", "00000000-0000-4000-8000-000000000002", "projects", "00000000-0000-4000-8000-000000000004", "workflows", "00000000-0000-4000-8000-000000000020");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "workflow.yaml"), [
      "id: 00000000-0000-4000-8000-000000000020",
      "name: 草稿流",
      "status: draft",
      "nodes:",
      "  - id: only",
      "    kind: request",
      "    apiId: 00000000-0000-4000-8000-000000000011",
      "    caseId: 00000000-0000-4000-8000-000000000015",
      "    label: only",
      "edges: []",
    ].join("\n"));
    await expect(
      runCli(["run-workflow", "groups/demo/projects/svc/workflows/草稿流", "--env", "dev"], createDefaultRegistry()),
    ).rejects.toThrow(/工作流为草稿，请先发布启用或加 --force-draft/);
    const code = await runCli(
      ["run-workflow", "groups/demo/projects/svc/workflows/草稿流", "--env", "dev", "--force-draft"],
      createDefaultRegistry(),
    );
    expect(code).toBe(0);
    await expect(
      runCli(["run-workflow", "groups/demo/projects/svc/workflows/不存在", "--env", "dev"], createDefaultRegistry()),
    ).rejects.toThrow(/未找到工作流/);
  });

  it("run-stress 对接口用例并发压测并落盘 JSON", async () => {
    // 夹具：既有临时工作区 + 本地 server（复用文件内既有 beforeAll 资源）。
    const runsDir = join(root, "stress-runs");
    const logs: string[] = [];
    const code = await runCli(
      [
        "run-stress", "groups/demo/projects/svc/collections/api/apis/ok",
        "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "4", "--iterations", "12",
        "--runs-dir", runsDir,
      ],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    const { readdirSync, readFileSync } = await import("node:fs");
    const files = readdirSync(runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const report = JSON.parse(readFileSync(join(runsDir, files[files.length - 1]!), "utf8")) as {
      totalRequests: number;
      ok: number;
      failed: number;
      concurrency: number;
    };
    expect(report.totalRequests).toBe(12);
    expect(report.concurrency).toBe(4);
    expect(report.ok).toBe(12);
    expect(report.failed).toBe(0);
    expect(logs.join("\n")).toContain("RPS");
  }, 30000);

  it("run-stress 首次目标（包括 loopback）无确认时在发包前拒绝，并保留结构化 origin", async () => {
    const { workspace } = await fileStorage.load(root);
    const project = workspace.groups[0]!.projects[0]!;
    project.stressPolicy = { trustedOrigins: [], deniedOrigins: [] };
    await fileStorage.save(root, workspace);
    const runsDir = join(root, "stress-unconfirmed");
    const logs: string[] = [];
    const code = await runCli([
      "run-stress", "groups/demo/projects/svc/collections/api/apis/ok", "--case", "00000000-0000-4000-8000-000000000015",
      "--env", "dev", "--concurrency", "1", "--iterations", "1", "--runs-dir", runsDir,
    ], createDefaultRegistry(), (line) => logs.push(line));
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("target_confirmation_required");
    expect(logs.join("\n")).toContain(baseUrl);
    const { readdirSync, readFileSync } = await import("node:fs");
    const file = readdirSync(runsDir).find((name) => name.endsWith(".json"))!;
    const report = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as {
      totalRequests: number; safety?: { targetOrigins: Array<{ origin: string; loopback?: boolean; confirmation: string }> };
    };
    expect(report.totalRequests).toBe(1);
    expect(report.safety?.targetOrigins).toEqual([{ origin: baseUrl, confirmation: "rejected", policy: "target_confirmation_required", loopback: true }]);
    project.stressPolicy = { trustedOrigins: [baseUrl] };
    await fileStorage.save(root, workspace);
  }, 30000);

  it("run-stress 精确 allow-target 放行，HTTP 200 但断言失败仍以 verdict 失败退出", async () => {
    const runsDir = join(root, "stress-assertion");
    const logs: string[] = [];
    const code = await runCli([
      "run-stress", "groups/demo/projects/svc/collections/api/apis/bad", "--case", "00000000-0000-4000-8000-000000000016",
      "--env", "dev", "--concurrency", "1", "--iterations", "1", "--allow-target", baseUrl, "--runs-dir", runsDir,
    ], createDefaultRegistry(), (line) => logs.push(line));
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("verdict: failed");
    expect(logs.join("\n")).toContain("失败分类: assertion=1");
    expect(logs.join("\n")).toContain("target origins");
  }, 30000);

  it.each(["https://example.com/path", "https://user:pass@example.com", "ftp://example.com"])(
    "run-stress 拒绝非 origin allow-target %s", async (origin) => {
      await expect(runCli([
        "run-stress", "groups/demo/projects/svc/collections/api/apis/ok", "--case", "00000000-0000-0000-0000-000000000015",
        "--env", "dev", "--concurrency", "1", "--iterations", "1", "--allow-target", origin,
      ], createDefaultRegistry(), () => {})).rejects.toThrow(/allow-target/);
    },
  );

  it.each(["omitted-slashes", "whitespace", "backslash", "uppercase"])(
    "run-stress WHATWG special HTTP URL %s 先做结构化目标确认，再以 canonical URL 发包",
    async (variant) => {
      const hostPath = baseUrl.slice("http://".length);
      const specialUrl = variant === "omitted-slashes"
        ? `http:${hostPath}/x`
        : variant === "whitespace"
          ? `\thttp:${hostPath}/x \n`
          : variant === "backslash"
            ? `http:\\${hostPath}\\x`
            : `HTTP://${hostPath}/x`;
      const { workspace } = await fileStorage.load(root);
      const project = workspace.groups[0]!.projects[0]!;
      const api = project.collections[0]!.apis[0]!;
      api.url = specialUrl;
      project.stressPolicy = { trustedOrigins: [], deniedOrigins: [] };
      await fileStorage.save(root, workspace);
      try {
        const canonical = new URL(specialUrl);
        const runsDir = join(root, `stress-special-${receivedPaths.length}`);
        const rejectedLogs: string[] = [];
        const beforeRejected = receivedPaths.length;
        await expect(runCli([
          "run-stress", "groups/demo/projects/svc/collections/api/apis/ok", "--case", "00000000-0000-4000-8000-000000000015",
          "--env", "dev", "--concurrency", "1", "--iterations", "1", "--runs-dir", runsDir,
        ], createDefaultRegistry(), (line) => rejectedLogs.push(line))).resolves.toBe(1);
        expect(receivedPaths.length).toBe(beforeRejected);
        expect(rejectedLogs.join("\n")).toContain("target_confirmation_required");
        expect(rejectedLogs.join("\n")).toContain(canonical.origin);
        expect(rejectedLogs.join("\n")).not.toContain("无协议客户端");

        const allowedLogs: string[] = [];
        const beforeAllowed = receivedPaths.length;
        await expect(runCli([
          "run-stress", "groups/demo/projects/svc/collections/api/apis/ok", "--case", "00000000-0000-4000-8000-000000000015",
          "--env", "dev", "--concurrency", "1", "--iterations", "1", "--allow-target", canonical.origin, "--runs-dir", runsDir,
        ], createDefaultRegistry(), (line) => allowedLogs.push(line))).resolves.toBe(0);
        expect(receivedPaths.length).toBe(beforeAllowed + 1);
        expect(receivedPaths.at(-1)).toBe("/x");
        expect(allowedLogs.join("\n")).toContain(`target origins: ${canonical.origin}`);
      } finally {
        // Restore the shared fixture for the following case and tests.
        api.url = "{{baseUrl}}/x";
        project.stressPolicy = { trustedOrigins: [baseUrl] };
        await fileStorage.save(root, workspace);
      }
    },
  );

  it("同一完整用例的集合运行与 concurrency=1/iterations=1 压测请求和结果一致", async () => {
    const normalizeRequest = (request: ObservedRequest) => ({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });
    const functionalDir = join(root, "stress-credibility-functional");
    const functionalBefore = receivedRequests.length;
    const functionalCode = await runCli([
      "run", "groups/demo/projects/svc/collections/credibility", "--env", "dev", "--reporters", "html", "--runs-dir", functionalDir,
    ], createDefaultRegistry());
    expect(functionalCode).toBe(0);
    const { readdirSync, readFileSync } = await import("node:fs");
    const functionalFile = readdirSync(functionalDir).find((name) => name.endsWith(".json"));
    expect(functionalFile).toBeDefined();
    const functionalResult = JSON.parse(readFileSync(join(functionalDir, functionalFile!), "utf8")) as {
      total: number; passed: number; failed: number; cases?: Array<{ assertions?: unknown[] }>;
    };
    expect(functionalResult).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(functionalResult.cases?.[0]?.assertions?.length).toBeGreaterThanOrEqual(4);
    const functionalObservedRequest = normalizeRequest(receivedRequests[functionalBefore]!);

    const stressDir = join(root, "stress-credibility-stress");
    const stressBefore = receivedRequests.length;
    const stressLogs: string[] = [];
    const stressCode = await runCli([
      "run-stress", "groups/demo/projects/svc/collections/credibility/apis/rich",
      "--case", "00000000-0000-4000-8000-000000000023", "--env", "dev", "--concurrency", "1", "--iterations", "1",
      "--allow-target", baseUrl, "--runs-dir", stressDir,
    ], createDefaultRegistry(), (line) => stressLogs.push(line));
    expect(stressCode).toBe(0);
    const stressFile = readdirSync(stressDir).find((name) => name.endsWith(".json"));
    expect(stressFile).toBeDefined();
    const stressReport = JSON.parse(readFileSync(join(stressDir, stressFile!), "utf8")) as {
      totalRequests: number; ok: number; failed: number; verdict?: { passed: boolean };
    };
    const stressObservedRequest = normalizeRequest(receivedRequests[stressBefore]!);
    expect(stressObservedRequest).toEqual(functionalObservedRequest);
    expect(stressReport.ok).toBe(functionalResult.passed ? 1 : 0);
    expect(stressReport.verdict?.passed).toBe(functionalResult.passed === 1);
    expect(stressReport).toMatchObject({ totalRequests: 1, failed: 0 });
    expect(stressLogs.join("\n")).toContain("verdict: passed");
  }, 30000);

  it("目标确认只匹配精确 origin：path 可变、scheme/host/port 必须重确认，denylist 和阈值失败仍优先", async () => {
    const { workspace } = await fileStorage.load(root);
    const project = workspace.groups[0]!.projects[0]!;
    const api = project.collections.find((collection) => collection.name === "credibility")!.apis[0]!;
    const dataPath = join(root, "credibility.csv");
    const originalData = "item,payload\nrow-item,row-payload\n";
    const originalUrl = api.url;
    const originalPolicy = project.stressPolicy;
    const originalEnvironments = project.environments;
    const runArgs = (env: string, runsDir: string, extra: string[] = []) => [
      "run-stress", "groups/demo/projects/svc/collections/credibility/apis/rich",
      "--case", "00000000-0000-4000-8000-000000000023", "--env", env, "--concurrency", "1", "--iterations", "1",
      "--allow-target", baseUrl, "--runs-dir", runsDir, ...extra,
    ];
    try {
      writeFileSync(dataPath, "item,payload\nfirst,p1\nsecond,p2\n");
      project.stressPolicy = { trustedOrigins: [], deniedOrigins: [] };
      await fileStorage.save(root, workspace);
      const pathLogs: string[] = [];
      const pathBefore = receivedRequests.length;
      expect(await runCli([
        ...runArgs("dev", join(root, "stress-origin-path"), ["--iterations", "2"]),
      ], createDefaultRegistry(), (line) => pathLogs.push(line))).toBe(0);
      expect(receivedRequests.slice(pathBefore).map((request) => request.url)).toEqual([
        "/credibility/first?marker=operation", "/credibility/second?marker=operation",
      ]);
      expect(pathLogs.join("\n")).toContain(`target origins: ${baseUrl}`);

      const port = Number(new URL(baseUrl).port);
      for (const [label, targetUrl] of [
        ["scheme", `https://127.0.0.1:${port}/credibility/{{item}}`],
        ["host", `http://localhost:${port}/credibility/{{item}}`],
        ["port", `http://127.0.0.1:${port + 1}/credibility/{{item}}`],
      ] as const) {
        api.url = targetUrl;
        await fileStorage.save(root, workspace);
        const logs: string[] = [];
        const before = receivedRequests.length;
        expect(await runCli(runArgs("dev", join(root, `stress-origin-${label}`)), createDefaultRegistry(), (line) => logs.push(line))).toBe(1);
        expect(receivedRequests.length).toBe(before);
        expect(logs.join("\n")).toContain("target_confirmation_required");
      }

      api.url = originalUrl;
      project.environments = [...originalEnvironments, { id: "00000000-0000-4000-8000-000000000024", name: "production", variables: { baseUrl } }];
      await fileStorage.save(root, workspace);
      expect(await runCli(runArgs("production", join(root, "stress-origin-label")), createDefaultRegistry())).toBe(0);

      project.stressPolicy = { trustedOrigins: [], deniedOrigins: [baseUrl] };
      await fileStorage.save(root, workspace);
      const deniedLogs: string[] = [];
      const deniedBefore = receivedRequests.length;
      expect(await runCli(runArgs("dev", join(root, "stress-origin-denied")), createDefaultRegistry(), (line) => deniedLogs.push(line))).toBe(1);
      expect(receivedRequests.length).toBe(deniedBefore);
      expect(deniedLogs.join("\n")).toContain("target_denied");

      project.stressPolicy = { trustedOrigins: [baseUrl], deniedOrigins: [] };
      await fileStorage.save(root, workspace);
      const thresholdLogs: string[] = [];
      expect(await runCli(runArgs("dev", join(root, "stress-threshold"), ["--max-p95-ms", "0.0001"]), createDefaultRegistry(), (line) => thresholdLogs.push(line))).toBe(1);
      expect(thresholdLogs.join("\n")).toContain("[阈值失败]");
    } finally {
      writeFileSync(dataPath, originalData);
      api.url = originalUrl;
      project.environments = originalEnvironments;
      project.stressPolicy = originalPolicy;
      await fileStorage.save(root, workspace);
    }
  }, 30000);

  it("单机与本地多分片对同一 HTTP 200 断言失败保持分类和退出码一致", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const runArgs = (runsDir: string, extra: string[] = []) => [
      "run-stress", "groups/demo/projects/svc/collections/api/apis/bad",
      "--case", "00000000-0000-4000-8000-000000000016", "--env", "dev", "--concurrency", "1", "--iterations", "2",
      "--allow-target", baseUrl, "--runs-dir", runsDir, ...extra,
    ];
    const singleDir = join(root, "stress-consistency-single");
    const singleLogs: string[] = [];
    const singleCode = await runCli(runArgs(singleDir), createDefaultRegistry(), (line) => singleLogs.push(line));
    const singleFile = readdirSync(singleDir).find((name) => name.endsWith(".json"))!;
    const single = JSON.parse(readFileSync(join(singleDir, singleFile), "utf8")) as {
      failures: Record<string, number>; verdict?: { passed: boolean };
    };

    const multiDir = join(root, "stress-consistency-multi");
    const multiLogs: string[] = [];
    const spawnWorkerFactory = () => async (spec: {
      apiPath: string; caseId: string; envName?: string; concurrency: number; maxIterations?: number; durationMs?: number;
      maxRps?: number; maxErrorRate?: number; maxAssertionFailureRate?: number; maxP95Ms?: number; minRps?: number;
      connectionMode?: "pooled" | "fresh"; confirmedTargetOrigins?: string[]; shardId: string; workspaceRoot: string;
    }): Promise<ShardOutcome> => {
      let wire = "";
      const code = await runCli([
        "stress-worker", spec.apiPath, "--case", spec.caseId, "--env", spec.envName!, "--concurrency", String(spec.concurrency),
        "--iterations", String(spec.maxIterations), "--shard-id", spec.shardId, "--workspace", spec.workspaceRoot,
        "--allow-target", ...(spec.confirmedTargetOrigins ?? []),
      ], createDefaultRegistry(), () => {}, { workerOut: (line) => { wire = line; }, workerErr: () => {} });
      expect(code).toBe(0);
      const outcome = JSON.parse(wire) as ShardOutcome;
      if (outcome.ok) outcome.generator = { ...outcome.generator, saturated: true, reasons: ["cpu"] };
      return outcome;
    };
    const multiCode = await runCli(runArgs(multiDir, ["--shards", "2"]), createDefaultRegistry(), (line) => multiLogs.push(line), { spawnWorkerFactory });
    const multiFile = readdirSync(multiDir).find((name) => name.endsWith(".json"))!;
    const multi = JSON.parse(readFileSync(join(multiDir, multiFile), "utf8")) as {
      failures: Record<string, number>; verdict?: { passed: boolean }; distributed?: { dataComplete: boolean };
    };
    expect(singleCode).toBe(1);
    expect(multiCode).toBe(singleCode);
    expect(single.failures.assertion).toBeGreaterThan(0);
    expect(multi.failures.assertion).toBeGreaterThan(0);
    expect(multi.verdict?.passed).toBe(single.verdict?.passed);
    expect(multi.distributed?.dataComplete).toBe(true);
    expect(singleLogs.join("\n")).toContain("失败分类: assertion=");
    expect(multiLogs.join("\n")).toContain("失败分类: assertion=");
    expect(multiLogs.join("\n")).toContain("[警告] generator saturation");
  }, 30000);
});
