import { describe, expect, it } from "vitest";
import { createWorkflowScheduler } from "../../src/workflow/scheduler.js";

describe("workflow leaf scheduler", () => {
  it("starts two leaves together and keeps the third queued until a permit is released", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let twoEntered!: () => void;
    const entered = new Promise<void>((resolve) => { twoEntered = resolve; });
    const scheduler = createWorkflowScheduler({ maxConcurrency: 2 });
    let active = 0; let peak = 0; const starts: number[] = [];
    const tasks = [1, 2, 3].map((id) => scheduler.runLeaf(async () => {
      starts.push(id); active++; peak = Math.max(peak, active);
      if (active === 2) twoEntered();
      await gate;
      active--;
    }));
    await entered;
    expect(active).toBe(2); expect(starts).toEqual([1, 2]);
    release();
    await Promise.all(tasks); await scheduler.drain();
    expect(active).toBe(0); expect(peak).toBe(2); expect(starts).toEqual([1, 2, 3]);
  });

  it("cancels queued work but drains a started noncooperative leaf before returning its permit", async () => {
    const scheduler = createWorkflowScheduler({ maxConcurrency: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const running = scheduler.runLeaf(() => gate, controller.signal);
    let started = false;
    const queued = scheduler.runLeaf(async () => { started = true; }, controller.signal);
    const rejected = expect(queued).rejects.toThrow("branch cancelled");
    controller.abort(new Error("branch cancelled"));
    await rejected;
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false); expect(started).toBe(false);
    release(); await running; await drain;
    expect(drained).toBe(true);
  });

  it("rejects every queued leaf on root cancellation without starting a replacement", async () => {
    const controller = new AbortController();
    const scheduler = createWorkflowScheduler({ maxConcurrency: 1, signal: controller.signal });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = scheduler.runLeaf(() => gate); let starts = 0;
    const queued = [1, 2].map(() => scheduler.runLeaf(async () => { starts++; }));
    const settled = Promise.allSettled(queued);
    controller.abort(new Error("root stop"));
    expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    release(); await running; await scheduler.drain(); expect(starts).toBe(0);
    await expect(scheduler.runLeaf(async () => {})).rejects.toThrow("root stop");
  });
});
