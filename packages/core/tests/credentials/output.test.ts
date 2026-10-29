import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { DeepReadonly } from "../../src/assets/snapshot.js";
import type { ApiAsset, ApiRequest, AuthBinding, ComponentAsset, SecretRef } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import type { CredentialBindings } from "../../src/credentials/types.js";
import {
  collectCredentialMarkersForRequests,
  collectCredentialOutputMarkers,
  collectCredentialRefsForRequests,
  collectCredentialRefsFromRequestDrafts,
  collectProjectCredentialRefs,
  createCredentialOutputSanitizer,
  selectCredentialRequests,
} from "../../src/credentials/output.js";
import { collectDefinedProjectCredentialRefs } from "../../src/assets/secretRefs.js";
import { createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";
import { createExecutionEvidenceCollector, redactExecutionOutput } from "../../src/report/evidence.js";
import type { CaseExecutionResult } from "../../src/runner/caseExecutor.js";
import { suiteToRunResult } from "../../src/report/suiteAdapter.js";
import { reportingUnits } from "../../src/report/units.js";
import type { SuiteRunResult } from "../../src/testing/suiteRunner.js";

it("F7b configured evidence previews and shared report budget apply inside the collector", () => {
  const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { mode: "all", limits: { bodyBytes: 8, valueBytes: 12, caseBytes: 3000, reportBytes: 16000, workflowMetadataBytes: 1000 } });
  const raw: CaseExecutionResult = { outcome: { apiId: "a", caseId: "c", apiName: "api", caseName: "case", passed: false, durationMs: 1, assertions: [], error: "actual failure" }, request: { protocol: "http", method: "GET", url: "https://example.test/long-value", headers: {}, query: [], auth: { kind: "none" } }, response: { status: 500, headers: {}, bodyText: "a".repeat(500), timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1 };
  collector.observe(raw);
  const report = collector.projectRun({ collectionId: "col", collectionName: "col", startedAt: "", finishedAt: "", total: 1, passed: 0, failed: 1, cases: [raw.outcome] });
  expect(report.cases[0]!.evidence!.response!.body.text).toBe("aaaaaaaa");
  expect(report.cases[0]!.evidence!.response!.body.truncated).toBe(true);
  expect(report.cases[0]!.evidence!.request!.url.text).toBe("https://exam");
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(16000);
});

it("F7c tightens the private marker ceiling without discarding previously learned secrets", () => {
  const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, ["known-private"], { privateMarkers: true });
  collector.configureStressBudget({ maxSamples: 2, bodyBytes: 64, valueBytes: 32, caseBytes: 2048, reportBytes: 4096 });
  expect(collector.boundary().redactText("known-private")).toBe("[REDACTED]");
  expect(() => collector.addMarkers(["m".repeat(5000)])).toThrow(/capacity/);
  expect(() => collector.projectSamples()).toThrow(/incomplete/);
});

it("R1 I-4 includes truncation markers in tiny diagnostic field budgets", () => {
  const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { limits: { valueBytes: 12, bodyBytes: 8, caseBytes: 700, reportBytes: 16000 } });
  const report = collector.projectRun({ collectionId: "col", collectionName: "col", startedAt: "", finishedAt: "", total: 1, passed: 0, failed: 1, cases: [{ apiId: "a", caseId: "c", apiName: "long api name", caseName: "case", passed: false, durationMs: 1, error: "actual failure", assertions: [] }] });
  expect(Buffer.byteLength(report.cases[0]!.apiName)).toBeLessThanOrEqual(12);
  expect(report.cases[0]!.failureKind).toBeUndefined();
});

it("R1 I-4 rejects a case ceiling smaller than immutable case and evidence framing", () => {
  const projectId = "10000000-0000-4000-8000-000000000001"; const apiId = "10000000-0000-4000-8000-000000000005"; const caseId = "10000000-0000-4000-8000-000000000006";
  const locator = { collectionId: "10000000-0000-4000-8000-000000000002", folderIds: ["10000000-0000-4000-8000-000000000003"], apiId, caseId, scope: "base" };
  const collector = createExecutionEvidenceCollector({ projectId, definitionRevision: "a".repeat(64), locator }, [], { limits: { bodyBytes: 8, valueBytes: 64, caseBytes: 256, reportBytes: 16000 } });
  expect(() => collector.projectRun({ collectionId: locator.collectionId, collectionName: "col", startedAt: "", finishedAt: "", total: 1, passed: 0, failed: 1, cases: [{ apiId, caseId, apiName: "api", caseName: "case", locator, scope: "base", passed: false, durationMs: 1, failureKind: "assertion", error: "actual assertion failure", assertions: [] }] })).toThrow(/case.*capacity|case.*budget|用例.*预算/i);
});

