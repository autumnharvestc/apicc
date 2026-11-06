import { describe, expect, it } from "vitest";
import { normalizeSyncSource } from "../../src/sync/index.js";
import { parseContractOpenapi } from "../../src/import/contractOpenapi.js";
import { decodeContractProjectFiles } from "../../src/storage/contractFiles.js";
import { SyncNormalizeInputSchema, SyncNormalizedSourceSchema, type SyncNormalizeInput } from "../../src/sync/types.js";
import { SyncPolicySchema, SyncPolicyValuesSchema, defaultSyncPolicyValues } from "../../src/sync/types.js";
import { resolveSyncPolicy } from "../../src/sync/policy.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const moduleId = "33333333-3333-4333-8333-333333333333";
const apiMapping = { entityKind: "api" as const, externalKey: "/apis/POST/~1pets", entityId: "55555555-5555-4555-8555-555555555555", ownerExternalKey: "/module", aliases: ["operationId:createPet"], ownership: "source" as const, correspondence: "confirmed" as const };
function document() {
  return { openapi: "3.0.3", info: { title: "Pets", version: "1" }, paths: {
    "/pets": { post: { operationId: "createPet", parameters: [{ name: "q", in: "query", schema: { type: "string" } }, { $ref: "#/components/parameters/Trace" }],
      requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { label: { type: "string" }, upload: { type: "string", format: "binary" } } } } } },
      responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" }, examples: { local: { value: { id: 1 } }, shared: { $ref: "#/components/examples/Pet" } } } } }, "400": { $ref: "#/components/responses/Bad" } }, security: [{ Token: [] }] } },
  }, components: { schemas: { Pet: { type: "object", properties: { id: { type: "integer" } } } }, parameters: { Trace: { name: "X-Trace", in: "header", schema: { type: "string" } } },
    responses: { Bad: { description: "bad", content: { "application/json": { example: { error: "bad" } } } } }, examples: { Pet: { value: { id: 1 } } }, securitySchemes: { Token: { type: "http", scheme: "bearer" } } } };
}
function fixture(doc: unknown = document()): SyncNormalizeInput {
  return SyncNormalizeInputSchema.parse({ rawText: JSON.stringify(doc), source: { formatVersion: 1, id: sourceId, revision: "1", kind: "url", moduleId, url: "https://example.test/openapi.json" },
    mapping: { formatVersion: 1, sourceId, namespace: "pets", revision: "0", algorithm: "apicc-sync-id-v1", entries: [apiMapping] }, allocationSeed: "apicc-sync-id-v1", budget: { maxSourceBytes: 65536, maxCompareInputBytes: 1048576, maxNormalizeDepth: 128, maxNormalizeNodes: 100000 } });
}
async function project(result: ReturnType<typeof normalizeSyncSource>) {
  const decoded = await decodeContractProjectFiles(new Map(result.files.map(f => [f.path, f.content])));
  expect(decoded.problems).toEqual([]);
  expect(decoded.project).toBeDefined();
  return decoded.project!;
}
function entry(result: ReturnType<typeof normalizeSyncSource>, kind: string) {
  const item = result.mapping.entries.find(e => e.entityKind === kind);
  expect(item).toBeDefined();
  return item!;
}

