export { version } from "./version.js";
export * from "./domain/model.js";
export { envChain } from "./domain/envChain.js";
export { createEventBus } from "./events/bus.js";
export type { RunEventMap } from "./events/bus.js";
export * from "./plugin/types.js";
export { createPluginRegistry, type PluginRegistry } from "./plugin/registry.js";
export { fileStorage } from "./storage/fileStorage.js";
export { SqliteIndex } from "./storage/sqliteIndex.js";
export { createVariableResolver, CyclicVariableError } from "./variables/resolver.js";
export { CollectionRunner } from "./runner/runner.js";
export type { RunResult, CaseOutcome } from "./report/types.js";
export { renderDesignMarkdown } from "./design/export.js";
export { htmlReporter } from "./report/html.js";
export { junitReporter } from "./report/junit.js";
export { collectionV21Importer } from "./import/collection21.js";
export { openapiImporter } from "./import/openapi.js";
export * from "./workflow/model.js";
export { validateWorkflowStructure, transitionWorkflowStatus, validateEnablement, type ValidationIssue } from "./workflow/validate.js";
export { workflowImpact, type WorkflowImpactEntry } from "./workflow/impact.js";
export { WorkflowRunner, type WorkflowRunResult, type NodeResult, type NodeState, type WorkflowRunnerOptions } from "./workflow/runner.js";
export { workflowToRunResult } from "./workflow/adapter.js";
export { mergedEnvVars } from "./domain/envChain.js";
export * from "./stress/model.js";
export { computeReport } from "./stress/aggregate.js";
export { buildStressRequest } from "./stress/build.js";
export { StressRunner, type StressRunnerOptions, type StressRunOptions } from "./stress/runner.js";

import { createPluginRegistry, type PluginRegistry } from "./plugin/registry.js";
import { fileStorage } from "./storage/fileStorage.js";
import { httpClient } from "./http/client.js";
import { builtinAuthProviders } from "./http/auth.js";
// 内置协议客户端与认证器同时对外导出：CLI run-stress 等消费方直接注入 StressRunner，无需绕注册中心取回。
export { httpClient, builtinAuthProviders };
import { builtinAssertOperators } from "./assert/operators.js";
import { jsScriptEngine } from "./sandbox/jsEngine.js";
import { htmlReporter } from "./report/html.js";
import { junitReporter } from "./report/junit.js";
import { collectionV21Importer } from "./import/collection21.js";
import { openapiImporter } from "./import/openapi.js";

/** 创建注册了全部内置插件的注册中心（内置功能即普通插件，规格 §4）。 */
export function createDefaultRegistry(): PluginRegistry {
  const registry = createPluginRegistry();
  registry.registerStorage(fileStorage);
  registry.registerProtocol(httpClient);
  for (const p of builtinAuthProviders) registry.registerAuth(p);
  for (const o of builtinAssertOperators) registry.registerAssert(o);
  registry.registerScriptEngine(jsScriptEngine);
  registry.registerReporter(htmlReporter);
  registry.registerReporter(junitReporter);
  registry.registerImporter(collectionV21Importer);
  registry.registerImporter(openapiImporter);
  return registry;
}
