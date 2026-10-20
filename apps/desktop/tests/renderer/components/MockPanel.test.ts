// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import type { ApiccApi } from "../../../src/shared/types.js";
import type { ProjectLocator } from "../../../src/shared/locations.js";
import type { MockStatus } from "../../../src/shared/mock.js";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { MockProjectConfigSchema } from "@apicc/core/schema";
import MockPanel from "../../../src/renderer/src/components/MockPanel.vue";

enableAutoUnmount(afterEach);

const locator: ProjectLocator = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  groupId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000003",
};
const config = { formatVersion: 1 as const, seed: "saved-seed", enabledContractIds: [], rules: [] };

function status(overrides: Partial<MockStatus> = {}): MockStatus {
  return {
    locator,
    config,
    sourceProjectRevision: "rev-1",
    status: "stopped",
    address: null,
    diagnostics: [],
    logs: [],
    simulated: true,
    ...overrides,
  };
}

function mountPanel(options: { readOnly?: boolean; initial?: MockStatus; getStatus?: () => Promise<MockStatus> } = {}) {
  let current = options.initial ?? status();
  const api = {
    mockGet: vi.fn(options.getStatus ?? (async () => current)),
    mockConfigSave: vi.fn(async (input) => { current = status({ ...current, config: input.config, sourceProjectRevision: "rev-2" }); return current; }),
    mockStart: vi.fn(async () => { current = status({ ...current, status: "running", address: { address: "127.0.0.1", family: "IPv4", port: 41731 } }); return current; }),
    mockStop: vi.fn(async () => { current = status({ ...current, status: "stopped" }); return current; }),
    mockReload: vi.fn(async () => current),
  } as unknown as ApiccApi;
  const { i18n } = createI18nInstance();
  const wrapper = mount(MockPanel, { props: { api, locator, readOnly: options.readOnly }, global: { plugins: [i18n] } });
  return { wrapper, api: api as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

describe("project Mock panel", () => {
  it("loads the current project, saves config without starting a server, and only emits the existing free-request action", async () => {
    const { wrapper, api } = mountPanel();
    await flushPromises();

    expect(api.mockGet).toHaveBeenCalledWith(locator);
    expect(wrapper.find('[data-testid="mock-simulated"]').exists()).toBe(true);
    const configText = JSON.stringify({ ...config, seed: "edited-seed" }, null, 2);
    expect(MockProjectConfigSchema.safeParse(JSON.parse(configText)).success).toBe(true);
    await wrapper.get('[data-testid="mock-config"]').setValue(configText);
    expect(wrapper.find('[data-testid="mock-config-error"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="mock-save"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="mock-save"]').trigger("click");
    await flushPromises();
    expect(api.mockConfigSave).toHaveBeenCalledWith({ locator, sourceProjectRevision: "rev-1", config: { ...config, seed: "edited-seed" } });
    expect(api.mockStart).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="mock-new-free-request"]').trigger("click");
    expect(wrapper.emitted("new-free-request")).toHaveLength(1);
    expect(api.mockStart).not.toHaveBeenCalled();
  });

  it("starts only on explicit action and displays the bound address and metadata-only request log", async () => {
    const running = status({
      status: "running",
      address: { address: "127.0.0.1", family: "IPv4", port: 41731 },
      logs: [{ requestId: "r-1", time: "2026-10-19T00:00:00.000Z", method: "GET", routeTemplate: "/items/{id}", status: 200, durationMs: 1, revision: "rev-1", reason: "matched" }],
    });
    const { wrapper, api } = mountPanel({ initial: status() });
    await flushPromises();
    await wrapper.get('[data-testid="mock-port"]').setValue("41731");
    await wrapper.get('[data-testid="mock-start"]').trigger("click");
    await flushPromises();
    expect(api.mockStart).toHaveBeenCalledWith({ locator, sourceProjectRevision: "rev-1", port: 41731 });

    const { wrapper: runningWrapper } = mountPanel({ initial: running });
    await flushPromises();
    expect(runningWrapper.get('[data-testid="mock-address"]').text()).toContain("127.0.0.1:41731");
    expect(runningWrapper.get('[data-testid="mock-log-row-r-1"]').text()).toContain("/items/{id}");
    expect(runningWrapper.text()).not.toContain("Authorization");
  });

  it("keeps the Mock address copyable text instead of a workspace-navigation link", async () => {
    const running = status({
      status: "running",
      address: { address: "127.0.0.1", family: "IPv4", port: 41731 },
    });
    const { wrapper } = mountPanel({ initial: running });
    await flushPromises();
    const locationBefore = window.location.href;
    const address = wrapper.get('[data-testid="mock-address"]');

    expect(address.element.tagName).toBe("SPAN");
    expect(address.attributes("href")).toBeUndefined();
    await address.trigger("click");
    expect(window.location.href).toBe(locationBefore);
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("running");
  });

  it("allows manual refresh after the initial status request fails", async () => {
    let calls = 0;
    const getStatus = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary status failure");
      return status({ sourceProjectRevision: "recovered-revision" });
    });
    const { wrapper, api } = mountPanel({ getStatus });
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("temporary status failure");
    expect(wrapper.get('[data-testid="mock-refresh"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-testid="mock-refresh"]').trigger("click");
    await flushPromises();

    expect(api.mockGet).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("recovered-revision");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("keeps mutations disabled in a read-only project", async () => {
    const { wrapper, api } = mountPanel({ readOnly: true });
    await flushPromises();
    expect(wrapper.get('[data-testid="mock-config"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="mock-save"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="mock-start"]').attributes("disabled")).toBeDefined();
    expect(api.mockConfigSave).not.toHaveBeenCalled();
    expect(api.mockStart).not.toHaveBeenCalled();
  });

  it("shows server failures and does not hide invalid start state", async () => {
    const { wrapper, api } = mountPanel();
    await flushPromises();
    api.mockStart.mockRejectedValueOnce(new Error("saved project revision changed"));
    await wrapper.get('[data-testid="mock-start"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("saved project revision changed");
  });

  it("reloads on same-locator physical-root switch and ignores the late prior-root result", async () => {
    let releaseFirst!: (value: MockStatus) => void;
    const first = new Promise<MockStatus>((resolve) => { releaseFirst = resolve; });
    const api = {
      mockGet: vi.fn().mockImplementationOnce(() => first).mockResolvedValueOnce(status({ sourceProjectRevision: "root-b-revision" })),
      mockConfigSave: vi.fn(), mockStart: vi.fn(), mockStop: vi.fn(), mockReload: vi.fn(),
    } as unknown as ApiccApi;
    const { i18n } = createI18nInstance();
    const wrapper = mount(MockPanel, { props: { api, locator, root: "C:/workspace-a" }, global: { plugins: [i18n] } });
    await wrapper.setProps({ root: "C:/workspace-b" });
    await flushPromises();
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("root-b-revision");
    expect(wrapper.get('[data-testid="mock-start"]').attributes("disabled")).toBeUndefined();
    releaseFirst(status({ sourceProjectRevision: "root-a-revision" }));
    await flushPromises();
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("root-b-revision");
    expect(api.mockGet).toHaveBeenCalledTimes(2);
  });

  it("does not let a late operation error from the previous project contaminate the new project", async () => {
    let rejectStart!: (error: Error) => void;
    const startPending = new Promise<MockStatus>((_resolve, reject) => { rejectStart = reject; });
    const api = {
      mockGet: vi.fn().mockResolvedValueOnce(status({ sourceProjectRevision: "root-a" })).mockResolvedValueOnce(status({ sourceProjectRevision: "root-b" })),
      mockConfigSave: vi.fn(),
      mockStart: vi.fn(() => startPending),
      mockStop: vi.fn(),
      mockReload: vi.fn(),
    } as unknown as ApiccApi;
    const { i18n } = createI18nInstance();
    const wrapper = mount(MockPanel, { props: { api, locator, root: "C:/workspace-a" }, global: { plugins: [i18n] } });
    await flushPromises();
    await wrapper.get('[data-testid="mock-start"]').trigger("click");
    await wrapper.setProps({ root: "C:/workspace-b" });
    await flushPromises();
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("root-b");
    expect(wrapper.get('[data-testid="mock-start"]').attributes("disabled")).toBeUndefined();

    rejectStart(new Error("late root A failure"));
    await flushPromises();
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("root-b");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("refreshes status and logs without overlap and preserves an unsaved config draft", async () => {
    vi.useFakeTimers();
    let releasePoll!: (value: MockStatus) => void;
    const polledStatus = status({
      status: "invalid",
      sourceProjectRevision: "rev-2-after-save",
      diagnostics: [{ severity: "error", code: "MOCK_INVALID", path: "mock.rules", message: "saved rule no longer compiles", lossy: false }],
      logs: [{ requestId: "r-2", time: "2026-10-19T00:00:00.000Z", method: "GET", routeTemplate: "/items/{id}", status: 503, durationMs: 1, revision: "rev-2-after-save", reason: "invalid" }],
    });
    const pendingPoll = new Promise<MockStatus>((resolve) => { releasePoll = resolve; });
    const api = {
      mockGet: vi.fn().mockResolvedValueOnce(status()).mockReturnValueOnce(pendingPoll).mockResolvedValue(status({ sourceProjectRevision: "rev-3-manual-refresh" })),
      mockConfigSave: vi.fn(),
      mockStart: vi.fn(async () => polledStatus),
      mockStop: vi.fn(),
      mockReload: vi.fn(async () => polledStatus),
    } as unknown as ApiccApi;
    const { i18n } = createI18nInstance();
    const wrapper = mount(MockPanel, { props: { api, locator, root: "C:/workspace" }, global: { plugins: [i18n] } });
    await flushPromises();
    const draftText = JSON.stringify({ ...config, seed: "not-saved" }, null, 2);
    await wrapper.get('[data-testid="mock-config"]').setValue(draftText);
    expect(wrapper.find('[data-testid="mock-unsaved"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mock-start-saved-note"]').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.mockGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.mockGet).toHaveBeenCalledTimes(2);
    releasePoll(polledStatus);
    await flushPromises();
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("rev-2-after-save");
    expect(wrapper.find('[data-testid="mock-log-row-r-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mock-diagnostics"]').text()).toContain("MOCK_INVALID");
    expect((wrapper.get('[data-testid="mock-config"]').element as HTMLTextAreaElement).value).toBe(draftText);

    await wrapper.get('[data-testid="mock-refresh"]').trigger("click");
    await flushPromises();
    expect(api.mockGet).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-testid="mock-status"]').text()).toContain("rev-3-manual-refresh");
    expect((wrapper.get('[data-testid="mock-config"]').element as HTMLTextAreaElement).value).toBe(draftText);
    await wrapper.get('[data-testid="mock-start"]').trigger("click");
    expect(api.mockStart).toHaveBeenCalledWith({ locator, sourceProjectRevision: "rev-3-manual-refresh", port: 0 });
    expect((wrapper.get('[data-testid="mock-config"]').element as HTMLTextAreaElement).value).toBe(draftText);
    wrapper.unmount();
    vi.useRealTimers();
  });
});