it("F7b workflow metadata shares a configured ceiling with its aliases", () => {
  const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { limits: { valueBytes: 2048, reportBytes: 16000, workflowMetadataBytes: 1000 } });
  const projected = collector.projectWorkflow({ workflowId: "wf", workflowName: "workflow", status: "enabled", nodeResults: [{ nodeId: "n", kind: "noop", state: "failed", error: "actual failure ".repeat(400) }], total: 1, passed: 0, failed: 1, skipped: 0, warnings: [], startedAt: "", finishedAt: "" });
  const metadata = { ...projected, report: undefined, nodeResults: projected.nodeResults.map(node => ({ ...node, outcome: undefined, outcomes: undefined })) };
  expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(1000);
  expect(projected.nodeResults[0]!.state).toBe("failed");
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(16000);
});

it("R2 N-1 preserves the original logical population when compact failure output omits unit details", () => {
  const uuid = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
  const states = ["failed", "passed", "failed"] as const;
  const suite: SuiteRunResult = {
    kind: "suite", suiteRunId: uuid(1), projectId: uuid(2), suiteId: uuid(3), suiteName: "suite", definitionRevision: "a".repeat(64), dataDigest: "b".repeat(64), allowDraft: false,
    startedAt: "", finishedAt: "", verdict: "failed", total: 3, passed: 1, failed: 2, skipped: 0, cases: [], warnings: [], requestFacts: { requestStarted: 0, requestCompleted: 0, httpExchanges: 0 },
    entries: states.map((status, index) => ({ entryId: uuid(10 + index), kind: "workflow", workflowId: uuid(20 + index), status, cases: [], ...(status === "failed" ? { error: "Workflow assertion failed" } : {}) })),
    workflowUnits: states.map((verdict, index) => ({ entryId: uuid(10 + index), workflowId: uuid(20 + index), invocationId: uuid(30 + index), verdict, ...(verdict === "failed" ? { error: "Workflow assertion failed" } : {}) })),
  };
  const raw = suiteToRunResult(suite);
  const expected = { total: 3, passed: 1, failed: 2, skipped: 0, entryDiagnostics: 0 };
  expect(reportingUnits(raw).summary).toEqual(expected);
  const collector = createExecutionEvidenceCollector({ projectId: suite.projectId, definitionRevision: suite.definitionRevision }, [], { limits: { bodyBytes: 8, valueBytes: 128, caseBytes: 3000, reportBytes: 16000, workflowMetadataBytes: 500 } });
  const result = collector.projectRunFailure(raw);
  expect.soft(result.reportingUnits).toEqual(expected);
  expect.soft(reportingUnits(result).summary).toEqual(expected);
  expect.soft(result.reportingMode).toBe("mixed-suite-v2");
  expect(result.suite).toMatchObject({ total: 3, passed: 1, failed: 2 });
  expect(result.cases).toEqual([]);
  expect(result.requestFacts).toEqual({ requestStarted: 0, requestCompleted: 0, httpExchanges: 0 });
  expect(result.reportFailure).toBe(true); expect(result.evidenceOmitted).toBe(true);
});

