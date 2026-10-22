import assert from "node:assert/strict";
import { test } from "vitest";
import { waitForRendererReady } from "../scripts/smoke-readiness.mjs";

const ready = {
  url: "file:///fixture/resources/app.asar/dist-renderer/index.html",
  readyState: "complete",
  title: "apicc",
  children: 1,
};

// Virtual time isolates startup timing from machine speed; only the CDP boundary is replaced.
function fixture(stateAt: (time: number) => typeof ready | null, start = 0, deadline = 2000) {
  let time = start;
  const budgets: number[] = [];
  return {
    run: () => waitForRendererReady({
      deadline,
      now: () => time,
      sleep: async (ms: number) => { time += ms; },
      isAlive: () => true,
      observe: async (budget: number) => {
        budgets.push(budget);
        return stateAt(time);
      },
    }),
    time: () => time,
    budgets,
  };
}

test("target may exist before the document title and mount are ready", async () => {
  const f = fixture((time) => time < 500
    ? { ...ready, readyState: "loading", title: "", children: 0 }
    : time < 1000 ? { ...ready, children: 0 } : ready);
  assert.deepEqual(await f.run(), ready);
  assert.equal(f.time(), 1000);
});

test("permanent wrong title, empty mount, loading document or wrong URL still fail", async () => {
  for (const state of [
    { ...ready, title: "wrong" },
    { ...ready, title: "" },
    { ...ready, children: 0 },
    { ...ready, readyState: "loading" },
    { ...ready, url: "file:///fixture/dist-renderer/index.html" },
  ]) {
    const f = fixture(() => state);
    await assert.rejects(f.run(), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /就绪超时/);
      assert.ok(error.message.includes(JSON.stringify(state)));
      return true;
    });
    assert.equal(f.time(), 2000);
  }
});

test("late discovery keeps the original deadline and caps the last sleep and probe", async () => {
  const f = fixture((time) => time < 19800 ? null : { ...ready, children: 0 }, 19300, 20000);
  await assert.rejects(f.run(), /就绪超时/);
  assert.equal(f.time(), 20000);
  assert.deepEqual(f.budgets, [700, 200]);
});

test("probe failures and early exit cannot become ready", async () => {
  let time = 0;
  await assert.rejects(waitForRendererReady({
    deadline: 700,
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    isAlive: () => true,
    observe: async () => { throw new Error("renderer load failed"); },
  }), /renderer load failed/);
  assert.equal(time, 700);
  await assert.rejects(waitForRendererReady({
    deadline: 2000,
    now: () => 0,
    sleep: async () => assert.fail("must not wait after process exit"),
    isAlive: () => false,
    observe: async () => ready,
  }), /进程提前退出/);
});

test("CDP protocol error is terminal even if the next document observation would be ready", async () => {
  let time = 0;
  const protocolError = Object.assign(new Error('{"code":-32601,"message":"Runtime.enable unavailable"}'), {
    code: "ERR_CDP_PROTOCOL",
  });
  await assert.rejects(waitForRendererReady({
    deadline: 2000,
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    isAlive: () => true,
    observe: async () => {
      if (time === 0) throw protocolError;
      return ready;
    },
  }), (error) => {
    assert.equal(error, protocolError);
    return true;
  });
  assert.equal(time, 0);
});
