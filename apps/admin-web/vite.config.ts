import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    // 开发模式直连同机自托管服务端（M4 规格 §2 D2/裁定②）：/api/** 代理到
    // 本地 8080 端口的 jar，控制台自身走同源相对路径，无跨域问题。
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
