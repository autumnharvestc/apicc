import { createPluginRegistry } from "./registry.js";
import { createHttpClient } from "../http/client.js";
import { wsClient } from "../protocol/websocket.js";
import { createSoapClient } from "../protocol/soap.js";
import { builtinAuthProviders } from "../http/auth.js";
import { builtinAssertOperators } from "../assert/operators.js";
import { createJsScriptEngine } from "../sandbox/jsEngine.js";
import { htmlReporter } from "../report/html.js";
import { junitReporter } from "../report/junit.js";

export type BuiltinExecutionProfile = "no-script" | "trusted-core-script";
/** Only built-in execution contributions; no plugin loading or implicit script engine. */
export function createBuiltinExecutionRegistry(options: { profile: BuiltinExecutionProfile; scriptTimeoutMs?: number }) {
  if (options.profile !== "no-script" && options.profile !== "trusted-core-script") throw new TypeError("Unknown execution profile");
  const registry = createPluginRegistry();
  const http = createHttpClient();
  registry.registerProtocol(http); registry.registerProtocol(wsClient); registry.registerProtocol(createSoapClient(http));
  for (const provider of builtinAuthProviders) registry.registerAuth(provider);
  for (const operator of builtinAssertOperators) registry.registerAssert(operator);
  registry.registerReporter(htmlReporter); registry.registerReporter(junitReporter);
  if (options.profile === "trusted-core-script") registry.registerScriptEngine(createJsScriptEngine({ timeoutMs: options.scriptTimeoutMs }));
  return Object.assign(registry, { close: () => http.close() });
}
