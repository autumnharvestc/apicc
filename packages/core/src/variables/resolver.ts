export class CyclicVariableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclicVariableError";
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}/g;

const dynamic: Record<string, () => string> = {
  $timestamp: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $uuid: () => crypto.randomUUID(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

export interface VariableResolver {
  /** 按优先级取值；未命中返回 undefined。 */
  get(name: string): string | undefined;
  /** 替换字符串中全部 {{name}}；未知变量保留原文；循环引用抛 CyclicVariableError。 */
  resolve(input: string): string;
  setRuntime(name: string, value: string): void;
  clearRuntime(): void;
}

/**
 * layers 按「高 → 低」优先级排列：[运行时, 环境, 集合, 项目, 全局]。
 * 运行时层始终存在且位于最前（规格 §7.3）。
 */
export function createVariableResolver(opts: { layers: Array<Record<string, string>> }): VariableResolver {
  const runtime = new Map<string, string>();

  function raw(name: string): string | undefined {
    for (const layer of [Object.fromEntries(runtime), ...opts.layers]) {
      if (!Object.hasOwn(layer, name)) continue;
      const v = layer[name];
      if (v !== undefined) return v;
    }
    if (Object.hasOwn(dynamic, name)) return dynamic[name]?.();
    return undefined;
  }

  function resolveName(name: string, seen: string[]): string | undefined {
    if (seen.includes(name)) {
      throw new CyclicVariableError(`变量循环引用: ${[...seen, name].join(" → ")}`);
    }
    const v = raw(name);
    if (v === undefined) return undefined;
    if (PLACEHOLDER.test(v)) {
      PLACEHOLDER.lastIndex = 0;
      return resolve(v, [...seen, name]);
    }
    return v;
  }

  function resolve(input: string, seen: string[] = []): string {
    return input.replace(PLACEHOLDER, (match, name: string) => resolveName(name, seen) ?? match);
  }

  return {
    get: (name) => resolveName(name, []),
    resolve: (input) => resolve(input),
    setRuntime: (name, value) => runtime.set(name, value),
    clearRuntime: () => runtime.clear(),
  };
}
