import { loadDeployment } from "./config.js";
import { bootstrapAgent } from "./bootstrap.js";
const configurationPath = process.argv[2];
if (!configurationPath) { process.stderr.write("Usage: runner-agent <absolute deployment configuration path>\n"); process.exitCode = 2; }
else {
  const controller = new AbortController(); const stop = () => controller.abort(new Error("Agent shutdown requested"));
  const fault = () => { process.exitCode = 1; controller.abort(new Error("Agent process fault")); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.once("uncaughtException", fault); process.once("unhandledRejection", fault);
  try { await bootstrapAgent(await loadDeployment(configurationPath), controller.signal); }
  catch { process.stderr.write("Agent startup or supervision failed; inspect deployment identity, configuration and control availability.\n"); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); process.removeListener("uncaughtException", fault); process.removeListener("unhandledRejection", fault); }
}
