/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 分离部署时的 API 根地址（裁定③）；缺省 = 同源 `/api/v1`（开发经 vite 代理转发）。 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
