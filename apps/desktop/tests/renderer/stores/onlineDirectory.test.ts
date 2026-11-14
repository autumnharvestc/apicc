// @vitest-environment jsdom
import { computed, shallowRef } from "vue";
import { describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import { useOnlineDirectory } from "../../../src/renderer/src/stores/onlineDirectory.js";
import { ContractProjectSchema } from "@apicc/core/schema";
import type { OnlineExecutionContext, OnlineProjectView } from "../../../src/shared/online/execution.js";
import type { OnlineTreeNodeDTO } from "../../../src/shared/tree-dto.js";

const url = "https://team.test";
const context: OnlineExecutionContext = { serverId: `${url}/api/v1`, ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
const root: OnlineTreeNodeDTO = { source: "online", kind: "project", id: "33", key: "project:33", label: "Shared project", children: [] };
const blank: OnlineProjectView = { assets: { ...context.scope, version: "0", format: null, contractProjectId: null, manifestHash: "a".repeat(64), files: [] }, project: null, problems: [] };

function setup() {
  localStorage.clear();
  const api = createMemoryApi();
  const online = createOnlineStore({ api, storage: localStorage });
  online.user = { id: "7", username: "editor", displayName: "Editor" };
  online.loggedIn = true;
  online.activeBaseUrl = url;
  online.activeWorkspaceId = "11";
  online.sessions["11"] = { workspace: { id: "11", name: "Workspace", myRole: "VIEWER" }, baseUrl: url, ownerId: "7", tree: root,
    projects: [{ id: "33", groupId: "22", name: root.label, myRole: "EDITOR" }], buffers: {}, activeEditorPath: null };
  online.execution.activate(context);
  online.execution.setVisible(true);
  online.execution.acceptDirectoryView(context, blank);
  const active = shallowRef<OnlineExecutionContext | null>(context);
  const selected = vi.fn();
  const createDirectory = () => useOnlineDirectory(online, computed(() => active.value), computed(() => root), selected);
  return { api, online, active, selected, createDirectory };
}

describe("online project directory", () => {
  it("keeps the same draft after a lost connection and leaves the switch target untouched", async () => {
    const { online, active, selected, createDirectory } = setup();
    const directory = createDirectory();
    const write = vi.spyOn(online, "writeDirectory")
      .mockResolvedValueOnce({ result: { status: "unknown" }, refreshed: false, current: true })
      .mockResolvedValueOnce({ result: { status: "unknown", view: blank }, refreshed: false, current: true });
    try {
      directory.start("api", root);
      const created = directory.draft.value!;
      created.name = "First API";
      await directory.save();
      expect(created.pending?.change).toMatchObject({ kind: "create-api", apiId: created.id });
      await directory.save();
      expect(write).toHaveBeenCalledOnce();
      active.value = { ...context, ownerId: "8" };
      expect(directory.draft.value).toBeUndefined();
      expect(directory.writable.value).toBe(false);
      active.value = context;
      expect(directory.draft.value).toBe(created);
      await directory.save(true);
      expect(write.mock.calls[1]?.[0]).toEqual({ ...write.mock.calls[0]?.[0], verifyOnly: true });
      expect(directory.draft.value).toBe(created);
      expect(created.needsTarget).toBe(true);
      expect(selected).not.toHaveBeenCalled();
    } finally { online.execution.setVisible(false); }
  });

  it("retries only tree refresh after a confirmed save and remembers the exact scope", async () => {
    const { online, active, selected, createDirectory } = setup();
    const directory = createDirectory();
    const path = "collections/confirmed";
    const write = vi.spyOn(online, "writeDirectory").mockResolvedValue({ result: { status: "saved", view: blank, path, recovered: false }, refreshed: false, current: true });
    const refresh = vi.spyOn(online, "refreshTreeView").mockResolvedValue(true);
    try {
      directory.updateTree({ filter: "orders", expanded: ["module"], selected: "endpoint" });
      directory.start("collection", root);
      await directory.confirmName("Ordinary module");
      expect(write.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: "0", change: { kind: "create-module", name: "Ordinary module" } });
      expect(directory.error.value).toBe("refresh-failed");
      expect(selected).not.toHaveBeenCalled();
      active.value = { ...context, scope: { ...context.scope, projectId: "34" } };
      expect(directory.tree.value.filter).toBe("");
      expect(directory.error.value).toBe("");
      active.value = context;
      expect(createDirectory().tree.value).toEqual({ filter: "orders", expanded: ["module"], selected: "endpoint" });
      await directory.refreshSaved();
      expect(write).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(selected).toHaveBeenCalledWith(`33/${path}`);
      expect(directory.error.value).toBe("");
    } finally { online.execution.setVisible(false); }
  });

  it.each(["assets", "save", "saveProject"] as const)("retains a confirmed directory version when an earlier %s response arrives late", async operation => {
    const { api, online } = setup();
    const project = ContractProjectSchema.parse({ id: crypto.randomUUID(), name: "Initial version", globals: {} });
    const view = (version: string, name: string): OnlineProjectView => ({ ...blank, project: { ...project, name }, assets: { ...blank.assets, version, contractProjectId: project.id, format: "contract-files-v1" } });
    online.execution.acceptDirectoryView(context, view("1", "Initial version"));
    const stale = view("2", "Old receipt");
    const accepted = view("3", "Directory confirmation");
    let resolveLoad!: (view: OnlineProjectView) => void;
    api.onlineExecution = async input => {
      if (input.operation === operation) return new Promise<OnlineProjectView>(resolve => { resolveLoad = resolve; });
      throw new Error("Unneeded follow-up reads");
    };
    try {
      const pending = operation === "assets" ? online.execution.load() : operation === "saveProject" ? online.execution.saveProject(project) :
        online.execution.save({ expectedVersion: "1", contractProjectId: project.id, format: "contract-files-v1", changes: [], deletes: [] });
      expect(online.execution.acceptDirectoryView(context, accepted)).toBe(true);
      resolveLoad(stale);
      await pending;
      expect(online.execution.view?.assets.version).toBe("3");
      expect(online.execution.project?.name).toBe("Directory confirmation");
      online.execution.project!.name = "Same-version local edit";
      expect(online.execution.acceptDirectoryView(context, accepted)).toBe(true);
      expect(online.execution.project?.name).toBe("Same-version local edit");
    } finally { online.execution.setVisible(false); }
  });
});
