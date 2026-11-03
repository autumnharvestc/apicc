// M3-B 任务 1：online:* 频道 IPC 接线测试——zod 校验、登录→存 token→请求自动带头、
// 409 冲突经处理器转为冲突结果对象、401 会话失效清 token、未登录可读错误。
import { describe, expect, it, vi } from "vitest";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { OnlineClient } from "../../../src/main/online/client.js";
import type { TokenStore } from "../../../src/main/online/tokenStore.js";
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IDS, makeWorkspace, persistWorkspace } from '../helpers/contract-assets.js';
import { aiReportDigest } from '../../../src/shared/ai/reportDigest.js';
import { ContractWorkspaceSchema, encodeContractProjectFiles } from '@apicc/core';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import { projectAssetsManifestHash } from '@apicc/execution/host';
import { defaultPolicyConfig } from '@apicc/execution/contract';
import { createHash } from 'node:crypto';

const json = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const USER = { id: "u-1", username: "alice", displayName: "Alice" };

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** 组合：createIpcDeps + 注入假 fetch 的 createClient 工厂 + 内存 tokenStore。 */
function setup(handler: (req: CapturedRequest) => Response) {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    return handler(req);
  };
  const savedTokens = new Map<string, string>();
  let cleared: string[] = [];
  const tokenStore: TokenStore = {
    save: (baseUrl, token) => {
      savedTokens.set(baseUrl, token);
    },
    load: (baseUrl) => savedTokens.get(baseUrl) ?? null,
    clear: (baseUrl) => {
      cleared = [...cleared, baseUrl];
      savedTokens.delete(baseUrl);
    },
  };
  const session = createSession();
  const deps = createIpcDeps({
    session,
    pickDirectory: async () => "",
    saveFile: async () => "",
    online: {
      fetch: impl,
      createClient: (baseUrl, hooks): OnlineClient =>
        createOnlineClient({ baseUrl, fetch: impl, timeoutMs: 5_000, onUnauthorized: hooks.onUnauthorized }),
      tokenStore,
    },
  });
  return { deps, session, calls, savedTokens, tokenStore, getCleared: () => cleared };
}

