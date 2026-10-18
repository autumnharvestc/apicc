import { z } from "zod";

import { SecretRefSchema, type SecretRef } from "../contract/request.js";

export interface NetworkProjectIdentity {
  workspaceId: string;
  groupId: string;
  projectId: string;
}

export interface NetworkScope {
  canonicalRoot: string;
  project: NetworkProjectIdentity;
  environmentId?: string;
}

export type NetworkSelection =
  | { kind: "direct" }
  | { kind: "profile"; profileId: string };

export interface NetworkTLSSettings {
  verify?: boolean;
  caCertificatePaths?: string[];
  clientCertificatePaths?: string[];
  clientPrivateKeyRef?: SecretRef;
  clientKeyPassphraseRef?: SecretRef;
}

export interface NetworkTargetTLSBinding {
  origin: string;
  tls: NetworkTLSSettings;
}

interface NetworkProfileBase {
  id: string;
  name: string;
  targetTlsBindings: NetworkTargetTLSBinding[];
}

export interface DirectNetworkProfile extends NetworkProfileBase {
  kind: "direct";
}

export interface ProxyNetworkProfile extends NetworkProfileBase {
  kind: "proxy";
  proxyUrl: string;
  username?: string;
  passwordRef?: SecretRef;
  proxyTLS?: NetworkTLSSettings;
}

export type NetworkProfile = DirectNetworkProfile | ProxyNetworkProfile;

export interface NetworkEnvironmentSelection {
  environmentId: string;
  selection: NetworkSelection;
}

export interface NetworkConfiguration {
  formatVersion: 1;
  profiles: NetworkProfile[];
  projectSelection?: NetworkSelection;
  environmentSelections: NetworkEnvironmentSelection[];
}

const nonEmptyId = z.string().min(1).max(256);

function isAbsolutePathText(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("\\\\")
    || /^[A-Za-z]:[\\/]/.test(value);
}

const absolutePath = z.string().min(1).refine(isAbsolutePathText, "A certificate path must be absolute.");

function isCanonicalTlsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "wss:") && url.origin === value;
  } catch {
    return false;
  }
}

const tlsOrigin = z.string().refine(isCanonicalTlsOrigin, "TLS bindings require an exact canonical HTTPS or WSS origin.");

export const NetworkScopeSchema: z.ZodType<NetworkScope> = z.object({
  canonicalRoot: z.string().min(1).refine(isAbsolutePathText, "A canonical absolute workspace root is required."),
  project: z.object({
    workspaceId: nonEmptyId,
    groupId: nonEmptyId,
    projectId: nonEmptyId,
  }).strict(),
  environmentId: nonEmptyId.optional(),
}).strict();

export const NetworkSelectionSchema: z.ZodType<NetworkSelection> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }).strict(),
  z.object({ kind: z.literal("profile"), profileId: nonEmptyId }).strict(),
]);

const tlsSettingsSchema: z.ZodType<NetworkTLSSettings> = z.object({
  verify: z.boolean().optional(),
  caCertificatePaths: z.array(absolutePath).optional(),
  clientCertificatePaths: z.array(absolutePath).optional(),
  clientPrivateKeyRef: SecretRefSchema.optional(),
  clientKeyPassphraseRef: SecretRefSchema.optional(),
}).strict().superRefine((tls, context) => {
  const hasCertificates = (tls.clientCertificatePaths?.length ?? 0) > 0;
  const hasPrivateKey = tls.clientPrivateKeyRef !== undefined;
  if (hasCertificates !== hasPrivateKey) {
    context.addIssue({ code: "custom", path: [hasCertificates ? "clientPrivateKeyRef" : "clientCertificatePaths"], message: "Client certificates and private key must be configured together." });
  }
  if (tls.clientKeyPassphraseRef && !hasPrivateKey) {
    context.addIssue({ code: "custom", path: ["clientKeyPassphraseRef"], message: "A key passphrase requires a client private key." });
  }
});

const targetTlsBindingSchema: z.ZodType<NetworkTargetTLSBinding> = z.object({
  origin: tlsOrigin,
  tls: tlsSettingsSchema,
}).strict();

const profileBaseShape = {
  id: nonEmptyId,
  name: z.string().trim().min(1).max(256),
  targetTlsBindings: z.array(targetTlsBindingSchema),
};

const directProfileSchema = z.object({
  ...profileBaseShape,
  kind: z.literal("direct"),
}).strict();

