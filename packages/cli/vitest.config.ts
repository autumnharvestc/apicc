import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // E2E, MCP, and subprocess fixtures share a disk-heavy runner; bound concurrency across host sizes.
    maxWorkers: Math.min(2, availableParallelism()),
  },
});
