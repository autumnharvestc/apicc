import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry, WorkflowSchema } from "@apicc/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createScopedMcpServer } from "../src/mcp/server.js";
import * as servers from "../src/mcp/server.js";
import * as sources from "../src/mcp/source.js";
import { runCli } from "../src/main.js";
import { executionFixture, localCaseExecutionFixture, outcome } from "./mcp-execution.fixture.js";
import { createMcpIntentJournal } from "../src/mcp/intents.js";
import * as localAdapters from "../src/mcp/localExecution.js";
import { oid } from "./mcp-online.fixture.js";

const processIO = vi.hoisted(() => ({ replacement: undefined as InMemoryTransport | undefined }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", async importOriginal => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/server/stdio.js")>();
  return { ...actual, StdioServerTransport: function (...args: ConstructorParameters<typeof actual.StdioServerTransport>) {
    return processIO.replacement ?? new actual.StdioServerTransport(...args);
  } };
});

const executionTools = ["prepare-run", "start-run", "cancel-run"];
function data(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const value = envelope(result);
  return (value.data ?? value) as Record<string, unknown>;
}
function envelope(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  expect(result.structuredContent).toBeTruthy();
  return result.structuredContent as Record<string, unknown>;
}
async function connected(source: sources.McpSource, options: Parameters<typeof createScopedMcpServer>[1]) {
  const server = createScopedMcpServer(source, options);
  const client = new Client({ name: "r56-startup", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { server, client };
}

describe.sequential("R56 execution startup", () => {
  it("startup_readonly_default_has_no_execution_tools_or_legacy_run_alias", async () => {
    const f = await localCaseExecutionFixture(); const c = await connected(f.source, {});
    try {
      const names = (await c.client.listTools()).tools.map(tool => tool.name);
      for (const name of [...executionTools, "run-case"]) expect(names).not.toContain(name);
      expect(f.requests).toHaveLength(0);
    } finally { await c.client.close(); await c.server.close(); await f.close(); }
  });

  it("startup_allow_run_uses_exact_source_and_owned_host_with_strict_model_boundary_and_whole_result_budget", async () => {
    const f = await localCaseExecutionFixture();
    const options = { allowRun: true, privateRoot: f.privateRoot, localHost: f.localHost,
      localProfile: "no-script" as const, limits: { maxTickets: 1 }, maxOutputBytes: 4096 };
    const c = await connected(f.source, options);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await c.client.callTool({ name, arguments: args });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
      return result;
    };
    try {
      const assets = await call("list-assets", { projectId: f.input.projectId, limit: 1 });
      expect(envelope(assets).source).toEqual(f.source.identity);
      expect((await c.client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...executionTools, "run-case"]));
      const forbidden = [
        { ...f.input, localProfile: "trusted-core-script" },
        { ...f.input, limits: { maxTickets: 1000 } },
        { ...f.input, runConfig: { stress: {} } },
        { ...f.input, target: { kind: "debug", invocation: { mode: "request", request: { url: f.baseUrl } } } },
      ];
      for (const args of forbidden) {
        const rejected = await outcome(async () => {
          const result = await call("prepare-run", args); if (result.isError) throw new Error("tool-refused");
        });
        expect(rejected.error).not.toBeNull();
      }
      expect(f.preparations).toHaveLength(0); expect(f.requests).toHaveLength(0);
      const prepared = await call("prepare-run", { ...f.input }); expect(prepared.isError).toBeFalsy();
      const ticketId = String(data(prepared).ticketId); expect(ticketId).not.toBe("undefined");
      expect(f.preparations).toHaveLength(1); expect(f.requests).toHaveLength(0);
      const full = await call("prepare-run", { ...f.input }); expect(full.isError).toBe(true);
      const started = await call("start-run", { ticketId, intentId: "sdk-owned-one" });
      expect(started.isError).toBeFalsy(); const runId = String(data(started).runId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(data(await call("start-run", { ticketId, intentId: "sdk-owned-one" })).runId).toBe(runId);
      expect(envelope(await call("get-run", { runId })).source).toEqual(f.source.identity);
      const readable = JSON.stringify(started.content); expect(readable).not.toContain("执行成功");
      expect(readable).toMatch(/接纳|运行|开始/);
      await call("cancel-run", { runId });
      expect(f.invocations[0]!.settled).toBe(true);
      const report = await call("get-report", { runId });
      const native = await f.source.getReport(runId, {}, new AbortController().signal);
      expect(report.isError).toBe(true); expect(JSON.stringify(report.content)).toMatch(/预算/);
      expect(native.report).toBeTruthy(); expect(f.requests).toHaveLength(1);
    } finally { f.release(); await c.client.close(); await c.server.close(); await f.close(); }
  });

  it("startup_online_allow_run_registers_saved_execution_but_never_legacy_local_alias", async () => {
    const f = await executionFixture();
    const options = { allowRun: true, privateRoot: f.privateRoot };
    const c = await connected(f.source, options);
    try {
      const names = (await c.client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(executionTools)); expect(names).not.toContain("run-case");
      const prepared = await c.client.callTool({ name: "prepare-run", arguments: { ...f.input } });
      expect(prepared.isError).toBeFalsy(); expect(f.counts.submissions).toBe(0);
      const started = await c.client.callTool({ name: "start-run", arguments: { ticketId: data(prepared).ticketId, intentId: "sdk-agent-one" } });
      expect(started.isError).toBeFalsy(); const runId = data(started).runId;
      expect((await c.client.callTool({ name: "get-run", arguments: { runId } })).isError).toBeFalsy();
      await c.server.close(); expect(f.cancellations).toEqual([]); expect(f.counts.submissions).toBe(1);
    } finally { await c.client.close(); await c.server.close(); await f.close(); }
  });

  // Posterior regression of the already-wired generic path, not independent historical feature REDs.
  it.each(["suite", "workflow"] as const)("startup_saved_%s_runs_through_default_adapter_real_core_and_native_read_tools", async kind => {
    const f = await localCaseExecutionFixture({ configureProject(project) {
      project.suites = [{ formatVersion: 1, id: oid(11), name: "one saved case", tags: [], failFast: false, reporters: ["json"],
        selection: { kind: "explicit", entries: [{ id: oid(13), kind: "case", collectionId: oid(4), folderIds: [], apiId: oid(5), caseId: oid(6) }] } }];
      project.workflows = [WorkflowSchema.parse({ id: oid(12), name: "one saved request", status: "published", executionVersion: 2,
        nodes: [{ id: "saved-request", kind: "request", apiId: oid(5), caseId: oid(6) }], edges: [] })];
    } });
    const factory = vi.spyOn(localAdapters, "createMcpLocalExecutionHost");
    const c = await connected(f.source, { allowRun: true, privateRoot: f.privateRoot, networkPrivateRoot: join(f.privateRoot, "network") });
    const adapter = factory.mock.results[0]!.value;
    const prepare = vi.spyOn(adapter, "prepare"), start = vi.spyOn(adapter, "start");
    try {
      const target = kind === "suite" ? { kind, suiteId: oid(11), allowDraft: false } : { kind, workflowId: oid(12), inputs: {} };
      const prepared = await c.client.callTool({ name: "prepare-run", arguments: { ...f.input, target } });
      expect(prepared.isError).toBeFalsy(); expect(data(prepared).targetKind).toBe(kind);
      expect((await prepare.mock.results[0]!.value).target.kind).toBe(kind); expect(f.requests).toHaveLength(0);
      const run = await c.client.callTool({ name: "start-run", arguments: { ticketId: data(prepared).ticketId, intentId: `sdk-saved-${kind}` } });
      expect(run.isError).toBeFalsy(); const runId = String(data(run).runId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1)); f.release();
      const output = await start.mock.results[0]!.value; expect(output.kind).toBe(kind);
      await vi.waitFor(async () => expect(data(await c.client.callTool({ name: "get-run", arguments: { runId } })).state).toBe("ended"));
      const report = await c.client.callTool({ name: "get-report", arguments: { runId } });
      expect(report.isError).toBeFalsy(); expect(data(report).evidence).toEqual(expect.any(Array));
      const native = await f.source.getReport(runId, {}, new AbortController().signal);
      expect(native.report).toBeTruthy(); expect(native.failure).toBeUndefined(); expect(f.requests).toHaveLength(1);
    } finally { f.release(); await c.client.close(); await c.server.close(); prepare.mockRestore(); start.mockRestore(); factory.mockRestore(); await f.close(); }
  });

  it("startup_authoritative_post_forbidden_is_readable_uncertain_and_keeps_original_intent_without_secret_or_resubmit", async () => {
    const f = await executionFixture("online", { rejectSubmit: { status: 403, code: "forbidden" } });
    const c = await connected(f.source, { allowRun: true, privateRoot: f.privateRoot });
    try {
      const prepared = await c.client.callTool({ name: "prepare-run", arguments: { ...f.input } });
      expect(prepared.isError).toBeFalsy(); const ticketId = String(data(prepared).ticketId);
      const original = { ticketId, intentId: "sdk-forbidden-original" };
      const result = await c.client.callTool({ name: "start-run", arguments: original });
      expect(result.isError).toBe(true);
      const readable = JSON.stringify(result.content);
      expect.soft(readable).toMatch(/权限不足|无权|forbidden/);
      expect.soft(readable).toMatch(/不确定|uncertain/);
      expect(readable).toMatch(/勿重新提交|不要重新提交|勿重发/);
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_SERVER_ERROR_BODY");
      expect(f.controlRequests.filter(request => request.method === "POST" && request.url.endsWith("/jobs"))).toHaveLength(1);
      expect(f.counts.submissions).toBe(1); expect(f.counts.business).toBe(0);
      const receipt = await createMcpIntentJournal(f.privateRoot).read(ticketId);
      expect(receipt).toMatchObject({ ...original, state: "uncertain" });
      await c.client.callTool({ name: "start-run", arguments: original });
      expect(f.counts.submissions).toBe(1);
      expect(await createMcpIntentJournal(f.privateRoot).read(ticketId)).toMatchObject({ ...original, state: "uncertain" });
    } finally { await c.client.close(); await c.server.close(); await f.close(); }
  });

  it("startup_sdk_strict_schema_errors_obey_the_whole_result_budget_before_entering_adapter", async () => {
    const f = await localCaseExecutionFixture();
    const c = await connected(f.source, { allowRun: true, privateRoot: f.privateRoot, localHost: f.localHost, maxOutputBytes: 4096 });
    try {
      // One bounded input sample, not a parameter matrix: SDK itself formats the strict-schema error.
      const unknown = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`operator-only-${i}-${"x".repeat(256)}`, false]));
      const result = await c.client.callTool({ name: "prepare-run", arguments: { ...f.input, ...unknown } });
      expect(result.isError).toBe(true);
      expect.soft(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
      expect(f.preparations).toHaveLength(0); expect(f.requests).toHaveLength(0);
    } finally { await c.client.close(); await c.server.close(); await f.close(); }
  });

  it("startup_main_reads_and_executes_from_one_actual_source_factory", async () => {
    const f = await localCaseExecutionFixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Replace only process IO with an actual SDK transport; all source/host/Core work stays real.
    processIO.replacement = serverTransport;
    const factory = vi.spyOn(sources, "createMcpSource");
    const client = new Client({ name: "r56-main-single-source", version: "1" });
    const running = outcome(() => runCli(["mcp", "--workspace", f.workspaceRoot, "--allow-run"], createDefaultRegistry(), () => {}, { loadPlugins: false, mcpHomeDir: f.privateRoot, networkPrivateRoot: join(f.privateRoot, "network") }));
    try {
      await client.connect(clientTransport);
      const assets = await client.callTool({ name: "list-assets", arguments: { projectId: f.input.projectId } });
      expect(assets.isError).toBeFalsy();
      expect(factory).toHaveBeenCalledTimes(1);
      const first = await factory.mock.results[0]!.value;
      expect(envelope(assets).source).toEqual(first.identity);
      const prepared = await client.callTool({ name: "prepare-run", arguments: { ...f.input } });
      expect(prepared.isError).toBeFalsy(); expect(f.requests).toHaveLength(0);
    } finally { await client.close(); await running; factory.mockRestore(); processIO.replacement = undefined; await f.close(); }
  });

  it("startup_rejects_invalid_operator_ticket_limit_instead_of_ignoring_configuration", async () => {
    const f = await localCaseExecutionFixture(); let server: ReturnType<typeof createScopedMcpServer> | undefined;
    try {
      const options = { allowRun: true, privateRoot: f.privateRoot, limits: { maxTickets: 0 } };
      expect(() => { server = createScopedMcpServer(f.source, options); }).toThrow(/ticket|票据|范围|limit/i);
      expect(f.requests).toHaveLength(0);
    } finally { await server?.close(); await f.close(); }
  });

  it.each(["activeLocalRuns", "terminalLocalRuns", "terminalLocalBytes"] as const)("startup_operator_local_result_limit_%s_must_reject_zero_before_any_business_run", async field => {
    const f = await localCaseExecutionFixture(); let server: ReturnType<typeof createScopedMcpServer> | undefined;
    try {
      const limits = { activeLocalRuns: 1, terminalLocalRuns: 20, terminalLocalBytes: 32 * 1024 * 1024, [field]: 0 };
      expect(() => { server = createScopedMcpServer(f.source, { allowRun: true, privateRoot: f.privateRoot, localHost: f.localHost, limits }); }).toThrow(/limit|额度|范围|invalid/i);
      expect(f.preparations).toHaveLength(0); expect(f.invocations).toHaveLength(0); expect(f.requests).toHaveLength(0);
    } finally { await server?.close(); await f.close(); }
  });

  it("startup_readonly_main_stdin_end_closes_the_same_actual_server_and_source_without_client_close", async () => {
    const f = await localCaseExecutionFixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    processIO.replacement = serverTransport;
    const actualSource = sources.createMcpSource, actualServer = servers.createScopedMcpServer;
    let sourceCloses = 0, serverCloses = 0, sourceIdentity: sources.McpSource["identity"] | undefined;
    const sourceObservation = vi.spyOn(sources, "createMcpSource").mockImplementation(async (...args) => {
      const source = await actualSource(...args); sourceIdentity = source.identity;
      const close = source.close.bind(source);
      source.close = async () => { sourceCloses++; await close(); };
      return source;
    });
    const serverObservation = vi.spyOn(servers, "createScopedMcpServer").mockImplementation((...args) => {
      const server = actualServer(...args), close = server.close.bind(server);
      server.close = async () => { serverCloses++; await close(); };
      return server;
    });
    const client = new Client({ name: "r56-readonly-eof", version: "1" });
    const running = outcome(() => runCli(["mcp", "--workspace", f.workspaceRoot], createDefaultRegistry(), () => {}, { loadPlugins: false, mcpHomeDir: f.privateRoot }));
    try {
      await client.connect(clientTransport);
      const assets = await client.callTool({ name: "list-assets", arguments: { projectId: f.input.projectId } });
      expect(assets.isError).toBeFalsy(); expect(envelope(assets).source).toEqual(sourceIdentity);
      expect(serverCloses).toBe(0); expect(sourceCloses).toBe(0);
      process.stdin.emit("end");
      // No client.close until finally: this observation cannot pass via SDK's transport close fallback.
      await vi.waitFor(() => expect(serverCloses).toBe(1));
      expect((await running).error).toBeNull(); expect(sourceCloses).toBe(1);
      expect(f.requests).toHaveLength(0);
    } finally {
      await client.close(); await running; serverObservation.mockRestore(); sourceObservation.mockRestore();
      processIO.replacement = undefined; await f.close();
    }
  });

  it("startup_cli_max_tickets_flag_reaches_the_owned_host_and_refuses_second_unused_prepare", async () => {
    const f = await localCaseExecutionFixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); processIO.replacement = serverTransport;
    const exit = vi.spyOn(process, "exit").mockImplementation(code => { throw new Error(`observed-cli-exit-${code}`); });
    const client = new Client({ name: "r56-cli-operator-limit", version: "1" });
    const running = outcome(() => runCli(["mcp", "--workspace", f.workspaceRoot, "--allow-run", "--max-tickets", "1"], createDefaultRegistry(), () => {}, { loadPlugins: false, mcpHomeDir: f.privateRoot, networkPrivateRoot: join(f.privateRoot, "network") }));
    const connection = outcome(() => client.connect(clientTransport));
    try {
      const first = await Promise.race([running.then(result => ({ phase: "cli-exited", result })), connection.then(result => ({ phase: "connected", result }))]);
      expect(first).toMatchObject({ phase: "connected", result: { error: null } });
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(executionTools));
      const prepared = await client.callTool({ name: "prepare-run", arguments: { ...f.input } }); expect(prepared.isError).toBeFalsy();
      const refused = await client.callTool({ name: "prepare-run", arguments: { ...f.input } });
      expect(refused.isError).toBe(true); expect(JSON.stringify(refused.content)).toMatch(/票据|ticket|容量/);
      expect(f.requests).toHaveLength(0);
    } finally { await client.close(); await connection; await running; exit.mockRestore(); processIO.replacement = undefined; await f.close(); }
  });

  it("startup_stdio_records_real_requests_and_requires_owned_eof_cleanup_and_exit_zero_without_sdk_kill", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol !== "http") throw new Error("http fixture required");
      request.method = "POST";
      request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("owned stdio cleanup evidence");
    const home = mkdtempSync(join(tmpdir(), "apicc-r56-stdio-home-"));
    const stdoutPath = join(home, "protocol.jsonl"), exitPath = join(home, "exit.txt"), eventsPath = join(home, "cleanup-events.jsonl");
    const bin = new URL("../dist/bin.js", import.meta.url).href;
    const bootstrap = `import {appendFileSync,writeFileSync} from 'node:fs';
      import fsp from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
      const event=value=>appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify(value)+'\\n');
      const actualOpen=fsp.open; let ordinal=0;
      fsp.open=async function(...args){const handle=await actualOpen(...args);
        if(String(args[0])===${JSON.stringify(f.materialPath)}){const owned=++ordinal;event({event:'attachment-open',owned});
          const close=handle.close.bind(handle);handle.close=async function(...closeArgs){await close(...closeArgs);event({event:'attachment-close',owned});};}
        return handle;}; syncBuiltinESMExports();
      const original=process.stdout.write.bind(process.stdout);
      process.stdout.write=function(chunk,encoding,callback){appendFileSync(${JSON.stringify(stdoutPath)},chunk);return original(chunk,encoding,callback);};
      process.on('exit',code=>{event({event:'exit',code});writeFileSync(${JSON.stringify(exitPath)},String(code));});
      process.argv=['node','apicc','--no-plugins','mcp','--workspace',${JSON.stringify(f.workspaceRoot)},'--allow-run'];
      await import(${JSON.stringify(bin)});`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", bootstrap], cwd: f.workspaceRoot, env: { HOME: home, USERPROFILE: home }, stderr: "pipe" });
    let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    const client = new Client({ name: "r56-real-stdio", version: "1" });
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, arguments: args }); return client.callTool({ name, arguments: args });
    };
    let eofStarted = false, evidenceExit = "missing";
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(executionTools));
      const first = data(await call("prepare-run", { ...f.input })); expect(f.requests).toHaveLength(0);
      const run = data(await call("start-run", { ticketId: first.ticketId, intentId: "stdio-first" }));
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(data(await call("start-run", { ticketId: first.ticketId, intentId: "stdio-first" })).runId).toBe(run.runId);
      expect((await call("get-run", { runId: run.runId })).isError).toBeFalsy();
      await call("cancel-run", { runId: run.runId });
      expect((await call("get-report", { runId: run.runId })).isError).toBeFalsy();
      const second = data(await call("prepare-run", { ...f.input }));
      await call("start-run", { ticketId: second.ticketId, intentId: "stdio-eof" });
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      eofStarted = true; await client.close();
      // SDK close kills after 2s; only natural exit(0) plus aborted actual HTTP is accepted.
      evidenceExit = readFileSync(exitPath, "utf8"); expect(evidenceExit).toBe("0");
      expect(f.closedBeforeReply).toHaveLength(2); expect(f.requests).toHaveLength(2);
      const events = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line) as { event: string; owned?: number });
      expect(events.filter(event => event.event === "attachment-open")).toHaveLength(2);
      const secondClose = events.findIndex(event => event.event === "attachment-close" && event.owned === 2);
      expect(secondClose).toBeGreaterThan(-1); expect(secondClose).toBeLessThan(events.findIndex(event => event.event === "exit"));
    } finally {
      await client.close();
      const stdout = readFileSync(stdoutPath, "utf8");
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) expect(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success).toBe(true);
      try { evidenceExit = readFileSync(exitPath, "utf8"); } catch { /* missing exit marker is evidence, not a pass */ }
      let cleanupEvents = "missing"; try { cleanupEvents = readFileSync(eventsPath, "utf8"); } catch { /* preserve absent evidence */ }
      const evidence = { calls, protocolLines: lines.length, stdout, stderr, childExit: evidenceExit, cleanupEvents, eofWithOwnedRunReached: eofStarted, targetRequests: f.requests.length, closedBeforeReply: f.closedBeforeReply.length };
      // Optional operator-owned evidence destination; never passed to the model or child process.
      if (process.env.APICC_MCP_STDIO_EVIDENCE) writeFileSync(process.env.APICC_MCP_STDIO_EVIDENCE, JSON.stringify(evidence, null, 2), { flag: "wx" });
      console.error(`R56_STDIO ${JSON.stringify(evidence)}`);
      f.release(); await f.close(); rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});
