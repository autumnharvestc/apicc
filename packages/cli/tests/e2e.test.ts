import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage, workflowToRunResult } from "@apicc/core";
import type { PluginRegistry, ShardOutcome, Workspace } from "@apicc/core";
import { runCli as runCliActual, type RunCliDeps } from "../src/main.js";

let server: Server;
let baseUrl = "";
let root: string;
let dataRoot: string;
let credibilityCsv: string;
let prevCwd = "";
let networkPrivateRoot = "";
const receivedPaths: string[] = [];
type ObservedRequest = { method: string; url: string; headers: Record<string, string | undefined>; body: string };
const receivedRequests: ObservedRequest[] = [];

function runCli(argv: string[], registry: PluginRegistry, log: (line: string) => void = () => {}, deps: RunCliDeps = {}): Promise<number> {
  return runCliActual(argv, registry, log, { networkPrivateRoot, ...deps });
}

const GROUP_A = "00000000-0000-4000-8000-000000000002";
const GROUP_B = "00000000-0000-4000-8000-000000000003";
const PROJECT_A = "00000000-0000-4000-8000-000000000004";
const PROJECT_B = "00000000-0000-4000-8000-000000000005";
const COLLECTION_API = "00000000-0000-4000-8000-000000000008";
const COLLECTION_XAPI = "00000000-0000-4000-8000-000000000009";
const COLLECTION_B = "00000000-0000-4000-8000-000000000010";
const COLLECTION_CREDIBILITY = "00000000-0000-4000-8000-000000000021";
const API_OK = "00000000-0000-4000-8000-000000000011";
const API_BAD = "00000000-0000-4000-8000-000000000012";
const API_XOK = "00000000-0000-4000-8000-000000000013";
const API_OK2 = "00000000-0000-4000-8000-000000000014";
const API_RICH = "00000000-0000-4000-8000-000000000022";
const CASE_OK = "00000000-0000-4000-8000-000000000015";
const CASE_BAD = "00000000-0000-4000-8000-000000000016";
const CASE_XOK = "00000000-0000-4000-8000-000000000017";
const CASE_OK2 = "00000000-0000-4000-8000-000000000018";
const CASE_RICH = "00000000-0000-4000-8000-000000000023";
const collectionPath = (groupId: string, projectId: string, collectionId: string) =>
  `groups/${groupId}/projects/${projectId}/collections/${collectionId}`;
const apiPath = (groupId: string, projectId: string, collectionId: string, apiId: string) =>
  `${collectionPath(groupId, projectId, collectionId)}/apis/${apiId}`;
const workflowPath = (groupId: string, projectId: string, workflowId: string) =>
  `groups/${groupId}/projects/${projectId}/workflows/${workflowId}`;

type ApiCase = Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["cases"][number];
type ApiRequest = Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["contract"]["request"];
type Workflow = Workspace["groups"][number]["projects"][number]["workflows"][number];

const runsPath = (name: string) => join(dataRoot, name);

function testCase(
  id: string,
  name: string,
  assertions: ApiCase["assertions"],
  options: Partial<Pick<ApiCase, "parameters" | "dataDriver" | "preOperations" | "postOperations">> = {},
): ApiCase {
  return { id, name, scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions, ...options };
}

function httpApi(
  id: string,
  name: string,
  path: string,
  cases: ApiCase[],
  options: { method?: "GET" | "POST"; body?: { kind: "none" } | { kind: "json"; content: string }; documentation?: string } = {},
): Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number] {
  const request: ApiRequest = {
    protocol: "http",
    method: options.method ?? "GET",
    baseUrl: "{{baseUrl}}",
    path,
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
    body: options.body ?? { kind: "none" },
  };
  return {
    contract: {
      formatVersion: 1,
      id,
      metadata: { name, description: "", tags: [], version: "1", status: "published" },
      request,
      responses: [],
    },
    documentation: options.documentation ?? "",
    cases,
  };
}

async function saveWorkspace(workspace: Workspace): Promise<void> {
  const current = await fileStorage.load(root);
  await fileStorage.save(root, workspace, { expectedRevision: current.revision, deletions: [] });
}

