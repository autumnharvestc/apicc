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

/** a-select 交互适配：经组件实例发 update:value（v-model 通道），见文件头说明。 */
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
  const projectNode = workspace.tree!.children![0]!.children![0]!;
  const envs = useEnvsStore(api);
  const { i18n } = createI18nInstance();
  const wrapper = mount(EnvPanel, {
    props: { envs, projectId: projectNode.id, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, envs, projectNode };
}

describe("EnvPanel", () => {
  it("无 projectId 时渲染空态", async () => {
    const { wrapper } = await mountEnvPanel({ projectId: null });
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="env-select"]').exists()).toBe(false);
  });

  it("挂载即按 projectId 加载项目环境列表", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const projectNode = workspace.tree!.children![0]!.children![0]!;
    const created = await api.envCreate({ projectId: projectNode.id, name: "dev" });
    const envs = useEnvsStore(api);
    const { i18n } = createI18nInstance();
    const wrapper = mount(EnvPanel, {
      props: { envs, projectId: projectNode.id, reportError: () => {} },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="env-select"]').exists()).toBe(true);
    // a-select 收起态不渲染 option 文本，列表内容以 store 状态断言
    expect(envs.envs).toEqual([{ id: created.id, name: "dev", variables: {} }]);
  });

  it("选中已存环境后变量表水合显示其已存变量（而非空表）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const workspace = useWorkspaceStore(api);
    await workspace.open("/tmp/ws");
    const projectNode = workspace.tree!.children![0]!.children![0]!;
    const created = await api.envCreate({ projectId: projectNode.id, name: "dev" });
    await api.envVarsSave(created.id, { baseUrl: "http://d", token: "t" });
    const envs = useEnvsStore(api);
    const { i18n } = createI18nInstance();
    const wrapper = mount(EnvPanel, {
      props: { envs, projectId: projectNode.id, reportError: () => {} },
      global: { plugins: [i18n] },
    });
    await flushPromises();
    chooseSelect(wrapper, "env-select", created.id);
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
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    expect(envs.envs.map((e) => e.name)).toContain("sit");
    expect(envs.selectedEnvId).toBe(envs.envs.find((e) => e.name === "sit")!.id);
  });

  it("从现有环境派生：选择父环境后 extends 透传父环境名", async () => {
    const { wrapper, api, envs, projectNode } = await mountEnvPanel();
    const dev = await envs.create({ projectId: projectNode.id, name: "dev" });
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
    const dev = await envs.create({ projectId: projectNode.id, name: "dev" });
    await envs.create({ projectId: projectNode.id, name: "sit" });
    await flushPromises();
    chooseSelect(wrapper, "env-select", dev.id);
    // a-select 的 value 通道更新后需一帧渲染，动作钮的 disabled 才解除
    await flushPromises();
    await wrapper.find('[data-testid="env-var-add"]').trigger("click");
    await flushPromises();
    await wrapper.findAll('[data-testid="env-var-key"]')[0]!.setValue("baseUrl");
    await wrapper.findAll('[data-testid="env-var-value"]')[0]!.setValue("http://s");
    let received: { envId: string; variables: Record<string, string> } | null = null;
    const original = api.envVarsSave.bind(api);
    api.envVarsSave = async (envId: string, variables: Record<string, string>) => {
      await original(envId, variables);
      received = { envId, variables };
    };
    await wrapper.find('[data-testid="env-vars-save"]').trigger("click");
    await flushPromises();
    expect(received).toEqual({ envId: dev.id, variables: { baseUrl: "http://s" } });
    expect(wrapper.find('[data-testid="env-vars-saved"]').exists()).toBe(true);
    // 切换到另一环境（无已存变量）：行缓冲清空
    const sit = envs.envs.find((e) => e.name === "sit")!;
    chooseSelect(wrapper, "env-select", sit.id);
    await flushPromises();
    expect(wrapper.findAll('[data-testid="env-var-key"]').length).toBe(0);
    // 再切回 dev：缓冲水合为已存值而非空（覆盖式保存不再静默丢数据）
    chooseSelect(wrapper, "env-select", dev.id);
    await flushPromises();
    const keys = wrapper.findAll('[data-testid="env-var-key"]');
    expect(keys).toHaveLength(1);
    expect((keys[0]!.element as HTMLInputElement).value).toBe("baseUrl");
    expect((wrapper.findAll('[data-testid="env-var-value"]')[0]!.element as HTMLInputElement).value).toBe("http://s");
  });

  it("删除选中环境：确认对话框放行后移除", async () => {
    const { wrapper, envs, projectNode } = await mountEnvPanel();
    const dev = await envs.create({ projectId: projectNode.id, name: "dev" });
    chooseSelect(wrapper, "env-select", dev.id);
    await flushPromises();
    await wrapper.find('[data-testid="env-delete"]').trigger("click");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(envs.envs.map((e) => e.name)).not.toContain("dev");
    expect(envs.selectedEnvId).toBeNull();
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
