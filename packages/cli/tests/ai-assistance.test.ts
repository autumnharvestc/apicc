import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, renameSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { createAiConfigRepository, createDefaultAiConfigDocument, createDefaultRegistry, createProjectSnapshot, fileStorage, aiCredentialAudience, type AiConfigDocument, type AiSecretBackend, type Workspace } from "@apicc/core";
import { runCli, type RunCliDeps } from "../src/main.js";
import { readLocalAiReports } from "../src/ai/commands.js";
import { onlineFixture } from "./mcp-online.fixture.js";
import { createMcpSource } from "../src/mcp/source.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [workspaceId, groupId, projectId, collectionId, apiId, caseId] = [1, 2, 3, 4, 5, 6].map(id) as [string, string, string, string, string, string];
const projectPath = `groups/${groupId}/projects/${projectId}`;
const apiPath = `${projectPath}/collections/${collectionId}/apis/${apiId}`;
const wireAssertion = { target: "status", op: "eq", expected: "200", path: null, headerName: null, cookieName: null, namespaces: null, match: null, optionsJson: null };
const wireCase = { name: "AI candidate", scope: "base", parameters: [], preOperations: [], postOperations: [], assertions: [wireAssertion], reason: "契约", evidenceIds: [] };
const originalCwd = process.cwd();
afterEach(() => { process.chdir(originalCwd); vi.restoreAllMocks(); });

