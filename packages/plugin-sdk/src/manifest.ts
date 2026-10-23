import type {
  CapabilityV1, ConfigFieldV1, PluginManifestV1, ReadonlyJsonObject,
} from "./types.js";

export interface PluginProblemV1 {
  code: "manifest_invalid" | "invalid_config" | "contribution_invalid" | "setup_failed";
  path: string;
  reason: string;
}
export interface PluginManifestValidationV1 {
  ok: boolean; problems: PluginProblemV1[]; manifest?: PluginManifestV1;
}
export interface PluginConfigValidationV1 {
  ok: boolean; problems: PluginProblemV1[]; config?: ReadonlyJsonObject;
}

const capabilities: readonly CapabilityV1[] = ["protocol", "auth", "assert", "importer", "reporter"];
const namespace = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const localName = /^[a-z0-9.-]+$/;
const expectedFormats = ["text", "pattern", "integer", "json", "jsonArray", "xpath", "none"];
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isCapability = (value: unknown): value is CapabilityV1 =>
  typeof value === "string" && capabilities.includes(value as CapabilityV1);
const validId = (id: unknown, pluginId: string, kind: CapabilityV1): id is string => {
  const prefix = `${pluginId}/${kind}.`;
  return typeof id === "string" && id.startsWith(prefix) && localName.test(id.slice(prefix.length));
};
const matchesField = (field: Record<string, unknown>, value: unknown): boolean => {
  switch (field.type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && Array.isArray(field.values) && field.values.includes(value);
    default: return false;
  }
};

