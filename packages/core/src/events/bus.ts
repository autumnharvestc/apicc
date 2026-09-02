import type { RunResult } from "../report/types.js";

/**
 * 执行生命周期事件载荷。request 为可变引用，钩子直接修改即生效（规格 §5.2）。
 * 载荷契约增量（规格 §5.2 裁定）：用例级事件携带 apiId/caseId 标识；afterCase 另带
 * row/durationMs/error；afterRun 可携带完整 RunResult 引用；afterResponse 可携带
 * headers/bodyText 响应快照（desktop 调试视图消费）。新增字段全部可选，
 * 保证既有处理器与 M2/M3 沿用时无需破坏性变更。
 */
export interface RunEventMap {
  beforeRun: { collectionName: string; envName?: string };
  beforeCase: { apiName: string; caseName: string; apiId?: string; caseId?: string; row?: number };
  beforeRequest: { request: unknown };
  afterResponse: { status: number; timeMs: number; headers?: Record<string, string>; bodyText?: string };
  afterCase: {
    apiName: string; caseName: string; passed: boolean;
    apiId?: string; caseId?: string; row?: number; durationMs?: number; error?: string;
  };
  afterRun: { total: number; passed: number; failed: number; result?: RunResult };
}

export type EventName = keyof RunEventMap;
type Handler<K extends EventName> = (payload: RunEventMap[K]) => void | Promise<void>;

export interface EventBus {
  on<K extends EventName>(type: K, handler: Handler<K>): () => void;
  emit<K extends EventName>(type: K, payload: RunEventMap[K]): Promise<void>;
}

export function createEventBus(): EventBus {
  const handlers = new Map<EventName, Set<Handler<EventName>>>();
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler as Handler<EventName>);
      handlers.set(type, set);
      return () => set.delete(handler as Handler<EventName>);
    },
    async emit(type, payload) {
      for (const h of handlers.get(type) ?? []) {
        try {
          await h(payload);
        } catch (e) {
          throw new Error(`事件 ${type} 处理器失败: ${(e as Error).message}`);
        }
      }
    },
  };
}
