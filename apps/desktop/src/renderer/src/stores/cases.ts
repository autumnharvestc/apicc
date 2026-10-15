import { createPinia, defineStore } from "pinia";
import type { ApiTestCase, DebugFieldState } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { CaseDraftDeletion } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";
import { readSessionRestoreField } from "./debug.js";

type Editor = ReturnType<typeof useEditorStore>;
export interface CaseIdentity { caseId: string; scope: string }
type PendingCaseDelete = CaseDraftDeletion & { kind: "explicit" | "scope-migration"; replacementScope?: string; generation: number };
type PendingCaseFields = CaseIdentity & { generation: number; fields: DebugFieldState[]; originalValues: Record<string, string> };

function removePendingCaseFields(pendingBySession: Record<string, PendingCaseFields[]>, sessionKey: string | null, identity: CaseIdentity, generation?: number): void {
  if (!sessionKey) return;
  const remaining = (pendingBySession[sessionKey] ?? []).filter((item) =>
    item.caseId !== identity.caseId || item.scope !== identity.scope || (generation !== undefined && item.generation !== generation));
  if (remaining.length > 0) pendingBySession[sessionKey] = remaining;
  else delete pendingBySession[sessionKey];
}

function reconcilePendingDeletes(
  pendingDeletes: Record<string, PendingCaseDelete[]>,
  sessionKey: string,
  generation: number,
  snapshot: string,
): PendingCaseDelete[] {
  const persistedCases = (JSON.parse(snapshot) as { cases: ApiTestCase[] }).cases;
  const valid = (pendingDeletes[sessionKey] ?? []).filter((item) => item.generation === generation
    && persistedCases.some((testCase) => testCase.id === item.caseId && testCase.scope === item.scope));
  if (valid.length > 0) pendingDeletes[sessionKey] = valid;
  else delete pendingDeletes[sessionKey];
  return valid;
}

