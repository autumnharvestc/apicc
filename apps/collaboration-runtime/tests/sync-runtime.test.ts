import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { writeFile, readFile, access, symlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { normalizeSyncSource, buildSyncCandidate, resolveSyncCandidate, buildSyncRollback, SyncPlanInputSchema, SyncRollbackInputSchema } from "@apicc/core/sync";
import { createProjectSnapshot } from "@apicc/core/collaboration";
import { contentReference, digestProject } from "../../../packages/core/src/sync/files.js";
import { candidateFixture, syncFixture, threeWayFixture, applyResolved, projectFiles } from "../../../packages/core/tests/sync/fixtures.js";
import { handleOperation } from "../src/handlers.js";
import { RequestSchema } from "../src/protocol.js";
import type { SyncPlanPayload, SyncPlanOutput } from "../src/sourceHost.js";
import { withSyncUrlRuntime, withSyncBlockedRuntime, withSyncRuntime, ownedChildBarrier, rpc, envelope, until, secret } from "./sync-runtime-fixture.js";
import { createSourceHost } from "@apicc/execution/source-host";
import { gitReaderFixture } from "../../../packages/execution/tests/sourceHost/git-reader-fixture.js";
import { preflightSourceTLS } from "../src/sourceHost.js";
import { startCollaborationRuntime } from "../src/server.js";
import { runtimeFromDeployment } from "../src/limits.js";

it("runs under the explicitly pinned Node22 runner", () => { expect(process.versions.node).toBe("22.19.0"); console.log("T8_NODE_RUNNER", process.execPath, process.versions.node); });

it.each(["read", "not-modified"] as const)("composes complete %s source content into a fixed usable Core plan", async status => {
  const f = await threeWayFixture(), original = syncFixture();
  const document = JSON.parse(original.rawText); document.paths["/pets/{id}"].get.description = "From actual raw T8 source";
  const rawText = JSON.stringify(document), input = f.planInput();
  const normalized = normalizeSyncSource({ ...original.normalizeInput, mapping: input.mapping, rawText });
  expect(normalized.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  const payload: SyncPlanPayload = { kind: "source-read", read: { formatVersion: 1, status, rawText, upstream: { ...input.upstream, rawSha256: createHash("sha256").update(rawText).digest("hex") }, diagnostics: [] },
    source: input.source, stamp: input.stamp, mapping: input.mapping, allocationSeed: "apicc-sync-id-v1", baselineFiles: input.baselineFiles, localFiles: input.localFiles,
    otherSourceMappings: [], budget: { ...original.normalizeInput.budget, ...input.budget } };
  expect(RequestSchema.safeParse(envelope("sync-plan", payload)).success).toBe(true);
  const positive = await buildSyncCandidate({ ...input, upstream: payload.read.upstream, mapping: normalized.mapping, remoteFiles: normalized.files, normalizationDiagnostics: normalized.diagnostics });
  expect(positive.changes).toEqual(expect.arrayContaining([expect.objectContaining({ summaries: expect.objectContaining({ source: { kind: "scalar", value: "From actual raw T8 source", truncated: false } }) })]));
  const result = await handleOperation("sync-plan", payload) as SyncPlanOutput;
  expect(SyncPlanInputSchema.safeParse(result.planInput).success).toBe(true);
  expect(result.planInput.remoteFiles).toEqual(normalized.files);
  expect(result.candidate.changes).toEqual(expect.arrayContaining([expect.objectContaining({ summaries: expect.objectContaining({ source: { kind: "scalar", value: "From actual raw T8 source", truncated: false } }) })]));
  const decisions = { formatVersion: 1 as const, candidateDigest: result.candidate.candidateDigest, entries: result.candidate.changes.map(c => ({ changeId: c.changeId, decision: "take-source" as const })) };
  const resolved = await resolveSyncCandidate({ candidate: result.candidate, planInput: result.planInput, decisions });
  expect((await applyResolved(result.planInput, resolved)).collections[0]!.apis[0]!.contract.metadata.description).toBe("From actual raw T8 source");
});

it("deployment assembly reads with actual private owner and current approved direct snapshot", async () => {
  await withSyncUrlRuntime(async f => {
    const response = await rpc(f.runtime.url, "sync-read", f.payload());
    expect(response.status).toBe(200); expect((await response.json()).payload).toMatchObject({ status: "read", rawText: "hello" });
  }, { captureNetwork: undefined });
});

it("real deployment file assembles the private host instead of relying on a test provider", async () => {
  await withSyncUrlRuntime(async f => {
    const secretFile = join(f.privateRoot, "rpc-key"), sourceConfigFile = join(f.privateRoot, "source-deployment.json");
    await writeFile(secretFile, secret); await writeFile(sourceConfigFile, JSON.stringify({ privateRoot: f.privateRoot, allowedOrigins: [f.source.url], allowedCidrs: ["127.0.0.1/32"], maxRedirects: 0 }));
    const configuration = { enabled: true, secretFile, port: 0, sourceConfigFile };
    const runtime = await runtimeFromDeployment(configuration); expect(runtime.enabled).toBe(true);
    if (!runtime.enabled) throw Error("legal deployment must enable listener");
    try { const response = await rpc(runtime.url, "sync-read", f.payload()); expect(response.status).toBe(200); expect((await response.json()).payload.rawText).toBe("hello"); }
    finally { await runtime.close(); }
  });
});

it.each(["root", "cidr"])("refuses invalid trusted source deployment %s before opening another runtime", async kind => {
  await withSyncUrlRuntime(async f => {
    let runtime: Awaited<ReturnType<typeof startCollaborationRuntime>> | undefined;
    const configuration = { secret, port: 0, source: { privateRoot: kind === "root" ? "relative-private-root" : f.privateRoot, allowedOrigins: [f.source.url], allowedCidrs: [kind === "cidr" ? "127.0.0.1/99" : "127.0.0.1/32"] } };
    try { await expect(startCollaborationRuntime(configuration).then(value => { runtime = value; })).rejects.toThrow("SYNC_HOST_CONFIG_INVALID"); }
    finally { await runtime?.close(); }
  });
});

it("real304 returns complete private content and preserves not-modified without reusing an old candidate", async () => {
  await withSyncUrlRuntime(async f => {
    const first = await rpc(f.runtime.url, "sync-read", f.payload("/cache")); expect(first.status).toBe(200); expect((await first.json()).payload.status).toBe("read");
    const second = await rpc(f.runtime.url, "sync-read", f.payload("/cache")); expect(second.status).toBe(200);
    expect((await second.json()).payload).toMatchObject({ status: "not-modified", rawText: "hello", upstream: { rawSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" } });
    expect(f.source.requests.at(-1)?.headers["if-none-match"]).toBe('"v1"');
  });
});

it.each(["native-path", "project-scope"])("private projection rejects %s on an otherwise successful real read", async kind => {
  await withSyncUrlRuntime(async f => {
    expect((await rpc(f.runtime.url, "sync-read", f.payload())).status).toBe(200);
    const payload = f.payload();
    if (kind === "native-path") Object.assign(payload.material, { ssh: { privateKeyPath: "C:/synthetic/private-key", knownHostsPath: "C:/synthetic/known-hosts" } });
    if (kind === "project-scope") payload.context.projectId = "00000000-0000-4000-8000-000000000001";
    const response = await rpc(f.runtime.url, "sync-read", payload);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "RPC_INVALID_REQUEST", retryable: false });
  });
});

it.each(["revision", "network-selection"])("rejects private %s identity mismatch before another actual source request", async kind => {
  await withSyncUrlRuntime(async f => {
    expect((await rpc(f.runtime.url, "sync-read", f.payload())).status).toBe(200);
    const before = f.source.requests.length, payload = f.payload();
    if (kind === "revision") payload.context.sourceRevision = "2";
    else payload.input.source.networkProfileRef = "not-selected-profile";
    const response = await rpc(f.runtime.url, "sync-read", payload);
    expect(await response.json()).toMatchObject({ code: kind === "revision" ? "SYNC_CONTEXT_STALE" : "SYNC_NETWORK_SNAPSHOT_INVALID", retryable: false });
    expect(response.status).toBe(400); expect(f.source.requests).toHaveLength(before);
  });
});

it.each(["origin", "cidr"])("current administrator %s approval cannot be widened by a trusted prepared snapshot", async kind => {
  await withSyncUrlRuntime(async f => {
    const before = f.source.requests.length, response = await rpc(f.runtime.url, "sync-read", f.payload());
    expect(await response.json()).toMatchObject({ code: "SYNC_NETWORK_DENIED", retryable: false });
    expect(response.status).toBe(400); expect(f.source.requests).toHaveLength(before);
  }, kind === "origin" ? { allowedOrigins: [] } : { allowedCidrs: [] });
});

it("passes the actual deployment redirect budget into the production SourceHost", async () => {
  await withSyncUrlRuntime(async f => {
    expect((await rpc(f.runtime.url, "sync-read", f.payload())).status).toBe(200);
    const response = await rpc(f.runtime.url, "sync-read", f.payload("/same"));
    expect(await response.json()).toMatchObject({ code: "SYNC_REDIRECT_LIMIT", retryable: false }); expect(response.status).toBe(400);
  }, { maxRedirects: 0 });
});

it("maps accepted SourceHost refusals to finite private codes without native detail", async () => {
  await withSyncUrlRuntime(async f => {
    const payload = f.payload(); payload.material.httpHeaders = [{ name: "Host", value: "synthetic-private-value" }];
    await expect(f.source.read(payload.input, {}, { httpHeaders: payload.material.httpHeaders })).rejects.toMatchObject({ code: "SYNC_MATERIAL_INVALID" });
    const response = await rpc(f.runtime.url, "sync-read", payload), text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "SYNC_MATERIAL_INVALID", retryable: false }); expect(text).not.toContain("synthetic-private-value");
  });
});

it("refuses missing production source deployment with an explicit finite unavailable result", async () => {
  const runtime = await startCollaborationRuntime({ secret, port: 0 });
  try { await withSyncUrlRuntime(async f => { const response = await rpc(runtime.url, "sync-read", f.payload()); expect(await response.json()).toMatchObject({ code: "SYNC_HOST_UNAVAILABLE", retryable: false }); }); }
  finally { await runtime.close(); }
});

it.each(["disconnect", "deadline", "shutdown"])("default production handler forwards real %s cancellation into the active SourceHost socket", async kind => {
  await withSyncBlockedRuntime(async f => {
    const payload = f.payload(), body = envelope("sync-read", payload, kind === "deadline" ? 3000 : 10000);
    const client = request(f.runtime.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret } });
    let status: number | undefined;
    const settled = new Promise<void>(done => { client.on("response", response => { response.resume(); response.on("end", done); }); client.on("error", () => done()); client.on("close", () => done()); });
    client.on("response", response => { status = response.statusCode; });
    client.end(JSON.stringify(body)); await f.received; expect(f.sourceSocketClosed()).toBe(false);
    let stopping: Promise<void> | undefined;
    if (kind === "disconnect") client.destroy();
    if (kind === "shutdown") stopping = f.runtime.close();
    if (kind === "deadline") { await settled; expect(status).toBe(408); }
    else await f.rpcClosed;
    try { expect(await until(() => f.capturedSignals.at(-1)?.aborted === true, 500)).toBe(true); expect(await until(f.sourceSocketClosed)).toBe(true); }
    finally { client.destroy(); await f.releaseUpstream(); await settled; await stopping; }
  });
});