function digest(root: string): string {
  const files: string[] = [];
  const visit = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(path, entry.name); if (entry.isDirectory()) visit(full); else files.push(`${full.slice(root.length)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
  } };
  visit(root); return createHash("sha256").update(files.join("\n")).digest("hex");
}
async function fixture() {
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`CLI exit ${code}`); });
  const root = mkdtempSync(join(tmpdir(), "apicc-assistance-"));
  const home = mkdtempSync(join(tmpdir(), "apicc-assistance-home-"));
  const workspace: Workspace = { formatVersion: 1, id: workspaceId, name: "AI", variables: {}, groups: [{ id: groupId, name: "group", projects: [{
    id: projectId, name: "project", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, workflows: [], environments: [], models: [], components: [], stressPolicy: {},
    collections: [{ id: collectionId, name: "collection", variables: {}, preOperations: [], postOperations: [], folders: [], apis: [{
      contract: { formatVersion: 1, id: apiId, metadata: { name: "contract", description: "contract description", tags: [], version: "1", status: "published" },
        request: { protocol: "http", method: "GET", baseUrl: "https://business.example", path: "/orders", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "json", content: '{"private":"DEFAULT_BODY_SENTINEL"}' } }, responses: [{ kind: "inline", id: id(7), status: "200", description: "success", headers: {}, content: {} }] },
      documentation: "doc", cases: [{ id: caseId, name: "existing", scope: "base", parameters: {}, assertions: [], preOperations: [], postOperations: [] }],
    }] }],
  }] }] };
  const state = await fileStorage.load(root); await fileStorage.save(root, workspace, { expectedRevision: state.revision, deletions: [] });
  const repository = createAiConfigRepository({ privateRoot: join(home, ".apicc", "ai") });
  const document = createDefaultAiConfigDocument();
  document.connections = [{ id: "gateway", revision: 1, name: "Gateway", owner: { kind: "personal" }, baseUrl: "https://fixture.example/v1", auth: { kind: "bearer" }, headers: {}, protocols: ["openai-chat-completions", "openai-responses", "anthropic-messages"], credentialRef: "fixture-ref" }];
  document.models = (["openai-chat-completions", "openai-responses", "anthropic-messages"] as const).map((protocol, index) => ({ id: `profile-${index}`, revision: 1, connectionId: "gateway", modelId: `model-${index}`, protocol, structuredOutput: protocol === "anthropic-messages" ? "prompt-json" : "json-schema", streaming: false, supportedParameters: [], capabilities: { status: "unconfirmed", source: "fixture" }, budgets: { maxRequests: 1, repairAttempts: 0, transportRetries: 0 }, purposeBudgets: {} }));
  document.bindings = ["case-suggestion", "assertion-suggestion", "report-analysis"].map((purpose, index) => ({ purpose, modelProfileId: `profile-${index}`, budgets: {} })) as AiConfigDocument["bindings"];
  await repository.write(document, 1);
  const backend: AiSecretBackend = { availability: "available", async get(ref, audience) { return ref === "fixture-ref" && audience === aiCredentialAudience(document.connections[0]!) ? "SYNTHETIC_PRIVATE_KEY" : undefined; }, async put() { throw new Error("not used"); }, async remove() {} };
  const requests: Array<{ url: string; body: any; headers: Headers }> = [];
  let output: unknown = { cases: [wireCase] };
  const aiFetch: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init!.body as string), headers: new Headers(init!.headers) });
    const text = JSON.stringify(output);
    return Response.json(String(url).endsWith("/responses") ? { status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] }
      : String(url).endsWith("/messages") ? { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] }
      : { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] });
  };
  const logs: string[] = [];
  const deps: RunCliDeps = { aiHomeDir: home, aiEnv: {}, aiSecretBackend: backend, aiFetch, loadPlugins: false };
  process.chdir(root);
  const run = (args: string[], overrides: RunCliDeps = {}) => runCli(["ai", ...args], createDefaultRegistry(), line => logs.push(line), { ...deps, ...overrides });
  return { root, home, document, repository, requests, logs, deps, run, output(value: unknown) { output = value; }, snapshot: createProjectSnapshot(workspace.groups[0]!.projects[0]!) };
}
function savedReport(f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}, name = "run-existing.json", directory = join(f.root, ".apicc", "runs")) {
  mkdirSync(directory, { recursive: true });
  const report = { kind: "collection", projectId, definitionRevision: f.snapshot.definitionRevision,
    executionIdentity: { projectId, definitionRevision: f.snapshot.definitionRevision }, collectionId, collectionName: "existing report",
    startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 0, passed: 0, failed: 0, cases: [], ...patch };
  const path = join(directory, name); writeFileSync(path, JSON.stringify(report));
  return { path, reportId: `report:${createHash("sha256").update(name).digest("hex")}` };
}

describe("personal model selection and native assistance", () => {
  // Posterior checks for the three disclosed CLI branches; not historical RED
  // and not accepted until the user's pending ruling.
  it.each([
    ['invalid-basis', ['--basis', 'invented'], /依据须为/],
    ['missing-report', ['--basis', 'observation', '--case-index', '0'], /观察依据须明确/],
    ['missing-index', ['--basis', 'observation', '--report', 'selected'], /观察依据须明确/],
    ['negative-index', ['--basis', 'observation', '--report', 'selected', '--case-index', '-1'], /观察依据须明确/],
    ['fractional-index', ['--basis', 'observation', '--report', 'selected', '--case-index', '0.5'], /观察依据须明确/],
  ] as const)('final B pending CLI branch posterior validation %s', async (_kind, args, expected) => {
    const f = await fixture(), before = digest(f.root);
    await expect(f.run(['suggest-assertions', apiPath, '--case', caseId, '--scope', 'base', ...args])).rejects.toThrow(expected);
    expect(f.requests).toEqual([]); expect(digest(f.root)).toBe(before);
  });
  it('final B pending CLI branch posterior validation rejects a real owned non-case report', async () => {
    const f = await fixture(), path = join(f.root, '.apicc', 'runs'); mkdirSync(path, { recursive: true });
    const name = 'owned-stress.json', reportId = `report:${createHash('sha256').update(name).digest('hex')}`;
    writeFileSync(join(path, name), JSON.stringify({ projectId, definitionRevision: f.snapshot.definitionRevision, concurrency: 1, totalRequests: 0, ok: 0, failed: 0, durationMs: 1, rps: 0,
      latency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 }, statusDist: {}, errorKinds: {}, startedAt: 0, finishedAt: 1 }));
    expect(readLocalAiReports(f.root, projectId).find(item => item.reportId === reportId)?.report).toMatchObject({ concurrency: 1 });
    const before = digest(f.root);
    await expect(f.run(['suggest-assertions', apiPath, '--case', caseId, '--scope', 'base', '--basis', 'observation', '--report', reportId, '--case-index', '0'])).rejects.toThrow(/^evidence-unavailable$/);
    expect(f.requests).toEqual([]); expect(digest(f.root)).toBe(before);
  });
  it.each(['evidence', 'body'] as const)('final B CLI closed metadata catalog refuses selectable-overflow %s', async kind => {
    const f = await fixture(), target = { collectionId, folderIds: [], apiId, caseId, scope: 'base' };
    const report = savedReport(f, { total: 260, failed: 260, cases: Array.from({ length: 260 }, (_, row) => ({ apiId, apiName: 'API', caseId, caseName: 'saved', locator: target, row, passed: false, durationMs: 1, assertions: [],
      evidence: { identity: { projectId, definitionRevision: f.snapshot.definitionRevision, locator: target }, state: 'collected', truncated: false, scriptDiagnostics: 'not-collected',
        response: { status: 503, headers: { text: '', truncated: false }, body: { text: 'DEFAULT_OFF_CATALOG_BODY', truncated: false } } } })) });
    await expect(f.run(['analyze-report', projectPath, '--report', report.reportId, '--evidence', `${report.reportId}:e1`])).rejects.toThrow(/confirm-send/);
    const before = digest(f.root);
    const args = kind === 'evidence' ? ['--evidence', `${report.reportId}:e1040`] : ['--include-body', 'cases[259].evidence.response.body', '--evidence', `${report.reportId}:e1`];
    const outcome = await f.run(['analyze-report', projectPath, '--report', report.reportId, ...args]).then(value => ({ value }), error => ({ error: error as Error }));
    expect(outcome).toMatchObject({ error: { message: kind === 'evidence' ? 'evidence-selection-unavailable' : 'body-selection-unavailable' } });
    expect(f.requests).toEqual([]); expect(digest(f.root)).toBe(before);
  });
  it("final B I2 CLI previews a legal greater-than-128KiB input using its effective 256KiB budget", async () => {
    const f = await fixture(), state = await fileStorage.load(f.root);
    const api = state.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    api.documentation = "A".repeat(140 * 1024);
    await fileStorage.save(f.root, state.workspace, { expectedRevision: state.revision, deletions: [] });
    const before = digest(f.root);
    const error = await f.run(["suggest-cases", apiPath]).then(() => null, cause => cause as Error);
    expect.soft(error?.message).toMatch(/confirm-send/);
    expect.soft(f.logs.join("\n")).toContain("AI 外发范围预览");
    expect(f.requests).toEqual([]); expect(digest(f.root)).toBe(before);
  });
  it("final B I3 CLI uses a selected saved observation and exact case index without promoting 503 to contract", async () => {
    const f = await fixture(), target = { collectionId, folderIds: [], apiId, caseId, scope: "base" };
    const selected = savedReport(f, { total: 1, failed: 1, cases: [{ apiId, apiName: "api", caseId, caseName: "saved", locator: target, passed: false, durationMs: 1, assertions: [],
      evidence: { identity: { projectId, definitionRevision: f.snapshot.definitionRevision, locator: target }, state: "collected", scriptDiagnostics: "not-collected", truncated: false,
        response: { status: 503, headers: { text: "", truncated: false }, body: { text: "FINAL_B_DEFAULT_OFF_OBSERVATION_BODY", truncated: false } } } }] });
    f.output({ assertions: [{ assertion: { ...wireAssertion, expected: "503" }, basis: "observation", reason: "One selected observation", evidenceIds: [`${selected.reportId}:e6`], requiresUserJudgment: true }] });
    const before = digest(f.root);
    const result = await f.run(["suggest-assertions", apiPath, "--case", caseId, "--scope", "base", "--basis", "observation", "--report", selected.reportId, "--case-index", "0", "--confirm-send"]).then(code => ({ code }), error => ({ error }));
    const sent = JSON.stringify(f.requests[0]?.body);
    expect.soft(sent).toContain("response-status"); expect.soft(sent).toContain("503");
    expect.soft(result).toMatchObject({ code: 0 });
    expect(f.requests).toHaveLength(1); expect(sent).not.toContain("FINAL_B_DEFAULT_OFF_OBSERVATION_BODY");
    expect(digest(f.root)).toBe(before);
  });
  it("final B I3 CLI refuses an observation lacking full locator and scope proof before preview or send", async () => {
    const f = await fixture();
    const selected = savedReport(f, { total: 1, failed: 1, cases: [{ apiId, apiName: "api", caseId, caseName: "saved", passed: false, durationMs: 1, assertions: [],
      evidence: { identity: { projectId, definitionRevision: f.snapshot.definitionRevision }, state: "collected", scriptDiagnostics: "not-collected", truncated: false,
        response: { status: 503, headers: { text: "", truncated: false }, body: { text: "", truncated: false } } } }] });
    const error = await f.run(["suggest-assertions", apiPath, "--case", caseId, "--scope", "base", "--basis", "observation", "--report", selected.reportId, "--case-index", "0"]).then(() => null, cause => cause as Error);
    expect.soft(error?.message).toMatch(/evidence-locator-unavailable|evidence-target-mismatch/);
    expect(f.requests).toEqual([]);
  });
  it("lists controlled reports across source pages in one CLI invocation", async () => {
    const f = await fixture(); let last = "";
    for (let index = 0; index < 51; index++) last = savedReport(f, {}, `report-${String(index).padStart(3, "0")}.json`).reportId;
    await f.run(["reports", projectPath]); expect(f.logs.join("\n")).toContain(last);
  });
  it("lists online report IDs through the same member source used for analysis", async () => {
    const f = await fixture(); const online = await onlineFixture();
    expect(await f.run(["reports", "groups/2/projects/3", "--online-profile", "online-member"], online.deps)).toBe(0);
    expect(f.logs.join("\n")).toContain("report:"); expect(f.logs.join("\n")).toContain("已归档");
    expect(f.requests).toEqual([]);
  });
  // All three business paths must read the same member source instead of the current local workspace.
  it.each(["case", "assertion", "report"])("uses the selected member source for online %s assistance", async purpose => {
    const f = await fixture(); const online = await onlineFixture();
    const onlinePath = "groups/2/projects/3/collections/00000000-0000-4000-8000-000000000004/apis/00000000-0000-4000-8000-000000000005";
    let args: string[];
    if (purpose === "case") { f.output({ cases: [wireCase] }); args = ["suggest-cases", onlinePath]; }
    else if (purpose === "assertion") { f.output({ assertions: [{ assertion: wireAssertion, basis: "contract", reason: "status", evidenceIds: [`contract:${apiId}`], requiresUserJudgment: false }] }); args = ["suggest-assertions", onlinePath, "--case", caseId, "--scope", "base"]; }
    else {
      const source = await createMcpSource({ onlineProfile: "online-member", ...online.deps });
      const page = await source.listRuns("3", {}, new AbortController().signal); await source.close();
      f.output({ conclusion: "online summary", observedFacts: [], possibleCauses: [], checks: [], limitations: [] });
      args = ["analyze-report", "groups/2/projects/3", "--report", page.items[0]!.runId];
    }
    expect(await f.run([...args, "--online-profile", "online-member", "--confirm-send"], online.deps)).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]!.body)).toContain(purpose === "report" ? "logical-summary" : "online-api");
    expect(JSON.stringify(f.requests[0]!.body)).not.toContain("ONLINE_DEFAULT_BODY");
    expect(f.requests[0]!.headers.get("authorization")).toBe("Bearer SYNTHETIC_PRIVATE_KEY");
    expect(f.logs.join("\n")).not.toContain("ONLINE_SYNTHETIC_MEMBER");
  });
  it("uses a purpose binding before a retained legacy file and keeps the workspace unchanged", async () => {
    const f = await fixture();
    writeFileSync(join(f.home, ".apicc", "ai.json"), JSON.stringify({ baseUrl: "https://old.example/v1", apiKey: "OLD_KEY", model: "old-model" }));
    const before = digest(f.root);
    expect(await f.run(["suggest-cases", apiPath, "--confirm-send"])).toBe(0);
    expect(f.requests[0]!.url).toBe("https://fixture.example/v1/chat/completions");
    expect(f.requests[0]!.body.model).toBe("model-0");
    expect(f.requests[0]!.headers.get("authorization")).toBe("Bearer SYNTHETIC_PRIVATE_KEY");
    expect(JSON.stringify(f.requests[0]!.body)).not.toContain("DEFAULT_BODY_SENTINEL");
    expect(digest(f.root)).toBe(before);
    expect(f.logs.join("\n")).toContain("未确认");
    expect(f.logs.find(message => message.startsWith('AI 外发范围预览'))).toContain("请求上限：1");
    expect(f.logs.join("\n")).not.toContain("SYNTHETIC_PRIVATE_KEY");
  });
  it("explicit model profile wins over a partial legacy environment and uses its independent protocol", async () => {
    const f = await fixture();
    expect(await f.run(["suggest-cases", apiPath, "--model-profile", "profile-1", "--confirm-send"], { aiEnv: { APICC_AI_MODEL: "partial" } })).toBe(0);
    expect(f.requests[0]!.url).toBe("https://fixture.example/v1/responses");
    expect(f.requests[0]!.body.model).toBe("model-1");
  });
  it("complete legacy environment wins over a purpose binding", async () => {
    const f = await fixture();
    expect(await f.run(["suggest-cases", apiPath, "--confirm-send"], { aiEnv: { APICC_AI_BASE_URL: "https://env.example/v1", APICC_AI_API_KEY: "ENV_KEY", APICC_AI_MODEL: "env-model" } })).toBe(0);
    expect(f.requests[0]!.url).toBe("https://env.example/v1/chat/completions");
    expect(f.requests[0]!.body.model).toBe("env-model");
    expect(f.requests[0]!.headers.get("authorization")).toBe("Bearer ENV_KEY");
  });
  it("stores a local project's personal purpose override without changing its assets", async () => {
    const f = await fixture(); const before = digest(f.root);
    await f.run(["config", "bind", "case-suggestion", "profile-1", "--project", projectPath]);
    const document = await f.repository.read();
    expect(document.bindings.find(b => b.purpose === "case-suggestion")?.modelProfileId).toBe("profile-0");
    expect(document.projectOverrides).toEqual([{ projectKey: expect.stringMatching(/^ai-project:v1:[a-f0-9]{64}$/), purpose: "case-suggestion", modelProfileId: "profile-1", budgets: {} }]);
    await f.run(["suggest-cases", apiPath, "--confirm-send"]);
    expect(f.requests[0]!.url).toBe("https://fixture.example/v1/responses");
    expect(digest(f.root)).toBe(before);
  });
  it("partial env cannot borrow personal binding fields", async () => {
    const f = await fixture();
    await expect(f.run(["suggest-cases", apiPath, "--confirm-send"], { aiEnv: { APICC_AI_MODEL: "partial" } })).rejects.toThrow(/不完整|incomplete-legacy/);
    expect(f.requests).toEqual([]);
  });
  it("suggests assertions for an explicit existing case through the Responses protocol without executing it", async () => {
    const f = await fixture();
    f.output({ assertions: [{ assertion: wireAssertion, basis: "contract", reason: "status contract", evidenceIds: [`contract:${apiId}`], requiresUserJudgment: true }] });
    const before = digest(f.root);
    expect(await f.run(["suggest-assertions", apiPath, "--case", caseId, "--scope", "base", "--confirm-send"])).toBe(0);
    expect(f.requests[0]!.url).toBe("https://fixture.example/v1/responses");
    const result = parseYaml(f.logs.at(-1)!) as any;
    expect(result.assertions[0]).toMatchObject({ assertion: { target: "status", expected: "200" }, basis: "contract", requiresUserJudgment: true });
    expect(digest(f.root)).toBe(before);
  });
  it("lists opaque saved report IDs and analyzes the selected report through Messages with readable facts and unchanged verdict", async () => {
    const f = await fixture();
    mkdirSync(join(f.root, ".apicc", "runs"), { recursive: true });
    const report = { kind: "collection", projectId, definitionRevision: f.snapshot.definitionRevision,
      executionIdentity: { projectId, definitionRevision: f.snapshot.definitionRevision }, collectionId, collectionName: "existing report",
      startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 0, passed: 0, failed: 0, cases: [],
    };
    writeFileSync(join(f.root, ".apicc", "runs", "run-existing.json"), JSON.stringify(report));
    await f.run(["reports", projectPath]);
    const reportId = f.logs.join("\n").match(/report:[a-f0-9]{64}/)?.[0];
    expect(reportId).toBeDefined();
    f.output({ conclusion: "没有执行用例", observedFacts: [{ evidenceIds: [`${reportId}:e1`] }], possibleCauses: [], checks: [], limitations: ["未采集请求数据"] });
    const before = digest(f.root);
    expect(await f.run(["analyze-report", projectPath, "--report", reportId!, "--confirm-send"])).toBe(0);
    expect(f.requests[0]!.url).toBe("https://fixture.example/v1/messages");
    expect(f.requests[0]!.body.model).toBe("model-2");
    expect(f.logs.at(-1)).toContain("程序事实（本次已选安全证据，不依赖模型引用）");
    expect(f.logs.at(-1)).toContain("模型引用的事实");
    expect(f.logs.at(-1)).toContain("逻辑结果：总数 0 项");
    expect(f.logs.at(-1)).toContain("没有执行用例");
    expect(f.logs.at(-1)).toContain("未采集请求数据");
    expect(f.logs.at(-1)).not.toContain('"observedFacts"');
    expect(digest(f.root)).toBe(before);
  });
});

describe("confirmed output and saved report boundaries", () => {
  it("refuses overwriting an external hardlink to a workspace asset after a confirmed complete AI response", async () => {
    const f = await fixture();
    const asset = join(f.root, "apicc.workspace.yaml");
    const before = readFileSync(asset);
    const out = join(f.home, "hardlinked-candidates.yaml");
    linkSync(asset, out);
    let failure: unknown;
    try { await f.run(["suggest-cases", apiPath, "--confirm-send", "--out", out, "--overwrite"]); }
    catch (error) { failure = error; }
    expect(f.requests).toHaveLength(1);
    expect.soft(failure).toBeInstanceOf(Error);
    expect.soft(failure instanceof Error ? failure.message : "").toMatch(/硬链接/);
    expect(readFileSync(asset)).toEqual(before);
    expect(readFileSync(out)).toEqual(before);
  });
  it.each([false, true])("does not overwrite a managed workspace asset even with explicit confirmation and overwrite (alias=%s)", async alias => {
    const f = await fixture();
    let target = join(f.root, "apicc.workspace.yaml");
    if (alias) { symlinkSync(f.root, join(f.home, "workspace-alias"), "junction"); target = join(f.home, "workspace-alias", "apicc.workspace.yaml"); }
    const before = digest(f.root);
    await expect(f.run(["suggest-cases", apiPath, "--confirm-send", "--out", target, "--overwrite"])).rejects.toThrow(/工作区|托管资产/);
    expect(digest(f.root)).toBe(before);
  });
  it("rejects a selected report whose execution identity is missing rather than guessing ownership", async () => {
    const f = await fixture(); const selected = savedReport(f, { executionIdentity: undefined });
    f.output({ conclusion: "empty", observedFacts: [], possibleCauses: [], checks: [], limitations: [] });
    await expect(f.run(["analyze-report", projectPath, "--report", selected.reportId, "--confirm-send"])).rejects.toThrow(/报告.*归属|报告选择不可用/);
    expect(f.requests).toEqual([]);
  });
  it("does not offer reports owned by a different project", async () => {
    const f = await fixture(); const selected = savedReport(f, { projectId: id(90), executionIdentity: { projectId: id(90), definitionRevision: f.snapshot.definitionRevision } });
    await f.run(["reports", projectPath]);
    expect(f.logs.join("\n")).not.toContain(selected.reportId);
  });
  it("refuses a report root escaping through a parent directory junction before reading or sending", async () => {
    const f = await fixture();
    const outside = mkdtempSync(join(tmpdir(), "apicc-outside-reports-"));
    const selected = savedReport(f, {}, "run-existing.json", join(outside, "runs"));
    renameSync(join(f.root, ".apicc"), join(f.root, ".apicc-original"));
    symlinkSync(outside, join(f.root, ".apicc"), "junction");
    f.output({ conclusion: "empty", observedFacts: [], possibleCauses: [], checks: [], limitations: [] });
    expect(() => readLocalAiReports(f.root, projectId)).toThrow(/报告.*边界/);
    expect(f.requests).toEqual([]);
  });
  it("bounds the saved report directory rather than reading arbitrarily many files", async () => {
    const f = await fixture();
    for (let n = 0; n < 101; n++) savedReport(f, {}, `run-${n}.json`);
    await expect(f.run(["reports", projectPath])).rejects.toThrow(/报告.*数量/);
  });
  it("bounds each saved report byte size before parsing", async () => {
    const f = await fixture(); const selected = savedReport(f);
    writeFileSync(selected.path, " ".repeat(16 * 1024 * 1024 + 1));
    await expect(f.run(["reports", projectPath])).rejects.toThrow(/报告.*大小/);
  });
});

describe("operation cancellation", () => {
  it("propagates cancellation to a pending response reader, returns 130 and removes process listeners", async () => {
    const f = await fixture();
    const abort = new AbortController(); let calls = 0, cancelled = false;
    let close!: () => void; let started!: () => void;
    const receiving = new Promise<void>(resolve => { started = resolve; });
    const response = JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ cases: [wireCase] }) } }] });
    const aiFetch: typeof fetch = async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(response)); close = () => controller.close(); started(); }, cancel() { cancelled = true; } }));
    };
    const listeners = process.listenerCount("SIGINT");
    const operation = f.run(["suggest-cases", apiPath, "--confirm-send"], { aiSignal: abort.signal, aiFetch });
    await receiving; abort.abort();
    const result = await Promise.race([operation, new Promise<string>(resolve => setTimeout(() => resolve("not-settled"), 200))]);
    if (result === "not-settled") { close(); await operation; }
    expect(result).toBe(130);
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(f.logs.join("\n")).not.toContain("cases:");
  });
  it("does not send when the caller already cancelled", async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    expect(await f.run(["suggest-cases", apiPath, "--confirm-send"], { aiSignal: abort.signal })).toBe(130);
    expect(f.requests).toEqual([]);
  });
});

describe("explicit session secrets and payload choices", () => {
  it.each(["env", "stdin"])("uses a %s session secret for the selected connection without changing private config", async source => {
    const f = await fixture(); const before = readFileSync(join(f.home, ".apicc", "ai", "config.v1.json"));
    const args = source === "env" ? ["--secret-env", "SESSION_KEY"] : ["--secret-stdin"];
    await f.run(["suggest-cases", apiPath, "--confirm-send", "--session-only", ...args], { aiEnv: { SESSION_KEY: "SESSION_SYNTHETIC" }, aiSecretInput: async () => "SESSION_SYNTHETIC" });
    expect(f.requests[0]!.headers.get("authorization")).toBe("Bearer SESSION_SYNTHETIC");
    expect(readFileSync(join(f.home, ".apicc", "ai", "config.v1.json"))).toEqual(before);
    expect(f.logs.join("\n")).not.toContain("SESSION_SYNTHETIC");
  });
  it("requires explicit session-only authorization for a transient key", async () => {
    const f = await fixture();
    await expect(f.run(["suggest-cases", apiPath, "--confirm-send", "--secret-env", "SESSION_KEY"], { aiEnv: { SESSION_KEY: "SESSION_SYNTHETIC" } })).rejects.toThrow(/session-only/);
    expect(f.requests).toEqual([]);
  });
  it("includes only an explicitly selected projected contract body", async () => {
    const f = await fixture();
    await f.run(["suggest-cases", apiPath, "--confirm-send", "--include-body", "contract:request-body"]);
    expect(JSON.stringify(f.requests[0]!.body)).toContain("DEFAULT_BODY_SENTINEL");
    expect(f.logs.find(message => message.startsWith('AI 外发范围预览'))).toContain("contract:request-body");
  });
});

describe("safe result delivery and report selection feedback", () => {
  it("redacts a provider echo of the actual connection secret from both candidate files and default output", async () => {
    const f = await fixture(); f.output({ cases: [{ ...wireCase, name: "echo SYNTHETIC_PRIVATE_KEY" }] });
    const out = join(f.home, "candidate.yaml");
    await f.run(["suggest-cases", apiPath, "--confirm-send", "--out", out]);
    expect(readFileSync(out, "utf8")).not.toContain("SYNTHETIC_PRIVATE_KEY");
    await f.run(["suggest-cases", apiPath, "--confirm-send"]);
    expect(f.logs.join("\n")).not.toContain("SYNTHETIC_PRIVATE_KEY");
  });
  it("explains the resolved report cap and allows explicit evidence shrinking followed by a new preview", async () => {
    const f = await fixture(); const selected = savedReport(f);
    const document = await f.repository.read(); document.models[2]!.budgets.evidenceCount = 1; await f.repository.write(document, document.revision);
    f.output({ conclusion: "empty", observedFacts: [], possibleCauses: [], checks: [], limitations: [] });
    await expect(f.run(["analyze-report", projectPath, "--report", selected.reportId, "--confirm-send"])).rejects.toThrow(/缩小.*--evidence/);
    expect(f.requests).toEqual([]);
    await f.run(["analyze-report", projectPath, "--report", selected.reportId, "--evidence", `${selected.reportId}:e1`, "--confirm-send"]);
    expect(f.requests).toHaveLength(1);
    expect(f.logs.at(-1)).toContain("1 / 3 项");
  });
  it("can explicitly overwrite an independent candidate file while source workspace bytes stay unchanged", async () => {
    const f = await fixture(); const out = join(f.home, "independent.yaml"); writeFileSync(out, "old bytes\0");
    const before = digest(f.root);
    await f.run(["suggest-cases", apiPath, "--confirm-send", "--out", out, "--overwrite"]);
    expect((parseYaml(readFileSync(out, "utf8")) as any).cases[0].name).toBe("AI candidate");
    expect(digest(f.root)).toBe(before);
  });
  it("does not advertise a report body as sent after that body's evidence is excluded", async () => {
    const f = await fixture(); const location = "cases[0].evidence.response.body";
    const selected = savedReport(f, { total: 1, failed: 1, cases: [{ apiId, apiName: "contract", caseId, caseName: "existing", passed: false, durationMs: 12, assertions: [],
      evidence: { identity: { projectId, definitionRevision: f.snapshot.definitionRevision }, state: "collected", scriptDiagnostics: "not-collected", truncated: false,
        response: { status: 500, headers: { text: "{}", truncated: false }, body: { text: "DO_NOT_SEND_BODY", truncated: false } } },
    }] });
    f.output({ conclusion: "summary only", observedFacts: [], possibleCauses: [], checks: [], limitations: [] });
    await f.run(["analyze-report", projectPath, "--report", selected.reportId, "--include-body", location, "--evidence", `${selected.reportId}:e1`, "--confirm-send"]);
    const preview = f.logs.find(message => message.startsWith('AI 外发范围预览'))!;
    expect(preview).toContain("实际正文外发：无");
    expect(JSON.stringify(f.requests[0]!.body)).not.toContain("DO_NOT_SEND_BODY");
  });
});

describe("fail-closed source and model selection", () => {
  it("discards report analysis when the same opaque archive ID changes during the model response", async () => {
    const f = await fixture(); const online = await onlineFixture(); const source = await createMcpSource({ onlineProfile: "online-member", ...online.deps });
    const page = await source.listRuns("3", {}, new AbortController().signal); await source.close();
    f.output({ conclusion: "stale archive analysis", observedFacts: [], possibleCauses: [], checks: [], limitations: [] });
    const aiFetch: typeof fetch = async (url, init) => { const response = await f.deps.aiFetch!(url, init); online.report.output.result.collectionName = "replaced archived bytes"; return response; };
    await expect(f.run(["analyze-report", "groups/2/projects/3", "--online-profile", "online-member", "--report", page.items[0]!.runId, "--confirm-send"], { ...online.deps, aiFetch })).rejects.toThrow(/报告.*改变|archive.*changed/);
    expect(f.logs.join("\n")).not.toContain("stale archive analysis");
  });
  // A permission change after preview must be rechecked at the actual external-send boundary.
  it("does not send online assets after member authority is revoked during credential resolution", async () => {
    const f = await fixture(); const online = await onlineFixture();
    const backend: AiSecretBackend = { availability: "available", async get() { online.meStatus(403); return "SYNTHETIC_PRIVATE_KEY"; }, async put() { throw new Error("unused"); }, async remove() {} };
    await expect(f.run(["suggest-cases", "groups/2/projects/3/collections/00000000-0000-4000-8000-000000000004/apis/00000000-0000-4000-8000-000000000005", "--online-profile", "online-member", "--confirm-send"], { ...online.deps, aiSecretBackend: backend })).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
  // A result from a captured older revision must not be delivered as a candidate for a changed source.
  it("discards an online AI result when the source revision changes while the model responds", async () => {
    const f = await fixture(); const online = await onlineFixture();
    const aiFetch: typeof fetch = async (url, init) => { const response = await f.deps.aiFetch!(url, init); online.assets.version = "2"; return response; };
    await expect(f.run(["suggest-cases", "groups/2/projects/3/collections/00000000-0000-4000-8000-000000000004/apis/00000000-0000-4000-8000-000000000005", "--online-profile", "online-member", "--confirm-send"], { ...online.deps, aiFetch })).rejects.toThrow(/source|来源/);
    expect(f.logs.join("\n")).not.toContain("AI candidate");
  });
  it("does not fall back from an explicitly missing model profile to a complete legacy environment", async () => {
    const f = await fixture();
    await expect(f.run(["suggest-cases", apiPath, "--model-profile", "missing", "--confirm-send"], { aiEnv: { APICC_AI_BASE_URL: "https://legacy.example/v1", APICC_AI_API_KEY: "LEGACY_SYNTHETIC", APICC_AI_MODEL: "legacy-model" } })).rejects.toThrow(/配置冲突/);
    expect(f.requests).toEqual([]);
  });
  it("refuses corrupted personal configuration instead of falling back to a retained valid legacy file", async () => {
    const f = await fixture();
    writeFileSync(join(f.home, ".apicc", "ai.json"), JSON.stringify({ baseUrl: "https://old.example/v1", apiKey: "OLD_SYNTHETIC", model: "old-model" }));
    writeFileSync(join(f.home, ".apicc", "ai", "config.v1.json"), "{bad");
    await expect(f.run(["suggest-cases", apiPath, "--confirm-send"])).rejects.toThrow(/invalid-configuration/);
    expect(f.requests).toEqual([]);
  });
  it("refuses an unimplemented selected network profile instead of silently bypassing it", async () => {
    const f = await fixture(); const document = await f.repository.read();
    document.connections[0]!.networkProfileId = "selected-network-profile"; await f.repository.write(document, document.revision);
    await expect(f.run(["suggest-cases", apiPath, "--confirm-send"])).rejects.toThrow(/网络配置.*不支持/);
    expect(f.requests).toEqual([]);
  });
});

function childEnvironment(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home };
  for (const name of ["APICC_AI_BASE_URL", "APICC_AI_API_KEY", "APICC_AI_MODEL"]) delete env[name];
  return env;
}
describe("built CLI process evidence", () => {
  it("cancels a waiting real stdin secret reader with exit 130 and no hung child", async () => {
    const f = await fixture();
    const document = await f.repository.read(); delete document.connections[0]!.credentialRef; await f.repository.write(document, document.revision);
    const main = new URL("../dist/main.js", import.meta.url).href;
    const core = new URL("../../core/dist/index.js", import.meta.url).href;
    const script = `import {runCli} from ${JSON.stringify(main)};import {createDefaultRegistry} from ${JSON.stringify(core)};
      process.stdin.once('resume',()=>{
        if(process.stdin.listenerCount('data')===0)throw new Error('stdin reader data listener missing');
        process.stdout.write('STDIN_READER_READY\\n');
        process.emit('SIGINT');
        setTimeout(()=>process.exit(99),1200).unref();
      });
      const code=await runCli(['--no-plugins','ai','config','credential','gateway','--secret-stdin'],createDefaultRegistry());process.exitCode=code;`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: f.root, env: childEnvironment(f.home), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
    child.stdin.destroy();
    console.log(`CLI stdin cancellation: exit=${code}; stdout=${stdout.trim()}; stderr=${stderr.trim()}`);
    expect(code).toBe(130);
    expect(stdout).toContain("STDIN_READER_READY");
    expect(stdout).toContain("取消");
    expect((await f.repository.read()).connections[0]!.credentialRef).toBeUndefined();
  }, 10000);
  it("runs the built executable against a local substitute endpoint using stdin and records safe stdout/exit", async () => {
    const f = await fixture(); const requests: Array<{ authorization?: string; body: any }> = [];
    const server = createServer((req, res) => { let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ cases: [wireCase] }) } }] }));
    }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const document = await f.repository.read(); document.connections[0]!.baseUrl = `http://127.0.0.1:${port}/v1`; document.connections[0]!.insecureLocalTest = true; delete document.connections[0]!.credentialRef; await f.repository.write(document, document.revision);
      const before = digest(f.root);
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "--no-plugins", "ai", "suggest-cases", apiPath, "--confirm-send", "--secret-stdin", "--session-only"], { cwd: f.root, env: childEnvironment(f.home), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdin.end("PROCESS_SYNTHETIC_KEY\n");
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
      console.log(`CLI endpoint process: exit=${code}; requests=${requests.length}; workspace=${before}/${digest(f.root)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      expect(code).toBe(0); expect(requests).toHaveLength(1);
      expect(requests[0]!.authorization).toBe("Bearer PROCESS_SYNTHETIC_KEY");
      expect(stdout).toContain("AI 外发范围预览"); expect(stdout).toContain("AI candidate");
      expect(stdout + stderr).not.toContain("PROCESS_SYNTHETIC_KEY"); expect(digest(f.root)).toBe(before);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 15000);
});
