import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type RawHeaderPair = readonly [name: string, value: string];

export class HttpResponseError extends Error {
  readonly stage = "response-body" as const;
  constructor(message: string, readonly code: string, readonly encodedBytes = 0, readonly decodedBytes = 0, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpResponseError";
  }
}

export function rawHeaderPairs(rawHeaders: string[]): RawHeaderPair[] {
  const pairs: RawHeaderPair[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return pairs;
}

export function legacyHeaders(rawHeaders: readonly RawHeaderPair[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of rawHeaders) {
    const key = name.toLowerCase();
    headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
  }
  return headers;
}

export interface BoundedResponseBody {
  bytes: Uint8Array;
  text: string;
  textAvailable: boolean;
  jsonAvailable: boolean;
  contentEncoding: string;
  encodedBytes: number;
  decodedBytes: number;
  declaredLength?: number;
}

function findHeader(rawHeaders: readonly RawHeaderPair[], name: string): string | undefined {
  return rawHeaders.find(([header]) => header.toLowerCase() === name)?.[1];
}

function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/xml"
    || mediaType === "text/xml"
    || mediaType.endsWith("+xml")
    || mediaType === "application/x-www-form-urlencoded"
    || mediaType === "application/javascript";
}

function textDecoder(contentType: string | undefined): TextDecoder | undefined {
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try { return new TextDecoder(charset, { fatal: true }); }
  catch { return undefined; }
}

function decompressor(encoding: string): Transform {
  switch (encoding) {
    case "gzip":
    case "x-gzip": return createGunzip();
    case "deflate": return createInflate();
    case "br": return createBrotliDecompress();
    default: throw new HttpResponseError("The response uses an unsupported content encoding.", "RESPONSE_ENCODING_UNSUPPORTED");
  }
}

/** Read, count and decode a response once; either the complete bounded body is returned or no body is exposed. */
export async function readBoundedResponseBody(
  body: Readable,
  rawHeaders: readonly RawHeaderPair[],
  limitBytes: number,
  signal?: AbortSignal,
  bodyTimeoutMs = 30_000,
): Promise<BoundedResponseBody> {
  let encodedBytes = 0;
  let decodedBytes = 0;
  const chunks: Buffer[] = [];
  let bodyIdleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetBodyIdleTimer = () => {
    if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
    bodyIdleTimer = setTimeout(() => {
      body.destroy(new HttpResponseError("The response body was idle beyond the configured timeout.", "UND_ERR_BODY_TIMEOUT", encodedBytes, decodedBytes));
    }, bodyTimeoutMs);
  };
  const encodingValue = findHeader(rawHeaders, "content-encoding") ?? "identity";
  const encodings = encodingValue.split(",").map((value) => value.trim().toLowerCase()).filter((value) => value && value !== "identity");
  const stages: Transform[] = [];
  const encodedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      resetBodyIdleTimer();
      encodedBytes += chunk.byteLength;
      if (encodedBytes > limitBytes) callback(new HttpResponseError("The encoded response exceeds the configured limit.", "RESPONSE_LIMIT_EXCEEDED", encodedBytes, decodedBytes));
      else callback(null, chunk);
    },
  });
  stages.push(encodedCounter);
  try {
    for (const encoding of encodings.reverse()) stages.push(decompressor(encoding));
  } catch (error) {
    body.destroy(error as Error);
    throw error;
  }
  const decodedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decodedBytes += chunk.byteLength;
      if (decodedBytes > limitBytes) callback(new HttpResponseError("The decoded response exceeds the configured limit.", "RESPONSE_LIMIT_EXCEEDED", encodedBytes, decodedBytes));
      else {
        chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      }
    },
  });
  stages.push(decodedCounter);
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  resetBodyIdleTimer();
  try {
    if (signal) await pipeline(body, ...stages, sink, { signal });
    else await pipeline(body, ...stages, sink);
  } catch (error) {
    if (error instanceof HttpResponseError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("Z_") ) {
      throw new HttpResponseError("The encoded response body could not be decoded.", "RESPONSE_DECODE_FAILED", encodedBytes, decodedBytes, error);
    }
    if (error instanceof Error) {
      Object.assign(error, { encodedBytes, decodedBytes });
    }
    throw error;
  } finally {
    if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
  }
  const bytes = Buffer.concat(chunks, decodedBytes);
  const contentType = findHeader(rawHeaders, "content-type");
  const decoder = isTextualContentType(contentType) ? textDecoder(contentType) : undefined;
  let text = "";
  let textAvailable = false;
  if (decoder) {
    try { text = decoder.decode(bytes); textAvailable = true; }
    catch { /* A lossy replacement string would misrepresent the response bytes. */ }
  }
  let jsonAvailable = false;
  if (textAvailable) {
    try { JSON.parse(text); jsonAvailable = true; } catch { /* malformed JSON stays available as text only */ }
  }
  const declaredValue = findHeader(rawHeaders, "content-length");
  const declaredLength = declaredValue && /^\d+$/.test(declaredValue) ? Number(declaredValue) : undefined;
  return {
    bytes,
    text,
    textAvailable,
    jsonAvailable,
    contentEncoding: encodingValue,
    encodedBytes,
    decodedBytes,
    ...(declaredLength === undefined ? {} : { declaredLength }),
  };
}
