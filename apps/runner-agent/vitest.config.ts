import { defineConfig } from "vitest/config";
export default defineConfig({ plugins: [{ name: "vitest-node-sqlite-native", enforce: "pre", applyToEnvironment: environment => environment.name === "client", resolveId(source) { if (source === "node:sqlite") return { id: source, external: true }; } }], test: { include: ["tests/**/*.test.ts"], maxWorkers: 2, testTimeout: 15000 } });
