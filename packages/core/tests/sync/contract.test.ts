import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { ContractProjectSchema } from "../../src/contract/workspace.js";
import { resolveSyncPolicy } from "../../src/sync/policy.js";
import { defaultSyncPolicyValues, SyncCandidateSchema, SyncCandidateViewSchema, SyncDecisionsSchema, SyncDeploymentLimitsSchema, SyncEffectivePolicySchema, SyncHistoryEntrySchema, SyncIdentityMapSchema, SyncNormalizeInputSchema, SyncNormalizedSourceSchema, SyncPlanInputSchema, SyncPolicySchema, SyncPolicyValuesSchema, SyncReceiptSchema, SyncResolvedPlanSchema, SyncResolveInputSchema, SyncRollbackInputSchema, SyncSourceSchema, SyncStampSchema, SyncUpstreamSchema, SourceReadInputSchema, SourceReadResultSchema, type SyncPolicy } from "../../src/sync/shared.js";
import { syncWireFixture } from "./wireFixtures.js";
import { defaultSyncPolicy, deploymentLimits, gitHttpsSource, gitSshSource, hashA, MiB, sourceAddressCases, sourceAddressInput, syncFixture, urlSource } from "./fixtures.js";

describe("sync contract legal prerequisites", () => {
  it("loads the built sync subpaths and bundles the shared entry without Node or host APIs", async () => {
    const shared = await import("@apicc/core/sync/shared");
    const host = await import("@apicc/core/sync");
    expect(typeof shared.SyncSourceSchema.parse).toBe("function");
    expect("resolveSyncPolicy" in shared).toBe(false);
    expect(typeof host.resolveSyncPolicy).toBe("function");
    const require = createRequire(import.meta.url);
    const vite = createRequire(require.resolve("vitest/package.json")).resolve("vite");
    const { build } = await import(pathToFileURL(vite).href);
    const modules: string[] = [];
    await build({ configFile: false, logLevel: "silent", build: { write: false, minify: false,
      lib: { entry: resolve("src/sync/shared.ts"), formats: ["es"], fileName: "sync-shared" } },
      plugins: [{ name: "inspect-sync-shared", generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
        for (const item of Object.values(bundle)) if (item.type === "chunk") modules.push(...Object.keys(item.modules ?? {}));
      } }],
    });
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter(id => /(?:node:|browser-external|\/storage\/|\/source-host\/|\/sync\/policy\.)/.test(id.replace(/\\/g, "/")))).toEqual([]);
  });
  it("builds a valid Pet project with a case and a real response-to-model reference", () => {
    const fixture = syncFixture();
    expect(ContractProjectSchema.safeParse(fixture.localProject).success).toBe(true);
    expect(createProjectSnapshot(fixture.localProject).context.diagnostics).toEqual([]);
    const api = fixture.localProject.collections[0]!.apis[0]!;
    expect(api.contract.request).toMatchObject({ path: "/pets/{id}" });
    expect(api.cases[0]).toMatchObject({ name: "returns a Pet" });
    const response = api.contract.responses[0]!;
    expect(response).toMatchObject({ status: "200", content: { "application/json": { schema: { kind: "modelRef", modelId: fixture.localProject.models[0]!.id } } } });
    expect(fixture.rawText).toContain('"openapi":"3.1.0"');
    expect(fixture.stamp.definitionRevision).toBe(createProjectSnapshot(fixture.localProject).definitionRevision);
  });

  it("encodes the current local project each time planInput is called", () => {
    const fixture = syncFixture();
    const before = fixture.planInput();
    fixture.localProject.name = "Edited locally";
    const after = fixture.planInput();
    expect(after.localFiles).not.toEqual(before.localFiles);
    expect(after.localFiles.find(file => file.path === "project.yaml")!.content).toContain("Edited locally");
    expect(after.stamp.definitionRevision).not.toBe(before.stamp.definitionRevision);
    expect(after.baselineFiles).toEqual(before.baselineFiles);
  });

  it.each([urlSource, gitHttpsSource, gitSshSource])("accepts the legal %s source fixture", make => {
    const source = make();
    expect(SyncSourceSchema.safeParse(source).success).toBe(true);
    expect(SyncSourceSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
  });
});

