import { describe, expect, it } from "vitest";
import { ProjectionPolicySchema, SharedMockPolicySchema } from "../../src/collaboration/shared.js";
import { projectPublication } from "../../src/collaboration/projection.js";
import { validateSharedMock } from "../../src/collaboration/policy.js";
import { documentInput, policy } from "./fixtures.js";
import type { SharedMockPolicy } from "../../src/collaboration/types.js";

const shared: SharedMockPolicy = { maxResponseBytes: 1024, maxDelayMs: 0, requestDeadlineMs: 1000,
  extraSensitiveHeaders: [], extraSensitiveQuery: [], extraSensitiveFields: [], extraSensitivePointers: [] };
const keys = ["extraSensitiveHeaders", "extraSensitiveQuery", "extraSensitiveFields", "extraSensitivePointers"] as const;
describe("inherited sensitive policy bounds", () => {
  it.each(keys)("rejects more than 200 entries or an item over 256 characters in %s", (key) => {
    const long = key === "extraSensitivePointers" ? `/${"a".repeat(256)}` : "a".repeat(257);
    const many = Array.from({ length: 201 }, (_, index) => key === "extraSensitivePointers" ? `/p${index}` : `p${index}`);
    for (const values of [[long], many]) {
      expect.soft(ProjectionPolicySchema.safeParse({ ...policy, [key]: values }).success).toBe(false);
      expect.soft(SharedMockPolicySchema.safeParse({ ...shared, [key]: values }).success).toBe(false);
    }
  });
  it.each(["not/a/pointer", "/bad~2", "/trailing~", "\n"])("rejects malformed JSON Pointer %s", (pointer) => {
    expect.soft(ProjectionPolicySchema.safeParse({ ...policy, extraSensitivePointers: [pointer] }).success).toBe(false);
    expect.soft(SharedMockPolicySchema.safeParse({ ...shared, extraSensitivePointers: [pointer] }).success).toBe(false);
  });
  it("rejects unsupported HTTP header field names", () => {
    for (const name of ["bad header", "X-Public\n"]) {
      expect.soft(ProjectionPolicySchema.safeParse({ ...policy, extraSensitiveHeaders: [name] }).success).toBe(false);
      expect.soft(SharedMockPolicySchema.safeParse({ ...shared, extraSensitiveHeaders: [name] }).success).toBe(false);
    }
  });
  it("enforces the aggregate 200-item semantic policy limit across the four lists", async () => {
    const lists = { extraSensitiveHeaders: Array.from({ length: 100 }, (_, index) => `h${index}`), extraSensitiveQuery: Array.from({ length: 101 }, (_, index) => `q${index}`), extraSensitiveFields: [], extraSensitivePointers: [] };
    // Per-list structural wire constraints cannot express this cross-field sum.
    expect.soft(ProjectionPolicySchema.safeParse({ ...policy, ...lists }).success).toBe(true);
    await expect(projectPublication(documentInput(), { ...policy, ...lists })).rejects.toThrow("PUBLICATION_POLICY_INVALID");
  });
  it("rejects aggregate shared policy excess with a located diagnostic", () => {
    const lists = { extraSensitiveHeaders: Array.from({ length: 100 }, (_, index) => `h${index}`), extraSensitiveQuery: Array.from({ length: 101 }, (_, index) => `q${index}`) };
    expect(validateSharedMock({ sourceProjectRevision: "r1", routes: [] }, { ...shared, ...lists })).toContainEqual(expect.objectContaining({ code: "SHARED_MOCK_POLICY_INVALID", path: "policy.extraSensitive" }));
  });
  it("accepts boundary totals, escaped/root pointers, and 256 Unicode code points", async () => {
    const lists = { extraSensitiveHeaders: Array.from({ length: 100 }, (_, index) => `h${index}`), extraSensitiveQuery: Array.from({ length: 100 }, (_, index) => `q${index}`), extraSensitiveFields: [], extraSensitivePointers: [] };
    expect.soft(validateSharedMock({ sourceProjectRevision: "r1", routes: [] }, { ...shared, ...lists })).toEqual([]);
    expect.soft(ProjectionPolicySchema.safeParse({ ...policy, extraSensitiveFields: ["😀".repeat(256)], extraSensitivePointers: ["", "/a~1b/~0"] }).success).toBe(true);
    expect.soft((await projectPublication(documentInput(), { ...policy, ...lists })).document?.apis).toHaveLength(1);
  });
});
