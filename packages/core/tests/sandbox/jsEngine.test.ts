import { describe, expect, it } from "vitest";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";
import type { PmApi, ScriptContext } from "../../src/plugin/types.js";

const pm: PmApi = {
  variables: { get: () => undefined, set: () => {} },
  environment: { get: () => undefined },
  request: { method: "GET", url: "http://x/", headers: {}, query: [] },
  assert(cond: boolean, message: string) {
    const acc = (this as { __asserts?: { cond: boolean; message: string }[] }).__asserts ??= [];
    acc.push({ cond, message });
  },
};

const ctx: ScriptContext = { pm };

describe("jsScriptEngine", () => {
  it("把同一个 pm 对象传入沙箱（脚本的读写直接作用于该对象）", () => {
    jsScriptEngine.run("pm.variables.set('token', 'abc'); pm.__probe = true;", ctx);
    expect((ctx.pm as { __probe?: boolean }).__probe).toBe(true);
  });

  it("脚本异常向上传播", () => {
    expect(() => jsScriptEngine.run("throw new Error('bad');", ctx)).toThrow(/bad/);
  });

  it("死循环在超时后被中断", () => {
    expect(() => jsScriptEngine.run("for(;;){}", ctx)).toThrow();
  });

  it("沙箱内无法访问 node:fs", () => {
    expect(() => jsScriptEngine.run("require('node:fs');", ctx)).toThrow();
  });
});

import { createVariableResolver } from "../../src/variables/resolver.js";

it("pm.variables.set 写入 resolver 运行时层", () => {
  const resolver = createVariableResolver({ layers: [] });
  const realCtx: ScriptContext = {
    pm: {
      variables: { get: (n) => resolver.get(n), set: (n, v) => resolver.setRuntime(n, v) },
      environment: { get: () => undefined },
      request: { method: "GET", url: "/", headers: {}, query: [] },
      assert: () => {},
    },
  };
  jsScriptEngine.run("pm.variables.set('k', 'v');", realCtx);
  expect(resolver.get("k")).toBe("v");
});
