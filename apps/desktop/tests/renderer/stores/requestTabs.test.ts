// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";
import { createRequestTabsStore } from "../../../src/renderer/src/stores/requestTabs.js";

const PROJECT: ProjectLocator = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  groupId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000003",
};
const API_A: ApiLocator = {
  ...PROJECT,
  collectionId: "10000000-0000-4000-8000-000000000004",
  folderIds: [],
  apiId: "10000000-0000-4000-8000-000000000005",
};
const API_B: ApiLocator = { ...API_A, apiId: "10000000-0000-4000-8000-000000000006" };

type RequestTabsFactory = (deps: {
  getContext: () => { root: string; project: ProjectLocator | null };
  isDirty: (tabId: string) => boolean;
  isRunning: (tabId: string) => boolean;
  confirmClose: (tabId: string, state: { dirty: boolean; running: boolean }) => Promise<boolean>;
  confirmCloseMany?: (tabs: unknown[], state: { dirty: boolean; running: boolean }) => Promise<boolean>;
  cancelRun: (tabId: string) => Promise<void>;
  evict: (tabId: string) => void;
}) => {
  tabs: Record<string, { tabId: string; root: string; generation: number; project: ProjectLocator; source: unknown }>;
  order: string[];
  activeId: string | null;
  open(source: { kind: "asset"; locator: ApiLocator } | { kind: "free"; project: ProjectLocator; draftId: string }): string;
  activate(tabId: string): boolean;
  close(tabId: string): Promise<boolean>;
  closeProject(root: string, project: ProjectLocator): Promise<boolean>;
  canConvertFreeToAsset(tabId: string, expected: { root: string; generation: number; project: ProjectLocator; draftId: string }, locator: ApiLocator): boolean;
  convertFreeToAsset(tabId: string, expected: { root: string; generation: number; project: ProjectLocator; draftId: string }, locator: ApiLocator): boolean;
  commitFreeToAsset(tabId: string, locator: ApiLocator): { root: string; generation: number; source: { kind: string; locator?: ApiLocator } };
};

function factory(): RequestTabsFactory { return createRequestTabsStore as RequestTabsFactory; }