it("source composition refuses a changed raw digest instead of binding it to the caller's upstream", async () => {
  const f = await threeWayFixture(), original = syncFixture(), input = f.planInput();
  const payload: SyncPlanPayload = { kind: "source-read", read: { formatVersion: 1, status: "read", rawText: original.rawText, upstream: { ...input.upstream, rawSha256: "0".repeat(64) }, diagnostics: [] }, source: input.source, stamp: input.stamp, mapping: input.mapping, allocationSeed: "apicc-sync-id-v1", baselineFiles: input.baselineFiles, localFiles: input.localFiles, otherSourceMappings: [], budget: { ...original.normalizeInput.budget, ...input.budget } };
  await expect(handleOperation("sync-plan", payload)).rejects.toThrow("SYNC_CONTENT_DIGEST_MISMATCH");
});

it.each(["source", "project", "host"])("source ownership retains a separate %s admission slot during actual blocked I/O", async kind => {
  await withSyncBlockedRuntime(async f => {
    const controller = new AbortController(), firstPayload = f.payload();
    const first = fetch(f.runtime.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(envelope("sync-read", firstPayload)), signal: controller.signal }).catch(() => undefined);
    await f.received;
    try {
      const next = f.payload("/quick", kind === "host" ? "73" : "72");
      if (kind === "project") next.input.source.id = "00000000-0000-4000-8000-000000000099";
      const response = await rpc(f.runtime.url, "sync-read", next);
      expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ code: "SYNC_BUSY", retryable: false });
    } finally { controller.abort(); await first; await f.releaseUpstream(); }
  }, () => ({ maxConcurrency: 1, maxProjectConcurrency: 1 }));
});