describe("strict sync map, candidate, decisions, history and source-read wire", () => {
  const cases = () => {
    const f = syncWireFixture();
    return [
      { name: "mapping", schema: SyncIdentityMapSchema, value: f.mapping },
      { name: "candidate", schema: SyncCandidateSchema, value: f.candidate },
      { name: "candidate view", schema: SyncCandidateViewSchema, value: { candidate: f.candidate, applicable: false, reasonCode: "source-revision-changed" } },
      { name: "decisions", schema: SyncDecisionsSchema, value: f.decisions },
      { name: "resolved plan", schema: SyncResolvedPlanSchema, value: f.resolved },
      { name: "receipt", schema: SyncReceiptSchema, value: f.receipt },
      { name: "history", schema: SyncHistoryEntrySchema, value: f.history },
      { name: "source read input", schema: SourceReadInputSchema, value: f.sourceReadInput },
      { name: "source read result", schema: SourceReadResultSchema, value: f.sourceReadResult },
      { name: "normalize input", schema: SyncNormalizeInputSchema, value: f.normalizeInput },
      { name: "normalized source", schema: SyncNormalizedSourceSchema, value: f.normalized },
      { name: "plan input", schema: SyncPlanInputSchema, value: f.planInput },
      { name: "resolve input", schema: SyncResolveInputSchema, value: { candidate: f.candidate, decisions: f.decisions, planInput: f.planInput } },
      { name: "rollback input", schema: SyncRollbackInputSchema, value: { history: f.history, currentFiles: f.planInput.localFiles, currentStamp: f.stamp, beforeFiles: f.planInput.localFiles, afterFiles: f.planInput.localFiles, mapping: f.mapping, baselineFiles: f.planInput.baselineFiles, otherSourceMappings: [], budget: f.planInput.budget } },
    ];
  };
  for (const { name, schema, value } of cases()) {
    it(`round-trips legal ${name} without losing fields`, () => {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    });
    it(`rejects an arbitrary unknown field on ${name}`, () => {
      expect(schema.safeParse({ ...value, unexpected: "wire data" }).success).toBe(false);
    });
  }
  it("rejects an unrecognized mapping algorithm", () => {
    expect(SyncIdentityMapSchema.safeParse({ ...syncWireFixture().mapping, algorithm: "random-uuid" }).success).toBe(false);
  });
  it.each(["entityKind", "ownership", "correspondence"])("rejects mapping entry with unknown %s", field => {
    const f = syncWireFixture();
    expect(SyncIdentityMapSchema.safeParse({ ...f.mapping, entries: [{ ...f.mapping.entries[0], [field]: "other" }] }).success).toBe(false);
  });
  it("rejects shared source ownership rather than granting two sources write authority", () => {
    const f = syncWireFixture();
    expect(SyncIdentityMapSchema.safeParse({ ...f.mapping, entries: [{ ...f.mapping.entries[0], ownership: "shared" }] }).success).toBe(false);
  });
  it("rejects a mapped identity that is not a UUID", () => {
    const f = syncWireFixture();
    expect(SyncIdentityMapSchema.safeParse({ ...f.mapping, entries: [{ ...f.mapping.entries[0], entityId: "not-a-uuid" }] }).success).toBe(false);
  });
  it("rejects alias objects carrying unconfirmed or arbitrary material", () => {
    const f = syncWireFixture();
    expect(SyncIdentityMapSchema.safeParse({ ...f.mapping, entries: [{ ...f.mapping.entries[0], aliases: [{ key: "old", confirmed: false }] }] }).success).toBe(false);
  });
  it.each(["parameter", "response", "example", "schema-property"])("covers referencable subentity kind %s", entityKind => {
    const f = syncWireFixture();
    expect(SyncIdentityMapSchema.safeParse({ ...f.mapping, entries: [{ ...f.mapping.entries[0], entityKind }] }).success).toBe(true);
  });
  it.each(["raw", "project", "unknown", "applicable"])("does not put %s in immutable candidate content", field => {
    expect(SyncCandidateSchema.safeParse({ ...syncWireFixture().candidate, [field]: {} }).success).toBe(false);
  });
  it("rejects arbitrary nested change content", () => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, changes: [{ ...f.change, raw: { project: {} } }] }).success).toBe(false);
  });
  it.each(["layer", "operation", "entityKind"])("rejects unknown candidate change %s", field => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, changes: [{ ...f.change, [field]: "other" }] }).success).toBe(false);
  });
  it("rejects malformed stable change IDs", () => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, changes: [{ ...f.change, changeId: "random" }] }).success).toBe(false);
  });
  it.each(["", "/metadata/description", "/a~0b", "/a~1b", "/properties/name", "/"])("accepts field-level JSON Pointer %s independently of file path", fieldPath => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, changes: [{ ...f.change, fieldPath }] }).success).toBe(true);
  });
  it.each(["metadata/description", "/~2bad", "/~", "/x~01~invalid"])("rejects invalid field-level JSON Pointer %s", fieldPath => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, changes: [{ ...f.change, fieldPath }] }).success).toBe(false);
  });
  it.each([-1, 0.5])("rejects non-count summary values %s", updated => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, summary: { ...f.candidate.summary, updated } }).success).toBe(false);
  });
  it("rejects unrecognized semantic diagnostic severity", () => {
    const f = syncWireFixture();
    expect(SyncCandidateSchema.safeParse({ ...f.candidate, diagnostics: [{ ...f.candidate.diagnostics[0], severity: "other" }] }).success).toBe(false);
  });
  it("rejects an undeclared candidate applicability reason", () => {
    expect(SyncCandidateViewSchema.safeParse({ candidate: syncWireFixture().candidate, applicable: false, reasonCode: "anything" }).success).toBe(false);
  });
  it("keeps immutable candidate content unchanged when current applicability changes", () => {
    const f = syncWireFixture();
    expect(SyncCandidateViewSchema.parse({ candidate: f.candidate, applicable: true, reasonCode: null })).toEqual({ candidate: f.candidate, applicable: true, reasonCode: null });
  });
  it.each(["take-source", "keep-current"])("accepts decision %s", decision => {
    const f = syncWireFixture();
    expect(SyncDecisionsSchema.safeParse({ ...f.decisions, entries: [{ changeId: hashA, decision }] }).success).toBe(true);
  });
  it("accepts a map-existing decision with an explicit UUID", () => {
    const f = syncWireFixture();
    expect(SyncDecisionsSchema.safeParse({ ...f.decisions, entries: [{ changeId: hashA, decision: "map-existing", existingEntityId: f.change.entityId }] }).success).toBe(true);
  });
  it.each(["force", "auto-apply"])("rejects unknown decision %s", decision => {
    const f = syncWireFixture();
    expect(SyncDecisionsSchema.safeParse({ ...f.decisions, entries: [{ changeId: hashA, decision }] }).success).toBe(false);
  });
  it("requires a map-existing target", () => {
    const f = syncWireFixture();
    expect(SyncDecisionsSchema.safeParse({ ...f.decisions, entries: [{ changeId: hashA, decision: "map-existing" }] }).success).toBe(false);
  });
  it("rejects a target field on a keep-current decision", () => {
    const f = syncWireFixture();
    expect(SyncDecisionsSchema.safeParse({ ...f.decisions, entries: [{ changeId: hashA, decision: "keep-current", existingEntityId: f.change.entityId }] }).success).toBe(false);
  });
  it("rejects unsafe paths in resolved writes", () => {
    const f = syncWireFixture();
    expect(SyncResolvedPlanSchema.safeParse({ ...f.resolved, writes: [{ path: "../project.yaml", content: "unsafe" }] }).success).toBe(false);
  });
  it("rejects unsafe deletion paths", () => {
    expect(SyncResolvedPlanSchema.safeParse({ ...syncWireFixture().resolved, deletions: ["/project.yaml"] }).success).toBe(false);
  });
  it("rejects malformed rollback content identities", () => {
    const f = syncWireFixture();
    expect(SyncHistoryEntrySchema.safeParse({ ...f.history, rollback: { ...f.history.rollback, beforeContent: { ...f.contentRef, digest: "short" } } }).success).toBe(false);
  });
  it("rejects arbitrary content reference types", () => {
    const f = syncWireFixture();
    expect(SyncHistoryEntrySchema.safeParse({ ...f.history, rollback: { ...f.history.rollback, beforeContent: { ...f.contentRef, contentType: "application/octet-stream" } } }).success).toBe(false);
  });
  it.each([-1, 1.5])("rejects invalid protected content byte count %s", bytes => {
    const f = syncWireFixture();
    expect(SyncHistoryEntrySchema.safeParse({ ...f.history, rollback: { ...f.history.rollback, beforeContent: { ...f.contentRef, bytes } } }).success).toBe(false);
  });
  it("rejects numeric online asset versions in receipt afterStamp", () => {
    const f = syncWireFixture();
    expect(SyncReceiptSchema.safeParse({ ...f.receipt, afterStamp: { ...f.stamp, kind: "online", assetVersion: 9007199254740992 } }).success).toBe(false);
  });
  it("rejects raw secrets embedded in receipt actors", () => {
    const f = syncWireFixture();
    expect(SyncReceiptSchema.safeParse({ ...f.receipt, actor: { ...f.receipt.actor, token: "secret" } }).success).toBe(false);
  });
  it.each(["materialLease", "privateKey", "passphrase", "signal"])("rejects %s in serializable source-read input", field => {
    expect(SourceReadInputSchema.safeParse({ ...syncWireFixture().sourceReadInput, [field]: "private" }).success).toBe(false);
  });
  it("requires a bounded source-read deadline", () => {
    expect(SourceReadInputSchema.safeParse({ ...syncWireFixture().sourceReadInput, deadlineAtMs: Infinity }).success).toBe(false);
  });
  it("rejects a source-read result without fixed upstream identity", () => {
    const input: Record<string, unknown> = { ...syncWireFixture().sourceReadResult };
    delete input.upstream;
    expect(SourceReadResultSchema.safeParse(input).success).toBe(false);
  });
  it("requires raw text for a completed source read", () => {
    const input: Record<string, unknown> = { ...syncWireFixture().sourceReadResult };
    delete input.rawText;
    expect(SourceReadResultSchema.safeParse(input).success).toBe(false);
  });
  it("represents not-modified reads with the fixed upstream and no new raw text", () => {
    const f = syncWireFixture();
    expect(SourceReadResultSchema.parse({ formatVersion: 1, status: "not-modified", upstream: f.upstream, diagnostics: [] })).toEqual({ formatVersion: 1, status: "not-modified", upstream: f.upstream, diagnostics: [] });
  });
  it("rejects new raw text on a not-modified result", () => {
    const f = syncWireFixture();
    expect(SourceReadResultSchema.safeParse({ ...f.sourceReadResult, status: "not-modified" }).success).toBe(false);
  });
});

