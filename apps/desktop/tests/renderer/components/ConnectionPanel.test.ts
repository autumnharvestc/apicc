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
  return { wrapper, api, online, storage, browsed };
}

describe("ConnectionPanel", () => {
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
    const { wrapper, online } = await mountPanel();
    await wrapper.find('[data-testid="connection-edit"]').trigger("click");
    expect((wrapper.find('[data-testid="connections-url"]').element as HTMLInputElement).value).toBe(SERVER_A);
    await wrapper.find('[data-testid="connections-name"]').setValue("新昵称");
    await wrapper.find('[data-testid="connections-save"]').trigger("click");
    expect(online.profiles.map((p) => p.name)).toEqual(["新昵称"]);
    expect(online.profiles).toHaveLength(1); // 同地址改昵称，不新增
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
