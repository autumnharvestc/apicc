import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    // 控制台是浏览器应用：组件挂载/store/路由守卫测试都需要 DOM，全局 jsdom
    // （计划任务 1 裁定）；契约/客户端纯逻辑测试同环境运行无碍。
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