describe("strict SyncSource wire", () => {
  for (const kind of ["url", "git-https", "git-ssh"] as const) {
    it.each(sourceAddressCases)(`${kind} supported address syntax: $authority => $accepted`, ({ authority, accepted }) => {
      const input = sourceAddressInput(kind, authority);
      if (accepted) expect(() => new URL("url" in input ? input.url : input.repositoryUrl)).not.toThrow();
      expect(SyncSourceSchema.safeParse(input).success).toBe(accepted);
    });
  }
  it.each(["https://example.test:99999/openapi.json", "https://[.]/openapi.json"])("rejects an address that the same Node URL parser cannot parse: %s", url => {
    expect(() => new URL(url)).toThrow();
    expect(SyncSourceSchema.safeParse({ ...urlSource(), url }).success).toBe(false);
  });
  // Each mutation names the missing production guard; the fixture is valid first.
  it("rejects SSH without approved host-key material", () => {
    const input: Record<string, unknown> = { ...gitSshSource() };
    delete input.knownHostsRef;
    expect(SyncSourceSchema.safeParse(input).success).toBe(false);
  });
  it("rejects SSH without private-key material", () => {
    const input: Record<string, unknown> = { ...gitSshSource() };
    delete input.privateKeyRef;
    expect(SyncSourceSchema.safeParse(input).success).toBe(false);
  });
  it.each(["password", "privateKey", "passphrase", "knownHosts", "toolPath", "raw", "project"])("rejects the non-reference/unknown field %s", field => {
    expect(SyncSourceSchema.safeParse({ ...gitSshSource(), [field]: "must-not-persist" }).success).toBe(false);
  });
  it("rejects unknown nested schedule fields", () => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, script: "run" } }).success).toBe(false);
  });
  it.each(["ftp", "git", "file", "other"])("rejects unknown source kind %s", kind => {
    expect(SyncSourceSchema.safeParse({ ...urlSource(), kind }).success).toBe(false);
  });
  it("rejects fields from another source variant", () => {
    expect(SyncSourceSchema.safeParse({ ...urlSource(), repositoryUrl: "https://git.example.test/a.git" }).success).toBe(false);
  });
  it.each(["https://user:password@spec.example.test/openapi.json", "https://user@spec.example.test/openapi.json", "file:///tmp/openapi.json", "ftp://spec.example.test/openapi.json", "not-a-url"])("rejects unsafe URL %s", url => {
    expect(SyncSourceSchema.safeParse({ ...urlSource(), url }).success).toBe(false);
  });
  it.each(["http://git.example.test/a.git", "ssh://git@git.example.test/a.git", "https://user:password@git.example.test/a.git"])("rejects HTTPS Git repository %s", repositoryUrl => {
    expect(SyncSourceSchema.safeParse({ ...gitHttpsSource(), repositoryUrl }).success).toBe(false);
  });
  it.each(["https://git.example.test/a.git", "ssh://git:password@git.example.test/a.git", "git@git.example.test:a.git"])("rejects SSH Git repository %s", repositoryUrl => {
    expect(SyncSourceSchema.safeParse({ ...gitSshSource(), repositoryUrl }).success).toBe(false);
  });
  it.each(["../openapi.json", "/openapi.json", "spec/./openapi.json", "spec//openapi.json", "spec\\openapi.json", "C:/spec.json", "spec/../openapi.json", "spec/", ""])("rejects noncanonical repository path %s", filePath => {
    expect(SyncSourceSchema.safeParse({ ...gitHttpsSource(), filePath }).success).toBe(false);
  });
  it.each(["", "-upload-pack=sh", "refs/heads/a..b", "refs/heads/a b", "refs/heads/a\n"])("rejects unsafe Git revision selector %s", ref => {
    expect(SyncSourceSchema.safeParse({ ...gitHttpsSource(), ref }).success).toBe(false);
  });
  it.each(["id", "moduleId"])("rejects malformed source identity %s", field => {
    expect(SyncSourceSchema.safeParse({ ...urlSource(), [field]: "not-a-uuid" }).success).toBe(false);
  });
  it.each([0, 2, "1"])("rejects source format version %s", formatVersion => {
    expect(SyncSourceSchema.safeParse({ ...urlSource(), formatVersion }).success).toBe(false);
  });
  it.each(["01", "-1", "1.0", "", 1])("rejects noncanonical source revision %s", revision => {
    expect(SyncSourceSchema.safeParse({ ...urlSource(), revision }).success).toBe(false);
  });
  it("prefills a disabled hourly UTC six-field Cron schedule", () => {
    const input: Record<string, unknown> = { ...urlSource() };
    delete input.schedule;
    expect(SyncSourceSchema.parse(input).schedule).toEqual({ enabled: false, rule: { kind: "cron", expression: "0 0 * * * *", timeZone: "UTC", dstOverlap: "first" } });
  });
  it("does not share mutable nested Cron defaults between different saved sources", () => {
    const input: Record<string, unknown> = { ...urlSource() };
    delete input.schedule;
    const first = SyncSourceSchema.parse(input);
    first.schedule.rule.expression = "* * * * * *";
    expect(SyncSourceSchema.parse(input).schedule.rule.expression).toBe("0 0 * * * *");
  });
  it("allows a separate SSH passphrase reference", () => {
    expect(SyncSourceSchema.parse({ ...gitSshSource(), passphraseRef: "key-passphrase-1" })).toMatchObject({ passphraseRef: "key-passphrase-1" });
  });
  it.each(["privateKeyRef", "knownHostsRef", "passphraseRef"])("rejects empty SSH material reference %s", field => {
    expect(SyncSourceSchema.safeParse({ ...gitSshSource(), [field]: "" }).success).toBe(false);
  });
  it.each(["", "0 * * * *", "0 ".repeat(300)])("rejects structurally invalid or unbounded Cron expression %s", expression => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { ...source.schedule.rule, expression } } }).success).toBe(false);
  });
  it.each(["", "A".repeat(129)])("rejects structurally invalid or unbounded timezone %s", timeZone => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { ...source.schedule.rule, timeZone } } }).success).toBe(false);
  });
  it.each(["first", "both"])("accepts Cron DST overlap %s", dstOverlap => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { ...source.schedule.rule, dstOverlap } } }).success).toBe(true);
  });
  it.each(["last", "all"])("rejects Cron DST overlap %s", dstOverlap => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { ...source.schedule.rule, dstOverlap } } }).success).toBe(false);
  });
  it("rejects unknown Cron rule fields", () => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { ...source.schedule.rule, intervalSeconds: 3600 } } }).success).toBe(false);
  });
  it("rejects the once schedule variant for source synchronization", () => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { kind: "once", timeZone: "UTC", atUtc: "2030-01-01T00:00:00Z" } } }).success).toBe(false);
  });
  it("leaves IANA existence and Cron frequency semantics to the Java calculator", () => {
    const source = urlSource();
    expect(SyncSourceSchema.safeParse({ ...source, schedule: { ...source.schedule, rule: { ...source.schedule.rule, expression: "* * * * * *", timeZone: "not/a/timezone" } } }).success).toBe(true);
  });
});

