import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPluginContract } from "@apicc/plugin-sdk/testing";
import { plugin } from "../src/index.js";

describe("apicc-plugin-demo 契约", () => {
  it("清单一致且断言贡献可执行", () => {
    expect(plugin.manifest).toEqual(JSON.parse(readFileSync(new URL("../apicc-plugin.json", import.meta.url), "utf8")));
    const checked = checkPluginContract(plugin, { config: {} });
    expect(checked.problems).toEqual([]);
    const assertion = checked.contributions.find(item => item.kind === "assert");
    if (assertion?.kind !== "assert") throw new Error("示例断言未注册");
    expect(assertion.evaluate({ id: 1 }, "id", { found: true, getModel: () => undefined }).pass).toBe(true);
    expect(assertion.evaluate({}, "id", { found: true, getModel: () => undefined }).pass).toBe(false);
  });
});
