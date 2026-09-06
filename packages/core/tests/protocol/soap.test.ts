import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { soapClient } from "../../src/protocol/soap.js";
import { HttpExecutionError } from "../../src/http/client.js";
import { CollectionRunner, createDefaultRegistry, createEventBus } from "../../src/index.js";
import type { Collection, Environment, Project, Workspace } from "../../src/domain/model.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

/**
 * 本地 http server 夹具（风格对照 tests/http/client.test.ts）：
 * /soap 正常回 SOAP 风格 XML；/fault 回 500 SOAP fault；
 * 服务端视角记录 method/content-type/SOAPAction/body 供请求形状断言。
 */
interface Captured {
  method: string | undefined;
  contentType: string | string[] | undefined;
  soapAction: string | string[] | undefined;
  body: string;
}
const captured: Captured[] = [];
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({
        method: req.method,
        contentType: req.headers["content-type"],
        soapAction: req.headers["soapaction"],
        body,
      });
      if (req.url === "/soap") {
        res.setHeader("content-type", "text/xml; charset=utf-8");
        res.setHeader("x-soap-probe", "ok");
        res.end('<Envelope><Body><AddUserResponse><id>42</id></AddUserResponse></Body></Envelope>');
      } else if (req.url === "/fault") {
        res.statusCode = 500;
        res.setHeader("content-type", "text/xml; charset=utf-8");
        res.end('<Envelope><Body><Fault><faultstring>boom</faultstring></Fault></Body></Envelope>');
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 5000);
      } else {
        res.statusCode = 404;
        res.end("nope");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

/** 夹具请求：envelope 为「已解析」XML 文本（变量解析在 runner，D7）。 */
function soapReq(overrides: Partial<ExecutableRequest> = {}): ExecutableRequest {
  return {
    method: "POST",
    url: `${baseUrl}/soap`,
    headers: {},
    query: [],
    protocol: "soap",
    envelope: '<Envelope><Body><AddUser name="m5"/></Body></Envelope>',
    ...overrides,
  };
}

describe("soapClient（M5 D3/D4，裁定 A）", () => {
  it("envelope 作为 XML body POST；Content-Type 缺省补 text/xml; charset=utf-8；响应透传映射", async () => {
    const res = await soapClient.execute(soapReq({ headers: { "x-probe": "m5" } }), opts);
    expect(res.status).toBe(200);
    expect(res.headers["x-soap-probe"]).toBe("ok");
    expect(res.bodyText).toContain("<id>42</id>");
    expect(res.timeMs).toBeGreaterThanOrEqual(0);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.body).toBe('<Envelope><Body><AddUser name="m5"/></Body></Envelope>');
    expect(captured[0]?.contentType).toBe("text/xml; charset=utf-8");
  });

  it("soapAction 存在 → SOAPAction 头；缺省 → 不带该头", async () => {
    captured.length = 0;
    await soapClient.execute(soapReq({ soapAction: "urn:demo/AddUser" }), opts);
    expect(captured[0]?.soapAction).toBe("urn:demo/AddUser");

    captured.length = 0;
    await soapClient.execute(soapReq(), opts);
    expect(captured[0]?.soapAction).toBeUndefined();
  });

  it("用户已显式声明 content-type → 不覆盖（SOAP 1.2 等场景的显式出口）", async () => {
    captured.length = 0;
    await soapClient.execute(soapReq({ headers: { "content-type": "application/soap+xml; charset=utf-8" } }), opts);
    expect(captured[0]?.contentType).toBe("application/soap+xml; charset=utf-8");
  });

  it("非 2xx（SOAP fault 500）→ 正常响应（HTTP 语义透传，非执行错误）", async () => {
    const res = await soapClient.execute(soapReq({ url: `${baseUrl}/fault` }), opts);
    expect(res.status).toBe(500);
    expect(res.bodyText).toContain("<faultstring>boom</faultstring>");
  });

  it("缺 envelope → 即时明确错误（fail-fast 不悬挂）", async () => {
    await expect(soapClient.execute(soapReq({ envelope: undefined }), opts)).rejects.toThrow(/envelope/);
  });

  it("端点不可达 → 委托 httpClient 的错误分类透传（HttpExecutionError），非悬挂", async () => {
    try {
      await soapClient.execute(soapReq({ url: "http://127.0.0.1:1/soap" }), { connectTimeoutMs: 1000, totalTimeoutMs: 2000 });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpExecutionError);
      expect(["refused", "unknown", "timeout"]).toContain((e as HttpExecutionError).kind);
    }
  });

  it("响应超时 → 委托 httpClient 的超时口径透传（totalTimeoutMs 约束）", async () => {
    try {
      await soapClient.execute(soapReq({ url: `${baseUrl}/slow` }), { connectTimeoutMs: 1000, totalTimeoutMs: 400 });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpExecutionError);
      expect((e as HttpExecutionError).kind).toBe("timeout");
    }
  });
});

describe("runner 分发与 envelope 变量解析（M5 D5+D7）", () => {
  it("CollectionRunner：soap 接口走 soapClient，envelope 模板经变量解析后作为请求体", async () => {
    const env: Environment = { id: "e1", name: "dev", variables: { who: "m5-soap" }, baseUrls: {} };
    const project: Project = { id: "p1", name: "p", variables: {}, environments: [env], collections: [], workflows: [] };
    const workspace: Workspace = { id: "w1", name: "ws", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
    const collection: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "soap-add", version: "1", deprecated: false,
        method: "POST", protocol: "soap", url: `${baseUrl}/soap`,
        envelope: '<Envelope><Body><AddUser name="{{who}}"/></Body></Envelope>',
        soapAction: "urn:demo/AddUser",
        headers: [], query: [], cases: [{
          id: "t1", name: "add", scope: "base", parameters: {}, assertions: [],
          postScript: 'pm.assert(pm.response.text().includes("<id>42</id>"), "响应应含 id=42");',
        }],
      }],
    };

    captured.length = 0;
    const runner = new CollectionRunner({
      registry: createDefaultRegistry(), bus: createEventBus(),
      timeouts: opts, failFast: false,
    });
    const result = await runner.run(collection, env, project, workspace, {});
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
    expect(captured[0]?.body).toBe('<Envelope><Body><AddUser name="m5-soap"/></Body></Envelope>');
    expect(captured[0]?.soapAction).toBe("urn:demo/AddUser");
  });
});
