// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；a-modal 传送门渲染于
// document.body（见 components.test.ts 文件头说明），对话框内元素用 body 作用域查询；
// a-select 下拉展开在 jsdom 中不稳定，统一经组件实例 update:value 驱动（chooseSelect）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEnvsStore } from "../../../src/renderer/src/stores/envs.js";
import type { EnvCreateInput } from "../../../src/shared/types.js";
import type { LocalProjectTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import EnvPanel from "../../../src/renderer/src/components/EnvPanel.vue";

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
  // 固定语言为 zh-CN，使文案断言与语言文件一致。
  localStorage.setItem("apicc.locale", "zh-CN");
});

enableAutoUnmount(afterEach);

function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

function expectBody(testid: string): DOMWrapper<Element> {
  const w = bodyFind(testid);
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Modal 传送门未渲染？）`);
  return w;
}

/** 环境选择适配（M9-B 重做后为左侧清单条目）：点击 env-item 切换选中环境。 */
async function chooseEnv(wrapper: VueWrapper, envId: string): Promise<void> {
  await wrapper.find(`[data-testid="env-item-${envId}"]`).trigger("click");
}

function findSeedProject(workspace: ReturnType<typeof useWorkspaceStore>): LocalProjectTreeNodeDTO {
  const candidate = workspace.tree?.children
    .flatMap((group) => group.kind === "group" ? group.children : [])
    .find((node) => node.kind === "project");
  if (candidate?.kind !== "project") throw new Error("Memory fixture did not create a project");
  return candidate;
}

/** a-select 交互适配（派生对话框父环境选择仍在用）：经组件实例发 update:value。 */
function chooseSelect(wrapper: VueWrapper, testid: string, value: string): void {
  const select = wrapper
    .findAllComponents({ name: "ASelect" })
    .find((c) => c.attributes("data-testid") === testid);
  if (!select) throw new Error(`ASelect 未找到: ${testid}`);
  select.vm.$emit("update:value", value);
}

/** 显式装配辅助（组合根约定的测试形态）：store 一次性创建，经 props 注入被测组件。 */
async function mountEnvPanel(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const projectNode = findSeedProject(workspace);
  const envs = useEnvsStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
  await envs.load(projectNode.locator);
  const { i18n } = createI18nInstance();
  const wrapper = mount(EnvPanel, {
    props: { envs, workspace, projectLocator: projectNode.locator, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, envs, projectNode, projectLocator: projectNode.locator };
}

describe("EnvPanel", () => {
  it("无 project locator 时渲染空态", async () => {
    const { wrapper } = await mountEnvPanel({ projectLocator: null });
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="env-tab-globals-vars"]').exists()).toBe(false);
  });

  it("挂载即按完整项目 locator 加载项目环境列表", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const projectNode = findSeedProject(workspace);
    const created = await api.envCreate({ locator: projectNode.locator, name: "dev" });
    const envs = useEnvsStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
    const { i18n } = createI18nInstance();
    const wrapper = mount(EnvPanel, {
      props: { envs, workspace, projectLocator: projectNode.locator, reportError: () => {} },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="env-tab-globals-vars"]').exists()).toBe(true);
    // a-select 收起态不渲染 option 文本，列表内容以 store 状态断言
    expect(envs.envs).toEqual([expect.objectContaining({ id: created.id, name: "dev", variables: {}, baseUrls: {}, locator: { ...projectNode.locator, environmentId: created.id } })]);
  });

  it("选中已存环境后变量表水合显示其已存变量（而非空表）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const projectNode = findSeedProject(workspace);
    const created = await api.envCreate({ locator: projectNode.locator, name: "dev" });
    const envLocator = { ...projectNode.locator, environmentId: created.id };
    await api.envVarsSave(envLocator, { baseUrl: "http://d", token: "t" });
    const envs = useEnvsStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
    const { i18n } = createI18nInstance();
    const wrapper = mount(EnvPanel, {
      props: { envs, workspace, projectLocator: projectNode.locator, reportError: () => {} },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    await chooseEnv(wrapper, created.id);
    await flushPromises();
    const keys = wrapper.findAll('[data-testid="env-var-key"]');
    const values = wrapper.findAll('[data-testid="env-var-value"]');
    expect(keys).toHaveLength(2);
    expect((keys[0]!.element as HTMLInputElement).value).toBe("baseUrl");
    expect((values[0]!.element as HTMLInputElement).value).toBe("http://d");
    expect((keys[1]!.element as HTMLInputElement).value).toBe("token");
    expect((values[1]!.element as HTMLInputElement).value).toBe("t");
  });

  it("新建环境：modal 输入名称确认后创建并选中", async () => {
    const { wrapper, envs } = await mountEnvPanel();
    await wrapper.find('[data-testid="env-new"]').trigger("click");
    await flushPromises();
    await expectBody("env-name-input").setValue("sit");
    const originalCreate = envs.create.bind(envs);
    let createTask: ReturnType<typeof originalCreate> | null = null;
    envs.create = (input) => {
      createTask = originalCreate(input);
      return createTask;
    };
    try {
      await expectBody("env-modal-confirm").trigger("click");
      if (!createTask) throw new Error("Environment confirmation did not invoke the real envs.create action");
      await createTask;
    } finally {
      envs.create = originalCreate;
    }
    expect(envs.envs.map((e) => e.name)).toContain("sit");
    expect(envs.selectedEnvId).toBe(envs.envs.find((e) => e.name === "sit")!.id);
  });

  it("新建确认仍绑定打开对话框时的root；复制根切换后不在新根创建旧目标", async () => {
    const { wrapper, api, workspace } = await mountEnvPanel();
    const root = workspace.root;
    let creates = 0;
    const create = api.envCreate.bind(api);
    api.envCreate = async (input) => { creates++; return create(input); };
    await wrapper.find('[data-testid="env-new"]').trigger("click");
    await flushPromises();
    await expectBody("env-name-input").setValue("stale-root");
    workspace.root = `${root}-copy`;
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(creates).toBe(0);
  });

  it("变量保存的第二次baseUrl写入在第一次await后root变化时取消", async () => {
    const { wrapper, api, workspace, envs, projectNode } = await mountEnvPanel();
    const created = await envs.create({ locator: projectNode.locator, name: "deferred" });
    await flushPromises();
    await chooseEnv(wrapper, created.id);
    await flushPromises();
    let startSave!: () => void;
    let finishSave!: () => void;
    const started = new Promise<void>((resolve) => { startSave = resolve; });
    const gate = new Promise<void>((resolve) => { finishSave = resolve; });
    const saveVars = api.envVarsSave.bind(api);
    let baseUrlWrites = 0;
    const saveBaseUrls = api.envBaseUrlsSave.bind(api);
    api.envVarsSave = async (locator, variables) => {
      startSave();
      await gate;
      return saveVars(locator, variables);
    };
    api.envBaseUrlsSave = async (locator, baseUrls) => {
      baseUrlWrites++;
      return saveBaseUrls(locator, baseUrls);
    };
    await wrapper.find('[data-testid="env-vars-save"]').trigger("click");
    await started;
    workspace.root = `${workspace.root}-copy`;
    finishSave();
    await flushPromises();
    expect(baseUrlWrites).toBe(0);
  });

  it("从现有环境派生：选择父环境后 extends 透传父环境名", async () => {
    const { wrapper, api, envs, projectNode } = await mountEnvPanel();
    const dev = await envs.create({ locator: projectNode.locator, name: "dev" });
    await flushPromises();
    let captured: EnvCreateInput | null = null;
    const original = api.envCreate.bind(api);
    api.envCreate = async (input: EnvCreateInput) => {
      captured = input;
      return original(input);
    };
    await wrapper.find('[data-testid="env-derive"]').trigger("click");
    await flushPromises();
    chooseSelect(wrapper, "env-parent-select", dev.id);
    await expectBody("env-name-input").setValue("sit");
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(captured).not.toBeNull();
    expect(captured!.extends).toBe("dev");
    expect(captured!.name).toBe("sit");
  });

  it("变量行编辑与保存：行缓冲经 saveVars 落盘，切换环境即重置", async () => {
    const { wrapper, api, envs, projectNode } = await mountEnvPanel();
    const dev = await envs.create({ locator: projectNode.locator, name: "dev" });
    const devItem = envs.envs.find((item) => item.id === dev.id)!;
    await envs.create({ locator: projectNode.locator, name: "sit" });
    await flushPromises();
    await chooseEnv(wrapper, dev.id);
    await flushPromises();
    await wrapper.find('[data-testid="env-var-add"]').trigger("click");
    await flushPromises();
    await wrapper.findAll('[data-testid="env-var-key"]')[0]!.setValue("baseUrl");
    await wrapper.findAll('[data-testid="env-var-value"]')[0]!.setValue("http://s");
    const received: { current: { locator: Parameters<typeof api.envVarsSave>[0]; variables: Record<string, string> } | null } = { current: null };
    const original = api.envVarsSave.bind(api);
    api.envVarsSave = async (locator, variables) => {
      const saved = await original(locator, variables);
      received.current = { locator, variables };
      return saved;
    };
    const originalStoreSaveVars = envs.saveVars.bind(envs);
    const originalStoreSaveBaseUrls = envs.saveBaseUrls.bind(envs);
    let storeSaveVarsTask: ReturnType<typeof originalStoreSaveVars> | null = null;
    let storeSaveBaseUrlsTask: ReturnType<typeof originalStoreSaveBaseUrls> | null = null;
    envs.saveVars = (...args) => {
      storeSaveVarsTask = originalStoreSaveVars(...args);
      return storeSaveVarsTask;
    };
    envs.saveBaseUrls = (...args) => {
      storeSaveBaseUrlsTask = originalStoreSaveBaseUrls(...args);
      return storeSaveBaseUrlsTask;
    };
    try {
      await wrapper.find('[data-testid="env-vars-save"]').trigger("click");
      if (!storeSaveVarsTask) throw new Error("Environment save did not invoke the real envs.saveVars action");
      await storeSaveVarsTask;
      if (!storeSaveBaseUrlsTask) throw new Error("Environment save did not invoke the real envs.saveBaseUrls action");
      await storeSaveBaseUrlsTask;
    } finally {
      envs.saveVars = originalStoreSaveVars;
      envs.saveBaseUrls = originalStoreSaveBaseUrls;
      api.envVarsSave = original;
    }
    await flushPromises();
    expect(received.current).toEqual({ locator: devItem.locator, variables: { baseUrl: "http://s" } });
    expect(wrapper.find('[data-testid="env-vars-saved"]').exists()).toBe(true);
    // 切换到另一环境（无已存变量）：行缓冲清空
    const sit = envs.envs.find((e) => e.name === "sit")!;
    await chooseEnv(wrapper, sit.id);
    await flushPromises();
    expect(wrapper.findAll('[data-testid="env-var-key"]').length).toBe(0);
    // 再切回 dev：缓冲水合为已存值而非空（覆盖式保存不再静默丢数据）
    await chooseEnv(wrapper, dev.id);
    await flushPromises();
    const keys = wrapper.findAll('[data-testid="env-var-key"]');
    expect(keys).toHaveLength(1);
    expect((keys[0]!.element as HTMLInputElement).value).toBe("baseUrl");
    expect((wrapper.findAll('[data-testid="env-var-value"]')[0]!.element as HTMLInputElement).value).toBe("http://s");
  });

  it("删除选中环境：确认对话框放行后移除", async () => {
    const { wrapper, envs, projectNode } = await mountEnvPanel();
    const dev = await envs.create({ locator: projectNode.locator, name: "dev" });
    await chooseEnv(wrapper, dev.id);
    await flushPromises();
    await wrapper.find('[data-testid="env-delete"]').trigger("click");
    const originalRemove = envs.remove.bind(envs);
    let removeTask: ReturnType<typeof originalRemove> | null = null;
    envs.remove = (...args) => {
      removeTask = originalRemove(...args);
      return removeTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!removeTask) throw new Error("Environment delete confirmation did not invoke the real envs.remove action");
      await removeTask;
    } finally {
      envs.remove = originalRemove;
    }
    expect(envs.envs.map((e) => e.name)).not.toContain("dev");
    expect(envs.selectedEnvId).toBeNull();
  });

  it("重挂水合（immediate watch）：挂载时选中态已在 store，首帧即水合已存变量", async () => {
    // 任务 4 遗留、任务 8 装配补课：视图切换重挂后 selectedEnvId 不经变化直接有值，
    // 不加 immediate 会等下次变化才水合，首次挂载变量表恒为空。
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const projectNode = findSeedProject(workspace);
    const created = await api.envCreate({ locator: projectNode.locator, name: "dev" });
    const envLocator = { ...projectNode.locator, environmentId: created.id };
    await api.envVarsSave(envLocator, { baseUrl: "http://d" });
    const envs = useEnvsStore(api, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
    await envs.load(projectNode.locator);
    envs.select(envLocator);
    const { i18n } = createI18nInstance();
    const wrapper = mount(EnvPanel, {
      props: { envs, workspace, projectLocator: projectNode.locator, reportError: () => {} },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    const keys = wrapper.findAll('[data-testid="env-var-key"]');
    expect(keys).toHaveLength(1);
    expect((keys[0]!.element as HTMLInputElement).value).toBe("baseUrl");
  });

  it("创建链路拒绝时经 reportError 上报（宽审查 I1）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountEnvPanel({ reportError: (e: unknown) => { errors.push(e); } });
    api.envCreate = async () => { throw new Error("boom"); };
    await wrapper.find('[data-testid="env-new"]').trigger("click");
    await flushPromises();
    await expectBody("env-name-input").setValue("x");
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
