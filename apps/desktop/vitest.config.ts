import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // antd 引入后 App 动态 import 需加载 ant-design-vue 全量 barrel，
    // Windows 冷启动可超默认 5s——放宽单用例超时避免冷加载误报；
    // 任务 7 新增 antd 组件用例（ImportWizard）后全量并行负载再超 20s，放宽至 30s。
    testTimeout: 30000,
  },
});
