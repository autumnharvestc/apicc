// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom（既有先例）。
// M3-B 任务 2：onlineStore 工厂测试——服务器档案增删改持久化（裁定 C：localStorage 先例）、
// 登录成功/失败（失败 → error 且不清旧态）、登出保留档案（档案与登录态分离）、注册双模式、
// 工厂隔离（先例：每调用独立 Pinia 实例）、init/resume 恢复链路（裁定 A 渲染侧）。
// api 用 memory 替身 + 按用例覆写（既有先例）；storage 注入内存替身保证隔离与断言。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createOnlineStore, readPersisted, STORAGE_KEY } from "../../../src/renderer/src/stores/online.js";
import type { OnlineResumeOutput } from "../../../src/shared/online/types.js";

const USER = { id: "u-online-1", username: "alice", displayName: "示例用户" };
const SERVER_A = "http://127.0.0.1:8080";
const SERVER_B = "http://192.168.1.10:8080";

/** 内存 Storage 替身：与 jsdom/localStorage 同形，实例间互不共享（工厂隔离断言用）。 */
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

function setup() {
  const api = createMemoryApi();
  const storage = memStorage();
  const store = createOnlineStore({ api, storage });
  return { api, storage, store };
}

describe("onlineStore 工厂隔离", () => {
  it("两实例（各自 storage/api）档案与登录态互不可见", async () => {
    const a = setup();
    const b = setup();
    expect(a.store.profiles).toEqual([]);
    a.store.addProfile(SERVER_A, "甲服务器");
    await a.store.login("alice", "password8");
    expect(b.store.profiles).toEqual([]);
    expect(b.store.loggedIn).toBe(false);
    expect(b.store.user).toBeNull();
    // storage 互不共享：A 的档案不进 B 的存储
    expect(b.storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("服务器档案（裁定 C：localStorage 持久化，增删改）", () => {
  it("addProfile：url 归一去空格、激活档案、持久化；同 baseUrl 重复保存 = 改昵称", () => {
    const { store, storage } = setup();
    expect(store.addProfile(`  ${SERVER_A}  `, " 团队服务器 ")).toBe(true);
    expect(store.profiles).toEqual([{ baseUrl: SERVER_A, name: "团队服务器" }]);
    expect(store.activeBaseUrl).toBe(SERVER_A);
    // 持久化：storage 里能读回同一状态
    expect(readPersisted(storage)).toEqual({ active: SERVER_A, servers: [{ baseUrl: SERVER_A, name: "团队服务器" }] });
    // 同 baseUrl 再保存 → 更新昵称而非新增
    expect(store.addProfile(SERVER_A, "改名")).toBe(true);
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]!.name).toBe("改名");
  });

  it("addProfile：非 http(s) 形态拒绝（store 侧护栏，组件已先行校验）", () => {
    const { store } = setup();
    expect(store.addProfile("ftp://x", "n")).toBe(false);
    expect(store.addProfile("", "n")).toBe(false);
    expect(store.profiles).toEqual([]);
    expect(store.activeBaseUrl).toBeNull();
  });

  it("removeProfile：删除档案并持久化；删除激活档案时清激活位与登录态（档案与登录态分离的反向操作）", async () => {
    const { api, store } = setup();
    store.addProfile(SERVER_A, "甲");
    await store.login("alice", "password8");
    expect(store.loggedIn).toBe(true);
    // 删除激活档案（登录目标）：档案移除、激活位与本地登录态清除（尽力吊销由 store 发起）
    store.removeProfile(SERVER_A);
    expect(store.profiles).toEqual([]);
    expect(store.activeBaseUrl).toBeNull();
    expect(store.loggedIn).toBe(false);
    // 未激活档案删除不动登录态：重建登录态（B 档案 + 存档有效）后删除旁路档案 A
    store.addProfile(SERVER_A, "甲");
    store.addProfile(SERVER_B, "乙");
    api.onlineResume = async (input): Promise<OnlineResumeOutput> => ({ outcome: "restored", user: { ...USER, username: input.baseUrl } });
    store.setActive(SERVER_B);
    await flush();
    expect(store.loggedIn).toBe(true);
    store.removeProfile(SERVER_A);
    expect(store.loggedIn).toBe(true);
    expect(store.activeBaseUrl).toBe(SERVER_B);
  });

  it("readPersisted：坏 JSON / 形状不符 → 空白状态 + 不抛（缺失/损坏一律降级）", () => {
    const storage = memStorage();
    storage.setItem(STORAGE_KEY, "not-json{");
    expect(readPersisted(storage)).toEqual({ active: null, servers: [] });
    storage.setItem(STORAGE_KEY, JSON.stringify({ servers: "nope", active: 3 }));
    expect(readPersisted(storage)).toEqual({ active: null, servers: [] });
    // 条目形状不全的被过滤，active 指向不存在档案时复位 null
    storage.setItem(STORAGE_KEY, JSON.stringify({ servers: [{ baseUrl: SERVER_A }, { baseUrl: SERVER_B, name: "乙" }], active: SERVER_A }));
    expect(readPersisted(storage)).toEqual({ active: null, servers: [{ baseUrl: SERVER_B, name: "乙" }] });
  });
});

describe("登录 / 登出 / 注册（plan 任务 2 步骤 1③④）", () => {
  it("login 成功 → user/expiresAt/loggedIn 上屏、error 清空", async () => {
    const { store } = setup();
    store.addProfile(SERVER_A, "甲");
    await store.login("alice", "password8");
    expect(store.loggedIn).toBe(true);
    expect(store.user).toEqual(USER);
    expect(new Date(store.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(store.error).toBeNull();
    expect(store.submitting).toBe(false);
  });

  it("login 失败 → error 置位且不清旧态（已登录另一态原样保留）；档案不受影响", async () => {
    const { api, store } = setup();
    store.addProfile(SERVER_A, "甲");
    await store.login("alice", "password8");
    const beforeUser = store.user;
    const originalLogin = api.onlineLogin.bind(api);
    api.onlineLogin = async () => {
      throw new Error("用户名或密码错误");
    };
    await store.login("alice", "wrong-password");
    expect(store.error).toBe("用户名或密码错误");
    expect(store.loggedIn).toBe(true);
    expect(store.user).toBe(beforeUser);
    expect(store.profiles).toHaveLength(1);
    // 失败后恢复：旧错误被下一次成功清空
    api.onlineLogin = originalLogin;
    await store.login("alice", "password8");
    expect(store.error).toBeNull();
  });

  it("未选激活档案时 login/register 直接返回（组件已禁用提交，store 静默护栏）", async () => {
    const { store } = setup();
    await store.login("alice", "password8");
    expect(store.loggedIn).toBe(false);
    await expect(store.register({ username: "a", password: "password8", displayName: "d" })).resolves.toBe(false);
  });

  it("logout → 登录态清空、档案保留（裁定 C：登出不清档案）", async () => {
    const { store } = setup();
    store.addProfile(SERVER_A, "甲");
    await store.login("alice", "password8");
    await store.logout();
    expect(store.loggedIn).toBe(false);
    expect(store.user).toBeNull();
    expect(store.profiles).toHaveLength(1);
    expect(store.activeBaseUrl).toBe(SERVER_A);
  });

  it("register 成功 → 返回 true 且不建立登录态；失败 → 返回 false + error 上屏", async () => {
    const { api, store } = setup();
    store.addProfile(SERVER_A, "甲");
    const registered: unknown[] = [];
    api.onlineRegister = async (input) => {
      registered.push(input);
      return { id: "u-2", username: input.username, displayName: input.displayName };
    };
    await expect(store.register({ username: "bob", password: "password8", displayName: "Bob" })).resolves.toBe(true);
    expect(registered).toHaveLength(1);
    expect(store.loggedIn).toBe(false);
    api.onlineRegister = async () => {
      throw new Error("用户名已被占用");
    };
    await expect(store.register({ username: "bob", password: "password8", displayName: "Bob" })).resolves.toBe(false);
    expect(store.error).toBe("用户名已被占用");
  });

  it("refreshWorkspaces：登录后拉取工作区列表入 store（列表 UI 归任务 3）", async () => {
    const { store } = setup();
    store.addProfile(SERVER_A, "甲");
    await store.login("alice", "password8");
    await store.refreshWorkspaces();
    expect(store.workspaces.length).toBeGreaterThan(0);
  });
});

describe("init / resume / setActive（裁定 A 渲染侧恢复链路）", () => {
  it("init：载入档案并对激活档案 resume；存档有效（替身已登录）→ 登录态恢复", async () => {
    const { api, storage } = setup();
    await api.onlineLogin({ baseUrl: SERVER_A, username: "alice", password: "password8" });
    // 预置档案存储（模拟上次会话配置）
    storage.setItem(STORAGE_KEY, JSON.stringify({ active: SERVER_A, servers: [{ baseUrl: SERVER_A, name: "甲" }] }));
    const store = createOnlineStore({ api, storage });
    await store.init();
    expect(store.profiles).toEqual([{ baseUrl: SERVER_A, name: "甲" }]);
    expect(store.loggedIn).toBe(true);
    expect(store.user).toEqual(USER);
    expect(store.restoring).toBe(false);
  });

  it("init：验活失败（替身未登录 → signed-out）→ 保持登出态，档案保留、不抛", async () => {
    const { storage } = setup();
    storage.setItem(STORAGE_KEY, JSON.stringify({ active: SERVER_A, servers: [{ baseUrl: SERVER_A, name: "甲" }] }));
    const store = createOnlineStore({ api: createMemoryApi(), storage });
    await expect(store.init()).resolves.toBeUndefined();
    expect(store.loggedIn).toBe(false);
    expect(store.profiles).toHaveLength(1);
  });

  it("init：无档案/存储损坏 → 空档案不 resume、不抛", async () => {
    const { storage } = setup();
    storage.setItem(STORAGE_KEY, "broken{");
    const store = createOnlineStore({ api: createMemoryApi(), storage });
    await expect(store.init()).resolves.toBeUndefined();
    expect(store.profiles).toEqual([]);
    expect(store.activeBaseUrl).toBeNull();
    expect(store.loggedIn).toBe(false);
  });

  it("setActive：切换档案 → 以新 baseUrl resume（spy 记录），旧登录态先清再恢复", async () => {
    const { api, store } = setup();
    store.addProfile(SERVER_A, "甲");
    store.addProfile(SERVER_B, "乙");
    await store.login("alice", "password8"); // 登录在 A（激活档案 A）
    expect(store.loggedIn).toBe(true);
    const resumes: string[] = [];
    api.onlineResume = async (input: { baseUrl: string }): Promise<OnlineResumeOutput> => {
      resumes.push(input.baseUrl);
      return { outcome: "restored", user: { ...USER, username: input.baseUrl } };
    };
    store.setActive(SERVER_B);
    await flush();
    expect(resumes).toEqual([SERVER_B]);
    expect(store.activeBaseUrl).toBe(SERVER_B);
    expect(store.loggedIn).toBe(true);
    // 恢复的用户来自 B 的验活结果（username 以 baseUrl 区分）
    expect(store.user!.username).toBe(SERVER_B);
  });
});

/** 排空微任务队列（resume/login 的 await 链）。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
