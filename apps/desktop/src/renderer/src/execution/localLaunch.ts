import type { ApiccApi } from "../../../shared/types.js";
import type { ProjectLocator, CollectionLocator } from "../../../shared/locations.js";
import type { useRunStore } from "../stores/run.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { useCasesStore } from "../stores/cases.js";
import type { TestingStore } from "../stores/testing.js";
import type { useWorkflowDesignStore } from "../stores/workflowDesign.js";
import type { createStressStore } from "../stores/stress.js";

export interface LocalLaunchProps {
  api: ApiccApi;
  projectLocator: ProjectLocator | null;
  environmentId: string | null;
  selectedCollectionLocator: CollectionLocator | null;
  workspace: ReturnType<typeof useWorkspaceStore>;
  run: ReturnType<typeof useRunStore>;
  editor: ReturnType<typeof useEditorStore>;
  debug: ReturnType<typeof useDebugStore>;
  cases: ReturnType<typeof useCasesStore>;
  testing: TestingStore;
  workflowDesign: ReturnType<typeof useWorkflowDesignStore>;
  stress: ReturnType<typeof createStressStore>;
  readOnly: boolean;
  reportError: (error: unknown) => void;
}
