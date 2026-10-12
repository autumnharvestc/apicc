import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { ProjectGlobals } from "../domain/common.js";
import type { AuthProvider, ExecutableRequest } from "../plugin/types.js";
import { materializeRequest, type MaterializedRequest } from "../request/materialize.js";
import type { VariableResolver } from "../variables/resolver.js";

/**
 * Compatibility entry that delegates all contract assembly to the sole Task 5
 * materializer. Current stress execution uses createStressCaseSession/executeCase
 * so each VU receives its own mutable request and applies auth in the normal stage.
 */
export function buildStressRequest(
  asset: DeepReadonly<ApiAsset>,
  assetContext: ProjectAssetContextReadView,
  credentialBindings: CredentialBindings,
  resolver: VariableResolver,
  authProviders: readonly AuthProvider[],
  options: { envBaseUrl?: string; globals?: DeepReadonly<ProjectGlobals> } = {},
): ExecutableRequest {
  const globals = options.globals ? mutableGlobals(options.globals) : {};
  const materialized: MaterializedRequest = materializeRequest(asset.contract, assetContext, {
    resolve: (template) => resolver.resolve(template),
    envBaseUrl: options.envBaseUrl,
    globals,
    credentials: credentialBindings,
  });
  if (materialized.auth.kind !== "none") {
    const provider = authProviders.find((candidate) => candidate.type === materialized.auth.kind);
    if (!provider) {
      throw Object.assign(new Error(`无可用认证提供方: ${materialized.auth.kind}`), { caseFailureKind: "config" as const });
    }
    provider.apply(materialized, materialized.auth);
  }
  return materialized;
}

function mutableGlobals(globals: DeepReadonly<ProjectGlobals>): ProjectGlobals {
  return {
    query: globals.query.map((entry) => ({ ...entry })),
    headers: globals.headers.map((entry) => ({ ...entry })),
    cookies: globals.cookies.map((entry) => ({ ...entry })),
    body: globals.body.map((entry) => ({ ...entry })),
  };
}
