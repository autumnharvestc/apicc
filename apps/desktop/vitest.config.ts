import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // antd 引入后 App 动态 import 需加载 ant-design-vue 全量 barrel，
    // Windows 冷启动可超默认 5s——放宽单用例超时避免冷加载误报。
    testTimeout: 20000,
  },
});
