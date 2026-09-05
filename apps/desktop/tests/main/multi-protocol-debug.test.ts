// @vitest-environment jsdom
// M5-B 任务 2（D7/D9 调试链路真执行 + D3 呈现核验，裁定 B）：主进程 sendDebug 对
// WebSocket / SOAP 接口的端到端集成——本地 ws echo server + http server 夹具（夹具
// 思路对齐 tests/main/online/e2e-server.test.ts 的「真服务端」原则与 core
// tests/protocol/websocket.test.ts 的本地 ws server），经真 core CollectionRunner
// → 协议分发（D5）→ 协议客户端执行，响应快照（afterResponse）喂给真 ResponseViewer
// 组件断言「上屏」：
// - WS：message 模板经环境变量解析（D7）后真实发帧（服务端侧记录收帧），
//   首个文本帧作为 bodyText、握手 101 作为 status（D3）上屏；
// - SOAP：envelope/soapAction 到达服务端（头与体逐项核对），HTTP 语义透传上屏；
// - SOAP fault：服务端 500 + XML 体 → 非执行错误（outcome.error 为空），
//   ResponseViewer 正常呈现 status/响应体（D3：fault 是合法响应，由断言层处理）。
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";
import type { DebugOutput } from "../../src/shared/types.js";
import ResponseViewer from "../../src/renderer/src/components/ResponseViewer.vue";
import { createI18nInstance } from "../../src/renderer/src/i18n/index.js";

// —— 本地 ws echo server：收到文本帧即回 echo:<原文>（首帧语义，D3） ——
const received: string[] = [];
let wss: WebSocketServer;
let wsUrl = "";

// —— 本地 http server：/soap 记录信封到达并回 XML；/fault 回 500 + XML fault ——
interface SoapHit { soapAction: string | undefined; contentType: string | undefined; body: string }
const soapHits: SoapHit[] = [];
let http: Server;
let httpBase = "";

let session: ReturnType<typeof createSession>;
let dir = "";
let wsApiId = "";
let soapApiId = "";
let faultApiId = "";
const caseIds: Record<string, string> = {};

beforeAll(async () => {
  // jsdom 未实现 matchMedia；ResponseViewer → antd（响应式断点）挂载需要。
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }),
  });

  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString();
      received.push(text);
      socket.send(`echo:${text}`);
    });
  });
  await new Promise<void>((r) => wss.once("listening", r));
  const addr = wss.address() as { address: string; port: number };
  wsUrl = `ws://${addr.address}:${addr.port}/echo`;

  http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/soap") {
        soapHits.push({
          soapAction: req.headers["soapaction"] as string | undefined,
          contentType: req.headers["content-type"],
          body,
        });
        res.writeHead(200, { "content-type": "text/xml" });
        res.end('<Envelope><Result>ok</Result></Envelope>');
        return;
      }
      // SOAP fault（裁定 B/D3）：500 + XML 体 = 合法响应，非执行错误
      res.writeHead(500, { "content-type": "text/xml" });
      res.end('<?xml version="1.0"?><Envelope><Fault><Code>Server</Code></Fault></Envelope>');
    });
  });
  http.listen(0, "127.0.0.1"); // node:http 不自启动监听（WebSocketServer 构造即 listen）
  await new Promise<void>((r) => http.once("listening", r));
  const httpAddr = http.address() as { address: string; port: number };
  httpBase = `http://${httpAddr.address}:${httpAddr.port}`;

  // —— 会话夹具：dev 环境（token=世界，D7 变量解析走真管线）+ 三个协议接口 ——
  session = createSession();
  dir = mkdtempSync(join(tmpdir(), "apicc-m5b-debug-"));
  await session.create(dir, "多协议调试");
  await session.open(dir);
  const g = session.createGroup("g");
  const p = session.createProject(g.id, "p");
  const c = session.createCollection(p.id, "c");
  const env = session.createEnvironment(p.id, { name: "dev" });
  session.setEnvironmentVariables(env.id, { token: "世界" });

  const wsApi = session.createApi(c.id, null, { name: "ws-echo", method: "GET", url: wsUrl });
  wsApi.protocol = "websocket";
  wsApi.message = "ping-{{token}}";
  await session.saveApi(wsApi);

  const soapApi = session.createApi(c.id, null, { name: "soap-do", method: "POST", url: `${httpBase}/soap` });
  soapApi.protocol = "soap";
  soapApi.envelope = "<Envelope><body>{{token}}</body></Envelope>";
  soapApi.soapAction = "urn:Ping";
  await session.saveApi(soapApi);

  const faultApi = session.createApi(c.id, null, { name: "soap-fault", method: "POST", url: `${httpBase}/fault` });
  faultApi.protocol = "soap";
  faultApi.envelope = "<Envelope><body>fault-me</body></Envelope>";
  await session.saveApi(faultApi);

  wsApiId = wsApi.id;
  soapApiId = soapApi.id;
  faultApiId = faultApi.id;
  for (const api of [wsApi, soapApi, faultApi]) caseIds[api.id] = api.cases[0]!.id;
}, 30_000);

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => http.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function mountViewer(result: DebugOutput): VueWrapper {
  const { i18n } = createI18nInstance();
  return mount(ResponseViewer, { props: { result }, global: { plugins: [i18n] } });
}

