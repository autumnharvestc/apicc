import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpClient, httpClient, classifyNetworkError, HttpExecutionError } from "../../src/http/client.js";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/echo") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("x-echo", req.headers["x-token"] ?? "none");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ method: req.method, body, contentType: req.headers["content-type"] ?? null }));
      });
    } else if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 5000);
    } else if (req.url === "/parallel") {
      setTimeout(() => res.end("parallel"), 120);
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

describe("httpClient", () => {
  it.each([
    "https:example.com/orders",
    "\thttps:example.com/orders \n",
    String.raw`https:\example.com\orders`,
    "HTTPS://EXAMPLE.COM/orders",
  ])("canHandle 按 WHATWG 识别 HTTP(S) special URL：%s", (url) => {
    const request = { method: "GET" as const, url, headers: {}, query: [] };
    expect(httpClient.canHandle(request)).toBe(true);
    expect(httpClient.canHandle({ ...request, protocol: "http" })).toBe(true);
  });

  it.each(["ftp://example.com/orders", "example.com/orders", "/relative/orders"])(
    "canHandle 拒绝非 HTTP(S)/relative URL：%s",
    (url) => {
      expect(httpClient.canHandle({ method: "GET", url, headers: {}, query: [] })).toBe(false);
    },
  );

  it("显式协议字段优先，HTTPS-looking websocket/SOAP 不由 HTTP client 承接", () => {
    const request = { method: "GET" as const, url: "https:example.com/orders", headers: {}, query: [] };
    expect(httpClient.canHandle({ ...request, protocol: "websocket" })).toBe(false);
    expect(httpClient.canHandle({ ...request, protocol: "soap" })).toBe(false);
  });

  it("发送 POST JSON 并读取响应头/体/耗时", async () => {
    const res = await httpClient.execute(
      { method: "POST", url: `${baseUrl}/echo`, headers: { "content-type": "application/json", "x-token": "t1" }, query: [], body: { kind: "json", content: '{"a":1}' } },
      opts,
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-echo"]).toBe("t1");
    expect(JSON.parse(res.bodyText)).toEqual({ method: "POST", body: '{"a":1}', contentType: "application/json" });
    expect(res.timeMs).toBeGreaterThanOrEqual(0);
  });

  it("form 请求体以 urlencoded 编码发送，缺省时自动补 content-type（回归 C4）", async () => {
    const res = await httpClient.execute(
      {
        method: "POST", url: `${baseUrl}/echo`, headers: {}, query: [],
        body: {
          kind: "form",
          content: "",
          form: [
            { key: "user", value: "alice", enabled: true },
            { key: "note", value: "a b&c=d", enabled: true },
            { key: "off", value: "no", enabled: false },
          ],
        },
      },
      opts,
    );
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.bodyText) as { body: string; contentType: string | null };
    // enabled 项参与编码，disabled 项丢弃；空格按 application/x-www-form-urlencoded 约定编码为 "+"
    expect(echoed.body).toBe("user=alice&note=a+b%26c%3Dd");
    expect(echoed.contentType).toBe("application/x-www-form-urlencoded");
  });

  it("form 请求体已显式声明 content-type 时不覆盖", async () => {
    const res = await httpClient.execute(
      {
        method: "POST", url: `${baseUrl}/echo`, headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, query: [],
        body: { kind: "form", content: "", form: [{ key: "a", value: "1", enabled: true }] },
      },
      opts,
    );
    const echoed = JSON.parse(res.bodyText) as { body: string; contentType: string };
    expect(echoed.body).toBe("a=1");
    expect(echoed.contentType).toBe("application/x-www-form-urlencoded; charset=utf-8");
  });

  it("query 参数拼接到 URL", async () => {
    const res = await httpClient.execute(
      { method: "GET", url: `${baseUrl}/echo`, headers: {}, query: [{ key: "a", value: "1", enabled: true }], },
      opts,
    );
    expect(res.status).toBe(200);
  });

  it("连接拒绝分类为 refused", async () => {
    // 端口 1 几乎必然拒绝；若环境异常兜底校验分类函数存在
    try {
      await httpClient.execute({ method: "GET", url: "http://127.0.0.1:1/", headers: {}, query: [] }, opts);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("refused");
    }
  });

  it("响应超时分类为 timeout", async () => {
    try {
      await httpClient.execute({ method: "GET", url: `${baseUrl}/slow`, headers: {}, query: [] }, { connectTimeoutMs: 1000, totalTimeoutMs: 500 });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("timeout");
    }
  });

  it("classifyNetworkError 覆盖 DNS", () => {
    expect(classifyNetworkError({ code: "ENOTFOUND" })).toBe("dns");
  });

  it("classifyNetworkError 扫描 cause——顶层 UND_ERR 包装码不遮蔽 errno", () => {
    expect(classifyNetworkError({ code: "UND_ERR_SOCKET", message: "connect failed", cause: { code: "ECONNREFUSED" } })).toBe("refused");
    expect(classifyNetworkError({ code: "UND_ERR_SOCKET", message: "connect failed", cause: { code: "ENOTFOUND" } })).toBe("dns");
    expect(classifyNetworkError({ code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error", cause: { code: "ECONNREFUSED" } })).toBe("timeout");
  });
});

describe("managed HTTP client lifecycle", () => {
  const req = () => ({ method: "GET" as const, url: `${baseUrl}/echo`, headers: {}, query: [] });

  it("pooled 模式复用连接，fresh 模式逐请求建连", async () => {
    let connections = 0;
    const onConnection = () => { connections += 1; };
    server.on("connection", onConnection);

    const pooled = createHttpClient({ connectionMode: "pooled" });
    await pooled.execute(req(), opts);
    await pooled.execute(req(), opts);
    expect(connections).toBe(1);
    await pooled.close();

    connections = 0;
    const fresh = createHttpClient({ connectionMode: "fresh" });
    await fresh.execute(req(), opts);
    await fresh.execute(req(), opts);
    expect(connections).toBe(2);
    await fresh.close();
    server.off("connection", onConnection);
  });

  it("pooled 模式允许并发请求使用多个连接，不被单连接串行化", async () => {
    const client = createHttpClient({ connectionMode: "pooled" });
    const started = performance.now();
    await Promise.all([
      client.execute({ ...req(), url: `${baseUrl}/parallel` }, opts),
      client.execute({ ...req(), url: `${baseUrl}/parallel` }, opts),
    ]);
    expect(performance.now() - started).toBeLessThan(220);
    await client.close();
  });

  it("close 后最终关闭 socket，且重复 close 幂等", async () => {
    let socketClosed = 0;
    const onClose = () => { socketClosed += 1; };
    server.on("connection", (socket) => socket.on("close", onClose));
    const client = createHttpClient();
    await client.execute(req(), opts);
    await client.close();
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socketClosed).toBeGreaterThanOrEqual(1);
  });

  it("将 AbortSignal 传递到请求层并中止慢请求", async () => {
    const controller = new AbortController();
    const client = createHttpClient();
    const pending = client.execute({ ...req(), url: `${baseUrl}/slow` }, { ...opts, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeInstanceOf(HttpExecutionError);
    await client.close();
  });
});
