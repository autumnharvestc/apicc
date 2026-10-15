import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutableRequest } from "../../src/plugin/types.js";
import { prepareHttpBody } from "../../src/http/body.js";
import { captureRequestFiles, type CapturedRequestFiles } from "../../src/http/files.js";

function binaryRequest(path: string): ExecutableRequest {
  return {
    protocol: "http",
    method: "POST",
    url: "http://127.0.0.1/upload",
    headers: {},
    query: [],
    auth: { kind: "none" },
    body: { kind: "binary", file: { path }, contentType: "application/octet-stream" },
  } as ExecutableRequest;
}

describe("captured HTTP files", () => {
  it("accepts a user-selected absolute file outside the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-files-"));
    const workspaceRoot = join(root, "workspace");
    const selectedPath = join(root, "selected.bin");
    const expected = Buffer.from([0, 3, 0x80, 0xff]);
    await mkdir(workspaceRoot);
    await writeFile(selectedPath, expected);
    const request = binaryRequest(selectedPath);
    const capturedRef = request.protocol === "http" && request.body?.kind === "binary" ? request.body.file : undefined;
    let captured: CapturedRequestFiles | undefined;
    try {
      captured = await captureRequestFiles(request, { workspaceRoot, uploadLimitBytes: 64 });
      const file = captured.get(capturedRef!)!;
      await file.assertUnchanged();
      const chunks: Buffer[] = [];
      for await (const chunk of file.openStream()) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(expected);
    } finally {
      await captured?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an explicitly selected relative file from the workspace root, including ..", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-files-"));
    const workspaceRoot = join(root, "workspace");
    const selectedPath = join(root, "selected.bin");
    const expected = Buffer.from("relative selection");
    await mkdir(workspaceRoot);
    await writeFile(selectedPath, expected);
    const request = binaryRequest("../selected.bin");
    const capturedRef = request.protocol === "http" && request.body?.kind === "binary" ? request.body.file : undefined;
    let captured: CapturedRequestFiles | undefined;
    try {
      captured = await captureRequestFiles(request, { workspaceRoot, uploadLimitBytes: 64 });
      const file = captured.get(capturedRef!)!;
      const chunks: Buffer[] = [];
      for await (const chunk of file.openStream()) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(expected);
    } finally {
      await captured?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing capture binding as FILE_SOURCE_NOT_REPLAYABLE", () => {
    const request = binaryRequest("source.bin");
    const bodyRequest = request as Extract<ExecutableRequest, { protocol: "http" }>;
    expect(() => prepareHttpBody(bodyRequest, {
      budget: { limitBytes: 64, uploadedFileBytes: 0 },
    })).toThrow(expect.objectContaining({ code: "FILE_SOURCE_NOT_REPLAYABLE" }));
  });

  it("reports a disappeared captured source as FILE_SOURCE_CHANGED with its native cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-files-"));
    const originalPath = join(root, "source.bin");
    const movedPath = join(root, "source-moved.bin");
    await writeFile(originalPath, Buffer.from("source"));
    const request = binaryRequest("source.bin");
    const capturedRef = request.protocol === "http" && request.body?.kind === "binary" ? request.body.file : undefined;
    let captured: CapturedRequestFiles | undefined;
    try {
      captured = await captureRequestFiles(request, { workspaceRoot: root, uploadLimitBytes: 64 });
      await rename(originalPath, movedPath);
      let failure: unknown;
      try { await captured.get(capturedRef!)!.assertUnchanged(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "FILE_SOURCE_CHANGED", cause: { code: "ENOENT" } });
    } finally {
      await captured?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a script-changed bound path as FILE_SOURCE_CHANGED", async () => {
    const root = await mkdtemp(join(tmpdir(), "apicc-http-files-"));
    await writeFile(join(root, "source.bin"), Buffer.from("source"));
    const request = binaryRequest("source.bin");
    const capturedRef = request.protocol === "http" && request.body?.kind === "binary" ? request.body.file : undefined;
    let captured: CapturedRequestFiles | undefined;
    try {
      captured = await captureRequestFiles(request, { workspaceRoot: root, uploadLimitBytes: 64 });
      capturedRef!.path = "other.bin";
      expect(() => captured!.get(capturedRef!)).toThrow(expect.objectContaining({ code: "FILE_SOURCE_CHANGED" }));
    } finally {
      await captured?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
