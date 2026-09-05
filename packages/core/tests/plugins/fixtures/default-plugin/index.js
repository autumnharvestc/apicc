// 本地插件夹具：仅默认导出（规格 D2：默认导出同样识别）。
export default {
  name: "default-fixture",
  version: "2.0.0",
  setup(ctx) {
    ctx.registry.registerReporter({
      format: "fixture-text",
      render: async () => "fixture-report",
    });
  },
};
