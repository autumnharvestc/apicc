import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/events/bus.js";

describe("EventBus", () => {
  it("按注册顺序串行触发同类型处理器", async () => {
    const bus = createEventBus();
    const calls: string[] = [];
    bus.on("beforeCase", async () => { calls.push("a"); });
    bus.on("beforeCase", async () => { calls.push("b"); });
    await bus.emit("beforeCase", { apiName: "x", caseName: "y", row: undefined });
    expect(calls).toEqual(["a", "b"]);
  });

  it("off 后不再触发，且不同事件互不影响", async () => {
    const bus = createEventBus();
    let n = 0;
    const off = bus.on("afterRun", () => { n += 1; });
    bus.on("beforeRun", () => { n += 100; });
    off();
    await bus.emit("afterRun", { total: 0, passed: 0, failed: 0 });
    await bus.emit("beforeRun", { collectionName: "c" });
    expect(n).toBe(100);
  });

  it("处理器抛错时 emit 拒绝并带事件名", async () => {
    const bus = createEventBus();
    bus.on("afterResponse", () => { throw new Error("boom"); });
    await expect(bus.emit("afterResponse", { status: 200, timeMs: 0 })).rejects.toThrow(/afterResponse.*boom/);
  });
});
