// 本地插件夹具：具名 plugin 导出（裁定①：直接 ESM JS 免构建）。setup 内注册断言操作符。
export const plugin = {
  name: "named-fixture",
  version: "1.0.0",
  setup(ctx) {
    ctx.registry.registerAssert({
      op: "fixtureEq",
      evaluate: (actual, expected) => ({ pass: String(actual) === expected, message: "fixtureEq" }),
    });
  },
};