describe("online:* 频道接线", () => {
  it.each(['current', 'relogin', 'other-window', 'relogin-report', 'other-window-report'])('previews the actual online local execution in its owning window without a filesystem root: %s', async change => {
    const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } }, owner = {}, runId = randomUUID();
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    project.workflows = [{ id: '00000000-0000-4000-8000-000000000091', name: 'No target traffic', status: 'enabled', nodes: [{ id: 'only', kind: 'noop' }], edges: [] }];
    const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: '1', hash: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) }));
    const assets = { ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version: '1', manifestHash: projectAssetsManifestHash(files), files };
    const f = setup(req => {
      if (req.url.endsWith('/auth/login')) return json(200, { token: 'tok', expiresAt: '2099-01-01T00:00:00Z', user: { ...USER, id: '7' } });
      if (req.url.endsWith('/tree')) return json(200, { workspaceId: '11', rootVersion: 1, files: [], projects: [] });
      if (req.url.endsWith('/groups')) return json(200, []);
      if (req.url.endsWith('/execution-agents')) return json(200, { agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig });
      if (req.url.endsWith('/execution-snapshots')) return json(200, { snapshotId: '66', createdByUserId: '7', assets });
      if (req.url.includes('/local-materials')) return json(200, { snapshotId: '66', scope: context.scope, credentials: [], attachments: [] });
      return json(400, { code: 'unexpected_test_request' });
    });
    try {
      await f.deps.handle('online:login', {}, { baseUrl: 'https://control.test', username: 'alice', password: 'password8' }); await f.deps.handle('online:workspace:open', {}, { workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
      const result = await f.deps.handle('online:execution', { sender: owner }, { operation: 'run', context, runId, location: { kind: 'local' }, target: { kind: 'workflow', workflowId: project.workflows[0]!.id }, expectedVersion: '1', runConfig: {}, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] });
      expect(result).toMatchObject({ location: { kind: 'local' }, runId }); expect(f.session.root).toBeNull(); const count = f.calls.length;
      const preview = await f.deps.handle('online:collaboration', { sender: owner }, { operation: 'preview-local', context, title: 'Online local result', source: { kind: 'online-local', runId } });
      expect(preview).toMatchObject({ stage: 'local', artifact: { source: { trust: 'member-claim' } } }); expect(f.calls).toHaveLength(count);
      if (change.startsWith('relogin')) { await f.deps.handle('online:login', {}, { baseUrl: 'https://control.test', username: 'alice', password: 'password8' }); await f.deps.handle('online:workspace:open', {}, { workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' }); }
      const reader = change.startsWith('other-window') ? {} : owner;
      if (change.endsWith('-report')) { const read = await f.deps.handle('online:execution', { sender: reader }, { operation: 'report', context, runId, location: { kind: 'local' } }); expect(read).toMatchObject({ location: { kind: 'local' }, runId }); }
      if (change !== 'current') { const after = f.calls.length; await expect(f.deps.handle('online:collaboration', { sender: reader }, { operation: 'preview-local', context, title: 'Old online result', source: { kind: 'online-local', runId } })).rejects.toThrow('collaboration-source-unavailable'); expect(f.calls).toHaveLength(after); }
    } finally { await f.deps.stopOnlineExecutions(); }
  });
  it.each(['collection', 'suite', 'workflow'])('registers the actual native %s return as a window-owned collaboration source without AI', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'apicc-collab-ipc-')), owner = {};
    const member = { ...USER, id: '7' };
    const f = setup(req => req.url.endsWith('/auth/login') ? json(200, { token: 'tok-1', expiresAt: '2099-01-01T00:00:00Z', user: member }) : req.url.endsWith('/tree') ? json(200, { workspaceId: '11', rootVersion: 1, files: [], projects: [] }) : json(200, []));
    try {
      const workspace = makeWorkspace(), project = workspace.groups[0]!.projects[0]!, workflowId = randomUUID(), suiteId = randomUUID();
      project.collections[0]!.apis = []; project.collections[0]!.folders = [];
      project.workflows = [{ id: workflowId, name: 'no external execution', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }];
      project.suites = [{ formatVersion: 1, id: suiteId, name: 'selected noop', tags: [], selection: { kind: 'explicit', entries: [{ id: randomUUID(), kind: 'workflow', workflowId }] }, failFast: false, reporters: ['json'] }];
      await persistWorkspace(root, workspace); await f.session.open(root);
      await f.deps.handle('online:login', {}, { baseUrl: 'https://control.test', username: 'alice', password: 'password8' }); await f.deps.handle('online:workspace:open', {}, { workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
      const projectRef = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, event = { sender: owner };
      const displayed = kind === 'collection' ? await f.deps.handle('run:collection', event, { locator: { ...projectRef, collectionId: IDS.collectionOne } }) : kind === 'suite' ? await f.deps.handle('testing:suite:run', event, { invocationId: randomUUID(), context: { root, revision: f.session.revision!, project: projectRef }, locator: { ...projectRef, suiteId } }) : await f.deps.handle('wf:run', event, { locator: { ...projectRef, workflowId }, invocationId: randomUUID(), root });
      expect(displayed).toBeTruthy(); const count = f.calls.length;
      const result = await f.deps.handle('online:collaboration', event, { operation: 'preview-local', context: { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } }, title: 'Selected native result', source: { kind: 'current', project: projectRef, expectedReportDigest: await aiReportDigest(displayed) } });
      expect(result).toMatchObject({ stage: 'local', artifact: { kind: 'report', source: { trust: 'member-claim' } } }); expect(f.calls).toHaveLength(count);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('routes the collaboration member read through the actual IPC sender and bound session', async () => {
    const member = { ...USER, id: '7' };
    const access = { accountEnabled: true, member: true, workspaceRole: 'EDITOR', projectOverride: null, overrideState: 'inherited', effectiveRole: 'EDITOR', capabilities: ['history.read'], accessRevision: 2, membershipEpoch: 3, responsibilityEpoch: 4, reasonCode: null };
    const f = setup(req => req.url.endsWith('/auth/login') ? json(200, { token: 'tok-1', expiresAt: '2099-01-01T00:00:00Z', user: member }) : req.url.includes('/tree') ? json(200, { workspaceId: '11', rootVersion: 1, files: [], projects: [] }) : req.url.endsWith('/groups') ? json(200, []) : json(200, access));
    await f.deps.handle('online:login', {}, { baseUrl: 'https://control.test', username: 'alice', password: 'password8' });
    await f.deps.handle('online:workspace:open', {}, { workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
    const input = { operation: 'access', context: { serverId: 'https://control.test/api/v1', ownerId: member.id, scope: { workspaceId: '11', groupId: '22', projectId: '33' } }, input: {} };
    expect(await f.deps.handle('online:collaboration' as any, { sender: {} }, input)).toEqual({ stage: 'access', access });
    expect(f.calls.at(-1)!.url).toBe('https://control.test/api/v1/workspaces/11/projects/33/access');
    const count = f.calls.length;
    await expect(f.deps.handle('online:collaboration', {}, input as any)).rejects.toThrow('collaboration-candidate-unavailable');
    await expect(f.deps.handle('online:collaboration', { sender: {} }, { ...input, path: 'C:\\private' } as any)).rejects.toThrow('入参校验失败'); expect(f.calls).toHaveLength(count);
  });
  it("online:login → 请求拼装正确、token 入库、返回不含 token（token 不出 main 进程）；后续 me 自动带头", async () => {
    const { deps, calls, savedTokens } = setup((req) =>
      req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, USER),
    );
    const result = await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    expect(result).toEqual({ expiresAt: "2026-10-03T00:00:00Z", user: USER });
    expect(result).not.toHaveProperty("token");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/api/v1/auth/login");
    expect(savedTokens.get("http://127.0.0.1:8080")).toBe("tok-1");
    expect(await deps.handle("online:me", {})).toEqual(USER);
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("online:register 不建立会话（不存 token）", async () => {
    const { deps, savedTokens } = setup(() => json(201, USER));
    const user = await deps.handle("online:register", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8", displayName: "Alice" });
    expect(user).toEqual(USER);
    expect(savedTokens.size).toBe(0);
  });

  it("online:files:put 遇 409 → 处理器返回 { outcome: conflict, conflict }（冲突对象过 IPC 不丢字段）", async () => {
    const conflict = { code: "version_conflict", currentVersion: 9, currentHash: "h9" };
    const { deps } = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(409, conflict)));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    const result = await deps.handle("online:files:put", {}, { workspaceId: "ws-1", path: "a.yaml", content: "x", baseVersion: 7 });
    expect(result).toEqual({ outcome: "conflict", conflict });
  });

  it("online:files:put 成功 → { outcome: pushed, result }；delete → { outcome: deleted }", async () => {
    const { deps } = setup((req) => {
      if (req.url.endsWith("/auth/login")) return json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER });
      if (req.method === "PUT") return json(201, { path: "a.yaml", version: 8, hash: "h8" });
      return new Response(null, { status: 204 });
    });
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    expect(await deps.handle("online:files:put", {}, { workspaceId: "ws-1", path: "a.yaml", content: "x", baseVersion: 7 }))
      .toEqual({ outcome: "pushed", result: { path: "a.yaml", version: 8, hash: "h8" } });
    expect(await deps.handle("online:files:delete", {}, { workspaceId: "ws-1", path: "a.yaml", baseVersion: 8 }))
      .toEqual({ outcome: "deleted" });
  });

  it("带 token 请求 401 → 会话失效：token 清除 + 后续调用抛「尚未登录」", async () => {
    const { deps, getCleared } = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(401, { code: "token_expired", message: "登录已过期" })));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    await expect(deps.handle("online:me", {})).rejects.toMatchObject({ message: "登录已过期" });
    expect(getCleared()).toEqual(["http://127.0.0.1:8080"]);
    await expect(deps.handle("online:me", {})).rejects.toThrow(/^online-not-signed-in$/);
  });

  it("online:logout → 调用服务端吊销并清 token；后续调用抛「尚未登录」", async () => {
    const { deps, calls, getCleared } = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : new Response(null, { status: 204 })));
    await deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    await deps.handle("online:logout", {});
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe("http://127.0.0.1:8080/api/v1/auth/logout");
    expect(getCleared()).toEqual(["http://127.0.0.1:8080"]);
    await expect(deps.handle("online:me", {})).rejects.toThrow(/^online-not-signed-in$/);
  });

  it("未登录时内容频道抛「尚未登录」；入参非法走 zod 校验错误", async () => {
    const { deps } = setup(() => json(200, []));
    await expect(deps.handle("online:workspaces:list", {})).rejects.toThrow(/^online-not-signed-in$/);
    await expect(deps.handle("online:login", {}, { baseUrl: "ftp://x", username: "a", password: "b" })).rejects.toThrow(/入参校验失败/);
    await expect(deps.handle("online:files:put", {}, { workspaceId: "ws-1", path: "../x", content: "", baseVersion: 0 })).rejects.toThrow(/入参校验失败/);
  });

  it("online 依赖未注入 → 可读错误（在线功能未配置）", async () => {
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" });
    await expect(deps.handle("online:me", {})).rejects.toThrow(/在线功能未配置/);
  });

  // —— 任务 2 裁定 A：online:resume 恢复链路频道 ——
  it("online:resume：登录后有存档 → restored 携用户；换新 deps（重启语义）→ me 带恢复 token", async () => {
    const first = setup((req) => (req.url.endsWith("/auth/login") ? json(200, { token: "tok-1", expiresAt: "2026-10-03T00:00:00Z", user: USER }) : json(200, USER)));
    await first.deps.handle("online:login", {}, { baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    // 重启语义：同一 tokenStore 存档 + 全新 ipc deps（main 进程重新组装）
    const second = setup(() => json(200, USER));
    second.tokenStore.save("http://127.0.0.1:8080", "tok-1");
    const out = await second.deps.handle("online:resume", {}, { baseUrl: "http://127.0.0.1:8080" });
    expect(out).toEqual({ outcome: "restored", user: USER });
    const meCall = second.calls.find((c) => c.url.endsWith("/me"))!;
    expect(meCall.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("online:resume：过期存档 → signed-out（已清档）；无存档 → signed-out；入参非法走 zod 校验", async () => {
    const expired = setup((req) => (req.url.endsWith("/me") ? json(401, { code: "token_expired", message: "登录已过期" }) : json(200, USER)));
    expired.tokenStore.save("http://127.0.0.1:8080", "tok-stale");
    await expect(expired.deps.handle("online:resume", {}, { baseUrl: "http://127.0.0.1:8080" })).resolves.toEqual({ outcome: "signed-out" });
    // 401 钩子与 resume 失败收口都按捕获的 baseUrl 清档（幂等，审查重要 1）：清档只落在目标
    expect(expired.getCleared().every((b) => b === "http://127.0.0.1:8080")).toBe(true);
    expect(expired.getCleared().length).toBeGreaterThan(0);
    const guest = setup(() => json(200, USER));
    await expect(guest.deps.handle("online:resume", {}, { baseUrl: "http://127.0.0.1:8080" })).resolves.toEqual({ outcome: "signed-out" });
    await expect(guest.deps.handle("online:resume", {}, { baseUrl: "ftp://x" })).rejects.toThrow(/入参校验失败/);
  });
});
