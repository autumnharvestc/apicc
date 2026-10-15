import { createPinia, defineStore } from "pinia";
import type { ApiccApi } from "../../../shared/types.js";
import type { DebugHistoryListFilter, DebugHistoryPreferences, DebugHistoryReadResult, DebugHistorySummary } from "@apicc/core";

const DEFAULT_PREFERENCES: DebugHistoryPreferences = { enabled: true, retentionDays: 30, maxRecords: 1000 };

export function useDebugHistoryStore(api: ApiccApi) {
  const getHistoryRecord = api.debugHistoryGet.bind(api) as (historyId: string) => Promise<DebugHistoryReadResult>;
  return defineStore("debugHistory", {
    state: () => ({
      filter: { limit: 50, offset: 0 } as DebugHistoryListFilter,
      items: [] as DebugHistorySummary[],
      nextOffset: null as number | null,
      diagnostics: [] as Array<{ code: string; message: string }>,
      selected: null as DebugHistoryReadResult | null,
      preferences: { ...DEFAULT_PREFERENCES } as DebugHistoryPreferences,
      loading: false,
      error: null as string | null,
    }),
    actions: {
      async load() {
        this.loading = true;
        this.error = null;
        try {
          const [preferences, page] = await Promise.all([
            api.debugHistoryPreferencesGet(),
            api.debugHistoryList(this.filter),
          ]);
          this.preferences = preferences.preferences;
          this.diagnostics = [...preferences.diagnostics, ...page.diagnostics];
          this.items = page.items;
          this.nextOffset = page.nextOffset ?? null;
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        } finally {
          this.loading = false;
        }
      },
      async refresh(reset = true) {
        if (reset) this.filter.offset = 0;
        this.loading = true;
        this.error = null;
        try {
          const page = await api.debugHistoryList(this.filter);
          this.diagnostics = page.diagnostics;
          this.items = reset ? page.items : [...this.items, ...page.items];
          this.nextOffset = page.nextOffset ?? null;
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        } finally {
          this.loading = false;
        }
      },
      async loadMore() {
        if (this.nextOffset === null || this.loading) return;
        this.filter.offset = this.nextOffset;
        await this.refresh(false);
      },
      async openRecord(historyId: string) {
        this.error = null;
        try {
          const result = await getHistoryRecord(historyId);
          (this as unknown as { selected: DebugHistoryReadResult | null }).selected = result;
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      },
      async deleteRecord(historyId: string) {
        try {
          await api.debugHistoryDelete(historyId);
          if (this.selected?.record?.historyId === historyId) this.selected = null;
          await this.refresh(true);
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      },
      async cleanup() {
        try {
          const result = await api.debugHistoryCleanup();
          this.diagnostics = result.diagnostics;
          await this.refresh(true);
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      },
      async updatePreferences(preferences: DebugHistoryPreferences) {
        try {
          this.preferences = await api.debugHistoryPreferencesUpdate(preferences);
          await this.refresh(true);
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      },
    },
  })(createPinia());
}
