import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultRegistry, type RunResult, type WorkflowRunResult } from "@apicc/core";
import { createWorkflowController } from "../../../src/main/workflow.js";
import { createSession, type DraftWriteContext } from "../../../src/main/session.js";
import { createCredentialHost } from "../../../src/main/credentialHost.js";
import { readScopedRun } from "../../../src/main/runs.js";
import { IDS, makeWorkspace, persistWorkspace } from "../helpers/contract-assets.js";
import type { ProjectLocator } from "../../../src/shared/locations.js";
it.each(["injected", "disk"] as const)("awaits trusted native/public workflow registration without changing verdict or repeating execution when registration fails (%s storage)", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t9-workflow-report-")), session = createSession();
  try {
    const workspace = makeWorkspace(), project = workspace.groups[0]!.projects[0]!;
    project.workflows = [{ id: IDS.workflow, name: "no external request", status: "enabled", nodes: [{ id: "noop", kind: "noop" }], edges: [] }];
    await persistWorkspace(root, workspace); await session.open(root);
    const credentials = createCredentialHost(session, () => ({ put: async () => {}, remove: async () => {}, resolve: async () => "", version: async () => "", status: async () => "available" }));
    const owner = {}; let calls = 0, persists = 0, delivered = false, persistedReport: RunResult | undefined;
    let captured: { owner: object | undefined; context: DraftWriteContext; scope: ProjectLocator; native: RunResult; dto: WorkflowRunResult; delivered: boolean } | undefined;
    const scope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: project.id };
    const controller = createWorkflowController(session, async () => createDefaultRegistry(), credentials, mode === "disk" ? undefined : {
      persist(_path, native, archiveProject) {
        expect(archiveProject).toEqual(scope);
        persists++; persistedReport = structuredClone(native);
        return {};
      },
    }, async (actualOwner, context, scope, native, dto) => {
      calls++; captured = { owner: actualOwner, context, scope, native, dto, delivered };
      await Promise.resolve(); throw new Error("AI registration deliberately unavailable");
    });
    const result = await controller.run({ locator: { ...scope, workflowId: IDS.workflow }, root }, owner); delivered = true;
    if (mode === "disk") persistedReport = readScopedRun(root, scope, result.archiveFile!, 100_000);
    else expect(persists).toBe(1);
    expect(result.verdict).toBe("passed"); expect(calls).toBe(1);
    expect(captured?.delivered).toBe(false); expect(captured?.owner).toBe(owner); expect(captured?.context.root).toBe(root); expect(captured?.scope.projectId).toBe(project.id);
    expect(captured?.native).toEqual(persistedReport); expect(captured?.native.workflow?.verdict).toBe("passed"); expect(captured?.native.total).toBe(0); expect(captured?.dto).toBe(result); expect(result.report).toBeUndefined();
    expect(captured?.native).not.toHaveProperty("archiveProject");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
