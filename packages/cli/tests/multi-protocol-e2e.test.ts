import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { fileStorage, type PluginRegistry, type Workspace } from "@apicc/core";
import { runCli as runCliActual, type RunCliDeps } from "../src/main.js";

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

const GROUP_ID = "00000000-0000-4000-8000-000000000042";
const PROJECT_ID = "00000000-0000-4000-8000-000000000043";
const COLLECTION_ID = "00000000-0000-4000-8000-000000000045";
const HTTP_API_ID = "00000000-0000-4000-8000-000000000046";
const WS_API_ID = "00000000-0000-4000-8000-000000000047";
const WS_CASE_ID = "00000000-0000-4000-8000-000000000048";
const SOAP_API_ID = "00000000-0000-4000-8000-000000000049";
const SOAP_CASE_ID = "00000000-0000-4000-8000-000000000050";
const HTTP_CASE_ID = "00000000-0000-4000-8000-000000000051";
const collectionPath = `groups/${GROUP_ID}/projects/${PROJECT_ID}/collections/${COLLECTION_ID}`;
const soapApiPath = `${collectionPath}/apis/${SOAP_API_ID}`;

function testCase(
  id: string,
  name: string,
  assertions: Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["cases"][number]["assertions"],
  postOperations: Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["cases"][number]["postOperations"] = [],
) {
  return { id, name, scope: "base", parameters: {}, preOperations: [], postOperations, assertions };
}

function apiAsset(
  id: string,
  name: string,
  request: Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["contract"]["request"],
  cases: ReturnType<typeof testCase>[],
) {
  return {
    contract: {
      formatVersion: 1 as const,
      id,
      metadata: { name, description: "", tags: [], version: "1", status: "published" as const },
      request,
      responses: [],
    },
    documentation: "",
    cases,
  };
}

let root: string;
let networkPrivateRoot = "";
let prevCwd = "";

function runCli(argv: string[], registry: PluginRegistry, hostLog: (line: string) => void = () => {}, injected: RunCliDeps = {}): Promise<number> {
  return runCliActual(argv, registry, hostLog, { networkPrivateRoot, ...injected });
}

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
  networkPrivateRoot = mkdtempSync(join(tmpdir(), "apicc-mixed-network-private-"));
  // CLI 按「cwd 向上查找 apicc.workspace.yaml」定位工作区（e2e.test.ts 同款 chdir 模拟）。
  prevCwd = process.cwd();
  process.chdir(root);
  const ws: Workspace = {
    formatVersion: 1,
    id: "00000000-0000-4000-8000-000000000041", name: "ws-mixed", variables: {},
    groups: [{
      id: GROUP_ID, name: "demo", projects: [{
        id: PROJECT_ID, name: "mixed", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] },
        environments: [{ id: "00000000-0000-4000-8000-000000000044", name: "dev", variables: {}, baseUrls: {} }],
        models: [], components: [], stressPolicy: { trustedOrigins: [httpBaseUrl], deniedOrigins: [] },
        collections: [{
          id: COLLECTION_ID, name: "mixed", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [
            apiAsset(HTTP_API_ID, "http-one", {
              protocol: "http", method: "GET", baseUrl: httpBaseUrl, path: "/one",
              pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
            }, [testCase(HTTP_CASE_ID, "http-用例", [{ id: "as1", target: "status", op: "eq", expected: "200" }])]),
            apiAsset(WS_API_ID, "ws-rt", {
              protocol: "websocket", baseUrl: wssUrl.replace(/\/rt$/, ""), path: "/rt",
              pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, message: '{"ping":"m5"}',
            }, [testCase(WS_CASE_ID, "ws-用例", [{ id: "as2", target: "bodyJson", op: "eq", expected: "ws-ok", path: "$.pong" }])]),
            apiAsset(SOAP_API_ID, "soap-add", {
              protocol: "soap", method: "POST", baseUrl: httpBaseUrl, path: "/soap",
              pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" },
              envelope: '<Envelope><Body><AddUser name="m5"/></Body></Envelope>', soapAction: "urn:add",
            }, [testCase(SOAP_CASE_ID, "soap-用例", [], [{
              id: "soap-response-assertion",
              type: "script",
              content: 'pm.assert(pm.response.text().includes("<id>7</id>"), "SOAP 响应应含 id=7");',
            }])]),
          ],
        }],
        workflows: [],
      }],
    }],
  };
  const initial = await fileStorage.load(root);
  await fileStorage.save(root, ws, { expectedRevision: initial.revision, deletions: [] });
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(networkPrivateRoot, { recursive: true, force: true });
  return new Promise<void>((r) => {
    wss.close(() => httpServer.close(() => r()));
  });
});

describe("多协议混合集合端到端（M5 验收）", () => {
  it("apicc run：HTTP + WS + SOAP 三用例全过（各协议由对应客户端承接）", async () => {
    const exit = await runCli(
      ["run", collectionPath, "--env", "dev"],
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
        "run-stress", soapApiPath,
        "--case", SOAP_CASE_ID, "--env", "dev", "--concurrency", "2", "--iterations", "6",
        "--allow-target", httpBaseUrl,
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
