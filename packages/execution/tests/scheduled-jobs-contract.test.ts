import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ControlBatchV1Schema, ScheduleHistoryPageSchema } from "../src/contract/index.js";

// Exact successful Java controller captures, not hand-built schema examples.
const capture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../server/src/test/resources/scheduling/${name}.json`, import.meta.url), "utf8"));

it("accepts the real original Job history projection through the frozen strict history contract", () => {
  const page = ScheduleHistoryPageSchema.parse(capture("job-history"));
  expect(page.items[0]?.execution).toEqual({ availability: "available", state: "queued", released: false, reportState: "none" });
  expect(page.items[0]?.state).toBe("submitted");
  expect(page.items[0]?.jobId).toBe("78");
  expect(page.items[0]?.executionId).toBe("79");
});

it("delivers a scheduled Job through the existing strict runner contract without server-only source fields", () => {
  const batch = ControlBatchV1Schema.parse(capture("job-control-batch"));
  expect(batch.deliveries[0]?.task.jobId).toBe("5");
  expect(batch.deliveries[0]?.task.submittedByUserId).toBe("4");
  expect(batch.deliveries[0]?.task.dispatchKind).toBe("dedicated-task");
});
