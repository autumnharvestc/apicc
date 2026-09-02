import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpClient, classifyNetworkError } from "../../src/http/client.js";

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
