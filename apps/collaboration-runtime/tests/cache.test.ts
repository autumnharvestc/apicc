import { expect, it } from "vitest";
import { PlanCache } from "../src/cache.js";
import { CompiledMockPlanSchema } from "@apicc/core/collaboration/shared";

const plan = (revision: string) => ({ sourceProjectRevision: revision, routes: [] });
const digestA = "a".repeat(64), digestB = "b".repeat(64), digestC = "c".repeat(64);
it("evicts by serialized safe plan bytes and LRU recency", () => {
  const a = plan("a"), b = plan("b"), c = plan("c");
  expect(CompiledMockPlanSchema.safeParse(a).success).toBe(true);
  const bytes = Buffer.byteLength(JSON.stringify(a));
  const cache = new PlanCache(bytes * 2, "core-a");
  cache.put(digestA, a); cache.put(digestB, b); expect(cache.get(digestA)).toEqual(a);
  cache.put(digestC, c);
  expect.soft(cache.get(digestB)).toBeUndefined();
  expect.soft(cache.get(digestA)).toEqual(a); expect(cache.get(digestC)).toEqual(c);
});
it("does not retain an oversized plan", () => {
  const cache = new PlanCache(1, "core-a"); cache.put(digestA, plan("a"));
  expect(cache.get(digestA)).toBeUndefined();
});
it("isolates entries by actual Core build identity", () => {
  const cache = new PlanCache(1024, "core-a"); cache.put(digestA, plan("a"));
  expect(cache.get(digestA, "core-b")).toBeUndefined();
});
it("stores safe parsed bytes without retaining caller source references", () => {
  const value = plan("safe"); const cache = new PlanCache(1024, "core-a"); cache.put(digestA, value);
  value.sourceProjectRevision = "changed";
  const first = cache.get(digestA)!;
  expect.soft(first.sourceProjectRevision).toBe("safe");
  first.sourceProjectRevision = "mutated-read";
  expect(cache.get(digestA)?.sourceProjectRevision).toBe("safe");
});
it("refuses unknown source material rather than caching it", () => {
  const cache = new PlanCache(1024, "core-a");
  expect(() => cache.put(digestA, Object.assign(plan("safe"), { rawSource: "synthetic-private" }))).toThrow("RPC_PLAN_INVALID");
});
