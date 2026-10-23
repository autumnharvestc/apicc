// CLI 夹具插件：具名 plugin 导出，setup 注册一个断言操作符（裁定①：直接 ESM JS 免构建）。
export const plugin = {
  manifest: { manifestVersion: 1, id: "example.demo", name: "sample-plugin", version: "0.1.0", apiVersion: 1,
    engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./index.js", capabilities: ["assert"],
    contributions: [{ kind: "assert", id: "example.demo/assert.has-field" }] },
  setup(ctx) {
    ctx.register({
      kind: "assert", id: "example.demo/assert.has-field",
      evaluate: (actual, expected) => {
        const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
          && expected !== undefined && Object.hasOwn(actual, expected);
        return { pass, message: pass ? "包含字段" : "缺少字段" };
      },
    });
  },
};