const policyRanges: [keyof SyncPolicy, number, number][] = [
  ["connectTimeoutMs", 1000, 60000], ["urlDeadlineMs", 5000, 600000], ["gitDeadlineMs", 10000, 1800000],
  ["maxAttempts", 1, 3], ["maxSourceBytes", 65536, 16 * MiB], ["maxCompareInputBytes", MiB, 64 * MiB],
  ["maxCompareOutputBytes", 256 * 1024, 32 * MiB], ["gitDiskThresholdBytes", 32 * MiB, 2 * 1024 * MiB],
  ["projectConcurrency", 1, 4], ["hostConcurrency", 1, 16], ["candidateTtlMs", 300000, 604800000],
  ["historyRetentionDays", 1, 365], ["historyMaxEntries", 1, 1000],
];
describe("SyncPolicy R0 wire units and ranges", () => {
  it("preserves saved omissions instead of filling defaults before source resolution", () => {
    expect(SyncPolicySchema.parse({ formatVersion: 1, revision: "0", scope: "project" })).toEqual({ formatVersion: 1, revision: "0", scope: "project" });
  });
  it("validates the independent R0 defaults through the complete-value schema", () => {
    const { formatVersion: _formatVersion, revision: _revision, scope: _scope, ...values } = defaultSyncPolicy();
    expect(SyncPolicyValuesSchema.parse(defaultSyncPolicyValues)).toEqual(values);
  });
  for (const [field, min, max] of policyRanges) {
    it.each([min, max])(`accepts ${field} boundary %s`, value => {
      expect(SyncPolicySchema.safeParse({ ...defaultSyncPolicy(), [field]: value }).success).toBe(true);
    });
    it.each([min - 1, max + 1, min + 0.5])(`rejects ${field} outside integer range: %s`, value => {
      expect(SyncPolicySchema.safeParse({ ...defaultSyncPolicy(), [field]: value }).success).toBe(false);
    });
  }
  it("rejects unknown policy fields", () => {
    expect(SyncPolicySchema.safeParse({ ...defaultSyncPolicy(), autoApply: true }).success).toBe(false);
  });
  it("rejects future policy format versions", () => {
    expect(SyncPolicySchema.safeParse({ ...defaultSyncPolicy(), formatVersion: 2 }).success).toBe(false);
  });
});

