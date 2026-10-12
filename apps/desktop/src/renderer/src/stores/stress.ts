import { createPinia, defineStore } from "pinia";
import type { StressThresholds } from "@apicc/core";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { ApiccApi, DesktopStressReport, StressRunInput } from "../../../shared/types.js";
import { apiSessionKey } from "./localIdentity.js";

export interface PendingStressConfirmation {
  origin: string;
  locator: ApiLocator;
  projectLocator: ProjectLocator;
  root: string;
  sessionKey: string;
  generation: number;
  token: number;
}

export interface StressContext {
  root: string;
  locator: ApiLocator | null;
}

/**
 * 压测表单状态：mode 决定 start 组装哪个终止条件；用例/环境由当前接口上下文驱动。
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

export function createStressFormDefaults(): StressForm {
  return {
    caseId: null, envName: null, concurrency: 1, mode: "iterations", iterations: 10, durationSeconds: 10,
    thresholds: {}, connectionMode: "pooled",
  };
}

function copyApiLocator(locator: ApiLocator): ApiLocator {
  return {
    workspaceId: locator.workspaceId,
    groupId: locator.groupId,
    projectId: locator.projectId,
    collectionId: locator.collectionId,
    folderIds: [...locator.folderIds],
    apiId: locator.apiId,
  };
}

function projectOf(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function sessionFor(context: StressContext, locator: ApiLocator): PendingStressConfirmation | null {
  if (!context.root || !context.locator) return null;
  const actualKey = apiSessionKey(context.root, context.locator);
  const submittedLocator = copyApiLocator(locator);
  const submittedKey = apiSessionKey(context.root, submittedLocator);
  if (actualKey !== submittedKey) return null;
  return {
    origin: "",
    locator: submittedLocator,
    projectLocator: projectOf(submittedLocator),
    root: context.root,
    sessionKey: submittedKey,
    generation: 0,
    token: 0,
  };
}

/** Store for the currently selected local API. Root + complete API locator fence every async result. */
export function createStressStore(deps: {
  api: ApiccApi;
  getContext: () => StressContext;
  trustOrigin?: (locator: ProjectLocator, origin: string) => Promise<void>;
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
      activeRoot: null as string | null,
      activeSessionKey: null as string | null,
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
        this.activeRoot = null;
        this.activeSessionKey = null;
        this.resetAttemptContext();
      },
      isCurrent(root: string, sessionKey: string, generation: number): boolean {
        if (generation !== this.generation || root !== this.activeRoot || sessionKey !== this.activeSessionKey) return false;
        const context = deps.getContext();
        return context.root === root && !!context.locator && apiSessionKey(root, context.locator) === sessionKey;
      },
      async runAttempt(snapshot: PendingStressConfirmation, token: number) {
        if (this.running) return;
        const caseId = this.form.caseId;
        if (!caseId) return;
        const { locator, projectLocator, root, sessionKey } = snapshot;
        const generation = this.generation;
        if (!this.isCurrent(root, sessionKey, generation)) return;
        this.running = true;
        this.error = null;
        try {
          const input: StressRunInput = {
            locator: copyApiLocator(locator),
            caseId,
            envName: this.form.envName ?? undefined,
            concurrency: this.form.concurrency,
            maxIterations: this.form.mode === "iterations" ? this.form.iterations : null,
            durationMs: this.form.mode === "duration" ? this.form.durationSeconds * 1000 : null,
            ...(Object.keys(this.form.thresholds).length > 0 ? { thresholds: { ...this.form.thresholds } } : {}),
            ...(this.form.connectionMode !== "pooled" ? { connectionMode: this.form.connectionMode } : {}),
            ...(this.confirmedTargetOrigins.length > 0 ? { confirmedTargetOrigins: [...this.confirmedTargetOrigins] } : {}),
          };
          const out = await api.stressRun(input);
          if (!this.isCurrent(root, sessionKey, generation)) return;
          if (!out.ok) {
            if (out.error.code === "target_confirmation_required" && out.error.targetOrigin) {
              this.pendingTargetOrigin = out.error.targetOrigin;
              this.pendingConfirmation = {
                origin: out.error.targetOrigin,
                locator: copyApiLocator(locator),
                projectLocator: { ...projectLocator },
                root,
                sessionKey,
                generation,
                token,
              };
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
        } catch (error) {
          if (!this.isCurrent(root, sessionKey, generation)) return;
          this.error = error instanceof Error ? error.message : String(error);
          this.resetAttemptContext();
          throw error;
        } finally {
          if (generation === this.generation && this.activeSessionKey === sessionKey) {
            this.running = false;
            if (!this.isCurrent(root, sessionKey, generation)) this.invalidateAttempt();
          }
        }
      },
      async start(locator: ApiLocator) {
        if (this.running) return;
        this.invalidateAttempt();
        const snapshot = sessionFor(deps.getContext(), locator);
        if (!snapshot) {
          this.error = "当前接口定位已切换，请重新选择接口";
          return;
        }
        this.activeRoot = snapshot.root;
        this.activeSessionKey = snapshot.sessionKey;
        const token = this.attemptToken;
        return this.runAttempt(snapshot, token);
      },
      async confirmTarget(locator: ApiLocator, trustProject: boolean) {
        const pending = this.pendingConfirmation;
        const active = sessionFor(deps.getContext(), locator);
        if (!pending || !active || pending.origin !== this.pendingTargetOrigin
          || pending.sessionKey !== active.sessionKey || pending.root !== active.root
          || pending.sessionKey !== this.activeSessionKey || pending.root !== this.activeRoot
          || pending.generation !== this.generation || pending.token !== this.attemptToken
          || this.confirmationInFlight) return;
        this.confirmationInFlight = true;
        try {
          if (trustProject) {
            if (!deps.trustOrigin) throw new Error("缺少项目目标信任持久化能力");
            await deps.trustOrigin({ ...pending.projectLocator }, pending.origin);
          }
          if (!this.isCurrent(pending.root, pending.sessionKey, pending.generation)
            || !this.pendingConfirmation || this.pendingConfirmation.token !== pending.token) return;
          if (!this.confirmedTargetOrigins.includes(pending.origin)) this.confirmedTargetOrigins.push(pending.origin);
          this.pendingTargetOrigin = null;
          this.pendingConfirmation = null;
          this.confirmationInFlight = false;
          return this.runAttempt(pending, pending.token);
        } catch (error) {
          if (!this.isCurrent(pending.root, pending.sessionKey, pending.generation)
            || pending.token !== this.attemptToken) return;
          this.error = error instanceof Error ? error.message : String(error);
          this.invalidateAttempt();
          throw error;
        } finally {
          if (pending.generation === this.generation && pending.token === this.attemptToken
            && pending.sessionKey === this.activeSessionKey) this.confirmationInFlight = false;
        }
      },
      denyTarget() {
        this.invalidateAttempt();
      },
      async stop(locator: ApiLocator) {
        const snapshot = sessionFor(deps.getContext(), locator);
        if (!snapshot || !this.running || snapshot.root !== this.activeRoot || snapshot.sessionKey !== this.activeSessionKey) return;
        const generation = this.generation;
        try {
          const out = await api.stressStop();
          if (!this.isCurrent(snapshot.root, snapshot.sessionKey, generation)) return;
          this.report = out.report;
          this.file = out.file ?? null;
          this.error = null;
        } catch (error) {
          if (!this.isCurrent(snapshot.root, snapshot.sessionKey, generation)) return;
          this.error = error instanceof Error ? error.message : String(error);
          this.invalidateAttempt();
          throw error;
        } finally {
          if (generation === this.generation && snapshot.sessionKey === this.activeSessionKey) this.invalidateAttempt();
        }
      },
      clear() {
        this.invalidateAttempt();
        this.report = null;
        this.file = null;
        this.error = null;
      },
    },
  })(createPinia());
}
