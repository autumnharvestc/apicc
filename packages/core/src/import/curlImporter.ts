import { randomUUID } from "node:crypto";
import type { HttpRequest, InlineParameter, RequestBody, SecretRef } from "../contract/request.js";
import { ContractProjectSchema } from "../contract/workspace.js";
import type { Importer } from "../plugin/types.js";
import type { ContractImportResult } from "./contractOpenapi.js";
import { CurlParseError, parseCurlRequest, type CurlBodyDeclaration, type CurlDiagnostic, type CurlParseResult } from "./curl.js";

function parameter(pair: { name: string; value: string }): InlineParameter {
  return { kind: "inline", id: randomUUID(), ...pair, schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "" };
}
const emptySecret = (): SecretRef => ({ id: randomUUID(), policy: "test-auto" });
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function bodyFrom(declarations: CurlBodyDeclaration[]): RequestBody {
  if (!declarations.length) return { kind: "none" };
  if (declarations[0]!.kind === "form") return {
    kind: "multipart",
    entries: declarations.map((body) => {
      if (body.kind !== "form") throw new Error("Invalid form declaration.");
      return body.value.kind === "text"
        ? { kind: "text", id: randomUUID(), name: body.name, value: body.value.text, enabled: true }
        : { ...body.value, id: randomUUID(), name: body.name, file: { path: "" }, enabled: true };
    }),
  };
  const first = declarations[0]!;
  if (first.kind === "data-binary" && first.fileReference) return { kind: "binary", file: { path: "" }, contentType: "application/x-www-form-urlencoded" };
  return {
    kind: "text",
    content: declarations.map((body) => {
      if (body.kind === "form") throw new Error("Invalid data declaration.");
      return body.kind === "data-urlencode" ? `${body.name === undefined ? "" : `${body.name}=`}${encode(body.value)}` : body.value;
    }).join("&"),
  };
}

export interface CurlContractImportResult extends ContractImportResult {
  diagnostics: Array<CurlDiagnostic & { ownerId: string; reason: string }>;
}

/** Adapt the same declaration parser used by preview into the existing importer project contract. */
export function parseContractCurl(content: string): CurlContractImportResult {
  const parsed: CurlParseResult = parseCurlRequest(content);
  const source = parsed.request;
  // File conversion/concatenation requires a contract feature the current model does not have.
  // Preserve it in the parsed declaration, but never create a silently altered Apply candidate.
  const fileBodies = source.body.filter((body) => body.kind !== "form" && body.fileReference);
  if (fileBodies.length && (source.body.length !== 1 || fileBodies[0]!.kind !== "data-binary")) {
    const position = parsed.declarations.find((declaration) => declaration.option.startsWith("--data"))!;
    throw new CurlParseError({ offset: position.offset, line: position.line, column: position.column,
      severity: "error", code: "CURL_FILE_BODY_UNREPRESENTABLE", path: `source/${position.offset}`,
      message: "File conversion or concatenation cannot be represented; use a standalone binary file or multipart upload.", lossy: false });
  }
  const id = randomUUID();
  const auth = source.auth.kind === "bearer" ? { kind: "bearer" as const, token: emptySecret() }
    : source.auth.kind === "basic" ? { kind: "basic" as const, username: source.auth.username, password: emptySecret() }
    : source.auth.kind === "apikey" ? { ...source.auth, value: emptySecret() }
    : source.auth;
  const headers = source.headers.map(parameter);
  if (source.body.length && source.body[0]!.kind !== "form" && !headers.some((header) => header.name.toLowerCase() === "content-type")) {
    headers.push(parameter({ name: "Content-Type", value: "application/x-www-form-urlencoded" }));
  }
  const body = bodyFrom(source.body);
  if (body.kind === "binary") body.contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? body.contentType;
  const request: HttpRequest = {
    protocol: "http", method: source.method, baseUrl: source.baseUrl, path: source.path,
    pathParams: [], query: source.query.map(parameter), headers, cookies: source.cookies.map(parameter), auth, body,
  };
  const project = ContractProjectSchema.parse({
    id: randomUUID(), name: "Imported cURL", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] },
    environments: [], collections: [{
      id: randomUUID(), name: "Imported cURL", variables: {}, preOperations: [], postOperations: [], folders: [],
      apis: [{ contract: {
        formatVersion: 1, id, metadata: { name: `${source.method} ${source.path}`, description: "", tags: [], version: "1.0.0", status: "draft" },
        request, responses: [],
      }, cases: [], documentation: "" }],
    }], workflows: [], models: [], components: [], stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
  });
  return { project, diagnostics: parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, ownerId: id, reason: diagnostic.message })) };
}

export const curlImporter: Importer = {
  name: "curl",
  // Detect the declaration family so unsupported flags still produce a concrete parser error.
  detect(_fileName, content) { return /^\s*(?:curl|curl\.exe)(?:\s|$)/.test(content); },
  parse(content) {
    const result = parseContractCurl(content);
    return { ...result, warnings: result.diagnostics.map((diagnostic) => diagnostic.message) };
  },
};
