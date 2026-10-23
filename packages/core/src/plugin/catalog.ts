import { validatePluginManifest, validatePluginConfig, validatePluginContribution } from "@apicc/plugin-sdk";
import type { CapabilityV1, PluginManifestV1, PluginContributionV1, PluginSetupContextV1 } from "@apicc/plugin-sdk";
import { prepareSdkContribution, type SdkAdapter } from "./sdkAdapter.js";
import { freezeDto } from "./sdkViews.js";

export class PluginCatalogError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PluginCatalogError"; }
}
export interface PluginCatalog {
  begin(manifest: PluginManifestV1, config: unknown): { context: PluginSetupContextV1; commit(): void; abort(): void };
  summary(): { id: string; name: string; version: string; apiVersion: number; contributions: { kind: CapabilityV1; id: string }[] }[];
  contributions(): { kind: CapabilityV1; id: string; label?: string }[];
  hasPlugin(id: string): boolean;
  hasContribution(id: string): boolean;
  adapter(id: string): SdkAdapter | undefined;
  adapters(): SdkAdapter[];
}

export function createPluginCatalog(): PluginCatalog {
  let state = { plugins: new Map<string, PluginManifestV1>(), adapters: new Map<string, SdkAdapter>() };
  const fail = (code: string, message: string): never => { throw new PluginCatalogError(code, message); };
  return {
    hasPlugin: id => state.plugins.has(id), hasContribution: id => state.adapters.has(id),
    adapter: id => state.adapters.get(id), adapters: () => [...state.adapters.values()],
    summary: () => [...state.plugins.values()].map(m => ({ id: m.id, name: m.name, version: m.version, apiVersion: m.apiVersion, contributions: m.contributions.map(c => ({ ...c })) })),
    contributions: () => [...state.adapters.values()].map(a => ({ kind: a.kind, id: a.id, ...(a.label === undefined ? {} : { label: a.label }) })),
    begin(input, config) {
      const checked = validatePluginManifest(input);
      if (!checked.ok) fail("manifest_invalid", checked.problems.map(p => `${p.path}: ${p.reason}`).join("; "));
      const manifest = freezeDto(structuredClone(input));
      const configured = validatePluginConfig(manifest, config);
      if (!configured.ok) fail("invalid_config", configured.problems.map(p => `${p.path}: ${p.reason}`).join("; "));
      if (state.plugins.has(manifest.id) || manifest.contributions.some(c => state.adapters.has(c.id))) fail("contribution_conflict", "Plugin or contribution is already committed");
      const declared = new Map(manifest.contributions.map(c => [c.id, c.kind]));
      const staged = new Map<string, SdkAdapter>();
      let closed = false; let poisoned = false;
      const context: PluginSetupContextV1 = Object.freeze({ config: configured.config!, register(contribution: PluginContributionV1) {
        if (closed) fail("registration_closed", "Plugin transaction is closed");
        try {
          const problems = validatePluginContribution(contribution, manifest);
          if (problems.length) fail("contribution_invalid", problems.map(p => `${p.path}: ${p.reason}`).join("; "));
          if (declared.get(contribution.id) !== contribution.kind) fail("contribution_invalid", "Contribution is not declared by this manifest");
          if (staged.has(contribution.id)) fail("contribution_conflict", "Contribution is registered twice");
          staged.set(contribution.id, prepareSdkContribution(contribution));
        } catch (error) { poisoned = true; throw error; }
      } });
      return { context, abort() { closed = true; staged.clear(); }, commit() {
        if (closed) fail("setup_failed", "Plugin transaction is closed");
        closed = true;
        if (poisoned) fail("setup_failed", "Plugin registration failed; transaction cannot commit");
        if (declared.size !== staged.size) fail("contribution_invalid", "Plugin did not register every declared contribution");
        if (state.plugins.has(manifest.id) || [...staged.keys()].some(id => state.adapters.has(id))) fail("contribution_conflict", "Plugin or contribution was committed by another transaction");
        const plugins = new Map(state.plugins); plugins.set(manifest.id, manifest);
        const adapters = new Map(state.adapters); for (const [id, adapter] of staged) adapters.set(id, adapter);
        state = { plugins, adapters };
      } };
    },
  };
}
