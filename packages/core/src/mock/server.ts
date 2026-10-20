import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

import type { CompiledMockPlan, CompiledMockRoute, CompiledMockRule } from "./compile.js";
import type { MockCondition, MockDiagnostic } from "./config.js";

const HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ACTIVE_REQUESTS = 64;
const MAX_LOG_ENTRIES = 200;
const STOP_TIMEOUT_MS = 5_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export type MockServerState = "starting" | "running" | "reloading" | "invalid" | "stopping" | "stopped";

export interface StartMockServerOptions {
  port?: number;
  signal?: AbortSignal;
}

export interface MockRequestLog {
  readonly requestId: string;
  readonly time: string;
  readonly method: string;
  readonly routeTemplate?: string;
  readonly contractId?: string;
  readonly ruleId?: string;
  readonly responseBindingId?: string;
  readonly status: number;
  readonly durationMs: number;
  readonly revision: string;
  readonly reason: string;
}

export interface MockServerHandle {
  readonly address: AddressInfo;
  readonly status: MockServerState;
  beginReload(): void;
  reload(nextPlan: CompiledMockPlan): Promise<void>;
  invalidate(diagnostics: readonly MockDiagnostic[]): void;
  logs(): readonly MockRequestLog[];
  stop(): Promise<void>;
}

export class MockServerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MockServerError";
  }
}

type BodyReadResult = { ok: true; bytes: Buffer } | { ok: false; reason: "REQUEST_TOO_LARGE" };
type DecodedTarget = { pathSegments: string[]; query: URLSearchParams } | { error: "MALFORMED_REQUEST_TARGET" | "MALFORMED_PATH_ENCODING" };
type PathMatch = Record<string, string> | undefined;

