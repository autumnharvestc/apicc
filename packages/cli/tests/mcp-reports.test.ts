import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProjectSnapshot, fileStorage, prepareAiContext, type Workspace } from "@apicc/core";
import { createMcpSource } from "../src/mcp/source.js";
import { onlineFixture } from "./mcp-online.fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScopedMcpServer } from "../src/mcp/server.js";

const roots: string[] = [];
it.each(['status','report403'])('F7f real MCP %s after minimum status has no fabricated history metadata',async route=>{
  const f=await onlineFixture();roots.push(f.home);const source=await createMcpSource({onlineProfile:'online-member',...f.deps});const signal=new AbortController().signal;
  try{
    const page=await source.listRuns('3',{},signal);expect(page.items[0]).toMatchObject({reportState:'archived'});
    const minimum={jobId:'99',executionId:'100',agentId:'5',state:'running',cancelState:'none',executionReleased:false,canCancel:true,view:'active-status',scope:{workspaceId:'1',groupId:'2',projectId:'3'}};
    f.jobViews(minimum);f.reportStatus(403);
    if(route==='status'){
      const run=await source.getRun(page.items[0]!.runId,signal);expect.soft(run.state).toBe('running');expect(run).not.toHaveProperty('reportState');
    }else{
      const error=await source.getReport(page.items[0]!.runId,{},signal).then(()=>null,cause=>cause);
      expect.soft(error).toMatchObject({status:403,code:'forbidden'});expect(f.requests.filter(request=>request.url.endsWith('/report'))).toHaveLength(1);
    }
    expect(f.requests.filter(request=>!request.url.endsWith('/auth/login')).every(request=>request.method==='GET')).toBe(true);
  }finally{await source.close();}
});
it('F7f minimum MCP report200 refuses unavailable original task binding after real member proof',async()=>{
  const f=await onlineFixture();roots.push(f.home);const source=await createMcpSource({onlineProfile:'online-member',...f.deps});const signal=new AbortController().signal;
  try{
    const page=await source.listRuns('3',{},signal);expect(page.items[0]).toMatchObject({reportState:'archived'});
    const minimum={jobId:'99',executionId:'100',agentId:'5',state:'running',cancelState:'none',executionReleased:false,canCancel:true,view:'active-status',scope:{workspaceId:'1',groupId:'2',projectId:'3'}};
    f.jobViews(minimum,minimum,f.job);
    const error=await source.getReport(page.items[0]!.runId,{},signal).then(()=>null,cause=>cause);
    expect.soft(error).toMatchObject({message:'MCP report-binding-unavailable；请刷新后重新读取报告，不会重跑'});
    expect.soft(f.requests.filter(request=>request.url.endsWith('/report'))).toHaveLength(1);
    expect(f.requests.filter(request=>request.url.endsWith('/jobs/99'))).toHaveLength(3);
  }finally{await source.close();}
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pid = "00000000-0000-4000-8000-000000000003";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "apicc-mcp-reports-")); roots.push(root);
  const project = { id: pid, name: "project", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, collections: [], models: [], components: [], workflows: [], environments: [], stressPolicy: {} };
  const workspace = { formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", name: "workspace", variables: {}, groups: [{ id: "00000000-0000-4000-8000-000000000002", name: "group", projects: [project] }] } as Workspace;
  const initial = await fileStorage.load(root); await fileStorage.save(root, workspace, { expectedRevision: initial.revision, deletions: [] });
  const revision = createProjectSnapshot(project).definitionRevision;
  const directory = join(root, ".apicc", "runs"); mkdirSync(directory, { recursive: true });
  const save = (name: string, patch: Record<string, unknown> = {}) => {
    writeFileSync(join(directory, name), JSON.stringify({ projectId: pid, definitionRevision: revision, executionIdentity: { projectId: pid, definitionRevision: revision }, collectionId: "collection", collectionName: "report", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 0, passed: 0, failed: 0, cases: [], ...patch }));
    return `report:${createHash("sha256").update(name).digest("hex")}`;
  };
  return { root, directory, save, source: await createMcpSource({ workspace: root }) };
}

