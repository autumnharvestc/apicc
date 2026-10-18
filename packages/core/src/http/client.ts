import { randomUUID } from "node:crypto";
import type { LookupFunction } from "node:net";
import { request } from "undici";
import type { Dispatcher } from "undici";
import type {
  ExecutableRequest, ExecutionResponse, HttpExecuteOptions, HttpHopObservation,
  HttpCapturedFileMetadata, HttpIncompleteResponseObservation, HttpRequestBodyObservation, ProtocolClient,
} from "../plugin/types.js";
import { resolveRequestSettings } from "../request/settings.js";
import { canHandleProtocol } from "../protocol/index.js";
import type { PreparedNetworkResolution, PreparedNetworkTLS } from "../network/prepare.js";
import { prepareHttpBody, type UploadBudget } from "./body.js";
import { HttpDispatcherPool, type HttpDispatcherFactory, type HttpDispatcherLease } from "./dispatchers.js";
import { legacyHeaders, rawHeaderPairs, readBoundedResponseBody } from "./response.js";

export type HttpErrorKind = "dns" | "refused" | "timeout" | "tls" | "unknown";

export interface HttpExecutionErrorOptions {
  code?: string;
  stage?: string;
  networkStarted?: boolean;
  attemptTimeMs?: number;
}

export class HttpExecutionError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly networkStarted: boolean;
  readonly attemptTimeMs: number;
  readonly caseFailureKind?: "config";
  readonly encodedBytes?: number;
  readonly decodedBytes?: number;

  constructor(public kind: HttpErrorKind, cause: unknown, options: HttpExecutionErrorOptions = {}) {
    super(`请求失败（${kind}）: ${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.name = "HttpExecutionError";
    const details = cause as { code?: unknown; stage?: unknown; caseFailureKind?: unknown; encodedBytes?: unknown; decodedBytes?: unknown };
    this.code = options.code ?? (typeof details?.code === "string" ? details.code : kind === "timeout" ? "REQUEST_TIMEOUT" : "HTTP_REQUEST_FAILED");
    this.stage = options.stage ?? (typeof details?.stage === "string" ? details.stage : "request");
    this.networkStarted = options.networkStarted ?? false;
    this.attemptTimeMs = options.attemptTimeMs ?? 0;
    if (details?.caseFailureKind === "config") this.caseFailureKind = "config";
    if (typeof details?.encodedBytes === "number") this.encodedBytes = details.encodedBytes;
    if (typeof details?.decodedBytes === "number") this.decodedBytes = details.decodedBytes;
  }
}

export function classifyNetworkError(e: unknown): HttpErrorKind {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const codes = [String(err.code ?? ""), String(err.cause?.code ?? "")];
  const msg = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  const precise = codes.find((code) => ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code) || code.includes("TIMEOUT"));
  if (precise === "ECONNREFUSED") return "refused";
  if (precise === "ENOTFOUND" || precise === "EAI_AGAIN") return "dns";
  if (precise) return "timeout";
  if (/ECONNREFUSED/.test(msg)) return "refused";
  if (/timed?\s?out|timeout/i.test(msg)) return "timeout";
  if (/TLS|CERT/.test(codes.join(" ")) || /tls|certificate/i.test(msg)) return "tls";
  return "unknown";
}

export interface HttpClientOptions {
  connectionMode?: "pooled" | "fresh";
  /** Host resolver override, also useful for bounded local connection fixtures. */
  lookup?: LookupFunction;
  /** Internal dispatcher seam for lifecycle tests; production should omit it. */
  dispatcherFactory?: HttpDispatcherFactory;
}

export interface ManagedProtocolClient extends ProtocolClient {
  close(): Promise<void>;
}

type HttpRequest = Extract<ExecutableRequest, { protocol: "http" }>;

function buildUrl(req: HttpRequest): string {
  const qs = req.query
    .filter((pair) => pair.enabled && pair.key !== "")
    .map((pair) => `${encodeURIComponent(pair.key)}=${encodeURIComponent(pair.value)}`)
    .join("&");
  return qs ? `${req.url}${req.url.includes("?") ? "&" : "?"}${qs}` : req.url;
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === name);
}

function setHeader(headers: Record<string, string>, name: string, value: string | undefined): void {
  const key = headerKey(headers, name.toLowerCase());
  if (key !== undefined) delete headers[key];
  if (value !== undefined) headers[name] = value;
}

function cookieHeader(headers: Record<string, string>): string | undefined {
  const key = headerKey(headers, "cookie");
  if (key === undefined) return undefined;
  return headers[key];
}

function mergeCookieValues(jar: string | undefined, parameters: string | undefined): string | undefined {
  if (!jar) return parameters;
  if (!parameters) return jar;
  const merged = new Map<string, string>();
  for (const source of [jar, parameters]) {
    for (const part of source.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      const name = part.slice(0, separator).trim();
      if (name) merged.set(name, part.slice(separator + 1).trim());
    }
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
}

function hasUnshadowedSessionCookie(jar: string | undefined, supplied: string | undefined): boolean {
  if (!jar) return false;
  const names = (value: string) => value.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    const name = (separator <= 0 ? "" : part.slice(0, separator)).trim();
    return name ? [name] : [];
  });
  const suppliedNames = new Set(names(supplied ?? ""));
  return jar.split(";").some((part) => {
    const separator = part.indexOf("=");
    const name = (separator <= 0 ? "" : part.slice(0, separator)).trim();
    return Boolean(name) && !suppliedNames.has(name);
  });
}

function cloneRequest(req: HttpRequest): HttpRequest {
  return {
    ...req,
    headers: { ...req.headers },
    query: req.query.map((pair) => ({ ...pair })),
    auth: { ...req.auth },
    ...(req.body === undefined ? {} : { body: req.body.kind === "form" ? { ...req.body, form: req.body.form.map((pair) => ({ ...pair })) } : { ...req.body } }),
  };
}

function cloneHttpBody(body: NonNullable<HttpRequest["body"]>): NonNullable<HttpRequest["body"]> {
  if (body.kind === "form") return { ...body, form: body.form.map((pair) => ({ ...pair })) };
  if (body.kind === "binary") return { ...body, file: { ...body.file } };
  if (body.kind === "multipart") {
    return {
      ...body,
      entries: body.entries.map((entry) => entry.kind === "file"
        ? { ...entry, file: { ...entry.file } }
        : { ...entry }),
    };
  }
  return { ...body };
}

function cloneRequestForObservation(request: HttpRequest): HttpRequest {
  const observed = cloneRequest(request);
  if (request.body !== undefined) observed.body = cloneHttpBody(request.body);
  return observed;
}

function capturedFileMetadata(request: HttpRequest, files: NonNullable<HttpExecuteOptions["runtime"]>["files"]): HttpCapturedFileMetadata[] {
  const body = request.body;
  if (!body) return [];
  const uses = body.kind === "binary"
    ? [{ entryIndex: 0, file: body.file, effectiveFilename: undefined }]
    : body.kind === "multipart"
      ? body.entries.flatMap((entry, entryIndex) => entry.enabled === false || entry.kind !== "file"
        ? []
        : [{ entryIndex, file: entry.file, effectiveFilename: entry.filename }])
      : [];
  return uses.map((use) => {
    let captured;
    try { captured = files?.get(use.file); }
    catch { captured = undefined; }
    if (!captured) return { entryIndex: use.entryIndex, available: false };
    return {
      entryIndex: use.entryIndex,
      available: true,
      capturedFilename: captured.filename,
      capturedSizeBytes: captured.size,
      effectiveFilename: use.effectiveFilename ?? captured.filename,
    };
  });
}

function transformRedirect(request: HttpRequest, status: number, fromUrl: string, location: string): { request: HttpRequest; url: string; fromUrl: string; originChanged: boolean } {
  const next = cloneRequest(request);
  const from = new URL(fromUrl);
  const to = new URL(location, from);
  const originChanged = from.origin !== to.origin;
  let method = next.method;
  if (status === 303 && method !== "HEAD") method = "GET";
  if ((status === 301 || status === 302) && method === "POST") method = "GET";
  if (method !== next.method) {
    next.method = method;
    delete next.body;
    for (const name of ["content-type", "content-length", "content-encoding", "transfer-encoding"]) {
      const key = headerKey(next.headers, name);
      if (key) delete next.headers[key];
    }
  }
  next.url = to.href;
  next.query = [];
  if (originChanged) {
    for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2"]) {
      const key = headerKey(next.headers, name);
      if (key) delete next.headers[key];
    }
    if (next.auth.kind === "apikey") {
      if (next.auth.placement === "header") {
        const key = headerKey(next.headers, next.auth.name.toLowerCase());
        if (key) delete next.headers[key];
      } else {
        const auth = next.auth;
        to.searchParams.delete(auth.name);
        next.url = to.href;
      }
    }
    next.auth = { kind: "none" };
    next.cookieHeaderMode = "none";
  }
  return { request: next, url: next.url, fromUrl, originChanged };
}

function responseValue(status: number, headers: Record<string, string>, rawHeaders: readonly (readonly [string, string])[], body: Awaited<ReturnType<typeof readBoundedResponseBody>>, timeMs: number): ExecutionResponse {
  return {
    status,
    headers,
    bodyText: body.textAvailable ? body.text : "",
    timeMs,
    bodyBytes: body.bytes,
    textAvailable: body.textAvailable,
    jsonAvailable: body.jsonAvailable,
    rawHeaders,
    encodedBytes: body.encodedBytes,
    decodedBytes: body.decodedBytes,
    ...(body.declaredLength === undefined ? {} : { declaredLength: body.declaredLength }),
  };
}

export function createHttpClient(options: HttpClientOptions = {}): ManagedProtocolClient {
  const connectionMode = options.connectionMode ?? "pooled";
  const pool = new HttpDispatcherPool(connectionMode, options.dispatcherFactory);
  const defaultTLS: PreparedNetworkTLS = Object.freeze({
    verify: true,
    caMode: "append-runtime-defaults",
    caCertificates: Object.freeze([]),
    clientCertificates: Object.freeze([]),
  });

  return {
    name: "http",
    canHandle: (req) => {
      if (!canHandleProtocol(req, "http")) return false;
      try {
        const protocol = new URL(req.url).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch { return false; }
    },
    async execute(req, opts) {
      if (req.protocol !== "http") {
        throw Object.assign(new Error(`HTTP 客户端不能执行 ${req.protocol} 请求`), { caseFailureKind: "config" as const, code: "CONFIG", stage: "request-prepare" });
      }
      const settings = resolveRequestSettings({}, {
        connectTimeoutMs: opts.connectTimeoutMs,
        totalTimeoutMs: opts.totalTimeoutMs,
        ...(opts.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: opts.headersTimeoutMs }),
        ...(opts.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: opts.bodyTimeoutMs }),
        ...(opts.followRedirects === undefined ? {} : { followRedirects: opts.followRedirects }),
        ...(opts.maxRedirects === undefined ? {} : { maxRedirects: opts.maxRedirects }),
        ...(opts.uploadLimitBytes === undefined ? {} : { uploadLimitBytes: opts.uploadLimitBytes }),
        ...(opts.responseLimitBytes === undefined ? {} : { responseLimitBytes: opts.responseLimitBytes }),
      });
      const uploadBudget: UploadBudget = { limitBytes: settings.uploadLimitBytes, uploadedFileBytes: 0 };
      const requestBodyChain: HttpRequestBodyObservation = { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true };
      let completedRequestBodyChain = true;
      let requestBodyProgress: HttpRequestBodyObservation = { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: false };
      let responseFailureObservation: HttpIncompleteResponseObservation | undefined;
      const boundary = req.body?.kind === "multipart" ? `----apicc-${randomUUID()}` : undefined;
      const isFresh = connectionMode === "fresh";
      let currentRequest: HttpRequest = req;
      let currentUrl = buildUrl(req);
      let hopIndex = 0;
      let networkStarted = false;
      let networkStartedAt: number | undefined;
      let currentStage = "request-prepare";
      let totalTimeoutExpired = false;
      let connectTimeoutExpired = false;
      let headersTimeoutExpired = false;
      let totalTimeout: ReturnType<typeof setTimeout> | undefined;
      let activeLease: HttpDispatcherLease | undefined;
      const totalAbort = new AbortController();
      const signal = opts.signal ? AbortSignal.any([opts.signal, totalAbort.signal]) : totalAbort.signal;
      const observe = async (event: HttpHopObservation) => { await opts.runtime?.observe?.(event); };
      try {
        while (true) {
          if (signal.aborted) throw Object.assign(new Error("请求已取消"), { name: "AbortError", code: "REQUEST_ABORTED", stage: currentStage });
          const parsedUrl = new URL(currentUrl);
          const network = opts.runtime?.network;
          const resolution: PreparedNetworkResolution = network?.resolveForOrigin(parsedUrl) ?? {
            origin: parsedUrl.origin,
            route: { kind: "direct" },
            targetTLS: defaultTLS,
          };
          activeLease = pool.acquire({
            origin: parsedUrl.origin,
            ...(network === undefined ? {} : { networkRevision: network.revision }),
            credentialVersions: network?.credentialVersions ?? {},
            settings: {
              connectTimeoutMs: settings.connectTimeoutMs,
              headersTimeoutMs: settings.headersTimeoutMs,
              bodyTimeoutMs: settings.bodyTimeoutMs,
              totalTimeoutMs: settings.totalTimeoutMs,
            },
            resolution,
            ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
          });
          requestBodyProgress = { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: false };
          responseFailureObservation = undefined;
          const sendHeaders = { ...currentRequest.headers };
          if (resolution.route.kind === "proxy") {
            const proxyAuthorization = headerKey(sendHeaders, "proxy-authorization");
            if (proxyAuthorization !== undefined) delete sendHeaders[proxyAuthorization];
          }
          const preparedBody = prepareHttpBody(currentRequest, {
            files: opts.runtime?.files,
            budget: uploadBudget,
            boundary,
            signal,
            onFileBytesRead(bytes) {
              requestBodyProgress.fileBytesRead += bytes;
              requestBodyChain.fileBytesRead += bytes;
            },
          });
          if (preparedBody.contentType && headerKey(sendHeaders, "content-type") === undefined) {
            sendHeaders["content-type"] = preparedBody.contentType;
          }
          const suppliedCookie = cookieHeader(sendHeaders);
          const explicitCookie = currentRequest.cookieHeaderMode === "explicit"
            || (currentRequest.cookieHeaderMode === undefined && headerKey(sendHeaders, "cookie") !== undefined);
          let sessionCookieUsed = false;
          if (opts.runtime?.session) {
            const jarCookie = await opts.runtime.session.getCookieHeader(currentUrl);
            sessionCookieUsed = !explicitCookie && hasUnshadowedSessionCookie(jarCookie, suppliedCookie);
            const cookie = explicitCookie ? suppliedCookie : mergeCookieValues(jarCookie, suppliedCookie);
            setHeader(sendHeaders, "cookie", cookie);
          }
          const observedRequest = cloneRequestForObservation(currentRequest);
          observedRequest.headers = { ...sendHeaders };
          await observe({
            type: "request", hopIndex, request: observedRequest, url: currentUrl, method: currentRequest.method,
            sessionCookieUsed, capturedFiles: capturedFileMetadata(currentRequest, opts.runtime?.files),
          });
          currentStage = "connect";
          if (!networkStarted) {
            networkStarted = true;
            networkStartedAt = performance.now();
            totalTimeout = setTimeout(() => {
              totalTimeoutExpired = true;
              totalAbort.abort(new Error("Total request timeout"));
            }, settings.totalTimeoutMs);
          }
          const requestStartedAt = performance.now();
          const hopAbort = new AbortController();
          const requestSignal = AbortSignal.any([signal, hopAbort.signal]);
          connectTimeoutExpired = false;
          headersTimeoutExpired = false;
          let connectTimer: ReturnType<typeof setTimeout> | undefined;
          let headersTimer: ReturnType<typeof setTimeout> | undefined;
          let rejectTimeout: ((error: Error) => void) | undefined;
          const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
          const startHeadersTimer = () => {
            if (connectTimer !== undefined) clearTimeout(connectTimer);
            if (headersTimer !== undefined) clearTimeout(headersTimer);
            headersTimer = setTimeout(() => {
              headersTimeoutExpired = true;
              const error = Object.assign(new Error("Response headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" });
              hopAbort.abort(error);
              rejectTimeout?.(error);
            }, settings.headersTimeoutMs);
          };
          connectTimer = setTimeout(() => {
            connectTimeoutExpired = true;
            const error = Object.assign(new Error("Connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
            hopAbort.abort(error);
            rejectTimeout?.(error);
          }, settings.connectTimeoutMs);
          const requestDispatcher = activeLease.dispatcher.compose((dispatch) => (dispatchOptions, dispatchHandler) => {
            const requestHandler = new Proxy(dispatchHandler, {
              get(target, property, receiver) {
                if (property === "onRequestStart") {
                  const onRequestStart = target.onRequestStart?.bind(target);
                  return (...args: Parameters<NonNullable<Dispatcher.DispatchHandler["onRequestStart"]>>) => {
                    startHeadersTimer();
                    return onRequestStart?.(...args);
                  };
                }
                if (property === "onBodySent") {
                  const onBodySent = target.onBodySent?.bind(target);
                  return (...args: Parameters<NonNullable<Dispatcher.DispatchHandler["onBodySent"]>>) => {
                    const chunk = args[0];
                    requestBodyProgress.transportEncodedBytesWritten += chunk.byteLength;
                    requestBodyChain.transportEncodedBytesWritten += chunk.byteLength;
                    return onBodySent?.(...args);
                  };
                }
                if (property === "onRequestSent") {
                  const onRequestSent = target.onRequestSent?.bind(target);
                  return (...args: Parameters<NonNullable<Dispatcher.DispatchHandler["onRequestSent"]>>) => {
                    requestBodyProgress.complete = true;
                    completedRequestBodyChain = completedRequestBodyChain && requestBodyProgress.complete;
                    requestBodyChain.complete = completedRequestBodyChain;
                    return onRequestSent?.(...args);
                  };
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            return dispatch(dispatchOptions, requestHandler);
          });
          let response: Awaited<ReturnType<typeof request>>;
          try {
            const pendingResponse = request(currentUrl, {
              method: currentRequest.method,
              headers: sendHeaders,
              body: preparedBody.body,
              dispatcher: requestDispatcher,
              signal: requestSignal,
              headersTimeout: settings.headersTimeoutMs,
              bodyTimeout: settings.bodyTimeoutMs,
              responseHeaders: "raw",
            });
            response = await Promise.race([pendingResponse, timeoutPromise]);
          } finally {
            if (connectTimer !== undefined) clearTimeout(connectTimer);
            if (headersTimer !== undefined) clearTimeout(headersTimer);
          }
          currentStage = "response-body";
          const rawHeaders = rawHeaderPairs(response.headers as unknown as string[]);
          const headers = legacyHeaders(rawHeaders);
          const declaredValue = rawHeaders.find(([name]) => name.toLowerCase() === "content-length")?.[1];
          const declaredLength = declaredValue && /^\d+$/.test(declaredValue) ? Number(declaredValue) : undefined;
          let boundedBody: Awaited<ReturnType<typeof readBoundedResponseBody>>;
          try {
            boundedBody = await readBoundedResponseBody(response.body, rawHeaders, settings.responseLimitBytes, signal, settings.bodyTimeoutMs);
          } catch (error) {
            const counts = error as { encodedBytes?: unknown; decodedBytes?: unknown };
            responseFailureObservation = {
              status: response.statusCode,
              headers,
              rawHeaders,
              encodedBytes: typeof counts.encodedBytes === "number" ? counts.encodedBytes : 0,
              decodedBytes: typeof counts.decodedBytes === "number" ? counts.decodedBytes : 0,
              ...(declaredLength === undefined ? {} : { declaredLength }),
              bodyComplete: false,
            };
            throw error;
          }
          const responseFinishedAt = performance.now();
          const timeMs = responseFinishedAt - (networkStartedAt ?? requestStartedAt);
          requestBodyChain.complete = requestBodyChain.complete && requestBodyProgress.complete;
          await observe({
            type: "response", hopIndex, url: currentUrl, status: response.statusCode, headers, rawHeaders,
            encodedBytes: boundedBody.encodedBytes, decodedBytes: boundedBody.decodedBytes,
            ...(boundedBody.declaredLength === undefined ? {} : { declaredLength: boundedBody.declaredLength }),
            bodyComplete: true,
            bodyBytes: Uint8Array.from(boundedBody.bytes),
            textAvailable: boundedBody.textAvailable,
            jsonAvailable: boundedBody.jsonAvailable,
            ...(boundedBody.textAvailable ? { bodyText: boundedBody.text } : {}),
            requestBody: { ...requestBodyProgress },
            requestBodyChain: { ...requestBodyChain },
          });
          await opts.runtime?.session?.storeResponseCookies(currentUrl, rawHeaders);

          const location = headers.location;
          if (settings.followRedirects && [301, 302, 303, 307, 308].includes(response.statusCode) && location) {
            if (hopIndex >= settings.maxRedirects) {
              throw Object.assign(new Error("The request exceeded the configured redirect limit."), { code: "REDIRECT_LIMIT_EXCEEDED", stage: "redirect", networkStarted: true });
            }
            const transition = transformRedirect(currentRequest, response.statusCode, currentUrl, location);
            currentRequest = transition.request;
            currentUrl = transition.url;
            hopIndex += 1;
            completedRequestBodyChain = completedRequestBodyChain && requestBodyProgress.complete;
            requestBodyProgress = { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: false };
            responseFailureObservation = undefined;
            requestBodyChain.complete = false;
            currentStage = "redirect-prepare";
            await opts.runtime?.beforeRedirect?.(currentRequest, {
              status: response.statusCode, from: transition.fromUrl, to: currentUrl,
              originChanged: transition.originChanged,
            });
            await activeLease.release();
            activeLease = undefined;
            currentUrl = buildUrl(currentRequest);
            continue;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          return responseValue(response.statusCode, headers, rawHeaders, boundedBody, timeMs);
        }
      } catch (error) {
        const attemptTimeMs = networkStartedAt === undefined ? 0 : performance.now() - networkStartedAt;
        const source = error as { code?: unknown; stage?: unknown; cause?: unknown };
        let code = typeof source?.code === "string" ? source.code : undefined;
        let stage = typeof source?.stage === "string" ? source.stage : currentStage;
        if (connectTimeoutExpired || code?.includes("CONNECT_TIMEOUT")) {
          code = "UND_ERR_CONNECT_TIMEOUT";
          stage = "connect";
        }
        else if (headersTimeoutExpired) {
          code = "UND_ERR_HEADERS_TIMEOUT";
          stage = "response-headers";
        }
        else if (code?.includes("BODY_TIMEOUT")) stage = "response-body";
        if (totalTimeoutExpired) { code = "TOTAL_TIMEOUT"; stage = currentStage; }
        else if (opts.signal?.aborted) { code = "REQUEST_ABORTED"; stage = currentStage; }
        if (error instanceof HttpExecutionError) throw error;
        const wrapped = new HttpExecutionError(classifyNetworkError(error), error, {
          code,
          stage,
          networkStarted,
          attemptTimeMs,
        });
        await observe({
          type: "failure", hopIndex, url: currentUrl, stage: wrapped.stage, code: wrapped.code,
          networkStarted: wrapped.networkStarted,
          ...((error as { encodedBytes?: number })?.encodedBytes === undefined ? {} : { encodedBytes: (error as { encodedBytes: number }).encodedBytes }),
          ...((error as { decodedBytes?: number })?.decodedBytes === undefined ? {} : { decodedBytes: (error as { decodedBytes: number }).decodedBytes }),
          ...(responseFailureObservation === undefined ? {} : { response: responseFailureObservation }),
          requestBody: { ...requestBodyProgress },
          requestBodyChain: { ...requestBodyChain, complete: requestBodyChain.complete && requestBodyProgress.complete },
        });
        throw wrapped;
      } finally {
        if (totalTimeout !== undefined) clearTimeout(totalTimeout);
        await activeLease?.release({
          destroy: isFresh && (connectTimeoutExpired || headersTimeoutExpired || totalTimeoutExpired || opts.signal?.aborted === true),
          reason: new Error("The HTTP attempt was aborted."),
        });
      }
    },
    async close() {
      await pool.close();
    },
  };
}

export const httpClient = createHttpClient();