it("same source UUID in another online project is independently owned", async () => {
  await withSyncBlockedRuntime(async f => {
    const controller = new AbortController();
    const first = fetch(f.runtime.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(envelope("sync-read", f.payload())), signal: controller.signal }).catch(() => undefined);
    await f.received;
    try { const response = await rpc(f.runtime.url, "sync-read", f.payload("/quick", "73")); expect(response.status).toBe(200); }
    finally { controller.abort(); await first; await f.releaseUpstream(); }
  }, () => ({ maxConcurrency: 2, maxProjectConcurrency: 1 }));
});

it("retains source capacity until a real owned child exits and actual private collection finishes", async () => {
  let barrier: ReturnType<typeof ownedChildBarrier> | undefined;
  await withSyncBlockedRuntime(async f => {
    const client = request(f.runtime.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret } }); client.on("error", () => undefined);
    client.end(JSON.stringify(envelope("sync-read", f.payload()))); await f.received;
    expect(barrier!.alive()).toBe(true); client.destroy(); await f.rpcClosed;
    try { expect(await until(barrier!.aborted)).toBe(true); expect(barrier!.alive()).toBe(true); expect(f.runtime.sourceCapacity()).toEqual({ held: 1, retained: 0 }); }
    finally { await barrier!.allowOwnedChildExit(); await f.releaseUpstream(); await barrier!.close(); }
    expect(await until(barrier!.collected)).toBe(true); expect(barrier!.alive()).toBe(false); expect(f.runtime.sourceCapacity()).toEqual({ held: 0, retained: 0 });
  }, privateRoot => { barrier = ownedChildBarrier(privateRoot); return { createPrivateRead: barrier.createPrivateRead }; });
});

