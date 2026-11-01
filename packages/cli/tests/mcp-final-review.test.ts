import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createScopedMcpServer } from "../src/mcp/server.js";
import { executionFixture } from "./mcp-execution.fixture.js";

// Final I9: actual member.prepare HTTP denials occur before ticket publication;
// they must not receive the accepted-start/response-loss recovery instructions.
it.each([
  { code: "forbidden", reason: /权限不足|没有.*权限/ },
  { code: "script_permission_denied", reason: /脚本.*权限|权限.*脚本/ },
])("final I9 SDK known prepare $code says not started without a nonexistent ticket", async ({ code, reason }) => {
  const f = await executionFixture("online", { rejectPrepare: { status: 403, code } });
  const server = createScopedMcpServer(f.source, { allowRun: true, privateRoot: f.privateRoot });
  const client = new Client({ name: "final-known-prepare-denial", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const result = await client.callTool({ name: "prepare-run", arguments: { ...f.input } });
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect.soft(text).toMatch(reason); expect.soft(text).toMatch(/准备未完成|准备.*拒绝/); expect.soft(text).toMatch(/未启动|执行未开始/);
    expect.soft(text).toMatch(/重新准备/); expect.soft(text).not.toMatch(/查询.*(?:票据|运行)|结果尚未确认|结果不确定/);
    expect(result.structuredContent).not.toHaveProperty("data.ticketId"); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PREPARE_PRIVATE_RESPONSE");
    expect(f.controlRequests.filter(row => row.url.endsWith("/execution-snapshots"))).toHaveLength(1);
    expect(f.counts.submissions).toBe(0); expect(f.counts.business).toBe(0);
  } finally { await client.close(); await server.close(); await f.close(); }
});

it("final I9 SDK lost accepted start response remains uncertain with one original submission", async () => {
  const f = await executionFixture("online", { loseSubmitResponse: true });
  const server = createScopedMcpServer(f.source, { allowRun: true, privateRoot: f.privateRoot });
  const client = new Client({ name: "final-uncertain-start", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const prepared = await client.callTool({ name: "prepare-run", arguments: { ...f.input } });
    const ticketId = (prepared.structuredContent as { data: { ticketId: string } }).data.ticketId;
    const started = await client.callTool({ name: "start-run", arguments: { ticketId, intentId: "final-original-start" } });
    expect(started.isError).toBe(true); expect(JSON.stringify(started.content)).toMatch(/不确定|尚未确认/); expect(JSON.stringify(started.content)).toMatch(/查询原|原票据/);
    const repeated = await client.callTool({ name: "start-run", arguments: { ticketId, intentId: "final-original-start" } });
    expect((repeated.structuredContent as { data: { runId: string } }).data.runId).toBe("99");
    expect(f.counts.submissions).toBe(1); expect(f.counts.business).toBe(0);
  } finally { await client.close(); await server.close(); await f.close(); }
});

// Final M5: protocol values remain untouched while the human text gains labels.
it("final M5 SDK accepted run describes agent and queued with Chinese business labels", async () => {
  const f = await executionFixture();
  const server = createScopedMcpServer(f.source, { allowRun: true, privateRoot: f.privateRoot });
  const client = new Client({ name: "final-readable-run", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const prepared = await client.callTool({ name: "prepare-run", arguments: { ...f.input } });
    const ticketId = (prepared.structuredContent as { data: { ticketId: string } }).data.ticketId;
    const result = await client.callTool({ name: "start-run", arguments: { ticketId, intentId: "final-readable-start" } });
    expect(result.structuredContent).toMatchObject({ data: { location: { kind: "agent" }, state: "queued", runId: "99" } });
    const text = JSON.stringify(result.content);
    expect.soft(text).toMatch(/代理/); expect.soft(text).toMatch(/排队/); expect.soft(text).not.toMatch(/位置 agent|状态 queued/);
    expect(f.counts.submissions).toBe(1); expect(f.counts.business).toBe(0);
  } finally { await client.close(); await server.close(); await f.close(); }
});
