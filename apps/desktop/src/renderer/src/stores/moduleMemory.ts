/**
 * Module-local UI memory. Local API-tree state is partitioned by both directory root and full
 * project locator; persisted legacy ID-only selections are deliberately not guessed.
 */
import { createPinia, defineStore } from "pinia";
import { ApiLocatorSchema, CollectionLocatorSchema, FolderLocatorSchema, ProjectLocatorSchema, WorkflowLocatorSchema } from "../../../shared/locations.js";
import type { ApiLocator, ProjectLocator, WorkflowLocator } from "../../../shared/locations.js";
import { projectSessionKey } from "./localIdentity.js";
import type { TestingPane } from "../../../shared/testing.js";
import { z } from "zod";

const DirectorySelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection"), locator: CollectionLocatorSchema }),
  z.object({ kind: z.literal("folder"), locator: FolderLocatorSchema }),
  z.object({ kind: z.literal("api"), locator: ApiLocatorSchema }),
  z.object({ kind: z.literal("workflow"), locator: WorkflowLocatorSchema }),
]);
export type DirectorySelection = z.infer<typeof DirectorySelectionSchema>;
type ApiTreeMemory = { filter: string; expanded: string[]; lastApiLocator: ApiLocator | null; selection: DirectorySelection | null };

const STORAGE_KEY = "apicc.moduleMemory";

interface ScopedMemory {
  root: string;
  projectLocator: ProjectLocator;
  apiTree: ApiTreeMemory;
  test: { apiLocator: ApiLocator | null; workflowLocator: WorkflowLocator | null };
}

interface ModuleMemory {
  apiTree: ApiTreeMemory;
  test: { pane: TestingPane; apiLocator: ApiLocator | null; workflowLocator: WorkflowLocator | null };
  activeScopeKey: string | null;
  scopes: Record<string, ScopedMemory>;
}

function copyProject(locator: ProjectLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function copyApi(locator: ApiLocator | null): ApiLocator | null {
  return locator ? { ...locator, folderIds: [...locator.folderIds] } : null;
}

function emptyTree(): ApiTreeMemory {
  return { filter: "", expanded: [], lastApiLocator: null, selection: null };
}

function copyTree(tree: ApiTreeMemory): ApiTreeMemory {
  return { filter: tree.filter, expanded: [...tree.expanded], lastApiLocator: copyApi(tree.lastApiLocator),
    selection: tree.selection ? DirectorySelectionSchema.parse(tree.selection) : null };
}

function emptyState(): ModuleMemory {
  return {
    apiTree: emptyTree(),
    test: { pane: "api-cases", apiLocator: null, workflowLocator: null },
    activeScopeKey: null,
    scopes: {},
  };
}

function parseStored(): ModuleMemory {
  const state = emptyState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return state;
    const value = parsed as Record<string, unknown>;
    const apiTree = typeof value.apiTree === "object" && value.apiTree !== null ? value.apiTree as Record<string, unknown> : {};
    const test = typeof value.test === "object" && value.test !== null ? value.test as Record<string, unknown> : {};
    state.apiTree.filter = typeof apiTree.filter === "string" ? apiTree.filter : "";
    state.test.pane = test.pane === "scenario" || test.pane === "datasets" || test.pane === "suites" ? test.pane : "api-cases";

    const scopes = typeof value.scopes === "object" && value.scopes !== null ? value.scopes as Record<string, unknown> : {};
    for (const [key, rowValue] of Object.entries(scopes)) {
      if (typeof rowValue !== "object" || rowValue === null) continue;
      const row = rowValue as Record<string, unknown>;
      const project = ProjectLocatorSchema.safeParse(row.projectLocator);
      if (!project.success || typeof row.root !== "string" || projectSessionKey(row.root, project.data) !== key) continue;
      const tree = typeof row.apiTree === "object" && row.apiTree !== null ? row.apiTree as Record<string, unknown> : {};
      const testState = typeof row.test === "object" && row.test !== null ? row.test as Record<string, unknown> : {};
      const lastApi = ApiLocatorSchema.safeParse(tree.lastApiLocator);
      const selection = DirectorySelectionSchema.safeParse(tree.selection);
      const testApi = ApiLocatorSchema.safeParse(testState.apiLocator);
      const workflow = WorkflowLocatorSchema.safeParse(testState.workflowLocator);
      state.scopes[key] = {
        root: row.root,
        projectLocator: copyProject(project.data),
        apiTree: {
          filter: typeof tree.filter === "string" ? tree.filter : "",
          selection: selection.success && projectSessionKey(row.root, selection.data.locator) === key ? selection.data : null,
          expanded: Array.isArray(tree.expanded) ? tree.expanded.filter((entry): entry is string => typeof entry === "string") : [],
          lastApiLocator: lastApi.success && lastApi.data.workspaceId === project.data.workspaceId
            && lastApi.data.groupId === project.data.groupId && lastApi.data.projectId === project.data.projectId
            ? copyApi(lastApi.data) : null,
        },
        test: {
          apiLocator: testApi.success && testApi.data.workspaceId === project.data.workspaceId
            && testApi.data.groupId === project.data.groupId && testApi.data.projectId === project.data.projectId
            ? copyApi(testApi.data) : null,
          workflowLocator: workflow.success && workflow.data.workspaceId === project.data.workspaceId
            && workflow.data.groupId === project.data.groupId && workflow.data.projectId === project.data.projectId
            ? { ...workflow.data } : null,
        },
      };
    }
  } catch {
    // Invalid or inaccessible storage is equivalent to no remembered module state.
  }
  return state;
}