describe("T2 review regressions", () => {
  it.each([
    ["https://spec.invalid/child.json", "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED"],
    ["#/x-definitions/Missing", "SYNC_INTERNAL_REFERENCE_UNRESOLVED"],
  ])("continues schema reference chains into extension targets: %s", (ref, code) => {
    const input = fixture({ openapi:"3.1.0", info:{title:"Referenced extension",version:"1"}, paths:{},
      components:{schemas:{Root:{$ref:"#/x-definitions/Root"}}},
      "x-definitions":{Root:{$ref:ref},Unused:{$ref:"business/literal"}},
    }); input.mapping.entries = [];
    const result = normalizeSyncSource(input);
    expect(result.diagnostics.filter(d=>d.code.startsWith("SYNC_") && d.code.includes("REFERENCE"))).toEqual([
      expect.objectContaining({code, severity:"error", path:"/x-definitions/Root/$ref"}),
    ]);
  });
  it("reports genuine refs under an escaped extension pointer while leaving unused literal data opaque", () => {
    const input = fixture({ openapi:"3.1.0", info:{title:"Pointer roles",version:"1"}, paths:{},
      components:{schemas:{Root:{$ref:"#/x-definitions/a%7E1b%7E0c"}}},
      "x-definitions":{
        "a/b~c":{type:"object",properties:{"child/id":{$ref:"https://spec.invalid/child.json"},missing:{$ref:"#/x-definitions/Missing"},recursive:{$ref:"#/x-definitions/a~1b~0c"}},default:{$ref:"business/default"}},
        Unused:{$ref:"business/literal",properties:{unused:{$ref:"business/unused"}}},
      },
    }); input.mapping.entries = [];
    const result = normalizeSyncSource(input);
    expect(result.diagnostics.filter(d=>d.code.startsWith("SYNC_") && d.code.includes("REFERENCE")).map(d=>[d.code,d.path]).sort()).toEqual([
      ["SYNC_EXTERNAL_REFERENCE_UNSUPPORTED","/x-definitions/a~1b~0c/properties/child~1id/$ref"],
      ["SYNC_INTERNAL_REFERENCE_UNRESOLVED","/x-definitions/a~1b~0c/properties/missing/$ref"],
    ]);
  });
  it("visits a shared local target separately for schema and response roles", () => {
    const input = fixture({ openapi:"3.1.0", info:{title:"Shared role",version:"1"}, paths:{},
      components:{schemas:{Root:{$ref:"#/x-definitions/Shared"}},responses:{Reply:{$ref:"#/x-definitions/Shared"}}},
      "x-definitions":{Shared:{schema:{$ref:"https://spec.invalid/response-schema"},properties:{child:{$ref:"https://spec.invalid/property-schema"}},value:{$ref:"business/literal"}}},
    }); input.mapping.entries = [];
    const result = normalizeSyncSource(input);
    expect(result.diagnostics.filter(d=>d.code === "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED").map(d=>d.path).sort()).toEqual([
      "/x-definitions/Shared/properties/child/$ref", "/x-definitions/Shared/schema/$ref",
    ]);
  });
  it("terminates legal mutual schema recursion through local extension targets", () => {
    const input = fixture({ openapi:"3.1.0", info:{title:"Recursive extension",version:"1"}, paths:{},
      components:{schemas:{Root:{$ref:"#/x-definitions/A"}}},
      "x-definitions":{A:{type:"object",properties:{b:{$ref:"#/x-definitions/B"}}},B:{type:"object",properties:{a:{$ref:"#/x-definitions/A"}}},Unused:{$ref:"business/literal"}},
    }); input.mapping.entries = [];
    const result = normalizeSyncSource(input);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.diagnostics.filter(d=>d.code.startsWith("SYNC_") && d.code.includes("REFERENCE"))).toEqual([]);
  });
  it("keeps extension payloads opaque inside Paths and Responses objects", () => {
    const data = { $ref: "invoice/123", amount: 7 };
    const result = normalizeSyncSource(fixture({ openapi: "3.1.0", info: { title:"Extensions", version:"1" }, paths: {
      "x-data": data, "/invoices": { get: { responses: { "x-data": data, "200": { description:"ok" } } } },
    } }));
    expect(result.diagnostics.filter(d=>d.code === "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED").map(d=>d.path)).toEqual([]);
  });
  it("treats literal business refs as data while diagnosing actual OpenAPI and Schema refs", async () => {
    const literal = { $ref: "invoice/123", amount: 7 };
    const input = fixture({ openapi: "3.1.0", info: { title: "Literal refs", version: "1" },
      "x-business": literal,
      paths: { "/invoices": { get: { responses: { "200": { description: "ok", content: { "application/json": {
        example: literal, examples: { inline: { value: literal }, shared: { $ref: "#/components/examples/Invoice" } }, schema: { $ref: "#/components/schemas/Invoice" },
      } } }, "400": { $ref: "https://spec.invalid/response" } } } } },
      components: { examples: { Invoice: { value: literal } }, schemas: {
        Invoice: { type: "object", default: literal, enum: [literal], const: literal, example: literal, examples: [literal], "x-business": literal,
          properties: { example: { $ref: "#/components/schemas/Line" }, default: { $ref: "https://spec.invalid/schema" }, value: { $ref: "#/components/schemas/Missing" }, "x-data": { $ref: "#/components/schemas/Line" } } }, Line: { type: "string" },
      } },
    });
    const before = input.rawText; const result = normalizeSyncSource(input);
    const refs = result.diagnostics.filter(d=>d.code.startsWith("SYNC_") && d.code.includes("REFERENCE"));
    expect(refs.map(d=>d.path).sort()).toEqual([
      "/components/schemas/Invoice/properties/default/$ref", "/components/schemas/Invoice/properties/value/$ref", "/paths/~1invoices/get/responses/400/$ref",
    ]);
    expect(refs.map(d=>d.code)).toEqual(expect.arrayContaining(["SYNC_EXTERNAL_REFERENCE_UNSUPPORTED", "SYNC_INTERNAL_REFERENCE_UNRESOLVED"]));
    expect(input.rawText).toBe(before);
    const parsed = await decodeContractProjectFiles(new Map(result.files.map(f=>[f.path,f.content])));
    expect(parsed.project?.components.find(c=>c.kind === "example")).toMatchObject({ definition: { value: literal } });
    expect(parsed.project?.models.find(m=>m.name === "Invoice")?.schema).toMatchObject({ default: literal, enum: [literal], examples: [literal] });
  });
  it("follows semantic refs in request bodies, headers, encoding, callbacks and Swagger 2 schemas", () => {
    const result = normalizeSyncSource(fixture({ openapi: "3.1.0", info: { title: "Ref roles", version: "1" }, paths: {},
      components: { requestBodies: { Body: { content: { "application/json": { schema: { properties: { example: { $ref: "remote-schema" } } }, encoding: { file: { headers: { H: { $ref: "remote-header" } } } } } } } },
        callbacks: { CB: { "{$request.body#/url}": { post: { parameters: [{ $ref: "remote-parameter" }], responses: {} } } } },
        schemas: { Conditional: { if: { $ref: "remote-if" }, then: { $defs: { value: { $ref: "remote-def" } } } } },
      } }));
    expect(result.diagnostics.filter(d=>d.code === "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED").map(d=>d.path).sort()).toEqual([
      "/components/callbacks/CB/{$request.body#~1url}/post/parameters/0/$ref", "/components/requestBodies/Body/content/application~1json/encoding/file/headers/H/$ref",
      "/components/requestBodies/Body/content/application~1json/schema/properties/example/$ref", "/components/schemas/Conditional/if/$ref", "/components/schemas/Conditional/then/$defs/value/$ref",
    ]);
    const old = normalizeSyncSource(fixture({ swagger: "2.0", info: { title: "Old", version: "1" }, paths: {}, definitions: { Old: { type: "object", default: { $ref: "literal" }, properties: { value: { $ref: "real-remote" } } } } }));
    expect(old.diagnostics.filter(d=>d.code === "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED").map(d=>d.path)).toEqual(["/definitions/Old/properties/value/$ref"]);
  });
  it.each(["{}", "[]"])("charges repeated empty %s containers before alias expansion", empty => {
    const input = fixture(); input.budget.maxNormalizeNodes = 1000000;
    input.rawText = "openapi: 3.0.3\ninfo: {title: Empty, version: '1'}\npaths: {}\nx-a: &a [" + Array.from({length:1000},()=>empty).join(",") + "]\nx-b: [" + Array.from({length:400},()=>"*a").join(",") + "]\n";
    const atom = empty === "{}" ? {} : []; const group = Array.from({length:1000},()=>atom);
    expect(Buffer.byteLength(JSON.stringify({ openapi:"3.0.3", info:{title:"Empty",version:"1"}, paths:{}, "x-a":group, "x-b":Array.from({length:400},()=>group) }))).toBeGreaterThan(input.budget.maxCompareInputBytes);
    expect(Buffer.byteLength(input.rawText)).toBeLessThan(input.budget.maxSourceBytes);
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0);
    expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZED_BYTES_EXCEEDED");
  });
  it.each(["{}", "[]"])("allows bounded repeated empty %s containers", empty => {
    const input = fixture(); input.budget.maxNormalizeNodes = 1000000;
    input.rawText = "openapi: 3.0.3\ninfo: {title: Empty, version: '1'}\npaths: {}\nx-a: &a [" + Array.from({length:1000},()=>empty).join(",") + "]\nx-b: [" + Array.from({length:200},()=>"*a").join(",") + "]\n";
    expect(normalizeSyncSource(input).files.length).toBeGreaterThan(0);
  });
  it("charges JSON stringification of collection-valued YAML pair keys before expansion", () => {
    const input = fixture(); input.budget.maxNormalizeNodes = 1000000;
    input.rawText = "openapi: 3.0.3\ninfo: {title: Keys, version: '1'}\npaths: {}\nx-a: &a [" + Array.from({length:1000},()=>"{ ? [] : 0 }").join(",") + "]\nx-b: [" + Array.from({length:140},()=>"*a").join(",") + "]\n";
    const group = Array.from({length:1000},()=>({"[]":0}));
    expect(Buffer.byteLength(JSON.stringify({ a:group, b:Array.from({length:140},()=>group) }))).toBeGreaterThan(input.budget.maxCompareInputBytes);
    const result = normalizeSyncSource(input); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZED_BYTES_EXCEEDED");
    expect(result.files.length).toBe(0);
  });
  it.each(["success", "source-bytes", "invalid-yaml", "invalid-root", "version", "depth", "nodes", "cycle", "expanded-bytes"])("bounds mapping-bearing %s failure envelopes without changing input", mode => {
    const input = fixture(); input.mapping.entries[0].aliases = [""];
    const overhead = Buffer.byteLength(JSON.stringify(input.mapping));
    // Mapping alone fits, but fewer than100 bytes remain for the full failure envelope.
    input.mapping.entries[0].aliases = ["x".repeat(input.budget.maxCompareInputBytes - 100 - overhead)];
    expect(Buffer.byteLength(JSON.stringify(input.mapping))).toBe(input.budget.maxCompareInputBytes - 100);
    if(mode === "source-bytes") input.rawText = "x".repeat(65537);
    if(mode === "invalid-yaml") input.rawText = "openapi: [broken";
    if(mode === "invalid-root") input.rawText = "[]";
    if(mode === "version") input.rawText = "openapi: 4.0.0";
    if(mode === "depth") { input.budget.maxNormalizeDepth = 16; input.rawText = JSON.stringify({ a:Array.from({length:20}).reduce<unknown>(v=>({ a:v }),0) }); }
    if(mode === "nodes") { input.budget.maxNormalizeNodes = 1000; input.rawText = JSON.stringify(Array.from({length:1200},()=>0)); }
    if(mode === "cycle") input.rawText = "a: &a [*a]";
    if(mode === "expanded-bytes") input.rawText = "a: &a " + "x".repeat(20000) + "\nb: [" + Array.from({length:60},()=>"*a").join(",") + "]";
    const before = JSON.stringify(input);
    expect(() => normalizeSyncSource(input)).toThrow("SYNC_NORMALIZED_BYTES_EXCEEDED");
    expect(JSON.stringify(input)).toBe(before);
  });
  it("rejects an input mapping that itself exceeds the byte budget with a bounded exception", () => {
    const input = fixture(); input.mapping.entries[0].aliases = ["operationId:" + "x".repeat(1100000)]; const before = JSON.stringify(input);
    expect(() => normalizeSyncSource(input)).toThrow("SYNC_NORMALIZED_BYTES_EXCEEDED");
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["4b2e74b5-8942-8902-9144-d4f16bb5d6ec", "4B2E74B5-8942-8902-9144-D4F16BB5D6EC"])("rejects confirmed mappings occupying reserved project %s", id => {
    const input = fixture(); input.mapping.entries[0].entityId = id;
    expect(() => normalizeSyncSource(input)).toThrow(/reserved|occupied/i);
  });
  it("rejects a target module whose case-equivalent UUID is the project container", () => {
    const input = fixture(); input.source.moduleId = "4B2E74B5-8942-8902-9144-D4F16BB5D6EC";
    expect(() => normalizeSyncSource(input)).toThrow(/reserved|occupied/i);
  });
  it("rejects a noncanonical confirmed module entry claiming the reserved module", () => {
    const input = fixture(); input.mapping.entries.push({ ...apiMapping, entityKind: "module", externalKey: "/wrong-module", entityId: moduleId, aliases: ["/module"] });
    expect(() => normalizeSyncSource(input)).toThrow(/reserved|occupied/i);
  });
  it("keeps a legitimate module mapping with case-equivalent UUID spelling", async () => {
    const input = fixture(); input.source.moduleId = "abcdefab-1234-4567-8abc-abcdefabcdef";
    input.mapping.entries.push({ ...apiMapping, entityKind: "module", externalKey: "/module", entityId: input.source.moduleId.toUpperCase(), aliases: [] });
    expect(() => normalizeSyncSource(input)).not.toThrow();
    const result = normalizeSyncSource(input); expect((await project(result)).collections[0].id).toBe(input.source.moduleId);
  });
});
describe("source identity normalization", () => {
  it("matches the independent tiny-source mapping and content digest golden", async () => {
    const input = fixture({ openapi: "3.0.3", info: { title: "Tiny", version: "1" }, paths: { "/ping": { get: { operationId: "ping", responses: { "200": { description: "pong" } } } } } }); input.mapping.entries = [];
    const result = normalizeSyncSource(input);
    expect(result.mapping.entries).toEqual([
      { entityKind: "api", externalKey: "/apis/GET/~1ping", entityId: "c428bbc6-fa26-8d6a-bfa5-4b055225140f", ownerExternalKey: "/module", aliases: ["operationId:ping"], ownership: "source", correspondence: "confirmed" },
      { entityKind: "response", externalKey: "/apis/GET/~1ping/responses/200", entityId: "1c5cf862-2f17-8932-8582-d0a6dc2a7f8b", ownerExternalKey: "/apis/GET/~1ping", aliases: [], ownership: "source", correspondence: "confirmed" },
      { entityKind: "module", externalKey: "/module", entityId: moduleId, ownerExternalKey: "/module", aliases: [], ownership: "local", correspondence: "manual" },
    ]);
    expect(result.manifestDigest).toBe("56e0bc8faba1733832fc7dd79e2b0cb333712f4990270fb4bc1a6de10b3fadd2");
    const parsed = await project(result);
    expect(parsed.id).toBe("4b2e74b5-8942-8902-9144-d4f16bb5d6ec");
    expect(parsed.collections[0].apis[0].contract.responses[0].id).toBe("1c5cf862-2f17-8932-8582-d0a6dc2a7f8b");
  });
  it("replays the entire valid asset graph including bindings, forms, examples and secret placeholders", async () => {
    const input = fixture(); const first = normalizeSyncSource(input);
    const again = normalizeSyncSource({ ...input, mapping: first.mapping });
    expect(again.entityIds).toEqual(first.entityIds);
    expect(again.files).toEqual(first.files);
    expect(again.manifestDigest).toBe(first.manifestDigest);
    expect(SyncNormalizedSourceSchema.safeParse(first).success).toBe(true);
    const parsed = await project(first);
    expect(parsed.collections[0].id).toBe(moduleId);
    expect(parsed.models).toHaveLength(1); expect(parsed.components).toHaveLength(4);
    const api = parsed.collections[0].apis[0];
    expect(api.contract.responses).toHaveLength(2);
    expect(api.contract.request).toMatchObject({ headers: [{ kind: "componentRef", componentId: parsed.components.find(c=>c.kind === "parameter")!.id }], auth: { kind: "componentRef", componentId: parsed.components.find(c=>c.kind === "auth")!.id } });
    expect(api.contract.responses[0]).toMatchObject({ content: { "application/json": { schema: { kind: "modelRef", modelId: parsed.models[0].id } } } });
    expect(first.mapping.entries.filter(e=>e.entityKind === "parameter").every(e=>e.ownerExternalKey === apiMapping.externalKey)).toBe(true);
    const serialized = JSON.stringify(parsed);
    for (const entity of first.entityIds) expect(serialized).toContain(entity.entityId);
    expect(first.entityIds.filter(e => e.entityKind === "parameter")).toHaveLength(4);
    expect(first.entityIds.filter(e => e.entityKind === "example")).toHaveLength(3);
    expect(first.entityIds.filter(e => e.externalKey.includes("secret"))).toHaveLength(1);
    expect(first.entityIds).toEqual([...first.entityIds].sort((a,b) => a.externalKey < b.externalKey ? -1 : a.externalKey > b.externalKey ? 1 : a.entityKind.localeCompare(b.entityKind)));
  });
  it("retains API and all child IDs when operationId changes on the same route", async () => {
    const first = normalizeSyncSource(fixture()); const doc = document(); doc.paths["/pets"].post.operationId = "savePet";
    const next = normalizeSyncSource({ ...fixture(doc), mapping: first.mapping });
    expect(next.entityIds).toEqual(first.entityIds);
    expect((await project(next)).collections[0].apis[0].contract.id).toBe(apiMapping.entityId);
  });
  it("uses explicitly confirmed route aliases before allocation and keeps children under the canonical parent", async () => {
    const first = normalizeSyncSource(fixture()); const api = entry(first, "api");
    const doc = document(); const moved = { ...doc, paths: { "/animals": doc.paths["/pets"] } };
    const mapping = structuredClone(first.mapping); mapping.entries.find(e => e.entityId === api.entityId)!.aliases.push("/apis/POST/~1animals");
    const next = normalizeSyncSource({ ...fixture(moved), mapping });
    expect(next.entityIds).toEqual(first.entityIds);
    expect((await project(next)).collections[0].apis[0].contract.id).toBe(api.entityId);
  });
  it("does not claim a local entity or silently transfer ownership when a manual mapping is supplied", async () => {
    const first = normalizeSyncSource(fixture()); const mapping = structuredClone(first.mapping);
    const api = mapping.entries.find(e => e.entityKind === "api")!; api.ownership = "local"; api.correspondence = "manual";
    const next = normalizeSyncSource({ ...fixture(), mapping });
    expect(entry(next, "api")).toMatchObject({ entityId: api.entityId, ownership: "local", correspondence: "manual" });
    expect((await project(next)).collections[0].apis[0].contract.id).toBe(api.entityId);
  });
  it("does not guess ownership from operationId and explains unmatched routes and duplicate operationIds", () => {
    const first = normalizeSyncSource(fixture()); const doc = document();
    const moved = { ...doc, paths: { "/a": doc.paths["/pets"], "/b": doc.paths["/pets"] } };
    const next = normalizeSyncSource({ ...fixture(moved), mapping: first.mapping });
    expect(next.entityIds.filter(e => e.entityKind === "api").every(e => e.entityId !== entry(first,"api").entityId)).toBe(true);
    expect(next.diagnostics.map(d=>d.code)).toEqual(expect.arrayContaining(["SYNC_IDENTITY_MATCH_SUGGESTION", "SYNC_OPERATION_ID_DUPLICATE"]));
  });
  it("does not infer correspondence when both route and operationId change and old candidates are ambiguous", () => {
    const doc = document(); const firstInput = fixture({ ...doc, paths: { "/a": doc.paths["/pets"], "/b": { post: { ...doc.paths["/pets"].post, operationId: "other" } } } }); firstInput.mapping.entries = []; const first = normalizeSyncSource(firstInput);
    doc.paths["/pets"].post.operationId = "third";
    const next = normalizeSyncSource({ ...fixture(doc), mapping: first.mapping });
    expect(next.entityIds.filter(e=>e.entityKind === "api").map(e=>e.entityId)).not.toContain(apiMapping.entityId);
    expect(next.diagnostics.map(d=>d.code)).toContain("SYNC_IDENTITY_UNMATCHED");
  });
  it("keeps source namespaces isolated for identical routes", async () => {
    const firstInput = fixture(); firstInput.mapping.entries = []; const first = normalizeSyncSource(firstInput); const input = fixture(); input.mapping.entries = []; input.source.id = "22222222-2222-4222-8222-222222222222"; input.mapping.sourceId = input.source.id;
    const next = normalizeSyncSource(input);
    expect(next.entityIds.filter(e=>e.entityKind === "api")).toHaveLength(1);
    expect((await project(next)).collections[0].apis[0].contract.id).not.toBe((await project(first)).collections[0].apis[0].contract.id);
  });
  it.each(["foreign-source", "duplicate-id", "alias-ambiguous", "occupied-id"])("rejects unsafe %s mapping", mode => {
    const first = normalizeSyncSource(fixture()); const input = { ...fixture(), mapping: structuredClone(first.mapping) }; const api = entry(first,"api");
    if(mode === "foreign-source") input.mapping.sourceId = "22222222-2222-4222-8222-222222222222";
    if(mode === "duplicate-id") input.mapping.entries.push({ ...api, externalKey: "/apis/POST/~1other" });
    if(mode === "alias-ambiguous") input.mapping.entries.push({ ...api, entityId: "44444444-4444-4444-8444-444444444444", externalKey: "/apis/POST/~1other", aliases: [api.externalKey] });
    if(mode === "occupied-id") { input.mapping.entries = [{ ...api, entityId: "469e832d-3267-8cae-b1a1-fabbad6fbc27", externalKey: "/occupied", aliases: [] }]; }
    expect(() => normalizeSyncSource(input)).toThrow(/identity|mapping|occupied|source/i);
  });
  it("ordinary imports continue to allocate fresh identities", () => {
    expect(parseContractOpenapi(document()).project.collections[0].apis[0].contract.id).not.toBe(parseContractOpenapi(document()).project.collections[0].apis[0].contract.id);
  });
  it("distinguishes example names containing structural separators", async () => {
    const doc = document();
    const input = fixture({ ...doc, paths: { "/pets": { post: { ...doc.paths["/pets"].post, responses: { "200": { description: "ok", content: {
      "x": { examples: { "a/content/y/examples/b": { value: 1 } } },
      "x/examples/a/content/y": { examples: { "b": { value: 2 } } },
    } } } } } } });
    const result = normalizeSyncSource(input); const parsed = await project(result);
    const response = parsed.collections[0].apis[0].contract.responses[0];
    if(response.kind !== "inline") throw new Error("Expected inline response");
    const ids = Object.values(response.content).flatMap(c=>c.examples.map(e=>e.id));
    expect(new Set(ids).size).toBe(2);
    expect(result.entityIds.filter(e=>e.entityKind === "example")).toHaveLength(3);
  });
  it("preserves identities when parameter and form order changes", () => {
    const first = normalizeSyncSource(fixture()); const doc = document(); doc.paths["/pets"].post.parameters.reverse();
    const schema = doc.paths["/pets"].post.requestBody.content["multipart/form-data"].schema;
    schema.properties = { upload: schema.properties.upload, label: schema.properties.label };
    expect(normalizeSyncSource({ ...fixture(doc), mapping: first.mapping }).entityIds).toEqual(first.entityIds);
  });
  it("retains component child examples and secret IDs after confirmed parent rename", () => {
    const first = normalizeSyncSource(fixture()); const doc = document();
    const mapping = structuredClone(first.mapping);
    mapping.entries.find(e=>e.externalKey === "/components/response/Bad")!.aliases.push("/components/response/Failure");
    mapping.entries.find(e=>e.externalKey === "/components/auth/Token")!.aliases.push("/components/auth/Bearer");
    const nextDoc = { ...doc, components: { ...doc.components, responses: { Failure: doc.components.responses.Bad }, securitySchemes: { Bearer: doc.components.securitySchemes.Token } } };
    // Update real source references to the renamed components.
    nextDoc.paths["/pets"].post.responses["400"].$ref = "#/components/responses/Failure";
    nextDoc.paths["/pets"].post.security = [{ Bearer: [] }] as unknown as Array<{ Token: never[] }>;
    const next = normalizeSyncSource({ ...fixture(nextDoc), mapping });
    expect(next.entityIds).toEqual(first.entityIds);
  });
  it("rejects case-equivalent occupied UUID mappings", () => {
    const input = fixture(); input.mapping.entries.push({ ...apiMapping, externalKey: "/other", entityId: "ABCDEFAB-1234-4567-8ABC-ABCDEFABCDEF" }, { ...apiMapping, externalKey: "/third", entityId: "abcdefab-1234-4567-8abc-abcdefabcdef" });
    expect(() => normalizeSyncSource(input)).toThrow(/identity|mapping/i);
  });
  it("rejects two active operations claiming one confirmed route correspondence", () => {
    const doc = document(); const input = fixture({ ...doc, paths: { "/pets": doc.paths["/pets"], "/animals": { post: { ...doc.paths["/pets"].post, operationId: "other" } } } });
    input.mapping.entries[0].aliases.push("/apis/POST/~1animals");
    expect(() => normalizeSyncSource(input)).toThrow();
  });
  it("checks alias-expanded bytes separately from node count", () => {
    const input = fixture(); input.budget.maxSourceBytes = 65536;
    input.rawText = "openapi: 3.0.3\ninfo: { title: Bytes, version: '1' }\npaths: {}\nx-a: &a " + "x".repeat(20000) + "\nx-b: [" + Array.from({length:60},()=>"*a").join(",") + "]\n";
    const result = normalizeSyncSource(input);
    expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZED_BYTES_EXCEEDED");
  });
});

