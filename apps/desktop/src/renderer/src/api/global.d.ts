import type { ApiccApi } from "../../../shared/types.js";

declare global {
  interface Window {
    /** 主进程经 contextBridge 暴露的类型化 API（preload.ts），渲染层经 api/index.ts 消费。 */
    apicc: ApiccApi;
  }
}
