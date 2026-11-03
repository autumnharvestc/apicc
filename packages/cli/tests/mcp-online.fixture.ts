import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectSnapshot, encodeContractProjectFiles, type ContractProject } from "@apicc/core";
import { loginMcpProfile, type McpProfileDeps } from "../src/mcp/profiles.js";

export const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export async function onlineFixture() {
  const home = mkdtempSync(join(tmpdir(), "apicc-mcp-online-"));
  const project: ContractProject = { id: oid(3), name: "online-project", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, collections: [{ id: oid(4), name: "collection", variables: {}, preOperations: [], postOperations: [], folders: [], apis: [{ contract: { formatVersion: 1, id: oid(5), metadata: { name: "online-api", description: "", tags: [], version: "1", status: "published" }, request: { protocol: "http", method: "GET", baseUrl: "https://business.example", path: "/orders", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "json", content: '{"private":"ONLINE_DEFAULT_BODY"}' } }, responses: [] }, documentation: "online-doc", cases: [{ id: oid(6), name: "online-case", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }] }] }], models: [], components: [], workflows: [], environments: [], stressPolicy: {} };
  project.collections[0]!.apis[0]!.contract.responses = [{ kind: "inline", id: oid(7), status: "200", description: "success", headers: {}, content: {} }];
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: "1", hash: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) }));
  const scope = { workspaceId: "1", groupId: "2", projectId: "3" };
  const assets = { ...scope, format: "contract-files-v1", contractProjectId: project.id, version: "1", manifestHash: "a".repeat(64), files };
  const job = { jobId: "99", executionId: "100", agentId: "5", state: "ended", cancelState: "none", executionReleased: true, reportState: "archived", task: { protocolVersion: 1, jobId: "99", executionId: "100", scope, submittedByUserId: "7", contractProjectId: project.id, snapshotId: "66", manifestHash: "a".repeat(64), target: { kind: "suite", suiteId: oid(9), allowDraft: false }, policyVersion: "0", requiredCoreBuildId: "b".repeat(64), scriptPlanDigest: "c".repeat(64), executionProfile: "no-script", runtimeCompatibilityId: "runtime", dispatchKind: "dedicated-task", requiredCapabilities: [] } };
  const definitionRevision = createProjectSnapshot(project).definitionRevision;
  const report = { executionId: "100", verdict: "passed", output: { kind: "suite", result: { projectId: project.id, definitionRevision, executionIdentity: { projectId: project.id, definitionRevision }, collectionId: oid(4), collectionName: "online report", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 0, passed: 0, failed: 0, cases: [] } } };
  const vault = new Map<string, string>(); const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  let meStatus = 200; let reportStatus = 200; let emptyReport = false;let statusViews:unknown[]=[];
  const deps: McpProfileDeps = { mcpHomeDir: home, mcpEnv: {}, mcpKeyringEntry: (_service, account) => ({ async getPassword() { return vault.get(account); }, async setPassword(value) { vault.set(account, value); }, async deleteCredential() { return vault.delete(account); } }), mcpFetch: async (url, init) => {
    const address = String(url); requests.push({ url: address, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    if (address.endsWith("/auth/login")) return Response.json({ token: "ONLINE_SYNTHETIC_MEMBER", expiresAt: "2099-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "member", role: "USER" } });
    if (address.endsWith("/me")) return Response.json(meStatus === 200 ? { id: "7", username: "member", displayName: "member", role: "USER" } : { code: "unauthorized" }, { status: meStatus });
    if (address.endsWith("/assets")) return Response.json(assets);
    if (address.includes("/projects/3/jobs?")) return Response.json([job]);
    if (address.endsWith("/jobs/99")) return Response.json(statusViews.length?statusViews.length>1?statusViews.shift():statusViews[0]:job);
    if (address.endsWith("/jobs/99/report")) return emptyReport ? new Response(null) : Response.json(reportStatus === 200 ? report : { code: reportStatus===403?'forbidden':"report_expired" }, { status: reportStatus });
    return Response.json({ code: "not_found" }, { status: 404 });
  } };
  await loginMcpProfile({ id: "online-member", server: "https://service.example", username: "member", password: "ONLINE_SYNTHETIC_PASSWORD", scopes: [scope] }, deps);
  return { home, deps, project, assets, job, report, requests, jobViews(...values:unknown[]){statusViews=values;}, meStatus(value: number) { meStatus = value; }, reportStatus(value: number) { reportStatus = value; }, emptyReport() { emptyReport = true; } };
}