it("completed newer source generation cannot be replaced by a stale private invocation", async () => {
  await withSyncUrlRuntime(async f => {
    expect((await rpc(f.runtime.url, "sync-read", f.payload())).status).toBe(200);
    const newer = f.payload(); newer.input.source.revision = "2"; newer.context.sourceRevision = "2"; newer.context.authorizationGeneration = "2";
    expect((await rpc(f.runtime.url, "sync-read", newer)).status).toBe(200);
    const before = f.source.requests.length, stale = await rpc(f.runtime.url, "sync-read", f.payload());
    expect(await stale.json()).toMatchObject({ code: "SYNC_CONTEXT_STALE", retryable: false }); expect(f.source.requests).toHaveLength(before);
  });
});

it.each([0,17])("invalid trusted source concurrency%s cannot start a provider", async maxConcurrency => {
  await withSyncUrlRuntime(async f => {
    let runtime: Awaited<ReturnType<typeof startCollaborationRuntime>> | undefined;
    try { await expect(startCollaborationRuntime({ secret, port: 0, source: { privateRoot: f.privateRoot, allowedOrigins: [f.source.url], allowedCidrs: ["127.0.0.1/32"], maxConcurrency } }).then(value => { runtime = value; })).rejects.toThrow("SYNC_HOST_CONFIG_INVALID"); }
    finally { await runtime?.close(); }
  });
});

it("production profile snapshot prepares actual CA content through Core before the source TLS handshake", async () => {
  await withSyncUrlRuntime(async f => {
    expect(await f.source.read(f.source.secureUrl + "/ok", {}, { tls: { caPem: f.source.ca } })).toMatchObject({ status: "read", rawText: "hello" });
    const payload = f.payload(); if (payload.input.source.kind !== "url") throw Error("URL fixture");
    payload.input.source.url = f.source.secureUrl + "/ok"; payload.input.source.networkProfileRef = "owned-profile";
    payload.network = { kind: "profile", revision: "1", profile: { kind: "direct", id: "owned-profile", name: "Owned TLS", targetTlsBindings: [{ origin: f.source.secureUrl, tls: { caPems: [f.source.ca], clientCertPems: [] } }] } };
    const response = await rpc(f.runtime.url, "sync-read", payload); expect(response.status).toBe(200); expect((await response.json()).payload.rawText).toBe("hello");
  }, { captureNetwork: undefined });
});