describe("request tab registry", () => {
  it.each([
    {
      name: "deduplicates an asset by its complete API locator",
      sources: [
        { kind: "asset" as const, locator: API_A },
        { kind: "asset" as const, locator: { ...API_A, folderIds: [] } },
      ],
      expectedCount: 1,
    },
    {
      name: "keeps free drafts with different IDs separate in the same project",
      sources: [
        { kind: "free" as const, project: PROJECT, draftId: "free-1" },
        { kind: "free" as const, project: PROJECT, draftId: "free-2" },
      ],
      expectedCount: 2,
    },
    {
      name: "keeps different formal APIs separate",
      sources: [
        { kind: "asset" as const, locator: API_A },
        { kind: "asset" as const, locator: API_B },
      ],
      expectedCount: 2,
    },
  ])("$name", ({ sources, expectedCount }) => {
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: () => false,
      isRunning: () => false,
      confirmClose: vi.fn(async () => true),
      cancelRun: vi.fn(async () => undefined),
      evict: vi.fn(),
    });

    const ids = sources.map((source) => tabs.open(source));
    if (sources[0]?.kind === "asset" && sources[1]?.kind === "asset"
      && JSON.stringify(sources[0].locator) === JSON.stringify(sources[1].locator)) {
      expect(ids[1]).toBe(ids[0]);
    }
    expect(tabs.order).toHaveLength(expectedCount);
    expect(new Set(ids).size).toBe(expectedCount);
  });

  it("keeps each tab record intact when switching between them", () => {
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: () => false,
      isRunning: () => false,
      confirmClose: vi.fn(async () => true),
      cancelRun: vi.fn(async () => undefined),
      evict: vi.fn(),
    });
    const a = tabs.open({ kind: "asset", locator: API_A });
    const b = tabs.open({ kind: "free", project: PROJECT, draftId: "free-1" });
    const recordA = tabs.tabs[a];
    const recordB = tabs.tabs[b];

    expect(tabs.activate(a)).toBe(true);
    expect(tabs.activate(b)).toBe(true);
    expect(tabs.tabs[a]).toBe(recordA);
    expect(tabs.tabs[b]).toBe(recordB);
    expect(tabs.activeId).toBe(b);
  });

  it("converts only the captured free request tab into its same-project asset identity", () => {
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: () => false,
      isRunning: () => false,
      confirmClose: vi.fn(async () => true),
      cancelRun: vi.fn(async () => undefined),
      evict: vi.fn(),
    });
    const first = tabs.open({ kind: "free", project: PROJECT, draftId: "free-1" });
    const second = tabs.open({ kind: "free", project: PROJECT, draftId: "free-2" });
    tabs.activate(first);
    const firstBefore = tabs.tabs[first] as { root: string; generation: number; source: { kind: string; draftId?: string; project?: ProjectLocator } };
    const expected = { root: firstBefore.root, generation: firstBefore.generation, project: PROJECT, draftId: "free-1" };
    const secondBefore = tabs.tabs[second];

    expect(tabs.convertFreeToAsset(second, expected, API_A)).toBe(false);
    expect(tabs.convertFreeToAsset(first, { ...expected, generation: expected.generation + 1 }, API_A)).toBe(false);
    expect(tabs.convertFreeToAsset(first, { ...expected, project: { ...PROJECT, projectId: "other" } }, API_A)).toBe(false);
    expect(tabs.tabs[first]?.source).toMatchObject({ kind: "free", draftId: "free-1" });
    expect(tabs.canConvertFreeToAsset(first, expected, API_A)).toBe(true);
    expect(tabs.tabs[first]?.source).toMatchObject({ kind: "free", draftId: "free-1" });

    const converted = tabs.commitFreeToAsset(first, API_A);
    expect(converted.source).toEqual({ kind: "asset", locator: API_A });
    expect(converted.generation).toBeGreaterThan(expected.generation);
    expect(converted.root).toBe(expected.root);
    expect(tabs.tabs[second]).toBe(secondBefore);
    expect(tabs.activeId).toBe(first);
  });

  it("asks once for a dirty in-flight tab and leaves it untouched when refused", async () => {
    const confirmClose = vi.fn(async () => false);
    const cancelRun = vi.fn(async () => undefined);
    const evict = vi.fn();
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: () => true,
      isRunning: () => true,
      confirmClose,
      cancelRun,
      evict,
    });
    const id = tabs.open({ kind: "free", project: PROJECT, draftId: "free-1" });

    await expect(tabs.close(id)).resolves.toBe(false);

    expect(confirmClose).toHaveBeenCalledTimes(1);
    expect(confirmClose).toHaveBeenCalledWith(id, { dirty: true, running: true });
    expect(cancelRun).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
    expect(tabs.tabs[id]).toBeDefined();
    expect(tabs.activeId).toBe(id);
  });

  it("cancels only after confirmation and then evicts the closed tab", async () => {
    const events: string[] = [];
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: () => true,
      isRunning: () => true,
      confirmClose: vi.fn(async (id) => { events.push(`confirm:${id}`); return true; }),
      cancelRun: vi.fn(async (id) => { events.push(`cancel:${id}`); }),
      evict: (id) => { events.push(`evict:${id}`); },
    });
    const id = tabs.open({ kind: "asset", locator: API_A });

    await expect(tabs.close(id)).resolves.toBe(true);

    expect(events).toEqual([`confirm:${id}`, `cancel:${id}`, `evict:${id}`]);
    expect(tabs.tabs[id]).toBeUndefined();
    expect(tabs.activeId).toBeNull();
  });

  it("closes all project request tabs after one aggregate confirmation", async () => {
    const running = new Set<string>();
    const dirty = new Set<string>();
    const confirmClose = vi.fn(async () => true);
    const confirmCloseMany = vi.fn(async (_tabs: unknown[], _state: { dirty: boolean; running: boolean }) => true);
    const cancelRun = vi.fn(async (id: string) => { running.delete(id); });
    const evict = vi.fn();
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: (id) => dirty.has(id),
      isRunning: (id) => running.has(id),
      confirmClose,
      confirmCloseMany,
      cancelRun,
      evict,
    });
    const assetId = tabs.open({ kind: "asset", locator: API_A });
    const freeId = tabs.open({ kind: "free", project: PROJECT, draftId: "free-1" });
    dirty.add(assetId);
    running.add(freeId);

    await expect(tabs.closeProject("C:/workspace", PROJECT)).resolves.toBe(true);

    expect(confirmCloseMany).toHaveBeenCalledTimes(1);
    expect(confirmCloseMany.mock.calls[0]?.[1]).toEqual({ dirty: true, running: true });
    expect(confirmClose).not.toHaveBeenCalled();
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith(freeId);
    expect(evict).toHaveBeenCalledTimes(2);
    expect(tabs.order).toEqual([]);
  });

  it("leaves every project request tab untouched when aggregate close is refused", async () => {
    const confirmCloseMany = vi.fn(async (_tabs: unknown[], _state: { dirty: boolean; running: boolean }) => false);
    const cancelRun = vi.fn(async () => undefined);
    const evict = vi.fn();
    const tabs = factory()({
      getContext: () => ({ root: "C:/workspace", project: PROJECT }),
      isDirty: () => true,
      isRunning: () => true,
      confirmClose: vi.fn(async () => true),
      confirmCloseMany,
      cancelRun,
      evict,
    });
    const assetId = tabs.open({ kind: "asset", locator: API_A });
    const freeId = tabs.open({ kind: "free", project: PROJECT, draftId: "free-1" });

    await expect(tabs.closeProject("C:/workspace", PROJECT)).resolves.toBe(false);

    expect(confirmCloseMany).toHaveBeenCalledTimes(1);
    expect(confirmCloseMany.mock.calls[0]?.[1]).toEqual({ dirty: true, running: true });
    expect(cancelRun).not.toHaveBeenCalled();
    expect(evict).not.toHaveBeenCalled();
    expect(tabs.order).toEqual([assetId, freeId]);
    expect(tabs.activeId).toBe(freeId);
  });
});
