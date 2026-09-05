// M4-A 任务 1：最小挂载冒烟——证明 vitest + jsdom + vue(+vue-i18n) 装配可用
// （计划任务 1 步骤 1③）；顺带钉住 D8 全局约束「zh/en 成对」的键集一致。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../src/App.vue";
import { createAdminI18n } from "../src/i18n/index.js";
import zhCN from "../src/i18n/zh-CN.json";
import en from "../src/i18n/en.json";

function mountApp() {
  const { i18n } = createAdminI18n();
  return mount(App, { global: { plugins: [i18n] } });
}

describe("App 最小挂载冒烟", () => {
  it("挂载渲染根容器与 i18n 标题：localStorage 语言偏好优先（zh-CN → 管理控制台）", () => {
    // jsdom 的 navigator.language 固定 en-US——用存储偏好钉住 zh-CN 渲染路径，
    // 同时证明偏好持久化键（apicc.admin.locale）被正确消费。
    localStorage.setItem("apicc.admin.locale", "zh-CN");
    const wrapper = mountApp();
    expect(wrapper.find("[data-testid=app-root]").exists()).toBe(true);
    expect(wrapper.text()).toContain("管理控制台");
  });

  it("无存储偏好 → 按 navigator 语言回退（jsdom en-US → Admin Console）", () => {
    localStorage.clear();
    const wrapper = mountApp();
    expect(wrapper.text()).toContain("Admin Console");
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
