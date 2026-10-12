import { createPinia, defineStore } from "pinia";
import type { AiSuggestedCase } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { ApiLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;

/**
 * AI 配置的渲染层存储键（规格 §2 D2 裁定：baseUrl/model 为非敏感配置，与既有偏好存储
 * 同一先例——theme `apicc.theme` / 语言 `apicc.locale` / 在线档案 `apicc.onlineServers`；
 * key 不在此处——key 走 main 进程 safeStorage，出口只含 hasKey）。
 */
export const AI_CONFIG_STORAGE_KEY = "apicc.ai.config";

/** localStorage 持久化形状：仅非敏感的 baseUrl/model。 */
export interface PersistedAiConfig { baseUrl: string; model: string }

interface SuggestionTarget {
  root: string;
  activeKey: string;
  generation: number;
  locator: ApiLocator;
}

function sameLocator(left: ApiLocator, right: ApiLocator): boolean {
  return left.workspaceId === right.workspaceId
    && left.groupId === right.groupId
    && left.projectId === right.projectId
    && left.collectionId === right.collectionId
    && left.apiId === right.apiId
    && left.folderIds.length === right.folderIds.length
    && left.folderIds.every((id, index) => id === right.folderIds[index]);
}

/** 读持久化配置（形状守卫：非 JSON/缺字段/类型不符 → 空白 + warn，不抛——先例同 online 档案）。 */
export function readPersistedAiConfig(storage: Storage): PersistedAiConfig {
  const raw = storage.getItem(AI_CONFIG_STORAGE_KEY);
  if (raw === null) return { baseUrl: "", model: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`AI 配置存储损坏，已忽略: ${e instanceof Error ? e.message : String(e)}`);
    return { baseUrl: "", model: "" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    console.warn("AI 配置存储形状不符，已忽略（请重新配置 AI 设置）");
    return { baseUrl: "", model: "" };
  }
  const candidate = parsed as Partial<PersistedAiConfig>;
  if (typeof candidate.baseUrl !== "string" || typeof candidate.model !== "string") {
    console.warn("AI 配置存储形状不符，已忽略（请重新配置 AI 设置）");
    return { baseUrl: "", model: "" };
  }
  return { baseUrl: candidate.baseUrl, model: candidate.model };
}

/**
 * AI store 工厂（M6-C 任务 1，规格 §2 D2/D4）：依赖注入（api + editor + storage，测试传
 * 新实例即天然隔离）；每次工厂调用绑定独立 Pinia 实例；组件内零工厂调用，实例由 App
 * 组合根创建后经 props 下传（AiConfigDialog/AiSuggestionsDrawer）。
 *
 * 状态契约：
 * - 配置：baseUrl/model 入注入 storage（键 apicc.ai.config）；key 经 IPC 入 main 安全存储，
 *   出口只含 hasKey（裁定②）；saveConfig 的 apiKey 留空 = 保持既有。
 * - 连接测试（任务 2 真探测）：ai:test-config 轻量探测——本地护栏（未保存配置不发 IPC）
 *   → resolve → success、reject（provider 归一化错误）→ failure + 可读 error。
 * - 建议（任务 2 真链路出口）：core AiSuggestedCase（带本地 id，勾选/采用按 id）；
 *   fetchSuggestions 成功 → 抽屉打开、默认未勾选；失败 → error 上屏、抽屉不动。
 * - 采用（裁定③）：勾选并入 editor.api.cases（沿用 core 本地生成的 id——不信任 AI 生成
 *   的 id 已由 core 兜住）后**不自动保存**——AI 产出永不静默落盘，dirty 点亮等待用户显式
 *   触发既有保存链路（editor.save）；关闭/丢弃零落盘。
 */
export function createAiStore(deps: {
  api: ApiccApi;
  editor: Editor;
  storage?: Storage;
  getContext?: () => { root: string; readOnly: boolean };
}) {
  const api = deps.api;
  const editor = deps.editor;
  const storage = deps.storage ?? localStorage;
  const getContext = deps.getContext ?? (() => ({
    root: editor.activeKey === null ? "" : editor.sessions[editor.activeKey]?.root ?? "",
    readOnly: false,
  }));
  let suggestionGeneration = 0;
  let suggestionTarget: SuggestionTarget | null = null;
  const activeTarget = (): SuggestionTarget | null => {
    const activeKey = editor.activeKey;
    if (activeKey === null) return null;
    const session = editor.sessions[activeKey];
    const context = getContext();
    if (!session || !context.root || session.root !== context.root) return null;
    return {
      root: session.root,
      activeKey,
      generation: session.generation,
      locator: {
        ...session.locator,
        folderIds: [...session.locator.folderIds],
      },
    };
  };
  const targetIsCurrent = (target: SuggestionTarget): boolean => {
    const current = activeTarget();
    return current !== null
      && current.root === target.root
      && current.activeKey === target.activeKey
      && current.generation === target.generation
      && sameLocator(current.locator, target.locator);
  };
  const clearSuggestions = (state: { suggestions: AiSuggestedCase[] | null; selectedIds: string[]; drawerOpen: boolean }): void => {
    state.suggestions = null;
    state.selectedIds = [];
    state.drawerOpen = false;
    suggestionTarget = null;
  };
  return defineStore("ai", {
    state: () => ({
      // —— 配置（对话框）——
      configDialogOpen: false,
      baseUrl: "",
      model: "",
      /** main 安全存储是否存在密钥（key 明文永不回传渲染层，裁定②）。 */
      hasKey: false,
      configLoading: false,
      savingConfig: false,
      /** 保存成功提示（对话框内一次性；重新打开复位）。 */
      savedNotice: false,
      // —— 连接测试（fixture 两态）——
      testing: false,
      testResult: null as null | "success" | "failure",
      // —— 建议（抽屉）——
      drawerOpen: false,
      suggestions: null as AiSuggestedCase[] | null,
      suggestLoading: false,
      selectedIds: [] as string[],
      /** 共享错误通道（保存/测试/拉取失败文案上屏）。 */
      error: null as string | null,
    }),
    getters: {
      canAdopt(state): boolean {
        return !getContext().readOnly
          && editor.api !== null
          && state.suggestions !== null
          && state.selectedIds.length > 0
          && suggestionTarget !== null
          && targetIsCurrent(suggestionTarget);
      },
    },
    actions: {
      /**
       * 启动装配（App 组合根 onMounted 调用，void 之）：读持久化 baseUrl/model + IPC
       * hasKey。IPC 失败仅记 error（hasKey 保持 false），全程不抛。
       */
      async init(): Promise<void> {
        this.configLoading = true;
        try {
          const persisted = readPersistedAiConfig(storage);
          this.baseUrl = persisted.baseUrl;
          this.model = persisted.model;
          const status = await api.aiGetConfig();
          this.hasKey = status.hasKey;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.configLoading = false;
        }
      },

      /**
       * 保存配置：apiKey 非空才携带（留空 = 保持既有）；成功 → 状态/持久化同步 + 返回
       * true；失败 → error 上屏、状态不变、返回 false。
       */
      async saveConfig(input: { baseUrl: string; model: string; apiKey?: string }): Promise<boolean> {
        this.savingConfig = true;
        this.error = null;
        this.savedNotice = false;
        try {
          const payload: { baseUrl: string; model: string; apiKey?: string } = {
            baseUrl: input.baseUrl,
            model: input.model,
          };
          if (input.apiKey) payload.apiKey = input.apiKey;
          const status = await api.aiSaveConfig(payload);
          this.baseUrl = input.baseUrl;
          this.model = input.model;
          this.hasKey = status.hasKey;
          this.savedNotice = true;
          storage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ baseUrl: input.baseUrl, model: input.model } satisfies PersistedAiConfig));
          return true;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
          return false;
        } finally {
          this.savingConfig = false;
        }
      },

      /**
       * 连接测试（任务 2 真探测）：本地护栏（未保存 baseUrl/model 不发 IPC）→
       * ai:test-config 轻量探测——resolve → success；reject（provider 归一化错误）→
       * failure + 可读 error。
       */
      async testConnection(): Promise<void> {
        if (!this.baseUrl || !this.model) {
          this.testResult = "failure";
          this.error = "尚未配置 AI，请先在 AI 设置中保存配置";
          return;
        }
        this.testing = true;
        this.error = null;
        this.testResult = null;
        try {
          await api.aiTestConfig({ baseUrl: this.baseUrl, model: this.model });
          this.testResult = "success";
        } catch (e) {
          this.testResult = "failure";
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.testing = false;
        }
      },

      /**
       * 拉取 AI 建议并打开抽屉（任务 2 真链路出口）：本地护栏（未选接口/未保存配置不发
       * IPC，apiId 与已保存配置随调用携带，key 留 main）→ 成功 → 抽屉打开、默认未勾选；
       * 失败 → error 上屏、抽屉不动。
       */
      async fetchSuggestions(): Promise<void> {
        const target = activeTarget();
        if (!target || !this.baseUrl || !this.model) {
          this.error = "尚未配置 AI 或未选择接口，请先保存 AI 配置并选择接口";
          return;
        }
        const requestGeneration = ++suggestionGeneration;
        this.suggestLoading = true;
        this.error = null;
        try {
          const rows = await api.aiSuggest({ locator: target.locator, baseUrl: this.baseUrl, model: this.model });
          if (requestGeneration !== suggestionGeneration) return;
          if (!targetIsCurrent(target)) {
            clearSuggestions(this);
            return;
          }
          this.suggestions = rows.map((s) => structuredClone(s));
          this.selectedIds = [];
          this.drawerOpen = true;
          suggestionTarget = target;
        } catch (e) {
          if (requestGeneration !== suggestionGeneration) return;
          if (!targetIsCurrent(target)) {
            clearSuggestions(this);
            return;
          }
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          if (requestGeneration === suggestionGeneration) this.suggestLoading = false;
        }
      },

      toggleSelect(id: string): void {
        const index = this.selectedIds.indexOf(id);
        if (index >= 0) this.selectedIds.splice(index, 1);
        else this.selectedIds.push(id);
      },

      /**
       * 采用勾选建议（裁定③）：并入 editor.api.cases（id 沿用 core 本地生成的 ULID——
       * 不信任 AI 生成 id 的边界由 core suggestCases 兜住），清空建议与勾选并关抽屉；
       * **不自动保存**——dirty 点亮，落盘由用户显式触发既有保存链路。未加载接口 /
       * 未勾选时为空操作（返回 0）。
       */
      adopt(): number {
        const target = editor.api;
        if (getContext().readOnly || !target || this.suggestions === null || this.selectedIds.length === 0) return 0;
        if (!suggestionTarget || !targetIsCurrent(suggestionTarget)) {
          clearSuggestions(this);
          return 0;
        }
        const selected = new Set(this.selectedIds);
        let count = 0;
        for (const row of this.suggestions) {
          if (!selected.has(row.id)) continue;
          target.cases.push({
            id: row.id,
            name: row.name,
            scope: row.scope,
            parameters: { ...row.parameters },
            preOperations: row.preOperations.map((operation) => ({ ...operation })),
            postOperations: row.postOperations.map((operation) => ({ ...operation })),
            assertions: row.assertions.map((a) => ({ ...a })),
          });
          count += 1;
        }
        this.suggestions = null;
        this.selectedIds = [];
        this.drawerOpen = false;
        suggestionTarget = null;
        return count;
      },

      /** 关闭/丢弃（零落盘）：建议与勾选清空、抽屉关闭，editor 不动。 */
      dismissSuggestions(): void {
        suggestionGeneration += 1;
        this.suggestLoading = false;
        this.drawerOpen = false;
        this.suggestions = null;
        this.selectedIds = [];
        suggestionTarget = null;
      },
    },
  })(createPinia());
}

export type AiStore = ReturnType<typeof createAiStore>;
