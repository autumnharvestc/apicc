import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PublicArtifactDtoSchema, PublicationInputSchema, ProjectionPolicySchema } from "../../src/collaboration/shared.js";
import { projectPublication } from "../../src/collaboration/projection.js";
import { decodeContractProjectFiles } from "../../src/storage/contractFiles.js";
import { documentInput, documentProject, ids, jsonWireSchema, policy, safeDocument, safeReport, title } from "./fixtures.js";
import type { JsonValue, SchemaNode } from "../../src/contract/schemaNode.js";

describe("strict public publication boundaries", () => {
  it("accepts a structured safe business DTO with original Chinese and HTML literal title", () => {
    const dto = safeDocument();
    expect(PublicArtifactDtoSchema.parse(dto)).toEqual(dto);
  });
  // Break caught: permissive public root/nested bags accidentally accept private material.
  it.each(["root", "source", "summary", "limitations", "document", "api", "request", "parameter", "body", "field", "response", "header", "content", "example", "case", "model", "component", "componentExample"])("rejects unknown private properties at %s", (at) => {
    const dto = safeDocument();
    const targets: Record<string, object> = { root: dto, source: dto.source, summary: dto.summary[0]!, limitations: { code: "masked" }, document: dto.document!,
      api: dto.document!.apis[0]!, request: dto.document!.apis[0]!.request, body: dto.document!.apis[0]!.request.body!,
      parameter: dto.document!.apis[0]!.request.parameters[0]!, field: dto.document!.apis[0]!.request.body!.fields![0]!,
      response: dto.document!.apis[0]!.responses[0]!, header: dto.document!.apis[0]!.responses[0]!.headers[0]!,
      content: dto.document!.apis[0]!.responses[0]!.content[0]!, example: dto.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!,
      case: dto.document!.apis[0]!.caseSummaries[0]!, model: dto.document!.models[0]!, component: dto.document!.components[0]!,
      componentExample: (dto.document!.components[0]! as { example: object }).example };
    if (at === "limitations") dto.limitations = [targets.limitations as { code: string }];
    Object.assign(targets[at]!, { raw: { privateProject: "PRIVATE" } });
    expect(PublicArtifactDtoSchema.safeParse(dto).success).toBe(false);
  });
  it.each(["root", "source", "file", "scope", "folder"])("rejects unknown fixed contract input property at %s", (at) => {
    const input = documentInput();
    const targets: Record<string, object> = { root: input, source: input.source, file: input.files[0]!, scope: input.scope,
      folder: input.scope.kind === "folders" ? input.scope.folders[0]! : {} };
    Object.assign(targets[at]!, { privateHistory: "PRIVATE" });
    expect(PublicationInputSchema.safeParse(input).success).toBe(false);
  });
  it.each(["server-archive", "saved-contract"] as const)("rejects a member upload claiming %s trust", (trust) => {
    const dto = safeDocument(); dto.source.trust = trust;
    expect(PublicationInputSchema.safeParse({ sourceKind: "member-upload", artifact: dto }).success).toBe(false);
  });
  it.each(["project", "history", "privateMarkers"])("rejects extra upload field %s", (field) => {
    expect(PublicationInputSchema.safeParse({ sourceKind: "member-upload", artifact: safeDocument(), [field]: "LOCAL-PRIVATE" }).success).toBe(false);
  });
  it("accepts exactly a single member claim and saved contract file list", () => {
    expect.soft(PublicationInputSchema.safeParse({ sourceKind: "member-upload", artifact: safeDocument() }).success).toBe(true);
    expect.soft(PublicationInputSchema.safeParse(documentInput()).success).toBe(true);
  });
  it.each([
    ["revision", 0], ["maxFieldBytes", 255], ["maxFieldBytes", 65537], ["maxFieldBytes", 256.5],
    ["maxEvidenceBytes", 4095], ["maxEvidenceBytes", 8388609], ["maxArtifactBytes", 65535], ["maxArtifactBytes", 33554433],
  ])("rejects invalid policy %s=%s", (key, value) => {
    expect(ProjectionPolicySchema.safeParse({ ...policy, [key]: value }).success).toBe(false);
  });
  it("exports root business schema as strict JSON wire structure", () => {
    const json = z.toJSONSchema(jsonWireSchema(PublicArtifactDtoSchema));
    const variants = (json.oneOf ?? json.anyOf ?? [json]) as { additionalProperties?: boolean }[];
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((variant) => variant.additionalProperties === false)).toBe(true);
  });
});

