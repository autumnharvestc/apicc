import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { fileStorage } from "@apicc/core";
import { runCli, type RunCliDeps } from "../src/main.js";

/**
 * M5 验收演示路径（规格 §5.3）：混合集合（HTTP + WS + SOAP 各一用例）`apicc run` 全过；
 * `apicc run-stress` 对 SOAP 接口照常（并发池复用 execute，D9）。
 * 夹具：临时工作区（fileStorage 落盘）+ 本地 ws/http server（服务端视角断言请求形状）。
 */

const logLines: string[] = [];
const log = (line: string) => logLines.push(line);
const deps: RunCliDeps = {};

let httpServer: Server;
let httpBaseUrl = "";
let wss: WebSocketServer;
let wssUrl = "";
/** 服务端视角捕获。 */
const captured: { soapBodies: string[]; soapContentTypes: string[]; wsMessages: string[]; httpBodies: string[] } = {
  soapBodies: [], soapContentTypes: [], wsMessages: [], httpBodies: [],
};

let root: string;
let prevCwd = "";

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/soap") {
        captured.soapBodies.push(body);
        captured.soapContentTypes.push(String(req.headers["content-type"]));
        res.setHeader("content-type", "text/xml; charset=utf-8");
        res.end('<Envelope><Body><AddUserResponse><id>7</id></AddUserResponse></Body></Envelope>');
      } else {
        captured.httpBodies.push(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  httpBaseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;

  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  const addr = wss.address() as { port: number };
  wssUrl = `ws://127.0.0.1:${addr.port}/rt`;
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      captured.wsMessages.push(data.toString());
      socket.send(JSON.stringify({ pong: "ws-ok" }));
      socket.close(1000);
    });
  });

  // 临时工作区：以内存对象为准经 fileStorage.save 一次性写全（save 会覆盖手写 yaml，
  // 故 environments/apis 必须在对象中真实携带）。
  root = mkdtempSync(join(tmpdir(), "apicc-mixed-"));
  // CLI 按「cwd 向上查找 apicc.workspace.yaml」定位工作区（e2e.test.ts 同款 chdir 模拟）。
  prevCwd = process.cwd();
  process.chdir(root);
  await fileStorage.save(root, {
    id: "00000000-0000-4000-8000-000000000041", name: "ws-mixed", variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000042", name: "demo", projects: [{
        id: "00000000-0000-4000-8000-000000000043", name: "mixed", variables: {},
        environments: [{ id: "00000000-0000-4000-8000-000000000044", name: "dev", variables: {} }],
        collections: [{
          id: "00000000-0000-4000-8000-000000000045", name: "mixed", variables: {}, folders: [],
          apis: [
            {
              id: "00000000-0000-4000-8000-000000000046", name: "http-one", version: "1", deprecated: false, method: "GET",
              url: `${httpBaseUrl}/one`, headers: [], query: [],
              cases: [{ id: "00000000-0000-4000-8000-000000000051", name: "http-用例", scope: "base", parameters: {}, assertions: [{ id: "as1", target: "status", op: "eq", expected: "200" }] }],
            },
            {
              id: "00000000-0000-4000-8000-000000000047", name: "ws-rt", version: "1", deprecated: false, protocol: "websocket",
              url: wssUrl, message: '{"ping":"m5"}', headers: [], query: [],
              cases: [{
                id: "00000000-0000-4000-8000-000000000048", name: "ws-用例", scope: "base", parameters: {},
                assertions: [{ id: "as2", target: "bodyJson", op: "eq", expected: "ws-ok", path: "pong" }],
              }],
            },
            {
              id: "00000000-0000-4000-8000-000000000049", name: "soap-add", version: "1", deprecated: false, method: "POST", protocol: "soap",
              url: `${httpBaseUrl}/soap`, envelope: '<Envelope><Body><AddUser name="m5"/></Body></Envelope>', soapAction: "urn:add",
              headers: [], query: [],
              cases: [{
                id: "00000000-0000-4000-8000-000000000050", name: "soap-用例", scope: "base", parameters: {},
                // SOAP 响应是 XML——bodyJson 断言不适用，用后置脚本 + 内置 xpath 操作符（M5 D6）。
        assertions: [],
        postScript: 'pm.assert(pm.response.text().includes("<id>7</id>"), "SOAP 响应应含 id=7");',
              }],
            },
          ],
        }],
        workflows: [],
      }],
    }],
  });
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
  return new Promise<void>((r) => {
    wss.close(() => httpServer.close(() => r()));
  });
});

describe("多协议混合集合端到端（M5 验收）", () => {
  it("apicc run：HTTP + WS + SOAP 三用例全过（各协议由对应客户端承接）", async () => {
    const exit = await runCli(
      ["run", "groups/demo/projects/mixed/collections/mixed", "--env", "dev"],
      (await import("@apicc/core")).createDefaultRegistry(),
      log,
      deps,
    );
    expect(exit).toBe(0);
    // 服务端视角：各协议请求形状正确（WS 帧内容 / SOAP 信封与 Content-Type）。
    expect(captured.wsMessages).toEqual(['{"ping":"m5"}']);
    expect(captured.soapBodies).toEqual(['<Envelope><Body><AddUser name="m5"/></Body></Envelope>']);
    expect(captured.soapContentTypes[0]).toBe("text/xml; charset=utf-8");
  }, 30000);

  it("apicc run-stress：SOAP 接口照常压测（协议感知客户端，非静默 HTTP）", async () => {
    const exit = await runCli(
      [
        "run-stress", "groups/demo/projects/mixed/collections/mixed/apis/soap-add",
        "--case", "00000000-0000-4000-8000-000000000050", "--env", "dev", "--concurrency", "2", "--iterations", "6",
        "--runs-dir", join(root, "runs"),
      ],
      (await import("@apicc/core")).createDefaultRegistry(),
      log,
      deps,
    );
    expect(exit).toBe(0);
    // 6 次采样全部抵达 SOAP 端点且以 SOAP 口径（Content-Type text/xml）发送。
    expect(captured.soapBodies.length).toBeGreaterThanOrEqual(6);
    expect(captured.soapContentTypes.every((c) => c.startsWith("text/xml"))).toBe(true);
  }, 30000);
});
