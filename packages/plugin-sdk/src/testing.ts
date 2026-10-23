import { validatePluginConfig, validatePluginContribution, validatePluginManifest, type PluginProblemV1 } from "./manifest.js";
import type { PluginContributionV1, PluginDefinitionV1, ReadonlyJsonObject } from "./types.js";

export interface PluginContractCheckV1 {
  ok: boolean;
  problems: PluginProblemV1[];
  contributions: PluginContributionV1[];
}

/** Run synchronous setup against a temporary collector; failed checks publish nothing. */
export function checkPluginContract(
  definition: PluginDefinitionV1,
  options: { config?: ReadonlyJsonObject } = {},
): PluginContractCheckV1 {
  const manifestCheck = validatePluginManifest(definition?.manifest);
  if (!manifestCheck.ok) return { ok: false, problems: manifestCheck.problems, contributions: [] };
  // Keep declaration identity independent of author objects mutated during setup.
  const manifest = {
    ...manifestCheck.manifest!,
    contributions: manifestCheck.manifest!.contributions.map(({ kind, id }) => ({ kind, id })),
  };
  const configCheck = validatePluginConfig(manifest, options.config === undefined ? {} : options.config);
  if (!configCheck.ok) return { ok: false, problems: configCheck.problems, contributions: [] };
  const problems: PluginProblemV1[] = [];
  const contributions: PluginContributionV1[] = [];
  const registered = new Set<string>();
  let open = true;
  try {
    if (typeof definition.setup !== "function") throw new Error("setup must be a function");
    const result: unknown = definition.setup({
      config: configCheck.config!,
      register(contribution) {
        if (!open) throw new Error("Plugin registration is closed");
        const invalid = validatePluginContribution(contribution, manifest);
        problems.push(...invalid);
        if (invalid.length) return;
        if (!manifest.contributions.some(value => value.id === contribution.id && value.kind === contribution.kind)) {
          problems.push({ code: "contribution_invalid", path: "contribution.id", reason: "Contribution is not declared in the manifest" });
        }
        if (registered.has(contribution.id)) {
          problems.push({ code: "contribution_invalid", path: "contribution.id", reason: "Contribution is registered more than once" });
        }
        registered.add(contribution.id);
        contributions.push(contribution);
      },
    });
    if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
      // Observe rejection to avoid an unhandled promise; asynchronous setup never succeeds.
      void Promise.resolve(result).catch(() => {});
      problems.push({ code: "setup_failed", path: "setup", reason: "Setup must be synchronous; Promise/thenable returned" });
    }
  } catch (error) {
    problems.push({ code: "setup_failed", path: "setup", reason: error instanceof Error ? error.message : "Setup threw an error" });
  } finally {
    open = false;
  }
  // Registration holds author references; validate their final state, not stale IDs.
  const finalRegistered = new Set<string>();
  for (const contribution of contributions) {
    const invalid = validatePluginContribution(contribution, manifest);
    problems.push(...invalid);
    if (invalid.length) continue;
    if (!manifest.contributions.some(value => value.id === contribution.id && value.kind === contribution.kind)) {
      problems.push({ code: "contribution_invalid", path: "contribution.id", reason: "Final contribution is not declared in the manifest" });
    }
    if (finalRegistered.has(contribution.id)) {
      problems.push({ code: "contribution_invalid", path: "contribution.id", reason: "Final contributions contain a duplicate id" });
    }
    finalRegistered.add(contribution.id);
  }
  for (const contribution of manifest.contributions) {
    if (!finalRegistered.has(contribution.id)) {
      problems.push({ code: "contribution_invalid", path: "manifest.contributions", reason: `Declared contribution was not registered: ${contribution.id}` });
    }
  }
  return { ok: problems.length === 0, problems, contributions: problems.length ? [] : contributions };
}
