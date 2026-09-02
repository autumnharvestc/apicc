import type { ApiccApi } from "../../../shared/types.js";

/**
 * 渲染层 API 单例：Electron 内取 preload 暴露的 window.apicc（IPC 契约）；
 * vitest（jsdom 无 preload）与浏览器直开调试回退内存替身。
 *
 * 注意：内存替身必须经「动态 import + 异步转发 Proxy」惰性加载，不能静态 import——
 * memory.ts 依赖 node:fs/node:os 等内置模块，静态引入会被 vite externalize 成
 * 「访问即抛」的浏览器 stub，模块求值即炸掉 Electron 生产包（本任务冒烟实测）。
 * ApiccApi 全部方法返回 Promise，故异步转发与接口签名天然吻合。
 * 组合根（App.vue）必须经此单例一次装配全部 store；不得在此之外另建实例。
 */
function lazyMemoryApi(): ApiccApi {
  let impl: Promise<ApiccApi> | null = null;
  const load = () => (impl ??= import("./memory.js").then((m) => m.createMemoryApi()));
  return new Proxy({} as ApiccApi, {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        const api = await load();
        const value = (api as unknown as Record<string, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).apply(api, args) : value;
      };
    },
  });
}

export const apicc: ApiccApi = window.apicc ?? lazyMemoryApi();
