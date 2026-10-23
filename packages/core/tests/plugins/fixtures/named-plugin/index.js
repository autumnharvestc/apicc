// 本地插件夹具：具名 plugin 导出（裁定①：直接 ESM JS 免构建）。setup 内注册断言操作符。
import { readFileSync } from "node:fs";
export const plugin = {
  manifest: JSON.parse(readFileSync(new URL("./apicc-plugin.json", import.meta.url), "utf8")),
  setup(ctx) {
    ctx.register({
      kind: "assert", id: "fixture.named/assert.eq",
      evaluate: (actual, expected) => ({ pass: String(actual) === expected, message: "fixtureEq" }),
    });
  },
};
