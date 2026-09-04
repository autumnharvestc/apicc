import { createPinia, defineStore } from "pinia";
import type { StressReport } from "@apicc/core";
import type { ApiccApi, StressRunInput } from "../../../shared/types.js";

/**
 * 压测表单状态（简报裁定 A）：mode 决定 start 组装哪个终止条件——
 * iterations → 只传 maxIterations、duration → 只传 durationMs（未选维度传 null，
 * 与 StressRunInput「二者可传 null」契约一致）。caseId/envName 由面板选择器回填。
 */
export interface StressForm {
  caseId: string | null;
  envName: string | null;
  concurrency: number;
  mode: "iterations" | "duration";
  iterations: number;
  durationSeconds: number;
}

/** form 默认值集中定义（计划步骤 2）：并发 1、迭代模式、迭代 10 次/时长 10 秒。 */
export function createStressFormDefaults(): StressForm {
  return { caseId: null, envName: null, concurrency: 1, mode: "iterations", iterations: 10, durationSeconds: 10 };
}

/**
 * 压测 store 工厂（M2-D3 任务 2，裁定 A）：接受依赖 api 参数（deps 对象），每次工厂调用
 * 绑定独立 Pinia 实例（测试传新实例即天然隔离，两实例互不可见）。start 按 form.mode 组装
 * 载荷发起 api.stressRun；成功报告 + file 上屏（file 省略 = 落盘降级，file 复位 null）；
 * 失败置 error 且老报告保留（debug 错误语义），同时向组件层重抛（转报组合根 reportError
 * 通道，EnvPanel/RunView 同款收口）；running 无论成败都在 finally 复位。stop 返回的部分
 * 报告同样上屏。组件内零工厂调用：store 实例经 props 注入（任务 3 App 装配）。
 * 代际令牌（终审修复）：clear() 自增 generation；start/stop 在 await 前捕获、返回后比对，
 * 不等即视为陈旧会话（运行中切接口/切工作区被组合根 clear）——其完成结果与拒绝一律不上屏、
 * 不置 error、不向组件层外抛，防止旧接口的报告/错误错挂进新面板。
 */
export function createStressStore(deps: { api: ApiccApi }) {
  const { api } = deps;
  return defineStore("stress", {
    state: () => ({
      running: false,
      report: null as StressReport | null,
      file: null as string | null,
      error: null as string | null,
      form: createStressFormDefaults(),
      generation: 0,
    }),
    actions: {
      async start(apiId: string) {
        if (this.running) return;
        const caseId = this.form.caseId;
        if (!caseId) return;
        this.running = true;
        this.error = null;
        const gen = this.generation;
        try {
          const input: StressRunInput = {
            apiId,
            caseId,
            envName: this.form.envName ?? undefined,
            concurrency: this.form.concurrency,
            maxIterations: this.form.mode === "iterations" ? this.form.iterations : null,
            durationMs: this.form.mode === "duration" ? this.form.durationSeconds * 1000 : null,
          };
          const out = await api.stressRun(input);
          if (gen !== this.generation) return;
          this.report = out.report;
          this.file = out.file ?? null;
        } catch (e) {
          if (gen !== this.generation) return;
          this.error = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          this.running = false;
        }
      },
      async stop() {
        const gen = this.generation;
        try {
          const out = await api.stressStop();
          if (gen !== this.generation) return;
          this.report = out.report;
          this.file = out.file ?? null;
          this.error = null;
        } catch (e) {
          if (gen !== this.generation) return;
          this.error = e instanceof Error ? e.message : String(e);
          throw e;
        }
      },
      /** 清空当前展示（报告/file/错误），form 保留；generation 自增使在途旧 run 失效——
       * 切换接口/工作区等场景由组合根按需调用。 */
      clear() {
        this.generation += 1;
        this.report = null;
        this.file = null;
        this.error = null;
      },
    },
  })(createPinia());
}
