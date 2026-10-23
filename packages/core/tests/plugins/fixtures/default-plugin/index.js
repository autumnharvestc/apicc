// 本地插件夹具：仅默认导出（规格 D2：默认导出同样识别）。
import { readFileSync } from "node:fs";
export default {
  manifest: JSON.parse(readFileSync(new URL("./apicc-plugin.json", import.meta.url), "utf8")),
  setup(ctx) {
    ctx.register({
      kind: "reporter", id: "fixture.default/reporter.text",
      render: async () => "fixture-report",
    });
  },
};
