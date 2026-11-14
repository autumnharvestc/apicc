// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境；a-modal 传送门渲染于
// document.body（见 components.test.ts 文件头说明），对话框内元素用 body 作用域查询；
// a-select 下拉展开在 jsdom 中不稳定，统一经组件实例 update:value 驱动（chooseSelect）。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
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

async function chooseAction(wrapper: VueWrapper, trigger: string, action: string) {
  await wrapper.get(`[data-testid="${trigger}"]`).trigger("click");
  await expectBody(action).trigger("click");
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
    attachTo: document.body,
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
    const menuTrigger = wrapper.get('[data-testid="env-create-menu"]');
    await menuTrigger.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(expectBody("env-new").element);
    expect(expectBody("env-derive").attributes("disabled")).toBeDefined();
    expect(expectBody("env-derive").text()).toContain("请先新建父环境");
    await expectBody("env-new").trigger("click");
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
    await chooseAction(wrapper, "env-create-menu", "env-new");
    await flushPromises();
    await expectBody("env-name-input").setValue("stale-root");
    workspace.root = `${root}-copy`;
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(creates).toBe(0);
  });

  it("已排队打开复制根时阻止基础 URL 写入，即使工作区根还未更新", async () => {
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
    const saveBaseUrls = vi.spyOn(api, "envBaseUrlsSave");
    api.envVarsSave = async (locator, variables) => {
      startSave();
      await gate;
      return saveVars(locator, variables);
    };
    let finishOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { finishOpen = resolve; });
    const wsOpen = api.wsOpen.bind(api);
    api.wsOpen = async (root) => {
      await openGate;
      return wsOpen(root);
    };
    const root = workspace.root;
    await wrapper.get('[data-testid="env-vars-save"]').trigger("click");
    await started;
    const opening = workspace.open(`${root}-copy`);
    try {
      expect(workspace.root).toBe(root);
      expect(workspace.hasPendingOpen()).toBe(true);
      finishSave();
      await vi.waitFor(() => expect(wrapper.get('[data-testid="env-save-error"]').text()).toContain("模块基础 URL 有待保存"));
      expect(saveBaseUrls).not.toHaveBeenCalled();
    } finally {
      finishSave();
      finishOpen();
      await opening;
    }
    await vi.waitFor(() => expect(wrapper.find('[data-testid="env-pane-globals-vars"]').exists()).toBe(true));
    expect(wrapper.find('[data-testid="env-global-vars-saved"]').exists()).toBe(false);
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
    await chooseAction(wrapper, "env-create-menu", "env-derive");
    await flushPromises();
    chooseSelect(wrapper, "env-parent-select", dev.id);
    await expectBody("env-name-input").setValue("sit");
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(captured).not.toBeNull();
    expect(captured!.extends).toBe("dev");
    expect(captured!.name).toBe("sit");
  });

  it("变量行编辑与保存：切换环境保留各自的内容", async () => {
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

  it("删除菜单绑定行目标，取消回焦，删除其他环境保留当前草稿", async () => {
    const { wrapper, envs, projectNode } = await mountEnvPanel();
    const dev = await envs.create({ locator: projectNode.locator, name: "dev" });
    const sit = await envs.create({ locator: projectNode.locator, name: "待删除环境的完整名称" });
    await chooseEnv(wrapper, dev.id);
    await flushPromises();
    await wrapper.get('[data-testid="env-var-add"]').trigger("click");
    await wrapper.get('[data-testid="env-var-key"]').setValue("keep");
    const more = wrapper.get(`[data-testid="env-more-${sit.id}"]`);
    await more.trigger("keydown", { key: "ArrowDown" });
    const remove = expectBody("env-delete");
    expect(document.activeElement).toBe(remove.element);
    await remove.trigger("click");
    expect(document.body.textContent).toContain(sit.name);
    await expectBody("dialog-cancel").trigger("click");
    expect(document.activeElement).toBe(more.element);
    expect(envs.selectedEnvId).toBe(dev.id);
    await chooseAction(wrapper, `env-more-${sit.id}`, "env-delete");
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
    expect(envs.envs.map((e) => e.name)).not.toContain(sit.name);
    expect(envs.selectedEnvId).toBe(dev.id);
    expect(wrapper.get<HTMLInputElement>('[data-testid="env-var-key"]').element.value).toBe("keep");
    await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get(`[data-testid="env-item-${dev.id}"]`).element));

    await chooseAction(wrapper, `env-more-${dev.id}`, "env-delete");
    await expectBody("dialog-confirm").trigger("click");
    await vi.waitFor(() => expect(envs.envs).toHaveLength(0));
    expect(envs.selectedEnvId).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get('[data-testid="env-tab-globals-vars"]').element));
  });

  it("只读工作区可浏览环境与全局配置，编辑和删除入口禁用", async () => {
    const { wrapper, workspace, envs, projectLocator } = await mountEnvPanel();
    const env = await envs.create({ locator: projectLocator, name: "dev" });
    workspace.readOnly = true;
    await chooseEnv(wrapper, env.id);
    expect(wrapper.get('[data-testid="env-vars-save"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="env-baseurl-input"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get(`[data-testid="env-more-${env.id}"]`).attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("只读");
    await wrapper.get('[data-testid="env-tab-globals-params"]').trigger("click");
    expect(wrapper.get('[data-testid="env-pane-globals-params"]').text()).toContain("请求头");
    expect(wrapper.get('[data-testid="env-create-menu"]').attributes("disabled")).toBeDefined();
  });

  it("空全局变量添加后聚焦名称，切换参数页保留草稿和参数启用状态", async () => {
    const { wrapper, api, projectLocator } = await mountEnvPanel();
    expect(wrapper.get('[data-testid="env-pane-globals-vars"]').text()).toContain("暂无全局变量");
    await wrapper.get('[data-testid="env-global-var-add"]').trigger("click");
    const name = wrapper.get<HTMLInputElement>('[data-testid="env-global-var-key"]');
    const value = wrapper.get<HTMLInputElement>('[data-testid="env-global-var-value"]');
    expect(document.activeElement).toBe(name.element);
    expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("无待保存更改");
    await name.setValue(" region ");
    await value.setValue("east");
    await wrapper.get('[data-testid="env-tab-globals-params"]').trigger("click");
    await wrapper.get('[data-testid="env-global-query-add"]').trigger("click");
    await wrapper.get('[data-testid="env-global-query-key"]').setValue(" q ");
    await wrapper.get('[data-testid="env-global-query-value"]').setValue(" search ");
    await wrapper.get('input[data-testid="env-global-query-enabled"]').setValue(false);
    await wrapper.get('[data-testid="env-global-params-save"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.get('[data-testid="env-global-params-saved"]').text()).toBe("已保存"));
    expect((await api.globalsGet(projectLocator)).query).toEqual([{ key: "q", value: " search ", enabled: false }]);

    await wrapper.get('[data-testid="env-tab-globals-vars"]').trigger("click");
    expect(wrapper.get<HTMLInputElement>('[data-testid="env-global-var-key"]').element.value).toBe(" region ");
    expect(wrapper.get<HTMLInputElement>('[data-testid="env-global-var-value"]').element.value).toBe("east");
    expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("未保存");
    await wrapper.get('[data-testid="env-global-vars-save"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.get('[data-testid="env-global-vars-saved"]').text()).toBe("已保存"));
    expect(await api.globalsGet(projectLocator)).toMatchObject({
      variables: { region: "east" },
      query: [{ key: "q", value: " search ", enabled: false }],
    });
  });

  it("基础 URL 写入失败后显示待保存步骤，重试成功并保留并行编辑", async () => {
    const { wrapper, api, envs, projectLocator } = await mountEnvPanel();
    const dev = await envs.create({ locator: projectLocator, name: "dev" });
    await envs.create({ locator: projectLocator, name: "sit" });
    await chooseEnv(wrapper, dev.id);
    await wrapper.get('[data-testid="env-var-add"]').trigger("click");
    await wrapper.get('[data-testid="env-var-key"]').setValue("region");
    await wrapper.get('[data-testid="env-var-value"]').setValue("east");
    const url = wrapper.get('[data-testid="env-baseurl-input"]');
    await url.setValue("https://example.test/east");
    const saveVars = vi.spyOn(api, "envVarsSave");
    const actualSaveUrls = api.envBaseUrlsSave.bind(api);
    const saveUrls = vi.spyOn(api, "envBaseUrlsSave").mockRejectedValueOnce(new Error("disk fault"));
    await wrapper.get('[data-testid="env-vars-save"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.get('[data-testid="env-save-error"]').text()).toContain("环境变量已保存，模块基础 URL 保存失败：disk fault"));
    expect(wrapper.find('[data-testid="env-vars-saved"]').exists()).toBe(false);

    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    saveUrls.mockImplementationOnce(async (...args) => {
      await gate;
      return actualSaveUrls(...args);
    });
    try {
      const save = wrapper.get('[data-testid="env-vars-save"]');
      await save.trigger("click");
      expect(save.attributes("disabled")).toBeDefined();
      await save.trigger("click");
      expect(saveUrls).toHaveBeenCalledTimes(2);
      await wrapper.get('[data-testid="env-var-value"]').setValue("west");
      await chooseEnv(wrapper, envs.envs.find((env) => env.name === "sit")!.id);
      expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("无待保存更改");
      finish();
      await vi.waitFor(() => expect(envs.envs.find((env) => env.id === dev.id)?.baseUrls).toMatchObject({
        [url.attributes("data-collection-id")!]: "https://example.test/east",
      }));
      expect(wrapper.find('[data-testid="env-vars-saved"]').exists()).toBe(false);
      await chooseEnv(wrapper, dev.id);
      expect(wrapper.get<HTMLInputElement>('[data-testid="env-var-value"]').element.value).toBe("west");
      expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("未保存");
      expect(saveVars).toHaveBeenCalledTimes(1);
      await wrapper.get('[data-testid="env-var-value"]').setValue("east");
      expect(wrapper.get('[data-testid="env-vars-saved"]').text()).toBe("已保存");
      await wrapper.get('[data-testid="env-baseurl-input"]').setValue("https://example.test/new");
      expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("未保存");
      await wrapper.get('[data-testid="env-baseurl-input"]').setValue("https://example.test/east");
      expect(wrapper.get('[data-testid="env-vars-saved"]').text()).toBe("已保存");
    } finally {
      finish();
    }
  });

  it("旧配置中的空白按写入规则比较，切模块重挂后保留草稿和进行中的写入", async () => {
    const { wrapper, api, workspace, envs, projectLocator } = await mountEnvPanel();
    const env = await envs.create({ locator: projectLocator, name: "preview" });
    const locator = { ...projectLocator, environmentId: env.id };
    const collectionId = wrapper.get('[data-testid="env-baseurl-input"]').attributes("data-collection-id")!;
    await api.envBaseUrlsSave(locator, { [collectionId]: " " });
    await api.envVarsSave(locator, { " region ": "east" });
    await envs.load(projectLocator);
    expect(wrapper.get('[data-testid="env-save-status"]').text()).toBe("无待保存更改");
    await wrapper.get('[data-testid="env-var-value"]').setValue("west");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const originalSave = api.envVarsSave.bind(api);
    const save = vi.spyOn(api, "envVarsSave").mockImplementationOnce(async (...args) => {
      await gate;
      return originalSave(...args);
    });
    await wrapper.get('[data-testid="env-vars-save"]').trigger("click");

    try {
      wrapper.unmount();
      const { i18n } = createI18nInstance();
      const returned = mount(EnvPanel, {
        props: { envs, workspace, projectLocator, reportError: () => {} },
        global: { plugins: [i18n] },
      });
      await flushPromises();
      expect(returned.get<HTMLInputElement>('[data-testid="env-var-value"]').element.value).toBe("west");
      expect(returned.get('[data-testid="env-save-status"]').text()).toBe("正在保存");
      const pending = returned.get('[data-testid="env-vars-save"]');
      expect(pending.attributes("disabled")).toBeDefined();
      await pending.trigger("click");
      expect(save).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(returned.get('[data-testid="env-vars-saved"]').text()).toBe("已保存"));
    } finally {
      finish();
    }
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
    await chooseAction(wrapper, "env-create-menu", "env-new");
    await flushPromises();
    await expectBody("env-name-input").setValue("x");
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
