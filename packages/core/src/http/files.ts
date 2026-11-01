import { createReadStream, read } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { LocalFileReference } from "../contract/request.js";
import type { DeepReadonly } from "../assets/context.js";
import type { RequestBody } from "../contract/request.js";
import type { RuntimeBody } from "../request/body.js";

export class HttpFileError extends Error {
  constructor(message: string, readonly code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpFileError";
  }
}

export interface CapturedFile {
  readonly sourceId: string;
  readonly filename: string;
  readonly size: number;
  openStream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

export interface CapturedRequestFiles {
  get(reference: LocalFileReference): CapturedFile | undefined;
  close(): Promise<void>;
}
export type RequestFileSource = { readonly protocol: "http"; readonly body?: DeepReadonly<RequestBody | RuntimeBody> }
  | { readonly protocol: "websocket" | "soap" };
export interface CapturedRequestFileOwner extends CapturedRequestFiles {
  assertUnchanged(): Promise<void>;
  borrow(runtime: RequestFileSource, uploadLimitBytes: number): Promise<CapturedRequestFiles>;
}

export interface CaptureRequestFilesOptions {
  workspaceRoot?: string;
  uploadLimitBytes: number;
}

interface FileUse { reference: LocalFileReference }

function requestFiles(request: RequestFileSource): FileUse[] {
  if (request.protocol !== "http" || !request.body) return [];
  if (request.body.kind === "binary") return [{ reference: request.body.file }];
  if (request.body.kind !== "multipart") return [];
  const files: FileUse[] = [];
  for (const entry of request.body.entries) {
    if (entry.enabled === false || entry.kind !== "file") continue;
    files.push({ reference: entry.file });
  }
  return files;
}
function assertUploadLimit(size: number, limit: number): void {
  if (size > limit) throw new HttpFileError("A request file exceeds the configured upload limit.", "UPLOAD_LIMIT_EXCEEDED");
}

function sameFingerprint(a: Awaited<ReturnType<FileHandle["stat"]>>, b: Awaited<ReturnType<FileHandle["stat"]>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Capture every enabled local file before scripts can change request paths. */
export async function captureRequestFiles(
  request: RequestFileSource,
  options: CaptureRequestFilesOptions,
): Promise<CapturedRequestFileOwner> {
  const uses = requestFiles(request);
  if (uses.length > 0 && !options.workspaceRoot) {
    throw new HttpFileError("A workspace root is required to send local request files.", "UPLOAD_WORKSPACE_ROOT_REQUIRED");
  }
  const bindings = new WeakMap<object, CapturedFile>();
  const expectedPaths = new WeakMap<object, string>();
  const captured: CapturedFile[] = [];
  const root = uses.length > 0 ? await realpath(options.workspaceRoot!) : undefined;
  try {
    for (const use of uses) {
      const requestedPath = use.reference.path;
      if (!requestedPath) throw new HttpFileError("A request file path is empty.", "UPLOAD_FILE_PATH_INVALID");
      const isExplicitAbsolutePath = isAbsolute(requestedPath);
      const candidate = isExplicitAbsolutePath ? resolve(requestedPath) : resolve(root!, requestedPath);
      let resolvedPath: string;
      try { resolvedPath = await realpath(candidate); }
      catch (error) {
        throw new HttpFileError("A request file source could not be captured.", "FILE_SOURCE_NOT_REPLAYABLE", error);
      }
      let handle: FileHandle;
      try { handle = await open(resolvedPath, "r"); }
      catch (error) {
        throw new HttpFileError("A request file source changed while it was being captured.", "FILE_SOURCE_CHANGED", error);
      }
      try {
        let fingerprint: Awaited<ReturnType<FileHandle["stat"]>>;
        try { fingerprint = await handle.stat(); }
        catch (error) {
          throw new HttpFileError("A request file source changed while it was being captured.", "FILE_SOURCE_CHANGED", error);
        }
        if (!fingerprint.isFile()) throw new HttpFileError("A request file must be a regular file.", "UPLOAD_FILE_NOT_REGULAR");
        assertUploadLimit(fingerprint.size, options.uploadLimitBytes);
        let pathStat: Awaited<ReturnType<typeof stat>>;
        try { pathStat = await stat(resolvedPath); }
        catch (error) {
          throw new HttpFileError("A request file source changed while it was being captured.", "FILE_SOURCE_CHANGED", error);
        }
        if (!sameFingerprint(fingerprint, pathStat)) {
          throw new HttpFileError("A request file changed while it was being captured.", "FILE_SOURCE_CHANGED");
        }
        const streams = new Set<ReturnType<typeof createReadStream>>();
        let closed = false;
        let closing: Promise<void> | undefined;
        const capturedFile: CapturedFile = {
          sourceId: `file-${captured.length + 1}`,
          filename: basename(resolvedPath),
          size: fingerprint.size,
          openStream(signal) {
            if (closed) throw new HttpFileError("A captured request file cannot be replayed after it is closed.", "FILE_SOURCE_NOT_REPLAYABLE");
            // The stream borrows the captured descriptor; only this owner closes it.
            const stream = createReadStream("", {
              fd: handle.fd, start: 0, autoClose: false,
              fs: { read, close: (_fd, callback) => callback(null) },
              ...(signal ? { signal } : {}),
            });
            streams.add(stream);
            stream.once("close", () => streams.delete(stream));
            return stream;
          },
          async assertUnchanged() {
            if (closed) throw new HttpFileError("A captured request file cannot be replayed after it is closed.", "FILE_SOURCE_NOT_REPLAYABLE");
            let opened: Awaited<ReturnType<FileHandle["stat"]>>;
            let currentRealPath: string;
            let currentPath: Awaited<ReturnType<typeof stat>>;
            try {
              [opened, currentRealPath] = await Promise.all([handle.stat(), realpath(candidate)]);
              currentPath = await stat(currentRealPath);
            } catch (error) {
              throw new HttpFileError("A captured request file source changed or disappeared.", "FILE_SOURCE_CHANGED", error);
            }
            if (currentRealPath !== resolvedPath || !sameFingerprint(fingerprint, opened) || !sameFingerprint(fingerprint, currentPath)) {
              throw new HttpFileError("A request file changed after it was captured.", "FILE_SOURCE_CHANGED");
            }
          },
          async close() {
            if (closed) return closing;
            closed = true;
            closing = (async () => {
              await Promise.all([...streams].map((stream) => new Promise<void>((resolveClosed) => {
                if (stream.closed) return resolveClosed();
                stream.once("close", resolveClosed);
                stream.destroy();
              })));
              await handle.close();
            })();
            await closing;
          },
        };
        bindings.set(use.reference, capturedFile);
        expectedPaths.set(use.reference, requestedPath);
        captured.push(capturedFile);
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    await Promise.allSettled(captured.map((file) => file.close()));
    throw error;
  }

  let closed = false;
  return {
    async assertUnchanged() {
      if (closed) throw new HttpFileError("A captured request cannot be replayed after it is closed.", "FILE_SOURCE_NOT_REPLAYABLE");
      for (const file of captured) await file.assertUnchanged();
    },
    async borrow(runtime, uploadLimitBytes) {
      if (closed) throw new HttpFileError("A captured request cannot be replayed after it is closed.", "FILE_SOURCE_NOT_REPLAYABLE");
      const next = requestFiles(runtime);
      if (runtime.protocol !== request.protocol || next.length !== uses.length
        || uses.length > 0 && request.protocol === "http" && runtime.protocol === "http" && request.body?.kind !== runtime.body?.kind) {
        throw new HttpFileError("A request file selection changed after it was captured.", "FILE_SOURCE_CHANGED");
      }
      const lease = new AbortController();
      let released = false;
      let borrowed = new WeakMap<object, CapturedFile>();
      const paths = new WeakMap<object, string>();
      for (let index = 0; index < uses.length; index++) {
        const original = uses[index]!.reference, reference = next[index]!.reference;
        const path = expectedPaths.get(original)!;
        if (reference.path !== path) throw new HttpFileError("A request file path changed after it was captured.", "FILE_SOURCE_CHANGED");
        const file = bindings.get(original)!;
        assertUploadLimit(file.size, uploadLimitBytes);
        await file.assertUnchanged();
        paths.set(reference, path);
        borrowed.set(reference, {
          sourceId: file.sourceId, filename: file.filename, size: file.size,
          openStream(signal) {
            if (released || closed) throw new HttpFileError("A borrowed request file cannot be replayed after it is closed.", "FILE_SOURCE_NOT_REPLAYABLE");
            return file.openStream(signal ? AbortSignal.any([signal, lease.signal]) : lease.signal);
          },
          assertUnchanged: () => file.assertUnchanged(),
          async close() { lease.abort(); },
        });
      }
      return {
        get(reference) {
          if (released || closed) return undefined;
          const file = borrowed.get(reference);
          if (file && reference.path !== paths.get(reference)) throw new HttpFileError("A request file path changed after it was captured.", "FILE_SOURCE_CHANGED");
          return file;
        },
        async close() { released = true; lease.abort(); borrowed = new WeakMap(); },
      };
    },
    get(reference) {
      const file = bindings.get(reference as object);
      if (file && reference.path !== expectedPaths.get(reference as object)) {
        throw new HttpFileError("A request file path changed after it was captured.", "FILE_SOURCE_CHANGED");
      }
      return file;
    },
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled(captured.map((file) => file.close()));
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    },
  };
}