it("G preserves duplicate Cookie boundaries, unavailable bodies and exact rerun row association", () => {
  const locator = { collectionId: "collection", folderIds: ["folder"], apiId: "api", caseId: "case", scope: "base" };
  const base = { projectId: "project", definitionRevision: "current-revision", entryId: "suite-entry", suiteRow: 1, rowIndex: 1, datasetId: "dataset", dataDigest: "current-digest" };
  const collector = createExecutionEvidenceCollector(base, [], { mode: "all" });
  const raw: CaseExecutionResult = { outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", scope: "base", locator, row: 1, passed: false, durationMs: 1, assertions: [] },
    request: { protocol: "http", method: "POST", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" }, body: { kind: "raw", content: "request row two" } },
    response: { status: 200, headers: { "set-cookie": "first=first-private; Path=/, second=second-private; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/" }, rawHeaders: [["Set-Cookie", "first=first-private; Path=/"], ["Set-Cookie", "second=second-private; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/"]], bodyText: "business second-private", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
    assertionOutcomes: [
      { id: "exact-assertion-id", op: "eq", selector: { target: "bodyXml", match: "first", path: "/dynamic-private-path", namespaces: { "dynamic-private-prefix": "urn:dynamic-private-namespace" } }, code: "ASSERTION_FAILED", pass: false, message: "dynamic-private-message", actual: "dynamic-private-actual", expected: "dynamic-private-expected" },
      { id: "exact-header-id", op: "exists", selector: { target: "header", match: "all", headerName: "dynamic-private-header" }, code: "OK", pass: true, message: "dynamic-private-message" },
    ],
    extractionOutcomes: [{ id: "exact-extraction-id", name: "dynamic-private-name", selector: { target: "cookie", match: "first", cookieName: "dynamic-private-cookie" }, status: "extracted", pass: true, code: "OK", published: true, sensitive: false, value: "dynamic-private-value", message: "dynamic-private-message" }],
  };
  collector.observe(raw, { rowIndex: 1 });
  const duplicate = { ...raw, response: { ...raw.response!, bodyText: "duplicate row evidence" } };
  collector.observe(duplicate, { rowIndex: 1 });
  const run = { collectionId: "collection", collectionName: "second-private", startedAt: "", finishedAt: "", total: 2, passed: 0, failed: 2, cases: [structuredClone(raw.outcome), structuredClone(raw.outcome)] };
  const safe = collector.projectRun(run);
  expect(JSON.stringify(safe)).not.toContain("second-private");
  expect(JSON.stringify(safe)).not.toContain("first-private");
  expect(safe.cases.map(row => row.evidence?.response?.body.text)).toEqual(["business [REDACTED]", "duplicate row evidence"]);
  expect(safe.cases[0]!.evidence).toMatchObject({ state: "collected", identity: { ...base, locator }, request: { body: { text: "request row two" } } });
  expect(safe.cases[0]!.evidence!.response!.headers.text).toContain("Expires=Wed, 21 Oct 2037 07:28:00 GMT");
  expect(safe.cases[0]!.evidence!.assertions![0]).toMatchObject({ id: { text: "exact-assertion-id" }, op: { text: "eq" }, code: { text: "ASSERTION_FAILED" }, actual: { text: "dynamic-private-actual" }, expected: { text: "dynamic-private-expected" } });
  expect(JSON.parse(safe.cases[0]!.evidence!.assertions![0]!.selector.text)).toEqual({ target: "bodyXml", match: "first", path: "/dynamic-private-path", namespaces: { "dynamic-private-prefix": "urn:dynamic-private-namespace" } });
  expect(JSON.parse(safe.cases[0]!.evidence!.assertions![1]!.selector.text)).toEqual({ target: "header", match: "all", headerName: "dynamic-private-header" });
  expect(safe.cases[0]!.evidence!.extractions![0]).toMatchObject({ id: { text: "exact-extraction-id" }, code: { text: "OK" }, value: { text: "dynamic-private-value" } });
  expect(JSON.parse(safe.cases[0]!.evidence!.extractions![0]!.selector.text)).toEqual({ target: "cookie", match: "first", cookieName: "dynamic-private-cookie" });
  const workflow = createExecutionEvidenceCollector({ ...base, workflowId: "original-dependent-workflow" }, [], { mode: "all" });
  workflow.observe(raw, { nodeId: "node", entryId: "node", rowIndex: 1 });
  const projected = workflow.projectWorkflow({ workflowId: "original-dependent-workflow", workflowName: "workflow", status: "enabled", nodeResults: [{ nodeId: "node", kind: "request", state: "failed", outcomes: [raw.outcome], outcome: raw.outcome }], total: 1, passed: 0, failed: 1, skipped: 0, verdict: "failed", warnings: [], startedAt: "", finishedAt: "" });
  expect(projected.nodeResults[0]!.outcomes![0]!.evidence).toMatchObject({ state: "collected", identity: { suiteRow: 1, rowIndex: 1, entryId: "node", nodeId: "node", definitionRevision: "current-revision", dataDigest: "current-digest" }, response: { body: { text: "business [REDACTED]" } } });
  const unavailable = createExecutionEvidenceCollector(base, [], { mode: "all" });
  unavailable.observe({ ...raw, response: { status: 200, headers: {}, bodyText: "", textAvailable: false, timeMs: 1 } });
  const binary = unavailable.projectRun({ ...run, cases: [raw.outcome], total: 1, failed: 1 });
  expect(binary.cases[0]!.evidence?.response).toMatchObject({ status: 200, body: { omitted: true, text: "unavailable" } });
  const mergedOnly = createExecutionEvidenceCollector(base, [], { mode: "all" });
  mergedOnly.observe({ ...raw, response: { ...raw.response!, rawHeaders: undefined } });
  const unavailableCookies = mergedOnly.projectRun(run);
  expect(JSON.stringify(unavailableCookies)).not.toContain("second-private");
  expect(unavailableCookies.cases[0]!.evidence?.response?.body).toMatchObject({ omitted: true, text: expect.stringContaining("unavailable") });
  const fallbackEvidence = unavailableCookies.cases[0]!.evidence!;
  expect(fallbackEvidence.assertions![0]).toMatchObject({ id: { text: "exact-assertion-id" }, op: { text: "eq" }, code: { text: "ASSERTION_FAILED" }, pass: false, actual: { omitted: true }, expected: { omitted: true }, message: { omitted: true } });
  expect(fallbackEvidence.assertions![0]!.id.omitted).toBeUndefined();
  expect(JSON.parse(fallbackEvidence.assertions![0]!.selector.text)).toMatchObject({ target: "bodyXml", match: "first", path: "[omitted: unavailable Set-Cookie boundaries]", namespaces: { "[omitted: unavailable Set-Cookie boundaries]": "[omitted: unavailable Set-Cookie boundaries]" } });
  expect(JSON.parse(fallbackEvidence.assertions![1]!.selector.text)).toEqual({ target: "header", match: "all", headerName: "[omitted: unavailable Set-Cookie boundaries]" });
  expect(fallbackEvidence.extractions![0]).toMatchObject({ id: { text: "exact-extraction-id" }, code: { text: "OK" }, status: "extracted", published: true, sensitive: false, name: { omitted: true }, value: { omitted: true } });
  expect(JSON.parse(fallbackEvidence.extractions![0]!.selector.text)).toEqual({ target: "cookie", match: "first", cookieName: "[omitted: unavailable Set-Cookie boundaries]" });
  expect(JSON.stringify(unavailableCookies)).not.toContain("dynamic-private-");
  expect(() => mergedOnly.markers()).toThrow(/marker set unavailable/);
  const privateCookies = createExecutionEvidenceCollector(base, [], { privateMarkers: true });
  expect(() => privateCookies.observe({ ...raw, response: { ...raw.response!, rawHeaders: undefined } })).toThrow(/markers incomplete/);
  expect(() => privateCookies.markers()).toThrow(/markers incomplete/);
  expect(() => privateCookies.projectRun(run)).toThrow(/markers incomplete/);
  const plain = createExecutionEvidenceCollector({ projectId: "project", definitionRevision: "revision" }, [], { mode: "all" });
  const noData = { ...raw, outcome: { ...raw.outcome, row: undefined } };
  plain.observe(noData, { rowIndex: 0 });
  const ordinary = plain.projectRun({ ...run, cases: [structuredClone(noData.outcome)], total: 1, failed: 1 });
  expect(ordinary.cases[0]!.evidence?.state).toBe("collected");
  expect(collector.projectRun({ ...run, cases: [{ ...raw.outcome, entryId: "different-entry" }] }).cases[0]!.evidence?.state).toBe("not-collected");
});

it("C1 Fix1 preserves typed verdicts and opaque identity when sensitive business content equals protocol metadata", () => {
  const identity = { projectId: "project-passed", definitionRevision: "revision-passed", locator: { collectionId: "collection-passed", folderIds: ["folder-passed"], apiId: "api-passed", caseId: "case-passed", scope: "scope-passed" } };
  const collector = createExecutionEvidenceCollector(identity, ["fix1-distinct-secret", "http"], { mode: "all" });
  const raw: CaseExecutionResult = { outcome: { ...identity.locator, apiName: "fix1-distinct-secret", caseName: "passed", passed: true, durationMs: 1, assertions: [{ pass: true, message: "passed fix1-distinct-secret" }], locator: identity.locator },
    request: { protocol: "http", method: "GET", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" } }, response: { status: 200, headers: {}, bodyText: "passed fix1-distinct-secret", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
    extractionOutcomes: [{ id: "extract-passed", name: "passed", selector: { target: "bodyText", match: "first" }, status: "extracted", pass: true, published: true, sensitive: true, code: "OK", message: "passed", value: "passed" }] };
  collector.observe(raw);
  const safe = collector.projectRun({ collectionId: identity.locator.collectionId, collectionName: "passed fix1-distinct-secret", startedAt: "start", finishedAt: "end", total: 1, passed: 1, failed: 0, cases: [raw.outcome],
    suite: { suiteRunId: "suite-passed", projectId: identity.projectId, definitionRevision: identity.definitionRevision, verdict: "passed", total: 1, passed: 1, failed: 0, skipped: 0, entries: [{ entryId: "entry-passed", kind: "case", status: "passed" }] } });
  expect(safe).toMatchObject({ passed: 1, failed: 0, total: 1, projectId: identity.projectId, definitionRevision: identity.definitionRevision, suite: { verdict: "passed", entries: [{ status: "passed", entryId: "entry-passed" }] } });
  expect(safe.cases[0]).toMatchObject({ passed: true, locator: identity.locator });
  expect(safe.reportingUnits).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, entryDiagnostics: 0 });
  expect(safe.cases[0]!.evidence?.identity).toMatchObject(identity);
  expect(safe.cases[0]!.evidence?.request?.protocol).toBe("http");
  expect(safe.cases[0]!.evidence?.response?.body.text).toBe("[REDACTED] [REDACTED]");
  expect(safe.cases[0]!.caseName).toBe("[REDACTED]");
  expect(JSON.stringify(safe)).not.toContain("fix1-distinct-secret");
  const final = redactExecutionOutput(safe, createCredentialOutputSanitizer(["passed", "http", "fix1-distinct-secret"]));
  expect(final).toMatchObject({ passed: 1, suite: { verdict: "passed" }, cases: [{ passed: true, locator: identity.locator }] });
  const worker = redactExecutionOutput({ protocolVersion: 2, ok: true, shardId: "shard-passed", samples: [{ status: 200, ok: true, requestStarted: true, requestCompleted: true, error: "fix1-distinct-secret", safety: { origin: "https://fix1-distinct-secret.test", confirmation: "passed", policy: "passed" } }], generator: { availability: "unavailable", unavailableReason: "fix1-distinct-secret" }, measurementWindow: { startWallMs: 0, endWallMs: 1, monotonicDurationMs: 1, eligibleCompletedAttempts: 1 } }, createCredentialOutputSanitizer(["passed", "fix1-distinct-secret"]));
  expect(worker).toMatchObject({ ok: true, shardId: "shard-passed", samples: [{ ok: true, status: 200, safety: { confirmation: "passed", policy: "passed" } }] });
  expect(JSON.stringify(worker)).not.toContain("fix1-distinct-secret");
});

it("C1 reprojects all legacy script primary-error sinks after a later unpublished sensitive extraction", () => {
  const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, []);
  const outcome = { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: false, durationMs: 1, error: "script: sensitive-later", assertions: [{ pass: false, message: "pm.assert sensitive-later" }] };
  const raw: CaseExecutionResult = { outcome, request: { protocol: "http", method: "GET", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" } }, requestTimeMs: 1, scriptTimeMs: 1, iterationTimeMs: 2 };
  collector.observe(raw);
  collector.observe({ ...raw, extractionOutcomes: [{ id: "x", name: "token", selector: { target: "bodyText", match: "first" }, sensitive: true, status: "failed", pass: false, published: false, code: "EXTRACTION_FAILED", message: "sensitive-later", value: "sensitive-later" }] });
  const safe = collector.projectRun({ collectionId: "c", collectionName: "c", startedAt: "now", finishedAt: "now", total: 1, passed: 0, failed: 1, cases: [outcome] });
  expect(safe.cases[0]!.error).toBe("script: [REDACTED]");
  expect(safe.cases[0]!.assertions[0]!.message).toBe("pm.assert [REDACTED]");
});

const componentId = "20000000-0000-4000-8000-000000000001";
const unusedComponentId = "20000000-0000-4000-8000-000000000002";

describe("shared credential output", () => {
  it("collects credential refs from free request drafts without inventing an owning API asset", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const authComponent: ComponentAsset = {
      formatVersion: 1,
      id: componentId,
      name: "free request auth",
      description: "",
      kind: "auth",
      definition: { kind: "bearer", token: { id: "free-auth-ref", policy: "test-auto" } },
    };
    project.components = [authComponent];
    const request = structuredClone(project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request);
    request.auth = { kind: "componentRef", componentId, expectedKind: "auth" };

    expect(collectCredentialRefsFromRequestDrafts(project, [request])).toEqual([
      { id: "free-auth-ref", policy: "test-auto" },
    ]);
  });

  it("selects only snapshot-owned effective case requests for credential refs and markers", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.auth = { kind: "bearer", token: { id: "default-ref", policy: "test-auto" } };
    const baseCase = asset.cases[0]!;
    asset.cases = [
      {
        ...baseCase,
        id: "selected-case",
        requestOverride: { ...asset.contract.request, auth: { kind: "bearer", token: { id: "selected-ref", policy: "test-auto" } } },
      },
      {
        ...baseCase,
        id: "unselected-case",
        requestOverride: { ...asset.contract.request, auth: { kind: "bearer", token: { id: "unselected-ref", policy: "test-auto" } } },
      },
    ];
    project.components = [{
      formatVersion: 1,
      id: "20000000-0000-4000-8000-000000000003",
      name: "unreferenced auth",
      description: "",
      kind: "auth",
      definition: { kind: "bearer", token: { id: "component-ref", policy: "test-auto" } },
    }];
    const snapshot = createProjectSnapshot(project);
    const snapshotAsset = snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const selected = selectCredentialRequests(snapshot, [{ asset: snapshotAsset, testCase: snapshotAsset.cases[0]! }]);

    expect(selected[0]!.request).toBe(snapshotAsset.cases[0]!.requestOverride);
    expect(collectCredentialRefsForRequests(snapshot.project, selected)).toEqual([{ id: "selected-ref", policy: "test-auto" }]);
    expect(collectDefinedProjectCredentialRefs(snapshot.project)).toEqual([
      { id: "default-ref", policy: "test-auto" },
      { id: "selected-ref", policy: "test-auto" },
      { id: "unselected-ref", policy: "test-auto" },
      { id: "component-ref", policy: "test-auto" },
    ]);

    const resolved: string[] = [];
    const bindings: CredentialBindings = {
      resolve(ref) { resolved.push(ref.id); return `secret:${ref.id}`; },
      versions: {},
    };
    expect(collectCredentialMarkersForRequests(snapshot.project, selected, bindings)).toEqual([
      "secret:selected-ref",
      "Bearer secret:selected-ref",
    ]);
    expect(resolved).toEqual(["selected-ref", "selected-ref"]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(() => (selected as unknown as unknown[]).pop()).toThrow(TypeError);
    expect(() => selectCredentialRequests(snapshot, [{ asset: structuredClone(snapshotAsset) }])).toThrow(/snapshot/);
    expect(() => selectCredentialRequests(snapshot, [{ asset: snapshotAsset, testCase: structuredClone(snapshotAsset.cases[0]!) }])).toThrow(/selected snapshot asset/);
  });

  it("collects refs only from selected HTTP, WebSocket, and SOAP auth, deduping aliases without mutating readonly inputs", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const baseAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const components: ComponentAsset[] = [
      {
        formatVersion: 1,
        id: componentId,
        name: "selected auth",
        description: "",
        kind: "auth",
        definition: { kind: "bearer", token: { id: "shared-ref", policy: "test-auto" } },
      },
      {
        formatVersion: 1,
        id: unusedComponentId,
        name: "unused auth",
        description: "",
        kind: "auth",
        definition: { kind: "basic", username: "unused", password: { id: "unused-component-ref", policy: "test-auto" } },
      },
    ];
    project.components = components;

    const directAssets = [
      apiWithAuth(baseAsset, 1, "http", { kind: "bearer", token: { id: "__proto__", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 2, "http", { kind: "basic", username: "alice", password: { id: "凭据-🔑", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 3, "websocket", { kind: "apikey", name: "q", placement: "query", value: { id: "query-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 4, "soap", { kind: "apikey", name: "X-Key", placement: "header", value: { id: "header-ref", policy: "test-auto" } }),
    ];
    const deepAssets = [
      apiWithAuth(baseAsset, 5, "http", { kind: "componentRef", componentId, expectedKind: "auth" }),
      apiWithAuth(baseAsset, 6, "soap", { kind: "bearer", token: { id: "shared-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 7, "websocket", { kind: "none" }),
      apiWithAuth(baseAsset, 8, "http", { kind: "bearer", token: { id: "not-selected-ref", policy: "test-auto" } }),
    ];
    project.collections[0]!.apis = directAssets;
    project.collections[0]!.folders[0]!.folders[0]!.apis = deepAssets;
    const before = structuredClone(project);
    const snapshot = createProjectSnapshot(project);
    const selectedAssets = [
      ...snapshot.project.collections[0]!.apis,
      ...snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis.slice(0, 3),
    ];

    const refs = collectProjectCredentialRefs(snapshot.project, selectedAssets);

    expect(refs).toEqual([
      { id: "__proto__", policy: "test-auto" },
      { id: "凭据-🔑", policy: "test-auto" },
      { id: "query-ref", policy: "test-auto" },
      { id: "header-ref", policy: "test-auto" },
      { id: "shared-ref", policy: "test-auto" },
    ]);
    expect(refs[0]).not.toBe(selectedAssets[0]!.contract.request.auth.kind === "bearer"
      ? selectedAssets[0]!.contract.request.auth.token
      : undefined);
    expect(refs[4]).not.toBe(snapshot.project.components[0]!.kind === "auth"
      ? snapshot.project.components[0]!.definition.kind === "bearer" ? snapshot.project.components[0]!.definition.token : undefined
      : undefined);
    expect(refs.map((ref) => ref.id)).not.toContain("unused-component-ref");
    expect(refs.map((ref) => ref.id)).not.toContain("not-selected-ref");
    expect(project).toEqual(before);
  });

  it("collects raw and rendered markers from prepared bindings and does not resolve empty auth", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const baseAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const assets = [
      apiWithAuth(baseAsset, 11, "http", { kind: "bearer", token: { id: "bearer-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 12, "http", { kind: "basic", username: "dynamic:user", password: { id: "password-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 13, "websocket", { kind: "apikey", name: "key", placement: "query", value: { id: "query-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 14, "soap", { kind: "apikey", name: "X-Key", placement: "header", value: { id: "header-ref", policy: "test-auto" } }),
      apiWithAuth(baseAsset, 15, "http", { kind: "none" }),
    ];
    project.collections[0]!.apis = assets;
    const snapshot = createProjectSnapshot(project);
    const selectedAssets = snapshot.project.collections[0]!.apis;
    const values = new Map([
      ["bearer-ref", "bearer secret"],
      ["password-ref", "päss🔐"],
      ["query-ref", "q +/雪"],
      ["header-ref", "header secret"],
    ]);
    const resolved: string[] = [];
    const bindings: CredentialBindings = {
      resolve(ref) {
        resolved.push(ref.id);
        const value = values.get(ref.id);
        if (value === undefined) throw new Error(`Unexpected ref ${ref.id}`);
        return value;
      },
      versions: {},
    };

    const markers = collectCredentialOutputMarkers(snapshot.project, selectedAssets, bindings);

    expect(markers).toEqual([
      "bearer secret",
      "päss🔐",
      "q +/雪",
      "header secret",
      "Bearer bearer secret",
      "Basic ZHluYW1pYzp1c2VyOnDDpHNz8J+UkA==",
      "q%20%2B%2F%E9%9B%AA",
    ]);
    expect(resolved).toEqual([
      "bearer-ref", "password-ref", "query-ref", "header-ref",
      "bearer-ref", "password-ref", "query-ref", "header-ref",
    ]);

    const emptyProject = createContractExecutionProject("https://service.example.test");
    const emptyBaseAsset = emptyProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    emptyProject.collections[0]!.apis = [apiWithAuth(emptyBaseAsset, 16, "http", { kind: "none" })];
    const emptySnapshot = createProjectSnapshot(emptyProject);
    let emptyResolves = 0;
    const emptyBindings: CredentialBindings = {
      resolve() {
        emptyResolves += 1;
        throw new Error("No credentials should be resolved");
      },
      versions: {},
    };
    expect(collectCredentialOutputMarkers(emptySnapshot.project, emptySnapshot.project.collections[0]!.apis, emptyBindings)).toEqual([]);
    expect(emptyResolves).toBe(0);
  });

  it("preserves a selected credential ref with an empty ID through collection and output markers", () => {
    const project = createContractExecutionProject("https://service.example.test");
    const baseAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    project.collections[0]!.apis = [apiWithAuth(baseAsset, 21, "http", {
      kind: "bearer",
      token: { id: "", policy: "test-auto" },
    })];
    const projectBefore = structuredClone(project);
    const snapshot = createProjectSnapshot(project);
    const snapshotBefore = structuredClone(snapshot.project);
    const selectedAssets = snapshot.project.collections[0]!.apis;
    const auth = selectedAssets[0]!.contract.request.auth;
    if (auth.kind !== "bearer") throw new Error("Expected the selected fixture to use bearer auth.");

    const refs = collectProjectCredentialRefs(snapshot.project, selectedAssets);

    expect(refs).toEqual([{ id: "", policy: "test-auto" }]);
    expect(refs[0]).not.toBe(auth.token);

    const resolved: SecretRef[] = [];
    const preparedBindings: CredentialBindings = {
      resolve(ref) {
        resolved.push({ ...ref });
        if (ref.id !== "") throw new Error(`Unexpected ref ${ref.id}`);
        return "empty-id-secret";
      },
      versions: {},
    };
    const markers = collectCredentialOutputMarkers(snapshot.project, selectedAssets, preparedBindings);

    expect(markers).toEqual(["empty-id-secret", "Bearer empty-id-secret"]);
    expect(resolved).toEqual([
      { id: "", policy: "test-auto" },
      { id: "", policy: "test-auto" },
    ]);
    expect(snapshot.project).toEqual(snapshotBefore);
    expect(project).toEqual(projectBefore);
  });

  it("redacts longest raw markers and canonical Basic headers in nested projections while preserving types and cycles", () => {
    const secret = "short-token";
    const longerSecret = "short-token with suffix";
    const malformedPassword = `replacement-${String.fromCharCode(0xd800)}`;
    const sanitizer = createCredentialOutputSanitizer([secret, longerSecret, "bb", "päss🔐", malformedPassword]);
    const basic = "Basic ZHluYW1pYzp1c2VyOnDDpHNz8J+UkA==";
    const replacementBasic = "Basic dXNlcjpyZXBsYWNlbWVudC3vv70=";
    const text = `keep this ${secret} and ${longerSecret}; ${basic}; ${replacementBasic}; Basic YTpiYh==`;

    expect(sanitizer.redactText(text)).toBe(
      `keep this [REDACTED] and [REDACTED]; [REDACTED]; [REDACTED]; Basic YTpiYh==`,
    );
    expect(sanitizer.redactText("unrelated text and Basic YTpiYg==")).toBe("unrelated text and [REDACTED]");

    const source: Record<string, unknown> = {};
    const nested: unknown[] = [source, `value ${secret}`, 42, null, true];
    source[`token:${secret}`] = nested;
    source.self = source;
    const projected = sanitizer.redactValue(source) as Record<string, unknown>;
    const projectedNested = projected["token:[REDACTED]"] as unknown[];

    expect(projected).not.toBe(source);
    expect(projectedNested).not.toBe(nested);
    expect(projectedNested[0]).toBe(projected);
    expect(projectedNested.slice(1)).toEqual(["value [REDACTED]", 42, null, true]);
    expect(projected.self).toBe(projected);
    expect(source[`token:${secret}`]).toBe(nested);
    expect(nested[1]).toBe(`value ${secret}`);
  });
});

function apiWithAuth(
  baseAsset: ApiAsset,
  ordinal: number,
  protocol: "http" | "websocket" | "soap",
  auth: AuthBinding,
): ApiAsset {
  const common = {
    baseUrl: "https://service.example.test",
    path: "/items",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth,
  };
  let request: ApiRequest;
  if (protocol === "http") {
    request = { ...common, protocol, method: "GET", body: { kind: "none" } };
  } else if (protocol === "websocket") {
    request = { ...common, protocol };
  } else {
    request = { ...common, protocol, method: "POST", envelope: "<Envelope/>" };
  }
  return {
    ...baseAsset,
    contract: {
      ...baseAsset.contract,
      id: `20000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`,
      request,
    },
  };
}