describe("normalization budgets and supported source boundary", () => {
  const limits = { maxWireBytes: 128 * 1048576, envelopeReserveBytes: 1024 };
  it("resolves documented defaults and preserves saved omission", () => {
    expect(defaultSyncPolicyValues).toMatchObject({ maxNormalizeDepth: 128, maxNormalizeNodes: 100000 });
    const saved = SyncPolicySchema.parse({ formatVersion: 1, revision: "1", scope: "workspace" });
    expect(saved).not.toHaveProperty("maxNormalizeDepth");
    expect(resolveSyncPolicy(saved, limits)).toMatchObject({ policy: { maxNormalizeDepth: 128, maxNormalizeNodes: 100000 }, sources: { maxNormalizeDepth: "default", maxNormalizeNodes: "default" } });
  });
  it.each([
    ["maxNormalizeDepth", 15], ["maxNormalizeDepth", 257], ["maxNormalizeDepth", 16.5],
    ["maxNormalizeNodes", 999], ["maxNormalizeNodes", 1000001], ["maxNormalizeNodes", 1000.5],
  ] as const)("rejects out of range %s=%s in saved/complete/normalize contracts", (key,value) => {
    expect.soft(SyncPolicySchema.safeParse({ formatVersion: 1, revision: "1", scope: "project", [key]: value }).success).toBe(false);
    expect.soft(SyncPolicyValuesSchema.safeParse({ ...defaultSyncPolicyValues, [key]: value }).success).toBe(false);
    const input = fixture(); input.budget[key] = value;
    expect.soft(SyncNormalizeInputSchema.safeParse(input).success).toBe(false);
  });
  it.each(["maxNormalizeDepth", "maxNormalizeNodes"] as const)("requires explicit %s on normalize input and complete policy values", key => {
    const input = fixture(); const values = { ...defaultSyncPolicyValues }; delete (input.budget as Partial<typeof input.budget>)[key]; delete (values as Partial<typeof values>)[key];
    expect.soft(SyncNormalizeInputSchema.safeParse(input).success).toBe(false);
    expect(SyncPolicyValuesSchema.safeParse(values).success).toBe(false);
  });
  it("inherits workspace ceilings, allows project narrowing and retains explicit-default provenance", () => {
    const inherited = resolveSyncPolicy({ formatVersion: 1, revision: "1", scope: "workspace", maxNormalizeDepth: 128, maxNormalizeNodes: 100000 }, limits);
    expect(resolveSyncPolicy({ formatVersion: 1, revision: "2", scope: "project" }, limits, inherited)).toMatchObject({ policy: { maxNormalizeDepth: 128, maxNormalizeNodes: 100000 }, sources: { maxNormalizeDepth: "workspace", maxNormalizeNodes: "workspace" } });
    expect(resolveSyncPolicy({ formatVersion: 1, revision: "2", scope: "project", maxNormalizeDepth: 64, maxNormalizeNodes: 2000 }, limits, inherited)).toMatchObject({ policy: { maxNormalizeDepth: 64, maxNormalizeNodes: 2000 }, sources: { maxNormalizeDepth: "project", maxNormalizeNodes: "project" } });
    expect(() => resolveSyncPolicy({ formatVersion: 1, revision: "2", scope: "project", maxNormalizeDepth: 129 }, limits, inherited)).toThrow("SYNC_POLICY_INVALID");
    expect(() => resolveSyncPolicy({ formatVersion: 1, revision: "2", scope: "project", maxNormalizeNodes: 100001 }, limits, inherited)).toThrow("SYNC_POLICY_INVALID");
  });
  it.each(["3.2.0", "3.0", "4.0.0", "2.1", ""])("rejects unsupported version %s before importing files", version => {
    const doc = { ...document(), openapi: version }; const result = normalizeSyncSource(fixture(doc));
    expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_OPENAPI_VERSION_UNSUPPORTED");
  });
  it.each(["2.0", "3.0.3", "3.1.0"])("accepts supported version %s", version => {
    const doc = version === "2.0" ? { swagger: "2.0", info: { title: "Old", version: "1" }, paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } } } : { ...document(), openapi: version };
    expect(normalizeSyncSource(fixture(doc)).files.length).toBeGreaterThan(0);
  });
  it("counts source UTF-8 bytes before parsing", () => {
    const input = fixture({ ...document(), info: { title: "界".repeat(22000), version: "1" } });
    expect(input.rawText.length).toBeLessThan(65536); expect(Buffer.byteLength(input.rawText)).toBeGreaterThan(65536);
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_SOURCE_BYTES_EXCEEDED");
  });
  it("bounds normalized file/mapping expansion even when source bytes are small", () => {
    const op = document().paths["/pets"]; const paths = Object.fromEntries(Array.from({length: 700}, (_,i)=>[`/p${i}`, { post: { ...op.post, operationId: `op${i}` } }]));
    const input = fixture({ ...document(), paths }); input.budget.maxSourceBytes = 1048576;
    input.budget.maxNormalizeNodes = 1000000;
    expect(Buffer.byteLength(input.rawText)).toBeLessThan(input.budget.maxSourceBytes);
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZED_BYTES_EXCEEDED");
  });
  it("rejects expanded depth before recursive contract mapping", () => {
    const input = fixture({ ...document(), "x-deep": Array.from({length: 30}).reduce<unknown>(v=>({nest:v}), "end") }); input.budget.maxNormalizeDepth = 16;
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZE_DEPTH_EXCEEDED");
  });
  it("rejects expanded node count before mapping", () => {
    const input = fixture({ ...document(), "x-many": Array.from({length: 1200},()=>"x") }); input.budget.maxNormalizeNodes = 1000;
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZE_NODES_EXCEEDED");
  });
  it("accounts repeated YAML aliases before expansion", () => {
    const input = fixture(); input.budget.maxNormalizeNodes = 1000;
    input.rawText = "openapi: 3.0.3\ninfo: { title: Alias, version: '1' }\npaths: {}\nx-a: &a [" + Array.from({length:600},()=>"a").join(",") + "]\nx-b: *a\n";
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_NORMALIZE_NODES_EXCEEDED");
  });
  it("rejects cyclic YAML aliases but keeps legitimate recursive model refs", () => {
    const input = fixture(); input.rawText = "openapi: 3.0.3\ninfo: { title: Cycle, version: '1' }\npaths: {}\nx-cycle: &a [*a]\n";
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_YAML_ALIAS_CYCLE");
  });
  it("reports external, missing internal and importer fidelity diagnostics without fetching", () => {
    const doc = document(); const modified = { ...doc, components: { ...doc.components, schemas: { ...doc.components.schemas, Recursive: { type: "object", properties: { child: { $ref: "#/components/schemas/Recursive" } } }, Missing: { $ref: "#/components/schemas/Absent" }, Remote: { $ref: "https://private.invalid/schema.json" } } } };
    const result = normalizeSyncSource(fixture(modified));
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.diagnostics.map(d=>d.code)).toEqual(expect.arrayContaining(["SYNC_EXTERNAL_REFERENCE_UNSUPPORTED", "SYNC_INTERNAL_REFERENCE_UNRESOLVED", "REQUEST_BODY_SCHEMA_NOT_REPRESENTED"]));
  });
  it("returns a bounded source parse diagnostic for invalid YAML", () => {
    const input = fixture(); input.rawText = "openapi: [broken";
    expect(() => normalizeSyncSource(input)).not.toThrow();
    const result = normalizeSyncSource(input); expect(result.files.length).toBe(0); expect(result.diagnostics.map(d=>d.code)).toContain("SYNC_SOURCE_PARSE_FAILED");
  });
});
