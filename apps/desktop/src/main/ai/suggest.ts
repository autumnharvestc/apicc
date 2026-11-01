/** Legacy transport types only. No URL + unbound-key execution compatibility path. */
import type { AiKeyStore } from "./config.js";
export interface AiRuntimeDeps { keyStore: AiKeyStore; fetch?: typeof fetch }
export { createDesktopAiRuntime } from "./runtime.js";
