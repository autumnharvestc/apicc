import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpClient, httpClient, classifyNetworkError, HttpExecutionError } from "../../src/http/client.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Agent } from "undici";
import type { Dispatcher } from "undici";
import { captureRequestFiles } from "../../src/http/files.js";
import { createHttpSession } from "../../src/http/session.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

type HttpRequest = Extract<ExecutableRequest, { protocol: "http" }>;
const httpRequest = (url: string, overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  protocol: "http", method: "GET", url, headers: {}, query: [], auth: { kind: "none" }, ...overrides,
});

it("forks a private Cookie snapshot without child or sibling writeback", async () => {
  const parent = createHttpSession();
  await parent.storeResponseCookies("https://example.com/", [["set-cookie", "login=parent; Path=/"]]);
  const left = await parent.fork(); const right = await parent.fork();
  try {
    expect(await left.getCookieHeader("https://example.com/")).toBe("login=parent");
    await left.storeResponseCookies("https://example.com/", [["set-cookie", "login=left; Path=/"]]);
    await parent.storeResponseCookies("https://example.com/", [["set-cookie", "later=parent; Path=/"]]);
    expect(await left.getCookieHeader("https://example.com/")).toBe("login=left");
    expect(await right.getCookieHeader("https://example.com/")).toBe("login=parent");
    expect(await parent.getCookieHeader("https://example.com/")).toBe("login=parent; later=parent");
    expect((await left.listCookies())[0]).not.toHaveProperty("value");
  } finally { await left.close(); await right.close(); await parent.close(); }
  await expect(parent.fork()).rejects.toThrow(/closed/);
});

let server: Server;
let secondServer: Server;
let baseUrl = "";
let secondBaseUrl = "";
const uploadRecords: Array<{ path: string; method: string; body: Buffer; contentType: string | undefined }> = [];
const observedWireRequests: Array<{ headers: import("node:http").IncomingHttpHeaders; body: Buffer }> = [];
const cancelHits: string[] = [];

