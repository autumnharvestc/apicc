import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SyncSourceSaveInputSchema, SyncPolicySaveInputSchema, SyncApplicationInputSchema, SyncRollbackRequestSchema, syncWireSchemas } from "../src/contract/synchronization.js";
import { resolveSyncPolicy } from "@apicc/core/sync";
import { defaultSyncPolicy, deploymentLimits, hashA, sourceAddressCases, sourceAddressInput } from "../../core/tests/sync/fixtures.js";
import { syncWireFixture, candidateId, intentId, historyId } from "../../core/tests/sync/wireFixtures.js";

type Boundary = Record<string, z.core.JSONSchema.JSONSchema>;
const generatorUrl = new URL("../scripts/generate-java-sync-schema.mjs", import.meta.url).href;
const { buildSyncBoundary, checkSyncBoundaryBytes }: { buildSyncBoundary: (schemas: Record<string, z.ZodType>) => Boundary; checkSyncBoundaryBytes: (actual: string, expected: string) => void } = await import(generatorUrl);

const requests = () => {
  const f = syncWireFixture();
  const expected = { formatVersion: 1, intentId, expectedSourceRevision: "1", expectedAssetVersion: "900719925474099312345" };
  return [
    { name: "source save", schema: SyncSourceSaveInputSchema, value: { ...expected, source: f.source } },
    { name: "policy save", schema: SyncPolicySaveInputSchema, value: { formatVersion: 1, intentId, expectedRevision: "0", policy: defaultSyncPolicy() } },
    { name: "application", schema: SyncApplicationInputSchema, value: { ...expected, sourceId: f.source.id, candidateId, candidateDigest: hashA, decisions: f.decisions, decisionsDigest: hashA } },
    { name: "rollback", schema: SyncRollbackRequestSchema, value: { ...expected, sourceId: f.source.id, historyId } },
  ];
};

