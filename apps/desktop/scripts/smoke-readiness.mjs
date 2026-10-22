// Target discovery and actual document readiness share the caller's original deadline.
export async function waitForRendererReady({ deadline, observe, isAlive, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let last = null;
  let lastError = "";
  while (now() < deadline) {
    if (!isAlive()) throw new Error("renderer 就绪前进程提前退出");
    try {
      const state = await observe(Math.min(5000, deadline - now()));
      if (state) last = state;
      lastError = "";
      if (!isAlive()) throw new Error("renderer 就绪前进程提前退出");
      if (now() < deadline && state
        && /^file:.*\/app\.asar\/dist-renderer\/index\.html(?:[?#]|$)/i.test(state.url)
        && ["interactive", "complete"].includes(state.readyState)
        && typeof state.title === "string" && state.title.toLowerCase().includes("apicc")
        && typeof state.children === "number" && state.children > 0) return state;
    } catch (error) {
      if (error?.code === "ERR_CDP_PROTOCOL") throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (!isAlive()) throw new Error("renderer 就绪前进程提前退出");
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(500, remaining));
  }
  throw new Error(`renderer 就绪超时；最后观测=${JSON.stringify(last)}${lastError ? `；最后错误=${lastError}` : ""}`);
}
