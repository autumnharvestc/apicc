import fsp, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import fs, { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureRequestFiles, materializeRequest, prepareRequestFiles, selectCredentialRequests, type CapturedRequestFiles, type ExecutableRequest, type PreparedRequestFiles, type SecretStore } from "@apicc/core";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { createMcpLocalExecutionHost } from "../src/mcp/localExecution.js";
import { localCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";
import { oid } from "./mcp-online.fixture.js";

const noSecrets: SecretStore = {
  async version() { throw new Error("unexpected attachment secret"); }, async resolve() { throw new Error("unexpected attachment secret"); },
  async status() { return "missing"; }, async put() { throw new Error("unexpected write"); }, async remove() { throw new Error("unexpected removal"); },
};
const materialOptions = (f: Awaited<ReturnType<typeof localCaseExecutionFixture>>) => ({ secretStore: noSecrets, networkPrivateRoot: join(f.privateRoot, "network") });
const upload = (path: string): ExecutableRequest => ({ protocol: "http", method: "POST", url: "http://127.0.0.1/not-dispatched", headers: {}, query: [], auth: { kind: "none" }, body: { kind: "binary", file: { path }, contentType: "application/octet-stream" } });
const reference = (request: ExecutableRequest) => {
  if (request.protocol !== "http" || request.body?.kind !== "binary") throw new Error("binary fixture required");
  return request.body.file;
};

/** Only owned paths, real handles/streams and real methods; restore Node's named binding in finally. */
function observeOwnedFiles(paths: string[]) {
  const owned = new Set(paths.map(path => path.toLowerCase()));
  const handles: FileHandle[] = [], streams: Array<ReturnType<FileHandle["createReadStream"]>> = [];
  const seenStreams = new Set<ReturnType<FileHandle["createReadStream"]>>();
  const trackStream = (stream: ReturnType<FileHandle["createReadStream"]>) => {
    if (!seenStreams.has(stream)) { seenStreams.add(stream); streams.push(stream); }
    return stream;
  };
  const open = fsp.open;
  const observed = vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (owned.has(String(args[0]).toLowerCase())) {
      handles.push(handle);
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = (...options) => trackStream(create(...options));
    }
    return handle;
  });
  const createReadStream = fs.createReadStream;
  const observedStream = vi.spyOn(fs, "createReadStream").mockImplementation((...args: Parameters<typeof createReadStream>) => {
    const stream = createReadStream(...args), options = args[1];
    if (options && typeof options === "object" && typeof options.fd === "number" && handles.some(handle => handle.fd === options.fd)) trackStream(stream);
    return stream;
  });
  syncBuiltinESMExports();
  return { handles, streams, async restore() {
    try { for (const stream of streams) stream.destroy(); await Promise.allSettled(handles.map(handle => handle.close())); }
    finally { observedStream.mockRestore(); observed.mockRestore(); syncBuiltinESMExports(); }
  } };
}
async function assertClosed(handles: FileHandle[]) {
  expect(handles.length).toBeGreaterThan(0);
  for (const handle of handles) await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
}
async function failure(action: () => Promise<unknown>) { try { await action(); return undefined; } catch (error) { return error; } }
async function cleanup(f: Awaited<ReturnType<typeof localCaseExecutionFixture>>, observed: ReturnType<typeof observeOwnedFiles>, close?: () => Promise<void>) {
  f.release();
  try { await close?.(); }
  finally { try { await observed.restore(); } finally { await f.close(); } }
}

