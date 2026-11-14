// @vitest-environment jsdom
// Real local WS/SOAP execution through the formal persisted contract-asset and full-locator path.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";
import ResponseViewer from "../../src/renderer/src/components/ResponseViewer.vue";
import { createI18nInstance } from "../../src/renderer/src/i18n/index.js";
import type { DebugOutput } from "../../src/shared/types.js";
import type { ApiLocator } from "../../src/shared/locations.js";
import { IDS, makeApi, makeWorkspace, makeTempRoot, persistWorkspace, projectOne, uuid } from "./helpers/contract-assets.js";

const received: string[] = [];
let wss: WebSocketServer | undefined;
let wsBase = "";
interface SoapHit { soapAction: string | undefined; contentType: string | undefined; body: string }
const soapHits: SoapHit[] = [];
let http: Server | undefined;
let httpBase = "";
let session: ReturnType<typeof createSession>;
let root: Awaited<ReturnType<typeof makeTempRoot>> | undefined;
const mountedViewers: VueWrapper[] = [];
const caseIds: Record<string, string> = {};
const apiLocators = new Map<string, ApiLocator>();
const SOAP_API_ID = uuid(30);
const FAULT_API_ID = uuid(31);
beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }),
  });

  const websocketServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss = websocketServer;
  websocketServer.on("connection", (socket: WsSocket) => {
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString();
      received.push(text);
      socket.send(`echo:${text}`);
    });
  });
  await new Promise<void>((resolve) => websocketServer.once("listening", resolve));
  const wsAddress = websocketServer.address() as { address: string; port: number };
  wsBase = `ws://${wsAddress.address}:${wsAddress.port}`;

  const httpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/soap") {
        soapHits.push({
          soapAction: req.headers["soapaction"] as string | undefined,
          contentType: req.headers["content-type"],
          body,
        });
        res.writeHead(200, { "content-type": "text/xml" });
        res.end("<Envelope><Result>ok</Result></Envelope>");
        return;
      }
      res.writeHead(500, { "content-type": "text/xml" });
      res.end('<?xml version="1.0"?><Envelope><Fault><Code>Server</Code></Fault></Envelope>');
    });
  });
  http = httpServer;
  httpServer.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const httpAddress = httpServer.address() as { address: string; port: number };
  httpBase = `http://${httpAddress.address}:${httpAddress.port}`;

  const workspace = makeWorkspace();
  const project = projectOne(workspace);
  const collection = project.collections.find((item) => item.id === IDS.collectionOne)!;
  const environment = project.environments[0]!;
  environment.variables.token = "世界";
  delete environment.baseUrls[IDS.collectionOne];

  const wsApi = makeApi(IDS.sharedApi, "ws-echo");
  wsApi.contract.request = {
    protocol: "websocket", baseUrl: wsBase, path: "/echo",
    pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, message: "ping-{{token}}",
  };
  const soapApi = makeApi(SOAP_API_ID, "soap-do");
  soapApi.contract.request = {
    protocol: "soap", method: "POST", baseUrl: httpBase, path: "/soap",
    pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" },
    envelope: "<Envelope><body>{{token}}</body></Envelope>", soapAction: "urn:Ping",
  };
  const faultApi = makeApi(FAULT_API_ID, "soap-fault");
  faultApi.contract.request = {
    protocol: "soap", method: "POST", baseUrl: httpBase, path: "/fault",
    pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" },
    envelope: "<Envelope><body>fault-me</body></Envelope>",
  };
  collection.apis = [wsApi, soapApi, faultApi];
  root = await makeTempRoot("apicc-multi-protocol-debug-");
  await persistWorkspace(root.path, workspace);
  session = createSession();
  await session.open(root.path);

  for (const id of [IDS.sharedApi, SOAP_API_ID, FAULT_API_ID]) {
    const locator: ApiLocator = {
      workspaceId: IDS.workspace,
      groupId: IDS.groupOne,
      projectId: IDS.projectOne,
      collectionId: IDS.collectionOne,
      folderIds: [],
      apiId: id,
    };
    apiLocators.set(id, locator);
  }
  for (const api of [wsApi, soapApi, faultApi]) caseIds[api.contract.id] = api.cases[0]!.id;
});

afterEach(() => {
  const errors: unknown[] = [];
  for (const wrapper of mountedViewers.splice(0)) {
    try {
      wrapper.unmount();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "ResponseViewer wrappers failed to unmount.");
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => wss!.close((error) => error ? reject(error) : resolve()));
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (http?.listening) await new Promise<void>((resolve, reject) => http!.close((error) => error ? reject(error) : resolve()));
  } catch (error) {
    errors.push(error);
  }
  try {
    await root?.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Multi-protocol test resources failed to clean up.");
});

function mountViewer(result: DebugOutput): VueWrapper {
  const { i18n } = createI18nInstance();
  const wrapper = mount(ResponseViewer, { props: { result }, global: { plugins: [i18n] } });
  mountedViewers.push(wrapper);
  return wrapper;
}

describe("WS/SOAP sendDebug 真执行 → ResponseViewer 上屏", () => {
  it("WS：message 经环境变量解析发帧，首帧上屏且握手 101 为 status", async () => {
    const locator = apiLocators.get(IDS.sharedApi)!;
    const result = await sendDebug(session, { locator, caseId: caseIds[IDS.sharedApi]!, envName: "dev" });
    expect(received).toContain("ping-世界");
    expect(result.response?.status).toBe(101);
    expect(result.response?.bodyText).toBe("echo:ping-世界");
    expect(result.response?.headers["upgrade"]?.toLowerCase()).toContain("websocket");
    expect(result.outcome.passed).toBe(true);
    expect(result.outcome.error).toBeUndefined();

    const wrapper = mountViewer(result);
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("echo:ping-世界");
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("101");
  });

  it("SOAP：envelope/soapAction 到达服务端，HTTP 语义响应上屏", async () => {
    const locator = apiLocators.get(SOAP_API_ID)!;
    const result = await sendDebug(session, { locator, caseId: caseIds[SOAP_API_ID]!, envName: "dev" });
    expect(soapHits).toHaveLength(1);
    const hit = soapHits[0]!;
    expect(hit.soapAction).toBe("urn:Ping");
    expect(hit.contentType).toContain("text/xml");
    expect(hit.body).toContain("<Envelope><body>世界</body></Envelope>");
    expect(result.response?.status).toBe(200);
    expect(result.response?.bodyText).toContain("<Result>ok</Result>");
    expect(result.outcome.passed).toBe(true);

    const wrapper = mountViewer(result);
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("<Result>ok</Result>");
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("200");
  });

  it("SOAP fault：服务端 500 + XML 体是合法响应而非执行错误", async () => {
    const locator = apiLocators.get(FAULT_API_ID)!;
    const result = await sendDebug(session, { locator, caseId: caseIds[FAULT_API_ID]!, envName: "dev" });
    expect(result.response?.status).toBe(500);
    expect(result.response?.bodyText).toContain("<Fault>");
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.passed).toBe(true);

    const wrapper = mountViewer(result);
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("500");
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("<Fault>");
    expect(wrapper.find('[data-testid="response-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
  });
});
