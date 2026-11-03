import { createProjectSnapshot } from "../assets/snapshot.js";
import { z } from "zod";
import { decodeContractProjectFiles } from "../storage/contractFiles.js";
import { buildDocumentProjection, selectDocumentApiLocations, type DocumentApi, type DocumentProjection } from "../design/projection.js";
import { createCredentialOutputSanitizer } from "../credentials/output.js";
import { isCredentialFieldName } from "../import/schemaMapping.js";
import { JsonValueSchema, type JsonValue, type SchemaNode } from "../contract/schemaNode.js";
import type { ContractFolder } from "../contract/workspace.js";
import { PublicationInputSchema, ProjectionPolicySchema, PublicArtifactDtoSchema } from "./shared.js";
import { projectReport, archiveHeaderMarkers } from "./report.js";
import { normalizeArchivedExecution } from './archive.js';
import { expandMarkers } from "../report/evidence.js";
import { redactKnownPrivatePaths } from "./privacy.js";
import type { DocumentViewDto, Limitation, PublicationInput, ProjectionPolicy, PublicArtifactDto, PublicBody, PublicComponent, PublicParameter, PublicResponse } from "./types.js";

export async function projectPublication(input: PublicationInput, policy: ProjectionPolicy): Promise<PublicArtifactDto> {
  validateProjectionPolicy(policy);
  policy = ProjectionPolicySchema.parse(policy);
  const parsed = PublicationInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("PUBLICATION_INPUT_INVALID");
  input = parsed.data as PublicationInput;
  let candidate: PublicArtifactDto;
  if (input.sourceKind === "member-upload") {
    candidate = structuredClone(input.artifact);
    if (candidate.report && !policy.includeEvidence) candidate.report.evidence = [];
  }
  else if (input.sourceKind === "server-archive") {
    const execution = normalizeArchivedExecution(input.report);
    const normalized = { ...input, report: execution.report };
    input = { ...input, privateMarkers: [...input.privateMarkers, ...archiveHeaderMarkers(normalized, policy)] };
    candidate = projectReport({ ...normalized, privateMarkers: input.privateMarkers }, policy, execution);
  }
  else {
    if (new Set(input.files.map((file) => file.path)).size !== input.files.length) throw new Error("PUBLICATION_SOURCE_INVALID");
    let loaded: Awaited<ReturnType<typeof decodeContractProjectFiles>>;
    try { loaded = await decodeContractProjectFiles(new Map(input.files.map(({ path, content }) => [path, content]))); }
    catch { throw new Error("PUBLICATION_SOURCE_INVALID"); }
    if (!loaded.project || loaded.readOnly || loaded.problems.length > 0) throw new Error("PUBLICATION_SOURCE_INVALID");
    const snapshot = createProjectSnapshot(loaded.project);
    let scope = input.scope;
    if (scope.kind === "folders") {
      const contractIds: string[] = [];
      for (const selected of scope.folders) {
        const collection = loaded.project.collections.find((item) => item.id === selected.collectionId);
        let folders = collection?.folders;
        let found: ContractFolder | undefined;
        for (const id of selected.folderIds) { found = folders?.find((item) => item.id === id); folders = found?.folders; }
        if (!found) throw new Error("PUBLICATION_SCOPE_INVALID");
        const collect = (folder: ContractFolder): void => { contractIds.push(...folder.apis.map((api) => api.contract.id)); folder.folders.forEach(collect); };
        collect(found);
      }
      scope = { kind: "apis", contractIds };
    }
    const selection = selectDocumentApiLocations(snapshot, scope);
    if (selection.diagnostics.some((item) => item.severity === "error")) throw new Error("PUBLICATION_SCOPE_INVALID");
    const projection = buildDocumentProjection(snapshot, scope);
    candidate = { formatVersion: 1, kind: "document", title: input.title, source: { trust: "saved-contract", ...input.source },
      summary: [{ labelCode: "document.apiCount", value: projection.apis.length }],
      limitations: projection.diagnostics.map((item) => ({ code: item.code })), document: documentView(projection) };
  }
  return finalizePublication(candidate, policy, input.sourceKind === "server-archive" ? input.privateMarkers : []);
}

