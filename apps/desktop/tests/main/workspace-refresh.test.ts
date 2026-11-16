import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { fileStorage, readStableContractWorkspace } from "@apicc/core";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { IpcChannel } from "../../src/shared/channels.js";
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace, uuid } from "./helpers/contract-assets.js";

const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const globals = { variables: { tenant: "main" }, query: [], headers: [], cookies: [], body: [] };

describe("explicit disk refresh IPC", () => {
  it("reads the other process's commit while TreeGet uses the old session and returns typed save conflicts", async () => {
    const temporary = await makeTempRoot("apicc-disk-refresh-");
    const session = createSession();
    const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const opened = await deps.handle(IpcChannel.WsOpen, {}, temporary.path);
      workspace.groups[0]!.projects[0]!.name = "externally updated";
      const written = await fileStorage.save(opened.root, workspace, { expectedRevision: opened.revision, deletions: [] });
      expect(await deps.handle(IpcChannel.TreeGet, {})).toEqual(opened.tree);
      expect(await deps.handleTransport(IpcChannel.GlobalsSave, {}, project, globals)).toEqual({
        localWorkspaceFailure: true, reason: "revision-conflict", root: opened.root, project,
      });
      const refreshed = await deps.handle(IpcChannel.WsRefresh, {}, { root: opened.root, workspaceId: workspace.id });
      expect(refreshed.revision).toBe(written.revision);
      expect(refreshed.tree.children[0]?.children?.[0]?.label).toBe("externally updated");
      expect(await deps.handle(IpcChannel.TreeGet, {})).toEqual(refreshed.tree);
      expect(session.captureDraftWriteContext().generation).toBe(1);
      await expect(deps.handle(IpcChannel.GlobalsSave, {}, project, globals)).resolves.toEqual(globals);
    } finally { await temporary.dispose(); }
  });

  it("merges duplicate reads, rejects a simultaneous mutation, and retains the old session after a directory replacement", async () => {
    const temporary = await makeTempRoot("apicc-disk-refresh-dedupe-");
    const root = join(temporary.path, "workspace");
    const displaced = join(temporary.path, "displaced");
    const workspace = makeWorkspace();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const readStable = vi.fn(async (root: string) => { const state = await readStableContractWorkspace(root); enter(); await held; return state; });
    const session = createSession({ readStable });
    const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
    try {
      await persistWorkspace(root, workspace);
      const opened = await deps.handle(IpcChannel.WsOpen, {}, root);
      const input = { root: opened.root, workspaceId: workspace.id };
      const reading = deps.handleTransport(IpcChannel.WsRefresh, {}, input);
      await entered;
      const duplicate = deps.handleTransport(IpcChannel.WsRefresh, {}, input);
      expect(await deps.handleTransport(IpcChannel.GlobalsSave, {}, project, globals)).toMatchObject({ reason: "busy" });
      await rename(opened.root, displaced);
      await persistWorkspace(root, workspace);
      release();
      const [first, second] = await Promise.all([reading, duplicate]);
      expect(first).toEqual({ localWorkspaceFailure: true, reason: "directory-changed", root: opened.root });
      expect(second).toEqual(first);
      expect(readStable).toHaveBeenCalledTimes(1);
      expect(await deps.handle(IpcChannel.TreeGet, {})).toEqual(opened.tree);
    } finally { release(); await temporary.dispose(); }
  });

  it("keeps the current projection for invalid data, changed workspace identity, and misplaced refresh receipts", async () => {
    const temporary = await makeTempRoot("apicc-disk-refresh-validation-");
    const session = createSession();
    const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const opened = await deps.handle(IpcChannel.WsOpen, {}, temporary.path);
      const metadataPath = join(opened.root, "apicc.workspace.yaml");
      const originalMetadata = await readFile(metadataPath, "utf8");
      await writeFile(metadataPath, "invalid: [");
      const input = { root: opened.root, workspaceId: workspace.id };
      expect(await deps.handleTransport(IpcChannel.WsRefresh, {}, input)).toMatchObject({ reason: "read-only" });
      expect(await deps.handle(IpcChannel.TreeGet, {})).toEqual(opened.tree);
      await writeFile(metadataPath, originalMetadata.replace(workspace.id, uuid(99)));
      expect(await deps.handleTransport(IpcChannel.WsRefresh, {}, input)).toMatchObject({ reason: "workspace-replaced" });
      expect(await deps.handle(IpcChannel.TreeGet, {})).toEqual(opened.tree);
      const other = join(temporary.path, "other");
      await mkdir(other);
      await persistWorkspace(other, { ...workspace, id: uuid(99) });
      await deps.handle(IpcChannel.WsOpen, {}, other);
      expect(await deps.handleTransport(IpcChannel.WsRefresh, {}, input)).toEqual({
        localWorkspaceFailure: true, reason: "context-changed", root: opened.root,
      });
    } finally { await temporary.dispose(); }
  });

  it("reports busy while a real request is running and leaves the request to complete", async () => {
    const temporary = await makeTempRoot("apicc-disk-refresh-running-");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = createServer((_request, response) => {
      enter();
      void held.then(() => response.end("completed"));
    });
    const session = createSession();
    const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const opened = await deps.handle(IpcChannel.WsOpen, {}, temporary.path);
      const input = { root: opened.root, workspaceId: workspace.id };
      const owner = { sender: {} };
      const address = server.address() as { port: number };
      const invocation = await deps.handle(IpcChannel.DebugStart, owner, {
        mode: "free", project, draftId: uuid(801), parameters: {}, fields: [],
        request: {
          protocol: "http", method: "GET", baseUrl: `http://127.0.0.1:${address.port}`, path: "/refresh",
          pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
        },
      });
      await entered;
      expect(await deps.handleTransport(IpcChannel.WsRefresh, owner, input)).toMatchObject({ reason: "busy", root: opened.root });
      expect(await deps.handle(IpcChannel.TreeGet, owner)).toEqual(opened.tree);
      release();
      expect((await deps.handle(IpcChannel.DebugWait, owner, invocation)).run).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect((await deps.handle(IpcChannel.WsRefresh, owner, input)).revision).toBe(opened.revision);
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await temporary.dispose();
    }
  });
});
