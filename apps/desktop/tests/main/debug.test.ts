import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";

let server: Server;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function setup(envUrl?: string) {
  const s = createSession();
  const dir = mkdtempSync(join(tmpdir(), "apicc-dbg-"));
  await s.create(dir, "w");
  await s.open(dir);
  const g = s.createGroup("g");
  const p = s.createProject(g.id, "p");
  if (envUrl) p.environments.push({ id: "e1", name: "dev", variables: { baseUrl } });
  const c = s.createCollection(p.id, "c");
  const api = s.createApi(c.id, null, { name: "ping", method: "GET", url: "{{baseUrl}}/x" });
  return { s, api, project: p };
}

describe("sendDebug", () => {
  it("以基座用例调试：返回单条结果且断言评估", async () => {
    const { s, api } = await setup();
    api.url = `${baseUrl}/x`; // 简报缺陷修正：无环境时 {{baseUrl}} 无法解析，直连测试服务器以聚焦基座用例与断言评估
    api.cases[0]!.assertions.push({ id: "as1", target: "status", op: "eq", expected: "200" });
    const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.run.total).toBe(1);
    expect(result.outcome.passed).toBe(true);
  });

  it("环境变量在调试中生效", async () => {
    const { s, api } = await setup("set");
    const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: "dev" });
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.passed).toBe(true);
  });

  it("网络错误进入 outcome.error 而非抛出", async () => {
    const { s, api } = await setup();
    api.url = "http://127.0.0.1:1/";
    const result = await sendDebug(s, { apiId: api.id, caseId: api.cases[0]!.id, envName: undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.error).toContain("refused");
  });
});
