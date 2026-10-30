import { describe, expect, it } from "vitest";
import { ScheduleRuleSchema, SchedulePoliciesSchema, ScheduleCredentialBindingSchema, SchedulerDeploymentSchema, NotificationDeploymentSchema, SchedulePolicySchema } from "../src/contract/index.js";

describe("scheduling strict boundary", () => {
  const cron = { kind: "cron", expression: "0 0 9 * * *", timeZone: "Asia/Shanghai", dstOverlap: "first" };
  it.each([
    { ...cron, atUtc: "2026-10-29T01:00:00Z" }, { ...cron, timeZone: "+08:00" },
    { ...cron, dstOverlap: "third" }, { ...cron, expression: "0 9 * * *" },
    { kind: "once", atUtc: "2026-10-29T01:00:00+08:00", timeZone: "Asia/Shanghai" },
    { kind: "once", atUtc: "tomorrow", timeZone: "Asia/Shanghai" },
  ])("rejects malformed or mixed rule %j", rule => expect(ScheduleRuleSchema.safeParse(rule).success).toBe(false));
  it("keeps UTC instants and explicit zones", () => {
    expect(ScheduleRuleSchema.parse(cron)).toEqual(cron);
    const once = { kind: "once", atUtc: "2026-10-29T01:00:00.123Z", timeZone: "UTC" };
    expect(ScheduleRuleSchema.parse(once)).toEqual(once);
  });
  it("supplies paused-safe temporal policies and rejects cross-field overflow", () => {
    expect(SchedulePoliciesSchema.parse({})).toEqual({ lateToleranceMs: 10000, misfire: "skip", catchupWindowMs: 300000, overlap: "skip", queueTimeoutMs: 300000 });
    expect(SchedulePoliciesSchema.safeParse({ lateToleranceMs: 999 }).success).toBe(false);
    expect(SchedulePolicySchema.safeParse({ maxQueueTimeoutMs: 1000 }).success).toBe(false);
  });
  it.each([
    { refId: "token", mode: "current-at-trigger", value: "secret" },
    { refId: "token", mode: "current-at-trigger", version: "1" },
    { refId: "token", mode: "fixed-version" },
    { refId: "token", mode: "fixed-version", version: 1 },
    { refId: "token", mode: "fixed-version", version: "9223372036854775808" },
  ])("never accepts credential values or unfixed bindings %j", binding => expect(ScheduleCredentialBindingSchema.safeParse(binding).success).toBe(false));
  it("keeps fixed credential identity", () => expect(ScheduleCredentialBindingSchema.parse({ refId: "token", mode: "fixed-version", version: "1" })).toEqual({ refId: "token", mode: "fixed-version", version: "1" }));
  it.each([{ mode: "external" }, { scanIntervalMs: 20000, claimLeaseMs: 30000 }, { unknown: 1 }, { evaluationMaxCandidates: 9 }])("rejects invalid scheduler deployment %j", input => expect(SchedulerDeploymentSchema.safeParse(input).success).toBe(false));
  it.each([{ requestTimeoutMs: 30000, leaseMs: 30000 }, { retryMinMs: 6000, retryMaxMs: 5000 }, { allowHttpOrigins: ["http://x.test/path"] }, { jitterRatio: 1.1 }, { unknown: 1 }])("rejects invalid notification deployment %j", input => expect(NotificationDeploymentSchema.safeParse(input).success).toBe(false));
});
