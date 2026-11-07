import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AgentConfigSchema, EntityIdSchema, defaultAgentConfig } from "@apicc/execution/contract";
export function canonicalControlBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/api/v1") throw new Error("Agent control base URL must be canonical HTTPS /api/v1");
  return url.href.replace(/\/$/, "");
}
const path = z.string().refine(isAbsolute, "Expected an absolute deployment path");
export const LedgerCompactionSchema = z.object({ enabled: z.boolean().default(true), batchSize: z.number().int().min(1).max(1000).default(50) }).strict();
export type LedgerCompactionOptions = z.infer<typeof LedgerCompactionSchema>;
export const DeploymentSchema = z.object({ baseUrl: z.string().transform(canonicalControlBaseUrl), agentId: EntityIdSchema, tokenFile: path, dataDirectory: path, trustedCaFile: path.optional(), bootstrapConfig: AgentConfigSchema.optional(), ledgerCompaction: LedgerCompactionSchema.optional() }).strict();
export type AgentDeployment = z.infer<typeof DeploymentSchema>;
export async function loadDeployment(path: string): Promise<AgentDeployment> { return DeploymentSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
export function initialAgentConfig(deployment: AgentDeployment) { return AgentConfigSchema.parse(deployment.bootstrapConfig ?? defaultAgentConfig); }
export function initialLedgerCompaction(deployment: AgentDeployment): LedgerCompactionOptions { return LedgerCompactionSchema.parse(deployment.ledgerCompaction ?? {}); }
