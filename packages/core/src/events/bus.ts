/** 执行生命周期事件载荷。request 为可变引用，钩子直接修改即生效（规格 §5.2）。 */
export interface RunEventMap {
  beforeRun: { collectionName: string; envName?: string };
  beforeCase: { apiName: string; caseName: string; row?: number };
  beforeRequest: { request: unknown };
  afterResponse: { status: number; timeMs: number };
  afterCase: { apiName: string; caseName: string; passed: boolean };
  afterRun: { total: number; passed: number; failed: number };
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