async function readBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/redirect307") {
      uploadRecords.push({ path, method: req.method ?? "", body: await readBody(req), contentType: req.headers["content-type"] });
      res.writeHead(307, { location: "/upload-sink", "content-type": "text/plain; charset=utf-8" });
      res.end("redirect hop");
    } else if (path === "/redirect303") {
      await readBody(req);
      res.writeHead(303, { location: "/echo" });
      res.end();
    } else if (path === "/redirect-cross-origin") {
      res.writeHead(302, { location: `${secondBaseUrl}/inspect?token=leak&keep=1` });
      res.end();
    } else if (path === "/redirect-cancel") {
      cancelHits.push(path);
      res.writeHead(302, { location: "/cancel-final" });
      res.end();
    } else if (path === "/cancel-final") {
      cancelHits.push(path);
      res.end("unexpected");
    } else if (path === "/cookie-set") {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("stored");
    } else if (path === "/cookie-echo") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? "" }));
    } else if (path === "/observe") {
      const body = await readBody(req);
      observedWireRequests.push({ headers: { ...req.headers }, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cookie: req.headers.cookie, contentType: req.headers["content-type"], body: body.toString() }));
    } else if (path === "/json-primitive") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("42");
    } else if (path === "/slow-headers") {
      setTimeout(() => { res.setHeader("content-type", "text/plain"); res.end("late"); }, 150);
    } else if (path === "/slow-body") {
      res.setHeader("content-type", "text/plain");
      res.write("first");
      setTimeout(() => res.end("second"), 150);
    } else if (path === "/upload-sink" || path === "/multipart-sink") {
      const body = await readBody(req);
      uploadRecords.push({ path, method: req.method ?? "", body, contentType: req.headers["content-type"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method, body: body.toString("base64"), contentType: req.headers["content-type"] }));
    } else if (path === "/too-large") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": "10", "x-limit-proof": "present" });
      res.end("0123456789");
    } else if (path === "/gzip-too-large") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync("x".repeat(256)));
    } else if (path === "/echo") {
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
  secondServer = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie }));
  });
  await new Promise<void>((r) => secondServer.listen(0, "127.0.0.1", r));
  secondBaseUrl = `http://127.0.0.1:${(secondServer.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  secondServer.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => secondServer.close(() => r())),
  ]);
});

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

describe("httpClient", () => {
  it.each([
    "https:example.com/orders",
    "\thttps:example.com/orders \n",
    String.raw`https:\example.com\orders`,
    "HTTPS://EXAMPLE.COM/orders",
  ])("canHandle 按 WHATWG 识别 HTTP(S) special URL：%s", (url) => {
    expect(httpClient.canHandle(httpRequest(url))).toBe(true);
    const missingProtocol = { method: "GET", url, headers: {}, query: [], auth: { kind: "none" } } as unknown as ExecutableRequest;
    expect(httpClient.canHandle(missingProtocol)).toBe(false);
  });

  it.each(["ftp://example.com/orders", "example.com/orders", "/relative/orders"])(
    "canHandle 拒绝非 HTTP(S)/relative URL：%s",
    (url) => {
      expect(httpClient.canHandle(httpRequest(url))).toBe(false);
    },
  );

  it("显式协议字段优先，HTTPS-looking websocket/SOAP 不由 HTTP client 承接", () => {
    const websocket: ExecutableRequest = { protocol: "websocket", url: "https:example.com/orders", headers: {}, query: [], auth: { kind: "none" } };
    const soap: ExecutableRequest = { protocol: "soap", method: "POST", envelope: "", url: "https:example.com/orders", headers: {}, query: [], auth: { kind: "none" } };
    expect(httpClient.canHandle(websocket)).toBe(false);
    expect(httpClient.canHandle(soap)).toBe(false);
  });

  it("发送 POST JSON 并读取响应头/体/耗时", async () => {
    const res = await httpClient.execute(
      httpRequest(`${baseUrl}/echo`, { method: "POST", headers: { "content-type": "application/json", "x-token": "t1" }, body: { kind: "json", content: '{"a":1}' } }),
      opts,
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-echo"]).toBe("t1");
    expect(JSON.parse(res.bodyText)).toEqual({ method: "POST", body: '{"a":1}', contentType: "application/json" });
    expect(res.timeMs).toBeGreaterThanOrEqual(0);
  });

  it("binary 文件经 307 重发时两跳都收到相同文件字节", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-file-"));
    const filePath = join(root, "payload.bin");
    const expected = Buffer.from([0, 1, 127, 128, 254, 255]);
    await writeFile(filePath, expected);
    uploadRecords.length = 0;
    const fileReference = { path: "payload.bin" };
    const request = httpRequest(`${baseUrl}/redirect307`, {
      method: "POST",
      body: { kind: "binary", file: fileReference, contentType: "application/octet-stream" } as never,
    });
    const captured = await captureRequestFiles(request, { workspaceRoot: root, uploadLimitBytes: 64 });
    const client = createHttpClient();
    const responseObservations: unknown[] = [];
    try {
      const response = await client.execute(request, {
        ...opts,
        followRedirects: true, maxRedirects: 10, uploadLimitBytes: 64,
        runtime: { files: captured, observe(event) { if (event.type === "response") responseObservations.push(event); } },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.bodyText).body).toBe(expected.toString("base64"));
      expect(uploadRecords.map(({ method }) => method)).toEqual(["POST", "POST"]);
      expect(uploadRecords.map(({ body }) => body)).toEqual([expected, expected]);
      expect(responseObservations[0]).toMatchObject({
        hopIndex: 0, status: 307, bodyComplete: true, bodyText: "redirect hop", textAvailable: true, jsonAvailable: false,
      });
      expect(Array.from((responseObservations[0] as { bodyBytes?: Uint8Array }).bodyBytes ?? []))
        .toEqual([...Buffer.from("redirect hop")]);
      expect(responseObservations[0]).toMatchObject({
        requestBody: { fileBytesRead: expected.byteLength, transportEncodedBytesWritten: expected.byteLength, complete: true },
        requestBodyChain: { fileBytesRead: expected.byteLength, transportEncodedBytesWritten: expected.byteLength, complete: true },
      });
      expect(responseObservations[1]).toMatchObject({
        hopIndex: 1, status: 200, bodyComplete: true, textAvailable: true, jsonAvailable: true,
        requestBody: { fileBytesRead: expected.byteLength, transportEncodedBytesWritten: expected.byteLength, complete: true },
        requestBodyChain: { fileBytesRead: expected.byteLength * 2, transportEncodedBytesWritten: expected.byteLength * 2, complete: true },
      });
    } finally {
      await client.close();
      await captured.close();
      expect(() => captured.get(fileReference)!.openStream()).toThrow(
        expect.objectContaining({ code: "FILE_SOURCE_NOT_REPLAYABLE" }),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redirect prepare 拒绝时失败归属新 hop 的零正文进度且保留已完成首跳", async () => {
    uploadRecords.length = 0;
    const observations: unknown[] = [];
    await expect(httpClient.execute(httpRequest(`${baseUrl}/redirect307`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: { kind: "raw", content: "abc" },
    }), {
      ...opts,
      followRedirects: true,
      runtime: {
        observe(event) { observations.push(event); },
        beforeRedirect() { throw Object.assign(new Error("redirect rejected for test"), { code: "REDIRECT_REJECTED" }); },
      },
    })).rejects.toMatchObject({ code: "REDIRECT_REJECTED", stage: "redirect-prepare" });

    expect(uploadRecords.map(({ path, body }) => [path, body.toString()])).toEqual([["/redirect307", "abc"]]);
    const priorResponse = observations.find((event) => (event as { type?: string }).type === "response");
    expect(priorResponse).toMatchObject({
      hopIndex: 0,
      requestBody: { fileBytesRead: 0, transportEncodedBytesWritten: 3, complete: true },
      requestBodyChain: { fileBytesRead: 0, transportEncodedBytesWritten: 3, complete: true },
    });
    const failure = observations.find((event) => (event as { type?: string }).type === "failure") as { response?: unknown } | undefined;
    expect(failure).toMatchObject({
      hopIndex: 1,
      stage: "redirect-prepare",
      requestBody: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: false },
      requestBodyChain: { fileBytesRead: 0, transportEncodedBytesWritten: 3, complete: false },
    });
    expect(failure?.response).toBeUndefined();
  });

  it("multipart 按启用项顺序发送重复名和 binary 文件的原始字节", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-multipart-"));
    const filePath = join(root, "photo.bin");
    const binary = Buffer.from([0, 0x41, 0x80, 0xff]);
    await writeFile(filePath, binary);
    const request = httpRequest(`${baseUrl}/multipart-sink`, {
      method: "POST",
      body: {
        kind: "multipart",
        entries: [
          { kind: "text", id: "text-1", name: "tag", value: "first", enabled: true },
          { kind: "text", id: "text-2", name: "tag", value: "", enabled: true },
          { kind: "file", id: "file-1", name: "photo", file: { path: "photo.bin" }, contentType: "application/octet-stream", enabled: true },
          { kind: "text", id: "text-3", name: "off", value: "ignored", enabled: false },
        ],
      } as never,
    });
    const captured = await captureRequestFiles(request, { workspaceRoot: root, uploadLimitBytes: 64 });
    const client = createHttpClient();
    let requestBodyObservation: unknown;
    uploadRecords.length = 0;
    try {
      const response = await client.execute(request, {
        ...opts,
        uploadLimitBytes: 64,
        runtime: { files: captured, observe(event) { if (event.type === "response") requestBodyObservation = event.requestBody; } },
      });
      const body = Buffer.from(JSON.parse(response.bodyText).body, "base64");
      const text = body.toString("latin1");
      expect(text.indexOf('name="tag"')).toBeLessThan(text.indexOf("first"));
      expect(text.indexOf("first")).toBeLessThan(text.indexOf('name="tag"', text.indexOf('name="tag"') + 1));
      expect(body.includes(binary)).toBe(true);
      expect(text).not.toContain("ignored");
      expect(JSON.parse(response.bodyText).contentType).toContain("multipart/form-data; boundary=");
      expect(requestBodyObservation).toMatchObject({ fileBytesRead: binary.byteLength, complete: true });
      expect((requestBodyObservation as { transportEncodedBytesWritten?: number }).transportEncodedBytesWritten)
        .toBe(uploadRecords[0]!.body.byteLength);
      expect((requestBodyObservation as { transportEncodedBytesWritten?: number }).transportEncodedBytesWritten)
        .toBeGreaterThan(binary.byteLength);
    } finally {
      await client.close();
      await captured.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("取消真实文件上传后关闭捕获句柄与活动文件流", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-cancel-file-"));
    const filePath = join(root, "upload.bin");
    await writeFile(filePath, Buffer.alloc(1024 * 1024, 0x41));
    let resolveFirstChunk: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => { resolveFirstChunk = resolve; });
    const uploadServer = createServer((request) => {
      request.once("data", () => { request.pause(); resolveFirstChunk?.(); });
    });
    await new Promise<void>((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
    const uploadUrl = `http://127.0.0.1:${(uploadServer.address() as { port: number }).port}/cancel`;
    const fileReference = { path: "upload.bin" };
    const request = httpRequest(uploadUrl, {
      method: "POST",
      body: { kind: "binary", file: fileReference, contentType: "application/octet-stream" } as never,
    });
    let captured: Awaited<ReturnType<typeof captureRequestFiles>> | undefined;
    let client: ReturnType<typeof createHttpClient> | undefined;
    const controller = new AbortController();
    let attempt: Promise<unknown> | undefined;
    try {
      captured = await captureRequestFiles(request, { workspaceRoot: root, uploadLimitBytes: 2 * 1024 * 1024 });
      client = createHttpClient();
      attempt = client.execute(request, {
        ...opts, signal: controller.signal, uploadLimitBytes: 2 * 1024 * 1024, runtime: { files: captured },
      });
      attempt.catch(() => undefined);
      await within(firstChunk, 2000, "server did not observe file upload bytes");
      controller.abort();
      const failure = await within(attempt.then(() => { throw new Error("cancelled upload unexpectedly completed"); }, (error) => error), 2000, "cancelled upload did not settle");
      expect(failure).toMatchObject({ code: "REQUEST_ABORTED", networkStarted: true });
    } finally {
      controller.abort();
      await attempt?.catch(() => undefined);
      await client?.close();
      await captured?.close();
      expect(() => captured?.get(fileReference)!.openStream()).toThrow(expect.objectContaining({ code: "FILE_SOURCE_NOT_REPLAYABLE" }));
      uploadServer.closeAllConnections();
      await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 8000);

  it("读取中的累计上传限额失败后回收真实 multipart 文件资源", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-limit-file-"));
    const filePath = join(root, "part.bin");
    await writeFile(filePath, Buffer.from("12345"));
    let resolveAborted: (() => void) | undefined;
    const requestAborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
    let receivedBytes = 0;
    const uploadServer = createServer((request) => {
      request.on("data", (chunk) => { receivedBytes += Buffer.byteLength(chunk); });
      request.once("aborted", () => resolveAborted?.());
    });
    await new Promise<void>((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
    const uploadUrl = `http://127.0.0.1:${(uploadServer.address() as { port: number }).port}/limit`;
    const firstReference = { path: "part.bin" };
    const secondReference = { path: "part.bin" };
    const request = httpRequest(uploadUrl, {
      method: "POST",
      body: {
        kind: "multipart",
        entries: [
          { kind: "file", id: "part-1", name: "part", file: firstReference, contentType: "application/octet-stream", enabled: true },
          { kind: "file", id: "part-2", name: "part", file: secondReference, contentType: "application/octet-stream", enabled: true },
        ],
      } as never,
    });
    let captured: Awaited<ReturnType<typeof captureRequestFiles>> | undefined;
    let client: ReturnType<typeof createHttpClient> | undefined;
    let failureObservation: unknown;
    try {
      captured = await captureRequestFiles(request, { workspaceRoot: root, uploadLimitBytes: 5 });
      client = createHttpClient();
      let failure: unknown;
      try {
        await client.execute(request, {
          ...opts, uploadLimitBytes: 5,
          runtime: { files: captured, observe(event) { if (event.type === "failure") failureObservation = event; } },
        });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "UPLOAD_LIMIT_EXCEEDED", stage: "request-body" });
      await within(requestAborted, 1000, "server did not observe stream termination after the read-time limit");
      expect(receivedBytes).toBeGreaterThan(0);
      expect(failureObservation).toMatchObject({
        requestBody: { fileBytesRead: 10, complete: false },
        requestBodyChain: { fileBytesRead: 10, complete: false },
      });
    } finally {
      await client?.close();
      await captured?.close();
      expect(() => captured?.get(firstReference)!.openStream()).toThrow(expect.objectContaining({ code: "FILE_SOURCE_NOT_REPLAYABLE" }));
      uploadServer.closeAllConnections();
      await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 8000);

  it("响应解码后超过上限时用机器码失败且不返回部分响应体", async () => {
    let failureObservation: unknown;
    await expect(httpClient.execute(httpRequest(`${baseUrl}/too-large`), {
      ...opts,
      responseLimitBytes: 4,
      runtime: { observe(event) { if (event.type === "failure") failureObservation = event; } },
    })).rejects.toMatchObject({ code: "RESPONSE_LIMIT_EXCEEDED", stage: "response-body" });
    expect(failureObservation).toMatchObject({
      response: {
        status: 200, declaredLength: 10, bodyComplete: false, encodedBytes: 10,
        rawHeaders: expect.arrayContaining([["x-limit-proof", "present"]]),
      },
    });
  });

  it("可靠文本中的 JSON primitive 可标记为可消费 JSON", async () => {
    const response = await httpClient.execute(httpRequest(`${baseUrl}/json-primitive`), opts);
    expect(response.textAvailable).toBe(true);
    expect(response.bodyText).toBe("42");
    expect(response.jsonAvailable).toBe(true);
  });

  it("gzip 解压后的响应超过上限也拒绝整个响应", async () => {
    let failure: unknown;
    try {
      await httpClient.execute(httpRequest(`${baseUrl}/gzip-too-large`), {
        ...opts, responseLimitBytes: 32,
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "RESPONSE_LIMIT_EXCEEDED", stage: "response-body" });
    expect((failure as { encodedBytes?: number }).encodedBytes).toBeGreaterThan(0);
    expect((failure as { encodedBytes?: number }).encodedBytes).toBeLessThanOrEqual(32);
    expect((failure as { decodedBytes?: number }).decodedBytes).toBeGreaterThan(32);
  });

  it("session 保存重复 Set-Cookie，参数 Cookie 同名覆盖 jar 而显式 Cookie 不合并", async () => {
    const session = createHttpSession();
    const client = createHttpClient();
    try {
      const stored = await client.execute(httpRequest(`${baseUrl}/cookie-set`), { ...opts, runtime: { session } });
      expect(stored.rawHeaders?.filter(([name]) => name.toLowerCase() === "set-cookie")).toHaveLength(2);
      const parameters = await client.execute(httpRequest(`${baseUrl}/cookie-echo`, {
        headers: { Cookie: "a=override; c=3" }, cookieHeaderMode: "parameters",
      }), { ...opts, runtime: { session } });
      expect(JSON.parse(parameters.bodyText).cookie).toBe("a=override; b=2; c=3");
      const explicit = await client.execute(httpRequest(`${baseUrl}/cookie-echo`, {
        headers: { Cookie: "manual=only" }, cookieHeaderMode: "explicit",
      }), { ...opts, runtime: { session } });
      expect(JSON.parse(explicit.bodyText).cookie).toBe("manual=only");
      const cookieSummaries = await session.listCookies();
      expect(cookieSummaries.map(({ name }) => name).sort()).toEqual(["a", "b"]);
      expect(cookieSummaries.every((cookie) => !Object.hasOwn(cookie, "value"))).toBe(true);
      expect(cookieSummaries[0]).toMatchObject({ domain: "127.0.0.1", path: "/", httpOnly: false, secure: false });
      await session.clearCookies();
      expect(await session.getCookieHeader(`${baseUrl}/cookie-echo`)).toBeUndefined();
    } finally {
      await session.close();
      await client.close();
    }
  });

  it("request observation 是独立 DTO，包含最终编码头和 jar Cookie", async () => {
    const session = createHttpSession();
    const client = createHttpClient();
    const request = httpRequest(`${baseUrl}/observe`, {
      method: "POST",
      body: { kind: "form", content: "", form: [{ key: "name", value: "Ada Lovelace", enabled: true }] },
    });
    let observedRequest: HttpRequest | undefined;
    let observedHeaders: Record<string, string> | undefined;
    let observedBodyValue: string | undefined;
    observedWireRequests.length = 0;
    try {
      await client.execute(httpRequest(`${baseUrl}/cookie-set`), { ...opts, runtime: { session } });
      await client.execute(request, {
        ...opts,
        runtime: {
          session,
          observe(event) {
            if (event.type !== "request") return;
            observedRequest = event.request as HttpRequest;
            observedHeaders = { ...observedRequest.headers };
            if (observedRequest.body?.kind === "form") observedBodyValue = observedRequest.body.form[0]?.value;
            observedRequest.headers.cookie = "observer-only=synthetic";
            if (observedRequest.body?.kind === "form") observedRequest.body.form[0]!.value = "mutated";
          },
        },
      });
      expect(observedRequest).not.toBe(request);
      expect(observedRequest?.headers).not.toBe(request.headers);
      expect(observedHeaders).toMatchObject({
        "content-type": "application/x-www-form-urlencoded",
        cookie: "a=1; b=2",
      });
      expect(observedHeaders?.host).toBeUndefined();
      expect(observedHeaders?.["user-agent"]).toBeUndefined();
      expect(observedBodyValue).toBe("Ada Lovelace");
      expect(request.headers).toEqual({});
      expect(request.body?.kind === "form" ? request.body.form[0]?.value : undefined).toBe("Ada Lovelace");
      expect(observedWireRequests).toHaveLength(1);
      expect(observedWireRequests[0]!.headers.cookie).toBe("a=1; b=2");
      expect(observedWireRequests[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    } finally {
      await client.close();
      await session.close();
    }
  });

  it("跨 origin redirect 剥离显式认证/Cookie 和认证 query key", async () => {
    const request = httpRequest(`${baseUrl}/redirect-cross-origin`, {
      headers: { Authorization: "Bearer synthetic", Cookie: "secret=synthetic" },
      query: [{ key: "token", value: "synthetic", enabled: true }],
      auth: { kind: "apikey", name: "token", placement: "query", value: "synthetic" },
      cookieHeaderMode: "explicit",
    });
    const response = await httpClient.execute(request, {
      ...opts, followRedirects: true,
    });
    expect(JSON.parse(response.bodyText)).toEqual({ url: "/inspect?keep=1", authorization: undefined, cookie: undefined });
  });

  it("收到 303 后 POST 转 GET 且不重发请求体", async () => {
    const response = await httpClient.execute(httpRequest(`${baseUrl}/redirect303`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: { kind: "raw", content: "payload" },
    }), { ...opts, followRedirects: true });
    expect(JSON.parse(response.bodyText)).toMatchObject({ method: "GET", body: "" });
  });

  it("收到首跳响应后取消，不发送后续 redirect hop", async () => {
    const controller = new AbortController();
    cancelHits.length = 0;
    await expect(httpClient.execute(httpRequest(`${baseUrl}/redirect-cancel`), {
      ...opts, followRedirects: true, signal: controller.signal,
      runtime: { observe(event) { if (event.type === "response") controller.abort(); } },
    })).rejects.toMatchObject({ code: "REQUEST_ABORTED", networkStarted: true });
    expect(cancelHits).toEqual(["/redirect-cancel"]);
  });

  it("headers 和 body idle 超时报告对应阶段", async () => {
    await expect(httpClient.execute(httpRequest(`${baseUrl}/slow-headers`), {
      ...opts, headersTimeoutMs: 20,
    })).rejects.toMatchObject({ code: "UND_ERR_HEADERS_TIMEOUT", stage: "response-headers", networkStarted: true });
    await expect(httpClient.execute(httpRequest(`${baseUrl}/slow-body`), {
      ...opts, bodyTimeoutMs: 20,
    })).rejects.toMatchObject({ code: "UND_ERR_BODY_TIMEOUT", stage: "response-body", networkStarted: true });
  });

  it("连接超时在受控本地 DNS 解析阶段触发", async () => {
    let lookupStarted = false;
    let resolutionFinished = false;
    let lookupTimer: ReturnType<typeof setTimeout> | undefined;
    const lookup: NonNullable<NonNullable<Parameters<typeof createHttpClient>[0]>["lookup"]> = (_hostname, lookupOptions, callback) => {
      lookupStarted = true;
      lookupTimer = setTimeout(() => {
        resolutionFinished = true;
        if (lookupOptions.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      }, 120);
    };
    const client = createHttpClient({ connectionMode: "fresh", lookup });
    try {
      let caught: unknown;
      try { await client.execute(httpRequest(`${baseUrl.replace("127.0.0.1", "controlled.local")}/echo`), {
        connectTimeoutMs: 20, totalTimeoutMs: 1000,
      }); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: "UND_ERR_CONNECT_TIMEOUT", stage: "connect", networkStarted: true });
      expect(lookupStarted).toBe(true);
      expect(resolutionFinished).toBe(false);
    } finally {
      if (lookupTimer !== undefined) clearTimeout(lookupTimer);
      await client.close();
    }
  });

  it("form 请求体以 urlencoded 编码发送，缺省时自动补 content-type（回归 C4）", async () => {
    const res = await httpClient.execute(
      httpRequest(`${baseUrl}/echo`, {
        method: "POST",
        body: {
          kind: "form",
          content: "",
          form: [
            { key: "user", value: "alice", enabled: true },
            { key: "note", value: "a b&c=d", enabled: true },
            { key: "off", value: "no", enabled: false },
          ],
        },
      }),
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
      httpRequest(`${baseUrl}/echo`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: { kind: "form", content: "", form: [{ key: "a", value: "1", enabled: true }] },
      }),
      opts,
    );
    const echoed = JSON.parse(res.bodyText) as { body: string; contentType: string };
    expect(echoed.body).toBe("a=1");
    expect(echoed.contentType).toBe("application/x-www-form-urlencoded; charset=utf-8");
  });

  it("query 参数拼接到 URL", async () => {
    const res = await httpClient.execute(
      httpRequest(`${baseUrl}/echo`, { query: [{ key: "a", value: "1", enabled: true }] }),
      opts,
    );
    expect(res.status).toBe(200);
  });

  it("连接拒绝分类为 refused", async () => {
    // 端口 1 几乎必然拒绝；若环境异常兜底校验分类函数存在
    try {
      await httpClient.execute(httpRequest("http://127.0.0.1:1/"), opts);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("refused");
    }
  });

  it("响应超时分类为 timeout", async () => {
    try {
      await httpClient.execute(httpRequest(`${baseUrl}/slow`), { connectTimeoutMs: 1000, totalTimeoutMs: 500 });
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
  const req = () => httpRequest(`${baseUrl}/echo`);

  it("does not count another pooled request's connected socket as this request's headers phase", async () => {
    let arrivals = 0;
    let releaseFirst: (() => void) | undefined;
    let firstArrival: (() => void) | undefined;
    const firstArrived = new Promise<void>((resolve) => { firstArrival = resolve; });
    const firstResponseReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const serverResponses: Array<import("node:http").ServerResponse> = [];
    const phaseServer = createServer((request, response) => {
      arrivals += 1;
      serverResponses.push(response);
      request.resume();
      if (arrivals === 1) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("first response is still active");
        firstArrival?.();
        void firstResponseReady.then(() => response.end(" done"));
      } else {
        response.setHeader("content-type", "text/plain");
        request.on("end", () => response.end("second response"));
      }
    });
    await new Promise<void>((resolve) => phaseServer.listen(0, "127.0.0.1", resolve));
    const phaseUrl = `http://phase.test:${(phaseServer.address() as { port: number }).port}`;
    let lookups = 0;
    const lookup: import("node:net").LookupFunction = (_hostname, options, callback) => {
      lookups += 1;
      const resolveLoopback = () => options.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4);
      if (lookups === 2) setTimeout(resolveLoopback, 80);
      else resolveLoopback();
    };
    const client = createHttpClient({ connectionMode: "pooled", lookup });
    const phaseRequest = () => httpRequest(`${phaseUrl}/phase`);
    const first = client.execute(phaseRequest(), {
      connectTimeoutMs: 300, headersTimeoutMs: 30, bodyTimeoutMs: 500, totalTimeoutMs: 2000,
    });
    first.catch(() => undefined);
    let second: ReturnType<typeof client.execute> | undefined;
    try {
      await Promise.race([
        firstArrived,
        first.then(() => Promise.reject(new Error("first response completed before the overlap barrier"))),
        first.then(undefined, (error) => Promise.reject(error)),
      ]);
      second = client.execute(phaseRequest(), {
        connectTimeoutMs: 300, headersTimeoutMs: 30, bodyTimeoutMs: 500, totalTimeoutMs: 2000,
      });
      const result = await second;
      expect(result.bodyText).toBe("second response");
      expect(lookups).toBe(2);
    } finally {
      releaseFirst?.();
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
      await client.close();
      for (const response of serverResponses) {
        if (!response.writableEnded) response.end();
      }
      phaseServer.closeAllConnections();
      await new Promise<void>((resolve) => phaseServer.close(() => resolve()));
    }
  });

  it("pooled 模式复用连接，fresh 模式逐请求建连", async () => {
    const lifecycleServer = createServer((request, response) => {
      request.resume();
      request.on("end", () => { response.setHeader("content-type", "text/plain"); response.end("ok"); });
    });
    await new Promise<void>((resolve) => lifecycleServer.listen(0, "127.0.0.1", resolve));
    const lifecycleUrl = `http://127.0.0.1:${(lifecycleServer.address() as { port: number }).port}/echo`;
    const lifecycleRequest = () => httpRequest(lifecycleUrl);
    let connections = 0;
    const onConnection = () => { connections += 1; };
    lifecycleServer.on("connection", onConnection);
    try {
      const pooled = createHttpClient({ connectionMode: "pooled" });
      await pooled.execute(lifecycleRequest(), opts);
      expect(connections).toBe(1);
      await pooled.execute(lifecycleRequest(), opts);
      expect(connections).toBe(1);
      await pooled.close();

      connections = 0;
      const fresh = createHttpClient({ connectionMode: "fresh" });
      await fresh.execute(lifecycleRequest(), opts);
      await fresh.execute(lifecycleRequest(), opts);
      expect(connections).toBe(2);
      await fresh.close();
    } finally {
      lifecycleServer.off("connection", onConnection);
      lifecycleServer.closeAllConnections();
      await new Promise<void>((resolve) => lifecycleServer.close(() => resolve()));
    }
  });

  it("池仅保留 16 个闲置 dispatcher、不驱逐在途租用并由 close 全量回收", async () => {
    const created: Array<{ closed: number; destroyed: number }> = [];
    const dispatcherFactory = () => {
      const target = new Agent();
      const record = { closed: 0, destroyed: 0 };
      created.push(record);
      return new Proxy(target, {
        get(dispatcher, property) {
          if (property === "close") return async () => { record.closed += 1; await dispatcher.close(); };
          if (property === "destroy") return async (error?: Error) => { record.destroyed += 1; await dispatcher.destroy(error ?? new Error("test dispatcher destroyed")); };
          const value = Reflect.get(dispatcher, property, dispatcher);
          return typeof value === "function" ? value.bind(dispatcher) : value;
        },
      }) as Dispatcher;
    };
    const holdServer = createServer((_request, response) => {
      if (_request.url === "/hold") {
        heldResponse = response;
        resolveArrival();
        return;
      }
      response.end("ok");
    });
    let heldResponse: import("node:http").ServerResponse | undefined;
    let resolveArrival!: () => void;
    const arrived = new Promise<void>((resolve) => { resolveArrival = resolve; });
    await new Promise<void>((resolve, reject) => {
      holdServer.once("error", reject);
      holdServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = holdServer.address();
    if (!address || typeof address === "string") throw new Error("The dispatcher lease fixture did not bind a TCP port.");
    const url = `http://127.0.0.1:${address.port}`;
    const client = createHttpClient({ dispatcherFactory });
    let active: Promise<unknown> | undefined;
    try {
      active = client.execute(httpRequest(`${url}/hold`), { ...opts, connectTimeoutMs: 1_000 });
      active.catch(() => undefined);
      await arrived;
      const activeDispatcher = created[0];
      expect(activeDispatcher).toBeDefined();

      for (let index = 0; index < 17; index += 1) {
        await client.execute(httpRequest(`${url}/idle-${index}`), { ...opts, connectTimeoutMs: 1_100 + index });
      }

      expect(created).toHaveLength(18);
      expect(activeDispatcher).toEqual({ closed: 0, destroyed: 0 });
      expect(created.filter((dispatcher) => dispatcher.closed + dispatcher.destroyed > 0)).toHaveLength(1);

      await client.close();
      await active.catch(() => undefined);
      expect(activeDispatcher).toEqual({ closed: 0, destroyed: 1 });
      expect(created.every((dispatcher) => dispatcher.closed + dispatcher.destroyed > 0)).toBe(true);
    } finally {
      heldResponse?.end("released");
      await active?.catch(() => undefined);
      await client.close();
      holdServer.closeAllConnections();
      await new Promise<void>((resolve) => holdServer.close(() => resolve()));
    }
  });

  it("pooled 模式允许并发请求使用多个连接，不被单连接串行化", async () => {
    let barrierServer: Server | undefined;
    let barrierBaseUrl = "";
    let barrierClient: ReturnType<typeof createHttpClient> | undefined;
    let controller: AbortController | undefined;
    const sockets = new Set<Socket>();
    const socketCloseHandlers = new Map<Socket, () => void>();
    const heldResponses: Array<import("node:http").ServerResponse> = [];
    const responseFinishHandlers = new Map<import("node:http").ServerResponse, () => void>();
    let arrivals = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    let releaseResponses: (() => void) | undefined;
    let resolveReleaseGate: (() => void) | undefined;
    let resolveTwoArrivals: (() => void) | undefined;
    let rejectTwoArrivals: ((error: Error) => void) | undefined;
    let barrierRequestHandler: ((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void) | undefined;
    let barrierServerErrorHandler: ((error: Error) => void) | undefined;
    const pendingRequests: Array<ReturnType<ReturnType<typeof createHttpClient>["execute"]>> = [];
    const onBarrierConnection = (socket: Socket) => {
      const onSocketClose = () => sockets.delete(socket);
      sockets.add(socket);
      socketCloseHandlers.set(socket, onSocketClose);
      socket.on("close", onSocketClose);
    };
    const twoArrivals = new Promise<void>((resolve, reject) => {
      resolveTwoArrivals = resolve;
      rejectTwoArrivals = reject;
    });
    twoArrivals.catch(() => undefined);
    const timeout = setTimeout(() => rejectTwoArrivals?.(new Error("timed out waiting for two in-flight requests")), 2000);
    const releaseGate = new Promise<void>((resolve) => { resolveReleaseGate = resolve; });
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    const protectCleanup = async (cleanup: () => void | Promise<void>) => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    try {
      barrierRequestHandler = (request, response) => {
        if (request.url !== "/parallel") {
          response.statusCode = 404;
          response.end("nope");
          return;
        }
        arrivals += 1;
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        heldResponses.push(response);
        const onResponseFinish = () => { inFlight -= 1; };
        responseFinishHandlers.set(response, onResponseFinish);
        response.on("finish", onResponseFinish);
        request.resume();
        if (arrivals === 2) resolveTwoArrivals?.();
      };
      barrierServer = createServer(barrierRequestHandler);
      barrierServer.on("connection", onBarrierConnection);
      await new Promise<void>((resolve, reject) => {
        barrierServerErrorHandler = reject;
        barrierServer?.on("error", barrierServerErrorHandler);
        barrierServer?.listen(0, "127.0.0.1", resolve);
      });
      barrierServer.off("error", barrierServerErrorHandler!);
      barrierServerErrorHandler = undefined;
      barrierBaseUrl = `http://127.0.0.1:${(barrierServer.address() as { port: number }).port}`;
      releaseResponses = () => {
        for (const response of heldResponses) {
          if (!response.writableEnded) {
            response.setHeader("content-type", "text/plain; charset=utf-8");
            response.end("parallel");
          }
        }
      };
      controller = new AbortController();
      barrierClient = createHttpClient({ connectionMode: "pooled" });
      const requestOptions = { ...opts, signal: controller.signal };
      for (let i = 0; i < 2; i += 1) {
        const pending = barrierClient.execute({ ...req(), url: `${barrierBaseUrl}/parallel` }, requestOptions);
        pending.catch(() => undefined);
        pendingRequests.push(pending);
      }
      const requestSettlesEarly = pendingRequests.map((pending, index) => pending.then(
        () => { throw new Error(`request ${index + 1} fulfilled before the overlap barrier`); },
        (error) => { throw error; },
      ));
      await Promise.race([twoArrivals, ...requestSettlesEarly]);
      expect(arrivals).toBe(2);
      expect(peakInFlight).toBe(2);
      resolveReleaseGate?.();
      await releaseGate;
      releaseResponses();
      const completed = await Promise.all(pendingRequests);
      expect(completed.map((response) => ({ status: response.status, body: response.bodyText }))).toEqual([
        { status: 200, body: "parallel" },
        { status: 200, body: "parallel" },
      ]);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await protectCleanup(() => clearTimeout(timeout));
      await protectCleanup(() => controller?.abort());
      await protectCleanup(() => releaseResponses?.());
      await protectCleanup(async () => { await Promise.allSettled(pendingRequests); });
      await protectCleanup(async () => { if (barrierClient) await barrierClient.close(); });
      await protectCleanup(() => {
        if (barrierServerErrorHandler && barrierServer) barrierServer.off("error", barrierServerErrorHandler);
        if (barrierServer && barrierRequestHandler) barrierServer.off("request", barrierRequestHandler);
        if (barrierServer) barrierServer.off("connection", onBarrierConnection);
        for (const [response, handler] of responseFinishHandlers) response.off("finish", handler);
        for (const [socket, handler] of socketCloseHandlers) socket.off("close", handler);
        for (const socket of sockets) socket.destroy();
      });
      await protectCleanup(async () => {
        if (barrierServer?.listening) await new Promise<void>((resolve) => barrierServer?.close(() => resolve()));
      });
      if (primaryError === undefined && cleanupErrors.length > 0) throw cleanupErrors[0];
    }
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
