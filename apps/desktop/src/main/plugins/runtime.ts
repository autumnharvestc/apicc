import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createUserPluginHost, type ExecutableRequest, type UserPluginHost } from "@apicc/core";
import type { PluginContributions, PluginsListResult } from "../../shared/plugins/contract.js";

export interface PluginsRuntimeOptions { homeDir?: string; loadPlugins?: boolean }
export interface PluginsRuntime extends Pick<UserPluginHost, "registry" | "snapshot"> { summary(): Promise<PluginsListResult> }
const hostVersion: string = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../package.json"), "utf8",
)).version;

/** One host owns both the public facts and every Desktop execution registry. */
export function createPluginsRuntime(options: PluginsRuntimeOptions = {}): PluginsRuntime {
  const enabled = options.loadPlugins !== false;
  const host = createUserPluginHost({ hostVersion, homeDir: options.homeDir, enabled });
  return { registry: () => host.registry(), snapshot: () => host.snapshot(), async summary() {
    const summary = await host.summary(), registry = await host.registry();
    const bindingActive = (kind: "protocols" | "auths", target: string, id: string): boolean => {
      try {
        if (kind === "auths") return registry.getAuth(target)?.type === target;
        // SDK binding selection only inspects protocol metadata, never executes a guest callback.
        const common = { url: "http://plugin-binding.invalid/", headers: {}, query: [], auth: { kind: "none" as const } };
        const request: ExecutableRequest = target === "websocket" ? { ...common, protocol: "websocket" }
          : target === "soap" ? { ...common, protocol: "soap", method: "POST", envelope: "<Envelope/>" }
          : { ...common, protocol: "http", method: "GET" };
        return registry.getProtocol(request)?.name === id;
      } catch (error) {
        if ((error as { code?: unknown })?.code === "binding_invalid") return false;
        throw error;
      }
    };
    return {
      enabled, hostVersion,
      plugins: [
        ...summary.loaded.map(p => {
          const contributions: PluginContributions = { protocols: [], auths: [], asserts: [], scripts: [], reporters: [], importers: [] };
          const fields = { protocol: "protocols", auth: "auths", assert: "asserts", reporter: "reporters", importer: "importers" } as const;
          for (const id of p.contributionIds) {
            const kind = id.split("/")[1]!.split(".")[0] as keyof typeof fields;
            contributions[fields[kind]].push(id);
          }
          return { key: `loaded:${p.pluginId}`, kind: "loaded" as const, name: p.name, pluginId: p.pluginId,
            source: p.source, version: p.version, apiVersion: p.apiVersion, requiredHost: p.engines.apicc, contributions };
        }),
        ...summary.problems.map((p, index) => ({ key: `failed:${p.file}:${p.code}:${index}`, kind: "failed" as const,
          name: p.pluginId ?? p.file, source: p.file, pluginId: p.pluginId, error: p.message, code: p.code, stage: p.stage,
          actual: p.actual, required: p.required, action: p.action })),
        ...(summary.disabled ?? []).map((p, index) => ({ key: `disabled:${p.source}:${index}`, kind: "disabled" as const, name: p.source, source: p.source })),
      ],
      bindings: (["protocols", "auths"] as const).flatMap(kind => Object.entries(summary.bindings[kind]).map(([target, contributionId]) => ({
        key: `${kind}:${target}`, kind, target, contributionId: contributionId!,
        active: bindingActive(kind, target, contributionId!),
      }))),
      importers: registry.listImporters().map(i => i.name),
    };
  } };
}
