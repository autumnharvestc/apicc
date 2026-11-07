// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES, ONLINE_EXECUTION_CACHE_SETTINGS_KEY, OnlineExecutionCachePreferencesSchema } from "../../../src/renderer/src/stores/onlineExecutionCachePreferences.js";
import { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import OnlineExecutionCacheSettings from "../../../src/renderer/src/components/OnlineExecutionCacheSettings.vue";

enableAutoUnmount(afterEach);

function fixture() {
  const execution = reactive({
    cachePreferences: { ...DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES },
    cacheUsage: { currentContexts: 1, protectedContexts: 2, inactiveContexts: 3, inactivePayloadBytes: 1572864, overLimit: true },
    cachePreferenceDiagnostic: null as string | null,
    setCachePreferences: vi.fn((_value: unknown) => {}),
  });
  execution.setCachePreferences.mockImplementation(value => { execution.cachePreferences = OnlineExecutionCachePreferencesSchema.parse(value); execution.cachePreferenceDiagnostic = null; });
  const { i18n } = createI18nInstance(); i18n.global.locale.value = "en";
  const panel = mount(OnlineExecutionCacheSettings, { props: { execution, open: true }, global: { plugins: [i18n] } });
  return { execution, i18n, panel };
}

describe("OnlineExecutionCacheSettings", () => {
  it("shows editable limits, units, distinct usage and lifecycle consequences in both languages", async () => {
    const { execution, i18n, panel } = fixture();
    expect(panel.text()).toContain("Default 20 contexts; range 0–200 contexts");
    expect(panel.text()).toContain("Default 30 minutes; range 1–1440 minutes");
    expect(panel.text()).toContain("Default 64 MiB; range 1–512 MiB");
    expect(panel.get('[data-testid="execution-cache-current"]').text()).toBe("1");
    expect(panel.get('[data-testid="execution-cache-protected"]').text()).toBe("2");
    expect(panel.get('[data-testid="execution-cache-inactive"]').text()).toBe("3");
    expect(panel.get('[data-testid="execution-cache-payload"]').text()).toBe("1.5 MiB");
    expect(panel.get('[data-testid="execution-cache-payload"]').attributes("title")).toContain("1572864 bytes");
    expect(panel.get('[data-testid="execution-cache-over-limit"]').text()).toContain("Protected records are retained");
    for (const text of ["does not delete server history", "cancel requests", "execute them again", "default execution location and environment", "new session", "may no longer be recoverable", "not an exact cleanup timer", "not an Electron heap or process RSS limit"]) expect(panel.text()).toContain(text);
    expect(panel.find('pre').exists()).toBe(false); expect(panel.text()).not.toContain("maxInactiveContexts");
    i18n.global.locale.value = "zh-CN"; await flushPromises();
    for (const text of ["默认 20 个；范围 0–200 个", "空闲保留期", "受保护上下文", "只释放可安全清理的非活动内存", "内存副本可能无法恢复", "不是精确到时清理"]) expect(panel.text()).toContain(text);
    execution.cacheUsage = { ...execution.cacheUsage, inactivePayloadBytes: 1, inactiveContexts: 4 }; await flushPromises();
    expect(panel.get('[data-testid="execution-cache-payload"]').text()).toBe("小于 0.01 MiB");
    expect(panel.get('[data-testid="execution-cache-inactive"]').text()).toBe("4");
    expect(execution.setCachePreferences).not.toHaveBeenCalled();
  });

  it("keeps drafts local until save and accepts the displayed minimum and maximum values", async () => {
    const { execution, panel } = fixture();
    await panel.get('[data-testid="execution-cache-max-contexts"]').setValue("0");
    await panel.get('[data-testid="execution-cache-ttl"]').setValue("1");
    await panel.get('[data-testid="execution-cache-max-payload"]').setValue("512");
    expect(execution.cachePreferences).toEqual(DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES);
    expect(panel.text()).toContain("Unsaved changes");
    await panel.get('[data-testid="execution-cache-form"]').trigger("submit");
    expect(execution.setCachePreferences).toHaveBeenCalledExactlyOnceWith({ maxInactiveContexts: 0, inactiveTtlMinutes: 1, maxInactivePayloadMiB: 512 });
    expect(panel.get('[data-testid="execution-cache-saved"]').text()).toContain("saved and applied");
    await panel.get('[data-testid="execution-cache-max-contexts"]').setValue("11");
    expect(panel.find('[data-testid="execution-cache-saved"]').exists()).toBe(false);
    execution.cacheUsage = { ...execution.cacheUsage, inactiveContexts: 4 }; await flushPromises();
    expect((panel.get('[data-testid="execution-cache-max-contexts"]').element as HTMLInputElement).value).toBe("11");
    execution.cachePreferences = { ...execution.cachePreferences, maxInactiveContexts: 2 }; await flushPromises();
    expect((panel.get('[data-testid="execution-cache-max-contexts"]').element as HTMLInputElement).value).toBe("2");
    await panel.get('[data-testid="execution-cache-max-contexts"]').setValue("12");
    await panel.setProps({ open: false }); await panel.setProps({ open: true });
    expect((panel.get('[data-testid="execution-cache-max-contexts"]').element as HTMLInputElement).value).toBe("2");
  });

  it("rejects empty, fractional and out-of-range drafts and leaves the effective settings intact on persistence failure", async () => {
    const { execution, i18n, panel } = fixture();
    await panel.get('[data-testid="execution-cache-ttl"]').setValue("");
    expect(panel.get('[data-testid="execution-cache-save"]').attributes("disabled")).toBeDefined();
    expect(panel.get('[data-testid="execution-cache-invalid"]').text()).toContain("All three settings are required");
    await panel.get('[data-testid="execution-cache-form"]').trigger("submit");
    expect(execution.setCachePreferences).not.toHaveBeenCalled();
    await panel.get('[data-testid="execution-cache-ttl"]').setValue("1.5");
    expect(panel.get('[data-testid="execution-cache-save"]').attributes("disabled")).toBeDefined();
    await panel.get('[data-testid="execution-cache-ttl"]').setValue("1441");
    expect(panel.get('[data-testid="execution-cache-save"]').attributes("disabled")).toBeDefined();
    await panel.get('[data-testid="execution-cache-ttl"]').setValue("45");
    execution.setCachePreferences.mockImplementationOnce(() => { throw new Error("online-cache-settings-save-failed"); });
    await panel.get('[data-testid="execution-cache-form"]').trigger("submit");
    expect(execution.cachePreferences).toEqual(DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES);
    expect(panel.get('[data-testid="execution-cache-error"]').text()).toContain("Previous cache settings remain effective");
    expect(panel.find('[data-testid="execution-cache-saved"]').exists()).toBe(false);
    i18n.global.locale.value = "zh-CN"; await flushPromises();
    expect(panel.get('[data-testid="execution-cache-error"]').text()).toContain("原缓存设置仍然生效");
    expect((panel.get('[data-testid="execution-cache-ttl"]').element as HTMLInputElement).value).toBe("45");
  });

  it("explains invalid stored preferences and unavailable storage while preserving unknown diagnostic codes", async () => {
    const { execution, panel } = fixture();
    execution.cachePreferenceDiagnostic = "online-cache-settings-corrupt"; await flushPromises();
    expect(panel.get('[data-testid="execution-cache-diagnostic"]').text()).toContain("Stored cache settings are invalid; defaults are in use");
    execution.cachePreferenceDiagnostic = "online-cache-settings-unavailable"; await flushPromises();
    expect(panel.get('[data-testid="execution-cache-diagnostic"]').text()).toContain("could not be read; defaults are in use");
    execution.cachePreferenceDiagnostic = "future-cache-reason-v9"; await flushPromises();
    expect(panel.get('[data-testid="execution-cache-diagnostic"]').text()).toBe("future-cache-reason-v9");
    await panel.get('[data-testid="execution-cache-form"]').trigger("submit");
    expect(panel.find('[data-testid="execution-cache-diagnostic"]').exists()).toBe(false);
  });

  it("saves through the real online store, applies safe cache cleanup and restores only persisted values after reopening", async () => {
    const entries = new Map<string, string>(); let failWrites = false;
    const storage: Storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw new Error("synthetic local write unavailable"); entries.set(key, value); }, removeItem: key => { entries.delete(key); }, clear: () => entries.clear(), key: index => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
    const api = createMemoryApi(); const calls = vi.spyOn(api, "onlineExecution");
    const online = createOnlineStore({ api, storage });
    const firstContext = { serverId: "https://cache.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
    online.execution.activate(firstContext); online.execution.selectLocation({ kind: "agent", agentId: "5" });
    online.execution.activate({ ...firstContext, scope: { ...firstContext.scope, projectId: "34" } });
    expect(online.execution.cacheUsage.inactiveContexts).toBe(1);
    const { i18n } = createI18nInstance(); i18n.global.locale.value = "en";
    const panel = mount(OnlineExecutionCacheSettings, { props: { execution: online.execution }, global: { plugins: [i18n] } });
    await panel.get('[data-testid="execution-cache-max-contexts"]').setValue("0");
    await panel.get('[data-testid="execution-cache-ttl"]').setValue("12");
    await panel.get('[data-testid="execution-cache-max-payload"]').setValue("8");
    expect(storage.getItem(ONLINE_EXECUTION_CACHE_SETTINGS_KEY)).toBeNull();
    await panel.get('[data-testid="execution-cache-form"]').trigger("submit");
    const persisted = { maxInactiveContexts: 0, inactiveTtlMinutes: 12, maxInactivePayloadMiB: 8 };
    expect(JSON.parse(storage.getItem(ONLINE_EXECUTION_CACHE_SETTINGS_KEY)!)).toEqual(persisted);
    expect(online.execution.cacheUsage.inactiveContexts).toBe(0);
    expect(panel.get('[data-testid="execution-cache-saved"]').text()).toContain("saved and applied");
    online.execution.activate(firstContext); expect(online.execution.location).toEqual({ kind: "local" });
    failWrites = true; await panel.get('[data-testid="execution-cache-ttl"]').setValue("13");
    await panel.get('[data-testid="execution-cache-form"]').trigger("submit");
    expect(online.execution.cachePreferences).toEqual(persisted);
    expect(panel.get('[data-testid="execution-cache-error"]').text()).toContain("Previous cache settings remain effective");
    expect(panel.findAll('[role="alert"]')).toHaveLength(1);
    expect(calls).not.toHaveBeenCalled();
    panel.unmount();
    const reopened = createOnlineStore({ api, storage });
    const next = mount(OnlineExecutionCacheSettings, { props: { execution: reopened.execution }, global: { plugins: [i18n] } });
    expect((next.get('[data-testid="execution-cache-max-contexts"]').element as HTMLInputElement).value).toBe("0");
    expect((next.get('[data-testid="execution-cache-ttl"]').element as HTMLInputElement).value).toBe("12");
    expect((next.get('[data-testid="execution-cache-max-payload"]').element as HTMLInputElement).value).toBe("8");
  });
});
