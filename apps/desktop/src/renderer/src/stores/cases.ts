import { createPinia, defineStore } from "pinia";
import type { ApiTestCase } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;
export interface CaseIdentity { caseId: string; scope: string }

/** Cases are edited as part of the active ApiAsset; selection/deletion use the physical id+scope pair. */
export function useCasesStore(_api: ApiccApi, editor: Editor) {
  return defineStore("cases", {
    state: () => ({ selectedCase: null as CaseIdentity | null }),
    getters: {
      selectedCaseId(): string | null { return this.selectedCase?.caseId ?? null; },
      selectedCaseScope(): string | null { return this.selectedCase?.scope ?? null; },
    },
    actions: {
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

      removeCase(caseId: string, scope: string): boolean {
        if (!editor.api || editor.api.cases.length <= 1) return false;
        if (editor.readOnly) throw new Error("工作区处于只读模式，不能修改用例");
        const index = editor.api.cases.findIndex((testCase) => testCase.id === caseId && testCase.scope === scope);
        if (index < 0) return false;
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

      async save(): Promise<void> {
        await editor.save();
      },
    },
  })(createPinia());
}