describe("M5-B 任务 2 调试链路：WS/SOAP sendDebug 真执行 → ResponseViewer 上屏", () => {
  it("WS：message 经环境变量解析发帧（服务端实收），首帧上屏且握手 101 为 status（D3/D7）", async () => {
    const result = await sendDebug(session, { apiId: wsApiId, caseId: caseIds[wsApiId]!, envName: "dev" });

    // 服务端侧：真实收到变量解析后的帧（D7 管线）
    expect(received).toContain("ping-世界");
    // D3 映射：status=握手 HTTP 状态、bodyText=首个文本帧、headers=握手响应头
    expect(result.response?.status).toBe(101);
    expect(result.response?.bodyText).toBe("echo:ping-世界");
    expect(result.response?.headers["upgrade"]?.toLowerCase()).toContain("websocket");
    expect(result.outcome.passed).toBe(true);
    expect(result.outcome.error).toBeUndefined();

    // 首帧上屏（ResponseViewer 既有渲染零分支）
    const wrapper = mountViewer(result);
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("echo:ping-世界");
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("101");
  });

  it("SOAP：envelope/soapAction 到达服务端（头体逐项核对），HTTP 语义响应上屏", async () => {
    const result = await sendDebug(session, { apiId: soapApiId, caseId: caseIds[soapApiId]!, envName: "dev" });

    expect(soapHits).toHaveLength(1);
    const hit = soapHits[0]!;
    expect(hit.soapAction).toBe("urn:Ping"); // soapAction → SOAPAction 头（D4）
    expect(hit.contentType).toContain("text/xml"); // 缺省补 Content-Type
    expect(hit.body).toContain("<Envelope><body>世界</body></Envelope>"); // envelope 变量解析（D7）

    expect(result.response?.status).toBe(200);
    expect(result.response?.bodyText).toContain("<Result>ok</Result>");
    expect(result.outcome.passed).toBe(true);

    const wrapper = mountViewer(result);
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("<Result>ok</Result>");
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("200");
  });

  it("SOAP fault：服务端 500 + XML 体 → 非执行错误，ResponseViewer 正常呈现（D3）", async () => {
    const result = await sendDebug(session, { apiId: faultApiId, caseId: caseIds[faultApiId]!, envName: "dev" });

    // D3 关键口径：fault 是合法响应而非执行错误——不抛错、error 为空、断言层裁决通过性
    expect(result.response?.status).toBe(500);
    expect(result.response?.bodyText).toContain("<Fault>");
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.passed).toBe(true); // 无断言 → 用例通过，状态码交由断言判定

    const wrapper = mountViewer(result);
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("500");
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("<Fault>");
    // 结果徽标仍按 outcome 渲染（fault 不触发 error 徽标）
    expect(wrapper.find('[data-testid="response-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
  });
});
