import { createPinia, defineStore } from "pinia";
import type { StressThresholds } from "@apicc/core";
import type { ApiccApi, DesktopStressReport, StressRunInput } from "../../../shared/types.js";

export interface PendingStressConfirmation {
  origin: string;
  apiId: string;
  projectId: string;
  generation: number;
  token: number;
}

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
  thresholds: StressThresholds;
  connectionMode: "pooled" | "fresh";
}

/** form 默认值集中定义（计划步骤 2）：并发 1、迭代模式、迭代 10 次/时长 10 秒。 */
export function createStressFormDefaults(): StressForm {
  return {
    caseId: null, envName: null, concurrency: 1, mode: "iterations", iterations: 10, durationSeconds: 10,
    thresholds: {}, connectionMode: "pooled",
  };
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
export function createStressStore(deps: {
  api: ApiccApi;
  resolveProjectId?: (apiId: string) => string | null;
  trustOrigin?: (projectId: string, origin: string) => Promise<void>;
}) {
  const { api } = deps;
  return defineStore("stress", {
    state: () => ({
      running: false,
      report: null as DesktopStressReport | null,
      file: null as string | null,
      error: null as string | null,
      form: createStressFormDefaults(),
      generation: 0,
      confirmedTargetOrigins: [] as string[],
      pendingTargetOrigin: null as string | null,
      pendingConfirmation: null as PendingStressConfirmation | null,
      attemptToken: 0,
      confirmationInFlight: false,
    }),
    actions: {
      resetAttemptContext() {
        this.confirmedTargetOrigins = [];
        this.pendingTargetOrigin = null;
        this.pendingConfirmation = null;
        this.confirmationInFlight = false;
      },
      invalidateAttempt() {
        this.generation += 1;
        this.attemptToken += 1;
        this.running = false;
        this.resetAttemptContext();
      },
      async runAttempt(apiId: string, token: number) {
        if (this.running) return;
        const caseId = this.form.caseId;
        if (!caseId) return;
        const gen = this.generation;
        const projectId = deps.resolveProjectId?.(apiId);
        if (!projectId) {
          this.error = "未找到接口所属项目";
          this.resetAttemptContext();
          return;
        }
        this.running = true;
        this.error = null;
        try {
          const input: StressRunInput = {
            apiId,
            caseId,
            envName: this.form.envName ?? undefined,
            concurrency: this.form.concurrency,
            maxIterations: this.form.mode === "iterations" ? this.form.iterations : null,
            durationMs: this.form.mode === "duration" ? this.form.durationSeconds * 1000 : null,
            ...(Object.keys(this.form.thresholds).length > 0 ? { thresholds: { ...this.form.thresholds } } : {}),
            ...(this.form.connectionMode !== "pooled" ? { connectionMode: this.form.connectionMode } : {}),
            ...(this.confirmedTargetOrigins.length > 0 ? { confirmedTargetOrigins: [...this.confirmedTargetOrigins] } : {}),
          };
          const out = await deps.api.stressRun(input);
          if (gen !== this.generation) return;
          if (!out.ok) {
            if (out.error.code === "target_confirmation_required" && out.error.targetOrigin) {
              this.pendingTargetOrigin = out.error.targetOrigin;
              this.pendingConfirmation = { origin: out.error.targetOrigin, apiId, projectId, generation: gen, token };
              return;
            }
            const failure = Object.assign(new Error(out.error.message), out.error);
            this.error = failure.message;
            this.resetAttemptContext();
            throw failure;
          }
          this.report = out.report;
          this.file = out.file ?? null;
          this.resetAttemptContext();
        } catch (e) {
          if (gen !== this.generation) return;
          this.error = e instanceof Error ? e.message : String(e);
          this.resetAttemptContext();
          throw e;
        } finally {
          if (gen === this.generation) this.running = false;
        }
      },
      async start(apiId: string) {
        if (this.running) return;
        this.invalidateAttempt();
        const token = this.attemptToken;
        return this.runAttempt(apiId, token);
      },
      async confirmTarget(apiId: string, trustProject: boolean) {
        const pending = this.pendingConfirmation;
        if (!pending || pending.origin !== this.pendingTargetOrigin || pending.apiId !== apiId || pending.generation !== this.generation || pending.token !== this.attemptToken || this.confirmationInFlight) return;
        this.confirmationInFlight = true;
        try {
          if (trustProject) {
            if (!deps.trustOrigin) throw new Error("缺少项目目标信任持久化能力");
            await deps.trustOrigin(pending.projectId, pending.origin);
          }
          if (!this.pendingConfirmation || this.pendingConfirmation.token !== pending.token || pending.generation !== this.generation || pending.apiId !== apiId) return;
          if (!this.confirmedTargetOrigins.includes(pending.origin)) this.confirmedTargetOrigins.push(pending.origin);
          this.pendingTargetOrigin = null;
          this.pendingConfirmation = null;
          this.confirmationInFlight = false;
          return this.runAttempt(apiId, pending.token);
        } catch (error) {
          if (pending.generation === this.generation && pending.token === this.attemptToken) {
            this.error = error instanceof Error ? error.message : String(error);
            this.invalidateAttempt();
          }
          throw error;
        } finally {
          if (pending.generation === this.generation && pending.token === this.attemptToken) this.confirmationInFlight = false;
        }
      },
      denyTarget() {
        this.invalidateAttempt();
      },
      async stop() {
        const gen = this.generation;
        try {
          const out = await deps.api.stressStop();
          if (gen !== this.generation) return;
          this.report = out.report;
          this.file = out.file ?? null;
          this.error = null;
        } catch (e) {
          if (gen !== this.generation) return;
          this.error = e instanceof Error ? e.message : String(e);
          this.invalidateAttempt();
          throw e;
        } finally {
          if (gen === this.generation) this.invalidateAttempt();
        }
      },
      /** 清空当前展示（报告/file/错误），form 保留；generation 自增使在途旧 run 失效——
       * 切换接口/工作区等场景由组合根按需调用。 */
      clear() {
        this.invalidateAttempt();
        this.report = null;
        this.file = null;
        this.error = null;
      },
    },
  })(createPinia());
}