it.each(["git-https", "git-ssh"] as const)("production %s dispatch uses configured tools and real private material instead of a second reader", async kind => {
  await withSyncRuntime(async f => {
    const dependency = await gitReaderFixture(f.git, { api: { createSourceHost } } as never);
    expect(await dependency.read(dependency.input(kind))).toMatchObject({ status: "read", rawText: f.git.repositories.sha1.rawText });
    const response = await rpc(f.runtime.url, "sync-read", f.payload(kind)); expect(response.status).toBe(200);
    expect((await response.json()).payload).toMatchObject({ status: "read", rawText: f.git.repositories.sha1.rawText, upstream: { kind: "git", commitOid: "f9fbd710b4a0772621ad5c76fb5393938a67b8e2", blobOid: "f77ca262872d149b637048a2aa365bc8794cd8db" } });
  });
}, 60000);

it("uncertain actual private collection keeps its real child, material and explicit occupancy after an RPC error", async () => {
  let barrier: ReturnType<typeof ownedChildBarrier> | undefined;
  await withSyncUrlRuntime(async f => {
    try {
      const response = await rpc(f.runtime.url, "sync-read", f.payload()), output = await response.json();
      expect.soft(output).toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED", retryable: false });
      expect.soft(barrier!.alive()).toBe(true); expect.soft(await access(barrier!.directory()).then(() => true, () => false)).toBe(true);
      expect.soft(f.runtime.sourceCapacity()).toEqual({ held: 1, retained: 1 });
      let reopened: Awaited<ReturnType<typeof startCollaborationRuntime>> | undefined;
      try {
        const alias = join(f.privateRoot, "alias-parent"); await symlink(dirname(f.privateRoot), alias, process.platform === "win32" ? "junction" : "dir");
        for (const privateRoot of [f.privateRoot, join(alias, basename(f.privateRoot))]) {
          const result = await startCollaborationRuntime({ secret, port: 0, source: { privateRoot, allowedOrigins: [f.source.url], allowedCidrs: ["127.0.0.1/32"] } }).then(value => { reopened = value; return "fresh-provider-held-" + value.sourceCapacity().held; }, error => (error as Error).message);
          expect.soft(result).toBe("SYNC_PROCESS_UNCOLLECTED"); expect.soft(barrier!.alive()).toBe(true);
        }
      } finally { await reopened?.close(); }
      const stopped = await f.runtime.close().then(() => "collected", error => (error as Error).message);
      expect.soft(stopped).toBe("SYNC_PROCESS_UNCOLLECTED");
    } finally { await barrier!.allowOwnedChildExit(); await barrier!.close(); }
  }, root => {
    barrier = ownedChildBarrier(root);
    return { createPrivateRead: async signal => { const owner = await barrier!.createPrivateRead(signal); await writeFile(join(owner.directory, "owned-material"), "synthetic-private-value"); return { ...owner, collect: async () => { await readFile(join(owner.directory, "missing-collection-proof")); } }; } };
  }, true);
});

it("explicit zero content-cache budget disables304reuse while preserving real source reads", async () => {
  await withSyncUrlRuntime(async f => {
    const first = await rpc(f.runtime.url, "sync-read", f.payload("/cache")); expect(first.status).toBe(200); expect((await first.json()).payload.rawText).toBe("hello");
    const second = await rpc(f.runtime.url, "sync-read", f.payload("/cache")); expect(second.status).toBe(200);
    expect((await second.json()).payload.status).toBe("read"); expect(f.source.requests.at(-1)?.headers["if-none-match"]).toBeUndefined();
  }, { cacheBytes: 0 });
});