export async function startMockServer(plan: CompiledMockPlan, options: StartMockServerOptions = {}): Promise<MockServerHandle> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new MockServerError("MOCK_PORT_INVALID", "The Mock server port must be 0 or an integer from 1 through 65535.");
  }
  if (options.signal?.aborted) throw new MockServerError("MOCK_START_ABORTED", "The Mock server start was aborted.");

  let state: MockServerState = "starting";
  let currentPlan = plan;
  let activeRequests = 0;
  let stopPromise: Promise<void> | undefined;
  let onSignalAbort: (() => void) | undefined;
  const requestControllers = new Set<AbortController>();
  const logEntries: MockRequestLog[] = [];
  const server: Server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.destroyed && !response.headersSent) sendStatus(response, request.method ?? "GET", 500);
      else if (!response.destroyed) response.destroy();
    });
  });

  const requestedPort = port;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new MockServerError("MOCK_PORT_IN_USE", `The Mock server port ${requestedPort} is already in use.`));
      } else {
        reject(new MockServerError("MOCK_LISTEN_FAILED", "The Mock server could not listen on the requested loopback port."));
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: HOST, port, exclusive: true });
  });

  const boundAddress = server.address();
  if (!boundAddress || typeof boundAddress === "string") {
    await closeServer(server);
    throw new MockServerError("MOCK_LISTEN_FAILED", "The Mock server did not receive a TCP address.");
  }
  const address: AddressInfo = { ...boundAddress };
  state = "running";
  server.on("error", () => {
    if (state === "running" || state === "reloading") state = "invalid";
  });

  const appendLog = (record: MockRequestLog): void => {
    logEntries.push(Object.freeze(record));
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  };

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const requestPlan = currentPlan;
    const revision = requestPlan.sourceProjectRevision;
    const method = request.method ?? "GET";
    let route: CompiledMockRoute | undefined;
    let routeTemplate: string | undefined;
    let contractId: string | undefined;
    let rule: CompiledMockRule | undefined;
    let responseBindingId: string | undefined;
    let logged = false;
    let requestController: AbortController | undefined;

    const finish = (status: number, reason: string): void => {
      if (logged) return;
      logged = true;
      appendLog({
        requestId,
        time: new Date().toISOString(),
        method,
        ...(routeTemplate ? { routeTemplate } : {}),
        ...(contractId ? { contractId } : {}),
        ...(rule ? { ruleId: rule.id } : {}),
        ...(responseBindingId ? { responseBindingId } : {}),
        status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        revision,
        reason,
      });
    };

    const sendAndFinish = async (
      status: number,
      reason: string,
      send: () => void,
    ): Promise<void> => {
      const completed = await sendAndWait(response, send);
      finish(
        completed ? status : 0,
        completed ? reason : requestController?.signal.aborted || isStopping(state) ? "CANCELLED" : "CONNECTION_CLOSED",
      );
    };
    const cancelAndFinish = async (): Promise<void> => {
      if (!response.destroyed && !response.writableEnded) response.destroy();
      await waitForResponseCompletion(response);
      finish(0, "CANCELLED");
    };

    if (state !== "running") {
      const reason = state === "reloading" ? "RELOADING" : state === "invalid" ? "INVALID" : "STOPPING";
      request.resume();
      await sendAndFinish(503, reason, () => sendStatus(response, method, 503));
      return;
    }

    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      request.resume();
      await sendAndFinish(429, "ACTIVE_REQUEST_LIMIT", () => sendStatus(response, method, 429));
      return;
    }

    activeRequests += 1;
    requestController = new AbortController();
    requestControllers.add(requestController);
    const onRequestAborted = (): void => requestController?.abort();
    request.once("aborted", onRequestAborted);
    const onRequestError = (): void => undefined;
    request.on("error", onRequestError);
    const onResponseClose = (): void => {
      if (!response.writableEnded) requestController?.abort();
    };
    response.once("close", onResponseClose);

    try {
      const bodyResult = await readRequestBody(request);
      if (!bodyResult.ok) {
        await sendAndFinish(413, bodyResult.reason, () => sendStatus(response, method, 413, true));
        return;
      }
      if (requestController.signal.aborted || isStopping(state)) {
        await cancelAndFinish();
        return;
      }

      const target = decodeTarget(request.url ?? "");
      if ("error" in target) {
        await sendAndFinish(400, target.error, () => sendStatus(response, method, 400));
        return;
      }

      const pathParameters = findRoute(requestPlan.routes, method, target.pathSegments, (matchedRoute) => {
        route = matchedRoute;
        routeTemplate = matchedRoute.pathTemplate;
        contractId = matchedRoute.contractId;
      });
      if (!pathParameters || !route) {
        await sendAndFinish(404, "NO_ROUTE", () => sendStatus(response, method, 404));
        return;
      }

      let parsedBody: unknown;
      let bodyIsParsed = false;
      let bodyParseFailed = false;
      const parseBody = (): boolean => {
        if (bodyIsParsed) return !bodyParseFailed;
        bodyIsParsed = true;
        try {
          parsedBody = JSON.parse(bodyResult.bytes.toString("utf8")) as unknown;
          return true;
        } catch {
          bodyParseFailed = true;
          return false;
        }
      };

      const headerValues = (name: string): string[] => requestHeaderValues(request, name);
      const queryValues = (name: string): string[] => target.query.getAll(name);
      rule = route.rules.find((candidate) => candidate.conditions.every((condition) => {
        if (condition.source === "body" && !parseBody()) return false;
        return matchesCondition(condition, pathParameters, queryValues, headerValues, parsedBody);
      }));
      if (!rule) {
        await sendAndFinish(501, "NO_RULE_MATCH", () => sendStatus(response, method, 501));
        return;
      }
      responseBindingId = rule.responseBindingId;

      if (!await waitForDelay(rule.delayMs, requestController.signal)) {
        await cancelAndFinish();
        return;
      }
      if (requestController.signal.aborted || isStopping(state) || response.destroyed) {
        await cancelAndFinish();
        return;
      }

      if (rule.body.length > MAX_RESPONSE_BYTES) {
        await sendAndFinish(500, "INVALID_PLAN_RESPONSE_TOO_LARGE", () => sendStatus(response, method, 500));
        return;
      }
      const body = method === "HEAD" || rule.status === 204 || rule.status === 304 ? Buffer.alloc(0) : Buffer.from(rule.body);
      const responseCompletion = waitForResponseCompletion(response);
      try {
        sendCompiledResponse(response, rule, body);
      } catch {
        if (!response.headersSent && !response.destroyed) {
          try {
            sendStatus(response, method, 500);
          } catch {
            if (!response.destroyed) response.destroy();
          }
          const completed = await responseCompletion;
          finish(completed ? 500 : 0, completed ? "INVALID_PLAN_RESPONSE" : "CONNECTION_CLOSED");
        } else {
          if (!response.destroyed) response.destroy();
          await responseCompletion;
          finish(0, "INVALID_PLAN_RESPONSE");
        }
        return;
      }
      const completed = await responseCompletion;
      finish(
        completed ? rule.status : 0,
        completed ? "MATCHED" : requestController.signal.aborted || isStopping(state) ? "CANCELLED" : "CONNECTION_CLOSED",
      );
    } catch {
      if (isStopping(state) || response.destroyed) await cancelAndFinish();
      else await sendAndFinish(400, "INVALID_REQUEST_BODY", () => sendStatus(response, method, 400));
    } finally {
      if (requestController) requestControllers.delete(requestController);
      request.off("aborted", onRequestAborted);
      request.off("error", onRequestError);
      response.off("close", onResponseClose);
      activeRequests -= 1;
    }
  }

  function beginReload(): void {
    if (state === "running" || state === "invalid") state = "reloading";
  }

  async function reload(nextPlan: CompiledMockPlan): Promise<void> {
    if (state === "stopping" || state === "stopped") throw new MockServerError("MOCK_SERVER_STOPPED", "A stopped Mock server cannot be reloaded.");
    state = "reloading";
    currentPlan = nextPlan;
    state = "running";
  }

  function invalidate(_diagnostics: readonly MockDiagnostic[]): void {
    if (state !== "stopping" && state !== "stopped") state = "invalid";
  }

  function logs(): readonly MockRequestLog[] {
    return Object.freeze(logEntries.slice());
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    if (state === "stopped") return Promise.resolve();
    state = "stopping";
    if (options.signal && onSignalAbort) options.signal.removeEventListener("abort", onSignalAbort);
    for (const controller of requestControllers) controller.abort();
    stopPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.closeAllConnections();
        state = "stopped";
        reject(new MockServerError("MOCK_STOP_TIMEOUT", "The Mock server did not stop within five seconds."));
      }, STOP_TIMEOUT_MS);
      timer.unref();
      server.close((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          state = "stopped";
          reject(new MockServerError("MOCK_STOP_FAILED", "The Mock server could not close its listener."));
          return;
        }
        state = "stopped";
        resolve();
      });
      server.closeAllConnections();
    });
    return stopPromise;
  }

  const handle: MockServerHandle = {
    address,
    get status() { return state; },
    beginReload,
    reload,
    invalidate,
    logs,
    stop,
  };
  if (options.signal) {
    onSignalAbort = (): void => { void stop().catch(() => undefined); };
    options.signal.addEventListener("abort", onSignalAbort, { once: true });
    if (options.signal.aborted) onSignalAbort();
  }
  return handle;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readRequestBody(request: IncomingMessage): Promise<BodyReadResult> {
  const contentLength = request.headers["content-length"];
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const rejectTooLarge = (): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      request.pause();
      resolve({ ok: false, reason: "REQUEST_TOO_LARGE" });
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (totalBytes + bytes.byteLength > MAX_REQUEST_BYTES) {
        rejectTooLarge();
        return;
      }
      totalBytes += bytes.byteLength;
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true, bytes: Buffer.concat(chunks, totalBytes) });
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Request body aborted."));
    };
    if (contentLength !== undefined && Number(contentLength) > MAX_REQUEST_BYTES) {
      rejectTooLarge();
      return;
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function decodeTarget(target: string): DecodedTarget {
  if (!target.startsWith("/")) return { error: "MALFORMED_REQUEST_TARGET" };
  const queryIndex = target.indexOf("?");
  const rawPath = queryIndex < 0 ? target : target.slice(0, queryIndex);
  const rawSegments = rawPath.split("/");
  let pathSegments: string[];
  try {
    pathSegments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return { error: "MALFORMED_PATH_ENCODING" };
  }
  return { pathSegments, query: new URLSearchParams(queryIndex < 0 ? "" : target.slice(queryIndex + 1)) };
}

function findRoute(
  routes: readonly CompiledMockRoute[],
  method: string,
  pathSegments: readonly string[],
  onMatch: (route: CompiledMockRoute) => void,
): PathMatch {
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== pathSegments.length) continue;
    const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
    let matches = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index]!;
      const value = pathSegments[index]!;
      if (segment.kind === "literal") {
        if (segment.value !== value) {
          matches = false;
          break;
        }
      } else parameters[segment.name] = value;
    }
    if (matches) {
      onMatch(route);
      return parameters;
    }
  }
  return undefined;
}

function requestHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name.toLowerCase()) values.push(request.rawHeaders[index + 1]!);
  }
  return values;
}

function matchesCondition(
  condition: MockCondition,
  pathParameters: Record<string, string>,
  queryValues: (name: string) => string[],
  headerValues: (name: string) => string[],
  body: unknown,
): boolean {
  if (condition.source === "body") {
    const pointer = resolveJsonPointer(body, condition.pointer);
    if (condition.op === "exists") return pointer.found;
    return pointer.found && pointer.value === condition.value;
  }
  let values: string[];
  if (condition.source === "path") values = Object.hasOwn(pathParameters, condition.name) ? [pathParameters[condition.name]!] : [];
  else if (condition.source === "query") values = queryValues(condition.name);
  else values = headerValues(condition.name);
  if (condition.op === "exists") return values.length > 0;
  return values.some((value) => value === condition.value);
}

function resolveJsonPointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  const tokens = pointer === "" ? [] : pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = root;
  for (const token of tokens) {
    if (typeof value !== "object" || value === null) return { found: false };
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= value.length) return { found: false };
      value = value[index];
      continue;
    }
    if (!Object.hasOwn(value, token)) return { found: false };
    value = (value as Record<string, unknown>)[token];
  }
  return { found: true, value };
}

function sendCompiledResponse(response: ServerResponse, rule: CompiledMockRule, body: Buffer): void {
  const connectionTokens = new Set<string>();
  for (const [name, value] of Object.entries(rule.headers)) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) connectionTokens.add(token.trim().toLowerCase());
    }
  }
  for (const [name, value] of Object.entries(rule.headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || key === "content-type" || connectionTokens.has(key)) continue;
    response.setHeader(name, value);
  }
  response.statusCode = rule.status;
  response.setHeader("Content-Type", rule.mediaType);
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function sendStatus(response: ServerResponse, method: string, status: number, closeConnection = false): void {
  const messages: Record<number, string> = {
    400: "Bad Request",
    404: "Not Found",
    413: "Payload Too Large",
    429: "Too Many Requests",
    500: "Internal Server Error",
    501: "Mock Rule Not Matched",
    503: "Service Unavailable",
  };
  const body = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(messages[status] ?? "Request Rejected", "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  if (closeConnection) {
    response.shouldKeepAlive = false;
    response.setHeader("Connection", "close");
  }
  response.end(body);
}

function sendAndWait(response: ServerResponse, send: () => void): Promise<boolean> {
  const completion = waitForResponseCompletion(response);
  try {
    send();
  } catch {
    if (!response.destroyed) response.destroy();
  }
  return completion;
}

function waitForResponseCompletion(response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      response.off("finish", onFinish);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(completed);
    };
    const onFinish = (): void => settle(true);
    const onClose = (): void => settle(response.writableFinished);
    const onError = (): void => {
      if (!response.destroyed) response.destroy();
    };
    response.once("finish", onFinish);
    response.once("close", onClose);
    response.once("error", onError);
    if (response.closed) settle(response.writableFinished);
  });
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(!signal.aborted);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isStopping(state: MockServerState): boolean {
  return state === "stopping" || state === "stopped";
}
