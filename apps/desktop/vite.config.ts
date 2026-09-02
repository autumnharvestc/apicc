import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [vue()],
  build: { outDir: "../../dist-renderer", emptyOutDir: true },
});