async function saveWorkflow(workflow: Workflow, groupId = GROUP_A, projectId = PROJECT_A): Promise<void> {
  const state = await fileStorage.load(root);
  const group = state.workspace.groups.find((candidate) => candidate.id === groupId);
  const project = group?.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Workflow project not found: ${groupId}/${projectId}`);
  const index = project.workflows.findIndex((candidate) => candidate.id === workflow.id);
  if (index < 0) project.workflows.push(workflow);
  else project.workflows[index] = workflow;
  await fileStorage.save(root, state.workspace, { expectedRevision: state.revision, deletions: [] });
}

function runCliProcess(args: string[], options: { cwd?: string; freezeNow?: boolean } = {}): Promise<{ code: number; output: string }> {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
  const privateHome = mkdtempSync(join(tmpdir(), "apicc-e2e-cli-home-"));
  const env = { ...process.env, HOME: privateHome, USERPROFILE: privateHome, APPDATA: join(privateHome, "Roaming"), LOCALAPPDATA: join(privateHome, "Local"), XDG_CONFIG_HOME: join(privateHome, "config") };
  if (options.freezeNow) {
    const preload = join(dirname(fileURLToPath(import.meta.url)), "freeze-date-now.cjs");
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "--no-plugins", ...args], { cwd: options.cwd ?? root, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("close", (code) => {
      rmSync(privateHome, { recursive: true, force: true });
      resolve({ code: code ?? 1, output });
    });
  });
}

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
  networkPrivateRoot = mkdtempSync(join(tmpdir(), "apicc-e2e-network-private-"));
  dataRoot = mkdtempSync(join(tmpdir(), "apicc-e2e-data-"));
  credibilityCsv = join(dataRoot, "credibility.csv");
  const ws: Workspace = {
    formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", name: "e2e", variables: {},
    groups: [{
      id: GROUP_A, name: "demo", projects: [{
        id: PROJECT_A, name: "svc", variables: {}, globals: {},
        stressPolicy: { trustedOrigins: [baseUrl], deniedOrigins: [] },
        workflows: [], models: [], components: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000006", name: "dev", variables: { baseUrl }, baseUrls: {} }],
        collections: [{
          id: COLLECTION_API, name: "api", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [
            httpApi(API_OK, "ok", "/x", [testCase(CASE_OK, "passes", [{ id: "as", target: "status", op: "eq", expected: "200" }])], { documentation: "# 设计" }),
            httpApi(API_BAD, "bad", "/x", [testCase(CASE_BAD, "fails", [{ id: "as", target: "status", op: "eq", expected: "500" }])]),
          ],
        }, {
          id: COLLECTION_XAPI, name: "xapi", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [httpApi(API_XOK, "xok", "/x", [testCase(CASE_XOK, "passes", [{ id: "as", target: "status", op: "eq", expected: "200" }])])],
        }, {
          id: COLLECTION_CREDIBILITY, name: "credibility", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [httpApi(API_RICH, "rich", "/credibility/{{parameterItem}}/{{rowItem}}", [testCase(CASE_RICH, "rich-case", [
            { id: "rich-status", target: "status", op: "eq", expected: "200" },
            { id: "rich-body", target: "bodyJson", op: "eq", path: "$.ok", expected: "true" },
          ], {
            parameters: { parameterItem: "parameter-item", parameterPayload: "parameter-payload", parameterHeader: "from-script-parameter" },
            dataDriver: { sourcePath: credibilityCsv, format: "csv" },
            preOperations: [
              { id: "rich-pre-script", type: "script", content: 'pm.request.headers["X-Pre-Script"] = pm.variables.get("parameterHeader") ?? "";' },
              { id: "rich-pre", type: "script", content: 'pm.request.headers["X-Pre-Operation"] = pm.variables.get("rowHeader") ?? ""; pm.request.url += "?marker=" + (pm.variables.get("rowMarker") ?? "");' },
            ],
            postOperations: [
              { id: "rich-post", type: "script", content: 'pm.assert(pm.response.status === 200, "post operation: status");' },
              { id: "rich-post-script", type: "script", content: 'pm.assert(pm.response.text().includes("\\"ok\\":true"), "post script: body");' },
            ],
          })], { method: "POST", body: { kind: "json", content: '{"parameterPayload":"{{parameterPayload}}","rowPayload":"{{rowPayload}}"}' } })],
        }],
      }],
    }, {
      id: GROUP_B, name: "demo2", projects: [{
        id: PROJECT_B, name: "svc", variables: {}, globals: {},
        workflows: [], models: [], components: [], stressPolicy: { trustedOrigins: [baseUrl], deniedOrigins: [] },
        environments: [{ id: "00000000-0000-4000-8000-000000000007", name: "dev", variables: { baseUrl }, baseUrls: {} }],
        collections: [{
          id: COLLECTION_B, name: "api", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [httpApi(API_OK2, "ok2", "/x", [testCase(CASE_OK2, "passes", [{ id: "as", target: "status", op: "eq", expected: "200" }])])],
        }],
      }],
    }],
  };
  writeFileSync(credibilityCsv, "rowItem,rowPayload,rowMarker,rowHeader\nrow-item,row-payload,row-marker,from-operation-row\n");
  const initial = await fileStorage.load(root);
  await fileStorage.save(root, ws, { expectedRevision: initial.revision, deletions: [] });
  // 注：CLI 的 run/export-design 按“从 cwd 向上查找 apicc.workspace.yaml”定位工作区；
  // 临时工作区无法从测试 cwd 上溯可达，故模拟真实用户“在工作区内执行 CLI”（用后还原）。
  prevCwd = process.cwd();
  process.chdir(root);
});
afterAll(() => {
  process.chdir(prevCwd);
  if (networkPrivateRoot) rmSync(networkPrivateRoot, { recursive: true, force: true });
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  return new Promise<void>((r) => server.close(() => r()));
});

describe("CLI 端到端", () => {
  it("validate 正常工作区退出码 0", async () => {
    const code = await runCli(["validate", root], createDefaultRegistry());
    expect(code).toBe(0);
  });

  it("run 执行集合并产出报告，失败用例使退出码为 1", async () => {
    const runsDir = runsPath("runs");
    const code = await runCli(
      ["run", collectionPath(GROUP_A, PROJECT_A, COLLECTION_API), "--env", "dev", "--reporters", "html,junit", "--runs-dir", runsDir],
      createDefaultRegistry(),
    );
    expect(code).toBe(1);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(runsDir).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("run 完整 UUID 路径精确定位，不误匹配同名集合或另一 collection", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["run", collectionPath(GROUP_A, PROJECT_A, COLLECTION_API), "--env", "dev", "--reporters", "html"],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(1);
    // 仅指定 UUID 集合（2 用例：1 过 1 败）应被运行；xapi 与 demo2 下同名 api 均 1 用例全过。
    expect(logs.join("\n")).toContain("总计 2 · 通过 1 · 失败 1");
  });

  it("export-design 输出 Markdown 到 stdout", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["export-design", apiPath(GROUP_A, PROJECT_A, COLLECTION_API, API_OK)],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("# 设计");
  });

  it("run 未指定 --runs-dir 时产物默认写入 <workspaceRoot>/.apicc/runs，数据树零污染（回归 I1）", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["run", collectionPath(GROUP_A, PROJECT_A, COLLECTION_XAPI), "--env", "dev", "--reporters", "html,junit"],
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
    const sampleRoot = mkdtempSync(join(tmpdir(), "apicc-e2e-import-source-"));
    const importRoot = mkdtempSync(join(tmpdir(), "apicc-e2e-import-workspace-"));
    const sample = join(sampleRoot, "openapi-sample.yaml");
    try {
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
      // Import has its own workspace and child-process cwd: a timed-out import cannot hold the shared workflow fixture read-only.
      const base = await fileStorage.load(root);
      const empty = await fileStorage.load(importRoot);
      await fileStorage.save(importRoot, base.workspace, { expectedRevision: empty.revision, deletions: [] });

      const firstImport = await runCliProcess(["import", sample, "--group", "imported", "--yes"], { cwd: importRoot });
      expect(firstImport.code).toBe(0);
      expect(firstImport.output).toContain("已导入项目「宠物样例」到分组「imported」");
      // 重开独立工作区断言项目存在（分组不存在时由 import 创建；含导入集合与接口）。
      const { workspace, readOnly, problems, revision } = await fileStorage.load(importRoot);
      expect(readOnly).toBe(false);
      expect(problems).toEqual([]);
      const group = workspace.groups.find((g) => g.name === "imported");
      expect(group).toBeDefined();
      const project = group!.projects.find((p) => p.name === "宠物样例");
      expect(project).toBeDefined();
      expect(project!.collections[0]!.apis.map((asset) => asset.contract.metadata.name)).toContain("listPets");

      // 重复导入同名项目：同名放开（轨一）后并存，不再拒绝——两个同名项目 id 不同。
      const secondImport = await runCliProcess(["import", sample, "--group", "imported", "--yes"], { cwd: importRoot });
      expect(secondImport.code).toBe(0);
      const { workspace: ws2, readOnly: secondReadOnly, problems: secondProblems, revision: secondRevision } = await fileStorage.load(importRoot);
      expect(secondReadOnly).toBe(false);
      expect(secondProblems).toEqual([]);
      const same = ws2.groups.find((g) => g.name === "imported")!.projects.filter((p) => p.name === "宠物样例");
      expect(same).toHaveLength(2);
      expect(same[0]!.id).not.toBe(same[1]!.id);
      await expect(fileStorage.save(importRoot, ws2, { expectedRevision: secondRevision, deletions: [] })).resolves.toBeDefined();
    } finally {
      rmSync(importRoot, { recursive: true, force: true });
      rmSync(sampleRoot, { recursive: true, force: true });
    }
  });

  it("import 不带 --yes 只打印预览不写入工作区", async () => {
    const { writeFileSync } = await import("node:fs");
    const sample = join(dataRoot, "preview-sample.yaml");
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
    const sample = join(dataRoot, "unknown-format.txt");
    writeFileSync(sample, "既不是 OpenAPI 也不是 v2.1 集合的普通文本");
    await expect(runCli(["import", sample, "--group", "g"], createDefaultRegistry())).rejects.toThrow(/无法识别的导入格式/);
  });

  it("run-workflow 按条件流转执行并产出报告", async () => {
    // 三节点条件工作流 one --prev.passed--> two --false--> three；workflow 属于 project 元数据。
    await saveWorkflow({
      id: "00000000-0000-4000-8000-000000000019", name: "条件流", status: "enabled",
      nodes: [
        { id: "one", kind: "request", apiId: API_OK, caseId: CASE_OK, label: "one" },
        { id: "two", kind: "request", apiId: API_XOK, caseId: CASE_XOK, label: "two" },
        { id: "three", kind: "request", apiId: API_BAD, caseId: CASE_BAD, label: "three" },
      ],
      edges: [
        { id: "e1", from: "one", to: "two", condition: "prev.passed" },
        { id: "e2", from: "two", to: "three", condition: "false" },
      ],
    });
    const { readdirSync, readFileSync } = await import("node:fs");
    const logs: string[] = [];
    const code = await runCli(
      ["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000019"), "--env", "dev", "--reporters", "junit"],
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
    await saveWorkflow({
      id: "00000000-0000-4000-8000-000000000020", name: "草稿流", status: "draft",
      nodes: [{ id: "only", kind: "request", apiId: API_OK, caseId: CASE_OK, label: "only" }], edges: [],
    });
    await expect(
      runCli(["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000020"), "--env", "dev"], createDefaultRegistry()),
    ).rejects.toThrow(/工作流为草稿，请先发布启用或加 --force-draft/);
    const code = await runCli(
      ["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000020"), "--env", "dev", "--force-draft"],
      createDefaultRegistry(),
    );
    expect(code).toBe(0);
    await expect(
      runCli(["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000099"), "--env", "dev"], createDefaultRegistry()),
    ).rejects.toThrow(/未找到工作流/);
  });

  it("run-workflow 缺引用默认严格失败；--no-strict 继续独立节点但仍失败", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const wfId = "00000000-0000-4000-8000-000000000024";
    await saveWorkflow({
      id: wfId, name: "严格诊断流", status: "enabled",
      nodes: [
        { id: "missing", kind: "request", apiId: "ghost-api", caseId: "ghost-case", label: "missing" },
        { id: "independent", kind: "request", apiId: API_OK, caseId: CASE_OK, label: "independent" },
      ],
      edges: [{ id: "hide-missing", from: "independent", to: "missing", condition: "false" }],
    });
    const strictDir = runsPath("strict-runs");
    const strictRequestsBefore = receivedRequests.length;
    const strict = await runCliProcess([
      "run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000024"), "--env", "dev", "--runs-dir", strictDir,
    ]);
    expect(strict.code).toBe(1);
    expect(receivedRequests).toHaveLength(strictRequestsBefore);
    const strictRaw = readdirSync(strictDir).find((name) => name.startsWith("workflow-") && name.endsWith(".json"))!;
    const strictReport = JSON.parse(readFileSync(join(strictDir, strictRaw), "utf8")) as { nodeResults: Array<{ nodeId: string; state: string; outcomes?: unknown[] }>; verdict?: string };
    expect(strictReport.verdict).toBe("failed");
    expect(strictReport.nodeResults.find((node) => node.nodeId === "missing")).toMatchObject({ state: "failed" });
    expect(strictReport.nodeResults.find((node) => node.nodeId === "independent")).toMatchObject({ state: "skipped" });
    expect(strictReport.nodeResults.find((node) => node.nodeId === "independent")?.outcomes).toBeUndefined();
    const relaxedDir = runsPath("relaxed-runs");
    const relaxed = await runCliProcess([
      "run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000024"), "--env", "dev", "--no-strict", "--reporters", "junit", "--runs-dir", relaxedDir,
    ]);
    expect(relaxed.code).toBe(1);
    expect(relaxed.output).toContain("节点统计");
    const relaxedRaw = readdirSync(relaxedDir).find((name) => name.startsWith("workflow-") && name.endsWith(".json"))!;
    const relaxedReport = JSON.parse(readFileSync(join(relaxedDir, relaxedRaw), "utf8")) as {
      verdict?: string; failed: number; warnings: string[];
      nodeResults: Array<{ nodeId: string; state: string; failureKind?: string; outcomes?: Array<{ failureKind?: string; passed: boolean }> }>;
    };
    expect(relaxedReport.verdict).toBe("failed");
    expect(relaxedReport.failed).toBe(1);
    expect(relaxedReport.nodeResults.find((node) => node.nodeId === "missing")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(relaxedReport.nodeResults.find((node) => node.nodeId === "missing")?.outcomes?.[0]).toMatchObject({ passed: false, failureKind: "config" });
    expect(relaxedReport.warnings.some((warning) => /不存在/.test(warning))).toBe(true);
    const parallelDir = runsPath("parallel-relaxed-runs");
    const [relaxedAgain, relaxedConcurrent] = await Promise.all([
      runCliProcess([
        "run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000024"), "--env", "dev", "--no-strict", "--reporters", "junit", "--runs-dir", parallelDir,
      ]),
      runCliProcess([
        "run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000024"), "--env", "dev", "--no-strict", "--reporters", "junit", "--runs-dir", parallelDir,
      ]),
    ]);
    expect(relaxedAgain.code).toBe(1);
    expect(relaxedConcurrent.code).toBe(1);
    const raws = readdirSync(parallelDir).filter((name) => name.startsWith("workflow-") && name.endsWith(".json"));
    expect(raws).toHaveLength(2);
    expect(new Set(raws).size).toBe(2);
    const reports = raws.map((name) => JSON.parse(readFileSync(join(parallelDir, name), "utf8")) as { workflowId: string; nodeResults: Array<{ nodeId: string; state: string }>; verdict?: string });
    expect(reports.every((report) => report.workflowId === wfId)).toBe(true);
    expect(reports.every((report) => report.verdict === "failed")).toBe(true);
    expect(reports.every((report) => report.nodeResults.find((node) => node.nodeId === "missing")?.state === "failed")).toBe(true);
    expect(reports.every((report) => report.nodeResults.find((node) => node.nodeId === "independent")?.state === "passed")).toBe(true);
  }, 30000);

  it("run-workflow 消费 verdict：false 通过、第二行失败、坏条件失败、force-draft 不绕过 strict，报告三态一致", async () => {
    const { readdirSync, readFileSync, existsSync } = await import("node:fs");
    const writeWorkflow = (id: string, name: string, status: Workflow["status"], nodes: Workflow["nodes"], edges: Workflow["edges"] = []) =>
      saveWorkflow({ id, name, status, nodes, edges });
    const noop = (id: string, label: string): Workflow["nodes"][number] => ({ id, kind: "noop", label });
    await writeWorkflow("00000000-0000-4000-8000-000000000025", "条件通过流", "enabled", [
      noop("start", "start"), noop("pruned", "pruned"),
    ], [{ id: "false-edge", from: "start", to: "pruned", condition: "false" }]);
    await writeWorkflow("00000000-0000-4000-8000-000000000026", "第二行失败流", "enabled", [
      { id: "first", kind: "request", apiId: API_OK, caseId: CASE_OK, label: "first" },
      { id: "second", kind: "request", apiId: API_BAD, caseId: CASE_BAD, label: "second" },
    ], [{ id: "next", from: "first", to: "second" }]);
    await writeWorkflow("00000000-0000-4000-8000-000000000027", "坏条件流", "enabled", [
      noop("condition-source", "condition-source"), noop("condition-target", "condition-target"),
    ], [{ id: "bad-condition", from: "condition-source", to: "condition-target", condition: "missingConditionValue" }]);
    await writeWorkflow("00000000-0000-4000-8000-000000000028", "草稿严格流", "draft", [
      { id: "missing", kind: "request", apiId: "ghost-api", caseId: "ghost-case", label: "missing" },
      { id: "independent", kind: "request", apiId: API_OK, caseId: CASE_OK, label: "independent" },
    ]);

    const falseDir = runsPath("false-runs");
    const falseRun = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000025"), "--reporters", "html,junit", "--runs-dir", falseDir]);
    expect(falseRun.code).toBe(0);
    const falseRaw = readdirSync(falseDir).find((file) => file.startsWith("workflow-") && file.endsWith(".json"))!;
    const falseResult = JSON.parse(readFileSync(join(falseDir, falseRaw), "utf8")) as { verdict?: string; total?: number; passed?: number; failed?: number; skipped?: number; nodeResults: Array<{ nodeId?: string; state: string; skipReason?: string }> };
    expect(falseResult.verdict).toBe("passed");
    expect(falseResult).toMatchObject({ total: 2, passed: 1, failed: 0, skipped: 1 });
    expect(falseResult.nodeResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "start", state: "noop" }),
      expect.objectContaining({ nodeId: "pruned", state: "skipped", skipReason: "condition-pruned" }),
    ]));
    const falseAdapted = workflowToRunResult(falseResult as never);
    expect(falseAdapted).toMatchObject({ total: 2, passed: 1, failed: 0, skipped: 1 });
    expect(falseAdapted.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "start", passed: true }),
      expect.objectContaining({ nodeId: "pruned", skipped: true, skipReason: "condition-pruned" }),
    ]));
    const falseHtml = readFileSync(join(falseDir, readdirSync(falseDir).find((file) => file.endsWith(".html"))!), "utf8");
    expect(falseHtml).toMatch(/总计 2 · 通过 1 · 失败 0 · 跳过 1/);
    expect((falseHtml.match(/<tr class="pass">/g) ?? [])).toHaveLength(1);
    expect((falseHtml.match(/<tr class="skip">/g) ?? [])).toHaveLength(1);
    const falseXml = readFileSync(join(falseDir, readdirSync(falseDir).find((file) => file.endsWith(".xml"))!), "utf8");
    expect(falseXml).toMatch(/<testsuites tests="2" failures="0" skipped="1">/);
    expect(falseXml).toMatch(/<testsuite name="条件通过流" tests="2" failures="0" skipped="1">/);
    expect(falseXml).toMatch(/<testcase name="pruned:[^"]+"[\s\S]*<skipped message="condition-pruned"\/>/);
    expect(falseXml).not.toContain("<failure ");

    const failedDir = runsPath("second-fails-runs");
    const failedRun = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000026"), "--env", "dev", "--reporters", "html,junit", "--runs-dir", failedDir]);
    expect(failedRun.code).toBe(1);
    const failedRaw = readdirSync(failedDir).find((file) => file.startsWith("workflow-") && file.endsWith(".json"))!;
    const failedResult = JSON.parse(readFileSync(join(failedDir, failedRaw), "utf8")) as { verdict?: string; total?: number; passed?: number; failed?: number; skipped?: number; nodeResults: Array<{ nodeId: string; state: string; outcomes?: Array<{ passed: boolean }> }> };
    expect(failedResult.verdict).toBe("failed");
    expect(failedResult).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(failedResult.nodeResults.find((node) => node.nodeId === "first")?.state).toBe("passed");
    expect(failedResult.nodeResults.find((node) => node.nodeId === "second")?.state).toBe("failed");
    const failedAdapted = workflowToRunResult(failedResult as never);
    expect(failedAdapted).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(failedAdapted.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "first", passed: true }),
      expect.objectContaining({ nodeId: "second", passed: false }),
    ]));
    const failedHtml = readFileSync(join(failedDir, readdirSync(failedDir).find((file) => file.endsWith(".html"))!), "utf8");
    const failedJunit = readFileSync(join(failedDir, readdirSync(failedDir).find((file) => file.endsWith(".xml"))!), "utf8");
    expect(failedHtml).toMatch(/总计 2 · 通过 1 · 失败 1 · 跳过 0/);
    expect((failedHtml.match(/<tr class="pass">/g) ?? [])).toHaveLength(1);
    expect((failedHtml.match(/<tr class="fail">/g) ?? [])).toHaveLength(1);
    expect(failedJunit).toMatch(/<testsuites tests="2" failures="1" skipped="0">/);
    expect(failedJunit).toMatch(/<testsuite name="第二行失败流" tests="2" failures="1" skipped="0">/);
    expect(failedJunit).toMatch(/<testcase name="second:[^"]+"[\s\S]*<failure message="/);

    const badDir = runsPath("bad-condition-runs");
    const badCondition = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000027"), "--reporters", "html,junit", "--runs-dir", badDir]);
    expect(badCondition.code).toBe(1);
    const badRaw = readdirSync(badDir).find((file) => file.startsWith("workflow-") && file.endsWith(".json"))!;
    const badResult = JSON.parse(readFileSync(join(badDir, badRaw), "utf8")) as { verdict?: string; total?: number; passed?: number; failed?: number; skipped?: number; nodeResults: Array<{ nodeId: string; state: string; failureKind?: string; skipReason?: string }> };
    expect(badResult.verdict).toBe("failed");
    expect(badResult).toMatchObject({ total: 2, passed: 0, failed: 1, skipped: 1 });
    expect(badResult.nodeResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "condition-source", state: "failed", failureKind: "script" }),
      expect.objectContaining({ nodeId: "condition-target", state: "skipped", skipReason: "upstream-failed" }),
    ]));
    const badAdapted = workflowToRunResult(badResult as never);
    expect(badAdapted).toMatchObject({ total: 2, passed: 0, failed: 1, skipped: 1 });
    expect(badAdapted.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "condition-source", passed: false, failureKind: "script" }),
      expect.objectContaining({ nodeId: "condition-target", skipped: true, skipReason: "upstream-failed" }),
    ]));
    const badHtml = readFileSync(join(badDir, readdirSync(badDir).find((file) => file.endsWith(".html"))!), "utf8");
    expect(badHtml).toMatch(/总计 2 · 通过 0 · 失败 1 · 跳过 1/);
    expect((badHtml.match(/<tr class="fail">/g) ?? [])).toHaveLength(1);
    expect((badHtml.match(/<tr class="skip">/g) ?? [])).toHaveLength(1);
    const badXml = readFileSync(join(badDir, readdirSync(badDir).find((file) => file.endsWith(".xml"))!), "utf8");
    expect(badXml).toMatch(/<testsuites tests="2" failures="1" skipped="1">/);
    expect(badXml).toMatch(/<testsuite name="坏条件流" tests="2" failures="1" skipped="1">/);
    const conditionSourceCase = badXml.match(/<testcase name="condition-source:[^"]+"[\s\S]*?<\/testcase>/)?.[0] ?? "";
    const conditionTargetCase = badXml.match(/<testcase name="condition-target:[^"]+"[\s\S]*?<\/testcase>/)?.[0] ?? "";
    expect(conditionSourceCase).not.toBe("");
    expect(conditionTargetCase).not.toBe("");
    expect(conditionSourceCase).toContain("<failure message=");
    expect(conditionTargetCase).toContain('<skipped message="upstream-failed"/>');
    const draftRequestsBefore = receivedRequests.length;
    const draft = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, "00000000-0000-4000-8000-000000000028"), "--force-draft", "--runs-dir", runsPath("draft-strict-runs")]);
    expect(draft.code).toBe(1);
    expect(receivedRequests).toHaveLength(draftRequestsBefore);
    const draftDir = runsPath("draft-strict-runs");
    if (!existsSync(draftDir)) throw new Error(`draft child output: ${draft.output}`);
    const draftRaw = readdirSync(draftDir).find((file) => file.startsWith("workflow-") && file.endsWith(".json"))!;
    const draftReport = JSON.parse(readFileSync(join(draftDir, draftRaw), "utf8")) as { verdict?: string; nodeResults: Array<{ nodeId: string; state: string; failureKind?: string; skipReason?: string; outcomes?: unknown[] }> };
    expect(draftReport.verdict).toBe("failed");
    expect(draftReport.nodeResults.find((node) => node.nodeId === "missing")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(draftReport.nodeResults.find((node) => node.nodeId === "independent")).toMatchObject({ state: "skipped", skipReason: "reference-invalid" });
    expect(draftReport.nodeResults.find((node) => node.nodeId === "independent")?.outcomes).toBeUndefined();
  }, 30000);

  it("run-workflow 数据驱动 JSON 保留第一行通过/第二行失败，CLI 与 HTML/JUnit 均按两行计数", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { workspace } = await fileStorage.load(root);
    const project = workspace.groups.find((group) => group.name === "demo")!.projects[0]!;
    const collection = project.collections[0]!;
    const source = collection.apis[0]!;
    const apiId = "00000000-0000-4000-8000-000000000034";
    const caseId = "00000000-0000-4000-8000-000000000035";
    const rowsPath = join(dataRoot, "workflow-rows.json");
    writeFileSync(rowsPath, JSON.stringify([{ expected: "200" }, { expected: "500" }]));
    collection.apis.push({
      ...source,
      contract: {
        ...source.contract,
        id: apiId,
        metadata: { ...source.contract.metadata, name: "数据行" },
        request: { ...source.contract.request, path: "/rows" },
      },
      cases: [{
      ...source.cases[0]!, id: caseId, name: "data-case", dataDriver: { sourcePath: rowsPath, format: "json" },
      assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }],
    }] });
    await saveWorkspace(workspace);
    const wfId = "00000000-0000-4000-8000-000000000036";
    await saveWorkflow({
      id: wfId, name: "数据行流", status: "enabled",
      nodes: [{ id: "data-row", kind: "request", apiId, caseId, label: "data-row" }], edges: [],
    });
    const runsDir = runsPath("data-row-runs");
    const run = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, wfId), "--env", "dev", "--reporters", "html,junit", "--runs-dir", runsDir]);
    expect(run.code).toBe(1);
    const rawFile = readdirSync(runsDir).find((file) => file.startsWith("workflow-") && file.endsWith(".json"))!;
    const report = JSON.parse(readFileSync(join(runsDir, rawFile), "utf8")) as { verdict?: string; nodeResults: Array<{ outcomes?: Array<{ row?: number; passed: boolean }> }> };
    expect(report.verdict).toBe("failed");
    expect(report.nodeResults[0]?.outcomes?.map((outcome) => ({ row: outcome.row, passed: outcome.passed }))).toEqual([{ row: 0, passed: true }, { row: 1, passed: false }]);
    const html = readFileSync(join(runsDir, readdirSync(runsDir).find((file) => file.endsWith(".html"))!), "utf8");
    expect(html).toMatch(/总计 2 · 通过 1 · 失败 1 · 跳过 0/);
    expect((html.match(/<tr class="pass">/g) ?? [])).toHaveLength(1);
    expect((html.match(/<tr class="fail">/g) ?? [])).toHaveLength(1);
    const xml = readFileSync(join(runsDir, readdirSync(runsDir).find((file) => file.endsWith(".xml"))!), "utf8");
    expect(xml).toMatch(/<testsuites tests="2" failures="1" skipped="0">/);
    expect(xml).toMatch(/<testsuite name="数据行流" tests="2" failures="1" skipped="0">/);
    const passCase = xml.match(/<testcase name="data-row:[^"]+#0"[\s\S]*?<\/testcase>/)?.[0];
    const failCase = xml.match(/<testcase name="data-row:[^"]+#1"[\s\S]*?<\/testcase>/)?.[0];
    expect(passCase).toBeDefined();
    expect(failCase).toBeDefined();
    expect(passCase).not.toContain("<failure ");
    expect(failCase).toContain("<failure ");
  }, 30000);

  it("run-workflow 固定同毫秒时不同 workflowName 仍写入两个可归属 JSON", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const wfId = "00000000-0000-4000-8000-000000000037";
    const writeNamedWorkflow = (name: string) => saveWorkflow({
      id: wfId, name, status: "enabled", nodes: [{ id: "marker-a", kind: "noop", label: "marker-a" }], edges: [],
    });
    await writeNamedWorkflow("碰撞甲");
    const runsDir = runsPath("collision-runs");
    const first = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, wfId), "--runs-dir", runsDir], { freezeNow: true });
    expect(first.code).toBe(0);
    await writeNamedWorkflow("碰撞乙");
    const second = await runCliProcess(["run-workflow", workflowPath(GROUP_A, PROJECT_A, wfId), "--runs-dir", runsDir], { freezeNow: true });
    expect(second.code).toBe(0);
    const files = readdirSync(runsDir).filter((file) => file.startsWith("workflow-") && file.endsWith(".json"));
    expect(files).toHaveLength(2);
    expect(files.every((file) => new RegExp(`^workflow-${wfId}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$`).test(file))).toBe(true);
    expect(new Set(files.map((file) => file.slice("workflow-".length, -".json".length))).size).toBe(2);
    const reports = files.map((file) => JSON.parse(readFileSync(join(runsDir, file), "utf8")) as { workflowId: string; workflowName: string; startedAt: string });
    expect(reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowId: wfId, workflowName: "碰撞甲" }),
      expect.objectContaining({ workflowId: wfId, workflowName: "碰撞乙" }),
    ]));
    const firstReport = reports.find((report) => report.workflowName === "碰撞甲")!;
    const secondReport = reports.find((report) => report.workflowName === "碰撞乙")!;
    expect(secondReport.startedAt).toBe(firstReport.startedAt);
  }, 30000);

  it("run-workflow 通过项目作用域递归查找同 ID API，保留两层 folder 与环境 baseUrl", async () => {
    const { workspace } = await fileStorage.load(root);
    const demo = workspace.groups.find((group) => group.name === "demo")!;
    const demo2 = workspace.groups.find((group) => group.name === "demo2")!;
    const sourceApi = demo.projects[0]!.collections[0]!.apis[0]!;
    const project = demo2.projects[0]!;
    const collection = project.collections[0]!;
    const nestedApi = {
      ...sourceApi,
      contract: {
        ...sourceApi.contract,
        metadata: { ...sourceApi.contract.metadata, name: "project-two" },
        request: { ...sourceApi.contract.request, path: "/project-two" },
      },
      cases: sourceApi.cases.map((testCase) => ({ ...testCase })),
    };
    collection.variables = {};
    project.environments[0]!.baseUrls = { [collection.id]: `${baseUrl}/module-base` };
    collection.folders = [{
      id: "00000000-0000-4000-8000-000000000031", name: "outer", preOperations: [], postOperations: [], apis: [], folders: [{
        id: "00000000-0000-4000-8000-000000000032", name: "inner", preOperations: [], postOperations: [], apis: [nestedApi], folders: [],
      }],
    }];
    await saveWorkspace(workspace);
    const wfId = "00000000-0000-4000-8000-000000000033";
    const { readFileSync, readdirSync } = await import("node:fs");
    await saveWorkflow({
      id: wfId, name: "项目作用域流", status: "enabled",
      nodes: [{ id: "nested-request", kind: "request", apiId: sourceApi.contract.id, caseId: sourceApi.cases[0]!.id, label: "nested-request" }], edges: [],
    }, GROUP_B, PROJECT_B);
    const runsDir = runsPath("project-scope-runs");
    const run = await runCliProcess(["run-workflow", workflowPath(GROUP_B, PROJECT_B, wfId), "--env", "dev", "--runs-dir", runsDir]);
    expect(run.code).toBe(0);
    expect(receivedPaths).toContain("/module-base/project-two");
    const raw = readdirSync(runsDir).find((name) => name.startsWith("workflow-") && name.endsWith(".json"))!;
    const report = JSON.parse(readFileSync(join(runsDir, raw), "utf8")) as { verdict?: string; nodeResults: Array<{ state: string; outcomes?: Array<{ passed: boolean }> }> };
    expect(report.verdict).toBe("passed");
    expect(report.nodeResults[0]?.outcomes?.[0]?.passed).toBe(true);
  }, 30000);

  it("run-stress 对接口用例并发压测并落盘 JSON", async () => {
    // 夹具：既有临时工作区 + 本地 server（复用文件内既有 beforeAll 资源）。
    const runsDir = runsPath("stress-runs");
    const logs: string[] = [];
    const code = await runCli(
      [
        "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_API, API_OK),
        "--case", CASE_OK, "--env", "dev", "--concurrency", "4", "--iterations", "12",
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
    await saveWorkspace(workspace);
    const runsDir = runsPath("stress-unconfirmed");
    const logs: string[] = [];
    const code = await runCli([
      "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_API, API_OK), "--case", CASE_OK,
      "--env", "dev", "--concurrency", "1", "--iterations", "1", "--runs-dir", runsDir,
    ], createDefaultRegistry(), (line) => logs.push(line));
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("target_confirmation_required");
    expect(logs.join("\n")).toContain(baseUrl);
    const { readdirSync, readFileSync } = await import("node:fs");
    const file = readdirSync(runsDir).find((name) => name.endsWith(".json"))!;
    const report = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as {
      totalRequests: number; safety?: { targetOrigins: Array<{ origin: string; loopback?: boolean; confirmation: string; appliedPolicy?: { trustedOrigins?: string[]; deniedOrigins?: string[] } }> };
    };
    expect(report.totalRequests).toBe(1);
    expect(report.safety?.targetOrigins).toEqual([{ origin: baseUrl, confirmation: "rejected", policy: "target_confirmation_required", loopback: true, appliedPolicy: { trustedOrigins: [], deniedOrigins: [] } }]);
    project.stressPolicy = { trustedOrigins: [baseUrl] };
    await saveWorkspace(workspace);
  }, 30000);

  it("run-stress 精确 allow-target 放行，HTTP 200 但断言失败仍以 verdict 失败退出", async () => {
    const runsDir = runsPath("stress-assertion");
    const logs: string[] = [];
    const code = await runCli([
      "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_API, API_BAD), "--case", CASE_BAD,
      "--env", "dev", "--concurrency", "1", "--iterations", "1", "--allow-target", baseUrl, "--runs-dir", runsDir,
    ], createDefaultRegistry(), (line) => logs.push(line));
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("verdict: failed");
    expect(logs.join("\n")).toContain("失败分类: assertion=1");
    expect(logs.join("\n")).toContain("target origins");
  }, 30000);

  it("混合 target confirmation rejection 与成功请求时 CLI 仍 exit 1", async () => {
    const { workspace } = await fileStorage.load(root);
    const project = workspace.groups[0]!.projects.find((candidate) => candidate.name === "svc")!;
    const api = project.collections.find((collection) => collection.name === "credibility")!.apis[0]!;
    const testCase = api.cases[0]!;
    const originalPreOperations = testCase.preOperations;
    const runsDir = runsPath("stress-mixed-safety");
    const before = receivedRequests.length;
    testCase.preOperations = [{ id: "safety-injection", type: "script", content: [
      'if (pm.variables.get("safetyOnce") !== "yes") {',
      '  pm.variables.set("safetyOnce", "yes");',
      '  pm.request.url = "http://127.0.0.1:1/blocked";',
      '}',
    ].join("\n") }, ...originalPreOperations];
    await saveWorkspace(workspace);
    try {
      const logs: string[] = [];
      const code = await runCli([
        "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_CREDIBILITY, API_RICH),
        "--case", CASE_RICH, "--env", "dev", "--concurrency", "1", "--iterations", "2",
        "--allow-target", baseUrl, "--runs-dir", runsDir,
      ], createDefaultRegistry(), (line) => logs.push(line));
      expect(code).toBe(1);
      expect(receivedRequests.length).toBe(before + 1);
      const { readdirSync, readFileSync } = await import("node:fs");
      const file = readdirSync(runsDir).find((name) => name.endsWith(".json"))!;
      const report = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as {
        totalRequests: number; ok: number; failed: number; failures: Record<string, number>;
        verdict?: { passed: boolean; violations: Array<{ metric: string; actual: number }> };
        safety?: { targetOrigins: Array<{ origin: string; confirmation: string }> };
      };
      expect(report).toMatchObject({ totalRequests: 2, ok: 1, failed: 1, failures: { config: 1 } });
      expect(report.verdict?.passed).toBe(false);
      expect(report.verdict?.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ metric: "businessFailures", actual: 1 }),
      ]));
      expect(report.safety?.targetOrigins).toEqual(expect.arrayContaining([
        expect.objectContaining({ origin: "http://127.0.0.1:1", confirmation: "rejected" }),
        expect.objectContaining({ origin: baseUrl, confirmation: expect.any(String) }),
      ]));
      expect(logs.join("\n")).toContain("verdict: failed");
    } finally {
      testCase.preOperations = originalPreOperations;
      await saveWorkspace(workspace);
    }
  }, 30000);

  it("混合 pre-script failure 与成功请求时 CLI 仍 exit 1", async () => {
    const { workspace } = await fileStorage.load(root);
    const project = workspace.groups[0]!.projects.find((candidate) => candidate.name === "svc")!;
    const api = project.collections.find((collection) => collection.name === "credibility")!.apis[0]!;
    const testCase = api.cases[0]!;
    const originalPreOperations = testCase.preOperations;
    const runsDir = runsPath("stress-mixed-script");
    const before = receivedRequests.length;
    testCase.preOperations = [{ id: "script-failure-injection", type: "script", content: [
      'if (pm.variables.get("scriptOnce") !== "yes") {',
      '  pm.variables.set("scriptOnce", "yes");',
      '  throw new Error("pre-script failed");',
      '}',
    ].join("\n") }, ...originalPreOperations];
    await saveWorkspace(workspace);
    try {
      const code = await runCli([
        "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_CREDIBILITY, API_RICH),
        "--case", CASE_RICH, "--env", "dev", "--concurrency", "1", "--iterations", "2",
        "--allow-target", baseUrl, "--runs-dir", runsDir,
      ], createDefaultRegistry());
      expect(code).toBe(1);
      expect(receivedRequests.length).toBe(before + 1);
      const { readdirSync, readFileSync } = await import("node:fs");
      const file = readdirSync(runsDir).find((name) => name.endsWith(".json"))!;
      const report = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as {
        totalRequests: number; ok: number; failed: number; failures: Record<string, number>;
        verdict?: { passed: boolean; violations: Array<{ metric: string; actual: number }> };
      };
      expect(report).toMatchObject({ totalRequests: 2, ok: 1, failed: 1, failures: { script: 1 } });
      expect(report.verdict?.passed).toBe(false);
      expect(report.verdict?.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ metric: "businessFailures", actual: 1 }),
      ]));
    } finally {
      testCase.preOperations = originalPreOperations;
      await saveWorkspace(workspace);
    }
  }, 30000);

  it.each(["https://example.com/path", "https://user:pass@example.com", "ftp://example.com"])(
    "run-stress 拒绝非 origin allow-target %s", async (origin) => {
      await expect(runCli([
        "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_API, API_OK), "--case", CASE_OK,
        "--env", "dev", "--concurrency", "1", "--iterations", "1", "--allow-target", origin,
      ], createDefaultRegistry(), () => {})).rejects.toThrow(/allow-target/);
    },
  );

  it("同一完整用例的集合运行与 concurrency=1/iterations=1 压测请求和结果一致", async () => {
    const normalizeRequest = (request: ObservedRequest) => ({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });
    const functionalDir = runsPath("stress-credibility-functional");
    const functionalBefore = receivedRequests.length;
    const functionalCode = await runCli([
      "run", collectionPath(GROUP_A, PROJECT_A, COLLECTION_CREDIBILITY), "--env", "dev", "--reporters", "html", "--runs-dir", functionalDir,
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
    expect(functionalObservedRequest).toEqual({
      method: "POST",
      url: "/credibility/parameter-item/row-item?marker=row-marker",
      headers: { "x-pre-script": "from-script-parameter", "x-pre-operation": "from-operation-row" },
      body: '{"parameterPayload":"parameter-payload","rowPayload":"row-payload"}',
    });

    const stressDir = runsPath("stress-credibility-stress");
    const stressBefore = receivedRequests.length;
    const stressLogs: string[] = [];
    const stressCode = await runCli([
      "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_CREDIBILITY, API_RICH),
      "--case", CASE_RICH, "--env", "dev", "--concurrency", "1", "--iterations", "1",
      "--allow-target", baseUrl, "--runs-dir", stressDir,
    ], createDefaultRegistry(), (line) => stressLogs.push(line));
    expect(stressCode).toBe(0);
    const stressFile = readdirSync(stressDir).find((name) => name.endsWith(".json"));
    expect(stressFile).toBeDefined();
    const stressReport = JSON.parse(readFileSync(join(stressDir, stressFile!), "utf8")) as {
      totalRequests: number; ok: number; failed: number; verdict?: { passed: boolean };
    };
    const stressObservedRequest = normalizeRequest(receivedRequests[stressBefore]!);
    expect(stressObservedRequest).toEqual({
      method: "POST",
      url: "/credibility/parameter-item/row-item?marker=row-marker",
      headers: { "x-pre-script": "from-script-parameter", "x-pre-operation": "from-operation-row" },
      body: '{"parameterPayload":"parameter-payload","rowPayload":"row-payload"}',
    });
    expect(stressReport.ok).toBe(functionalResult.passed ? 1 : 0);
    expect(stressReport.verdict?.passed).toBe(functionalResult.passed === 1);
    expect(stressReport).toMatchObject({ totalRequests: 1, failed: 0 });
    expect(stressLogs.join("\n")).toContain("verdict: passed");
    expect(functionalResult.cases?.[0]?.assertions).toEqual([
      { pass: true, message: "eq 断言通过: actual=200, expected=200" },
      { pass: true, message: "eq 断言通过: actual=true, expected=true" },
      { pass: true, message: "post operation: status" },
      { pass: true, message: "post script: body" },
    ]);
  }, 30000);

  it("目标确认只匹配精确 origin：path 可变、scheme/host/port 必须重确认，denylist 和阈值失败仍优先", async () => {
    const { workspace } = await fileStorage.load(root);
    const project = workspace.groups[0]!.projects[0]!;
    const api = project.collections.find((collection) => collection.name === "credibility")!.apis[0]!;
    const dataPath = credibilityCsv;
    const originalData = "rowItem,rowPayload,rowMarker,rowHeader\nrow-item,row-payload,row-marker,from-operation-row\n";
    const originalBaseUrl = api.contract.request.baseUrl;
    const originalPath = api.contract.request.path;
    const originalPolicy = project.stressPolicy;
    const originalEnvironments = project.environments;
    const runArgs = (env: string, runsDir: string, extra: string[] = []) => [
      "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_CREDIBILITY, API_RICH),
      "--case", CASE_RICH, "--env", env, "--concurrency", "1", "--iterations", "1",
      "--allow-target", baseUrl, "--runs-dir", runsDir, ...extra,
    ];
    try {
      writeFileSync(dataPath, "rowItem,rowPayload,rowMarker,rowHeader\nfirst,p1,first-marker,first-header\nsecond,p2,second-marker,second-header\n");
      project.stressPolicy = { trustedOrigins: [], deniedOrigins: [] };
      await saveWorkspace(workspace);
      const pathLogs: string[] = [];
      const pathBefore = receivedRequests.length;
      expect(await runCli([
        ...runArgs("dev", runsPath("stress-origin-path"), ["--iterations", "2"]),
      ], createDefaultRegistry(), (line) => pathLogs.push(line))).toBe(0);
      expect(receivedRequests.slice(pathBefore).map((request) => request.url)).toEqual([
        "/credibility/parameter-item/first?marker=first-marker", "/credibility/parameter-item/second?marker=second-marker",
      ]);
      expect(pathLogs.join("\n")).toContain(`target origins: ${baseUrl}`);

      const port = Number(new URL(baseUrl).port);
      for (const [label, targetUrl] of [
        ["scheme", `https://127.0.0.1:${port}/credibility/{{parameterItem}}/{{rowItem}}`],
        ["host", `http://localhost:${port}/credibility/{{parameterItem}}/{{rowItem}}`],
        ["port", `http://127.0.0.1:${port + 1}/credibility/{{parameterItem}}/{{rowItem}}`],
      ] as const) {
        const parsed = new URL(targetUrl);
        api.contract.request.baseUrl = `${parsed.protocol}//${parsed.host}`;
        api.contract.request.path = parsed.pathname;
        await saveWorkspace(workspace);
        const logs: string[] = [];
        const before = receivedRequests.length;
        expect(await runCli(runArgs("dev", runsPath(`stress-origin-${label}`)), createDefaultRegistry(), (line) => logs.push(line))).toBe(1);
        expect(receivedRequests.length).toBe(before);
        expect(logs.join("\n")).toContain("target_confirmation_required");
      }

      api.contract.request.baseUrl = originalBaseUrl;
      api.contract.request.path = originalPath;
      project.environments = [...originalEnvironments, { id: "00000000-0000-4000-8000-000000000024", name: "production", variables: { baseUrl }, baseUrls: {} }];
      await saveWorkspace(workspace);
      expect(await runCli(runArgs("production", runsPath("stress-origin-label")), createDefaultRegistry())).toBe(0);

      project.stressPolicy = { trustedOrigins: [], deniedOrigins: [baseUrl] };
      await saveWorkspace(workspace);
      const deniedLogs: string[] = [];
      const deniedBefore = receivedRequests.length;
      expect(await runCli(runArgs("dev", runsPath("stress-origin-denied")), createDefaultRegistry(), (line) => deniedLogs.push(line))).toBe(1);
      expect(receivedRequests.length).toBe(deniedBefore);
      expect(deniedLogs.join("\n")).toContain("target_denied");

      project.stressPolicy = { trustedOrigins: [baseUrl], deniedOrigins: [] };
      await saveWorkspace(workspace);
      const thresholdLogs: string[] = [];
      expect(await runCli(runArgs("dev", runsPath("stress-threshold"), ["--max-p95-ms", "0.0001"]), createDefaultRegistry(), (line) => thresholdLogs.push(line))).toBe(1);
      expect(thresholdLogs.join("\n")).toContain("[阈值失败]");
    } finally {
      writeFileSync(dataPath, originalData);
      api.contract.request.baseUrl = originalBaseUrl;
      api.contract.request.path = originalPath;
      project.environments = originalEnvironments;
      project.stressPolicy = originalPolicy;
      await saveWorkspace(workspace);
    }
  }, 30000);

  it("单机与本地多分片对同一 HTTP 200 断言失败保持分类和退出码一致", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const runArgs = (runsDir: string, extra: string[] = []) => [
      "run-stress", apiPath(GROUP_A, PROJECT_A, COLLECTION_API, API_BAD),
      "--case", CASE_BAD, "--env", "dev", "--concurrency", "2", "--iterations", "2",
      "--allow-target", baseUrl, "--runs-dir", runsDir, ...extra,
    ];
    const singleDir = runsPath("stress-consistency-single");
    const singleLogs: string[] = [];
    const singleCode = await runCli(runArgs(singleDir), createDefaultRegistry(), (line) => singleLogs.push(line));
    const singleFile = readdirSync(singleDir).find((name) => name.endsWith(".json"))!;
    const single = JSON.parse(readFileSync(join(singleDir, singleFile), "utf8")) as {
      totalRequests: number; ok: number; failed: number; failures: Record<string, number>; statusDist: Record<string, number>;
      latency: Record<string, number>; scriptLatency: Record<string, number>; iterationLatency: Record<string, number>;
      verdict?: { passed: boolean; violations: Array<{ metric: string; actual: number; expected: number }> };
    };

    const multiDir = runsPath("stress-consistency-multi");
    const multiLogs: string[] = [];
    const networkPrivateRoot = join(root, ".apicc-network-private");
    const spawnWorkerFactory = () => async (spec: {
      apiPath: string; caseId: string; envName?: string; concurrency: number; maxIterations?: number; durationMs?: number;
      maxRps?: number; maxErrorRate?: number; maxAssertionFailureRate?: number; maxP95Ms?: number; minRps?: number;
      connectionMode?: "pooled" | "fresh"; confirmedTargetOrigins?: string[]; shardId: string; workspaceRoot: string;
      definitionRevision: string; credentialVersions: Record<string, string>; networkIdentity: string;
    }): Promise<ShardOutcome> => {
      let wire = "";
      const code = await runCli([
        "stress-worker", spec.apiPath, "--case", spec.caseId, "--env", spec.envName!, "--concurrency", String(spec.concurrency),
        "--iterations", String(spec.maxIterations), "--shard-id", spec.shardId, "--workspace", spec.workspaceRoot,
        "--definition-revision", spec.definitionRevision, "--credential-versions", JSON.stringify(spec.credentialVersions),
        "--network-identity", spec.networkIdentity,
        "--allow-target", ...(spec.confirmedTargetOrigins ?? []),
      ], createDefaultRegistry(), () => {}, { workerOut: (line) => { wire = line; }, workerErr: () => {}, networkPrivateRoot });
      expect(code).toBe(0);
      const outcome = JSON.parse(wire) as ShardOutcome;
      if (outcome.ok) outcome.generator = { ...outcome.generator, saturated: true, reasons: ["cpu"] };
      return outcome;
    };
    const multiCode = await runCli(runArgs(multiDir, ["--shards", "2"]), createDefaultRegistry(), (line) => multiLogs.push(line), { spawnWorkerFactory, networkPrivateRoot });
    const multiFile = readdirSync(multiDir).find((name) => name.endsWith(".json"))!;
    const multi = JSON.parse(readFileSync(join(multiDir, multiFile), "utf8")) as {
      totalRequests: number; ok: number; failed: number; failures: Record<string, number>; statusDist: Record<string, number>;
      latency: Record<string, number>; scriptLatency: Record<string, number>; iterationLatency: Record<string, number>;
      verdict?: { passed: boolean; violations: Array<{ metric: string; actual: number; expected: number }> };
      distributed?: { dataComplete: boolean };
    };
    const expectedFailures = { transport: 0, http: 0, script: 0, assertion: 2, config: 0, aborted: 0 };
    const expectedStatusDist = { "200": 2 };
    for (const report of [single, multi]) {
      expect(report.totalRequests).toBe(2);
      expect(report.ok).toBe(0);
      expect(report.failed).toBe(2);
      expect(report.failures).toEqual(expectedFailures);
      expect(report.statusDist).toEqual(expectedStatusDist);
      for (const latency of [report.latency, report.scriptLatency, report.iterationLatency]) {
        expect(Object.values(latency).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
        expect(latency.min).toBeLessThanOrEqual(latency.avg);
        expect(latency.avg).toBeLessThanOrEqual(latency.max);
        expect(latency.min).toBeLessThanOrEqual(latency.p50);
        expect(latency.p50).toBeLessThanOrEqual(latency.p95);
        expect(latency.p95).toBeLessThanOrEqual(latency.max);
        // Both paths have exactly two samples: nearest-rank quantiles and avg
        // must therefore reflect a merge of both, while wall-clock values may differ.
        expect(latency.p50).toBe(latency.min);
        expect(latency.p90).toBe(latency.max);
        expect(latency.p95).toBe(latency.max);
        expect(latency.p99).toBe(latency.max);
        expect(latency.avg).toBeCloseTo((latency.min + latency.max) / 2, 8);
      }
      expect(report.verdict?.violations).toEqual(expect.arrayContaining([
        { metric: "businessFailures", actual: 2, expected: 0, message: "2 business request(s) failed" },
      ]));
      expect(report.verdict?.violations.some((violation) => violation.metric === "noData")).toBe(false);
    }
    expect(singleCode).toBe(1);
    expect(multiCode).toBe(singleCode);
    expect(multi.verdict?.passed).toBe(single.verdict?.passed);
    expect(multi.distributed?.dataComplete).toBe(true);
    expect(singleLogs.join("\n")).toContain("失败分类: assertion=");
    expect(multiLogs.join("\n")).toContain("失败分类: assertion=");
    expect(multiLogs.join("\n")).toContain("[警告] generator saturation");
  }, 30000);
});