// Final M4: a real bounded report projection can exceed context bytes before
// the tool output budget; the remedy must not diagnose a login failure.
it("final M4 SDK context-budget offers smaller selection without asking for login", async () => {
  const f = await fixture();
  const reportId = f.save("large-safe-report.json", { total: 90, failed: 90, cases: Array.from({ length: 90 }, (_, index) => ({
    apiId: `api-${index}`, apiName: "report API", caseId: `case-${index}`, caseName: "saved case", passed: false, durationMs: 1, assertions: [], error: "observed bounded failure ".repeat(90),
  })) });
  const server = createScopedMcpServer(f.source, { maxOutputBytes: 1024 * 1024 });
  const client = new Client({ name: "final-context-budget", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    const selected = await f.source.getReport(reportId, {}, new AbortController().signal);
    expect(() => prepareAiContext({ purpose: "report-analysis", reportId, report: selected.report!, snapshot: selected.project.snapshot,
      context: selected.project.snapshot.context, source: selected.project.binding, bodySelection: [] })).toThrow(/^context-budget$/);
    await Promise.all([client.connect(a), server.connect(b)]);
    const result = await client.callTool({ name: "get-report", arguments: { runId: reportId } });
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true); expect.soft(text).toMatch(/缩小选择|分页/); expect.soft(text).not.toMatch(/重新登录/);
    expect(readFileSync(join(f.directory, "large-safe-report.json"), "utf8")).toContain("observed bounded failure");
  } finally { await client.close(); await server.close(); }
});

// A source that omits archives or substitutes an execution instead of reading cannot satisfy this.
it("lists and reads a verified existing local report through an opaque ID", async () => {
  const f = await fixture(); const reportId = f.save("report.json"); const signal = new AbortController().signal;
  try {
    const page = await f.source.listRuns(pid, {}, signal);
    expect(page.items).toEqual([expect.objectContaining({ runId: reportId, projectId: pid, reportState: "archived" })]);
    const read = await f.source.getReport(reportId, {}, signal);
    expect(read.report).toMatchObject({ projectId: pid, total: 0, cases: [] });
    expect(read.project.binding.projectId).toBe(pid);
  } finally { await f.source.close(); }
});

// Ignoring limit/cursor would silently repeat or omit archived reports.
it("paginates local archives without losing or repeating the next report", async () => {
  const f = await fixture(); const first = f.save("a.json"); const second = f.save("b.json"); const signal = new AbortController().signal;
  try {
    const page = await f.source.listRuns(pid, { limit: 1 }, signal);
    expect(page.items.map(item => item.runId)).toEqual([first]);
    expect(page.nextCursor).toBeTruthy();
    const next = await f.source.listRuns(pid, { limit: 1, cursor: page.nextCursor }, signal);
    expect(next.items.map(item => item.runId)).toEqual([second]);
    expect(next.nextCursor).toBeUndefined();
  } finally { await f.source.close(); }
});
// Out-of-range page sizes must be rejected before building a response.
it.each([0, 201, 1.5])("refuses invalid local report page size %s", async limit => {
  const f = await fixture(); f.save("a.json");
  try { await expect(f.source.listRuns(pid, { limit }, new AbortController().signal)).rejects.toThrow(/limit|页/); }
  finally { await f.source.close(); }
});
// A cursor from another source identity must never select an offset in this source.
it("rejects an opaque cursor issued by a different local source", async () => {
  const f = await fixture(); f.save("a.json"); f.save("b.json"); const signal = new AbortController().signal;
  const other = await createMcpSource({ workspace: f.root });
  try {
    const page = await f.source.listRuns(pid, { limit: 1 }, signal);
    await expect(other.listRuns(pid, { limit: 1, cursor: page.nextCursor }, signal)).rejects.toThrow(/cursor/);
  } finally { await f.source.close(); await other.close(); }
});

// The adapter must use jobs/status and T6 report verification, never prepare a replacement execution.
it("lists online jobs and reads the archived report bound to the fixed source", async () => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    const page = await source.listRuns("3", { limit: 1 }, signal);
    expect(page.items).toEqual([expect.objectContaining({ projectId: "3", reportState: "archived" })]);
    expect(page.items[0]!.runId).toMatch(/^report:/);
    const read = await source.getReport(page.items[0]!.runId, {}, signal);
    expect(read.report).toMatchObject({ projectId: f.project.id, total: 0 });
    expect(f.requests.filter(request => !request.url.endsWith("/auth/login")).every(request => request.method === "GET")).toBe(true);
  } finally { await source.close(); }
});

