// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；jsdom 未实现 matchMedia，antd
// 组件挂载需要（见 EnvPanel.test.ts 文件头说明）。文件选择经 input[type=file] 注入
// File 对象 + change 事件驱动（组件即以该通道读文本，Electron 渲染层同语义）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useImportWizardStore } from "../../../src/renderer/src/stores/importW.js";
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
import ImportWizard from "../../../src/renderer/src/components/ImportWizard.vue";
import { ApiAssetSchema, ContractProjectSchema } from "@apicc/core/schema";
import { curlImporter } from "@apicc/core";
import { countingStorage, IDS, makeTempRoot, makeWorkspace, persistWorkspace } from "../../main/helpers/contract-assets.js";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { IpcChannel } from "../../../src/shared/channels.js";
import type { ImportApplyInput, ImportApplyResult } from "../../../src/shared/types.js";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
  localStorage.setItem("apicc.locale", "zh-CN");
});

enableAutoUnmount(afterEach);

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。
 *  apiOverride 供用例预配置替身（如 pluginsList 注入失败）后再装配。 */
async function mountWizard(props: Record<string, unknown> = {}, apiOverride?: ReturnType<typeof createMemoryApi>) {
  const errors: unknown[] = [];
  const api = apiOverride ?? createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const importW = useImportWizardStore(api, workspace);
  // M7-B 任务 1：导入格式清单改走 plugins store 动态枚举（IPC plugins:list 出口），
  // 组合根一次性创建后经 props 下传（组件内零工厂调用）。
  const plugins = createPluginsStore({ api });
  await plugins.init();
  const { i18n } = createI18nInstance();
  const firstGroup = workspace.tree?.children.find((node) => node.kind === "group");
  const componentProps = { ...props };
  const requestedGroups = props.groups as Array<{ locator?: unknown; label?: string }> | undefined;
  if (requestedGroups !== undefined) {
    componentProps.groups = requestedGroups.map((group) => ({
      locator: group.locator ?? firstGroup?.locator,
      label: group.label ?? (firstGroup?.kind === "group" ? firstGroup.label : ""),
    }));
  }
  if ("defaultGroupId" in props) {
    componentProps.defaultGroupLocator = props.defaultGroupId === null ? null : firstGroup?.locator ?? null;
    delete componentProps.defaultGroupId;
  }
  const wrapper = mount(ImportWizard, {
    props: { mode: "project", importW, plugins, reportError: (e: unknown) => { errors.push(e); }, ...componentProps },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, importW, plugins, errors };
}

/** 文件选择适配：jsdom 无法真正弹文件对话框，直接向 input[type=file] 注入 File 并派发 change。 */
async function pickFile(wrapper: Awaited<ReturnType<typeof mountWizard>>["wrapper"], fileName: string, content: string) {
  const input = wrapper.find('[data-testid="import-file-input"]').element as HTMLInputElement;
  const file = new File([content], fileName, { type: "text/yaml" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await input.dispatchEvent(new Event("change"));
  await flushPromises();
}

describe("ImportWizard", () => {
  it("粘贴 cURL 沿现有预览和项目落点进入向导", async () => {
    const api = createMemoryApi();
    const originalPreview = api.importPreview.bind(api);
    api.importPreview = async ({ content }) => {
      const preview = await originalPreview({ fileName: "pasted.curl", content });
      const project = curlImporter.parse(content).project;
      api.setImportPreviewCandidate(preview.token, project);
      const tree = project.collections.map((collection) => ({
        id: collection.id, name: collection.name,
        apis: collection.apis.map((asset) => ({
          id: asset.contract.id, name: asset.contract.metadata.name,
          method: asset.contract.request.protocol === "websocket" ? "WS" : asset.contract.request.method,
          path: asset.contract.request.path,
        })),
      }));
      return { ...preview, importerName: "curl", summary: { ...preview.summary, projectName: project.name, collections: tree.length, apis: tree.reduce((n, c) => n + c.apis.length, 0) }, tree };
    };
    const { wrapper, importW } = await mountWizard({ groups: [{ label: "示例分组" }] }, api);
    await wrapper.get('[data-testid="import-curl-input"]').setValue("curl http://localhost/items");
    await wrapper.get('[data-testid="import-curl-preview"]').trigger("click");
    await flushPromises();
    expect(importW.previewIsCurrent).toBe(true);
    expect(importW.preview?.tree[0]?.apis[0]).toMatchObject({ method: "GET", path: "/items" });
    expect(wrapper.find('[data-testid="import-preview-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-group-select"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-error"]').exists()).toBe(false);
  });

  it("project 模式三步推进：选文件进预览 → 选分组/项目名导入 → 完成态（整包落库、树已刷新）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const seeded = await api.treeGet();
    const gId = seeded.children![0]!.id; // 示例分组（种子）
    const { wrapper, workspace, importW, errors } = await mountWizard({
      mode: "project",
      groups: [{ id: gId, label: "示例分组" }],
      defaultGroupId: gId,
    }, api);
    const originalStoreApply = importW.apply.bind(importW);
    let initialApply: Promise<ImportApplyResult> | undefined;
    importW.apply = (input) => (initialApply = originalStoreApply(input));
    // 第一步：只有文件选择，没有落点表单
    expect(wrapper.find('[data-testid="import-file-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);
    await pickFile(wrapper, "sample.yaml", "openapi: 3.0.0");
    // 第二步：预览树 + 警告 + 分组下拉（预选默认分组）+ 项目名（预填 title）
    expect(wrapper.find('[data-testid="import-preview-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-warnings"]').text()).toContain("示例警告");
    expect(wrapper.find('[data-testid="import-group-select"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="import-name-input"]').element as HTMLInputElement).value).toBe("导入示例项目");
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    if (!initialApply) throw new Error("The wizard must start the import apply");
    await initialApply;
    await flushPromises();
    // 第三步：完成态；apply 记录 project 模式调用、树已刷新出导入项目
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(true);
    expect(api.importApplyCalls).toEqual([{ mode: "project", groupId: gId, name: "导入示例项目" }]);
    const groupNode = workspace.tree!.children!.find((n) => n.id === gId);
    expect(groupNode!.children!.map((n) => n.label)).toContain("导入示例项目");
    expect(importW.applying).toBe(false);

    // A new preview replaces the UI context while the previous refresh is still pending.
    await wrapper.find('[data-testid="import-finish"]').trigger("click");
    await flushPromises();
    let releaseRefresh!: () => void;
    let notifyRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { notifyRefreshStarted = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const originalRefresh = workspace.refresh.bind(workspace);
    workspace.refresh = async () => {
      notifyRefreshStarted();
      await refreshGate;
      await originalRefresh();
    };
    let oldApply: Promise<ImportApplyResult> | undefined;
    importW.apply = (input) => (oldApply = originalStoreApply(input));
    await pickFile(wrapper, "old-import.yaml", "x");
    await wrapper.find('[data-testid="import-name-input"]').setValue("迟到导入");
    const oldContext = importW.previewContext;
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await refreshStarted;
    await wrapper.find('[data-testid="import-prev"]').trigger("click");
    await pickFile(wrapper, "replacement.yaml", "y");
    const replacementContext = importW.previewContext;
    releaseRefresh();
    if (!oldApply) throw new Error("The component must start the original import apply");
    await expect(oldApply).resolves.toMatchObject({ committed: true, undoToken: expect.any(String) });
    await flushPromises();
    expect(replacementContext).not.toBe(oldContext);
    expect(importW.previewIsCurrent).toBe(true);
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(true);
    expect(errors).toEqual([]);
  });

  it("真实 session/storage 已提交后 treeGet 拒绝：显示已提交、禁止重复 mutation，并支持仅刷新恢复", async () => {
    const temporary = await makeTempRoot("apicc-c3-refresh-");
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const initialProjectCount = session.workspace!.groups.reduce((count, group) => count + group.projects.length, 0);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const api = createMemoryApi();
      api.importPreview = (input) => deps.handle(IpcChannel.ImportPreview, null, input);
      api.importPlan = (input) => deps.handle(IpcChannel.ImportPlan, null, input);
      api.importApply = (input) => deps.handle(IpcChannel.ImportApply, null, input);
      api.importUndo = (input) => deps.handle(IpcChannel.ImportUndo, null, input);
      api.treeGet = () => deps.handle(IpcChannel.TreeGet, null);

      const workspace = useWorkspaceStore(api);
      workspace.apply({
        workspace: session.workspace!,
        root: temporary.path,
        problems: [],
        readOnly: false,
        revision: session.revision!,
      });
      const initialTree = await api.treeGet();
      if (initialTree.source !== "local" || initialTree.kind !== "root") throw new Error("The host must return a local workspace root tree.");
      workspace.tree = initialTree;
      const groupNode = initialTree.children.find((node) => node.kind === "group");
      if (!groupNode || groupNode.kind !== "group") throw new Error("The persisted project workspace must contain its target group.");

      const actualTreeGet = api.treeGet.bind(api);
      let rejectFirstRefresh = true;
      api.treeGet = async () => {
        if (rejectFirstRefresh) {
          rejectFirstRefresh = false;
          throw new Error("transient tree refresh failure");
        }
        return actualTreeGet();
      };
      const importW = useImportWizardStore(api, workspace);
      const plugins = createPluginsStore({ api });
      await plugins.init();
      const { i18n } = createI18nInstance();
      const reportedErrors: unknown[] = [];
      const wrapper = mount(ImportWizard, {
        props: {
          mode: "project",
          importW,
          plugins,
          reportError: (error: unknown) => { reportedErrors.push(error); },
          groups: [{ locator: groupNode.locator, label: groupNode.label }],
          defaultGroupLocator: groupNode.locator,
        },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      const content = JSON.stringify({ openapi: "3.0.3", info: { title: "Committed refresh candidate", version: "1.0.0" }, paths: {} });
      await pickFile(wrapper, "refresh.openapi.json", content);
      await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
      await flushPromises();
      const originalApply = importW.apply.bind(importW);
      let applyRequest: Promise<ImportApplyResult> | undefined;
      importW.apply = (target) => (applyRequest = originalApply(target));
      expect(importW.plan, JSON.stringify({ previewDiagnostics: importW.preview?.diagnostics, reportedErrors })).not.toBeNull();
      expect(wrapper.find('[data-testid="import-apply"]').attributes("disabled")).toBeUndefined();
      await wrapper.find('[data-testid="import-apply"]').trigger("click");
      if (!applyRequest) throw new Error("The wizard must start the real import apply.");
      await applyRequest;
      await flushPromises();

      expect(importW.applyResult?.committed).toBe(true);
      expect(importW.refreshError).toContain("transient tree refresh failure");
      expect(wrapper.find('[data-testid="import-done"]').text()).toContain("导入完成");
      expect(wrapper.find('[data-testid="import-refresh-error"]').text()).toContain("已提交，但工作区树刷新失败；请仅重试刷新，不要重复应用。");
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      const committedRevision = session.revision;
      const committedProjectCount = session.workspace!.groups.reduce((count, group) => count + group.projects.length, 0);
      expect(committedProjectCount).toBe(initialProjectCount + 1);
      const target = { mode: "project" as const, target: groupNode.locator, name: "Committed refresh candidate" };
      await expect(importW.apply(target)).rejects.toThrow(/已提交/);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);

      await wrapper.find('[data-testid="import-refresh-only"]').trigger("click");
      await flushPromises();
      expect(importW.refreshError).toBe("");
      expect(session.revision).toBe(committedRevision);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      const refreshedGroup = workspace.tree!.children.find((node) => node.kind === "group" && node.id === groupNode.id);
      expect(refreshedGroup?.children?.some((node) => node.kind === "project" && node.label === "Committed refresh candidate")).toBe(true);
      const refreshedProjectCount = workspace.tree!.children.reduce((count, node) => count + (node.kind === "group"
        ? (node.children ?? []).filter((child) => child.kind === "project").length
        : 0), 0);
      expect(refreshedProjectCount).toBe(committedProjectCount);
    } finally {
      await temporary.dispose();
    }
  });

  it("displays plan diagnostics and disables Apply for structural errors", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const tree = await api.treeGet();
    if (tree.source !== "local" || tree.kind !== "root") throw new Error("The memory fixture must return a local workspace root tree.");
    const group = tree.children.find((node) => node.kind === "group");
    if (!group || group.kind !== "group") throw new Error("The memory fixture must contain its target group.");
    const originalPlan = api.importPlan.bind(api);
    api.importPlan = async (input) => {
      const plan = await originalPlan(input);
      return {
        ...plan,
        diagnostics: [...plan.diagnostics, {
          severity: "error",
          code: "ASSET_REFERENCE_MISSING",
          path: "contract.request.body.schema.modelId",
          message: "引用的目标资产不存在。",
          lossy: false,
        }],
      };
    };
    let applyCalls = 0;
    api.importApply = async () => {
      applyCalls += 1;
      return { committed: true, summary: { added: 1, overwritten: 0, skipped: 0 } };
    };
    const { wrapper } = await mountWizard({
      mode: "project",
      groups: [{ locator: group.locator, label: group.label }],
      defaultGroupLocator: group.locator,
    }, api);
    await pickFile(wrapper, "valid.openapi.json", "openapi: 3.0.0");
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();

    const diagnostics = wrapper.findAll('[data-testid="import-warnings"]').map((alert) => alert.text()).join("\n");
    expect(diagnostics).toContain("ASSET_REFERENCE_MISSING");
    expect(diagnostics).toContain("contract.request.body.schema.modelId");
    expect(diagnostics).toContain("引用的目标资产不存在。");
    expect(wrapper.find('[data-testid="import-apply"]').attributes("disabled")).toBeDefined();
    expect(applyCalls).toBe(0);
  });

  it("project 模式无可用分组时导入按钮禁用（防无落点提交）", async () => {
    const { wrapper } = await mountWizard({ mode: "project", groups: [], defaultGroupId: null });
    await pickFile(wrapper, "sample.yaml", "x");
    expect(wrapper.find('[data-testid="import-apply"]').attributes("disabled")).toBeDefined();
  });

  it("module 模式：无落点选择，仅模块名（预填 title），并入目标项目", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const seeded = await api.treeGet();
    const projectNode = seeded.children!.flatMap((group) => group.children ?? []).find((node) => node.kind === "project");
    if (!projectNode || projectNode.kind !== "project") throw new Error("fixture must contain the seeded project");
    const pId = projectNode.id;
    const importedProject = ContractProjectSchema.parse({
      id: "c2e8a7f1-3c07-42ea-85a4-15ed01d7a201", name: "导入示例项目", globals: {},
      environments: [
        { id: "env-production", name: "production", variables: {}, baseUrls: { "2e8a7f71-3c07-42ea-85a4-15ed01d7a201": "https://production.example.test" } },
        { id: "env-staging", name: "staging", extends: "production", variables: {}, baseUrls: { "2e8a7f71-3c07-42ea-85a4-15ed01d7a201": "https://staging.example.test" } },
      ],
      collections: [{
        id: "2e8a7f71-3c07-42ea-85a4-15ed01d7a201", name: "来源集合", variables: {}, preOperations: [], postOperations: [], folders: [],
        apis: [ApiAssetSchema.parse({
          contract: {
            formatVersion: 1, id: "2e8a7f71-3c07-42ea-85a4-15ed01d7a202",
            metadata: { name: "来源接口", description: "", tags: [], version: "1.0.0", status: "draft" },
            request: { protocol: "http", method: "GET", baseUrl: "https://fallback.example.test", path: "/ping", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } },
            responses: [],
          }, cases: [], documentation: "",
        })],
      }],
    });
    const originalPreview = api.importPreview.bind(api);
    api.importPreview = async (input) => {
      const preview = await originalPreview(input);
      api.setImportPreviewCandidate(preview.token, importedProject);
      const collection = importedProject.collections[0]!;
      return { ...preview,
        summary: { ...preview.summary, collections: 1, apis: 1 },
        tree: [{ id: collection.id, name: collection.name, apis: collection.apis.map((asset) => ({ id: asset.contract.id, name: asset.contract.metadata.name, method: asset.contract.request.protocol === "websocket" ? "WS" : asset.contract.request.method, path: asset.contract.request.path })) }],
      };
    };
    const applied: ImportApplyInput[] = [];
    const originalApply = api.importApply.bind(api);
    api.importApply = async (input) => { applied.push(input); return originalApply(input); };
    const { wrapper, workspace, importW, errors } = await mountWizard({ mode: "module", targetProjectLocator: projectNode.locator }, api);
    expect(wrapper.props("targetProjectLocator")).toEqual(projectNode.locator);
    const originalStoreApply = importW.apply.bind(importW);
    let applyPromise: Promise<ImportApplyResult> | undefined;
    importW.apply = (input) => (applyPromise = originalStoreApply(input));
    await pickFile(wrapper, "sample.yaml", "openapi: 3.0.0");
    // module 模式不出现分组下拉
    expect(wrapper.find('[data-testid="import-group-select"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="import-source-environment-select"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="import-name-input"]').element as HTMLInputElement).value).toBe("导入示例项目");
    await wrapper.find('[data-testid="import-source-environment-select"] .ant-select-selector').trigger("mousedown");
    await flushPromises();
    const stagingOption = [...document.body.querySelectorAll(".ant-select-item-option")].find((option) => option.textContent?.trim() === "staging");
    if (!stagingOption) throw new Error("source environment selector must render staging");
    await new DOMWrapper(stagingOption).trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="import-source-environment-select"]').text()).toContain("staging");
    await wrapper.find('[data-testid="import-name-input"]').setValue("并入模块");
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="import-apply"]').attributes("disabled")).toBeUndefined();
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    expect(applyPromise).toBeDefined();
    await applyPromise;
    await flushPromises();
    expect(importW.applying).toBe(false);
    expect(errors.map((error) => error instanceof Error ? error.message : String(error))).toEqual([]);
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ planToken: expect.any(String), allowLossy: false });
    expect(api.importApplyCalls).toEqual([{ mode: "module", projectId: pId, name: "并入模块" }]);
    const targetProject = workspace.tree!.children!.flatMap((g) => g.children!).find((p) => p.label === "示例项目");
    expect(targetProject!.children!.map((c) => c.label)).toContain("并入模块");
    const importedCollection = targetProject!.children!.find((node) => node.label === "并入模块");
    if (!importedCollection || importedCollection.kind !== "collection") throw new Error("module import must create a collection");
    const importedContainer = await api.containerGet({ kind: "collection", locator: importedCollection.locator });
    if (importedContainer.kind !== "collection") throw new Error("fixture imported a collection");
    expect(importedContainer.operations.variables.baseUrl).toBe("https://staging.example.test");
  });

  it("取消：清空 preview 并向组合根发 close 事件", async () => {
    const { wrapper, importW, workspace } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] });
    let releaseText!: (content: string) => void;
    const text = new Promise<string>((resolve) => { releaseText = resolve; });
    const lateFile = new File([], "late.yaml");
    Object.defineProperty(lateFile, "text", { value: () => text });
    const fileInput = wrapper.find('[data-testid="import-file-input"]');
    Object.defineProperty(fileInput.element, "files", { configurable: true, value: [lateFile] });
    await fileInput.trigger("change");
    await workspace.open("/tmp/ws-switched-during-file-read");
    releaseText("openapi: 3.0.0");
    await flushPromises();
    expect(importW.preview).toBeNull();
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);

    await pickFile(wrapper, "sample.yaml", "x");
    expect(importW.preview).not.toBeNull();
    await wrapper.find('[data-testid="import-cancel"]').trigger("click");
    await flushPromises();
    expect(importW.preview).toBeNull();
    expect(wrapper.emitted("close")).toHaveLength(1);
    // 回到第一步：落点表单不再展示
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);
  });

  it("完成态点完成后关闭向导（close 事件 + 回到第一步）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const seeded = await api.treeGet();
    const gId = seeded.children![0]!.id;
    const { wrapper, importW } = await mountWizard({
      mode: "project",
      groups: [{ id: gId, label: "示例分组" }],
      defaultGroupId: gId,
    }, api);
    const originalStoreApply = importW.apply.bind(importW);
    let applyPromise: Promise<ImportApplyResult> | undefined;
    importW.apply = (input) => (applyPromise = originalStoreApply(input));
    await pickFile(wrapper, "sample.yaml", "x");
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    if (!applyPromise) throw new Error("The wizard must start the import apply");
    await applyPromise;
    await flushPromises();
    await wrapper.find('[data-testid="import-finish"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
  });

  it("apply 拒绝时经 reportError 上报且不进入完成态（可修改后重试）", async () => {
    const { wrapper, api, errors, importW } = await mountWizard({
      mode: "project",
      groups: [{ id: "g", label: "g" }],
      defaultGroupId: "g",
    });
    const originalStoreApply = importW.apply.bind(importW);
    let initialApply: Promise<ImportApplyResult> | undefined;
    api.importApply = async () => { throw new Error("落库失败（注入）"); };
    importW.apply = (input) => (initialApply = originalStoreApply(input));
    await pickFile(wrapper, "sample.yaml", "x");
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    if (!initialApply) throw new Error("The wizard must start the import apply");
    await expect(initialApply).rejects.toThrow("落库失败");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("落库失败");
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);

    await wrapper.find('[data-testid="import-prev"]').trigger("click");
    await pickFile(wrapper, "old-error.yaml", "x");
    let rejectLateApply!: (error: Error) => void;
    let notifyLateApplyStarted!: () => void;
    const lateApplyStarted = new Promise<void>((resolve) => { notifyLateApplyStarted = resolve; });
    const lateFailure = new Promise<ImportApplyResult>((_resolve, reject) => { rejectLateApply = reject; });
    api.importApply = async () => {
      notifyLateApplyStarted();
      return await lateFailure;
    };
    let oldApply: Promise<ImportApplyResult> | undefined;
    importW.apply = (input) => (oldApply = originalStoreApply(input));
    await wrapper.find('[data-testid="import-build-plan"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="import-apply"]').trigger("click");
    await lateApplyStarted;
    await wrapper.find('[data-testid="import-prev"]').trigger("click");
    await pickFile(wrapper, "replacement-error.yaml", "y");
    rejectLateApply(new Error("旧导入请求迟到失败"));
    if (!oldApply) throw new Error("The component must start the original import apply");
    await expect(oldApply).rejects.toThrow("旧导入请求迟到失败");
    await flushPromises();
    expect(importW.previewIsCurrent).toBe(true);
    expect(errors).toHaveLength(1);
    expect(wrapper.find('[data-testid="import-done"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(true);
  });

  it("无法识别的格式：留在第一步并展示错误（不推进向导）", async () => {
    const { wrapper, api } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] });
    api.importPreview = async () => { throw new Error("无法识别的导入格式"); };
    await pickFile(wrapper, "unknown.txt", "随便什么内容");
    expect(wrapper.find('[data-testid="import-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-error"]').text()).toContain("无法识别的导入格式");
    expect(wrapper.find('[data-testid="import-name-input"]').exists()).toBe(false);
  });

  // M7-B 任务 1（规格 §2 D5）：导入格式清单改走 IPC 动态枚举——清单来自 plugins:list
  // 出口的 importers（内置 registry + 插件贡献），向导内零硬编码格式名。
  it("第一步展示动态枚举的导入格式：内置 + 插件贡献各一（来自 plugins:list）", async () => {
    const { wrapper } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] });
    const formats = wrapper.findAll('[data-testid="import-format"]');
    const names = formats.map((f) => f.text());
    // 内置 registry 导入器
    expect(names).toContain("collection-v21");
    expect(names).toContain("openapi");
    // 插件贡献导入器（fixture：apicc-plugin-example 贡献）
    expect(names).toContain("example-csv");
  });

  it("plugins:list 拉取失败：格式清单空但不阻断文件选择链路", async () => {
    const api = createMemoryApi();
    api.pluginsList = async () => { throw new Error("清单不可用"); };
    const { wrapper } = await mountWizard({ mode: "project", groups: [{ id: "g", label: "g" }] }, api);
    expect(wrapper.findAll('[data-testid="import-format"]').length).toBe(0);
    expect(wrapper.find('[data-testid="import-file-button"]').exists()).toBe(true);
  });
});