describe("fixed selected document projection", () => {
  // Break caught: replacing selected closure with empty or whole-project output.
  it("projects only the chosen folder plus transitive model dependencies with local IDs", async () => {
    const dto = await projectPublication(documentInput(), policy);
    expect.soft(dto.title).toBe(title);
    expect.soft(dto.source).toEqual({ trust: "saved-contract", revision: "fixed-r1", digest: "digest-r1" });
    expect.soft(dto.document?.apis.map((api) => api.name)).toEqual(["选定接口"]);
    expect.soft(dto.document?.models.map((model) => model.name).sort()).toEqual(["传递依赖", "必要模型"]);
    const text = JSON.stringify(dto);
    expect.soft(text).not.toContain("不得公开");
    expect.soft(text).not.toContain(ids.contract);
    expect.soft(text).not.toContain(ids.model);
    expect.soft(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
  });
  // Empty baseline would mask the privacy assertions; require retained public material as well.
  it("keeps business body and schema while masking mandatory and configured sensitive values", async () => {
    const dto = await projectPublication(documentInput(), policy);
    expect.soft(dto.document?.apis[0]?.request.body?.content ?? "").toContain("保留正文");
    expect.soft(dto.document?.apis[0]?.request.body?.schema?.kind).toBe("modelRef");
    const text = JSON.stringify(dto);
    for (const secret of ["KNOWN-PRIVATE", "private-1", "private-2", "QUERY-PRIVATE", "FIELD-PRIVATE", "POINTER-PRIVATE", "C:\\\\Users", "/home/private"]) expect.soft(text).not.toContain(secret);
    expect.soft(dto.limitations.some((item) => item.code === "masked")).toBe(true);
  });
  it.each(["missing", "invalid", "partial"])("rejects %s source without disk fallback", async (mode) => {
    const input = documentInput();
    if (mode === "missing") input.files = [];
    if (mode === "invalid") input.files = [{ path: "project.yaml", content: ":::invalid" }];
    if (mode === "partial") {
      const originalCount = input.files.length;
      input.files = input.files.filter((file) => !file.path.endsWith("/api.yaml"));
      expect(input.files.length).toBeLessThan(originalCount);
      const decoded = await decodeContractProjectFiles(new Map(input.files.map(({ path, content }) => [path, content])));
      expect.soft(decoded.readOnly).toBe(true);
      expect.soft(decoded.problems.length).toBeGreaterThan(0);
    }
    await expect(projectPublication(input, policy)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
  });
  it("rejects unknown selected folder instead of publishing an empty substitute", async () => {
    const input = documentInput(); input.scope = { kind: "folders", folders: [{ collectionId: ids.collection, folderIds: [ids.unselectedApi] }] };
    await expect(projectPublication(input, policy)).rejects.toThrow("PUBLICATION_SCOPE_INVALID");
  });
  it("truncates fields by UTF-8 bytes while recording a distinct limitation", async () => {
    const input = documentInput(); input.title = "中".repeat(100);
    const dto = await projectPublication(input, { ...policy, maxFieldBytes: 256 });
    expect.soft(new TextEncoder().encode(dto.title).length).toBeLessThanOrEqual(256);
    expect.soft(dto.title).not.toContain("�");
    expect.soft(dto.limitations).toContainEqual(expect.objectContaining({ code: "truncated", path: "title" }));
  });
  it("rejects actual artifact UTF-8 over budget rather than silently dropping APIs", async () => {
    const project = documentProject();
    const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    for (let index = 0; index < 20; index += 1) { const copy = structuredClone(api); copy.contract.id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`; copy.contract.metadata.description = "中".repeat(2500); project.collections[0]!.folders[0]!.folders[0]!.apis.push(copy); }
    await expect(projectPublication(documentInput(project), { ...policy, maxArtifactBytes: 65536, maxEvidenceBytes: 8192 })).rejects.toThrow("PUBLICATION_ARTIFACT_TOO_LARGE");
  });
  it("rejects invalid field/evidence/artifact ordering", async () => {
    await expect(projectPublication(documentInput(), { ...policy, maxFieldBytes: 8192, maxEvidenceBytes: 4096 })).rejects.toThrow("PUBLICATION_POLICY_INVALID");
  });
  it("fixes title, identity and selected scope before async decoding yields", async () => {
    const input = documentInput(); const pending = projectPublication(input, policy);
    input.title = "mutation after invocation"; input.source.revision = "changed-revision"; input.scope = { kind: "project" };
    const dto = await pending;
    expect.soft(dto.title).toBe(title);
    expect.soft(dto.source.revision).toBe("fixed-r1");
    expect.soft(dto.document?.apis.map((api) => api.name)).toEqual(["选定接口"]);
  });
  it("fixes policy budgets and sensitive lists before async decoding yields", async () => {
    const input = documentInput(); input.title = "中".repeat(100);
    const current = { ...policy, maxFieldBytes: 256, extraSensitiveFields: [...policy.extraSensitiveFields] };
    const pending = projectPublication(input, current);
    current.maxFieldBytes = 8192; current.extraSensitiveFields = [];
    const dto = await pending;
    expect.soft(new TextEncoder().encode(dto.title).length).toBeLessThanOrEqual(256);
    expect.soft(JSON.stringify(dto)).not.toContain("FIELD-PRIVATE");
  });
  it("rejects duplicate fixed file paths instead of silently choosing one", async () => {
    const input = documentInput(); input.files.push({ ...input.files[0]! });
    await expect(projectPublication(input, policy)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
  });
  it("removes private keys from structured examples and limitation paths", async () => {
    const artifact = safeDocument();
    artifact.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!.value = { "C:\\Users\\private\\key.txt": { privateField: "EXAMPLE-SECRET" } };
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(JSON.stringify(dto)).not.toContain("C:\\\\Users");
    expect.soft(dto.limitations.every((item) => !item.path?.includes("C:\\Users"))).toBe(true);
    expect.soft(dto.document?.apis[0]?.responses[0]?.content[0]?.examples).toHaveLength(1);
  });
  it("remaps private schema property names together with required names", async () => {
    const artifact = safeDocument(); const privateName = "C:\\Users\\private\\key.txt";
    artifact.document!.models[0]!.schema = { kind: "object", properties: { [privateName]: { kind: "scalar", type: "string" } }, required: [privateName], additionalProperties: false };
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(JSON.stringify(dto)).not.toContain("C:\\\\Users");
    const schema = dto.document?.models[0]?.schema;
    if (schema?.kind !== "object") throw new Error("object schema must be retained");
    expect.soft(schema.required).toEqual(Object.keys(schema.properties));
  });
  it("preserves two distinct values and required associations when private keys both need masking", async () => {
    const artifact = safeDocument(); const first = "C:\\Users\\one\\key.txt"; const second = "C:\\Users\\two\\key.txt";
    artifact.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!.value = { [first]: "first-public", [second]: "second-public" };
    artifact.document!.models[0]!.schema = { kind: "object", properties: { [first]: { kind: "scalar", type: "string" }, [second]: { kind: "scalar", type: "integer" } }, required: [first, second], additionalProperties: false };
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(JSON.stringify(dto)).not.toContain("C:\\\\Users");
    const example = dto.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!.value as Record<string, string>;
    expect.soft(Object.values(example).sort()).toEqual(["first-public", "second-public"]);
    const schema = dto.document!.models[0]!.schema;
    if (schema.kind !== "object") throw new Error("object schema must be retained");
    expect.soft(Object.keys(schema.properties)).toHaveLength(2);
    expect.soft(schema.required).toEqual(Object.keys(schema.properties));
  });
  it("preserves an original REDACTED business key alongside a masked private key", async () => {
    const artifact = safeDocument();
    artifact.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!.value = { "C:\\Users\\private\\key.txt": "private-key-public-value", "[REDACTED]": "original-public-value" };
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    const value = dto.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!.value as Record<string, string>;
    expect.soft(JSON.stringify(dto)).not.toContain("C:\\\\Users");
    expect.soft(value["[REDACTED]"]).toBe("original-public-value");
    expect.soft(Object.values(value).sort()).toEqual(["original-public-value", "private-key-public-value"]);
  });
  it.each(["/srv/private/key.txt", "\\\\private-server\\share\\key.txt"])("masks an uploaded server filesystem path %s", async (path) => {
    const artifact = safeDocument(); artifact.document!.apis[0]!.documentation = path;
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect(dto.document?.apis[0]?.documentation).toBe("[REDACTED]");
  });
  it("retains a declared business route even when its first segment is a filesystem root name", async () => {
    const artifact = safeDocument(); artifact.document!.apis[0]!.request.path = "/home/{id}";
    artifact.document!.apis[0]!.documentation = "/home/private/key.txt";
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(dto.document?.apis[0]?.request.path).toBe("/home/{id}");
    expect.soft(dto.document?.apis[0]?.documentation).toBe("[REDACTED]");
  });
  it("reprojects member upload for mandatory masking and current byte limits", async () => {
    const artifact = safeDocument(); artifact.document!.apis[0]!.documentation = "Bearer KNOWN-PRIVATE /home/private/key.txt";
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(JSON.stringify(dto)).not.toContain("KNOWN-PRIVATE");
    expect.soft(JSON.stringify(dto)).not.toContain("/home/private");
    expect.soft(dto.source.trust).toBe("member-claim");
  });
  it("masks an actual uploaded Windows filesystem path", async () => {
    const artifact = safeDocument(); artifact.document!.apis[0]!.documentation = "read C:\\Users\\private\\key.txt";
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(JSON.stringify(dto)).not.toContain("C:\\\\Users");
    expect.soft(dto.document?.apis[0]?.documentation ?? "").toContain("[REDACTED]");
  });
  // These reach actual sensitive values even before document mapping exists.
  // Break caught: allowing an already-safe claim to bypass any mandatory second projection.
  it.each(["Authorization", "Cookie", "X-Private"])("masks uploaded %s and its known marker in other text", async (name) => {
    const artifact = safeDocument(); const api = artifact.document!.apis[0]!;
    api.request.parameters[0]!.location = "header"; api.request.parameters[0]!.name = name;
    api.request.parameters[0]!.value = "KNOWN-UPLOAD-SECRET";
    api.documentation = "reference KNOWN-UPLOAD-SECRET";
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(JSON.stringify(dto)).not.toContain("KNOWN-UPLOAD-SECRET");
    expect.soft(dto.limitations.some((item) => item.code === "masked")).toBe(true);
    expect.soft(dto.document?.apis[0]?.name).toBe("安全接口");
  });
  it("masks uploaded configured query, JSON names, and JSON pointers in bodies and examples", async () => {
    const artifact = safeDocument(); const api = artifact.document!.apis[0]!;
    api.request.parameters[0]!.name = "access"; api.request.parameters[0]!.value = "QUERY-PRIVATE";
    api.request.body = { kind: "json", content: '{"public":"保留正文","privateField":"FIELD-PRIVATE","nested":{"secret":"POINTER-PRIVATE"}}' };
    api.responses[0]!.content[0]!.examples[0]!.value = { public: true, privateField: "EXAMPLE-PRIVATE", nested: { secret: "EXAMPLE-POINTER" } };
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    const text = JSON.stringify(dto);
    for (const secret of ["QUERY-PRIVATE", "FIELD-PRIVATE", "POINTER-PRIVATE", "EXAMPLE-PRIVATE", "EXAMPLE-POINTER"]) expect.soft(text).not.toContain(secret);
    expect.soft(dto.document?.apis[0]?.request.body?.content ?? "").toContain("保留正文");
  });
});

describe("review fix round1 sensitive context", () => {
  // Break caught: Schema property context is dropped before annotations and marker gathering.
  it.each(["mandatory", "configured-field", "configured-pointer"] as const)("masks sensitive schema annotations and their text copies: %s", async (mode) => {
    const artifact = safeDocument();
    const secrets = ["SCHEMA-DEFAULT-PRIVATE", "SCHEMA-EXAMPLE-PRIVATE", "SCHEMA-ENUM-PRIVATE"];
    const leaf: SchemaNode = { kind: "scalar", type: "string", default: secrets[0]!, examples: [secrets[1]!], enum: [secrets[2]!] };
    const publicLeaf: SchemaNode = { kind: "scalar", type: "string", default: "public-default", examples: ["public-example"], enum: ["public-enum"] };
    const name = mode === "mandatory" ? "password" : mode === "configured-field" ? "privateField" : "nested";
    artifact.document!.models[0]!.schema = { kind: "object", properties: {
      [name]: mode === "configured-pointer" ? { kind: "object", properties: { privateArea: leaf }, required: ["privateArea"], additionalProperties: false } : leaf,
      public: publicLeaf,
    }, required: [name, "public"], additionalProperties: false };
    artifact.document!.apis[0]!.documentation = `public-copy ${secrets.join(" ")} ${Buffer.from(secrets[0]!).toString("base64")}`;
    const currentPolicy = { ...policy, extraSensitivePointers: ["/nested/privateArea"] };
    const input = { sourceKind: "member-upload" as const, artifact };
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect(ProjectionPolicySchema.safeParse(currentPolicy).success).toBe(true);
    const dto = await projectPublication(input, currentPolicy);
    expect.soft(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
    const schema = dto.document!.models[0]!.schema;
    if (schema.kind !== "object") throw new Error("public object schema must remain");
    const branch = schema.properties[name]!;
    const masked = mode === "configured-pointer" && branch.kind === "object" ? branch.properties.privateArea! : branch;
    expect.soft(masked).toMatchObject({ kind: "scalar", type: "string", default: "[REDACTED]", examples: ["[REDACTED]"], enum: ["[REDACTED]"] });
    expect.soft(schema.required).toEqual([name, "public"]);
    expect.soft(schema.additionalProperties).toBe(false);
    expect.soft(schema.properties.public).toEqual(publicLeaf);
    for (const secret of [...secrets, Buffer.from(secrets[0]!).toString("base64")]) expect.soft(JSON.stringify(dto)).not.toContain(secret);
    expect.soft(dto.document!.apis[0]!.documentation).toContain("public-copy");
    expect.soft(dto.limitations.some((item) => item.code === "masked")).toBe(true);
  });
  // Break caught: Pointer target masks in place, but its string values never become known markers.
  it.each<{ name: string; pointer: string; body: JsonValue; secrets: string[] }>([
    { name: "scalar", pointer: "/nested/privateArea", body: { nested: { privateArea: "中POINTER-SCALAR-PRIVATE" }, public: "retained" }, secrets: ["中POINTER-SCALAR-PRIVATE"] },
    { name: "parent subtree", pointer: "/nested/privateArea", body: { nested: { privateArea: { left: "中PARENT-A-PRIVATE", values: ["中PARENT-B-PRIVATE"] } }, public: "retained" }, secrets: ["中PARENT-A-PRIVATE", "中PARENT-B-PRIVATE"] },
    { name: "child subtree", pointer: "/nested/privateArea/child", body: { nested: { privateArea: { child: "中CHILD-PRIVATE", sibling: "public-sibling" } }, public: "retained" }, secrets: ["中CHILD-PRIVATE"] },
    { name: "array item", pointer: "/rows/1/memo", body: { rows: [{ memo: "public-sibling" }, { memo: "中ARRAY-PRIVATE" }], public: "retained" }, secrets: ["中ARRAY-PRIVATE"] },
    { name: "escaped tokens", pointer: "/a~1b/~0memo", body: { "a/b": { "~memo": "中ESCAPED-PRIVATE", sibling: "public-sibling" }, public: "retained" }, secrets: ["中ESCAPED-PRIVATE"] },
  ])("collects configured Pointer subtree markers before masking copies: $name", async ({ pointer, body, secrets }) => {
    const artifact = safeDocument();
    artifact.document!.apis[0]!.request.body = { kind: "json", content: JSON.stringify(body) };
    artifact.document!.apis[0]!.responses[0]!.content[0]!.examples[0]!.value = structuredClone(body);
    const copies = secrets.flatMap((secret) => [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]);
    artifact.document!.apis[0]!.documentation = `public-copy ${copies.join(" ")}`;
    const currentPolicy = { ...policy, extraSensitivePointers: [pointer] };
    const input = { sourceKind: "member-upload" as const, artifact };
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect(ProjectionPolicySchema.safeParse(currentPolicy).success).toBe(true);
    const dto = await projectPublication(input, currentPolicy);
    expect.soft(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
    for (const copy of copies) expect.soft(JSON.stringify(dto)).not.toContain(copy);
    const api = dto.document!.apis[0]!;
    expect.soft(api.request.body!.content).toContain('"public":"retained"');
    expect.soft(api.responses[0]!.content[0]!.examples[0]!.value).toMatchObject({ public: "retained" });
    if (JSON.stringify(body).includes("public-sibling")) expect.soft(api.request.body!.content).toContain("public-sibling");
    expect.soft(api.documentation).toContain("public-copy");
    expect.soft(api.documentation).toContain("[REDACTED]");
    expect.soft(dto.limitations.some((item) => item.code === "masked")).toBe(true);
  });
});

describe("review fix round2 structural code collisions", () => {
  // Break caught: a known secret equal to a machine literal/enum corrupts the validated DTO.
  it.each(["string", "scalar", "document", "member-claim", "http", "draft", "query", "json", "example", "none"])("preserves document structure but masks business copies of %s", async (marker) => {
    const artifact = safeDocument();
    artifact.document!.components.push({ id: "auth-1", name: "public auth", description: "", kind: "auth", scheme: "none" });
    artifact.document!.models[0]!.schema = { kind: "object", properties: {
      password: { kind: "scalar", type: "string", default: marker, examples: [marker], enum: [marker] },
      public: { kind: "scalar", type: "string", default: "retained-public" },
    }, required: ["password", "public"], additionalProperties: false };
    artifact.document!.apis[0]!.documentation = `copy ${marker}`;
    artifact.document!.apis[0]!.request.body = { kind: "json", content: JSON.stringify({ kind: marker, type: marker, protocol: marker, public: "retained" }) };
    const input = { sourceKind: "member-upload" as const, artifact };
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect(ProjectionPolicySchema.safeParse(policy).success).toBe(true);
    const dto = await projectPublication(input, policy);
    expect.soft(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
    expect.soft(dto.kind).toBe("document"); expect.soft(dto.source.trust).toBe("member-claim");
    const api = dto.document!.apis[0]!;
    expect.soft(api.status).toBe("draft"); expect.soft(api.request.protocol).toBe("http");
    expect.soft(api.request.parameters[0]!.location).toBe("query"); expect.soft(api.request.body!.kind).toBe("json");
    expect.soft(dto.document!.components[0]!.kind).toBe("example");
    expect.soft(dto.document!.components[1]).toMatchObject({ kind: "auth", scheme: "none" });
    const schema = dto.document!.models[0]!.schema;
    if (schema.kind !== "object") throw new Error("object schema must remain");
    expect.soft(schema.properties.password).toEqual({ kind: "scalar", type: "string", default: "[REDACTED]", examples: ["[REDACTED]"], enum: ["[REDACTED]"] });
    expect.soft(schema.properties.public).toEqual({ kind: "scalar", type: "string", default: "retained-public" });
    expect.soft(api.documentation).toBe("copy [REDACTED]");
    expect.soft(JSON.parse(api.request.body!.content!)).toEqual({ kind: "[REDACTED]", type: "[REDACTED]", protocol: "[REDACTED]", public: "retained" });
  });
  it.each(["report", "stress", "available", "measurement", "passed"])("preserves report structure but masks business copies of %s", async (marker) => {
    const artifact = safeReport();
    artifact.report!.nodes[0]!.name = `copy ${marker}`;
    artifact.report!.evidence[0]!.responseBody = JSON.stringify({ privateField: marker, kind: marker, type: marker, public: "retained" });
    const currentPolicy = { ...policy, includeEvidence: true };
    const input = { sourceKind: "member-upload" as const, artifact };
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect(ProjectionPolicySchema.safeParse(currentPolicy).success).toBe(true);
    const dto = await projectPublication(input, currentPolicy);
    expect.soft(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
    expect.soft(dto.kind).toBe("report"); expect.soft(dto.report!.sourceCategory).toBe("stress");
    expect.soft(dto.report!.stress!.phases[0]!.phase).toBe("measurement");
    expect.soft(dto.report!.stress!.rps.availability).toBe("available");
    expect.soft(dto.report!.stress!.lifecycle[0]!.state).toBe("passed");
    expect.soft(dto.report!.nodes[0]!.name).toBe("copy [REDACTED]");
    expect.soft(JSON.parse(dto.report!.evidence[0]!.responseBody!)).toEqual({ privateField: "[REDACTED]", kind: "[REDACTED]", type: "[REDACTED]", public: "retained" });
  });
});
