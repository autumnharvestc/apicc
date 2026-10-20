import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { createProjectSnapshot, type MockServerHandle } from "@apicc/core";
import { ContractProjectSchema, type ContractProject } from "@apicc/core/schema";
import { createMockConfiguredProject } from "../../../../packages/core/tests/helpers/mockFixtures.js";
import { createMockManager } from "../../src/main/mockManager.js";
import { createSession } from "../../src/main/session.js";
import type { ProjectLocator } from "../../src/shared/locations.js";
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace } from "./helpers/contract-assets.js";

const projectLocator: ProjectLocator = {
  workspaceId: IDS.workspace,
  groupId: IDS.groupOne,
  projectId: IDS.projectOne,
};

const managers: Array<ReturnType<typeof createMockManager>> = [];
const roots: Array<() => Promise<void>> = [];

async function savedMockProject() {
  const temporary = await makeTempRoot("apicc-b3-mock-");
  roots.push(temporary.dispose);
  const workspace = makeWorkspace();
  const project = createMockConfiguredProject();
  const savedProject = ContractProjectSchema.parse({ ...project, id: IDS.projectOne }) as ContractProject;
  workspace.groups[0]!.projects[0] = savedProject;
  await persistWorkspace(temporary.path, workspace);
  return temporary;
}

async function openMockSession(root: string) {
  const session = createSession();
  await session.open(root);
  const manager = createMockManager({ session });
  managers.push(manager);
  return { session, manager };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(roots.splice(0).map((dispose) => dispose()));
});