describe("resolveSyncPolicy cross-field restrictions", () => {
  it("resolves legal baseline with explicit saved revision and next-check semantics", () => {
    const { formatVersion: _formatVersion, revision: _revision, scope: _scope, ...values } = defaultSyncPolicy();
    expect(resolveSyncPolicy(defaultSyncPolicy(), deploymentLimits)).toMatchObject({ policy: values, savedRevision: "0", deploymentLimits, appliesTo: "next-check" });
  });
  it("rejects a project budget above the deployment wire ceiling", () => {
    expect(() => resolveSyncPolicy(defaultSyncPolicy(), { maxWireBytes: 8 * MiB, envelopeReserveBytes: 128 * 1024 })).toThrowError("SYNC_POLICY_INVALID");
  });
  it("accounts for envelope bytes when input alone fits", () => {
    expect(() => resolveSyncPolicy(defaultSyncPolicy(), { maxWireBytes: 16 * MiB, envelopeReserveBytes: 128 * 1024 })).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects output above the deployment wire ceiling independently of input", () => {
    expect(() => resolveSyncPolicy({ ...defaultSyncPolicy(), maxSourceBytes: 65536, maxCompareInputBytes: MiB, maxCompareOutputBytes: 32 * MiB }, { maxWireBytes: 20 * MiB, envelopeReserveBytes: 128 * 1024 })).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects a source larger than the comparison input budget", () => {
    expect(() => resolveSyncPolicy({ ...defaultSyncPolicy(), maxCompareInputBytes: MiB }, deploymentLimits)).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects connect timeout above URL deadline", () => {
    expect(() => resolveSyncPolicy({ ...defaultSyncPolicy(), connectTimeoutMs: 60000, urlDeadlineMs: 5000 }, deploymentLimits)).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects connect timeout above Git deadline", () => {
    expect(() => resolveSyncPolicy({ ...defaultSyncPolicy(), connectTimeoutMs: 60000, gitDeadlineMs: 10000 }, deploymentLimits)).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects project concurrency above the host concurrency", () => {
    expect(() => resolveSyncPolicy({ ...defaultSyncPolicy(), projectConcurrency: 4, hostConcurrency: 1 }, deploymentLimits)).toThrowError("SYNC_POLICY_INVALID");
  });
  it("does not allow project settings to enlarge an inherited ceiling", () => {
    const inherited = resolveSyncPolicy({ ...defaultSyncPolicy(), maxSourceBytes: MiB }, deploymentLimits);
    expect(() => resolveSyncPolicy(defaultSyncPolicy(), deploymentLimits, inherited)).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects invalid wire policy values at the resolver entry", () => {
    expect(() => resolveSyncPolicy({ ...defaultSyncPolicy(), maxAttempts: 4 }, deploymentLimits)).toThrowError("SYNC_POLICY_INVALID");
  });
  it.each([0, -1, 1.5])("rejects deployment maxWireBytes %s", maxWireBytes => {
    expect(SyncDeploymentLimitsSchema.safeParse({ ...deploymentLimits, maxWireBytes }).success).toBe(false);
  });
  it.each([-1, 0.5])("rejects deployment envelopeReserveBytes %s", envelopeReserveBytes => {
    expect(SyncDeploymentLimitsSchema.safeParse({ ...deploymentLimits, envelopeReserveBytes }).success).toBe(false);
  });
  it("rejects a reserve that consumes the whole wire ceiling", () => {
    expect(() => resolveSyncPolicy(defaultSyncPolicy(), { maxWireBytes: 20 * MiB, envelopeReserveBytes: 20 * MiB })).toThrowError("SYNC_POLICY_INVALID");
  });
});

