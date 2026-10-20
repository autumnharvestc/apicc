// memory 替身复用正式压力控制器；仅 transport 与 history 使用内存实现。
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialError, fileStorage, StressReportSchema, type CredentialScope, type ProtocolClient, type SecretRef, type SecretStore, type StorageAdapter } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { contractAssetFixture, duplicateContractProjectAcrossGroups } from "../helpers/contract-assets.js";

type TestManagedClient = ProtocolClient & { close(): Promise<void> };

async function seededMemory(client?: TestManagedClient) {
  const api = createMemoryApi(client ? { stressClient: client } : undefined);
  const fixture = await contractAssetFixture(api);
  const detail = await api.apiGet(fixture.apiLocator);
  return { api, locator: fixture.apiLocator, caseId: detail.api.cases[0]!.id };
}

/** 挂起假 client：execute 进入即计数并停在 gate 上，制造活动运行窗口。 */
function hangingClient() {
  let entered = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client: TestManagedClient = {
    name: "hanging",
    canHandle: () => true,
    execute: async () => {
      entered += 1;
      await gate;
      return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
    },
    close: async () => {},
  };
  return {
    client,
    waitEntered: async () => { while (entered === 0) await new Promise((resolve) => setTimeout(resolve, 1)); },
    release: () => release(),
  };
}

function syntheticSecretStore() {
  const values = new Map<string, string>();
  let nextPutFailure = false;
  const key = (scope: CredentialScope, ref: SecretRef) => JSON.stringify([scope.workspaceId, scope.groupId, scope.projectId, ref.id, ref.policy]);
  const store: SecretStore = {
    async put(scope, ref, value) {
      if (nextPutFailure) {
        nextPutFailure = false;
        throw new CredentialError("CREDENTIAL_SAVE_FAILED", ref.id);
      }
      values.set(key(scope, ref), value);
    },
    async resolve(scope, ref) {
      const value = values.get(key(scope, ref));
      if (value === undefined) throw new CredentialError("CREDENTIAL_MISSING", ref.id);
      return value;
    },
    async version(scope, ref) { return values.has(key(scope, ref)) ? "1" : "0"; },
    async remove(scope, ref) { values.delete(key(scope, ref)); },
    async status(scope, ref) { return values.has(key(scope, ref)) ? "available" : "missing"; },
  };
  return { store, values, failNextPut: () => { nextPutFailure = true; } };
}

describe("memory 替身正式压力控制器入口", () => {
  it("Mock 仅仿真 UI 状态，不绑定 HTTP 地址或生成网络日志", async () => {
    const { api, locator: apiLocator } = await seededMemory();
    const locator = { workspaceId: apiLocator.workspaceId, groupId: apiLocator.groupId, projectId: apiLocator.projectId };
    const initial = await api.mockGet(locator);
    expect(initial).toMatchObject({ simulated: true, status: "stopped", address: null, logs: [] });
    const saved = await api.mockConfigSave({
      locator,
      sourceProjectRevision: initial.sourceProjectRevision,
      config: { formatVersion: 1, seed: "memory-seed", enabledContractIds: [], rules: [] },
    });
    const started = await api.mockStart({ locator, sourceProjectRevision: saved.sourceProjectRevision, port: 0 });
    expect(started).toMatchObject({ simulated: true, status: "running", address: null, logs: [] });
  });

  it("未确认目标通过结构化结果返回精确 origin，而不是抛出带自定义字段的 Error", async () => {
    const { api, locator, caseId } = await seededMemory();
    const out = await api.stressRun({ locator, caseId, concurrency: 1, maxIterations: 1 });
    expect(out).toEqual({ ok: false, error: { code: "target_confirmation_required", message: expect.any(String), targetOrigin: "http://127.0.0.1" } });
  });

  it("假 client 产出正式 schema 报告与内存历史 stress 行", async () => {
    let calls = 0;
    const client: TestManagedClient = {
      name: "fake",
      canHandle: () => true,
      execute: async () => {
        calls += 1;
        return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
      },
      close: async () => {},
    };
    const { api, locator, caseId } = await seededMemory(client);
    const out = await api.stressRun({ locator, caseId, concurrency: 2, maxIterations: 4, confirmedTargetOrigins: ["http://127.0.0.1"] });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error.message);
    expect(calls).toBe(4);
    expect(() => StressReportSchema.parse(out.report)).not.toThrow();
    expect(out.report.totalRequests).toBe(4);
    expect(out.file).toMatch(/^stress-.+-\d+\.json$/);
    const list = await api.runsList();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("stress");
    expect(list[0]).toMatchObject({ totalRequests: 4, ok: 4, failed: 0 });
    const detail = await api.runsGet(out.file!);
    expect(detail).toEqual({ kind: "stress", report: out.report });
  });

  it("单活动拒绝与 stop：活动窗口内二次启动拒绝，stop 等待部分报告", async () => {
    const fake = hangingClient();
    const { api, locator, caseId } = await seededMemory(fake.client);
    await expect(api.stressStop()).rejects.toThrow(/没有进行中的压测/);
    const first = api.stressRun({ locator, caseId, concurrency: 1, maxIterations: 100, confirmedTargetOrigins: ["http://127.0.0.1"] });
    await fake.waitEntered();
    await expect(api.stressRun({ locator, caseId, concurrency: 1, maxIterations: 100 })).rejects.toThrow(/已有压测进行中/);
    const stopping = api.stressStop();
    fake.release();
    const stopped = await stopping;
    expect(stopped.report.totalRequests).toBeGreaterThanOrEqual(1);
    expect(stopped.report.totalRequests).toBeLessThanOrEqual(100);
    await first;
    await expect(api.stressStop()).rejects.toThrow(/没有进行中的压测/);
  });

  it("正式完整 locator 错误与用例/环境错误仍保留主进程文案", async () => {
    const { api, locator, caseId } = await seededMemory();
    await expect(api.stressRun({ locator: { ...locator, apiId: "00000000-0000-4000-8000-000000000001" }, caseId, concurrency: 1, maxIterations: 1 })).rejects.toThrow(/未找到接口:/);
    await expect(api.stressRun({ locator, caseId: "ghost", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/用例不存在: ghost/);
    await expect(api.stressRun({ locator, caseId, envName: "ghost", concurrency: 1, maxIterations: 1 })).rejects.toThrow(/未找到环境: ghost/);
  });

  it("终止条件缺失沿用 core 文案", async () => {
    const { api, locator, caseId } = await seededMemory();
    await expect(api.stressRun({ locator, caseId, concurrency: 1 })).rejects.toThrow(/压测终止条件缺失/);
  });

  it("报告返回值与内存历史深拷贝隔离", async () => {
    const { api, locator, caseId } = await seededMemory();
    const out = await api.stressRun({ locator, caseId, concurrency: 1, maxIterations: 2, confirmedTargetOrigins: ["http://127.0.0.1"] });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error.message);
    out.report.totalRequests = 999;
    const detail = await api.runsGet(out.file!);
    expect(detail).toMatchObject({ kind: "stress", report: { totalRequests: 2 } });
  });
});

