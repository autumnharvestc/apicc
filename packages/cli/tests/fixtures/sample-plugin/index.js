// CLI 夹具插件：具名 plugin 导出，setup 注册一个断言操作符（裁定①：直接 ESM JS 免构建）。
export const plugin = {
  name: "sample-plugin",
  version: "1.0.0",
  setup(ctx) {
    ctx.registry.registerAssert({
      op: "sampleEq",
      evaluate: (actual, expected) => ({ pass: String(actual) === expected, message: "sampleEq" }),
    });
  },
};
