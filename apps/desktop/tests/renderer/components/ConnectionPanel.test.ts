// @vitest-environment jsdom
// ConnectionPanel 组件测试（轨三收口）：服务器档案增删改+登录/浏览动作的唯一管理入口。
// 从 OnlineLoginDialog.test.ts 迁入（档案管理自登录对话框收口至主页连接面板）。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createOnlineStore, STORAGE_KEY } from "../../../src/renderer/src/stores/online.js";
import ConnectionPanel from "../../../src/renderer/src/components/ConnectionPanel.vue";

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

/** 装配：memory api + 注入 store 实例（组合根约定的测试形态），预置一份档案。 */
async function mountPanel() {
  const api = createMemoryApi();
  const storage = memStorage();
  const online = createOnlineStore({ api, storage });
  online.addProfile(SERVER_A, "团队服务器");
  const { i18n } = createI18nInstance();
  const browsed: string[] = [];
  const wrapper = mount(ConnectionPanel, {
    props: { online, onBrowse: (baseUrl: string) => browsed.push(baseUrl) },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, online, storage, browsed, i18n };
}

describe("ConnectionPanel", () => {
  it("distinguishes account authentication from browsing for an already signed-in profile", async () => {
    const { wrapper, online, i18n } = await mountPanel();
    await online.login('alice', 'password8');
    for (const language of ['zh-CN', 'en'] as const) {
      i18n.global.locale.value = language; await flushPromises();
      const account = wrapper.get('[data-testid="connection-login"]');
      expect.soft(account.text()).toContain(language === 'zh-CN' ? '账户' : 'Account');
      expect.soft(account.text()).not.toBe(wrapper.get('[data-testid="connection-browse"]').text());
      await account.trigger('click'); expect(online.dialogOpen).toBe(true); online.dialogOpen = false;
      online.error = "Error invoking remote method 'online:me': Error: online-not-signed-in";
      await flushPromises();
      expect.soft(wrapper.get('[data-testid="connections-error"]').text()).toContain(language === 'zh-CN' ? '请先登录在线服务器' : 'Sign in to the online server first');
      online.error = 'unknown-server-error: original business detail'; await flushPromises();
      expect(wrapper.get('[data-testid="connections-error"]').text()).toContain('unknown-server-error: original business detail');
    }
  });
  it("连接列表：档案行（昵称+地址）渲染；未登录无状态标签", async () => {
    const { wrapper } = await mountPanel();
    const row = wrapper.find(`[data-testid="connection-${SERVER_A}"]`);
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("团队服务器");
    expect(row.text()).toContain(SERVER_A);
    expect(wrapper.find('[data-testid="connection-logged-in"]').exists()).toBe(false);
  });

  it("新增连接：url 形态校验（缺 http(s) → 行内错误不落 store）；合法则保存进列表并持久化", async () => {
    const { wrapper, online, storage } = await mountPanel();
    await wrapper.find('[data-testid="connections-add"]').trigger("click");
    await wrapper.find('[data-testid="connections-url"]').setValue("ftp://bad");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    expect(wrapper.find('[data-testid="connections-form-error"]').text()).toContain("http://");
    expect(online.profiles).toHaveLength(1); // 未新增
    await wrapper.find('[data-testid="connections-url"]').setValue("http://10.0.0.8:9000");
    await wrapper.find('[data-testid="connections-name"]').setValue("备用");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    expect(online.profiles.map((p) => p.baseUrl)).toEqual([SERVER_A, "http://10.0.0.8:9000"]);
    expect(online.activeBaseUrl).toBe("http://10.0.0.8:9000"); // 新档案即激活
    // 持久化落在注入的 storage（组件测试不写真实 localStorage）
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).servers).toHaveLength(2);
  });

  it("编辑连接：回填既有档案，保存改昵称（同地址语义）", async () => {
    const { wrapper, api, online } = await mountPanel();
    await online.login("alice", "password8");
    const signedInUser = online.user;
    api.onlineResume = async () => ({ outcome: "signed-out" });
    await wrapper.find('[data-testid="connection-edit"]').trigger("click");
    expect((wrapper.find('[data-testid="connections-url"]').element as HTMLInputElement).value).toBe(SERVER_A);
    await wrapper.find('[data-testid="connections-name"]').setValue("新昵称");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    await flushPromises();
    expect(online.profiles.map((p) => p.name)).toEqual(["新昵称"]);
    expect(online.profiles).toHaveLength(1); // 同地址改昵称，不新增
    expect(online.activeBaseUrl).toBe(SERVER_A);
    expect(online.loggedIn).toBe(true);
    expect(online.user).toEqual(signedInUser);
  });

  it("editing an address replaces the original profile instead of adding another connection", async () => {
    const { wrapper, api, online, storage } = await mountPanel();
    await online.login("alice", "password8");
    api.onlineResume = async () => ({ outcome: "signed-out" });
    await wrapper.find('[data-testid="connection-edit"]').trigger("click");
    await wrapper.find('[data-testid="connections-url"]').setValue("http://10.0.0.8:9000");
    await wrapper.find('[data-testid="connections-name"]').setValue("新地址");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    await flushPromises();
    expect(online.profiles).toEqual([{ baseUrl: "http://10.0.0.8:9000", name: "新地址" }]);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({ active: "http://10.0.0.8:9000", servers: [{ baseUrl: "http://10.0.0.8:9000", name: "新地址" }] });
    expect(wrapper.findAll('[data-testid^="connection-http"]')).toHaveLength(1);
    expect(online.loggedIn).toBe(false);
    expect(online.user).toBeNull();
    expect(wrapper.find('[data-testid="connection-logged-in"]').exists()).toBe(false);
  });

  it("editing to an equivalent existing address rejects the duplicate without changing either connection", async () => {
    const { wrapper, online, storage, i18n } = await mountPanel();
    online.addProfile("http://10.0.0.8:9000/", "备用");
    online.setActive(SERVER_A);
    await flushPromises();
    await online.login("alice", "password8");
    const signedInUser = online.user;
    const persisted = storage.getItem(STORAGE_KEY);
    const profiles = [{ baseUrl: SERVER_A, name: "团队服务器" }, { baseUrl: "http://10.0.0.8:9000/", name: "备用" }];
    await wrapper.find(`[data-testid="connection-${SERVER_A}"] [data-testid="connection-edit"]`).trigger("click");
    await wrapper.find('[data-testid="connections-url"]').setValue("  http://10.0.0.8:9000  ");
    await wrapper.find('[data-testid="connections-name"]').setValue("不可覆盖");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    await flushPromises();
    expect.soft(online.profiles).toEqual(profiles);
    expect.soft(storage.getItem(STORAGE_KEY)).toBe(persisted);
    expect.soft(online.activeBaseUrl).toBe(SERVER_A);
    expect.soft(online.loggedIn).toBe(true);
    expect.soft(online.user).toEqual(signedInUser);
    expect.soft(wrapper.find('[data-testid="connections-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="connections-form-error"]').exists(), "the form must explain the duplicate rather than silently saving").toBe(true);
    expect(wrapper.find('[data-testid="connections-form-error"]').text()).toContain("已存在");
    i18n.global.locale.value = "en";
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    expect(wrapper.find('[data-testid="connections-form-error"]').text()).toContain("already exists");
    expect(online.profiles).toEqual(profiles);
    expect(storage.getItem(STORAGE_KEY)).toBe(persisted);
    i18n.global.locale.value = "zh-CN";
  });

  it("editing an inactive connection keeps the active login and profile order", async () => {
    const { wrapper, api, online, storage } = await mountPanel();
    const other = "http://10.0.0.8:9000/";
    online.addProfile(other, "活动连接");
    await flushPromises();
    await online.login("bob", "password8");
    const signedInUser = online.user;
    api.onlineResume = async () => ({ outcome: "signed-out" });
    await wrapper.find(`[data-testid="connection-${SERVER_A}"] [data-testid="connection-edit"]`).trigger("click");
    await wrapper.find('[data-testid="connections-url"]').setValue("http://10.0.0.9:9000");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    await flushPromises();
    expect(online.profiles).toEqual([{ baseUrl: "http://10.0.0.9:9000", name: "团队服务器" }, { baseUrl: other, name: "活动连接" }]);
    expect(online.activeBaseUrl).toBe(other);
    expect(online.user).toEqual(signedInUser);
    expect(online.loggedIn).toBe(true);
    // An equivalent spelling of the active root is only a rename, not a token-key change.
    await wrapper.find(`[data-testid="connection-${other}"] [data-testid="connection-edit"]`).trigger("click");
    await wrapper.find('[data-testid="connections-url"]').setValue("  http://10.0.0.8:9000  ");
    await wrapper.find('[data-testid="connections-name"]').setValue("仅改名称");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    await flushPromises();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual({ active: other, servers: [{ baseUrl: "http://10.0.0.9:9000", name: "团队服务器" }, { baseUrl: other, name: "仅改名称" }] });
    expect(online.user).toEqual(signedInUser);
    expect(online.loggedIn).toBe(true);
  });

  it("删除连接：档案从列表消失、激活位回退", async () => {
    const { wrapper, online } = await mountPanel();
    online.addProfile("http://10.0.0.8:9000", "备用");
    await flushPromises();
    // 删除非激活的「备用」
    const backupRow = wrapper
      .findAll('[data-testid^="connection-http"]')
      .find((r) => r.attributes("data-testid") === "connection-http://10.0.0.8:9000")!;
    await backupRow.find('[data-testid="connection-delete"]').trigger("click");
    expect(online.profiles.map((p) => p.baseUrl)).toEqual([SERVER_A]);
  });

  it("登录动作：激活档案 + 打开登录对话框（online.dialogOpen 置位）", async () => {
    const { wrapper, online } = await mountPanel();
    await wrapper.find('[data-testid="connection-login"]').trigger("click");
    expect(online.activeBaseUrl).toBe(SERVER_A);
    expect(online.dialogOpen).toBe(true);
  });

  it("浏览动作：激活档案、拉取工作区并 emit browse（主页切服务器视图）", async () => {
    const { api, wrapper, online, browsed } = await mountPanel();
    await api.onlineLogin({ baseUrl: SERVER_A, username: "alice", password: "password8" });
    await online.resume(SERVER_A);
    // 预置一个团队空间（替身初始清单为空）
    await api.onlineWorkspaceCreate({ name: "团队空间甲" });
    await wrapper.find('[data-testid="connection-browse"]').trigger("click");
    await flushPromises();
    expect(online.activeBaseUrl).toBe(SERVER_A);
    expect(browsed).toEqual([SERVER_A]);
    expect(online.workspaces.length).toBeGreaterThan(0); // 已登录 → refreshWorkspaces 已拉取
  });
});
