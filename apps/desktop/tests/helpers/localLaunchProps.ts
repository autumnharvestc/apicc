import type { ApiccApi } from "../../src/shared/types.js";
import type { ProjectLocator } from "../../src/shared/locations.js";
import { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../src/renderer/src/stores/debug.js";
import { useCasesStore } from "../../src/renderer/src/stores/cases.js";
import { createTestingStore } from "../../src/renderer/src/stores/testing.js";
import { createStressStore } from "../../src/renderer/src/stores/stress.js";
import { useWorkflowDesignStore } from "../../src/renderer/src/stores/workflowDesign.js";

export function localLaunchProps(api: ApiccApi, workspace: ReturnType<typeof useWorkspaceStore>, project?: ProjectLocator) {
  const node = workspace.workspace!.groups.flatMap(group => group.projects.map(item => ({group, item})))[0]!;
  const projectLocator = project ? { workspaceId: project.workspaceId, groupId: project.groupId, projectId: project.projectId }
    : { workspaceId: workspace.workspace!.id, groupId: node.group.id, projectId: node.item.id };
  const context = () => ({ root: workspace.root, readOnly: workspace.readOnly });
  const editor = useEditorStore(api, context);
  return { api, projectLocator, environmentId: null, readOnly: workspace.readOnly, editor, debug: useDebugStore(api, editor, context),
    cases: useCasesStore(api, editor), testing: createTestingStore(api, {confirmDiscard: () => false}),
    workflowDesign: useWorkflowDesignStore(api, context), stress: createStressStore({api, getContext: () => ({root: workspace.root, projectLocator, locator: null})}) };
}
