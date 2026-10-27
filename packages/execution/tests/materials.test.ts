import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { CredentialError, createProjectSnapshot, prepareTestData, testDataSelectionsForRequests, type SecretRef } from "@apicc/core";
import { createContractExecutionProject, contractExecutionIds as ids } from "../../core/tests/helpers/contractExecutionFixtures.js";
import { createOnlineProjectSecretStore, prepareRunCredentials, createDeclaredAttachmentReader, withDeclaredInputFiles, type OnlineMaterialBinding } from "../src/host/credentials.js";
import { prepareExecution, invokeExecution } from "../src/host/index.js";
import type { ProjectRunMaterials } from "../src/contract/index.js";
import { createMemberMaterialsClient } from "../src/client/materials.js";
import { existsSync } from "node:fs";

let server: Server; let url = ""; let hits = 0;
const ref: SecretRef = { id: ids.credential, policy: "test-auto" };
const binding: OnlineMaterialBinding = { serverId: "https://control.example/api/v1", userId: "5", snapshotId: "10", scope: { workspaceId: "1", groupId: "2", projectId: "3" }, contractScope: { workspaceId: "workspace", groupId: "group", projectId: ids.project } };
beforeAll(async () => {
  server = createServer((_request, response) => { hits++; response.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
function prepared(fileData = false) {
  const project = createContractExecutionProject(url); const folder = project.collections[0]!.folders[0]!.folders[0]!;
  folder.preOperations = []; folder.postOperations = []; folder.apis[0]!.cases[0]!.preOperations = [];
  folder.apis[0]!.contract.request.baseUrl = url; folder.apis[0]!.contract.request.path = "/materials";
  if (fileData) folder.apis[0]!.cases[0]!.dataDriver = { sourcePath: "data/rows.csv", format: "csv" };
  const locator = { ...binding.contractScope, collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract };
  return prepareExecution({ snapshot: createProjectSnapshot(project), profile: "no-script", target: { kind: "debug", invocation: { mode: "case", locator, case: { ...locator, caseId: ids.case, scope: "base" } } } });
}
function batch(version = "1", value = "project-secret"): ProjectRunMaterials {
  return { snapshotId: "10", scope: { ...binding.scope }, credentials: [{ refId: ref.id, version, value }], attachments: [] };
}

it("rejects project A material returned to project B and never contacts a target", async () => {
  const before = hits;
  const wrong = batch(); wrong.scope.projectId = "4";
  const store = createOnlineProjectSecretStore(binding, async () => wrong);
  await expect(prepareRunCredentials(prepared(), binding, store)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(hits).toBe(before);
});

it("rejects a changed credential version between preparation and start with zero target requests", async () => {
  const before = hits; let current = batch();
  const store = createOnlineProjectSecretStore(binding, async (_scope, selection) => {
    if (selection.credentials[0]?.version && selection.credentials[0].version !== current.credentials[0]!.version) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
    return current;
  });
  const plan = prepared(); const materials = await prepareRunCredentials(plan, binding, store);
  expect(materials.versions).toEqual({ [ref.id]: "1" });
  current = batch("2", "new-secret");
  const outcome = await materials.start().then(credentialBindings => invokeExecution(plan, { credentialBindings })).catch(error => error);
  expect(hits).toBe(before); expect(outcome).toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT" }); materials.dispose();
});

it("binds only the requested project reference per invocation and clears it when disposed", async () => {
  const store = createOnlineProjectSecretStore(binding, async (_scope, selection) => {
    expect(selection).toEqual({ projectId: "3", credentials: [{ refId: ref.id, ...(selection.credentials[0]?.version ? { version: "1" } : {}) }], attachments: [] });
    return batch();
  });
  const material = await prepareRunCredentials(prepared(), binding, store);
  const active = await material.start(); expect(active.resolve(ref)).toBe("project-secret");
  expect(() => active.resolve({ id: "unselected", policy: "test-auto" })).toThrow();
  material.dispose(); expect(() => active.resolve(ref)).toThrow();
  await expect(material.start()).rejects.toThrow();
});

it("refuses missing or unassigned remote credentials instead of producing empty authorization", async () => {
  const before = hits;
  const store = createOnlineProjectSecretStore(binding, async () => { throw new CredentialError("CREDENTIAL_MISSING", ref.id); });
  await expect(prepareRunCredentials(prepared(), binding, store)).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  expect(hits).toBe(before);
});

it("reads only fixed declared attachments, verifies digest and refuses PC paths and undeclared files", async () => {
  const bytes = Buffer.from("fixed csv\n"); const hash = createHash("sha256").update(bytes).digest("hex");
  const materials = batch(); materials.credentials = []; materials.attachments = [{ refId: "rows", version: "2", hash, size: bytes.length, kind: "file", contentBase64: bytes.toString("base64") }];
  const read = createDeclaredAttachmentReader(materials, { "data/rows.csv": { refId: "rows", version: "2", hash } });
  expect(Buffer.from(await read("data/rows.csv")).toString()).toBe("fixed csv\n");
  await expect(read("C:\\private\\rows.csv")).rejects.toThrow(); await expect(read("other.csv")).rejects.toThrow();
  const corrupt = structuredClone(materials); corrupt.attachments[0]!.contentBase64 = Buffer.from("other").toString("base64");
  await expect(createDeclaredAttachmentReader(corrupt, { "data/rows.csv": { refId: "rows", version: "2", hash } })("data/rows.csv")).rejects.toThrow(/digest|hash|bytes/i);
});

it("loads member materials using the dedicated snapshot endpoint and validates the returned scope", async () => {
  const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const client = createMemberMaterialsClient({ baseUrl: binding.serverId, token: () => "member-control-token", fetch: async (input, options) => {
    calls.push({ url: String(input), body: JSON.parse(String(options?.body)), authorization: new Headers(options?.headers).get("authorization") });
    return new Response(JSON.stringify(batch()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const selection = { projectId: "3", credentials: [{ refId: ref.id }], attachments: [] };
  expect(await client.loadLocal("10", selection, new AbortController().signal)).toEqual(batch());
  expect(calls).toEqual([{ url: "https://control.example/api/v1/execution-snapshots/10/local-materials", body: selection, authorization: "Bearer member-control-token" }]);
});

it("supplies a declared attachment to Core data preparation and cleans its per-call directory", async () => {
  const bytes = Buffer.from("region\nfixed\n"); const hash = createHash("sha256").update(bytes).digest("hex");
  const materials = batch(); materials.credentials = []; materials.attachments = [{ refId: "rows", version: "1", hash, size: bytes.length, kind: "file", contentBase64: bytes.toString("base64") }];
  const plan = prepared(true); let root = "";
  const result = await withDeclaredInputFiles(materials, { "data/rows.csv": { refId: "rows", version: "1", hash } }, { totalInputBytes: 1024, minFreeDiskBytes: 1 }, async files => {
    root = files.workspaceRoot; expect(existsSync(files.pathFor("data/rows.csv"))).toBe(true);
    expect(() => files.pathFor("C:\\private\\rows.csv")).toThrow(); expect(() => files.pathFor("other.csv")).toThrow();
    return prepareTestData(plan.snapshot, testDataSelectionsForRequests(plan.snapshot, plan.selections), { workspaceRoot: files.workspaceRoot });
  });
  expect(result.sources[0]!.rows).toEqual([{ index: 0, values: { region: "fixed" } }]);
  expect(existsSync(root)).toBe(false);
});