export function validateProjectionPolicy(policy: ProjectionPolicy): void {
  if (!ProjectionPolicySchema.safeParse(policy).success || policy.maxFieldBytes > policy.maxEvidenceBytes || policy.maxEvidenceBytes > policy.maxArtifactBytes
    || policy.extraSensitiveHeaders.length + policy.extraSensitiveQuery.length + policy.extraSensitiveFields.length + policy.extraSensitivePointers.length > 200) throw new Error("PUBLICATION_POLICY_INVALID");
}

function documentView(projection: DocumentProjection): DocumentViewDto {
  const ids = new Map<string, string>();
  const local = (id: string): string => {
    let value = ids.get(id);
    if (!value) { value = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`; ids.set(id, value); }
    return value;
  };
  const schema = (input: SchemaNode): SchemaNode => {
    const output = structuredClone(input);
    const walk = (node: SchemaNode): void => {
      if (node.kind === "modelRef") node.modelId = local(node.modelId);
      else if (node.kind === "object") { Object.values(node.properties).forEach(walk); if (typeof node.additionalProperties !== "boolean") walk(node.additionalProperties); }
      else if (node.kind === "array") walk(node.items);
      else if (node.kind === "oneOf" || node.kind === "allOf" || node.kind === "anyOf") node.variants.forEach(walk);
    };
    walk(output); return output;
  };
  const parameters = (api: DocumentApi): PublicParameter[] => {
    const request = api.request;
    return [...request.pathParams, ...request.query, ...request.headers, ...request.cookies].flatMap((item) => item.kind === "unresolved" ? [] : [{
      id: local(item.id), location: item.location, name: item.name, schema: schema(item.schema), required: item.required,
      enabled: item.enabled, description: item.description, ...(item.value === undefined ? {} : { value: item.value }),
    }]);
  };
  const response = (input: Exclude<DocumentApi["responses"][number], { kind: "unresolved" }>): PublicResponse => ({
    id: local(input.id), status: input.status, description: input.description, headers: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
    content: Object.entries(input.content).map(([mediaType, value]) => ({ mediaType, ...(value.schema ? { schema: schema(value.schema) } : {}),
      examples: value.examples.flatMap((example) => example.kind === "unresolved" ? [] : [{ id: local(example.id), name: example.name, value: structuredClone(example.value) }]) })),
  });
  const body = (api: DocumentApi): PublicBody | undefined => {
    const request = api.request;
    if (request.protocol === "soap") return { kind: "xml", content: request.envelope };
    if (request.protocol === "websocket") return request.message === undefined ? undefined : { kind: "text", content: request.message };
    const value = request.body;
    if (value.kind === "json" || value.kind === "xml" || value.kind === "text") return { kind: value.kind, content: value.content, ...(value.schema ? { schema: schema(value.schema) } : {}) };
    if (value.kind === "graphql") return { kind: value.kind, content: value.query };
    if (value.kind === "urlencoded") return { kind: value.kind, fields: value.fields.map(({ name, value, enabled }) => ({ name, value, enabled })) };
    if (value.kind === "multipart") return { kind: value.kind, fields: value.entries.flatMap((entry) => entry.kind === "text" ? [{ name: entry.name, value: entry.value, enabled: entry.enabled }] : []) };
    return { kind: value.kind };
  };
  const models = new Map<string, DocumentViewDto["models"][number]>();
  const components = new Map<string, PublicComponent>();
  const apis = projection.apis.map((api) => {
    for (const model of api.models) models.set(model.id, { id: local(model.id), name: model.name, description: model.description, schema: schema(model.schema) });
    for (const item of api.components) {
      const identity = { id: local(item.id), name: item.name, description: item.description };
      if (item.kind === "parameter") components.set(item.id, { ...identity, kind: "parameter", parameter: { ...item.definition, schema: schema(item.definition.schema) } });
      else if (item.kind === "example") components.set(item.id, { ...identity, kind: "example", example: structuredClone(item.definition) });
      else if (item.kind === "auth") components.set(item.id, { ...identity, kind: "auth", scheme: item.definition.kind });
      else {
        const { id: _id, ...definition } = response({ ...item.definition, kind: "inline", id: item.id });
        components.set(item.id, { ...identity, kind: "response", response: definition });
      }
    }
    const requestBody = body(api);
    return { id: local(api.contractId), ...api.metadata, collection: api.collection.name, folders: api.folders.map((folder) => folder.name),
      request: { protocol: api.request.protocol, ...("method" in api.request ? { method: api.request.method } : {}), path: api.request.path,
        parameters: parameters(api), ...(requestBody ? { body: requestBody } : {}) },
      responses: api.responses.flatMap((item) => item.kind === "unresolved" ? [] : [response(item)]),
      documentation: api.documentation, caseSummaries: structuredClone(api.caseSummaries),
      modelIds: api.models.map((item) => local(item.id)), componentIds: api.components.map((item) => local(item.id)),
    };
  });
  return { apis, models: [...models.values()], components: [...components.values()] };
}

/** Scan only the candidate/final business DTO. Raw source is never serialized as a scan target. */
export function finalizePublication(candidate: PublicArtifactDto, policy: ProjectionPolicy, trustedMarkers: readonly string[] = []): PublicArtifactDto {
  let structuralFields = new WeakMap<object, Set<PropertyKey>>();
  // Only literal/enum leaves of this validated DTO shape are machine codes.
  // JsonValue (including Schema annotations) is business content, never an exemption.
  const indexStructure = (dto: PublicArtifactDto): void => {
    structuralFields = new WeakMap();
    if (!PublicArtifactDtoSchema.safeParse(dto).success) return;
    const visit = (schema: z.core.$ZodType, value: unknown, parent?: object, key?: PropertyKey): void => {
      if (!(schema instanceof z.ZodType) || schema === JsonValueSchema) return;
      const wire = schema.meta()?.apiccJsonWireSchema;
      if (wire instanceof z.ZodType) { visit(wire, value, parent, key); return; }
      if ((schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum) && typeof value === "string" && parent && key !== undefined) {
        let keys = structuralFields.get(parent); if (!keys) { keys = new Set(); structuralFields.set(parent, keys); } keys.add(key);
      } else if (schema instanceof z.ZodObject && value && typeof value === "object") {
        for (const [name, child] of Object.entries(schema.shape)) visit(child as z.ZodType, (value as Record<string, unknown>)[name], value, name);
      } else if (schema instanceof z.ZodArray && Array.isArray(value)) value.forEach((item, index) => visit(schema.element, item, value, index));
      else if (schema instanceof z.ZodRecord && value && typeof value === "object") {
        Object.entries(value).forEach(([name, item]) => visit(schema.valueType, item, value, name));
      } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
        const branch = schema.options.find((option) => z.safeParse(option, value).success); if (branch) visit(branch, value, parent, key);
      } else if (schema instanceof z.ZodLazy) visit(schema.unwrap() as z.ZodType, value, parent, key);
      else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) visit(schema.unwrap(), value, parent, key);
    };
    visit(PublicArtifactDtoSchema, dto);
  };
  indexStructure(candidate);
  const limitations: Limitation[] = [...candidate.limitations];
  const add = (code: string, path: string): void => { const safePath = cleanDiagnostic(path); if (!limitations.some((item) => item.code === code && item.path === safePath)) limitations.push({ code, path: safePath }); };
  const names = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", ...policy.extraSensitiveHeaders, ...policy.extraSensitiveQuery, ...policy.extraSensitiveFields].map((name) => name.toLowerCase()));
  const sensitive = (name: string): boolean => names.has(name.toLowerCase()) || isCredentialFieldName(name);
  const markers = new Set<string>(trustedMarkers);
  const childPointer = (pointer: string, key: string): string => `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
  const collectStrings = (value: unknown): void => {
    if (typeof value === "string") { if (value) markers.add(value); }
    else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
  };
  const gatherJson = (value: JsonValue, pointer: string): void => {
    if (policy.extraSensitivePointers.includes(pointer)) collectStrings(value);
    if (Array.isArray(value)) value.forEach((item, index) => gatherJson(item, `${pointer}/${index}`));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => gatherJson(item, childPointer(pointer, key)));
  };
  const gatherSchema = (node: SchemaNode, pointer: string, inheritedSecret: boolean): void => {
    const secret = inheritedSecret || policy.extraSensitivePointers.includes(pointer);
    const annotation = (value: JsonValue): void => { if (secret) collectStrings(value); gatherJson(value, pointer); gather(value, false); };
    if (node.default !== undefined) annotation(node.default);
    node.examples?.forEach(annotation); node.enum?.forEach(annotation);
    if (node.kind === "object") {
      Object.entries(node.properties).forEach(([name, child]) => gatherSchema(child, childPointer(pointer, name), secret || sensitive(name)));
      if (typeof node.additionalProperties !== "boolean") gatherSchema(node.additionalProperties, pointer, secret);
    } else if (node.kind === "array") gatherSchema(node.items, pointer, secret);
    else if (node.kind === "allOf" || node.kind === "oneOf" || node.kind === "anyOf") node.variants.forEach((child) => gatherSchema(child, pointer, secret));
  };
  const gather = (value: unknown, allowSchema = true): void => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) { value.forEach((item) => gather(item, allowSchema)); return; }
    const record = value as Record<string, unknown>;
    if ((typeof record.name === "string" && sensitive(record.name)) || record.location === "cookie") {
      if (typeof record.value === "string" && record.value) { markers.add(record.value); markers.add(record.value.replace(/^Bearer\s+/i, "")); }
    }
    for (const [key, item] of Object.entries(record)) {
      if (allowSchema && key === "schema" && item && typeof item === "object") { gatherSchema(item as SchemaNode, "", false); continue; }
      if (sensitive(key) && typeof item === "string" && item) markers.add(item);
      if ((key === "content" || key === "requestBody" || key === "responseBody") && typeof item === "string") {
        try { const parsed = JSON.parse(item) as JsonValue; gatherJson(parsed, ""); gather(parsed, false); } catch { /* Original non-JSON business text remains text. */ }
      }
      if (key === "value" && "name" in record && typeof item === "object") { gatherJson(item as JsonValue, ""); gather(item, false); }
      else gather(item, allowSchema);
    }
  };
  gather(candidate);
  const boundary = createCredentialOutputSanitizer(expandMarkers([...markers]));
  const cleanDiagnostic = (value: string): string => redactKnownPrivatePaths(boundary.redactText(value).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]"));
  const utf8Prefix = (value: string, limit: number): string => {
    let used = 0; let output = "";
    for (const char of value) { const size = new TextEncoder().encode(char).byteLength; if (used + size > limit) break; output += char; used += size; }
    return output;
  };
  const text = (value: string, path: string): string => {
    const businessRoute = /^document\.apis\[\d+\]\.request\.path$/.test(path) && value.startsWith("/") && !value.startsWith("//") && !/[A-Za-z]:[\\/]|\\\\/.test(value);
    let safe = businessRoute ? boundary.redactText(value).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]") : cleanDiagnostic(value);
    if (safe !== value) add("masked", path);
    if (new TextEncoder().encode(safe).byteLength > policy.maxFieldBytes) {
      safe = utf8Prefix(safe, policy.maxFieldBytes); add("truncated", path);
    }
    return safe;
  };
  const publicKeys = (keys: readonly string[], path: string): Map<string, string> => {
    const safe = keys.map((key) => text(key, `${path}.$key`));
    const reserved = new Set(keys.filter((key, index) => safe[index] === key));
    const used = new Set<string>(); const output = new Map<string, string>();
    keys.forEach((key, index) => {
      const base = safe[index]!; let alias = base; let suffixIndex = 1;
      if (base !== key) while (reserved.has(alias) || used.has(alias)) {
        const suffix = ` (${++suffixIndex})`;
        alias = utf8Prefix(base, policy.maxFieldBytes - new TextEncoder().encode(suffix).byteLength) + suffix;
      }
      used.add(alias); output.set(key, alias);
    });
    return output;
  };
  const json = (value: JsonValue, pointer: string, path: string): JsonValue => {
    if (policy.extraSensitivePointers.includes(pointer)) { add("masked", path); return "[REDACTED]"; }
    if (typeof value === "string") return text(value, path);
    if (Array.isArray(value)) return value.map((item, index) => json(item, `${pointer}/${index}`, `${path}[${index}]`));
    if (value && typeof value === "object") {
      const keys = publicKeys(Object.keys(value), path);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const publicKey = keys.get(key)!; const child = `${path}.${publicKey}`;
        if (sensitive(key)) { add("masked", child); return [publicKey, "[REDACTED]"]; }
        return [publicKey, json(item, childPointer(pointer, key), child)];
      }));
    }
    return value;
  };
  const walkSchema = (node: SchemaNode, path: string, pointer: string, inheritedSecret: boolean): unknown => {
    const secret = inheritedSecret || policy.extraSensitivePointers.includes(pointer);
    const properties = node.kind === "object" ? node.properties : undefined;
    const propertyNames = properties ? publicKeys(Object.keys(properties), `${path}.properties`) : undefined;
    const annotation = (value: JsonValue, child: string): JsonValue => {
      if (secret) { add("masked", child); return "[REDACTED]"; }
      return json(value, pointer, child);
    };
    return Object.fromEntries(Object.entries(node).map(([key, item]) => {
      const child = `${path}.${key}`;
      if (structuralFields.get(node)?.has(key)) return [key, item];
      if (key === "default") return [key, annotation(item as JsonValue, child)];
      if (key === "examples" || key === "enum") return [key, (item as JsonValue[]).map((value, index) => annotation(value, `${child}[${index}]`))];
      if (key === "properties" && properties && propertyNames) return [key, Object.fromEntries(Object.entries(properties).map(([name, value]) => [propertyNames.get(name)!,
        walkSchema(value, `${child}.${propertyNames.get(name)!}`, childPointer(pointer, name), secret || sensitive(name))]))];
      if (key === "required" && propertyNames) return [key, (item as string[]).map((name) => propertyNames.get(name) ?? text(name, child))];
      if (key === "items" || (key === "additionalProperties" && typeof item !== "boolean")) return [key, walkSchema(item as SchemaNode, child, pointer, secret)];
      if (key === "variants") return [key, (item as SchemaNode[]).map((value, index) => walkSchema(value, `${child}[${index}]`, pointer, secret))];
      return [key, walk(item, child)];
    }));
  };
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") return text(value, path);
    if (Array.isArray(value)) return value.map((item, index) => structuralFields.get(value)?.has(index) ? item : walk(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const namedSecret = (typeof record.name === "string" && sensitive(record.name)) || record.location === "cookie";
    return Object.fromEntries(Object.entries(record).map(([key, item]) => {
      const child = path ? `${path}.${key}` : key;
      if (structuralFields.get(record)?.has(key)) return [key, item];
      if (key === "schema" && item && typeof item === "object") return [key, walkSchema(item as SchemaNode, child, "", false)];
      if (key === "value" && namedSecret) { add("masked", child); return [key, "[REDACTED]"]; }
      if (key === "value" && "name" in record && typeof item === "object") return [key, json(item as JsonValue, "", child)];
      if ((key === "content" || key === "requestBody" || key === "responseBody") && typeof item === "string") {
        try { return [key, text(JSON.stringify(json(JSON.parse(item) as JsonValue, "", child)), child)]; }
        catch { return [key, text(item, child)]; }
      }
      if (["default", "enum", "examples"].includes(key) && item !== undefined) return [key, json(item as JsonValue, "", child)];
      return [key, walk(item, child)];
    }));
  };
  const safe = walk(candidate, "") as PublicArtifactDto;
  safe.limitations = limitations;
  // Validate the actual safe candidate, then scan the final allowed DTO once more.
  const allowed = PublicArtifactDtoSchema.parse(safe) as PublicArtifactDto;
  indexStructure(allowed);
  const final = walk(allowed, "") as PublicArtifactDto;
  final.limitations = limitations;
  let remainingEvidenceBytes = policy.maxEvidenceBytes;
  final.report?.evidence.forEach((item, index) => {
    const prefix = `report.evidence[${index}]`;
    for (const key of ["requestBody", "responseBody"] as const) {
      const value = item[key];
      if (value === undefined) continue;
      if (new TextEncoder().encode(value).byteLength > remainingEvidenceBytes) {
        item[key] = utf8Prefix(value, remainingEvidenceBytes); add("truncated", `${prefix}.${key}`);
      }
      remainingEvidenceBytes -= new TextEncoder().encode(item[key]).byteLength;
    }
    if (limitations.some((entry) => entry.code === "truncated" && entry.path?.startsWith(prefix))) item.status = "truncated";
    else if (limitations.some((entry) => entry.code === "masked" && entry.path?.startsWith(prefix))) item.status = "masked";
  });
  final.limitations = limitations.map((item) => ({ code: utf8Prefix(cleanDiagnostic(item.code), policy.maxFieldBytes),
    ...(item.path === undefined ? {} : { path: utf8Prefix(cleanDiagnostic(item.path), policy.maxFieldBytes) }) }));
  if (new TextEncoder().encode(JSON.stringify(final)).byteLength > policy.maxArtifactBytes) throw new Error("PUBLICATION_ARTIFACT_TOO_LARGE");
  return PublicArtifactDtoSchema.parse(final) as PublicArtifactDto;
}