it.each(["disconnect", "deadline", "shutdown"])("actual default Git read retains its owned child and source slot through %s until real collection", async kind => {
  await withSyncRuntime(async f => {
    const pending = await f.startBlockedGitRead(kind === "deadline" ? 8000 : 30000);
    expect(f.childAlive()).toBe(true); let stopping: Promise<void> | undefined, stopped = false;
    if (kind === "disconnect") await f.disconnect(pending);
    if (kind === "shutdown") { stopping = f.runtime.close().then(() => { stopped = true; }); await pending.rpcClosed; }
    if (kind === "deadline") { await pending.settled; expect(pending.status()).toBe(408); }
    try {
      expect(await until(f.abortObserved)).toBe(true); expect(f.childAlive()).toBe(true); expect(f.capacity()).toEqual({ held: 1, retained: 0 });
      expect(await until(async () => await f.git.activeHttpSockets() === 0, 5000)).toBe(true);
      if (kind === "shutdown") expect(stopped).toBe(false);
    } finally { await f.allowOwnedChildExit(); await f.waitCollected(pending); await stopping; }
    expect(f.childAlive()).toBe(false); expect(f.capacity()).toEqual({ held: 0, retained: 0 });
  });
}, 60000);

it.each(["scopes", "bytes"])("a small trusted generation %s budget is actually consumed and refuses new scope metadata", async kind => {
  await withSyncUrlRuntime(async f => {
    expect((await rpc(f.runtime.url, "sync-read", f.payload())).status).toBe(200);
    const next = f.payload(); next.input.source.id = "00000000-0000-4000-8000-000000000099";
    if (kind === "bytes") { next.input.source.revision = "2".repeat(600); next.context.sourceRevision = next.input.source.revision; next.context.authorizationGeneration = "2".repeat(600); }
    expect(RequestSchema.safeParse(envelope("sync-read", next)).success).toBe(true);
    const response = await rpc(f.runtime.url, "sync-read", next); expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ code: "SYNC_BUSY", retryable: false });
  }, kind === "scopes" ? { maxTrackedSources: 1 } : { maxGenerationBytes: 1024 });
});

it.each([{ maxTrackedSources: 0 }, { maxGenerationBytes: 1023 }])("invalid generation quota refuses provider startup %j", async options => {
  await withSyncUrlRuntime(async f => {
    let runtime: Awaited<ReturnType<typeof startCollaborationRuntime>> | undefined;
    try { await expect(startCollaborationRuntime({ secret, port: 0, source: { privateRoot: f.privateRoot, allowedOrigins: [f.source.url], allowedCidrs: ["127.0.0.1/32"], ...options } }).then(value => { runtime = value; })).rejects.toThrow("SYNC_HOST_CONFIG_INVALID"); }
    finally { await runtime?.close(); }
  });
});

it("TLS staging preflight accepts an actual valid CA before any native material write", async () => {
  await withSyncUrlRuntime(async f => {
    expect(await f.source.read(f.source.secureUrl + "/ok", {}, { tls: { caPem: f.source.ca } })).toMatchObject({ status: "read", rawText: "hello" });
    expect(() => preflightSourceTLS([{ caPems: [f.source.ca], clientCertPems: [] }])).not.toThrow();
  });
});
it("TLS staging preflight refuses invalid PEM before allocating native certificate files", () => {
  expect(() => preflightSourceTLS([{ caPems: ["synthetic-invalid-certificate"], clientCertPems: [] }])).toThrow("SYNC_MATERIAL_INVALID");
});
it("TLS staging preflight shares Core's actual4MiB certificate ceiling", async () => {
  await withSyncUrlRuntime(async f => {
    const size = Buffer.byteLength(f.source.ca), count = Math.floor(4 * 1048576 / size) + 1;
    expect(size).toBeLessThan(1048576); expect(size * count).toBeGreaterThan(4 * 1048576);
    expect(() => preflightSourceTLS([{ caPems: Array.from({ length: count }, () => f.source.ca), clientCertPems: [] }])).toThrow("SYNC_MATERIAL_INVALID");
  });
});

it("full private planning envelope has its own wire budget independent of the candidate's semantic budget", async () => {
  const f = await threeWayFixture(), input = f.planInput(), candidate = await buildSyncCandidate(input);
  expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(4096);
  expect(Buffer.byteLength(JSON.stringify({ candidate, planInput: input }))).toBeGreaterThan(4096);
  await withSyncUrlRuntime(async runtime => {
    const payload = { kind: "prepared", input }, small = { ...envelope("sync-plan", payload), outputBudgetBytes: 4096 };
    const response = await fetch(runtime.runtime.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(small) });
    expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: "RPC_MESSAGE_TOO_LARGE", retryable: false });
    const complete = await rpc(runtime.runtime.url, "sync-plan", payload); expect(complete.status).toBe(200);
    const result = await complete.json(); expect(result.payload.candidate.candidateDigest).toBe(candidate.candidateDigest); expect(result.payload.planInput.localFiles).toEqual(input.localFiles);
  });
});

