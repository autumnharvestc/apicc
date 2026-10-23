/** JSON data crosses the SDK boundary without exposing host models or resources. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
export interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJsonValue }

export type CapabilityV1 = "protocol" | "auth" | "assert" | "importer" | "reporter";
export type ContributionIdV1 = `${string}/${CapabilityV1}.${string}`;
export type ProtocolKindV1 = "http" | "websocket" | "soap";
export type AuthKindV1 = "bearer" | "basic" | "apikey";
export type ConfigFieldV1 =
  | { type: "string"; required?: boolean; default?: string }
  | { type: "number"; required?: boolean; default?: number }
  | { type: "boolean"; required?: boolean; default?: boolean }
  | { type: "enum"; values: readonly string[]; required?: boolean; default?: string };
export interface PluginManifestV1 {
  manifestVersion: 1; id: string; name: string; version: string; apiVersion: 1;
  engines: { apicc: string }; entry: string;
  capabilities: readonly CapabilityV1[];
  contributions: readonly { kind: CapabilityV1; id: ContributionIdV1 }[];
  configSchema?: { fields: Readonly<Record<string, ConfigFieldV1>> };
}
export interface PluginDefinitionV1 {
  manifest: PluginManifestV1;
  setup(context: PluginSetupContextV1): void;
}
export interface PluginSetupContextV1 {
  readonly config: ReadonlyJsonObject;
  register(contribution: PluginContributionV1): void;
}
export interface AssertionResultV1 {
  pass: boolean; message: string; kind?: "config" | "assertion";
  code?: string; differencePath?: string; schemaPath?: string;
}
export interface AssertionContextV1 {
  found: boolean; options?: ReadonlyJsonObject; schema?: ReadonlyJsonValue;
  getModel(id: string): ReadonlyJsonValue | undefined;
}
export interface AssertContributionV1 {
  kind: "assert"; id: ContributionIdV1; label?: string;
  descriptor?: {
    targets?: readonly string[];
    expectedFormat?: "text" | "pattern" | "integer" | "json" | "jsonArray" | "xpath" | "none";
    expectedRequired?: boolean;
  };
  evaluate(actual: ReadonlyJsonValue | undefined, expected: string | undefined,
    context: AssertionContextV1): AssertionResultV1;
}
export interface ImportDiagnosticV1 {
  code: string; ownerId: string; path: string; reason: string; targetId?: string;
}
export interface ImporterContributionV1 {
  kind: "importer"; id: ContributionIdV1; label?: string;
  detect(fileName: string, content: string): boolean;
  parse(content: string): {
    formatVersion: 1; project: JsonObject;
    diagnostics: ImportDiagnosticV1[]; warnings: string[];
  };
}
export interface ReportViewV1 {
  formatVersion: 1; kind: "collection" | "workflow" | "suite"; title: string;
  startedAt: string; finishedAt: string;
  rows: { total: number; passed: number; failed: number; skipped: number };
  logical?: { total: number; passed: number; failed: number; skipped: number };
  requestFacts?: { started: number; completed: number; httpExchanges: number };
  cases: readonly ReadonlyJsonObject[]; diagnostics: readonly string[];
  details?: ReadonlyJsonObject;
}
export interface ReporterContributionV1 {
  kind: "reporter"; id: ContributionIdV1; label?: string;
  render(report: Readonly<ReportViewV1>, outDir: string): Promise<string>;
}
export interface RequestFileViewV1 {
  readonly fileRef: string; readonly filename?: string; readonly sizeBytes?: number;
}
export type RequestBodyViewV1 =
  | { readonly kind: "json" | "xml" | "raw"; readonly content: string }
  | { readonly kind: "form"; readonly form: readonly { readonly key: string; readonly value: string }[] }
  | { readonly kind: "binary"; readonly file: RequestFileViewV1; readonly contentType: string }
  | { readonly kind: "multipart"; readonly entries: readonly (
      | { readonly kind: "text"; readonly name: string; readonly value: string }
      | { readonly kind: "file"; readonly name: string; readonly file: RequestFileViewV1; readonly filename?: string; readonly contentType: string }
    )[] };
export interface RequestCommonV1 {
  readonly url: string; readonly headers: Readonly<Record<string, string>>;
  readonly query: readonly { readonly key: string; readonly value: string }[];
}
export type RequestViewV1 = RequestCommonV1 & (
  | { readonly protocol: "http"; readonly method: string; readonly body?: RequestBodyViewV1 }
  | { readonly protocol: "websocket"; readonly message?: string }
  | { readonly protocol: "soap"; readonly method: "POST"; readonly envelope: string; readonly soapAction?: string }
);
export interface ResponseViewV1 {
  readonly status: number; readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string; readonly timeMs: number;
  readonly bodyBytes?: Uint8Array; readonly textAvailable?: boolean; readonly jsonAvailable?: boolean;
  readonly rawHeaders?: readonly (readonly [string, string])[];
  readonly encodedBytes?: number; readonly decodedBytes?: number; readonly declaredLength?: number;
}
export type AuthValueV1 =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "apikey"; name: string; placement: "header" | "query"; value: string };
export interface AuthContributionV1 {
  kind: "auth"; id: ContributionIdV1; label?: string;
  supports: readonly AuthKindV1[];
  apply(request: Readonly<RequestViewV1>, auth: Readonly<AuthValueV1>): {
    headers?: Readonly<Record<string, string>>;
    query?: readonly { key: string; value: string }[];
  };
}
export interface ProtocolContextV1 {
  signal?: AbortSignal; runId?: string; vuId?: string;
  transport: { execute(request: Readonly<RequestViewV1>): Promise<ResponseViewV1> };
}
export interface ProtocolContributionV1 {
  kind: "protocol"; id: ContributionIdV1; label?: string;
  supports: readonly ProtocolKindV1[];
  execute(request: Readonly<RequestViewV1>, context: ProtocolContextV1): Promise<ResponseViewV1>;
}
export type PluginContributionV1 = AssertContributionV1 | ImporterContributionV1
  | ReporterContributionV1 | AuthContributionV1 | ProtocolContributionV1;
