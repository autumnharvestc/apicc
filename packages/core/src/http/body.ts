import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ExecutableRequest } from "../plugin/types.js";
import { HttpFileError, type CapturedFile, type CapturedRequestFiles } from "./files.js";

export class HttpBodyError extends Error {
  readonly caseFailureKind = "config" as const;
  readonly stage = "request-body" as const;
  constructor(message: string, readonly code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpBodyError";
  }
}

export interface UploadBudget {
  readonly limitBytes: number;
  uploadedFileBytes: number;
}

export interface PreparedHttpBody {
  body?: string | Readable;
  contentType?: string;
}

function header(request: Extract<ExecutableRequest, { protocol: "http" }>, name: string): string | undefined {
  const key = Object.keys(request.headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : request.headers[key];
}

function quoteHeader(value: string): string {
  return value.replace(/[\r\n\\"]/g, (character) => character === "\\" || character === '"' ? `\\${character}` : "_");
}

function getFile(files: CapturedRequestFiles | undefined, reference: { path: string }): CapturedFile {
  let file: CapturedFile | undefined;
  try { file = files?.get(reference); }
  catch (error) { throw error; }
  if (!file) throw new HttpBodyError("A request file was not captured before scripts ran.", "FILE_SOURCE_NOT_REPLAYABLE");
  return file;
}

async function* fileBytes(
  file: CapturedFile,
  budget: UploadBudget,
  signal?: AbortSignal,
  onFileBytesRead?: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
  try {
    await file.assertUnchanged();
    for await (const chunk of file.openStream(signal)) {
      budget.uploadedFileBytes += chunk.byteLength;
      onFileBytesRead?.(chunk.byteLength);
      if (budget.uploadedFileBytes > budget.limitBytes) {
        throw new HttpBodyError("The request exceeds the configured total upload limit.", "UPLOAD_LIMIT_EXCEEDED");
      }
      yield chunk;
    }
  } catch (error) {
    if (error instanceof HttpBodyError) throw error;
    if (signal?.aborted) throw error;
    if (error instanceof HttpFileError) throw new HttpBodyError(error.message, error.code, error);
    throw new HttpBodyError("A captured request file could not be read or replayed.", "FILE_SOURCE_NOT_REPLAYABLE", error);
  }
}

function multipartStream(
  request: Extract<ExecutableRequest, { protocol: "http" }>,
  files: CapturedRequestFiles | undefined,
  budget: UploadBudget,
  boundary: string,
  signal?: AbortSignal,
  onFileBytesRead?: (bytes: number) => void,
): Readable {
  if (request.body?.kind !== "multipart") throw new Error("multipart body expected");
  const entries = request.body.entries;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      const fieldName = quoteHeader(entry.name);
      if (entry.kind === "text") {
        yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${entry.value}\r\n`, "utf8");
      } else {
        const file = getFile(files, entry.file);
        const filename = quoteHeader(entry.filename ?? file.filename);
        yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${entry.contentType}\r\n\r\n`, "utf8");
        yield* fileBytes(file, budget, signal, onFileBytesRead);
        yield Buffer.from("\r\n");
      }
    }
    yield Buffer.from(`--${boundary}--\r\n`, "utf8");
  }
  return Readable.from(chunks());
}

/** Prepare a fresh body stream per hop while sharing the call's file-byte budget. */
export function prepareHttpBody(
  request: Extract<ExecutableRequest, { protocol: "http" }>,
  options: {
    files?: CapturedRequestFiles;
    budget: UploadBudget;
    boundary?: string;
    signal?: AbortSignal;
    onFileBytesRead?: (bytes: number) => void;
  },
): PreparedHttpBody {
  const body = request.body;
  if (!body) return {};
  if (body.kind === "json" || body.kind === "xml" || body.kind === "raw") return { body: body.content };
  if (body.kind === "form") {
    const params = new URLSearchParams();
    for (const pair of body.form ?? []) if (pair.enabled) params.append(pair.key, pair.value);
    return { body: params.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (body.kind === "binary") {
    const file = getFile(options.files, body.file);
    return {
      body: Readable.from(fileBytes(file, options.budget, options.signal, options.onFileBytesRead)),
      contentType: body.contentType,
    };
  }
  if (body.kind === "multipart") {
    if (header(request, "content-type") !== undefined) {
      throw new HttpBodyError("Multipart requests cannot provide a conflicting Content-Type header.", "MULTIPART_CONTENT_TYPE_CONFLICT");
    }
    const boundary = options.boundary ?? `----apicc-${randomUUID()}`;
    return {
      body: multipartStream(request, options.files, options.budget, boundary, options.signal, options.onFileBytesRead),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }
  throw new HttpBodyError("The HTTP request body encoding is unsupported.", "UNSUPPORTED_BODY_ENCODING");
}
