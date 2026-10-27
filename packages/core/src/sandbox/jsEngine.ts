import { createContext, runInNewContext } from "node:vm";
import type { ScriptContext, ScriptEngine } from "../plugin/types.js";

export const SCRIPT_TIMEOUT_MS = 3000;

export class ScriptTimeoutError extends Error {}

/**
 * 复用 node:vm 的受信同步脚本语义与超时；这不构成恶意代码隔离机制。
 * 不向脚本注册新的主机 API。
 */
export function createJsScriptEngine(options: { timeoutMs?: number } = {}): ScriptEngine {
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError("Invalid script timeoutMs");
  return {
  language: "javascript",
  run(code: string, ctx: ScriptContext): void {
    const sandbox = createContext({ pm: ctx.pm });
    try {
      runInNewContext(code, sandbox, { timeout: timeoutMs });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("Script execution timed out")) throw new ScriptTimeoutError(`脚本超时（>${timeoutMs}ms）`);
      throw e;
    }
  },
  };
}
export const jsScriptEngine = createJsScriptEngine();

// 实现说明：引擎只负责把 `pm` 原样传入执行上下文——脚本对该对象的一切读写（含新增属性）
// 都直接落在 `ctx.pm` 上，由测试第一个用例验证；`pm.variables` 与真实解析器的联动
// 由测试最后一个用例验证。
