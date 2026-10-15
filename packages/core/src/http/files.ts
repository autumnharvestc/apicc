import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { LocalFileReference } from "../contract/request.js";
import type { ExecutableRequest } from "../plugin/types.js";

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

export interface CaptureRequestFilesOptions {
  workspaceRoot?: string;
  uploadLimitBytes: number;
}

interface FileUse { reference: LocalFileReference }

function requestFiles(request: ExecutableRequest): FileUse[] {
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

function sameFingerprint(a: Awaited<ReturnType<FileHandle["stat"]>>, b: Awaited<ReturnType<FileHandle["stat"]>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Capture every enabled local file before scripts can change request paths. */
export async function captureRequestFiles(
  request: ExecutableRequest,
  options: CaptureRequestFilesOptions,
): Promise<CapturedRequestFiles> {
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
        if (fingerprint.size > options.uploadLimitBytes) {
          throw new HttpFileError("A request file exceeds the configured upload limit.", "UPLOAD_LIMIT_EXCEEDED");
        }
        let pathStat: Awaited<ReturnType<typeof stat>>;
        try { pathStat = await stat(resolvedPath); }
        catch (error) {
          throw new HttpFileError("A request file source changed while it was being captured.", "FILE_SOURCE_CHANGED", error);
        }
        if (!sameFingerprint(fingerprint, pathStat)) {
          throw new HttpFileError("A request file changed while it was being captured.", "FILE_SOURCE_CHANGED");
        }
        const streams = new Set<ReturnType<FileHandle["createReadStream"]>>();
        let closed = false;
        const capturedFile: CapturedFile = {
          sourceId: `file-${captured.length + 1}`,
          filename: basename(resolvedPath),
          size: fingerprint.size,
          openStream(signal) {
          if (closed) throw new HttpFileError("A captured request file cannot be replayed after it is closed.", "FILE_SOURCE_NOT_REPLAYABLE");
            const stream = handle.createReadStream({ start: 0, autoClose: false, ...(signal ? { signal } : {}) });
            streams.add(stream);
            stream.once("end", () => streams.delete(stream));
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
            if (closed) return;
            closed = true;
            for (const stream of streams) stream.destroy();
            streams.clear();
            await handle.close();
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
