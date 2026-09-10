// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境（vitest 4 已移除 environmentMatchGlobs）。
//
// M3-B 任务 2：OnlineLoginDialog 组件测试——表单校验（url 形态/用户名密码必填）、提交调
// store（组件内零工厂调用：store 实例经 props 注入）、api 错误上屏、注册/登录双模式
// （a-tabs）、已登录态与退出登录。档案管理用例迁移至 ConnectionPanel.test.ts（轨三收口）。
// antd 适配沿用 components.test.ts 约定：a-modal 传送门渲染到 document.body → body 作用域
// 查询；a-tabs 页签触发钩子经 #tab slot 的 span。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createOnlineStore, STORAGE_KEY, type OnlineSession } from "../../../src/renderer/src/stores/online.js";
import { createTabsStore } from "../../../src/renderer/src/stores/tabs.js";
import OnlineLoginDialog from "../../../src/renderer/src/components/OnlineLoginDialog.vue";
import type { ApiccApi } from "../../../src/shared/types.js";

const SERVER_A = "http://127.0.0.1:8080";

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

function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

function expectBody(testid: string): DOMWrapper<Element> {
  const w = bodyFind(testid);
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Modal 传送门未渲染？）`);
  return w;
}

function bodyHas(testid: string): boolean {
  return bodyFind(testid) !== null;
}

/**
 * 页签内容可见性断言：antd Tabs 的非激活页签内容留在 DOM（仅隐藏，destroyInactiveTabPane
 * 默认 false），bodyHas 判「存在」会误报——此辅助只认位于激活页签内的元素
 * （元素不在页签内时视为可见，如对话框直挂区块）。
 */
function bodyActiveHas(testid: string): boolean {
  const el = bodyFind(testid);
  if (!el) return false;
  const pane = el.element.closest(".ant-tabs-tabpane");
  return !pane || pane.classList.contains("ant-tabs-tabpane-active");
}

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/**
 * 装配：memory api + 注入 store 实例（组合根约定的测试形态），对话框默认开启并预置一份档案。
 * 终审 Important 2：登出前草稿确认需要签表（受影响签聚合 + 逐工作区关签）——真实构造
 * tabs store（deps 全内存 stub，与 online store 同一实例）经 props 注入。
 */
async function mountDialog({ open = true, logins = 0 }: { open?: boolean; logins?: number } = {}) {
  const api = createMemoryApi();
  for (let i = 0; i < logins; i += 1) {
    await api.onlineLogin({ baseUrl: SERVER_A, username: "alice", password: "password8" });
  }
  const storage = memStorage();
  const online = createOnlineStore({ api, storage });
  online.addProfile(SERVER_A, "团队服务器");
  if (logins > 0) await online.resume(SERVER_A); // 替身已登录 → store 恢复登录态（裁定 A 链路）
  const tabs = createTabsStore({
    workspace: { open: async () => {}, opened: false, root: "", tree: null },
    tree: { select: async () => {} },
    online,
    storage: memStorage(),
  });
  online.dialogOpen = open;
  const { i18n } = createI18nInstance();
  const wrapper = mount(OnlineLoginDialog, {
    props: { online, apicc: api, tabs },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api: api as ApiccApi, online, tabs, storage };
}

describe("OnlineLoginDialog", () => {
  it("dialogOpen=false 不渲染；true 经传送门渲染（登录页签默认；档案区已收口至主页管理连接）", async () => {
    const { online } = await mountDialog({ open: false });
    // a-modal 不透传 data-testid（components.test.ts 既有备案），挂载判据用对话框内层 online-body
    expect(bodyHas("online-body")).toBe(false);
    online.dialogOpen = true;
    await flushPromises();
    // 模态标题在 a-modal 头部（不在 body 插槽内），登录页签在内层 body
    expect(document.body.textContent).toContain("在线模式");
    // 轨三收口：档案增删改不在对话框内（唯一入口 = 主页管理连接面板）
    expect(bodyHas("online-server-select")).toBe(false);
    expect(bodyHas("online-server-url")).toBe(false);
    expect(bodyHas("online-login-form")).toBe(true);
    expect(bodyActiveHas("online-register-form")).toBe(false); // 注册页签未激活（懒渲染且未触达）
  });

  it("登录校验：用户名/密码必填 → online-form-error 且登录未发起", async () => {
    let loginCalls = 0;
    const { api, online } = await mountDialog();
    api.onlineLogin = async () => {
      loginCalls += 1;
      throw new Error("不应发起登录");
    };
    await expectBody("online-login-submit").trigger("click");
    expect(expectBody("online-form-error").text()).toContain("用户名");
    await expectBody("online-username").setValue("alice");
    await expectBody("online-login-submit").trigger("click");
    expect(expectBody("online-form-error").text()).toContain("密码");
    expect(loginCalls).toBe(0);
    expect(online.loggedIn).toBe(false);
  });

  it("提交登录调 store：载荷携带档案 baseUrl，成功后登录态上屏（对话框切已登录区）", async () => {
    const sent: Array<{ baseUrl: string; username: string; password: string }> = [];
    const { api } = await mountDialog();
    const original = api.onlineLogin.bind(api);
    api.onlineLogin = async (input) => {
      sent.push(input);
      return original(input);
    };
    await expectBody("online-username").setValue("alice");
    await expectBody("online-password").setValue("password8");
    await expectBody("online-login-submit").trigger("click");
    await flushPromises();
    expect(sent).toEqual([{ baseUrl: SERVER_A, username: "alice", password: "password8" }]);
    expect(bodyHas("online-signed-in")).toBe(true);
    expect(expectBody("online-user").text()).toContain("示例用户");
    expect(expectBody("online-user").text()).toContain("团队服务器");
  });

  it("登录失败：api 错误上屏（online-error），登录态不建立", async () => {
    const { api, online } = await mountDialog();
    api.onlineLogin = async () => {
      throw new Error("用户名或密码错误");
    };
    await expectBody("online-username").setValue("alice");
    await expectBody("online-password").setValue("password8");
    await expectBody("online-login-submit").trigger("click");
    await flushPromises();
    expect(expectBody("online-error").text()).toContain("用户名或密码错误");
    expect(online.loggedIn).toBe(false);
    expect(bodyHas("online-signed-in")).toBe(false);
  });

  it("注册双模式：切注册页签 → 显示名称输入出现；成功 → 成功提示并回登录页签（不建立登录态）", async () => {
    const { online } = await mountDialog();
    await expectBody("online-tab-register").trigger("click");
    await flushPromises();
    expect(bodyActiveHas("online-register-form")).toBe(true);
    expect(bodyActiveHas("online-login-form")).toBe(false);
    await expectBody("online-reg-username").setValue("bob");
    await expectBody("online-reg-password").setValue("password8");
    await expectBody("online-display-name").setValue("Bob");
    await expectBody("online-register-submit").trigger("click");
    await flushPromises();
    expect(expectBody("online-register-ok").text()).toContain("注册成功");
    expect(online.loggedIn).toBe(false);
    // 回登录页签，注册填的用户名保留可直接登录
    expect(bodyActiveHas("online-login-form")).toBe(true);
    expect(bodyActiveHas("online-register-form")).toBe(false);
    expect((expectBody("online-username").element as HTMLInputElement).value).toBe("bob");
  });

  it("注册校验：密码至少 8 位、显示名称必填", async () => {
    const { online } = await mountDialog();
    await expectBody("online-tab-register").trigger("click");
    await flushPromises();
    await expectBody("online-reg-username").setValue("bob");
    await expectBody("online-reg-password").setValue("short");
    await expectBody("online-register-submit").trigger("click");
    expect(expectBody("online-form-error").text()).toContain("8");
    await expectBody("online-reg-password").setValue("password8");
    await expectBody("online-register-submit").trigger("click");
    expect(expectBody("online-form-error").text()).toContain("显示名称");
    expect(online.loggedIn).toBe(false);
  });

  it("注册开关关闭（auth/config false）→ 注册页签不渲染（独立部署口径）", async () => {
    const api = createMemoryApi();
    api.authConfig = async () => ({ allowRegistration: false });
    const storage = memStorage();
    const online = createOnlineStore({ api, storage });
    online.addProfile(SERVER_A, "团队服务器");
    online.dialogOpen = true;
    const { i18n } = createI18nInstance();
    const tabs = createTabsStore({
      workspace: { open: async () => {}, opened: false, root: "", tree: null },
      tree: { select: async () => {} },
      online,
      storage: memStorage(),
    });
    const wrapper = mount(OnlineLoginDialog, { props: { online, apicc: api, tabs }, global: { plugins: [i18n] } });
    await flushPromises();
    expect(bodyHas("online-tab-register")).toBe(false);
    expect(bodyHas("online-login-form")).toBe(true);
  });

  it("已登录态：退出登录按钮 → store.logout（档案保留），回到登录表单", async () => {
    const { online } = await mountDialog({ logins: 1 });
    expect(online.loggedIn).toBe(true);
    expect(bodyHas("online-signed-in")).toBe(true);
    await expectBody("online-logout").trigger("click");
    await flushPromises();
    expect(online.loggedIn).toBe(false);
    expect(online.profiles).toHaveLength(1); // 登出不清档案（裁定 C）
    expect(bodyHas("online-login-form")).toBe(true);
  });

  it("关闭按钮：置 dialogOpen=false 卸载对话框", async () => {
    const { online } = await mountDialog();
    await expectBody("online-close").trigger("click");
    await flushPromises();
    expect(online.dialogOpen).toBe(false);
    expect(bodyHas("online-body")).toBe(false);
  });
});

// —— 终审 Important 2：登出绕过签表同步——logout 一次清全部在线会话，指向在线工作区的
// 签的编辑缓冲草稿被静默丢弃。修复后：登出前聚合在线签草稿态（tabs.projectHasDrafts），
// 有草稿先确认（列出有草稿的签），确认后逐工作区 tabs.closeWorkspaceTabs（签表同步 +
// 逐签驱逐会话）再登出；无草稿直接登出（现状保持）。
describe("OnlineLoginDialog 登出前草稿确认（终审 Important 2）", () => {
  /** 脏缓冲槽：api 相对快照有未保存修改（判定先例同 topBar.test.ts / online editorDirty）。 */
  function dirtyBuffer(path: string): OnlineSession["buffers"][string] {
    return {
      path,
      kind: "api",
      api: { id: "a-1", name: "改过的接口" } as never,
      raw: "",
      problems: [],
      version: 2,
      snapshot: JSON.stringify({ id: "a-1", name: "原接口" }),
      loading: false,
    };
  }

  /** 装配：已登录 + 已驻留在线工作区 + 一个在线项目签（draft=true 时该签含脏缓冲）。 */
  async function mountWithOnlineTab(draft: boolean) {
    const ctx = await mountDialog({ logins: 1 });
    await ctx.online.refreshWorkspaces();
    await ctx.online.openWorkspace(ctx.online.workspaces[0]!);
    const wsId = ctx.online.activeWorkspace!.id;
    await ctx.tabs.openProjectTab(
      { kind: "online", workspaceId: wsId, name: ctx.online.workspaces[0]!.name },
      { id: "p-1", name: "项目甲" },
    );
    await flushPromises();
    if (draft) {
      ctx.online.sessions[wsId]!.buffers["p-1/collections/c/apis/a/api.yaml"] =
        dirtyBuffer("p-1/collections/c/apis/a/api.yaml");
    }
    return { ...ctx, wsId };
  }

  it("有草稿在线签：登出先弹确认并列出有草稿的签；取消 → 登出不发生、会话与签原样", async () => {
    const { online, tabs, wsId } = await mountWithOnlineTab(true);
    await expectBody("online-logout").trigger("click");
    await flushPromises();
    // 确认弹窗先行（TopBar 退出在线确认同形态）：登出未发生，列出有草稿的签（工作区 / 项目）
    expect(expectBody("online-logout-impact").exists()).toBe(true);
    expect(expectBody("online-logout-tab-0").text()).toContain("项目甲");
    expect(online.loggedIn).toBe(true);
    expect(tabs.tabs).toHaveLength(1);
    // 取消：弹窗关闭，登录态/驻留会话/签表原样
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    expect(online.loggedIn).toBe(true);
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0]!.workspaceRef).toEqual({ kind: "online", workspaceId: wsId, name: "示例在线空间" });
    expect(online.sessions[wsId]).toBeDefined();
    expect(bodyFind("online-logout-impact")).toBeNull();
  });

  it("确认登出：先逐工作区关签（签清空 + 缓冲驱逐）再登出（会话清空、登录态清除）", async () => {
    const { online, tabs, wsId } = await mountWithOnlineTab(true);
    await expectBody("online-logout").trigger("click");
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    // 登出完成：会话全表清空（渲染层），登录态清除
    expect(online.loggedIn).toBe(false);
    expect(online.sessions).toEqual({});
    expect(online.activeWorkspaceId).toBeNull();
    // 签表同步：指向在线工作区的签已随登出关闭，不再残留正常态死签
    expect(tabs.tabs).toHaveLength(0);
    expect(bodyFind("online-logout-impact")).toBeNull();
  });

  it("无草稿在线签：直接登出不弹确认（现状保持）", async () => {
    const { online, tabs } = await mountWithOnlineTab(false);
    await expectBody("online-logout").trigger("click");
    await flushPromises();
    expect(bodyHas("online-logout-impact")).toBe(false);
    expect(online.loggedIn).toBe(false);
    expect(tabs.tabs).toHaveLength(0); // 无草稿也关签：登出牵连全部在线工作区，签表同步
    expect(online.sessions).toEqual({});
  });
});