// Listing a foreign job as this project's run would bind an opaque ID to the wrong authority.
it("rejects an online job whose task scope disagrees with the selected project", async () => {
  const f = await onlineFixture(); roots.push(f.home); f.job.task.scope = { workspaceId: "1", groupId: "2", projectId: "99" };
  const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps });
  try { await expect(source.listRuns("3", {}, new AbortController().signal)).rejects.toThrow(/scope/); }
  finally { await source.close(); }
});
// A syntactically valid report for another Core project must not enter a safe projection or AI.
it("rejects an online report whose Core project differs from the captured job", async () => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    const page = await source.listRuns("3", {}, signal); f.report.output.result.projectId = "00000000-0000-4000-8000-000000000099";
    await expect(source.getReport(page.items[0]!.runId, {}, signal)).rejects.toThrow(/report.*scope|project.*mismatch/);
  } finally { await source.close(); }
});
// A server returning an old body must not make a nonarchived/expired report appear readable.
it.each(["none", "pending", "expired"])("refuses an online report in %s archive state", async state => {
  const f = await onlineFixture(); roots.push(f.home); f.job.reportState = state;
  const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    const page = await source.listRuns("3", {}, signal);
    await expect(source.getReport(page.items[0]!.runId, {}, signal)).rejects.toThrow(state === "expired" ? /expired/ : /not-archived/);
    expect(f.requests.some(request => request.url.endsWith("/jobs/99/report"))).toBe(false);
  } finally { await source.close(); }
});
// T6 already protects execution identity and an HTTP 200 empty body; retain those inherited boundaries.
it.each(["execution", "empty", "gone"])("refuses an online report with inherited %s failure", async kind => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    const page = await source.listRuns("3", {}, signal);
    if (kind === "execution") f.report.executionId = "101";
    else if (kind === "empty") f.emptyReport(); else f.reportStatus(410);
    await expect(source.getReport(page.items[0]!.runId, {}, signal)).rejects.toThrow();
    expect(f.requests.filter(request => !request.url.endsWith("/auth/login")).every(request => request.method === "GET")).toBe(true);
  } finally { await source.close(); }
});

// A changed archive set invalidates its cursor even when project definitions remain unchanged.
it("rejects a local archive cursor after the archive set changes", async () => {
  const f = await fixture(); f.save("a.json"); f.save("b.json"); const signal = new AbortController().signal;
  try {
    const page = await f.source.listRuns(pid, { limit: 1 }, signal); f.save("c.json");
    await expect(f.source.listRuns(pid, { limit: 1, cursor: page.nextCursor }, signal)).rejects.toThrow(/cursor/);
  } finally { await f.source.close(); }
});
// Counting only .json files still permits unbounded directory enumeration.
it("bounds archive directory enumeration including nonreport entries", async () => {
  const f = await fixture();
  for (let index = 0; index < 1001; index++) writeFileSync(join(f.directory, `nonreport-${index}.txt`), "");
  try { await expect(f.source.listRuns(pid, {}, new AbortController().signal)).rejects.toThrow(/报告.*数量|目录.*预算/); }
  finally { await f.source.close(); }
});
// A valid new execution body must not reuse an opaque ID issued for an earlier execution.
it("rejects an online report when the captured job execution is replaced", async () => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    const page = await source.listRuns("3", {}, signal);
    f.job.executionId = "101"; f.job.task.executionId = "101"; f.report.executionId = "101";
    await expect(source.getReport(page.items[0]!.runId, {}, signal)).rejects.toThrow(/execution.*binding|来源/);
  } finally { await source.close(); }
});

it("rejects an online native report whose archived execution definition is unowned", async () => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    const page = await source.listRuns("3", {}, signal); f.report.output.result.executionIdentity.definitionRevision = "different-definition";
    await expect(source.getReport(page.items[0]!.runId, {}, signal)).rejects.toThrow(/report.*unowned|归属/);
  } finally { await source.close(); }
});
