import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // These suites perform concurrent transactional filesystem I/O; keep the upper bound stable on high-core hosts.
    maxWorkers: Math.min(2, availableParallelism()),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85, functions: 80 },
    },
  },
});
