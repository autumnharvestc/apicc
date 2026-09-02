import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { cpus } from "node:os";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // antd 引入后 App 动态 import 需加载 ant-design-vue 全量 barrel，
    // Windows 冷启动可超默认 5s——放宽单用例超时避免冷加载误报；
    // 任务 7 新增 antd 组件用例（ImportWizard）后全量并行负载再超 20s，放宽至 30s。
    testTimeout: 30000,
    // 任务 8 再增 3 个 antd+jsdom 测试文件后，12 核全并行下 App.test 首例
    // （承担 barrel 冷加载大头）复现 30s 超时（任务 7 报告预警的负载增长）。
    // 按任务 7 建议改为限流而非继续放宽超时：worker 数减半后冷加载争用显著下降。
    maxWorkers: Math.max(2, Math.floor(cpus().length / 2)),
  },
});
