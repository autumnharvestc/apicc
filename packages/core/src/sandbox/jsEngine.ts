import { createContext, runInNewContext } from "node:vm";
import type { ScriptContext, ScriptEngine } from "../plugin/types.js";

export const SCRIPT_TIMEOUT_MS = 3000;

export class ScriptTimeoutError extends Error {}

/**
 * node:vm 独立上下文：不提供 require/process/fs/net（规格 §8）。
 * 脚本只能通过注入的 pm 对象与外界交互。
 */
export const jsScriptEngine: ScriptEngine = {
  language: "javascript",
  run(code: string, ctx: ScriptContext): void {
    const sandbox = createContext({ pm: ctx.pm });
    try {
      runInNewContext(code, sandbox, { timeout: SCRIPT_TIMEOUT_MS });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("Script execution timed out")) throw new ScriptTimeoutError(`脚本超时（>${SCRIPT_TIMEOUT_MS}ms）`);
      throw e;
    }
  },
};

// 实现说明：引擎只负责把 `pm` 原样传入沙箱——脚本对该对象的一切读写（含新增属性）
// 都直接落在 `ctx.pm` 上，由测试第一个用例验证；`pm.variables` 与真实解析器的联动
// 由测试最后一个用例验证。
