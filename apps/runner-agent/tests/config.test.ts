import { expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeploymentSchema, initialLedgerCompaction, type AgentDeployment } from "../src/config.js";
const deployment: AgentDeployment = { baseUrl: "https://control.test/api/v1", agentId: "7", tokenFile: join(tmpdir(), "agent-token"), dataDirectory: join(tmpdir(), "agent-data") };

it("accepts local ledger compaction without changing legacy deployment requirements", () => {
  expect(DeploymentSchema.safeParse(deployment).success).toBe(true);
  const parsed = DeploymentSchema.safeParse({ ...deployment, ledgerCompaction: { enabled: true, batchSize: 50 } });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toMatchObject({ ledgerCompaction: { enabled: true, batchSize: 50 } });
});

it("defaults omitted local options and accepts the inclusive configured boundaries", () => {
  expect(initialLedgerCompaction(deployment)).toEqual({ enabled: true, batchSize: 50 });
  expect(DeploymentSchema.parse({ ...deployment, ledgerCompaction: {} }).ledgerCompaction).toEqual({ enabled: true, batchSize: 50 });
  for (const batchSize of [1, 1000]) expect(DeploymentSchema.parse({ ...deployment, ledgerCompaction: { enabled: false, batchSize } }).ledgerCompaction).toEqual({ enabled: false, batchSize });
  expect(DeploymentSchema.parse({ ...deployment, ledgerCompaction: { enabled: false } }).ledgerCompaction).toEqual({ enabled: false, batchSize: 50 });
});

it.each([0, 1001, -1, 1.5, "50", null, Infinity, NaN])("rejects invalid ledger batchSize %s", batchSize => {
  expect(DeploymentSchema.safeParse({ ...deployment, ledgerCompaction: { enabled: true, batchSize } }).success).toBe(false);
});
it.each(["true", 1, null])("rejects invalid compaction enabled value %s", enabled => {
  expect(DeploymentSchema.safeParse({ ...deployment, ledgerCompaction: { enabled, batchSize: 50 } }).success).toBe(false);
});
it("keeps local compaction outside remote bootstrap AgentConfig and rejects unknown maintenance fields", () => {
  expect(DeploymentSchema.safeParse({ ...deployment, ledgerCompaction: { enabled: true, batchSize: 50, intervalMs: 1 } }).success).toBe(false);
  expect(DeploymentSchema.safeParse({ ...deployment, bootstrapConfig: { ledgerCompaction: { enabled: true, batchSize: 50 } } }).success).toBe(false);
});