describe("memory 替身正式资产入口", () => {
  it("apiGet/apiSave 按完整 ApiLocator 使用唯一 ContractWorkspace ApiAsset 事实源", async () => {
    const fixture = await contractAssetFixture();
    const detail = await fixture.api.apiGet(fixture.apiLocator);
    expect(detail.locator).toEqual(fixture.apiLocator);
    expect(detail.api).toMatchObject({
      contract: { formatVersion: 1, id: fixture.apiNode.id, metadata: { name: "示例接口", version: "1.0.0" } },
      cases: [{ id: expect.any(String), scope: "base", preOperations: [], postOperations: [] }],
      documentation: "",
    });
    expect(detail.envs).toEqual([]);

    detail.api.documentation = "正式文档草稿";
    detail.api.cases[0]!.preOperations = [{ id: "before", type: "script", content: "pm.variables.set('before', 'yes')" }];
    detail.api.cases[0]!.postOperations = [{ id: "after", type: "script", content: "pm.variables.set('after', 'yes')" }];
    await fixture.api.apiSave(fixture.apiLocator, detail.api, detail.sourceApiRevision);
    const reopened = await fixture.api.apiGet(fixture.apiLocator);
    expect(reopened.api.documentation).toBe("正式文档草稿");
    expect(reopened.api.cases[0]!.preOperations).toEqual(detail.api.cases[0]!.preOperations);
    expect(reopened.api.cases[0]!.postOperations).toEqual(detail.api.cases[0]!.postOperations);
  });

  it("modelList 接受完整 ProjectLocator", async () => {
    const fixture = await contractAssetFixture();
    expect(await fixture.api.modelList(fixture.projectLocator)).toEqual([]);
  });
});

describe("memory 替身正式工作流入口", () => {
  it("用完整 WorkflowLocator 假执行已发布工作流", async () => {
    const fixture = await contractAssetFixture();
    const workflow = await fixture.api.wfCreate({ locator: fixture.projectLocator, name: "可运行工作流" });
    const locator = { ...fixture.projectLocator, workflowId: workflow.id };
    await fixture.api.wfSetStatus(locator, "published");

    const result = await fixture.api.wfRun({ locator });

    expect(result).toMatchObject({ workflowId: workflow.id, workflowName: "可运行工作流", status: "published", nodeResults: [] });
  });

  it("拒绝把存在的工作流 ID 用于另一个项目的完整定位", async () => {
    const fixture = await contractAssetFixture();
    const workflow = await fixture.api.wfCreate({ locator: fixture.projectLocator, name: "仅属原项目" });
    const locator = { ...fixture.projectLocator, workflowId: workflow.id };
    await fixture.api.wfSetStatus(locator, "published");
    const sibling = await fixture.api.nodeCreate({ kind: "project", parent: fixture.group.locator, name: "另一个项目" });
    if (sibling.kind !== "project") throw new Error(`Expected project DTO, received ${sibling.kind}`);
    const wrongLocator = { ...sibling.locator, workflowId: workflow.id };

    await expect(fixture.api.wfRun({ locator: wrongLocator })).rejects.toThrow(
      `Workflow not found at complete locator: ${JSON.stringify(wrongLocator)}`,
    );
  });
});