describe("saved overrides and effective policy provenance", () => {
  it.each(["workspace", "project"] as const)("identifies explicit %s overrides even when equal to default", scope => {
    const requested = SyncPolicySchema.parse({ formatVersion: 1, revision: "7", scope, maxAttempts: 1 });
    const effective = resolveSyncPolicy(requested, deploymentLimits);
    expect(effective.sources.maxAttempts).toBe(scope);
    expect(effective.sources.maxSourceBytes).toBe("default");
    expect(effective.savedRevision).toBe("7");
  });
  it("inherits omitted values with their actual parent source", () => {
    const parent = resolveSyncPolicy(SyncPolicySchema.parse({ formatVersion: 1, revision: "3", scope: "workspace", maxSourceBytes: MiB }), deploymentLimits);
    const child = resolveSyncPolicy(SyncPolicySchema.parse({ formatVersion: 1, revision: "8", scope: "project" }), deploymentLimits, parent);
    expect(child.policy.maxSourceBytes).toBe(MiB);
    expect(child.sources.maxSourceBytes).toBe("workspace");
    expect(child.sources.maxAttempts).toBe("default");
    expect(child.savedRevision).toBe("8");
  });
  it("keeps the inherited deployment ceiling when the caller offers a larger one", () => {
    const parent = resolveSyncPolicy(SyncPolicySchema.parse({ formatVersion: 1, revision: "3", scope: "workspace" }), { maxWireBytes: 32 * MiB, envelopeReserveBytes: 256 * 1024 });
    const child = resolveSyncPolicy(SyncPolicySchema.parse({ formatVersion: 1, revision: "8", scope: "project" }), deploymentLimits, parent);
    expect(child.deploymentLimits).toEqual({ maxWireBytes: 32 * MiB, envelopeReserveBytes: 256 * 1024 });
  });
  it("rechecks inherited budgets against a smaller trusted deployment", () => {
    const parent = resolveSyncPolicy(SyncPolicySchema.parse({ formatVersion: 1, revision: "3", scope: "workspace" }), deploymentLimits);
    expect(() => resolveSyncPolicy(SyncPolicySchema.parse({ formatVersion: 1, revision: "8", scope: "project" }), { maxWireBytes: 8 * MiB, envelopeReserveBytes: 128 * 1024 }, parent)).toThrowError("SYNC_POLICY_INVALID");
  });
  it("rejects an unknown saved policy scope", () => {
    expect(SyncPolicySchema.safeParse({ ...defaultSyncPolicy(), scope: "deployment" }).success).toBe(false);
  });
  it("requires explicit versioned save metadata", () => {
    expect(SyncPolicySchema.safeParse({}).success).toBe(false);
  });
  it("requires effective provenance for every numeric policy key", () => {
    const effective = resolveSyncPolicy(defaultSyncPolicy(), deploymentLimits);
    expect(SyncEffectivePolicySchema.safeParse({ ...effective, sources: {} }).success).toBe(false);
  });
  it("requires all values in an already resolved effective policy", () => {
    const effective = resolveSyncPolicy(defaultSyncPolicy(), deploymentLimits);
    expect(SyncEffectivePolicySchema.safeParse({ ...effective, policy: {} }).success).toBe(false);
  });
  it("requires all numeric values in the complete-value schema", () => {
    expect(SyncPolicyValuesSchema.safeParse({}).success).toBe(false);
  });
});