const proxyProfileSchema = z.object({
  ...profileBaseShape,
  kind: z.literal("proxy"),
  proxyUrl: z.string().min(1),
  username: z.string().optional(),
  passwordRef: SecretRefSchema.optional(),
  proxyTLS: tlsSettingsSchema.optional(),
}).strict();

function isCanonicalProxyOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.origin === value
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

export const NetworkProfileSchema: z.ZodType<NetworkProfile> = z.discriminatedUnion("kind", [
  directProfileSchema,
  proxyProfileSchema,
]).superRefine((profile, context) => {
  const origins = new Set<string>();
  profile.targetTlsBindings.forEach((binding, index) => {
    if (origins.has(binding.origin)) {
      context.addIssue({ code: "custom", path: ["targetTlsBindings", index, "origin"], message: "Target TLS origins must be unique within a profile." });
    }
    origins.add(binding.origin);
  });

  if (profile.kind !== "proxy") return;
  if (!isCanonicalProxyOrigin(profile.proxyUrl)) {
    context.addIssue({ code: "custom", path: ["proxyUrl"], message: "A proxy URL must be an exact HTTP or HTTPS origin without embedded credentials." });
  }
  if ((profile.username === undefined) !== (profile.passwordRef === undefined)) {
    context.addIssue({ code: "custom", path: ["passwordRef"], message: "Proxy username and password reference must be configured together." });
  }
  if (profile.proxyTLS && !profile.proxyUrl.startsWith("https://")) {
    context.addIssue({ code: "custom", path: ["proxyTLS"], message: "Proxy TLS settings require an HTTPS proxy origin." });
  }
});

export const NetworkConfigurationSchema: z.ZodType<NetworkConfiguration> = z.object({
  formatVersion: z.literal(1),
  profiles: z.array(NetworkProfileSchema),
  projectSelection: NetworkSelectionSchema.optional(),
  environmentSelections: z.array(z.object({
    environmentId: nonEmptyId,
    selection: NetworkSelectionSchema,
  }).strict()),
}).strict().superRefine((configuration, context) => {
  const ids = new Set<string>();
  for (const [index, profile] of configuration.profiles.entries()) {
    if (ids.has(profile.id)) {
      context.addIssue({ code: "custom", path: ["profiles", index, "id"], message: "Profile IDs must be unique." });
    }
    ids.add(profile.id);
  }

  const selectionIssues = (selection: NetworkSelection | undefined, path: (string | number)[]): void => {
    if (selection?.kind === "profile" && !ids.has(selection.profileId)) {
      context.addIssue({ code: "custom", path: [...path, "profileId"], message: "Selection references an unknown profile." });
    }
  };
  selectionIssues(configuration.projectSelection, ["projectSelection"]);

  const environmentIds = new Set<string>();
  configuration.environmentSelections.forEach((entry, index) => {
    if (environmentIds.has(entry.environmentId)) {
      context.addIssue({ code: "custom", path: ["environmentSelections", index, "environmentId"], message: "Environment selection IDs must be unique." });
    }
    environmentIds.add(entry.environmentId);
    selectionIssues(entry.selection, ["environmentSelections", index, "selection"]);
  });
});

export function emptyNetworkConfiguration(): NetworkConfiguration {
  return { formatVersion: 1, profiles: [], environmentSelections: [] };
}

export type NetworkProfileErrorCode =
  | "NETWORK_CONFIGURATION_INVALID"
  | "NETWORK_CONFIGURATION_UNSUPPORTED"
  | "NETWORK_STORAGE_FAILED"
  | "NETWORK_REVISION_CONFLICT"
  | "NETWORK_PROFILE_NOT_FOUND"
  | "NETWORK_CERTIFICATE_MISSING"
  | "NETWORK_CERTIFICATE_INVALID"
  | "NETWORK_CERTIFICATE_TOO_LARGE"
  | "NETWORK_CERTIFICATE_BUDGET_EXCEEDED"
  | "NETWORK_CERTIFICATE_READ_FAILED"
  | "NETWORK_SECRET_MISSING"
  | "NETWORK_SECRET_UNAVAILABLE"
  | "NETWORK_SECRET_VERSION_CONFLICT"
  | "NETWORK_SECRET_INVALID"
  | "NETWORK_WORKSPACE_ROOT_UNAVAILABLE"
  | "NETWORK_PREPARATION_ABORTED";

export class NetworkProfileError extends Error {
  constructor(
    readonly code: NetworkProfileErrorCode,
    readonly profileId?: string,
    readonly field?: string,
  ) {
    super([code, profileId, field].filter((part) => part !== undefined).join(":"));
    this.name = "NetworkProfileError";
  }
}
