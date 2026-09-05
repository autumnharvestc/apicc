// 本地插件夹具：形状不符（version 非字符串、setup 非函数）——形状校验拒绝。
export const plugin = { name: "bad-shape-fixture", version: 42, setup: "not-a-function" };
