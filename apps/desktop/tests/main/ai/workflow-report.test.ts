import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultRegistry, type RunResult, type WorkflowRunResult } from "@apicc/core";
import { createWorkflowController } from "../../../src/main/workflow.js";
import { createSession, type DraftWriteContext } from "../../../src/main/session.js";
import { createCredentialHost } from "../../../src/main/credentialHost.js";
import { IDS, makeWorkspace, persistWorkspace } from "../helpers/contract-assets.js";
import type { ProjectLocator } from "../../../src/shared/locations.js";
it("awaits trusted native/public workflow registration without changing verdict or repeating execution when registration fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t9-workflow-report-")), session = createSession();
  try {
    const workspace = makeWorkspace(), project = workspace.groups[0]!.projects[0]!;
    project.workflows = [{ id: IDS.workflow, name: "no external request", status: "enabled", nodes: [{ id: "noop", kind: "noop" }], edges: [] }];
    await persistWorkspace(root, workspace); await session.open(root);
    const credentials = createCredentialHost(session, () => ({ put: async () => {}, remove: async () => {}, resolve: async () => "", version: async () => "", status: async () => "available" }));
    const owner = {}; let calls = 0, persists = 0, delivered = false, persistedReport: RunResult | undefined;
    let captured: { owner: object | undefined; context: DraftWriteContext; scope: ProjectLocator; native: RunResult; dto: WorkflowRunResult; delivered: boolean } | undefined;
    type ReportCallback = (owner: object | undefined, context: DraftWriteContext, project: ProjectLocator, native: RunResult, dto: WorkflowRunResult) => Promise<void>;
    const factory = createWorkflowController as typeof createWorkflowController & ((...args: [...Parameters<typeof createWorkflowController>, ReportCallback]) => ReturnType<typeof createWorkflowController>);
    const controller = factory(session, async () => createDefaultRegistry(), credentials, { persist(_path, native) { persists++; persistedReport = structuredClone(native); return {}; } }, async (actualOwner, context, scope, native, dto) => {
      calls++; captured = { owner: actualOwner, context, scope, native, dto, delivered };
      await Promise.resolve(); throw new Error("AI registration deliberately unavailable");
    });
    const result = await controller.run({ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: project.id, workflowId: IDS.workflow }, root }, owner); delivered = true;
    expect(result.verdict).toBe("passed"); expect(calls).toBe(1); expect(persists).toBe(1);
    expect(captured?.delivered).toBe(false); expect(captured?.owner).toBe(owner); expect(captured?.context.root).toBe(root); expect(captured?.scope.projectId).toBe(project.id);
    expect(captured?.native).toEqual(persistedReport); expect(captured?.native.workflow?.verdict).toBe("passed"); expect(captured?.native.total).toBe(0); expect(captured?.dto).toBe(result); expect(result.report).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
