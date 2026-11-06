import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateReadOwner, createRuntimeSourceHost } from "../src/sourceHost.js";
import { rpc, withSyncUrlRuntime } from "./sync-runtime-fixture.js";

const replacement = vi.hoisted(() => ({ root: "", moved: "", enabled: false }));
const observed = vi.hoisted(() => ({ root: "", handles: [] as import("node:fs/promises").FileHandle[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: unknown[]) => {
    const handle = await Reflect.apply(actual.open, actual, args);
    if (args[0] === observed.root) observed.handles.push(handle);
    return handle;
  }, stat: async (...args: unknown[]) => {
    const result = await Reflect.apply(actual.stat, actual, args);
    if (replacement.enabled && args[0] === replacement.root && (args[1] as { bigint?: boolean })?.bigint) {
      replacement.enabled = false;
      await actual.rename(replacement.root, replacement.moved);
      await actual.mkdir(replacement.root);
    }
    return result;
  } };
});

async function liveHandles() {
  return (await Promise.all(observed.handles.map(handle => handle.stat().then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    return false;
  })))).filter(Boolean).length;
}

const identity = async (path: string) => {
  const info = await stat(path, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
};

it("new private roots remain independent after external removal of a retained source root", async () => {
  let retainedRoot = "", retainedIdentity: Awaited<ReturnType<typeof identity>> | undefined;
  await withSyncUrlRuntime(async fixture => {
    retainedRoot = fixture.privateRoot; retainedIdentity = await identity(retainedRoot);
    const response = await rpc(fixture.runtime.url, "sync-read", fixture.payload());
    expect(await response.json()).toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED" });
    expect(fixture.runtime.sourceCapacity()).toEqual({ held: 1, retained: 1 });
    expect(await readdir(join(retainedRoot, ".apicc-sync-owners"))).toHaveLength(1);
    await expect(fixture.runtime.close()).rejects.toThrow("SYNC_PROCESS_UNCOLLECTED");
    await expect(createRuntimeSourceHost({ privateRoot: retainedRoot, allowedOrigins: [], allowedCidrs: [] })).rejects.toThrow("SYNC_PROCESS_UNCOLLECTED");
    expect(await liveHandles()).toBe(1);
  }, root => {
    observed.root = root; observed.handles = [];
    return { createPrivateRead: async () => {
      const owner = await createPrivateReadOwner(root);
      return { ...owner, collect: async () => { throw Error("synthetic unavailable collection proof"); } };
    } };
  }, true);
  expect(await stat(retainedRoot).then(() => true, () => false)).toBe(false);
  expect(await liveHandles()).toBe(1);
  const pinned = await observed.handles[0]!.stat({ bigint: true });
  expect({ dev: pinned.dev.toString(), ino: pinned.ino.toString() }).toEqual(retainedIdentity);
  observed.root = "";

  // Real allocators may reuse an unlinked directory's inode. Each directory is
  // freshly allocated and empty; none is an alias of the retained physical root.
  for (let attempt = 0; attempt < 64; attempt++) {
    const freshRoot = await mkdtemp(join(tmpdir(), "apicc-sync-runtime-"));
    let host: Awaited<ReturnType<typeof createRuntimeSourceHost>> | undefined;
    try {
      const freshIdentity = await identity(freshRoot);
      if (freshIdentity.dev === retainedIdentity!.dev && freshIdentity.ino === retainedIdentity!.ino)
        console.log("CI92_ROOT_REUSE", JSON.stringify({ attempt, retainedRoot, retainedIdentity, freshRoot, freshIdentity }));
      const opened = await createRuntimeSourceHost({ privateRoot: freshRoot, allowedOrigins: [], allowedCidrs: [] })
        .then(value => { host = value; return "ready"; }, error => (error as Error).message);
      expect(opened).toBe("ready");
      expect(host!.capacity()).toEqual({ held: 0, retained: 0 });
    } finally { await host?.close(); await rm(freshRoot, { recursive: true, force: true }); }
  }
  console.log("CI92_ROOT_LIFECYCLE", JSON.stringify({ retainedRoot, retainedIdentity, independentRoots: 64, retainedHandles: 1, retainedLinks: pinned.nlink.toString() }));
});

it("refuses a real root replacement between its path identity check and directory handle acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "apicc-sync-root-replaced-")), moved = root + "-moved";
  const original = await identity(root);
  let host: Awaited<ReturnType<typeof createRuntimeSourceHost>> | undefined;
  Object.assign(replacement, { root, moved, enabled: true });
  observed.root = root; observed.handles = [];
  try {
    const opened = await createRuntimeSourceHost({ privateRoot: root, allowedOrigins: [], allowedCidrs: [] })
      .then(value => { host = value; return "ready"; }, error => (error as Error).message);
    const current = await identity(root);
    expect(current).not.toEqual(original);
    console.log("CI92_ROOT_REPLACED", JSON.stringify({ root, moved, original, current, opened }));
    expect(opened).toBe("SYNC_HOST_CONFIG_INVALID");
    expect(await readdir(root)).toEqual([]);
    expect(await liveHandles()).toBe(0);
  } finally {
    replacement.enabled = false; observed.root = ""; await host?.close();
    await rm(root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true });
  }
});

it("shared providers release candidate handles and close their physical-root handle only after the final provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "apicc-sync-root-handles-"));
  const providers: Awaited<ReturnType<typeof createRuntimeSourceHost>>[] = [];
  observed.root = root; observed.handles = [];
  try {
    const source = { privateRoot: root, allowedOrigins: [], allowedCidrs: [] };
    providers.push(await createRuntimeSourceHost(source), await createRuntimeSourceHost(source));
    expect(await liveHandles()).toBe(1);
    await providers[0]!.close(); expect(await liveHandles()).toBe(1);
    await providers[1]!.close(); expect(await liveHandles()).toBe(0);
    // A failed initializer must not leave a directory handle open either.
    await mkdir(join(root, ".apicc-sync-owners"));
    await writeFile(join(root, ".apicc-sync-owners", "owned-test-marker.json"), '{"formatVersion":1,"status":"uncollected"}');
    await expect(createRuntimeSourceHost(source)).rejects.toThrow("SYNC_PROCESS_UNCOLLECTED");
    expect(await liveHandles()).toBe(0);
  } finally {
    observed.root = "";
    for (const provider of providers) await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
