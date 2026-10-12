// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；store 工厂每调用一次即新建
// 独立 Pinia 实例，这里按组合根约定一次性装配 editor/cases 后经 props 注入被测组件。
// 本文件补任务 5 待办：CasePanel 组件测试（挂载后添加用例、保存成功路径），
// 并钉住任务 8 新增的可选 reportError 通道（case-save 拒绝不再静默吞没）。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { Input as AInput } from "ant-design-vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import CasePanel from "../../../src/renderer/src/components/CasePanel.vue";

beforeAll(() => {
  // jsdom 未实现 matchMedia；antd 组件（响应式断点）挂载时需要。
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

/** 显式装配辅助（组合根约定的测试形态）：editor 加载接口后创建 cases store 注入组件。 */
async function mountCasePanel(props: Record<string, unknown> = {}, withDebug = false) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const group = workspace.tree!.children.find((node) => node.kind === "group" && node.children.some((child) =>
    child.kind === "project" && child.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api"))));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const project = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api")));
  if (!project || project.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const collection = project.children.find((node) => node.kind === "collection");
  if (!collection || collection.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
  const apiNode = collection.children.find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory collection is missing the seeded API");
  const editor = useEditorStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
  await editor.load(apiNode.locator);
  const cases = useCasesStore(api, editor);
  const debug = withDebug ? useDebugStore(api, editor, () => ({ root: workspace.root, readOnly: workspace.readOnly })) : undefined;
  const { i18n } = createI18nInstance();
  const wrapper = mount(CasePanel, {
    props: { editor, cases, ...(debug ? { debug } : {}), ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, editor, cases, debug, workspace };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CasePanel", () => {
  it("只读模式禁用本地写控件并拒绝直接输入事件，同时保留运行入口", async () => {
    const { wrapper, editor } = await mountCasePanel({ readOnly: true }, true);
    const initialName = editor.api!.cases[0]!.name;
    expect((wrapper.find('[data-testid="case-add"]').element as HTMLButtonElement).disabled).toBe(true);
    expect((wrapper.find('[data-testid="case-name"]').element as HTMLInputElement).disabled).toBe(true);
    const nameInput = wrapper.findAllComponents(AInput).find((item) => item.attributes("data-testid") === "case-name");
    if (!nameInput) throw new Error("case name input component missing");
    await nameInput.vm.$emit("update:value", "只读改名");
    expect(editor.api!.cases[0]!.name).toBe(initialName);
    expect((wrapper.find(`[data-testid="case-run-${editor.api!.cases[0]!.id}"]`).element as HTMLButtonElement).disabled).toBe(false);
  });

  it("未加载接口时渲染空态", async () => {
    const api = createMemoryApi();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const cases = useCasesStore(api, editor);
    const { i18n } = createI18nInstance();
    const wrapper = mount(CasePanel, { props: { editor, cases }, global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="case-add"]').exists()).toBe(false);
  });

  it("添加用例：列表新增一行且新用例即选中（任务 5 待办补课）", async () => {
    const { wrapper, editor, cases } = await mountCasePanel();
    expect(wrapper.findAll('[data-testid="case-row"]')).toHaveLength(1);
    await wrapper.find('[data-testid="case-add"]').trigger("click");
    expect(wrapper.findAll('[data-testid="case-row"]')).toHaveLength(2);
    expect(editor.api!.cases).toHaveLength(2);
    expect(cases.selectedCaseId).toBe(editor.api!.cases[1]!.id);
  });

  it("保存成功路径：改名后 case-save 委托 editor.save 持久化并复位 dirty（任务 5 待办补课）", async () => {
    const { wrapper, editor } = await mountCasePanel();
    await wrapper.find('[data-testid="case-add"]').trigger("click");
    await wrapper.findAll('[data-testid="case-name"]')[1]!.setValue("登录用例");
    expect(editor.dirty).toBe(true);
    const save = editor.save.bind(editor);
    let savePromise: ReturnType<typeof save> | null = null;
    editor.save = () => (savePromise = save());
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    expect(savePromise).not.toBeNull();
    await savePromise;
    await flushPromises();
    expect(editor.dirty).toBe(false);
    expect(editor.api!.cases[1]!.name).toBe("登录用例");
  });

  it("保存链路拒绝时经 reportError 上报（任务 8：case-save 补错误通道）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountCasePanel({ reportError: (e: unknown) => { errors.push(e); } });
    api.apiSave = async () => { throw new Error("保存失败（测试注入）"); };
    await wrapper.find('[data-testid="case-save"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("保存失败（测试注入）");
  });

  it("captures root before the case-run save await and refuses to send after root changes", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountCasePanel({}, true);
    if (!debug) throw new Error("Expected debug store in this case-run fixture");
    editor.api!.documentation = "dirty before run";
    const saveStarted = deferred<void>();
    const saveGate = deferred<void>();
    const originalSave = api.apiSave.bind(api);
    api.apiSave = async (locator, asset) => {
      saveStarted.resolve();
      await saveGate.promise;
      return originalSave(locator, asset);
    };
    let sends = 0;
    api.debugSend = async () => {
      sends += 1;
      throw new Error("debug send reached after root switch");
    };
    const caseId = editor.api!.cases[0]!.id;
    await wrapper.get(`[data-testid="case-run-${caseId}"]`).trigger("click");
    await saveStarted.promise;
    expect(debug.sending).toBe(true); // case-run owns the whole save+send operation, not a pre-save detached from identity
    workspace.root = `${workspace.root}-copied`;
    saveGate.resolve();
    await vi.waitFor(() => expect(debug.sending).toBe(false));
    expect(sends).toBe(0);
  });
});