describe("memory 替身凭据与持久化边界", () => {
  it("keeps a successful secret put when the referenced ApiAsset file save fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-memory-credential-file-failure-"));
    let failNextSave = false;
    const storage: StorageAdapter = {
      load: (path) => fileStorage.load(path),
      save: (path, workspace, options) => {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject(new Error("injected storage failure"));
        }
        return fileStorage.save(path, workspace, options);
      },
    };
    const secrets = syntheticSecretStore();
    const api = createMemoryApi({ root, storage, secretStore: secrets.store });
    const fixture = await contractAssetFixture(api, root);
    const ref = { id: "one-secret-ref", policy: "test-auto" };
    const put = await api.credentialPut({ locator: fixture.projectLocator, ref, value: "secret-value-not-returned" });
    expect(put).toEqual({ ok: true });
    const detail = await api.apiGet(fixture.apiLocator);
    detail.api.contract.request.auth = { kind: "bearer", token: ref };

    failNextSave = true;
    await expect(api.apiSave(fixture.apiLocator, detail.api, detail.sourceApiRevision)).rejects.toThrow("injected storage failure");
    expect(await api.credentialStatus({ locator: fixture.projectLocator, ref })).toEqual({ ok: true, status: "available" });
    expect(JSON.stringify(await api.credentialStatus({ locator: fixture.projectLocator, ref }))).not.toContain("secret-value-not-returned");
    expect((await api.apiGet(fixture.apiLocator)).api.contract.request.auth).toEqual({ kind: "none" });

    const reopened = createMemoryApi({ root });
    await reopened.wsOpen(root);
    expect((await reopened.apiGet(fixture.apiLocator)).api.contract.request.auth).toEqual({ kind: "none" });
    expect(await secrets.store.resolve({ workspaceId: fixture.projectLocator.workspaceId, groupId: fixture.projectLocator.groupId, projectId: fixture.projectLocator.projectId }, ref)).toBe("secret-value-not-returned");
  });

  it("isolates one ref across groups with the same project ID and preserves the prior value on put failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-memory-credential-scope-"));
    const secrets = syntheticSecretStore();
    const api = createMemoryApi({ root, secretStore: secrets.store });
    const fixture = await contractAssetFixture(api, root);
    const duplicateProject = await duplicateContractProjectAcrossGroups(fixture, "凭据隔离组");
    const duplicateLocator = { ...fixture.projectLocator, groupId: duplicateProject.groupId };
    expect(duplicateLocator.projectId).toBe(fixture.projectLocator.projectId);
    const ref = { id: "same-ref", policy: "test-auto" };
    const originalScope = { workspaceId: fixture.projectLocator.workspaceId, groupId: fixture.projectLocator.groupId, projectId: fixture.projectLocator.projectId };
    const duplicateScope = { ...originalScope, groupId: duplicateProject.groupId };

    expect(await api.credentialPut({ locator: fixture.projectLocator, ref, value: "group-one-value" })).toEqual({ ok: true });
    secrets.failNextPut();
    expect(await api.credentialPut({ locator: fixture.projectLocator, ref, value: "failed-replacement" })).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_SAVE_FAILED", refId: ref.id, message: expect.any(String) },
    });
    expect(await secrets.store.resolve(originalScope, ref)).toBe("group-one-value");
    expect(await api.credentialStatus({ locator: fixture.projectLocator, ref })).toEqual({ ok: true, status: "available" });
    expect(await api.credentialStatus({ locator: duplicateLocator, ref })).toEqual({ ok: true, status: "missing" });

    expect(await api.credentialPut({ locator: duplicateLocator, ref, value: "group-two-value" })).toEqual({ ok: true });
    const status = await api.credentialStatus({ locator: duplicateLocator, ref });
    expect(status).toEqual({ ok: true, status: "available" });
    expect(JSON.stringify(status)).not.toContain("group-two-value");
    expect(await secrets.store.resolve(originalScope, ref)).toBe("group-one-value");
    expect(await secrets.store.resolve(duplicateScope, ref)).toBe("group-two-value");
    expect(await api.credentialRemove({ locator: duplicateLocator, ref })).toEqual({ ok: true });
    expect(await api.credentialStatus({ locator: duplicateLocator, ref })).toEqual({ ok: true, status: "missing" });
    expect(await secrets.store.resolve(originalScope, ref)).toBe("group-one-value");
  });
});
