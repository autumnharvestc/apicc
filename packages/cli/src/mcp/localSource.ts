import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { aiPersonalProjectKey, createDefaultRegistry, createProjectSnapshot, type PluginRegistry } from "@apicc/core";
import { assertWorkspaceUsable, loadWorkspace } from "../workspace.js";
import type { McpSource } from "./source.js";
import { readLocalAiReports, readLocalReportArchive } from "./reports.js";
import { createPager } from "./pagination.js";
import { registerExecutionCapability, ownedRunReadersFor } from "./executionCapabilities.js";

export async function createLocalSource(root: string, registry: PluginRegistry = createDefaultRegistry()): Promise<McpSource> {
  const canonicalRoot = realpathSync(root);
  const rootIdentity = createHash("sha256").update(canonicalRoot).digest("hex");
  const bindingId = randomUUID();
  let closed = false;
  const pager = createPager();
  const load = async (signal: AbortSignal) => {
    if (closed) throw new Error("MCP source closed；请重新连接");
    signal.throwIfAborted();
    const state = await loadWorkspace(registry, canonicalRoot); assertWorkspaceUsable(state);
    signal.throwIfAborted(); return state;
  };
  await load(new AbortController().signal);
  const source: McpSource = {
    identity: Object.freeze({ kind: "local", bindingId, rootIdentity }),
    async projects(signal) {
      const state = await load(signal);
      return state.workspace.groups.flatMap(group => group.projects.map(project => ({ projectId: project.id, name: project.name, workspaceId: state.workspace.id, groupId: group.id })));
    },
    async readProject(projectId, signal) {
      const state = await load(signal);
      for (const group of state.workspace.groups) {
        const project = group.projects.find(project => project.id === projectId);
        if (!project) continue;
        const snapshot = createProjectSnapshot(project);
        return { snapshot, revision: snapshot.definitionRevision, preferenceKey: aiPersonalProjectKey({ kind: "local", root: canonicalRoot, workspaceId: state.workspace.id, groupId: group.id, projectId: project.id }), projectId: project.id, workspaceId: state.workspace.id, groupId: group.id,
          binding: { kind: "local", bindingId, rootIdentity, projectId: project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 } };
      }
      throw new Error("MCP project unavailable");
    },
    async listRuns(projectId, page, signal) {
      const project = await source.readProject(projectId, signal);
      const archive = readLocalReportArchive(canonicalRoot, projectId); const reports = archive.items;
      const archiveRevision = archive.revision;
      const owned = ownedRunReadersFor(source);
      const items = [...owned.flatMap(reader => reader.list(projectId)), ...reports.map(({ reportId, report }) => ({ runId: reportId, projectId, state: "ended", reportState: "archived", startedAt: report.startedAt, finishedAt: report.finishedAt, definitionRevision: report.definitionRevision }))];
      return { ...pager.page(items, page, `${bindingId}:${projectId}:${project.revision}:${archiveRevision}:${owned.map(reader => reader.revision()).join(":")}:runs`), diagnostics: archive.diagnostics };
    },
    async getRun(runId, signal) {
      for (const reader of ownedRunReadersFor(source)) {
        const run = reader.get(runId);
        if (run) { await source.readProject(run.projectId, signal); return run; }
      }
      const read = await source.getReport(runId, {}, signal);
      if (!read.report) throw new Error("MCP report-unreadable");
      return { runId, projectId: read.project.projectId, state: "ended", reportState: "archived", startedAt: read.report.startedAt, finishedAt: read.report.finishedAt, definitionRevision: "sourceProjectRevision" in read.report ? read.report.sourceProjectRevision : read.report.definitionRevision };
    },
    async getReport(runId, _selection, signal) {
      for (const reader of ownedRunReadersFor(source)) {
        const run = reader.get(runId);
        if (run) return reader.report(runId, await source.readProject(run.projectId, signal), signal);
      }
      for (const project of await source.projects(signal)) {
        const selected = readLocalAiReports(canonicalRoot, project.projectId).find(report => report.reportId === runId);
        if (selected) return { reportId: runId, revision: selected.revision, report: selected.report, project: await source.readProject(project.projectId, signal) };
      }
      throw new Error("MCP report unavailable；仅接受归属可靠的 opaque 报告 ID");
    },
    async close() { closed = true; pager.clear(); },
  };
  registerExecutionCapability(source, { kind: "local", root: canonicalRoot, async authenticate(signal) { await load(signal); }, isInvalid: () => closed });
  return source;
}