describe.sequential("R53 prepared attachments", () => {
  // A green characterization establishes that observation reaches the real existing Node capture, not a synthetic flag.
  it("attachment_legacy_capture_really_opens_and_closes_the_observed_owned_file", async () => {
    const f = await localCaseExecutionFixture(); f.writeDriver("legacy file bytes");
    const observed = observeOwnedFiles([f.materialPath]);
    let captured: CapturedRequestFiles | undefined;
    try {
      const request = upload(f.materialPath);
      captured = await captureRequestFiles(request, { workspaceRoot: f.workspaceRoot, uploadLimitBytes: 1024 });
      expect(observed.handles).toHaveLength(1);
      expect((await observed.handles[0]!.stat()).isFile()).toBe(true);
      reference(request).path += ".changed";
      expect(() => captured!.get(reference(request))).toThrow(expect.objectContaining({ code: "FILE_SOURCE_CHANGED" }));
      await captured.close(); await captured.close();
      await assertClosed(observed.handles);
      expect(f.requests).toEqual([]);
    } finally { await cleanup(f, observed, async () => { await captured?.close(); }); }
  });

  // Catch losing an owner when two selections share one definition, closing another borrow, or losing runtime path binding.
  it("attachment_batch_shared_definition_borrows_keep_parent_and_other_stream_alive", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const api = project.collections[0]!.apis[0]!;
      if (api.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
      api.contract.request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
      api.cases.push({ ...structuredClone(api.cases[0]!), id: oid(8) });
    } });
    f.writeDriver("x".repeat(300000));
    const observed = observeOwnedFiles([f.materialPath]);
    let owner: PreparedRequestFiles | undefined, a: CapturedRequestFiles | undefined, b: CapturedRequestFiles | undefined, changed: CapturedRequestFiles | undefined;
    try {
      const { snapshot } = await f.source.readProject(f.input.projectId, signal());
      const asset = snapshot.project.collections[0]!.apis[0]!;
      const selections = asset.cases.map(testCase => ({ asset, testCase }));
      owner = await prepareRequestFiles(snapshot, selections, { workspaceRoot: f.workspaceRoot, signal: signal() });
      const selected = selectCredentialRequests(snapshot, selections)[0]!;
      const runtime = () => materializeRequest(selected.asset.contract, snapshot.context, { resolve: text => text, globals: {
        query: snapshot.project.globals.query.map(value => ({ ...value })), headers: snapshot.project.globals.headers.map(value => ({ ...value })),
        cookies: snapshot.project.globals.cookies.map(value => ({ ...value })), body: snapshot.project.globals.body.map(value => ({ ...value })),
      },
        credentials: { versions: {}, resolve() { throw new Error("no secret expected"); } } }, selected.request);
      const requestA = runtime(), requestB = runtime();
      a = await owner.borrow(selected.request, requestA, 1000000); b = await owner.borrow(selected.request, requestB, 1000000);
      const streamA = a.get(reference(requestA))!.openStream()[Symbol.asyncIterator]();
      const streamB = b.get(reference(requestB))!.openStream()[Symbol.asyncIterator]();
      await streamA.next(); const firstB = await streamB.next();
      await a.close();
      await vi.waitFor(() => expect(observed.streams[0]?.destroyed).toBe(true));
      expect(observed.streams[1]?.destroyed).toBe(false);
      for (const handle of observed.handles) expect((await handle.stat()).isFile()).toBe(true);
      let received = firstB.value!.byteLength;
      for (let next = await streamB.next(); !next.done; next = await streamB.next()) received += next.value.byteLength;
      expect(received).toBe(300000);
      const requestChanged = runtime(); changed = await owner.borrow(selected.request, requestChanged, 1000000);
      reference(requestChanged).path += ".changed";
      expect(() => changed!.get(reference(requestChanged))).toThrow(expect.objectContaining({ code: "FILE_SOURCE_CHANGED" }));
      await b.close(); await changed.close(); await owner.close(); await owner.close();
      await assertClosed(observed.handles);
      expect(f.requests).toEqual([]);
    } finally { await cleanup(f, observed, async () => { await a?.close(); await b?.close(); await changed?.close(); await owner?.close(); }); }
  });

  // Capture admits 16 bytes under 32; a different runtime budget must still reject before any upload.
  it("attachment_batch_runtime_limit_rejects_a_prepared_file_larger_than_the_actual_borrow_budget", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol === "http") request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("0123456789abcdef"); const observed = observeOwnedFiles([f.materialPath]);
    let owner: PreparedRequestFiles | undefined;
    try {
      const { snapshot } = await f.source.readProject(f.input.projectId, signal()); const asset = snapshot.project.collections[0]!.apis[0]!;
      const selections = [{ asset, testCase: asset.cases[0]! }];
      owner = await prepareRequestFiles(snapshot, selections, { workspaceRoot: f.workspaceRoot, requestSettings: { uploadLimitBytes: 32 } });
      const selected = selectCredentialRequests(snapshot, selections)[0]!;
      const runtime = materializeRequest(selected.asset.contract, snapshot.context, { resolve: text => text, globals: { query: [], headers: [], cookies: [], body: [] },
        credentials: { versions: {}, resolve() { throw new Error("no secret expected"); } } }, selected.request);
      expect(await failure(() => owner!.borrow(selected.request, runtime, 8))).toMatchObject({ code: "UPLOAD_LIMIT_EXCEEDED" });
      expect(f.requests).toEqual([]); await owner.close(); await assertClosed(observed.handles);
    } finally { await cleanup(f, observed, async () => { await owner?.close(); }); }
  });

  it("attachment_batch_preflight_refuses_changed_source_without_business", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol === "http") request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("before"); const observed = observeOwnedFiles([f.materialPath]);
    let owner: PreparedRequestFiles | undefined;
    try {
      const { snapshot } = await f.source.readProject(f.input.projectId, signal()); const asset = snapshot.project.collections[0]!.apis[0]!;
      owner = await prepareRequestFiles(snapshot, [{ asset, testCase: asset.cases[0]! }], { workspaceRoot: f.workspaceRoot });
      f.writeDriver("changed after preparation with different size");
      expect(await failure(() => owner!.assertUnchanged())).toMatchObject({ code: "FILE_SOURCE_CHANGED" });
      expect(f.requests).toEqual([]); await owner.close(); await assertClosed(observed.handles);
    } finally { await cleanup(f, observed, async () => { await owner?.close(); }); }
  });

  it("attachment_batch_partial_failure_closes_real_handles_from_prior_selections", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const api = project.collections[0]!.apis[0]!;
      if (api.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
      api.contract.request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
      const other = structuredClone(api); other.contract.id = oid(8); other.cases[0]!.id = oid(9);
      if (other.contract.request.protocol === "http") other.contract.request.body = { kind: "binary", file: { path: `${driverPath}.missing` }, contentType: "application/octet-stream" };
      project.collections[0]!.apis.push(other);
    } });
    f.writeDriver("first real source"); const observed = observeOwnedFiles([f.materialPath]);
    try {
      const { snapshot } = await f.source.readProject(f.input.projectId, signal());
      const selections = snapshot.project.collections[0]!.apis.map(asset => ({ asset, testCase: asset.cases[0]! }));
      const error = await failure(() => prepareRequestFiles(snapshot, selections, { workspaceRoot: f.workspaceRoot }));
      expect.soft(error).toMatchObject({ code: "FILE_SOURCE_NOT_REPLAYABLE" });
      await assertClosed(observed.handles); expect(f.requests).toEqual([]);
    } finally { await cleanup(f, observed); }
  });

  it.each(["binary", "multipart"] as const)("attachment_mcp_%s_prepares_without_target_then_uploads_the_captured_file", async kind => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol !== "http") throw new Error("HTTP fixture required");
      request.method = "POST";
      request.body = kind === "binary" ? { kind, file: { path: driverPath }, contentType: "application/octet-stream" }
        : { kind, entries: [{ kind: "file", id: oid(41), name: "upload", file: { path: driverPath }, contentType: "application/octet-stream", enabled: true },
          { kind: "file", id: oid(42), name: "disabled", file: { path: `${driverPath}.missing` }, enabled: false }] };
    } });
    f.writeDriver("R53_FIXED_ATTACHMENT_BYTES"); const observed = observeOwnedFiles([f.materialPath]);
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, ...materialOptions(f) });
    try {
      const prepared = await outcome(() => host.prepare(f.input, signal()));
      expect(f.requests).toEqual([]); expect(prepared.error).toBeNull();
      expect(observed.handles.length).toBeGreaterThan(0);
      expect(JSON.stringify(prepared.value)).not.toContain(f.materialPath);
      const ticket = prepared.value!;
      await host.start({ ticketId: ticket.ticketId, intentId: `attachment-${kind}-once` }, signal());
      await vi.waitFor(() => expect(f.requestBodies).toHaveLength(1));
      expect(f.requestBodies[0]!.toString()).toContain("R53_FIXED_ATTACHMENT_BYTES");
      expect(f.requests).toEqual([{ method: "POST", url: "/saved-case" }]);
      f.release(); await host.close(); await assertClosed(observed.handles);
    } finally { await cleanup(f, observed, () => host.close()); }
  });

  it("attachment_mcp_changed_before_start_rejects_real_completion_with_zero_target", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol === "http") request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("before"); const observed = observeOwnedFiles([f.materialPath]);
    const adapter = createMcpLocalExecutionHost(materialOptions(f)); const actual = vi.spyOn(adapter, "start");
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: adapter });
    try {
      const prepared = await outcome(() => host.prepare(f.input, signal())); expect(prepared.error).toBeNull();
      f.writeDriver("changed before start, not the prepared source bytes"); const ticket = prepared.value!;
      await host.start({ ticketId: ticket.ticketId, intentId: "attachment-source-changed" }, signal());
      expect(await failure(() => actual.mock.results[0]!.value)).toMatchObject({ code: "FILE_SOURCE_CHANGED" });
      expect(f.requests).toEqual([]); await host.close(); await assertClosed(observed.handles);
    } finally { await cleanup(f, observed, () => host.close()); }
  });

  it("attachment_mcp_runtime_script_path_change_is_rejected_without_reading_another_file", async () => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const api = project.collections[0]!.apis[0]!; const request = api.contract.request;
      if (request.protocol === "http") request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
      api.cases[0]!.preOperations = [{ id: oid(43), type: "script", content: `pm.request.body.file.path = ${JSON.stringify(`${driverPath}.other`)};` }];
    } });
    f.writeDriver("selected"); writeFileSync(`${f.materialPath}.other`, "not selected");
    const observed = observeOwnedFiles([f.materialPath, `${f.materialPath}.other`]);
    const adapter = createMcpLocalExecutionHost(materialOptions(f)); const actual = vi.spyOn(adapter, "start");
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: adapter, localProfile: "trusted-core-script" });
    try {
      const prepared = await outcome(() => host.prepare(f.input, signal())); expect(prepared.error).toBeNull(); const ticket = prepared.value!;
      await host.start({ ticketId: ticket.ticketId, intentId: "attachment-script-changed" }, signal());
      const output = await actual.mock.results[0]!.value;
      expect(output).toMatchObject({ kind: "debug", result: { failureKind: expect.any(String) } });
      expect(JSON.stringify(output)).toMatch(/FILE_SOURCE_CHANGED|file path changed|文件.*变/i);
      expect(f.requests).toEqual([]); expect(observed.handles).toHaveLength(1);
      await host.close(); await assertClosed(observed.handles);
    } finally { await cleanup(f, observed, () => host.close()); }
  });

  it.each(["close", "expiry"] as const)("attachment_mcp_unused_%s_releases_actual_prepared_handles", async action => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol === "http") request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("unused prepared file"); const observed = observeOwnedFiles([f.materialPath]);
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, ...materialOptions(f), limits: { ticketTtlMs: 30000 } });
    try {
      if (action === "expiry") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const prepared = await outcome(() => host.prepare(f.input, signal())); expect(prepared.error).toBeNull();
      expect(observed.handles.length).toBeGreaterThan(0);
      for (const handle of observed.handles) expect((await handle.stat()).isFile()).toBe(true);
      if (action === "expiry") { await vi.advanceTimersByTimeAsync(30001); vi.useRealTimers(); }
      else { await host.close(); await host.close(); }
      await vi.waitFor(() => expect(observed.handles.every(handle => handle.fd === -1)).toBe(true));
      await assertClosed(observed.handles); expect(f.requests).toEqual([]);
    } finally { vi.useRealTimers(); await cleanup(f, observed, () => host.close()); }
  });
});
