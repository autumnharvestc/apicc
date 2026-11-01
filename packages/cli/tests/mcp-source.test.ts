import { mkdtempSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage, type Workspace } from "@apicc/core";
import { createMcpSource } from "../src/mcp/source.js";
import { boundedJson, createPager } from "../src/mcp/pagination.js";
import { onlineFixture } from "./mcp-online.fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
export const pid = "00000000-0000-4000-8000-000000000003";
export async function localFixture() {
  const root = mkdtempSync(join(tmpdir(), "apicc-mcp-source-")); roots.push(root);
  const workspace: Workspace = { formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", name: "workspace", variables: {}, groups: [{ id: "00000000-0000-4000-8000-000000000002", name: "group", projects: [{
    id: pid, name: "project", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, collections: [], models: [], components: [], workflows: [], environments: [], stressPolicy: {},
  }] }] };
  const initial = await fileStorage.load(root); await fileStorage.save(root, workspace, { expectedRevision: initial.revision, deletions: [] });
  return { root, workspace };
}

// A source returning a stale/different project or no Core context must fail this consumer contract.
it("captures one local source and reads a Core project snapshot with an opaque matching binding", async () => {
  const f = await localFixture();
  const source = await createMcpSource({ workspace: f.root, registry: createDefaultRegistry() });
  try {
    const read = await source.readProject(pid, new AbortController().signal);
    expect(read.snapshot.project.id).toBe(pid);
    expect(read.binding).toMatchObject({ kind: "local", projectId: pid, definitionRevision: read.snapshot.definitionRevision });
    expect(JSON.stringify(source.identity)).not.toContain(f.root);
    expect(read.revision).toBeTruthy();
  } finally { await source.close(); }
});

// Accepting both fixed-source selectors would silently choose an identity.
it("refuses simultaneous workspace and online profile selectors", async () => {
  const f = await localFixture();
  await expect(createMcpSource({ workspace: f.root, onlineProfile: "member" } as never)).rejects.toThrow(/互斥|exactly one/);
});
// Keeping the local loader alive after close would allow an obsolete source to serve data.
it("invalidates a closed local source before further reads", async () => {
  const f = await localFixture(); const source = await createMcpSource({ workspace: f.root });
  await source.close();
  await expect(source.readProject(pid, new AbortController().signal)).rejects.toThrow(/closed|失效/);
});
// Replacing the root by a junction must never read a different workspace under a captured binding.
it("refuses a captured workspace root replaced by a junction", async () => {
  const f = await localFixture(); const other = await localFixture();
  const source = await createMcpSource({ workspace: f.root });
  const moved = `${f.root}-original`; renameSync(f.root, moved); roots.push(moved);
  symlinkSync(other.root, f.root, "junction");
  try { await expect(source.readProject(pid, new AbortController().signal)).rejects.toThrow(/source.*changed|边界|工作区存在格式或资产问题/); }
  finally { await source.close(); }
});

// JSON encodes an unpaired UTF-16 surrogate as six ASCII bytes, not three replacement bytes.
it("refuses JSON whose escaped lone surrogate would exceed the byte budget", () => {
  expect(() => boundedJson({ value: "\ud800" }, 16)).toThrow(/预算/);
});
// A real surrogate pair remains one four-byte emoji and must fit its exact JSON budget.
it("retains a valid emoji when its complete JSON fits the byte budget", () => {
  expect(boundedJson({ value: "😀" }, 16)).toBe('{"value":"😀"}');
  expect(Buffer.byteLength(boundedJson({ value: "😀" }, 16))).toBe(16);
});

// Online reads must consume the T6 assets seam; no prepare/snapshot side effect is allowed.
it("reads the online allowlisted project through the member assets client without creating a snapshot", async () => {
  const f = await onlineFixture(); roots.push(f.home);
  const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps });
  try {
    const read = await source.readProject("3", new AbortController().signal);
    expect(read.snapshot.project.id).toBe(f.project.id);
    expect(read.binding).toMatchObject({ kind: "online", memberIdentity: "7", workspaceId: "1", groupId: "2", serverProjectId: "3", projectVersion: "1" });
    expect(f.requests.some(request => request.url.endsWith("/workspaces/1/projects/3/assets"))).toBe(true);
    expect(f.requests.filter(request => !request.url.endsWith("/auth/login")).every(request => request.method === "GET" && request.authorization === "Bearer ONLINE_SYNTHETIC_MEMBER")).toBe(true);
    expect(JSON.stringify(source.identity)).not.toContain("ONLINE_SYNTHETIC_MEMBER");
  } finally { await source.close(); }
});

// Closing a source must revoke the read surface even when the underlying member assets method is reusable.
it("invalidates online reads when the source closes", async () => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps });
  await source.close(); await expect(source.readProject("3", new AbortController().signal)).rejects.toThrow(/closed|失效/);
});
// 401/403 end this captured identity; later requests must not silently resume on the old connection.
it.each([401, 403])("requires a new login after current online authority returns %s", async status => {
  const f = await onlineFixture(); roots.push(f.home); const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const signal = new AbortController().signal;
  try {
    f.meStatus(status); await expect(source.readProject("3", signal)).rejects.toThrow();
    f.meStatus(200); await expect(source.readProject("3", signal)).rejects.toThrow(/失效|重新登录/);
  } finally { await source.close(); }
});

// Paging a lazy real iterator must stop after the returned window and one lookahead item.
it("pages a lazy asset iterator without materializing its remaining rows", () => {
  let consumed = 0;
  function* rows() { for (let index = 0; index < 10000; index++) { consumed++; yield index; } }
  const page = createPager().page(rows(), { limit: 2 }, "fixed-query");
  expect(page.items).toEqual([0, 1]); expect(consumed).toBe(3); expect(page.nextCursor).toBeTruthy();
});
