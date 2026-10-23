import { mkdtempSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { StressPlanSchema } from "@apicc/core";
import { createStressPlanRepository } from "../../src/main/stressPlans.js";
import { IDS } from "./helpers/contract-assets.js";
const scope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: IDS.workflow }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } });
const fault = vi.hoisted(() => ({ replace: false }));
vi.mock("node:fs", async (original) => { const fs = await original<typeof import("node:fs")>(); return { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => { if (fault.replace) throw new Error("interrupted replace"); return fs.renameSync(...args); } }; });
describe("project stress plan repository", () => {
  // Returning a synthetic success or hashing projectId alone breaks real reopen/isolation.
  it("reopens saved plans and isolates full scope and actual root", () => {
    const root = mkdtempSync(join(tmpdir(), "f6-plans-")), repository = createStressPlanRepository(root);
    const saved = repository.save(scope, { name: "nightly", plan }); expect(saved).toMatchObject({ name: "nightly", plan });
    expect(createStressPlanRepository(root).get(scope, saved!.id)).toEqual(saved);
    expect(repository.list({ ...scope, groupId: IDS.groupTwo })).toEqual([]);
    expect(createStressPlanRepository(mkdtempSync(join(tmpdir(), "f6-plans-"))).list(scope)).toEqual([]);
    expect(repository.remove(scope, saved!.id)).toEqual(saved); expect(repository.get(scope, saved!.id)).toBeNull();
  });
  it("rejects path IDs and runtime fields, preserving old content when replacement cannot finish", () => {
    const root = mkdtempSync(join(tmpdir(), "f6-plans-")), repository = createStressPlanRepository(root);
    const saved = repository.save(scope, { name: "old", plan }); expect(saved).not.toBeNull();
    expect(() => repository.get(scope, "../bad")).toThrow();
    expect(() => repository.save(scope, { name: "bad", plan: { ...plan, confirmedTargetOrigins: ["https://example.com"] } as typeof plan })).toThrow();
    const dir = join(root, ".apicc", "stress-plans", readdirSync(join(root, ".apicc", "stress-plans"))[0]!);
    // The old file stays readable after an abandoned write and its random temp cannot become a plan.
    mkdirSync(join(dir, "abandoned.tmp"));
    fault.replace = true;
    try { expect(() => repository.save(scope, { id: saved!.id, name: "replacement", plan })).toThrow("interrupted replace"); }
    finally { fault.replace = false; }
    expect(repository.list(scope)).toEqual([saved]);
    expect(JSON.parse(readFileSync(join(dir, `${saved!.id}.json`), "utf8"))).toEqual(saved);
  });
});
