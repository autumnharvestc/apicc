// Real local WS/SOAP execution through the formal persisted contract-asset and full-locator path.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { VueWrapper } from "@vue/test-utils";
import type { Component } from "vue";
import { createSession } from "../../src/main/session.js";
import { sendDebug } from "../../src/main/debug.js";
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
let dom: MinimalJSDOM | undefined;
let mountComponent: typeof import("@vue/test-utils").mount;
let responseViewer: Component;
let createI18nInstance: typeof import("../../src/renderer/src/i18n/index.js").createI18nInstance;
const domGlobalNames = ["window", "document", "navigator", "localStorage", "getComputedStyle", "Node", "Element", "HTMLElement", "SVGElement", "ShadowRoot", "MutationObserver"] as const;
const previousDomGlobals = new Map<(typeof domGlobalNames)[number], PropertyDescriptor | undefined>();
const mountedViewers: VueWrapper[] = [];
const caseIds: Record<string, string> = {};
const apiLocators = new Map<string, ApiLocator>();
const SOAP_API_ID = uuid(30);
const FAULT_API_ID = uuid(31);
type DomWindow = Window & {
  Node: typeof Node;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  SVGElement: typeof SVGElement;
  ShadowRoot: typeof ShadowRoot;
  MutationObserver: typeof MutationObserver;
};
type MinimalJSDOM = { window: DomWindow & { close(): void } };
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => MinimalJSDOM;
};

beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  const domWindow = dom.window;
  const globals: Record<(typeof domGlobalNames)[number], unknown> = {
    window: domWindow,
    document: domWindow.document,
    navigator: domWindow.navigator,
    localStorage: domWindow.localStorage,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    SVGElement: domWindow.SVGElement,
    ShadowRoot: domWindow.ShadowRoot,
    MutationObserver: domWindow.MutationObserver,
  };
  for (const name of domGlobalNames) {
    previousDomGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value: globals[name] });
  }
  Object.defineProperty(domWindow, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }),
  });

  const testUtils = await import("@vue/test-utils");
  const i18n = await import("../../src/renderer/src/i18n/index.js");
  const vue = await import("vue");
  const compiler = await import("vue/compiler-sfc");
  const typescript = await import("typescript");
  const vueI18n = await import("vue-i18n");
  const antDesign = await import("ant-design-vue");
  const emptyState = await import("../../src/renderer/src/components/EmptyState.vue");
  mountComponent = testUtils.mount;
  createI18nInstance = i18n.createI18nInstance;
  const source = readFileSync(new URL("../../src/renderer/src/components/ResponseViewer.vue", import.meta.url), "utf8");
  const { descriptor, errors } = compiler.parse(source, { filename: "ResponseViewer.vue" });
  if (errors.length > 0 || !descriptor.template) throw new Error("Could not parse the ResponseViewer template for the manual DOM harness.");
  const compiled = compiler.compileScript(descriptor, { id: "manual-response-viewer", inlineTemplate: true });
  const moduleBody = typescript.transpileModule(compiled.content, {
    compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
  }).outputText
    .replace(/^\s*import\s+.*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/export default\s+/, "return ");
  const compileComponent = new Function(
    "vueRuntime", "vueI18n", "antDesign", "EmptyState",
    `const { defineComponent: _defineComponent, unref: _unref, createVNode: _createVNode, openBlock: _openBlock, createElementBlock: _createElementBlock, createCommentVNode: _createCommentVNode, toDisplayString: _toDisplayString, createTextVNode: _createTextVNode, withCtx: _withCtx, createBlock: _createBlock, createElementVNode: _createElementVNode, computed, ref, watch } = vueRuntime;
const { useI18n } = vueI18n;
const { Alert: AAlert, Button: AButton, Input: AInput, Select: ASelect, TabPane: ATabPane, Tabs: ATabs, Tag: ATag, Table: ATable, Typography: ATypography } = antDesign;
${moduleBody}`,
  ) as (
    vueRuntime: typeof vue,
    vueI18nRuntime: typeof vueI18n,
    antDesignRuntime: typeof antDesign,
    emptyStateComponent: Component,
  ) => Component;
  responseViewer = compileComponent(vue, vueI18n, antDesign, emptyState.default);

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
  } finally {
    for (const name of domGlobalNames) {
      const descriptor = previousDomGlobals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    previousDomGlobals.clear();
    dom?.window.close();
    dom = undefined;
  }
  if (errors.length > 0) throw new AggregateError(errors, "Multi-protocol test resources failed to clean up.");
});

function mountViewer(result: DebugOutput): VueWrapper {
  const { i18n } = createI18nInstance();
  const wrapper = mountComponent(responseViewer, { props: { result }, global: { plugins: [i18n] } });
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
