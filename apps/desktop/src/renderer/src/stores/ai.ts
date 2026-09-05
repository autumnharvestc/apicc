import { createPinia, defineStore } from "pinia";
import type { ApiccApi } from "../../../shared/types.js";
import type { AiSuggestedCase } from "../../../shared/ai/contract.js";
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

/** 建议行视图模型：contract 契约 + 本地行键（不信任 AI 侧 id，勾选/列表 :key 用行键）。 */
export type AiSuggestionRow = AiSuggestedCase & { key: string };

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
 * - 连接测试（fixture 阶段）：经 ai:suggest 桩两态——resolve → success、reject → failure +
 *   可读 error（与「未配置」错误同源）。
 * - 建议：fetchSuggestions 成功 → 抽屉打开、默认未勾选；失败 → error 上屏、抽屉不动。
 * - 采用（裁定③）：勾选并入 editor.api.cases 后**不自动保存**——AI 产出永不静默落盘，
 *   dirty 点亮等待用户显式触发既有保存链路（editor.save）；关闭/丢弃零落盘（裁定④的
 *   反向：列表带「AI 生成」来源标注，采用与否都由用户显式决定）。
 */
export function createAiStore(deps: { api: ApiccApi; editor: Editor; storage?: Storage }) {
  const api = deps.api;
  const editor = deps.editor;
  const storage = deps.storage ?? localStorage;
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
      suggestions: null as AiSuggestionRow[] | null,
      suggestLoading: false,
      selectedIds: [] as string[],
      /** 共享错误通道（保存/测试/拉取失败文案上屏）。 */
      error: null as string | null,
    }),
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
       * 连接测试（fixture 阶段经 ai:suggest 桩两态）：resolve → success；reject → failure
       * + 可读 error。任务 2 切真 provider 轻量调用后语义不变（出口仍两态）。
       */
      async testConnection(): Promise<void> {
        this.testing = true;
        this.error = null;
        this.testResult = null;
        try {
          await api.aiSuggest({ apiId: editor.apiId ?? "" });
          this.testResult = "success";
        } catch (e) {
          this.testResult = "failure";
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.testing = false;
        }
      },

      /** 拉取 AI 建议并打开抽屉：成功 → 行键本地生成、默认未勾选；失败 → error 上屏、抽屉不动。 */
      async fetchSuggestions(): Promise<void> {
        this.suggestLoading = true;
        this.error = null;
        try {
          const rows = await api.aiSuggest({ apiId: editor.apiId ?? "" });
          this.suggestions = rows.map((s) => ({ ...s, key: crypto.randomUUID() }));
          this.selectedIds = [];
          this.drawerOpen = true;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.suggestLoading = false;
        }
      },

      toggleSelect(key: string): void {
        const index = this.selectedIds.indexOf(key);
        if (index >= 0) this.selectedIds.splice(index, 1);
        else this.selectedIds.push(key);
      },

      /**
       * 采用勾选建议（裁定③）：并入 editor.api.cases（用例与断言 id 本地生成——不信任
       * AI 生成的 id，规格 §2 D3），清空建议与勾选并关抽屉；**不自动保存**——dirty 点亮，
       * 落盘由用户显式触发既有保存链路。未加载接口 / 未勾选时为空操作（返回 0）。
       */
      adopt(): number {
        const target = editor.api;
        if (!target || this.suggestions === null || this.selectedIds.length === 0) return 0;
        const selected = new Set(this.selectedIds);
        let count = 0;
        for (const row of this.suggestions) {
          if (!selected.has(row.key)) continue;
          target.cases.push({
            id: crypto.randomUUID(),
            name: row.name,
            scope: row.scope,
            parameters: { ...row.parameters },
            assertions: row.assertions.map((a) => ({ ...a, id: crypto.randomUUID() })),
            ...(row.postScript !== undefined ? { postScript: row.postScript } : {}),
          });
          count += 1;
        }
        this.suggestions = null;
        this.selectedIds = [];
        this.drawerOpen = false;
        return count;
      },

      /** 关闭/丢弃（零落盘）：建议与勾选清空、抽屉关闭，editor 不动。 */
      dismissSuggestions(): void {
        this.drawerOpen = false;
        this.suggestions = null;
        this.selectedIds = [];
      },
    },
  })(createPinia());
}

export type AiStore = ReturnType<typeof createAiStore>;
