// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境（vitest 4 已移除 environmentMatchGlobs）。
import { describe, expect, it, beforeAll } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import SideTree from "../../../src/renderer/src/components/SideTree.vue";
import RequestEditor from "../../../src/renderer/src/components/RequestEditor.vue";
import ResponseViewer from "../../../src/renderer/src/components/ResponseViewer.vue";
import EmptyState from "../../../src/renderer/src/components/EmptyState.vue";
import ConfirmDialog from "../../../src/renderer/src/components/ConfirmDialog.vue";
import TopBar from "../../../src/renderer/src/components/TopBar.vue";

beforeAll(() => {
  // jsdom 未实现 matchMedia；TopBar→ThemeLanguageToggle 挂载时解析主题偏好会调用它。
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
  // 固定语言为 zh-CN，使文案断言与语言文件一致（jsdom navigator.language 为 en-US）。
  localStorage.setItem("apicc.locale", "zh-CN");
});

/**
 * 显式装配辅助（组合根约定的测试形态）：
 * store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的状态副本——因此同一份
 * store 在这里一次性创建，经 props 注入被测组件（简报原 mountWith 未向组件传 store，
 * 与该装配约定冲突，以约定为准调整）。组件内部不重复调用工厂。
 */
async function mountWith(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const tree = useTreeStore(api, workspace);
  const editor = useEditorStore(api);
  const debug = useDebugStore(api);
  const { i18n } = createI18nInstance();
  const wrapper = mount(component, {
    props: { api, workspace, tree, editor, debug, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, tree, editor, debug };
}

/** 仅需 i18n 插件的挂载（组件只收普通 props，不消费 store）。 */
function mountWithI18n(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}): VueWrapper {
  const { i18n } = createI18nInstance();
  return mount(component, { props, global: { plugins: [i18n] } });
}

describe("SideTree", () => {
  it("渲染工作区树并支持选中接口", async () => {
    const { wrapper } = await mountWith(SideTree);
    // 分组/项目/集合默认折叠：接口初始不可见
    expect(wrapper.find('[data-testid="tree-api"]').exists()).toBe(false);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const apiNode = wrapper.find('[data-testid="tree-api"]');
    expect(apiNode.exists()).toBe(true);
    await apiNode.trigger("click");
    expect(wrapper.emitted("select")).toBeTruthy();
  });

  it("新建接口：集合动作钮经对话框输入后创建并选中", async () => {
    const { wrapper } = await mountWith(SideTree);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
    // 创建走 ConfirmDialog 复用的输入对话框
    const input = wrapper.find('[data-testid="dialog-input"]');
    expect(input.exists()).toBe(true);
    await input.setValue("新接口");
    await wrapper.find('[data-testid="dialog-confirm"]').trigger("click");
    await flushPromises();
    // select 事件必须携带 "api"（App 据此加载编辑器；主进程 nodeCreate 返回体无 kind，
    // 组件以发起请求的 kind 为准）
    expect(wrapper.emitted("select")![0]).toEqual(["api", expect.any(String)]);
    expect(wrapper.text()).toContain("新接口");
  });

  it("删除接口：确认对话框放行后节点消失", async () => {
    const { wrapper, workspace } = await mountWith(SideTree);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    // 以接口所在行（tree-api-row）为作用域，避免命中祖先节点的删除钮
    const row = wrapper.find('[data-testid="tree-api-row"]');
    const apiId = row.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    await row.find('[data-testid="node-delete"]').trigger("click");
    await wrapper.find('[data-testid="dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(JSON.stringify(workspace.tree)).not.toContain(apiId);
  });

  it("根层新建分组：空工作区也能从根创建顶层节点", async () => {
    const { wrapper, workspace } = await mountWith(SideTree);
    const before = workspace.tree!.children!.length;
    await wrapper.find('[data-testid="new-group"]').trigger("click");
    await wrapper.find('[data-testid="dialog-input"]').setValue("根层新分组");
    await wrapper.find('[data-testid="dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(workspace.tree!.children!.length).toBe(before + 1);
    expect(wrapper.text()).toContain("根层新分组");
  });

  it("工作区未打开时渲染空态", async () => {
    const { wrapper, workspace } = await mountWith(SideTree);
    workspace.opened = false;
    await flushPromises();
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
  });
});

describe("RequestEditor", () => {
  it("编辑 URL 触发 update 且显示发送按钮", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    // 未加载接口时是空态，无编辑输入
    expect(wrapper.find('[data-testid="editor-url"]').exists()).toBe(false);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await flushPromises();
    const url = wrapper.find('[data-testid="editor-url"]');
    await url.setValue("http://example.com/x");
    expect((url.element as HTMLInputElement).value).toBe("http://example.com/x");
    // v-model 直接写 editor.api 字段（Pinia 响应式），dirty 快照比对 getter 跟踪
    expect(editor.api!.url).toBe("http://example.com/x");
    expect(editor.dirty).toBe(true);
    expect(wrapper.find('[data-testid="send-btn"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-btn"]').exists()).toBe(true);
  });

  it("点击发送走默认 apicc.debugSend 并产生结果", async () => {
    const { wrapper, editor, debug, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await wrapper.find('[data-testid="send-btn"]').trigger("click");
    await flushPromises();
    expect(debug.result).not.toBeNull();
    expect(debug.sending).toBe(false);
    expect(debug.error).toBeNull();
  });

  it("认证 tab：选择类型生成对应 auth 字段", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await wrapper.find('[data-testid="tab-auth"]').trigger("click");
    await wrapper.find('[data-testid="auth-type"]').setValue("bearer");
    expect(editor.api!.auth).toMatchObject({ type: "bearer" });
    await wrapper.find('[data-testid="auth-token"]').setValue("t0");
    expect(editor.api!.auth!.token).toBe("t0");
  });

  it("请求体 tab：选择 form 类型后可添加行", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await wrapper.find('[data-testid="tab-body"]').trigger("click");
    await wrapper.find('[data-testid="body-kind"]').setValue("form");
    expect(editor.api!.body).toMatchObject({ kind: "form" });
    await wrapper.find('[data-testid="add-form-row"]').trigger("click");
    expect(editor.api!.body!.form).toHaveLength(1);
  });
});

describe("ResponseViewer", () => {
  const result = {
    run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
    outcome: {
      apiId: "a", apiName: "a", caseId: "t", caseName: "t", passed: true, durationMs: 5,
      assertions: [{ pass: false, message: "eq 失败" }],
    },
  };

  it("无结果时显示空态", () => {
    const wrapper = mountWithI18n(ResponseViewer, {});
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(true);
  });

  it("有结果时显示状态徽标与断言明细", async () => {
    const wrapper = mountWithI18n(ResponseViewer, {});
    await wrapper.setProps({ result });
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("eq 失败");
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
  });

  it("body/headers tab 显示占位「—」（DebugOutput 无响应体字段，不得臆造）", async () => {
    const wrapper = mountWithI18n(ResponseViewer, { result });
    expect(wrapper.find('[data-testid="response-body"]').text()).toBe("—");
    await wrapper.find('[data-testid="response-tab-headers"]').trigger("click");
    expect(wrapper.find('[data-testid="response-headers"]').text()).toBe("—");
  });

  it("error 属性非空时显示错误徽标", () => {
    const wrapper = mountWithI18n(ResponseViewer, { result, error: "网络不可达" });
    expect(wrapper.find('[data-testid="response-error"]').text()).toContain("网络不可达");
  });
});

describe("EmptyState", () => {
  it("渲染传入文本", () => {
    const wrapper = mountWithI18n(EmptyState, { text: "打开工作区后在此浏览接口" });
    expect(wrapper.find('[data-testid="empty-state"]').text()).toBe("打开工作区后在此浏览接口");
  });
});

describe("ConfirmDialog", () => {
  it("带输入框时确认回传输入值", async () => {
    const wrapper = mountWithI18n(ConfirmDialog, { open: true, title: "新建接口", inputPlaceholder: "名称" });
    await wrapper.find('[data-testid="dialog-input"]').setValue("abc");
    await wrapper.find('[data-testid="dialog-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual(["abc"]);
  });

  it("无输入框时确认回传 null，取消触发 cancel", async () => {
    const wrapper = mountWithI18n(ConfirmDialog, { open: true, title: "确认删除" });
    await wrapper.find('[data-testid="dialog-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual([null]);
    await wrapper.find('[data-testid="dialog-cancel"]').trigger("click");
    expect(wrapper.emitted("cancel")).toBeTruthy();
  });

  it("open=false 不渲染", () => {
    const wrapper = mountWithI18n(ConfirmDialog, { open: false, title: "x" });
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false);
  });
});

describe("TopBar", () => {
  it("打开工作区：经 wsPickDirectory+wsOpen 后显示工作区名", async () => {
    const { wrapper, workspace } = await mountWith(TopBar, {});
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    expect(workspace.opened).toBe(true);
    expect(wrapper.find('[data-testid="workspace-name"]').text()).toContain("内存工作区");
  });

  it("新建工作区先弹名称输入对话框，可取消", async () => {
    const { wrapper } = await mountWith(TopBar, {});
    await wrapper.find('[data-testid="new-workspace"]').trigger("click");
    expect(wrapper.find('[data-testid="dialog-input"]').exists()).toBe(true);
    await wrapper.find('[data-testid="dialog-cancel"]').trigger("click");
    expect(wrapper.find('[data-testid="dialog-input"]').exists()).toBe(false);
  });
});
