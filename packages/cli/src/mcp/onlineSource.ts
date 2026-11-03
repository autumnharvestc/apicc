import type { McpSource, McpProjectRead, McpRun } from "./source.js";
import { openMcpProfile, type McpProfileDeps } from "./profiles.js";
import { createMemberExecutionClient, createMemberExecutionRequest, FullOnlineJobSchema, isFullOnlineJob, type OnlineJob } from "@apicc/execution/client";
import { aiPersonalProjectKey, createProjectSnapshot, assertAiReportOwnership, type AiReadableReport } from "@apicc/core";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson, pageLimit, createPager } from "./pagination.js";
import { ownedReport } from "./reports.js";
import { registerExecutionCapability, ownedRunReadersFor } from "./executionCapabilities.js";

export async function createOnlineSource(profileId: string, deps: McpProfileDeps): Promise<McpSource> {
  const opened = await openMcpProfile(profileId, deps);
  const member = createMemberExecutionClient({ session: opened.session, fetch: opened.fetch });
  let closed = false;
  const authenticate = async (signal: AbortSignal) => {
    if (closed) throw new Error("MCP source closed；请重新连接");
    await opened.authenticate(signal);
  };
  const bindingId = randomUUID();
  const serverIdentity = createHash("sha256").update(opened.profile.server).digest("hex");
  const references = new Map<string, { projectId: string; jobId: string; executionId: string; agentId: string }>();
  const aliases = new Map<string, string>();
  const ownedPager = createPager();
  const cursors = new Map<string, { key: string; before?: string; ownedCursor?: string; phase: "owned" | "remote" }>();
  const contextFor = (projectId: string) => {
    const scope = opened.profile.scopes.find(scope => scope.projectId === projectId);
    if (!scope) throw new Error("MCP project scope 不在 profile allowlist");
    return { serverId: `${opened.profile.server}/api/v1`, ownerId: opened.profile.memberId, scope };
  };
  const runView = (job: OnlineJob, projectId: string): McpRun => {
    const runId = `report:${createHash("sha256").update(`${opened.profile.generation}:${serverIdentity}:${opened.profile.memberId}:${projectId}:${job.jobId}:${job.executionId}`).digest("hex")}`;
    if (references.size >= 1000 && !references.has(runId)) {
      const oldest = references.keys().next().value!; references.delete(oldest);
      for (const [alias, id] of aliases) if (id === oldest) aliases.delete(alias);
    }
    references.set(runId, { projectId, jobId: job.jobId, executionId: job.executionId, agentId: job.agentId });
    return { runId, projectId, state: job.state, ...(isFullOnlineJob(job) ? { reportState: job.reportState } : { view: job.view }) };
  };
  const resolve = async (runId: string, signal: AbortSignal) => {
    await authenticate(signal);
    const reference = references.get(aliases.get(runId) ?? runId);
    if (!reference) throw new Error("MCP report unavailable；请先 list-runs 选择 opaque ID");
    const context = contextFor(reference.projectId);
    const job = await member.status(context, { kind: "agent", agentId: reference.agentId }, reference.jobId, signal) as OnlineJob;
    if (job.jobId !== reference.jobId || job.executionId !== reference.executionId || isFullOnlineJob(job) && (job.task.jobId !== reference.jobId || job.task.executionId !== reference.executionId)) throw new Error("MCP report-execution-binding-mismatch；来源已改变");
    return { reference, context, job };
  };
  const source: McpSource = {
    identity: Object.freeze({ kind: "online", bindingId, serverIdentity, memberIdentity: opened.profile.memberId }),
    async projects(signal) {
      await authenticate(signal);
      return opened.profile.scopes.map(scope => ({ ...scope, name: scope.projectId }));
    },
    async readProject(projectId, signal) {
      await authenticate(signal);
      const context = contextFor(projectId); const scope = context.scope;
      const view = await member.assets(context, signal);
      if (!view.project) throw new Error("MCP online assets unreadable；请检查项目格式，读取不会创建快照");
      const snapshot = createProjectSnapshot(view.project);
      return { snapshot, revision: `${view.assets.version}:${snapshot.definitionRevision}`, preferenceKey: aiPersonalProjectKey({ kind: "online", serverUrl: opened.profile.server, memberId: opened.profile.memberId, ...scope }), ...scope,
        binding: { kind: "online", bindingId, serverIdentity, memberIdentity: opened.profile.memberId, workspaceId: scope.workspaceId, groupId: scope.groupId, serverProjectId: scope.projectId, projectVersion: view.assets.version, projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 } };
    },
    async listRuns(projectId, page, signal) {
      const limit = pageLimit(page); const project = await source.readProject(projectId, signal); const context = contextFor(projectId);
      const owned = ownedRunReadersFor(source);
      const key = `${bindingId}:${projectId}:${project.revision}:${owned.map(reader => reader.revision()).join(":")}:runs:${limit}`;
      const cursor = page.cursor ? cursors.get(page.cursor) : undefined;
      if (page.cursor && (!cursor || cursor.key !== key)) throw new Error("MCP cursor 已失效；请重新从首页读取");
      const result: { items: McpRun[]; nextCursor?: string } = { items: [] };
      const next = (record: Omit<NonNullable<typeof cursor>, "key">) => {
        if (cursors.size >= 1000) cursors.delete(cursors.keys().next().value!);
        result.nextCursor = `cursor:${randomUUID()}`; cursors.set(result.nextCursor, { key, ...record });
      };
      if (!cursor || cursor.phase === "owned") {
        const local = ownedPager.page(owned.flatMap(reader => reader.list(projectId)), { limit, cursor: cursor?.ownedCursor }, key);
        result.items.push(...local.items);
        if (local.nextCursor) { next({ phase: "owned", ownedCursor: local.nextCursor }); return result; }
        if (result.items.length === limit) { next({ phase: "remote" }); return result; }
      }
      const remaining = limit - result.items.length;
      const request = createMemberExecutionRequest(opened.session.captureExecution(context), opened.fetch, signal);
      const jobs = await request("GET", `workspaces/${context.scope.workspaceId}/projects/${projectId}/jobs?limit=${remaining}${cursor?.before ? `&beforeJobId=${cursor.before}` : ""}`, undefined, z.array(FullOnlineJobSchema).max(remaining));
      if (jobs.some(job => job.task.scope.workspaceId !== context.scope.workspaceId || job.task.scope.groupId !== context.scope.groupId || job.task.scope.projectId !== context.scope.projectId)) throw new Error("MCP online-job-scope-mismatch");
      result.items.push(...jobs.map(job => runView(job, projectId)));
      if (jobs.length === remaining) next({ phase: "remote", before: jobs.at(-1)!.jobId });
      return result;
    },
    async getRun(runId, signal) {
      for (const reader of ownedRunReadersFor(source)) {
        const run = reader.get(runId); if (run) { await source.readProject(run.projectId, signal); return run; }
      }
      const { job, reference } = await resolve(runId, signal); return runView(job, reference.projectId);
    },
    async getReport(runId, _selection, signal) {
      for (const reader of ownedRunReadersFor(source)) {
        const run = reader.get(runId); if (run) return reader.report(runId, await source.readProject(run.projectId, signal), signal);
      }
      const { reference, context, job } = await resolve(runId, signal);
      if (isFullOnlineJob(job) && job.reportState !== "archived") throw new Error(job.reportState === "expired" ? "MCP report-expired：报告已到期/清理" : "MCP report-not-archived：报告尚未归档");
      const result = await member.report(context, { kind: "agent", agentId: reference.agentId }, reference.jobId, signal);
      if (!isFullOnlineJob(job)) throw new Error("MCP report-binding-unavailable；请刷新后重新读取报告，不会重跑");
      const output = result.output;
      if (!output || output.kind === "stress-failure") throw new Error("MCP report-unreadable：没有可读的归档报告；不会重跑");
      const project = await source.readProject(reference.projectId, signal);
      if (job.task.contractProjectId !== project.snapshot.project.id) throw new Error("MCP report-project-scope-mismatch");
      let report: AiReadableReport | undefined;
      if (output.kind === "debug") {
        assertAiReportOwnership(output.result, project.snapshot.project.id); report = output.result;
      } else {
        const value = output.kind === "workflow" ? output.result.report : output.result;
        if (!value) throw new Error("MCP report-unreadable：工作流报告未采集（not-collected）；不会重跑");
        if (value.projectId !== job.task.contractProjectId) throw new Error("MCP report-project-scope-mismatch");
        report = ownedReport(value, project.snapshot.project.id);
      }
      if (!report) throw new Error("MCP report-unowned：报告定义或执行归属不明，不可读取");
      return { reportId: runId, revision: createHash("sha256").update(boundedJson(report, 64 * 1024 * 1024)).digest("hex"), report, project };
    },
    async close() { closed = true; cursors.clear(); ownedPager.clear(); references.clear(); aliases.clear(); await member.close(); },
  };
  registerExecutionCapability(source, { kind: "online", generation: opened.profile.generation, authenticate, isInvalid: () => closed || opened.isInvalid(), contextFor, member,
    rememberAgentJob(projectId, job) { aliases.set(job.jobId, runView(job, projectId).runId); } });
  return source;
}
