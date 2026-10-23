// 本地插件夹具：setup 抛错——失败隔离为 LoadProblem（规格 D3）。
import { readFileSync } from "node:fs";
export const plugin = {
  manifest: JSON.parse(readFileSync(new URL("./apicc-plugin.json", import.meta.url), "utf8")),
  setup() {
    throw new Error("setup 崩溃");
  },
};
