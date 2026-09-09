// M4-A 任务 2：App 装配冒烟——App 为组合根渲染 router-view；未登录启动经守卫落在登录页。
// 另钉 i18n 初始语言行为（localStorage 偏好优先 / navigator 回退）与 D8 zh/en 键集成对。
// （任务 1 版本的「挂载渲染标题」断言随 App 装配面演进为登录页装配断言。）
import { describe, expect, it, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import App from "../src/App.vue";
import { createAdminI18n } from "../src/i18n/index.js";
import { createAdminClient } from "../src/api/client.js";
import { createSessionStore } from "../src/stores/session.js";
import { createWorkspacesStore } from "../src/stores/workspaces.js";
import { createUsersStore } from "../src/stores/users.js";
import { createOrgStore } from "../src/stores/org.js";
import { createAppRouter } from "../src/router/index.js";
import zhCN from "../src/i18n/zh-CN.json";
import en from "../src/i18n/en.json";

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
});

function mountApp() {
  // 空存储下不应发起任何请求；fetch 替身兜底防止意外网络。
  const client = createAdminClient({
    baseUrl: "/api/v1",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/workspaces") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "u", username: "x", displayName: "x" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const session = createSessionStore({ client, storage: localStorage });
  const workspaces = createWorkspacesStore({ client });
  const users = createUsersStore({ client });
  const org = createOrgStore({ client });
  const router = createAppRouter({ session, workspaces, users, org, client });
  const { i18n } = createAdminI18n();
  const wrapper = mount(App, { global: { plugins: [i18n, router] } });
  return { wrapper, router };
}

describe("App 装配冒烟", () => {
  it("未登录启动：初始导航 / 经守卫落在 /login，登录表单渲染（vitest+jsdom+vue+router 装配可用）", async () => {
    localStorage.clear();
    const { wrapper, router } = mountApp();
    await router.isReady();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("login");
    expect(wrapper.find("[data-testid=login-form]").exists()).toBe(true);
  });
});

describe("i18n 初始语言（localStorage 偏好优先，navigator 回退）", () => {
  it("存储偏好 zh-CN 生效", () => {
    localStorage.clear();
    localStorage.setItem("apicc.admin.locale", "zh-CN");
    const { i18n } = createAdminI18n();
    expect(i18n.global.locale.value).toBe("zh-CN");
  });

  it("无存储偏好 → navigator 回退（jsdom en-US → en）", () => {
    localStorage.clear();
    const { i18n } = createAdminI18n();
    expect(i18n.global.locale.value).toBe("en");
  });
});

/** 深度收集消息键路径（嵌套对象展开为 a.b.c），供 zh/en 键集对比。 */
function collectKeys(node: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === "object" ? collectKeys(value as Record<string, unknown>, path) : [path];
  });
}

describe("i18n 消息 zh/en 成对（D8）", () => {
  it("zh-CN 与 en 键集深度一致（单侧漏键即失败）", () => {
    expect(collectKeys(zhCN).sort()).toEqual(collectKeys(en).sort());
  });
});
