import { createPinia, defineStore } from "pinia";
import type { TestCase } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;

/**
 * 用例 store 工厂：接受依赖 api/editor 参数（api 参数为后续调试/持久化扩展预留，
 * 选中与增删直接编辑 editor.api.cases），每次工厂调用绑定独立 Pinia 实例。
 * 修正（相对简报实现，两处）：
 * 1. id 用浏览器全局 crypto.randomUUID()（jsdom/Node ≥19 均有）——渲染层不可导入 node:crypto；
 * 2. 工厂统一 `(createPinia())` 收口（与 workspace/editor/envs 同款）——简报 `(api, editor)`
 *    会把非 Pinia 实例当 pinia 注册表（pinia._s 不存在必抛错）。
 * 语义：至少保留一个用例（最后一个拒绝删除）；增删改直接写 editor.api（dirty 由
 * editor 的快照比对 getter 自动跟踪）；save 委托 editor.save（apiSave 持久化 + 复位快照）。
 */
export function useCasesStore(api: ApiccApi, editor: Editor) {
  return defineStore("cases", {
    state: () => ({ selectedCaseId: null as string | null }),
    actions: {
      addCase(input: { name: string; scope: string }) {
        if (!editor.api) throw new Error("未加载接口");
        const created: TestCase = {
          id: crypto.randomUUID(),
          name: input.name,
          scope: input.scope,
          parameters: {},
          assertions: [],
        };
        editor.api.cases.push(created);
        this.selectedCaseId = created.id;
        return created;
      },
      removeCase(caseId: string): boolean {
        if (!editor.api || editor.api.cases.length <= 1) return false;
        const index = editor.api.cases.findIndex((c) => c.id === caseId);
        if (index < 0) return false;
        editor.api.cases.splice(index, 1);
        if (this.selectedCaseId === caseId) this.selectedCaseId = editor.api.cases[0]!.id;
        return true;
      },
      select(caseId: string) {
        this.selectedCaseId = caseId;
      },
      async save() {
        await editor.save();
      },
    },
  })(createPinia());
}