describe("synchronization save/application wire", () => {
  for (const { name, schema, value } of requests()) {
    it(`round-trips a legal ${name} request`, () => {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    });
    it(`rejects unknown material fields in ${name}`, () => {
      expect(schema.safeParse({ ...value, materialLease: { privateKey: "private" } }).success).toBe(false);
    });
    it(`requires stable intent identity in ${name}`, () => {
      const input: Record<string, unknown> = { ...value };
      delete input.intentId;
      expect(schema.safeParse(input).success).toBe(false);
    });
    it(`rejects malformed intent identity in ${name}`, () => {
      expect(schema.safeParse({ ...value, intentId: "random-request" }).success).toBe(false);
    });
    it(`rejects an unsupported format version in ${name}`, () => {
      expect(schema.safeParse({ ...value, formatVersion: 2 }).success).toBe(false);
    });
  }
  for (const { name, schema, value } of requests().filter(r => r.name !== "policy save")) {
    it(`keeps ${name} expected asset versions as exact decimal strings`, () => {
      expect(schema.safeParse({ ...value, expectedAssetVersion: 9007199254740992 }).success).toBe(false);
    });
    it(`requires ${name} expected source revision`, () => {
      const input: Record<string, unknown> = { ...value };
      delete input.expectedSourceRevision;
      expect(schema.safeParse(input).success).toBe(false);
    });
  }
  it("requires policy save CAS as a decimal revision string", () => {
    const input = requests().find(r => r.name === "policy save")!.value;
    expect(SyncPolicySaveInputSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
  });
  it("requires both candidate and complete decision digests on apply", () => {
    const input: Record<string, unknown> = { ...requests().find(r => r.name === "application")!.value };
    delete input.decisionsDigest;
    expect(SyncApplicationInputSchema.safeParse(input).success).toBe(false);
    expect(SyncApplicationInputSchema.safeParse({ ...input, decisionsDigest: "short" }).success).toBe(false);
  });
  it("requires a fixed target history on rollback", () => {
    const input: Record<string, unknown> = { ...requests().find(r => r.name === "rollback")!.value };
    delete input.historyId;
    expect(SyncRollbackRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("generated synchronization JSON boundary", () => {
  const generatedSource = z.fromJSONSchema(buildSyncBoundary(syncWireSchemas).source);
  for (const kind of ["url", "git-https", "git-ssh"] as const) {
    it.each(sourceAddressCases)(`${kind} generated address syntax: $authority => $accepted`, ({ authority, accepted }) => {
      expect(generatedSource.safeParse(sourceAddressInput(kind, authority)).success).toBe(accepted);
    });
  }
  it("rejects validation metadata overriding strict additionalProperties", () => {
    const original = z.object({ value: z.string().min(5) }).strict();
    expect(original.safeParse({ value: "valid", unknown: true }).success).toBe(false);
    expect(() => buildSyncBoundary({ input: original.meta({ additionalProperties: true }) })).toThrow(/metadata/);
  });
  it("rejects metadata lowering a nested string validation boundary", () => {
    const value = z.string().min(5);
    expect(value.safeParse("short".slice(0, 1)).success).toBe(false);
    expect(() => buildSyncBoundary({ input: z.object({ value: value.meta({ minLength: 0 }) }).strict() })).toThrow(/metadata/);
  });
  it.each([
    { type: "number" }, { properties: { value: {} } }, { required: [] }, { anyOf: [{}] },
    { pattern: ".*" }, { default: { value: "x" } }, { id: "redefined-schema" },
  ])("rejects validation-keyword metadata %j", metadata => {
    expect(() => buildSyncBoundary({ input: z.object({ value: z.string().min(5) }).strict().meta(metadata) })).toThrow(/metadata/);
  });
  it("preserves descriptive metadata without changing validation semantics", () => {
    const document = buildSyncBoundary({ input: z.object({ value: z.string().min(5).meta({ description: "Five or more characters" }) }).strict().meta({ title: "Safe annotation", description: "Only annotations", deprecated: false, examples: [{ value: "valid" }], $comment: "No validation overrides" }) });
    expect(document.input.title).toBe("Safe annotation");
    expect(document.input.description).toBe("Only annotations");
    const consumer = z.fromJSONSchema(document.input);
    expect(consumer.safeParse({ value: "valid" }).success).toBe(true);
    expect(consumer.safeParse({ value: "x" }).success).toBe(false);
    expect(consumer.safeParse({ value: "valid", unknown: true }).success).toBe(false);
  });
  it("checks generated object strictness without rejecting finite enum-key records", () => {
    const keys = z.enum(["first", "second"]);
    const document = buildSyncBoundary({ input: z.object({ selected: keys, values: z.record(keys, z.string()) }).strict() });
    const consumer = z.fromJSONSchema(document.input);
    expect(consumer.safeParse({ selected: "first", values: { first: "one", second: "two" } }).success).toBe(true);
    expect(consumer.safeParse({ selected: "first", values: { first: "one", second: "two", arbitrary: "three" } }).success).toBe(false);
    expect(() => buildSyncBoundary({ input: z.record(z.string(), z.string()) })).toThrow(/strict/);
  });
  it("checks exact generated bytes and detects a stale or edited Java resource", () => {
    expect(() => checkSyncBoundaryBytes('{"source":{}}\n', '{"source":{}}\n')).not.toThrow();
    expect(() => checkSyncBoundaryBytes('{"source":{}}\n', '{"source":{"additionalProperties":false}}\n')).toThrow(/SYNC_SCHEMA_DRIFT/);
  });
  it("consumes a legal source and rejects SSH material omission via generated JSON Schema", () => {
    const schema = z.fromJSONSchema(buildSyncBoundary(syncWireSchemas).source);
    const source = { ...syncWireFixture().source, kind: "git-ssh", url: undefined, authRef: undefined,
      repositoryUrl: "ssh://git@git.example.test/team/pets.git", ref: "refs/heads/main", filePath: "spec/openapi.json", privateKeyRef: "key", knownHostsRef: "hosts" };
    const legal = JSON.parse(JSON.stringify(source));
    expect(schema.safeParse(legal).success).toBe(true);
    delete legal.knownHostsRef;
    expect(schema.safeParse(legal).success).toBe(false);
  });
  it("keeps integer ranges and unknown-field rejection when consumed from JSON Schema", () => {
    const schema = z.fromJSONSchema(buildSyncBoundary(syncWireSchemas).policy);
    const legal = defaultSyncPolicy();
    expect(schema.safeParse(legal).success).toBe(true);
    expect(schema.safeParse({ ...legal, maxAttempts: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...legal, maxAttempts: 4 }).success).toBe(false);
    expect(schema.safeParse({ ...legal, autoApply: true }).success).toBe(false);
  });
  it("separates expressible wire structure from explicit effective-policy rules", () => {
    const policy = defaultSyncPolicy();
    expect(z.fromJSONSchema(buildSyncBoundary(syncWireSchemas).policy).safeParse(policy).success).toBe(true);
    expect(() => resolveSyncPolicy(policy, { maxWireBytes: 8 * 1024 * 1024, envelopeReserveBytes: 128 * 1024 })).toThrowError("SYNC_POLICY_INVALID");
    expect(resolveSyncPolicy(policy, deploymentLimits).policy.maxCompareInputBytes).toBe(16 * 1024 * 1024);
  });
  for (const [name, schema] of [
    ["unknown", z.unknown()], ["any", z.any()],
    ["transform", z.string().transform(v => v)], ["pipe", z.string().pipe(z.string().min(2))],
    ["overwrite", z.string().overwrite(v => v.trim())],
    ["custom refinement", z.object({ value: z.number() }).strict().refine(v => v.value > 0)],
    ["super refinement", z.object({ value: z.number() }).strict().superRefine((v, ctx) => { if (v.value < 0) ctx.addIssue({ code: "custom", message: "negative" }); })],
    ["untrusted metadata substitution", z.string().refine(v => v.length > 0).meta({ apiccJsonWireSchema: z.string() })],
  ] as const) {
    it(`fails closed on ${name} rather than emitting a permissive boundary`, () => {
      expect(() => buildSyncBoundary({ input: schema })).toThrow(/Unrepresented/);
    });
  }
  it("finds unrepresented checks inside nested optional union arrays", () => {
    const schema = z.object({ values: z.array(z.union([z.string(), z.object({ value: z.number().refine(v => v > 0) }).strict()])).optional() }).strict();
    expect(() => buildSyncBoundary({ input: schema })).toThrow(/Unrepresented/);
  });
  it.each([z.object({ value: z.string() }), z.object({ value: z.string() }).passthrough(), z.object({ value: z.string() }).catchall(z.string())])("rejects a non-strict object root", schema => {
    expect(() => buildSyncBoundary({ input: schema })).toThrow(/strict/);
  });
  it.each(["$ref", "$dynamicRef", "$recursiveRef"])("rejects nonlocal generated %s", key => {
    expect(() => buildSyncBoundary({ input: z.string().meta({ [key]: "https://remote.example.test/schema" }) })).toThrow(/Nonlocal/);
  });
});