describe("Desktop saved Mock lifecycle", () => {
  it("serves a saved project snapshot over localhost and makes repeated lifecycle calls idempotent", async () => {
    const root = await savedMockProject();
    const { manager } = await openMockSession(root.path);

    const [first, duplicate] = await Promise.all([
      manager.start(projectLocator),
      manager.start(projectLocator),
    ]);
    expect(first.status).toBe("running");
    expect(duplicate.address).toEqual(first.address);
    expect(first.address).toMatchObject({ address: "127.0.0.1" });

    const response = await fetch(`http://127.0.0.1:${first.address!.port}/items/item-7`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "item-7" });
    expect(manager.get(projectLocator).logs).toHaveLength(1);

    await Promise.all([manager.stop(projectLocator), manager.stop(projectLocator)]);
    expect(manager.get(projectLocator).status).toBe("stopped");
    await expect(fetch(`http://127.0.0.1:${first.address!.port}/items/item-7`)).rejects.toThrow();
  });

  it("reloads the running handle after the saved project Mock configuration changes", async () => {
    const root = await savedMockProject();
    const { session, manager } = await openMockSession(root.path);
    const started = await manager.start(projectLocator);
    const before = manager.get(projectLocator).sourceProjectRevision;
    const savedConfig = session.locateProject(projectLocator)!.project.mock!;

    await session.saveMockConfig(projectLocator, { ...savedConfig, seed: "after-save" }, before, session.captureDraftWriteContext());
    await manager.saved(projectLocator);

    const after = manager.get(projectLocator);
    expect(after.status).toBe("running");
    expect(after.sourceProjectRevision).not.toBe(before);
    const response = await fetch(`http://127.0.0.1:${started.address!.port}/items/item-7`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "item-7" });
  });

  it("restarts after stop and retries after a port collision", async () => {
    const root = await savedMockProject();
    const { manager } = await openMockSession(root.path);
    const first = await manager.start(projectLocator);
    await manager.stop(projectLocator);
    const restarted = await manager.start(projectLocator);
    expect(restarted.status).toBe("running");
    expect(first.address!.port).toBeGreaterThan(0);
    await manager.stop(projectLocator);

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      const failed = await manager.start(projectLocator, blockedPort);
      expect(failed.status).toBe("stopped");
      expect(failed.diagnostics[0]?.code).toBe("MOCK_PORT_IN_USE");
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    }
    const retried = await manager.start(projectLocator, blockedPort);
    expect(retried.status).toBe("running");
    expect(retried.address!.port).toBe(blockedPort);
  });

  it("compiles the latest saved snapshot after old-handle cleanup", async () => {
    const root = await savedMockProject();
    const session = createSession();
    await session.open(root.path);
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupEntered = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const compiledRevisions: string[] = [];
    const manager = createMockManager({
      session,
      startServer: async (plan) => {
        compiledRevisions.push(plan.sourceProjectRevision);
        const first = compiledRevisions.length === 1;
        let status: MockServerHandle["status"] = first ? "stopped" : "running";
        return {
          address: { address: "127.0.0.1", family: "IPv4", port: 41_321 + compiledRevisions.length },
          get status() { return status; },
          beginReload() {},
          async reload() {},
          invalidate() {},
          logs: () => [],
          async stop() {
            if (first) {
              cleanupStarted();
              await cleanupGate;
            }
            status = "stopped";
          },
        } as unknown as MockServerHandle;
      },
    });
    managers.push(manager);

    try {
      const initial = await manager.start(projectLocator);
      expect(initial.status).toBe("stopped");
      const retry = manager.start(projectLocator);
      await cleanupEntered;

      const project = session.locateProject(projectLocator)!.project;
      const before = createProjectSnapshot(project).definitionRevision;
      await session.saveMockConfig(projectLocator, { ...project.mock!, seed: "saved-during-cleanup" }, before, session.captureDraftWriteContext());
      await manager.saved(projectLocator);
      const savedRevision = createProjectSnapshot(session.locateProject(projectLocator)!.project).definitionRevision;

      releaseCleanup();
      const restarted = await retry;
      expect(restarted.status).toBe("running");
      expect(compiledRevisions).toHaveLength(2);
      expect(compiledRevisions[1]).toBe(savedRevision);
      expect(compiledRevisions[1]).not.toBe(compiledRevisions[0]);
    } finally {
      releaseCleanup();
    }
  });

  it("coalesces two concurrent restarts after stop on the same released port", async () => {
    const root = await savedMockProject();
    const { manager } = await openMockSession(root.path);
    const initial = await manager.start(projectLocator);
    const releasedPort = initial.address!.port;
    await manager.stop(projectLocator);

    const [first, second] = await Promise.all([
      manager.start(projectLocator, releasedPort),
      manager.start(projectLocator, releasedPort),
    ]);

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(first.address).toEqual(second.address);
    expect(first.address!.port).toBe(releasedPort);
    const response = await fetch(`http://127.0.0.1:${releasedPort}/items/item-7`);
    expect(response.status).toBe(200);
    expect(manager.get(projectLocator).logs).toHaveLength(1);
  });

  it("checks root, generation, and expected project revision inside the queued save", async () => {
    const root = await savedMockProject();
    const { session, manager } = await openMockSession(root.path);
    const savedConfig = session.locateProject(projectLocator)!.project.mock!;
    const expectedRevision = manager.get(projectLocator).sourceProjectRevision;
    const context = session.captureDraftWriteContext();
    const first = session.saveMockConfig(projectLocator, { ...savedConfig, seed: "first-write" }, expectedRevision, context);
    const stale = session.saveMockConfig(projectLocator, { ...savedConfig, seed: "stale-write" }, expectedRevision, context);

    await expect(first).resolves.toMatchObject({ seed: "first-write" });
    await expect(stale).rejects.toThrow("Mock 配置已变化");
    expect(session.locateProject(projectLocator)!.project.mock?.seed).toBe("first-write");

    const secondRoot = await savedMockProject();
    await session.open(secondRoot.path);
    const secondContext = session.captureDraftWriteContext();
    const secondRevision = manager.get(projectLocator).sourceProjectRevision;
    const sameRootReopen = session.open(secondRoot.path);
    const staleGenerationSave = session.saveMockConfig(projectLocator, { ...savedConfig, seed: "stale-generation" }, secondRevision, secondContext);
    await sameRootReopen;
    await expect(staleGenerationSave).rejects.toThrow("工作区上下文已更改");
    expect(session.locateProject(projectLocator)!.project.mock?.seed).toBe(savedConfig.seed);

    const switchBack = session.open(root.path);
    const staleRootSave = session.saveMockConfig(projectLocator, { ...savedConfig, seed: "stale-root" }, secondRevision, secondContext);
    await switchBack;
    await expect(staleRootSave).rejects.toThrow("工作区上下文已更改");
    expect(session.locateProject(projectLocator)!.project.mock?.seed).toBe("first-write");
  });

  it("keeps same-ID projects at different physical roots isolated across a workspace change", async () => {
    const firstRoot = await savedMockProject();
    const secondRoot = await savedMockProject();
    const { session, manager } = await openMockSession(firstRoot.path);
    const first = await manager.start(projectLocator);
    expect(manager.get(projectLocator).logs).toHaveLength(0);

    await manager.transitionWorkspace(() => session.open(secondRoot.path));
    expect(manager.get(projectLocator).status).toBe("stopped");
    const second = await manager.start(projectLocator);
    expect(second.status).toBe("running");
    expect(manager.get(projectLocator).logs).toHaveLength(0);
    await expect(fetch(`http://127.0.0.1:${first.address!.port}/items/item-7`)).rejects.toThrow();
  });

  it("stops a handle whose asynchronous start resolves after the session generation changes", async () => {
    const firstRoot = await savedMockProject();
    const secondRoot = await savedMockProject();
    const session = createSession();
    await session.open(firstRoot.path);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const lateHandles: Array<{ status: string }> = [];
    const manager = createMockManager({
      session,
      startServer: async (plan) => {
        await startGate;
        const { startMockServer } = await import("@apicc/core");
        const handle = await startMockServer(plan, { port: 0 });
        lateHandles.push(handle);
        return handle;
      },
    });
    managers.push(manager);

    const pending = manager.start(projectLocator);
    await Promise.resolve();
    await session.open(secondRoot.path);
    releaseStart();

    const result = await pending;
    expect(result.status).toBe("stopped");
    expect(lateHandles).toHaveLength(1);
    expect(lateHandles[0]!.status).toBe("stopped");
  });

  it("does not admit a start until workspace transition has stopped old handles and opened the new root", async () => {
    const firstRoot = await savedMockProject();
    const secondRoot = await savedMockProject();
    const session = createSession();
    await session.open(firstRoot.path);
    let releaseStop!: () => void;
    let stopEntered!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopping = new Promise<void>((resolve) => { stopEntered = resolve; });
    let startCount = 0;
    const handles: MockServerHandle[] = [];
    const manager = createMockManager({
      session,
      startServer: async () => {
        startCount += 1;
        const first = startCount === 1;
        let currentStatus: MockServerHandle["status"] = "running";
        const handle = {
          address: { address: "127.0.0.1", family: "IPv4", port: 41_000 + startCount },
          get status() { return currentStatus; },
          beginReload() {},
          async reload() {},
          invalidate() {},
          logs: () => [],
          async stop() {
            if (first) {
              stopEntered();
              await stopGate;
            }
            currentStatus = "stopped";
          },
        } as unknown as MockServerHandle;
        handles.push(handle);
        return handle;
      },
    });
    managers.push(manager);
    await manager.start(projectLocator);

    try {
      const transition = manager.transitionWorkspace(() => session.open(secondRoot.path));
      await stopping;
      const staleStart = manager.start(projectLocator);
      await Promise.resolve();
      expect(startCount).toBe(1);
      releaseStop();
      await transition;

      await expect(staleStart).rejects.toThrow("工作区已切换");
      expect(startCount).toBe(1);
      const nextStart = manager.start(projectLocator);
      const result = await nextStart;
      expect(result.status).toBe("running");
      expect(session.root).toBe(secondRoot.path);
      expect(startCount).toBe(2);
    } finally {
      releaseStop();
    }
  });
});
