import type { ApiccApi } from "../../../shared/types.js";

/**
 * 渲染层 API 单例：Electron 内取 preload 暴露的 window.apicc（IPC 契约）；
 * vitest（jsdom 无 preload）与浏览器直开调试回退内存替身。
 *
 * Electron 路径统一深平化入参（withPlainArgs）：store 返回的 Pinia/Vue 状态是
 * Proxy，跨 contextBridge 结构化克隆即抛「An object could not be cloned」
 * （2026-09-06 用户导入实测暴露——editor/wfSave 曾各自手写 JSON 深拷贝绕过，
 * importApply/envVarsSave/onlineFilePut 等漏网）。单点收口后 store 层无需各自转换；
 * 入参均为 JSON 契约数据（zod schema），round-trip 无损。jsdom 内存替身路径无克隆
 * 限制，保持原样（直接注入的 store 测试依赖真实引用）。
 *
 * 注意：内存替身必须经「动态 import + 异步转发 Proxy」惰性加载，不能静态 import——
 * memory.ts 依赖 node:fs/node:os 等内置模块，静态引入会被 vite externalize 成
 * 「访问即抛」的浏览器 stub，模块求值即炸掉 Electron 生产包（任务 8 冒烟实测）。
 * ApiccApi 全部方法返回 Promise，故异步转发与接口签名天然吻合。
 * 组合根（App.vue）必须经此单例一次装配全部 store；不得在此之外另建实例。
 * 回归守门：tests/renderer/api/api-singleton.test.ts（回退单例转发语义）、
 * tests/renderer/api/bundle-isolation.test.ts（产物层：静态引用混入入口即红）、
 * tests/renderer/api/ipc-plain-args.test.ts（Electron 路径入参深平化）。
 */

/**
 * 深平化：结构化克隆只接受普通对象；undefined 原样保留（顶层缺省参数合法）。
 */
export function toPlain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Electron API 包装：每次调用深平化全部入参（函数型入参原样透传——如 onDirtyCheck 的
 * 应答器回调，JSON 往返会把函数抹成 undefined）。目标必须是普通空对象——contextBridge
 * 暴露的属性不可配置（non-configurable），直接 Proxy 其本体时 get 陷阱返回新函数会触发
 * Proxy 不变式报错（'get' on proxy: … did not return its actual value，2026-09-06
 * 打开工作区实测）；以空对象为目标动态转发（与内存回退 lazyMemoryApi 同款模式）。 */
export function withPlainArgs(api: ApiccApi): ApiccApi {
  return new Proxy({} as ApiccApi, {
    get(_target, prop: string) {
      const value = (api as unknown as Record<string, unknown>)[prop];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(
          api,
          args.map((arg) => (typeof arg === "function" ? arg : toPlain(arg))),
        );
    },
  });
}

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

export const apicc: ApiccApi = window.apicc ? withPlainArgs(window.apicc) : lazyMemoryApi();