export function useModuleMemoryStore() {
  return defineStore("moduleMemory", {
    state: (): ModuleMemory => parseStored(),
    actions: {
      activateProject(root: string, locator: ProjectLocator | null): void {
        const previousKey = this.activeScopeKey;
        if (previousKey) {
          const previous = this.scopes[previousKey];
          if (previous) this.scopes[previousKey] = {
            ...previous,
            apiTree: copyTree(this.apiTree),
            test: {
              apiLocator: copyApi(this.test.apiLocator),
              workflowLocator: this.test.workflowLocator ? { ...this.test.workflowLocator } : null,
            },
          };
        }
        if (!locator || !root) {
          this.activeScopeKey = null;
          this.apiTree = emptyTree();
          this.test.apiLocator = null;
          this.test.workflowLocator = null;
          return;
        }
        const projectLocator = copyProject(locator);
        const key = projectSessionKey(root, projectLocator);
        const scope = this.scopes[key];
        this.activeScopeKey = key;
        this.apiTree = scope ? copyTree(scope.apiTree) : emptyTree();
        this.test.apiLocator = scope ? copyApi(scope.test.apiLocator) : null;
        this.test.workflowLocator = scope?.test.workflowLocator ? { ...scope.test.workflowLocator } : null;
        if (!scope) this.scopes[key] = { root, projectLocator, apiTree: emptyTree(), test: { apiLocator: null, workflowLocator: null } };
        this.touch();
      },

      touch(): void {
        if (this.activeScopeKey) {
          const previous = this.scopes[this.activeScopeKey];
          if (previous) this.scopes[this.activeScopeKey] = {
            ...previous,
            apiTree: copyTree(this.apiTree),
            test: {
              apiLocator: copyApi(this.test.apiLocator),
              workflowLocator: this.test.workflowLocator ? { ...this.test.workflowLocator } : null,
            },
          };
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
      },

      rememberDirectorySelection(root: string, node: unknown): void {
        const selection = DirectorySelectionSchema.safeParse(node);
        if (!selection.success || projectSessionKey(root, selection.data.locator) !== this.activeScopeKey) return;
        this.apiTree.selection = selection.data;
        if (selection.data.kind === "api") this.apiTree.lastApiLocator = copyApi(selection.data.locator);
        this.touch();
      },
    },
  })(createPinia());
}
