// 本地插件夹具：setup 抛错——失败隔离为 LoadProblem（规格 D3）。
export const plugin = {
  name: "setup-throws-fixture",
  version: "1.0.0",
  setup() {
    throw new Error("setup 崩溃");
  },
};