/** Pure V1 shape/semantic checks. Standard SemVer admission belongs to the host. */
export function validatePluginManifest(input: unknown): PluginManifestValidationV1 {
  const problems: PluginProblemV1[] = [];
  const problem = (path: string, reason: string) => problems.push({ code: "manifest_invalid", path, reason });
  if (!isObject(input)) {
    problem("manifest", "Manifest must be a plain object");
    return { ok: false, problems };
  }
  if (input.manifestVersion !== 1) problem("manifest.manifestVersion", "Manifest version must be 1");
  if (input.apiVersion !== 1) problem("manifest.apiVersion", "API version must be 1");
  if (typeof input.id !== "string" || !namespace.test(input.id)
      || input.id === "apicc" || input.id.startsWith("apicc.")) {
    problem("manifest.id", "Plugin id must be a lowercase dotted namespace outside apicc");
  }
  for (const field of ["name", "version", "entry"] as const) {
    if (!nonempty(input[field])) problem(`manifest.${field}`, `${field} must be a nonempty string`);
  }
  if (!isObject(input.engines) || !nonempty(input.engines.apicc)) {
    problem("manifest.engines.apicc", "Host range must be a nonempty string");
  }
  const declaredCapabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
  if (!Array.isArray(input.capabilities)) problem("manifest.capabilities", "Capabilities must be an array");
  const seenCapabilities = new Set<unknown>();
  declaredCapabilities.forEach((kind, index) => {
    if (!isCapability(kind)) problem(`manifest.capabilities.${index}`, "Unsupported V1 capability");
    if (seenCapabilities.has(kind)) problem(`manifest.capabilities.${index}`, "Duplicate capability");
    seenCapabilities.add(kind);
  });
  if (!Array.isArray(input.contributions)) {
    problem("manifest.contributions", "Contributions must be an array");
  } else {
    const ids = new Set<string>();
    input.contributions.forEach((contribution, index) => {
      const path = `manifest.contributions.${index}`;
      if (!isObject(contribution) || !isCapability(contribution.kind)) {
        problem(path, "Contribution must declare a supported kind and id");
        return;
      }
      if (!declaredCapabilities.includes(contribution.kind)) problem(`${path}.kind`, "Contribution kind is not declared in capabilities");
      if (typeof input.id !== "string" || !validId(contribution.id, input.id, contribution.kind)) {
        problem(`${path}.id`, "Contribution id must use this plugin namespace, kind and a lowercase local name");
      }
      if (typeof contribution.id === "string") {
        if (ids.has(contribution.id)) problem(`${path}.id`, "Duplicate contribution id");
        ids.add(contribution.id);
      }
    });
  }
  if (input.configSchema !== undefined) {
    if (!isObject(input.configSchema) || !isObject(input.configSchema.fields)) {
      problem("manifest.configSchema.fields", "Config fields must be a plain object");
    } else {
      for (const [key, field] of Object.entries(input.configSchema.fields)) {
        const path = `manifest.configSchema.fields.${key}`;
        if (!isObject(field) || typeof field.type !== "string" || !["string", "number", "boolean", "enum"].includes(field.type)) {
          problem(path, "Config field must have a supported type");
          continue;
        }
        if (field.required !== undefined && typeof field.required !== "boolean") problem(`${path}.required`, "Required must be boolean");
        if (field.type === "enum" && (!Array.isArray(field.values) || field.values.length === 0
            || !field.values.every(value => typeof value === "string"))) {
          problem(`${path}.values`, "Enum choices must be a nonempty array of strings");
        }
        if (Object.hasOwn(field, "default") && !matchesField(field, field.default)) {
          problem(`${path}.default`, "Default must match the field type and choices");
        }
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, problems, manifest: input as unknown as PluginManifestV1 };
}

/** Apply defaults, then validate only declared primitive fields. Never mutate caller data. */
export function validatePluginConfig(manifest: PluginManifestV1, input: unknown): PluginConfigValidationV1 {
  const checked = validatePluginManifest(manifest);
  if (!checked.ok) return { ok: false, problems: checked.problems };
  const problems: PluginProblemV1[] = [];
  const problem = (path: string, reason: string) => problems.push({ code: "invalid_config", path, reason });
  if (!isObject(input)) {
    problem("config", "Config must be a plain object");
    return { ok: false, problems };
  }
  const fields = manifest.configSchema?.fields ?? {};
  const normalized: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) problem(`config.${key}`, "Config field is not declared");
  }
  for (const [key, field] of Object.entries(fields)) {
    const value = Object.hasOwn(input, key) ? input[key] : field.default;
    if (value === undefined) {
      if (field.required) problem(`config.${key}`, "Required config field is missing");
    } else if (!matchesField(field as ConfigFieldV1 & Record<string, unknown>, value)) {
      problem(`config.${key}`, "Config value must match the declared type and choices");
    } else {
      // defineProperty also keeps declared keys such as __proto__ as ordinary data.
      Object.defineProperty(normalized, key, { value, enumerable: true });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, problems, config: Object.freeze(normalized) };
}

/** Validate registration shape, without calling trusted plugin callbacks. */
export function validatePluginContribution(input: unknown, manifest: PluginManifestV1): PluginProblemV1[] {
  const problems: PluginProblemV1[] = [];
  const problem = (path: string, reason: string) => problems.push({ code: "contribution_invalid", path, reason });
  if (!isObject(input) || !isCapability(input.kind)) {
    problem("contribution", "Contribution must have a supported V1 kind");
    return problems;
  }
  if (!validId(input.id, manifest.id, input.kind)) problem("contribution.id", "Contribution id must use this plugin namespace and kind");
  if (input.label !== undefined && typeof input.label !== "string") problem("contribution.label", "Label must be a string");
  const methods: Record<CapabilityV1, readonly string[]> = {
    assert: ["evaluate"], importer: ["detect", "parse"], reporter: ["render"], auth: ["apply"], protocol: ["execute"],
  };
  for (const method of methods[input.kind]) {
    if (typeof input[method] !== "function") problem(`contribution.${method}`, `${method} must be a function`);
  }
  if (input.kind === "auth" || input.kind === "protocol") {
    const supported = input.kind === "auth" ? ["bearer", "basic", "apikey"] : ["http", "websocket", "soap"];
    if (!Array.isArray(input.supports) || input.supports.length === 0
        || input.supports.some(value => !supported.includes(value)) || new Set(input.supports).size !== input.supports.length) {
      problem("contribution.supports", "Supports must list distinct existing V1 kinds");
    }
  }
  if (input.kind === "assert" && input.descriptor !== undefined) {
    const descriptor = input.descriptor;
    if (!isObject(descriptor)) problem("contribution.descriptor", "Descriptor must be a plain object");
    else {
      if (descriptor.targets !== undefined && (!Array.isArray(descriptor.targets)
          || !descriptor.targets.every(value => typeof value === "string"))) problem("contribution.descriptor.targets", "Targets must be strings");
      if (descriptor.expectedFormat !== undefined && (typeof descriptor.expectedFormat !== "string"
          || !expectedFormats.includes(descriptor.expectedFormat))) {
        problem("contribution.descriptor.expectedFormat", "Unsupported expected format");
      }
      if (descriptor.expectedRequired !== undefined && typeof descriptor.expectedRequired !== "boolean") {
        problem("contribution.descriptor.expectedRequired", "Expected required must be boolean");
      }
    }
  }
  return problems;
}