it("dispatches prepared planning and complete decisions through the finite Core operations", async () => {
  const f = await candidateFixture();
  const positive = await buildSyncCandidate(f.planInput);
  expect(positive.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "both-modified" })]));
  const planned = await handleOperation("sync-plan", { kind: "prepared", input: f.planInput }) as SyncPlanOutput;
  expect(planned.candidate.candidateDigest).toBe(positive.candidateDigest);
  const result = await handleOperation("sync-resolve", { ...f.resolveInput, candidate: planned.candidate, planInput: planned.planInput });
  expect(result).toMatchObject({ writes: [], deletions: [], candidateDigest: planned.candidate.candidateDigest });
});

it("dispatches complete decisions against a fixed real candidate", async () => {
  const f = await candidateFixture();
  expect(await resolveSyncCandidate(f.resolveInput)).toMatchObject({ writes: [], deletions: [] });
  expect(RequestSchema.safeParse(envelope("sync-resolve", f.resolveInput)).success).toBe(true);
  expect(await handleOperation("sync-resolve", f.resolveInput)).toMatchObject({ writes: [], deletions: [], candidateDigest: f.candidate.candidateDigest });
});

it("dispatches a real content-bound rollback without implementing a second merge algorithm", async () => {
  const f = await candidateFixture();
  const applied = await resolveSyncCandidate({ ...f.resolveInput, decisions: { ...f.keepCurrentDecisions, entries: f.keepCurrentDecisions.entries.map(d => ({ ...d, decision: "take-source" as const })) } });
  const after = await applyResolved(f.planInput, applied), beforeFiles = f.planInput.localFiles, afterFiles = projectFiles(after);
  const currentStamp = { ...f.planInput.stamp, definitionRevision: createProjectSnapshot(after).definitionRevision, baselineRevision: "1" };
  const history = { formatVersion: 1, id: "00000000-0000-4000-8000-000000000761", sourceId: f.source.id, projectId: f.localProject.id, intentId: "00000000-0000-4000-8000-000000000762", operationKind: "apply", actor: { id: "fixture", name: "Fixture" }, createdAtMs: 1000,
    beforeStamp: f.planInput.stamp, afterStamp: currentStamp, upstream: f.planInput.upstream, before: digestProject(f.localProject, beforeFiles), after: digestProject(after, afterFiles), rollback: { beforeContent: contentReference(beforeFiles), afterContent: contentReference(afterFiles) }, integritySha256: "a".repeat(64) };
  const input = SyncRollbackInputSchema.parse({ history, currentFiles: afterFiles, currentStamp, beforeFiles, afterFiles, mapping: f.mapping, baselineFiles: applied.baselineFiles, otherSourceMappings: [], budget: f.planInput.budget });
  const positive = await buildSyncRollback(input); expect(positive.writes).toHaveLength(1);
  const result = await handleOperation("sync-rollback", input);
  expect(result).toEqual(positive);
});

it("default production dispatch reads an approved real source with complete typed private content", async () => {
  await withSyncUrlRuntime(async f => {
    const payload = f.payload("/cache");
    expect(RequestSchema.safeParse(envelope("sync-read", payload)).success).toBe(true);
    // Direct accepted SourceHost proves source fixture, network and budget before the RPC assertion.
    expect(await f.source.read(payload.input, { captureNetwork: async () => ({ ...await f.source.options.captureNetwork(payload.input.source, new AbortController().signal), approveDestination: (_u, a) => a.address === "127.0.0.1" }) })).toMatchObject({ status: "read", rawText: "hello" });
    const response = await rpc(f.runtime.url, "sync-read", payload);
    expect(response.status).toBe(200);
    expect((await response.json()).payload).toMatchObject({ formatVersion: 1, status: "read", rawText: "hello", upstream: { rawSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" } });
  });
});