/** Cases are edited as part of the active ApiAsset; selection/deletion use the physical id+scope pair. */
export function useCasesStore(_api: ApiccApi, editor: Editor) {
  const store = defineStore("cases", {
    state: () => ({
      selectedCase: null as CaseIdentity | null,
      pendingDeletes: {} as Record<string, PendingCaseDelete[]>,
      pendingRestoreFields: {} as Record<string, PendingCaseFields[]>,
    }),
    getters: {
      selectedCaseId(): string | null { return this.selectedCase?.caseId ?? null; },
      selectedCaseScope(): string | null { return this.selectedCase?.scope ?? null; },
    },
    actions: {
      hasUnresolvedRestoreInput(sessionKey: string, generation: number): boolean {
        if (sessionKey !== editor.activeKey || editor.sessions[sessionKey]?.generation !== generation || !editor.api) return false;
        return (this.pendingRestoreFields[sessionKey] ?? []).some((item) => {
          if (item.generation !== generation) return false;
          const selected = editor.api!.cases.find((testCase) => testCase.id === item.caseId && testCase.scope === item.scope);
          if (!selected) return false;
          return item.fields.some((field) => {
            if (!field.needsInput) return false;
            if ((field.path === "request" || field.path.startsWith("request.")) && !selected.requestOverride) return false;
            return readSessionRestoreField(selected.requestOverride ?? editor.api!.contract.request, selected.parameters, field.path)
              === item.originalValues[field.path];
          });
        });
      },
      addCase(input: { name: string; scope: string }): ApiTestCase {
        if (!editor.api) throw new Error("未加载接口");
        if (editor.readOnly) throw new Error("工作区处于只读模式，不能修改用例");
        const created: ApiTestCase = {
          id: crypto.randomUUID(),
          name: input.name,
          scope: input.scope,
          parameters: {},
          preOperations: [],
          postOperations: [],
          assertions: [],
        };
        editor.api.cases.push(created);
        this.selectedCase = { caseId: created.id, scope: created.scope };
        return created;
      },

      changeScope(caseId: string, currentScope: string, nextScope: string): boolean {
        if (!editor.api) return false;
        if (editor.readOnly) throw new Error("工作区处于只读模式，不能修改用例");
        if (currentScope === nextScope) return true;
        const target = editor.api.cases.find((testCase) => testCase.id === caseId && testCase.scope === currentScope);
        if (!target) return false;
        if (editor.api.cases.some((testCase) => testCase.id === caseId && testCase.scope === nextScope)) {
          throw new Error(`用例 ${caseId} 已存在 scope ${nextScope}`);
        }
        const sessionKey = editor.activeKey;
        const session = sessionKey ? editor.sessions[sessionKey] : undefined;
        if (sessionKey && session) {
          this.pendingRestoreFields[sessionKey] = (this.pendingRestoreFields[sessionKey] ?? [])
            .filter((item) => item.generation === session.generation)
            .map((item) => item.caseId === caseId && item.scope === currentScope
              ? { ...item, scope: nextScope }
              : item);
          if (this.pendingRestoreFields[sessionKey]!.length === 0) delete this.pendingRestoreFields[sessionKey];
          const originalCases = (JSON.parse(session.snapshot) as { cases: ApiTestCase[] }).cases;
          const pending = reconcilePendingDeletes(this.pendingDeletes, sessionKey, session.generation, session.snapshot);
          const migration = pending.find((item) => item.kind === "scope-migration"
            && item.caseId === caseId && item.replacementScope === currentScope);
          if (migration) {
            if (migration.scope === nextScope) {
              this.pendingDeletes[sessionKey] = pending.filter((item) => item !== migration);
              if (this.pendingDeletes[sessionKey]!.length === 0) delete this.pendingDeletes[sessionKey];
            } else migration.replacementScope = nextScope;
          } else if (originalCases.some((item) => item.id === caseId && item.scope === currentScope)
            && !pending.some((item) => item.kind === "explicit" && item.caseId === caseId && item.scope === currentScope)) {
            pending.push({ kind: "scope-migration", caseId, scope: currentScope, replacementScope: nextScope, generation: session.generation });
          }
          if (pending.length > 0) this.pendingDeletes[sessionKey] = pending;
        }
        target.scope = nextScope;
        this.selectedCase = { caseId, scope: nextScope };
        return true;
      },

      removeCase(caseId: string, scope: string): boolean {
        if (!editor.api || editor.api.cases.length <= 1) return false;
        if (editor.readOnly) throw new Error("工作区处于只读模式，不能修改用例");
        const index = editor.api.cases.findIndex((testCase) => testCase.id === caseId && testCase.scope === scope);
        if (index < 0) return false;
        const sessionKey = editor.activeKey;
        const session = sessionKey ? editor.sessions[sessionKey] : undefined;
        removePendingCaseFields(this.pendingRestoreFields, sessionKey, { caseId, scope });
        if (sessionKey && session) {
          const persistedCases = (JSON.parse(session.snapshot) as { cases: ApiTestCase[] }).cases;
          const pending = reconcilePendingDeletes(this.pendingDeletes, sessionKey, session.generation, session.snapshot);
          const migration = pending.find((item) => item.kind === "scope-migration"
            && item.caseId === caseId && item.replacementScope === scope);
          if (migration) {
            migration.kind = "explicit";
            delete migration.replacementScope;
          } else if (persistedCases.some((item) => item.id === caseId && item.scope === scope)
            && !pending.some((item) => item.kind === "explicit" && item.caseId === caseId && item.scope === scope)) {
            pending.push({ kind: "explicit", caseId, scope, generation: session.generation });
          }
          if (pending.length > 0) this.pendingDeletes[sessionKey] = pending;
        }
        editor.api.cases.splice(index, 1);
        if (this.selectedCase?.caseId === caseId && this.selectedCase.scope === scope) {
          const next = editor.api.cases[0]!;
          this.selectedCase = { caseId: next.id, scope: next.scope };
        }
        return true;
      },

      select(caseId: string, scope: string): void {
        if (!editor.api?.cases.some((testCase) => testCase.id === caseId && testCase.scope === scope)) return;
        this.selectedCase = { caseId, scope };
      },

      setPendingRestoreFields(identity: CaseIdentity, fields: DebugFieldState[], originalValues: Record<string, string>): void {
        const sessionKey = editor.activeKey;
        const session = sessionKey ? editor.sessions[sessionKey] : undefined;
        removePendingCaseFields(this.pendingRestoreFields, sessionKey, identity);
        if (!sessionKey || !session || !fields.some((field) => field.needsInput)) return;
        this.pendingRestoreFields[sessionKey] ??= [];
        this.pendingRestoreFields[sessionKey]!.push({
          ...identity,
          generation: session.generation,
          fields: fields.filter((field) => field.needsInput).map((field) => ({ ...field })),
          originalValues: { ...originalValues },
        });
      },

      clearRequestRestoreFields(identity: CaseIdentity): void {
        const sessionKey = editor.activeKey;
        if (!sessionKey) return;
        const pending = this.pendingRestoreFields[sessionKey] ?? [];
        const target = pending.find((item) => item.caseId === identity.caseId && item.scope === identity.scope);
        if (!target) return;
        target.fields = target.fields.filter((field) => field.path !== "request" && !field.path.startsWith("request."));
        for (const field of Object.keys(target.originalValues)) {
          if (field === "request" || field.startsWith("request.")) delete target.originalValues[field];
        }
        if (target.fields.length === 0) removePendingCaseFields(this.pendingRestoreFields, sessionKey, identity);
      },

      async save(): Promise<void> {
        const selectedIdentity = this.selectedCase ?? (editor.api?.cases[0] ? { caseId: editor.api.cases[0]!.id, scope: editor.api.cases[0]!.scope } : null);
        const identity = selectedIdentity ? { ...selectedIdentity } : null;
        if (!identity) return;
        const sessionKey = editor.activeKey;
        const session = sessionKey ? editor.sessions[sessionKey] : undefined;
        const pending = sessionKey && session
          ? reconcilePendingDeletes(this.pendingDeletes, sessionKey, session.generation, session.snapshot)
          : [];
        const submitted = pending.filter((item) => item.kind === "explicit"
          || (item.kind === "scope-migration" && item.caseId === identity.caseId && item.replacementScope === identity.scope));
        const deletedCases = submitted.map(({ caseId, scope }) => ({ caseId, scope }));
        const selected = editor.api?.cases.find((testCase) => testCase.id === identity.caseId && testCase.scope === identity.scope);
        const generation = session?.generation;
        const submittedRestoreFields = sessionKey && session && selected
          ? (this.pendingRestoreFields[sessionKey] ?? []).filter((item) => item.generation === generation
            && item.caseId === identity.caseId && item.scope === identity.scope)
          : [];
        const pendingFields = sessionKey && session && selected
          ? submittedRestoreFields
            .flatMap((item) => {
              const current = item.fields.filter((field) => {
                if (field.path === "request" || field.path.startsWith("request.")) {
                  if (!selected.requestOverride) return false;
                  return readSessionRestoreField(selected.requestOverride, selected.parameters, field.path)
                    === item.originalValues[field.path];
                }
                return readSessionRestoreField(selected.requestOverride ?? editor.api!.contract.request, selected.parameters, field.path)
                  === item.originalValues[field.path];
              });
              item.fields = current;
              return current.map((field) => ({ ...field }));
            })
          : [];
        await editor.saveCaseDraft(identity, deletedCases, pendingFields);
        if (sessionKey) {
          // An application during the await replaces its record, even within the same generation.
          const remaining = (this.pendingRestoreFields[sessionKey] ?? []).filter((item) =>
            item.generation !== generation || !submittedRestoreFields.includes(item));
          if (remaining.length > 0) this.pendingRestoreFields[sessionKey] = remaining;
          else delete this.pendingRestoreFields[sessionKey];
        }
        if (sessionKey && this.pendingDeletes[sessionKey]) {
          const savedKeys = new Set(submitted.map((item) => `${item.kind}\0${item.caseId}\0${item.scope}\0${item.generation}`));
          this.pendingDeletes[sessionKey] = this.pendingDeletes[sessionKey]!.filter((item) =>
            !savedKeys.has(`${item.kind}\0${item.caseId}\0${item.scope}\0${item.generation}`));
          if (this.pendingDeletes[sessionKey]!.length === 0) delete this.pendingDeletes[sessionKey];
        }
      },
    },
  })(createPinia());
  editor.registerFullAssetSaveGuard(() => {
    const sessionKey = editor.activeKey;
    const session = sessionKey ? editor.sessions[sessionKey] : undefined;
    if (sessionKey && session && store.hasUnresolvedRestoreInput(sessionKey, session.generation)) {
      throw new Error("请先补齐调试恢复字段，再保存接口。");
    }
  });
  return store;
}
