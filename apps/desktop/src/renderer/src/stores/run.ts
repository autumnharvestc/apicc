import { createPinia, defineStore } from "pinia";
import type { RunResult } from "@apicc/core";
import type { ApiccApi, RunSummaryDTO, StressReportDTO, StressRunSummaryDTO } from "../../../shared/types.js";

/**
 * 运行 store 工厂：接受依赖 api 参数（测试传新实例即天然隔离），每次工厂调用绑定
 * 独立 Pinia 实例。状态：running（运行门控，进行中重复触发直接忽略）、result（当前
 * 展示的完整 RunResult——runCollection 产出或 openRun 从历史读回）、summaries（运行
 * 历史摘要，新→旧，M2-D3 起含压测行联合）、historyOpen（历史抽屉开关）、stressReport
 * （runs:get 读回的压测报告，M2-D3 任务 3：RunsHistory 内嵌 StressReportView 复位前持有）。
 * 失败时错误上抛由组件层捕获转报组合根错误通道（EnvPanel 同款），running 无论成败都在
 * finally 复位。
 */
export function useRunStore(api: ApiccApi) {
  return defineStore("run", {
    state: () => ({
      running: false,
      result: null as RunResult | null,
      summaries: [] as Array<RunSummaryDTO | StressRunSummaryDTO>,
      historyOpen: false,
      stressReport: null as StressReportDTO | null,
    }),
    actions: {
      async runCollection(collectionId: string, envName?: string) {
        if (this.running) return;
        this.running = true;
        try {
          this.result = await api.runCollection({ collectionId, envName });
        } finally {
          this.running = false;
        }
      },
      async loadHistory() {
        this.summaries = await api.runsList();
      },
      async openRun(file: string) {
        const run = await api.runsGet(file);
        if (!run) return;
        // kind 判别（M2-D3 任务 1 联合分支）：集合运行回填 RunView 表格；压测报告入
        // stressReport（任务 3 裁定 B：运行历史抽屉内嵌 StressReportView 展示）。
        if ("kind" in run) this.stressReport = run;
        else this.result = run;
      },
    },
  })(createPinia());
}