describe("SyncStamp revisions and upstream identity", () => {
  it("preserves online versions beyond JS safe integer as decimal strings", () => {
    const stamp = { ...syncFixture().stamp, kind: "online", assetVersion: "900719925474099312345" };
    expect(SyncStampSchema.parse(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp);
  });
  it.each([9007199254740992, "01", "-1", "1e3", ""])("rejects noncanonical online asset version %s", assetVersion => {
    expect(SyncStampSchema.safeParse({ ...syncFixture().stamp, kind: "online", assetVersion }).success).toBe(false);
  });
  it("does not confuse workspace CAS revision with definitionRevision", () => {
    expect(SyncStampSchema.safeParse({ ...syncFixture().stamp, expectedRevision: hashA }).success).toBe(false);
  });
  it.each(["sourceRevision", "mappingRevision", "baselineRevision", "authorizationGeneration"])("rejects numeric %s", field => {
    expect(SyncStampSchema.safeParse({ ...syncFixture().stamp, [field]: 1 }).success).toBe(false);
  });
  it.each(["definitionRevision", "coreBuildId"])("rejects truncated %s", field => {
    expect(SyncStampSchema.safeParse({ ...syncFixture().stamp, [field]: "abc" }).success).toBe(false);
  });
  it.each(["sha1", "sha256"] as const)("accepts full %s Git object IDs independently of raw SHA-256", objectFormat => {
    const oid = "b".repeat(objectFormat === "sha1" ? 40 : 64);
    const input = { kind: "git", objectFormat, commitOid: oid, blobOid: oid, rawSha256: hashA };
    expect(SyncUpstreamSchema.parse(input)).toEqual(input);
  });
  it.each(["sha1", "sha256"] as const)("rejects abbreviated %s Git object IDs", objectFormat => {
    expect(SyncUpstreamSchema.safeParse({ kind: "git", objectFormat, commitOid: "abcdef1", blobOid: "b".repeat(objectFormat === "sha1" ? 40 : 64), rawSha256: hashA }).success).toBe(false);
  });
  it("rejects an OID with the wrong object-format length", () => {
    expect(SyncUpstreamSchema.safeParse({ kind: "git", objectFormat: "sha1", commitOid: hashA, blobOid: "b".repeat(40), rawSha256: hashA }).success).toBe(false);
  });
  it("rejects an upstream raw digest that is not complete SHA-256", () => {
    expect(SyncUpstreamSchema.safeParse({ kind: "url", finalUrl: "https://spec.example.test/openapi.json", rawSha256: "abc" }).success).toBe(false);
  });
});

describe("receipt asset identity is separate from workspace storage CAS", () => {
  const afterReceipt = () => {
    const f = syncWireFixture();
    return { formatVersion: 1, operationId: f.receipt.operationId, intentId: f.receipt.intentId, kind: f.receipt.kind, status: f.receipt.status,
      historyId: f.receipt.historyId, sourceId: f.receipt.sourceId, projectId: f.receipt.projectId, actor: f.receipt.actor,
      completedAtMs: f.receipt.completedAtMs, integritySha256: f.receipt.integritySha256, afterStamp: f.stamp };
  };
  it("accepts committed local identity through afterStamp", () => {
    expect(SyncReceiptSchema.safeParse(afterReceipt()).success).toBe(true);
  });
  it("accepts online afterStamp with an exact large decimal asset version", () => {
    const receipt = afterReceipt();
    const input = { ...receipt, afterStamp: { ...receipt.afterStamp, kind: "online", assetVersion: "900719925474099312345" } };
    const result = SyncReceiptSchema.safeParse(JSON.parse(JSON.stringify(input)));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(input);
  });
  it("rejects the legacy independent projectRevision and duplicate version fields", () => {
    const { afterStamp: _afterStamp, ...base } = afterReceipt();
    expect(SyncReceiptSchema.safeParse({ ...base, sourceRevision: "1", projectRevision: "2", definitionRevision: hashA, mappingRevision: "1", baselineRevision: "1" }).success).toBe(false);
  });
  it("rejects workspace storageRevision in durable receipt identity", () => {
    expect(SyncReceiptSchema.safeParse({ ...afterReceipt(), storageRevision: hashA }).success).toBe(false);
  });
});
