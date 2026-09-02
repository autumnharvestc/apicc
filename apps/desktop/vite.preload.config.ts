import { defineConfig } from "vite";
import { resolve } from "node:path";

// sandbox 模式下的 preload 只支持 CommonJS 且 require 受限，必须打包为
// 单文件自包含 .cjs（tsc 的 NodeNext 产物是 ESM，无法在 sandboxed preload 中运行）。
export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), "src/preload/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    outDir: "dist-electron",
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: ["electron"],
    },
  },
});
