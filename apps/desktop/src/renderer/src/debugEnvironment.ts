import { apiSessionKey } from "./stores/localIdentity.js";
import type { useDebugStore } from "./stores/debug.js";
import type { useEditorStore } from "./stores/editor.js";
import type { RequestTab } from "./stores/requestTabs.js";

export interface DebugEnvironmentSelection {
  owner: string;
  value: string | null;
  options: { key: string; name: string }[];
  select(value: string | null): void;
}

export function debugEnvironmentSelection(
  editor: ReturnType<typeof useEditorStore>,
  debug: ReturnType<typeof useDebugStore>,
  tab: RequestTab | null | undefined,
): DebugEnvironmentSelection | null {
  if (tab) {
    let session;
    if (tab.source.kind === "free") {
      const active = editor.activeFreeId === tab.tabId ? editor.freeSessions[tab.tabId] : undefined;
      if (active?.draftId === tab.source.draftId && active.project.workspaceId === tab.project.workspaceId
          && active.project.groupId === tab.project.groupId && active.project.projectId === tab.project.projectId) session = active;
    } else {
      const key = apiSessionKey(tab.root, tab.source.locator);
      if (key && editor.activeKey === key) session = editor.sessions[key];
    }
    if (!session || session.root !== tab.root) return null;
    const state = debug.requestTabState(tab);
    return {
      owner: JSON.stringify([tab.root, tab.project, tab.tabId, tab.generation, session.generation]),
      value: state.selectedEnvironmentId,
      options: session.envs.map((env) => ({ key: env.id, name: env.name })),
      select: (value) => {
        state.selectedEnvironmentId = value;
        if (state.error === "debug-environment-unavailable") state.error = null;
      },
    };
  }
  const key = editor.activeKey;
  const session = key ? editor.sessions[key] : undefined;
  if (!session || editor.activeFreeId !== null) return null;
  return {
    owner: JSON.stringify([key, session.generation]),
    value: debug.selectedEnvName,
    options: [...new Set(session.envs.map((env) => env.name))].map((name) => ({ key: name, name })),
    select: (value) => {
      debug.selectEnv(value);
      if (debug.error === "debug-environment-unavailable") debug.error = null;
    },
  };
}
