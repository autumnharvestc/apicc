import { createPinia, defineStore } from "pinia";
import { resolveAiInvocation } from "@apicc/core/ai/config";
import type { AiSuggestedCase, AiConfigDocument, AiResolvedInvocation, AiPurpose, AiEvidence } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { ApiLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "./editor.js";
import { AiSettingsWriteSchema, type AiSettingsWriteInput, type AiSettingsView, type AiCatalogDto, type AiDiscoverResultDto, type AiCatalogImportInput, type AiMigrationResultDto, type AiPrepareInput, type AiContextPreviewDto, type AiProgressDto, type AiBusinessResultDto, type AiSourceRef, type AiReportRef, type AiChoicesDto, type AiChoicesPageDto } from "../../../shared/ai/contract.js";
import { aiReportDigest } from '../../../shared/ai/reportDigest.js';
import { aiFactRows, aiFactTitle, aiProgramFacts, aiSourceSections } from '../ai/presentation.js';
import { initI18n } from '../i18n/bridge.js';
import { AiPurposeSchema } from "@apicc/core/schema";

type Editor = ReturnType<typeof useEditorStore>;
export interface AiDisplayConnection { id: string; name: string; revision: number; providerId?: string }
function displayConnection(settings: AiSettingsView | null, preview: AiContextPreviewDto): AiDisplayConnection | null {
  const model = settings?.models.find(item => item.id === preview.destination.modelProfileId);
  const connection = settings?.connections.find(item => item.id === model?.connectionId);
  return connection ? { id: connection.id, name: connection.name, revision: connection.revision,
    ...(connection.templateSource ? { providerId: connection.templateSource.id } : {}) } : null;
}

export function aiPublicDocument(view: AiSettingsView): AiConfigDocument {
  return { formatVersion: 1, revision: view.revision, application: view.application,
    connections: view.connections.map(({ credentialState: _state, ...connection }) => connection),
    models: view.models, bindings: view.bindings, projectOverrides: view.projectOverrides };
}

/** Legacy nonsecret input is captured by the native migration flow; never a renderer settings repository. */
export const AI_CONFIG_STORAGE_KEY = "apicc.ai.config";
interface SuggestionTarget {
  editor: Editor;
  root: string;
  activeKey: string;
  generation: number;
  locator: ApiLocator;
  content: string;
  settingsRevision: number | null;
  source: AiSourceRef;
  sourceVersion: string | number | null;
  caseIdentity?: { caseId: string; scope: string };
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
function samePublicValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
/** Same safe host-code normalization for settings and business operations; no raw Error storage. */
function aiErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code
    : ["个人 AI 设置需要可信桌面宿主", "个人 AI 操作需要可信桌面宿主"].includes(message) ? "trusted-desktop-host-required"
    : message.match(/(?:^|Error: |（)((?:ai-|online-ai-)[a-z0-9-]+)(?:[:：）'"]|$)/)?.[1]
    ?? message.match(/(?:configuration: |（|Error: |^)([a-z][a-z0-9-]+)(?:）|['"])?$/)?.[1] ?? "invalid-configuration";
}

/** One App-created store. Personal settings use the safe host DTO only.
 * Legacy suggestion/adoption state remains until T11 migrates its business IPC.
 */
export function createAiStore(deps: {
  api: ApiccApi;
  editor: Editor;
  storage?: Storage;
  getContext?: () => { root: string; readOnly: boolean };
  getEditor?: () => Editor;
  getSource?: () => AiSourceRef | null;
  getSourceVersion?: () => string | number | null;
}) {
  const api = deps.api;
  const editor = deps.editor;
  const currentEditor = () => deps.getEditor?.() ?? editor;
  const getContext = deps.getContext ?? (() => ({
    root: currentEditor().activeKey === null ? "" : currentEditor().sessions[currentEditor().activeKey!]?.root ?? "",
    readOnly: false,
  }));
  let suggestionGeneration = 0;
  let suggestionTarget: SuggestionTarget | null = null;
  let preparedInput: AiPrepareInput | null = null;
  let choiceInput: AiPrepareInput | null = null;
  let releaseBusinessProgress: (() => void) | null = null;
  let assistanceIsCurrent: (() => boolean) | null = null;
  let authorisedEvidence: readonly AiEvidence[] = [];
  let locateReportEvidence: ((evidence: AiEvidence, authorised: readonly AiEvidence[]) => void) | undefined;
  let canLocateReportEvidence: ((evidence: AiEvidence, authorised: readonly AiEvidence[]) => boolean) | undefined;
  const activeTarget = (settingsRevision: number | null = null): SuggestionTarget | null => {
    const selectedEditor = currentEditor();
    const activeKey = selectedEditor.activeKey;
    if (activeKey === null) return null;
    const session = selectedEditor.sessions[activeKey];
    const context = getContext();
    if (!session || !context.root || session.root !== context.root) return null;
    const source = deps.getSource ? deps.getSource() : { kind: 'local' as const,
      project: { workspaceId: session.locator.workspaceId, groupId: session.locator.groupId, projectId: session.locator.projectId } };
    if (!source) return null;
    return {
      editor: selectedEditor,
      root: session.root,
      activeKey,
      generation: session.generation,
      content: JSON.stringify(session.api),
      settingsRevision,
      source: JSON.parse(JSON.stringify(source)),
      sourceVersion: deps.getSourceVersion?.() ?? null,
      locator: {
        ...session.locator,
        folderIds: [...session.locator.folderIds],
      },
    };
  };
  const targetIsCurrent = (target: SuggestionTarget, settingsRevision: number | null): boolean => {
    const current = activeTarget(settingsRevision);
    return !getContext().readOnly && current !== null
      && current.root === target.root
      && current.activeKey === target.activeKey
      && current.generation === target.generation
      && current.content === target.content
      && current.settingsRevision === target.settingsRevision
      && current.editor === target.editor
      && samePublicValue(current.source, target.source)
      && current.sourceVersion === target.sourceVersion
      && sameLocator(current.locator, target.locator);
  };
  const clearSuggestions = (state: { suggestions: AiSuggestedCase[] | null; selectedIds: string[]; drawerOpen: boolean; outboundPreview: unknown; businessResult: AiBusinessResultDto | null; contentChoices: AiChoicesDto | null }): void => {
    state.suggestions = null;
    state.selectedIds = [];
    state.drawerOpen = false;
    state.outboundPreview = null;
    state.businessResult = null;
    state.contentChoices = null; choiceInput = null;
    suggestionTarget = null;
  };
  return defineStore("ai", {
    state: () => ({
      // —— 配置（对话框）——
      configDialogOpen: false,
      settings: null as AiSettingsView | null,
      catalog: null as AiCatalogDto | null,
      catalogPreview: null as AiCatalogDto | null,
      catalogImportGeneration: 0,
      catalogImportInput: null as { file: string; document: unknown } | null,
      pendingConnectionAudienceId: null as string | null,
      migrationStatus: null as AiMigrationResultDto["status"] | null,
      settingsIssue: null as null | { code: string; field?: string; source?: string; allowed?: number | string; file?: string },
      baseUrl: "",
      model: "",
      configLoading: false,
      savingConfig: false,
      /** 保存成功提示（对话框内一次性；重新打开复位）。 */
      savedNotice: false,
      // —— 连接测试（fixture 两态）——
      testing: false,
      activeOperationId: null as string | null,
      discovery: null as AiDiscoverResultDto | null,
      testResult: null as null | "success" | "failure",
      // —— 建议（抽屉）——
      drawerOpen: false,
      outboundPreview: null as { previewId: string; preview: AiContextPreviewDto } | null,
      contentChoices: null as AiChoicesDto | null,
      contentEvidenceIds: null as string[] | null,
      assertionObservation: null as { target: ApiLocator & { caseId: string; scope: string }; basis: Extract<Extract<AiPrepareInput['selection']['business'], { purpose: 'assertion-suggestion' }>['basis'], { kind: 'observation' }>; isCurrent: () => boolean } | null,
      outboundConnection: null as AiDisplayConnection | null,
      businessOperationId: null as string | null,
      businessPurpose: 'case-suggestion' as AiPurpose,
      businessError: null as string | null,
      businessProgress: null as AiProgressDto | null,
      businessResult: null as AiBusinessResultDto | null,
      businessElapsedMs: 0,
      suggestions: null as AiSuggestedCase[] | null,
      suggestLoading: false,
      selectedIds: [] as string[],
      /** 共享错误通道（保存/测试/拉取失败文案上屏）。 */
      error: null as string | null,
    }),
    getters: {
      canSelectContentEvidence(state): boolean { return state.contentChoices !== null && choiceInput?.selection.business.purpose === 'report-analysis'; },
      canAdopt(state): boolean {
        return !getContext().readOnly
          && currentEditor().api !== null
          && (state.suggestions !== null || state.businessResult?.purpose === 'assertion-suggestion')
          && state.selectedIds.length > 0
          && suggestionTarget !== null
          && targetIsCurrent(suggestionTarget, state.settings?.revision ?? null);
      },
    },
    actions: {
      async reloadCatalog(): Promise<void> {
        try { this.catalog = await api.aiCatalogReload(); }
        catch (error) { this.settingsFailure(error); }
      },
      beginCatalogImport(): number {
        this.catalogImportGeneration++;
        this.catalogPreview = null; this.catalogImportInput = null;
        return this.catalogImportGeneration;
      },
      async previewCatalog(input: Pick<AiCatalogImportInput, "file" | "document">, generation: number): Promise<void> {
        this.error = null; this.settingsIssue = null;
        try {
          const result = await api.aiCatalogImport(input);
          if (generation === this.catalogImportGeneration) { this.catalogPreview = result; this.catalogImportInput = input; }
        } catch (error) { if (generation === this.catalogImportGeneration) this.settingsFailure(error); }
      },
      async applyCatalog(confirmConflicts: boolean): Promise<void> {
        const input = this.catalogImportInput; if (!input) return;
        const generation = this.catalogImportGeneration;
        this.error = null; this.settingsIssue = null;
        try {
          const result = await api.aiCatalogImport({ ...input, apply: true, confirmConflicts });
          if (generation !== this.catalogImportGeneration) return;
          this.catalog = result;
          this.catalogPreview = null; this.catalogImportInput = null; this.savedNotice = true;
        } catch (error) { if (generation === this.catalogImportGeneration) this.settingsFailure(error); }
      },
      resolveSettings(modelProfileId: string, purpose: AiPurpose): AiResolvedInvocation {
        if (!this.settings) throw new Error("invalid-configuration");
        return resolveAiInvocation({ document: aiPublicDocument(this.settings), modelProfileId, purpose });
      },
      settingsFailure(error: unknown): void {
        const code = aiErrorCode(error);
        this.settingsIssue = { code };
        if (typeof error === "object" && error) {
          if ("field" in error && typeof error.field === "string") this.settingsIssue.field = error.field;
          if ("source" in error && typeof error.source === "string") this.settingsIssue.source = error.source;
          if ("allowed" in error && (typeof error.allowed === "number" || typeof error.allowed === "string")) this.settingsIssue.allowed = error.allowed;
        }
        this.error = code;
      },
      businessFailure(error: unknown): void {
        this.error = aiErrorCode(error); this.businessError = this.error;
      },
      async writeSettings(input: AiSettingsWriteInput): Promise<boolean> {
        this.savingConfig = true; this.error = null; this.settingsIssue = null; this.savedNotice = false;
        try {
          const validated = AiSettingsWriteSchema.safeParse(input);
          if (!validated.success) {
            const path = validated.error.issues[0]?.path ?? [];
            this.settingsIssue = { code: "invalid-configuration", field: path.includes("headers") ? "headers" : path.includes("auth") ? "auth" : String(path.at(-1) ?? "") };
            return false;
          }
          if (input.operation === "credential" && input.mode === "persistent" && this.settings?.backend !== "available") throw new Error("secure-backend-unavailable");
          if (input.operation === "preferences" && this.settings) {
            const next = { ...aiPublicDocument(this.settings),
              ...(input.application ? { application: input.application } : {}), ...(input.models ? { models: input.models } : {}),
              ...(input.bindings ? { bindings: input.bindings } : {}), ...(input.projectOverrides ? { projectOverrides: input.projectOverrides } : {}) };
            for (const model of next.models) {
              // A binding's budgets belong to its selected model, not every profile being validated.
              // Keep all references for Core document validation, but exclude unrelated budget layers.
              const document = { ...next, bindings: next.bindings.map(binding => binding.modelProfileId === model.id ? binding : { ...binding, budgets: {} }) };
              for (const purpose of AiPurposeSchema.options) resolveAiInvocation({ document, modelProfileId: model.id, purpose });
            }
          }
          const result = await api.aiSettingsWrite(validated.data);
          if ("scope" in result) { this.settings = result; this.savedNotice = true; }
          else { this.migrationStatus = result.status; this.settings = await api.aiSettingsRead(); }
          return true;
        } catch (error) { this.settingsFailure(error); return false; }
        finally { this.savingConfig = false; }
      },
      /** App initialization reads the main-owned personal settings and provider catalog. */
      async init(): Promise<void> {
        this.configLoading = true;
        try {
          this.error = null;
          this.settingsIssue = null;
          this.settings = await api.aiSettingsRead();
          this.catalog = await api.aiCatalogReload();
        } catch (e) {
          this.settingsFailure(e);
        } finally {
          this.configLoading = false;
        }
      },


      /**
       * 连接测试（任务 2 真探测）：本地护栏（未保存 baseUrl/model 不发 IPC）→
       * ai:test-config 轻量探测——resolve → success；reject（provider 归一化错误）→
       * failure + 可读 error。
       */
      async runAuxiliary(kind: "probe" | "discover", id: string): Promise<void> {
        if (this.activeOperationId) return;
        const operationId = crypto.randomUUID(); this.activeOperationId = operationId;
        this.testing = true; this.testResult = null; this.discovery = null; this.error = null; this.settingsIssue = null;
        try {
          if (kind === "probe") {
            await api.aiConnectionTest({ operationId, modelProfileId: id });
            if (this.activeOperationId === operationId) this.testResult = "success";
          } else {
            const result = await api.aiDiscover({ operationId, connectionId: id });
            if (this.activeOperationId === operationId) this.discovery = result;
          }
        } catch (error) { if (this.activeOperationId === operationId) { this.testResult = "failure"; this.settingsFailure(error); } }
        finally { if (this.activeOperationId === operationId) { this.activeOperationId = null; this.testing = false; } }
      },
      async testConnection(modelProfileId?: string): Promise<void> {
        const id = modelProfileId ?? this.settings?.bindings[0]?.modelProfileId;
        if (!id) { this.testResult = "failure"; this.settingsFailure(new Error("missing-model")); return; }
        await this.runAuxiliary("probe", id);
      },
      async cancelAuxiliary(): Promise<void> {
        const operationId = this.activeOperationId; if (!operationId) return;
        this.activeOperationId = null; this.testing = false; this.testResult = null;
        try { await api.aiCancel({ operationId }); } catch (error) { this.settingsFailure(error); }
      },

      /** Prepare the current API through the trusted host; sending requires a separate confirmation. */
      async fetchSuggestions(caseIdentity?: { caseId: string; scope: string }, basis: Extract<AiPrepareInput['selection']['business'], { purpose: 'assertion-suggestion' }>['basis'] = { kind: 'contract' }): Promise<void> {
        const target = activeTarget(this.settings?.revision ?? null);
        if (!target || getContext().readOnly) {
          this.error = this.businessError = "ai-source-unavailable";
          return;
        }
        const session = target.editor.sessions[target.activeKey]!;
        if (caseIdentity) target.caseIdentity = { ...caseIdentity };
        const { workspaceId, groupId, projectId, collectionId, folderIds, apiId } = target.locator;
        const input: AiPrepareInput = {
          selection: { source: target.source, editGeneration: target.generation,
            business: caseIdentity
              ? { purpose: 'assertion-suggestion', target: { collectionId, folderIds, apiId, ...caseIdentity }, basis }
              : { purpose: "case-suggestion", target: { collectionId, folderIds, apiId } } },
          bodySelection: [],
          currentDraft: { sourceApiRevision: session.sourceApiRevision,
            contract: JSON.parse(JSON.stringify(session.api.contract)), documentation: session.api.documentation },
        };
        const requestGeneration = ++suggestionGeneration;
        this.suggestLoading = true;
        this.error = null;
        this.businessError = null; this.businessPurpose = input.selection.business.purpose;
        this.outboundPreview = null;
        this.businessResult = null;
        this.drawerOpen = true;
        try {
          assistanceIsCurrent = () => targetIsCurrent(target, this.settings?.revision ?? null);
          const { bodySelection: _body, evidenceSelection: _evidence, choicesId: _choices, ...captureInput } = input;
          const choices = await api.aiInspectChoices({ operation: 'capture', input: captureInput });
          if (requestGeneration !== suggestionGeneration) return;
          if (!targetIsCurrent(target, this.settings?.revision ?? null)) { clearSuggestions(this); return; }
          this.contentChoices = choices; this.contentEvidenceIds = null; choiceInput = input;
          input.choicesId = choices.choicesId;
          const prepared = await api.aiPrepareAssistance(input);
          if (requestGeneration !== suggestionGeneration) return;
          if (!targetIsCurrent(target, this.settings?.revision ?? null)) {
            clearSuggestions(this);
            return;
          }
          this.outboundPreview = prepared;
          this.outboundConnection = displayConnection(this.settings, prepared.preview);
          preparedInput = input;
          this.suggestions = null;
          this.selectedIds = [];
          this.drawerOpen = true;
          suggestionTarget = target;
          assistanceIsCurrent = () => targetIsCurrent(target, this.settings?.revision ?? null);
        } catch (e) {
          if (requestGeneration !== suggestionGeneration) return;
          if (!targetIsCurrent(target, this.settings?.revision ?? null)) {
            clearSuggestions(this);
            return;
          }
          this.businessFailure(e);
        } finally {
          if (requestGeneration === suggestionGeneration) this.suggestLoading = false;
        }
      },

      async prepareAssertions(identity: { caseId: string; scope: string }, basis?: Extract<AiPrepareInput['selection']['business'], { purpose: 'assertion-suggestion' }>['basis']): Promise<void> {
        await this.fetchSuggestions(identity, basis);
      },
      selectAssertionObservation(selection: NonNullable<typeof this.assertionObservation>): void {
        suggestionGeneration++; preparedInput = null; clearSuggestions(this);
        this.assertionObservation = selection;
      },

      async prepareReportAnalysis(input: { source: AiSourceRef; displayed?: unknown; report?: AiReportRef; baseline?: AiReportRef; isCurrent?: () => boolean; locateEvidence?: (evidence: AiEvidence, authorised: readonly AiEvidence[]) => void; canLocateEvidence?: (evidence: AiEvidence, authorised: readonly AiEvidence[]) => boolean; evidenceSelection?: string[] }): Promise<void> {
        const capturedRoot = getContext().root, revision = this.settings?.revision ?? null;
        const source: AiSourceRef = JSON.parse(JSON.stringify(input.source));
        const sourceVersion = deps.getSourceVersion?.() ?? null;
        const content = JSON.stringify(input.displayed);
        const current = () => !!capturedRoot && getContext().root === capturedRoot && !getContext().readOnly
          && (source.kind !== 'online' || !deps.getSource || samePublicValue(deps.getSource(), source))
          && (deps.getSourceVersion?.() ?? null) === sourceVersion
          && (this.settings?.revision ?? null) === revision && JSON.stringify(input.displayed) === content && (input.isCurrent?.() ?? true);
        if (!current()) { this.error = this.businessError = 'ai-source-unavailable'; return; }
        const requestGeneration = ++suggestionGeneration;
        locateReportEvidence = input.locateEvidence; canLocateReportEvidence = input.canLocateEvidence;
        this.suggestLoading = true; this.error = null; this.outboundPreview = null; this.businessResult = null; this.suggestions = null; this.selectedIds = []; this.drawerOpen = true;
        this.businessError = null; this.businessPurpose = 'report-analysis';
        try {
          const report = input.report ?? { kind: 'current' as const, expectedReportDigest: await aiReportDigest(input.displayed) };
          const prepared: AiPrepareInput = { selection: { source, editGeneration: 0,
            business: { purpose: 'report-analysis', report, ...(input.baseline ? { baseline: input.baseline } : {}) } }, bodySelection: [], ...(input.evidenceSelection ? { evidenceSelection: [...input.evidenceSelection] } : {}) };
          assistanceIsCurrent = current;
          const { bodySelection: _body, evidenceSelection: _evidence, ...captureInput } = prepared;
          const choices = await api.aiInspectChoices({ operation: 'capture', input: captureInput });
          if (requestGeneration !== suggestionGeneration) return;
          if (!current()) { clearSuggestions(this); return; }
          this.contentChoices = choices; this.contentEvidenceIds = input.evidenceSelection ? [...input.evidenceSelection] : null; choiceInput = prepared;
          prepared.choicesId = choices.choicesId;
          const preview = await api.aiPrepareAssistance(prepared);
          if (requestGeneration !== suggestionGeneration) return;
          if (!current()) { clearSuggestions(this); return; }
          this.outboundPreview = preview; preparedInput = prepared; assistanceIsCurrent = current; suggestionTarget = null; this.drawerOpen = true;
          this.outboundConnection = displayConnection(this.settings, preview.preview);
          authorisedEvidence = JSON.parse(JSON.stringify(preview.preview.evidence));
        } catch (error) { if (requestGeneration === suggestionGeneration) this.businessFailure(error); }
        finally { if (requestGeneration === suggestionGeneration) this.suggestLoading = false; }
      },

      async contentPage(section: 'evidence' | 'bodies', next = false): Promise<void> {
        const choices = this.contentChoices!, generation = suggestionGeneration;
        try {
          const page = await api.aiReadChoicesPage({ choicesId: choices.choicesId, section, ...(next ? { cursor: choices[section].nextCursor } : {}) });
          if (generation !== suggestionGeneration || !assistanceIsCurrent?.()) return;
          this.contentChoices = { ...choices, [section]: page };
        } catch (error) { if (generation === suggestionGeneration) this.businessFailure(error); }
      },
      clearContentEvidence(): void {
        suggestionGeneration++;
        this.contentEvidenceIds = []; this.outboundPreview = null; preparedInput = null;
        this.error = null; this.businessError = null;
      },
      async toggleContentEvidence(id: string): Promise<void> {
        const choices = this.contentChoices!, generation = ++suggestionGeneration;
        this.outboundPreview = null; preparedInput = null; this.error = null; this.businessError = null;
        try {
          let ids = this.contentEvidenceIds;
          if (ids === null) {
            let page = await api.aiReadChoicesPage({ choicesId: choices.choicesId, section: 'evidence', limit: 50 }) as Extract<AiChoicesPageDto, { section: 'evidence' }>;
            ids = page.items.map(item => item.id);
            while (page.nextCursor) {
              page = await api.aiReadChoicesPage({ choicesId: choices.choicesId, section: 'evidence', limit: 50, cursor: page.nextCursor }) as Extract<AiChoicesPageDto, { section: 'evidence' }>;
              ids.push(...page.items.map(item => item.id));
            }
            const first = await api.aiReadChoicesPage({ choicesId: choices.choicesId, section: 'evidence' }) as Extract<AiChoicesPageDto, { section: 'evidence' }>;
            if (generation !== suggestionGeneration || !assistanceIsCurrent?.()) return;
            this.contentChoices = { ...choices, evidence: first };
          }
          if (generation !== suggestionGeneration || !assistanceIsCurrent?.()) return;
          this.contentEvidenceIds = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
        } catch (error) { if (generation === suggestionGeneration) this.businessFailure(error); }
      },
      async toggleContentBody(location: string): Promise<void> {
        const choices = this.contentChoices!, generation = ++suggestionGeneration;
        this.outboundPreview = null; preparedInput = null; this.contentEvidenceIds = this.canSelectContentEvidence ? [] : null; this.error = null; this.businessError = null;
        const bodies = choices.bodySelection.includes(location) ? choices.bodySelection.filter(value => value !== location) : [...choices.bodySelection, location];
        try {
          const changed = await api.aiInspectChoices({ operation: 'bodies', choicesId: choices.choicesId, bodySelection: bodies });
          if (generation !== suggestionGeneration || !assistanceIsCurrent?.()) return;
          this.contentChoices = changed; choiceInput = { ...choiceInput!, bodySelection: [...changed.bodySelection], choicesId: changed.choicesId };
        } catch (error) { if (generation === suggestionGeneration) this.businessFailure(error); }
      },
      async repreviewContent(): Promise<void> {
        const choices = this.contentChoices!, generation = ++suggestionGeneration;
        this.outboundPreview = null; preparedInput = null; this.error = null; this.businessError = null; this.suggestLoading = true;
        const input: AiPrepareInput = { ...choiceInput!, choicesId: choices.choicesId, bodySelection: [...choices.bodySelection], ...(this.contentEvidenceIds === null ? {} : { evidenceSelection: [...this.contentEvidenceIds] }) };
        try {
          const prepared = await api.aiPrepareAssistance(input);
          if (generation !== suggestionGeneration || !assistanceIsCurrent?.()) return;
          this.outboundPreview = prepared; preparedInput = input;
          authorisedEvidence = JSON.parse(JSON.stringify(prepared.preview.evidence));
          this.outboundConnection = displayConnection(this.settings, prepared.preview);
        } catch (error) { if (generation === suggestionGeneration) this.businessFailure(error); }
        finally { if (generation === suggestionGeneration) this.suggestLoading = false; }
      },

      async confirmAssistance(): Promise<void> {
        const prepared = this.outboundPreview, current = assistanceIsCurrent, input = preparedInput;
        if (!prepared || !current || !input || this.businessOperationId) return;
        if (!current()) { clearSuggestions(this); return; }
        const requestGeneration = suggestionGeneration;
        const operationId = crypto.randomUUID();
        this.businessOperationId = operationId; this.businessProgress = null;
        const startedAt = performance.now(); this.businessElapsedMs = 0;
        const elapsed = setInterval(() => { this.businessElapsedMs = Math.max(0, Math.floor(performance.now() - startedAt)); }, 100);
        const unsubscribe = api.onAiProgress(progress => {
          if (this.businessOperationId === operationId && progress.operationId === operationId
            && current()) this.businessProgress = structuredClone(progress);
        });
        let subscribed = true;
        const cleanup = () => { if (subscribed) { subscribed = false; unsubscribe(); clearInterval(elapsed); this.businessElapsedMs = Math.max(0, Math.floor(performance.now() - startedAt)); } };
        releaseBusinessProgress = cleanup;
        this.suggestLoading = true; this.error = null; this.businessError = null;
        try {
          const result = await api.aiStart({ previewId: prepared.previewId, operationId, selection: input.selection });
          if (requestGeneration !== suggestionGeneration) return;
          if (!current()) { clearSuggestions(this); return; }
          if (result.purpose !== input.selection.business.purpose || result.bindingId !== prepared.preview.source.bindingId
            || !samePublicValue(result.source, prepared.preview.source)) {
            clearSuggestions(this); this.businessFailure(new Error('ai-result-binding-changed')); return;
          }
          this.businessResult = result;
          this.suggestions = result.purpose === 'case-suggestion' ? result.cases.map(candidate => structuredClone(candidate)) : null;
          this.selectedIds = []; this.outboundPreview = null; preparedInput = null;
        } catch (error) { if (requestGeneration === suggestionGeneration) this.businessFailure(error); }
        finally {
          cleanup();
          if (releaseBusinessProgress === cleanup) releaseBusinessProgress = null;
          if (this.businessOperationId === operationId) this.businessOperationId = null;
          if (requestGeneration === suggestionGeneration) this.suggestLoading = false;
        }
      },

      async cancelAssistance(): Promise<void> {
        const operationId = this.businessOperationId;
        this.businessOperationId = null;
        suggestionGeneration++; this.suggestLoading = false;
        releaseBusinessProgress?.(); releaseBusinessProgress = null;
        preparedInput = null; clearSuggestions(this);
        if (operationId) {
          try { await api.aiCancel({ operationId }); }
          catch (error) { this.businessFailure(error); }
        }
      },

      dispose(): void { void this.cancelAssistance(); },

      canLocateEvidence(id: string): boolean {
        if (this.businessResult?.purpose !== 'report-analysis' || !assistanceIsCurrent?.() || !locateReportEvidence) return false;
        const evidence = authorisedEvidence.find(item => item.id === id);
        return !!evidence && !!canLocateReportEvidence?.(evidence, authorisedEvidence);
      },

      locateEvidence(id: string): void {
        if (!this.canLocateEvidence(id)) return;
        const evidence = authorisedEvidence.find(item => item.id === id)!;
        locateReportEvidence?.(JSON.parse(JSON.stringify(evidence)), authorisedEvidence);
      },

      exportAnalysis(): { filename: string; content: string } | null {
        const result = this.businessResult;
        if (result?.purpose !== 'report-analysis') return null;
        const t = (key: string) => String(initI18n().i18n.global.t(key));
        const lines = [result.label, `${t('ai.model')}: ${result.model.modelId} (${result.model.profileId})`,
          `${t('ai.connectionIdentity')}: ${result.model.connectionId}${this.outboundConnection?.id === result.model.connectionId ? ` · ${this.outboundConnection.name}` : ''}`,
          `${t('ai.generatedAt')}: ${new Date(result.generatedAt).toISOString()} (${result.timeZone})`];
        for (const section of aiSourceSections(result.source, t)) lines.push(section.label, ...section.rows.map(row => `${row.label}: ${row.value}`));
        lines.push('', t('ai.conclusion'), result.analysis.conclusion, '', t('ai.observedFacts'));
        for (const fact of aiProgramFacts(result.evidence, result.analysis.observedFacts)) {
          lines.push(aiFactTitle(fact, t), ...aiFactRows(fact, t).map(row => `${row.label}: ${row.value}`));
        }
        lines.push(`${t('ai.modelReferences')}: ${result.analysis.observedFacts.map(fact => fact.id).join(', ') || t('ai.none')}`);
        lines.push('', t('ai.possibleCauses'), ...result.analysis.possibleCauses.map(cause => `${cause.text} (${t('ai.possibleOnly')}; ${cause.evidenceIds.join(', ')})`),
          '', t('ai.checks'), ...result.analysis.checks.map(check => `${check.text} (${check.evidenceIds.join(', ')})`), '', t('ai.limitations'), ...result.analysis.limitations, t('ai.bodyOmitted'));
        return { filename: `ai-analysis-${Date.parse(result.generatedAt)}.txt`, content: lines.join('\n') };
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
        const target = currentEditor().api;
        if (getContext().readOnly || !target || (this.suggestions === null && this.businessResult?.purpose !== 'assertion-suggestion') || this.selectedIds.length === 0) return 0;
        if (!suggestionTarget || !targetIsCurrent(suggestionTarget, this.settings?.revision ?? null)) {
          clearSuggestions(this);
          return 0;
        }
        const selected = new Set(this.selectedIds);
        let count = 0;
        if (this.businessResult?.purpose === 'assertion-suggestion') {
          const identity = suggestionTarget.caseIdentity;
          const testCase = identity && target.cases.find(item => item.id === identity.caseId && item.scope === identity.scope);
          if (!testCase) return 0;
          for (const candidate of this.businessResult.assertions) if (selected.has(candidate.assertion.id)) {
            testCase.assertions.push(JSON.parse(JSON.stringify(candidate.assertion))); count++;
          }
        }
        for (const row of this.suggestions ?? []) {
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
        this.businessResult = null;
        this.selectedIds = [];
        this.drawerOpen = false;
        suggestionTarget = null;
        return count;
      },

      /** 关闭/丢弃（零落盘）：建议与勾选清空、抽屉关闭，editor 不动。 */
      dismissSuggestions(): void {
        void this.cancelAssistance();
      },
    },
  })(createPinia());
}

export type AiStore = ReturnType<typeof createAiStore>;
