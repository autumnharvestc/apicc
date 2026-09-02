// @vitest-environment jsdom
// 注：vitest 4 已移除 environmentMatchGlobs，渲染层测试改用本文件级 pragma 指定 jsdom 环境。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../../src/renderer/src/App.vue";

describe("App", () => {
  it("挂载并渲染就绪标记", () => {
    const wrapper = mount(App);
    expect(wrapper.find('[data-testid="app-ready"]').text()).toBe("apicc");
  });
});
