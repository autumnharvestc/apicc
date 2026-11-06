import { describe, expect, it } from "vitest";
import { realpath, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createProjectSnapshot, fileStorage } from "@apicc/core";
import { decodeContractWorkspace, defaultSyncPolicyValues } from "@apicc/core/sync";
import { deferred, id, withLocalSync } from "./fixtures.js";
import { createLocalSyncAdmission, openLocalSync } from "../../../src/main/sync/local.js";
import { createSession } from "../../../src/main/session.js";

describe("main local synchronization authority and durable transactions", () => {
  it.each(["project", "host", "retained"])("enforces %s read occupancy using the effective policy limits", kind => {
    const admission = createLocalSyncAdmission(); const first = admission.acquire("owned-project", 1, 2);
    if (kind === "project") expect(() => admission.acquire("owned-project", 1, 2)).toThrow("SYNC_CONCURRENCY_LIMIT");
    if (kind === "host") { admission.acquire("other-project", 1, 2); expect(() => admission.acquire("third-project", 1, 2)).toThrow("SYNC_CONCURRENCY_LIMIT"); }
    if (kind === "retained") { first.retain(); first.release(); expect(() => admission.acquire("owned-project", 1, 2)).toThrow("SYNC_CONCURRENCY_LIMIT"); }
  });
  it("returns an ordinarily settled slot to subsequent checks", () => {
    const admission = createLocalSyncAdmission(), slot = admission.acquire("owned", 1, 1); slot.release(); expect(() => admission.acquire("owned", 1, 1)).not.toThrow();
  });
  it("establishes a real legal session, fixed B/L/R and the actual runner", async () => {
    await withLocalSync(async f => {
      expect(process.version).toBe("v22.19.0"); expect(f.session.readOnly).toBe(false);
      expect(f.preparedCandidate.stamp.definitionRevision).toBe(createProjectSnapshot(f.readProject()).definitionRevision);
      expect(f.preparedCandidate.changes.length).toBeGreaterThan(0); expect(f.preparedCandidate.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    });
  });
  it("reads sources through the active session authority", async () => {
    await withLocalSync(async f => { expect(await f.client.sources(f.location)).toEqual([f.source]); });
  });
  it("versions a saved source without replacing baseline or project assets", async () => {
    await withLocalSync(async f => {
      const before = createProjectSnapshot(f.readProject()).definitionRevision;
      await f.client.saveSource(f.location, { ...f.source, revision: "2", url: f.source.url + "?next" }, "1");
      expect((await f.state()).sources[0]!.source.revision).toBe("2");
      expect((await f.state()).sources[0]!.baselineRevision).toBe("0"); expect(createProjectSnapshot(f.readProject()).definitionRevision).toBe(before);
    });
  });
  it.each(["revision", "new-revision", "module", "module-change"])("rejects an invalid source %s write", async kind => {
    await withLocalSync(async f => {
      const code = kind === "module-change" ? "SYNC_SOURCE_MODULE_CHANGE_UNSUPPORTED" : kind === "module" ? "SYNC_SOURCE_MODULE_MISMATCH" : "SYNC_SOURCE_REVISION_CHANGED";
      await expect(f.client.saveSource(f.location, { ...f.source, revision: kind === "new-revision" ? "5" : "2", moduleId: kind === "module" ? id(999) : kind === "module-change" ? id(824) : f.source.moduleId }, kind === "revision" ? "0" : "1")).rejects.toThrow(code);
    });
  });
  it("creates a new versioned source through the same authority", async () => {
    await withLocalSync(async f => { const source = { ...f.source, id: id(988), moduleId: id(824) }; await f.client.saveSource(f.location, source, "0"); expect((await f.state()).sources.find(s => s.source.id === source.id)?.source).toEqual(source); });
  });
  it.each(["source", "candidate", "history"])("rejects an absent %s at its real entry", async kind => {
    await withLocalSync(async f => {
      const missing = kind === "source" ? f.client.check(f.location, id(999)) : kind === "candidate" ? f.client.candidate(f.location, id(999)) : f.rollback(id(999));
      await expect(missing).rejects.toThrow(`SYNC_${kind.toUpperCase()}_NOT_FOUND`);
    });
  });
  it("creates and persists a usable immutable candidate without changing the business fingerprint", async () => {
    await withLocalSync(async f => {
      await f.mutateState(s => { s.candidates = []; }); await f.reopen();
      const fingerprint = createProjectSnapshot(f.readProject()).definitionRevision, beforeRevision = f.storageRevision();
      const view = await f.check(); expect(view?.applicable).toBe(true); expect(view?.candidate.upstream.kind).toBe("url");
      expect(createProjectSnapshot(f.readProject()).definitionRevision).toBe(fingerprint);
      expect((await f.client.candidate(f.location, view.candidate.id)).candidate).toEqual(view.candidate);
      expect(f.storageRevision()).not.toBe(beforeRevision); expect(f.released()).toBe(1);
    });
  });
  it("does not publish or settle a candidate while material release is still owned", async () => {
    await withLocalSync(async f => {
      const gate = f.blockRelease(), before = (await f.state()).candidates.length; let done = false;
      const pending = f.check().finally(() => { done = true; });
      try { expect(await Promise.race([gate.started.then(() => "release"), pending.then(() => "early")])).toBe("release"); expect(done).toBe(false); expect((await f.state()).candidates).toHaveLength(before); }
      finally { gate.unblock(); await pending; }
    });
  });
  it("discards a private raw handoff when final owned release fails", async () => {
    await withLocalSync(async f => { const before = f.storageRevision(); f.failRelease(); await expect(f.check()).rejects.toThrow(); expect(f.storageRevision()).toBe(before); expect((await f.state()).operations).toEqual([]); });
  });
  it("retains coordinator occupancy when the actual Git owner cannot prove collection", async () => {
    await withLocalSync(async f => {
      let retained = 0;
      await f.mutateState(s => { const { url: _url, ...base } = f.source; s.sources[0]!.source = { ...base, kind: "git-https", repositoryUrl: "https://owned.example.test/synthetic.git", ref: "main", filePath: "openapi.json" }; });
      f.deps.sourceHost = { ...f.deps.sourceHost, git: { tools: { gitPath: f.privateRoot + "/not-installed-owned-fixture.exe" }, createPrivateRead: async () => ({ directory: f.privateRoot, collect: async () => { throw new Error("owned collection unavailable"); }, retainUncollected: async () => { retained++; } }) } };
      await expect(f.check()).rejects.toThrow("SYNC_PROCESS_UNCOLLECTED"); expect(retained).toBe(1); expect(f.released()).toBe(0);
      await expect(f.check()).rejects.toThrow("SYNC_CONCURRENCY_LIMIT"); expect((await f.state()).operations).toEqual([]);
    });
  });
  it("normalizes validated 304 content again under the current mapping", async () => {
    await withLocalSync(async f => {
      const first = await f.check(); expect(first?.applicable).toBe(true);
      const newApi = id(990);
      await f.mutateState(s => { s.sources[0]!.mapping.revision = "1"; s.sources[0]!.mapping.entries.find(e => e.entityKind === "api")!.entityId = newApi; });
      const second = await f.check(); expect(second.candidate.stamp.mappingRevision).toBe("1"); expect(second.candidate.candidateDigest).not.toBe(first.candidate.candidateDigest);
      expect(f.requests.map(r => r.status)).toEqual([200, 304]); expect((await f.remoteFiles(second.candidate.id)).some(file => file.path.includes(newApi))).toBe(true);
    });
  });
  it("evicts old private cache bindings instead of retaining every downloaded source", async () => {
    await withLocalSync(async f => {
      const first = await f.check(); expect(first?.applicable).toBe(true);
      for (let n = 1; n <= 4; n++) { await f.mutateState(s => { s.sources[0]!.source = { ...f.source, url: f.source.url + `?owned=${n}`, revision: String(n + 1) }; }); await f.check(); }
      await f.mutateState(s => { s.sources[0]!.source = f.source; }); await f.check();
      expect(f.requests.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    });
  });
  it("applies fixed content using the latest storage CAS and refreshes the actual session", async () => {
    await withLocalSync(async f => {
      await f.mutateState(s => { s.candidates[0]!.expiresAtMs += 1; });
      const receipt = await f.apply(); expect(receipt?.status).toBe("committed");
      expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("upstream");
      expect(f.unrelatedAssetBytes()).toEqual(f.originalUnrelatedAssetBytes); expect(f.session.revision).toBe((await decodeContractWorkspace(f.root)).revision);
      expect((await f.state()).history).toHaveLength(1);
    });
  });
  it.each(["project", "source", "mapping", "baseline", "authorization", "core", "expiry"])("explains and rejects a %s stale candidate", async kind => {
    await withLocalSync(async f => {
      const codes = { project: "project-assets-changed", source: "source-revision-changed", mapping: "mapping-revision-changed", baseline: "baseline-revision-changed", authorization: "authorization-changed", core: "core-identity-changed", expiry: "candidate-expired" };
      if (kind === "project") await f.editAssets();
      if (kind === "source") await f.mutateState(s => { s.sources[0]!.source.revision = "2"; });
      if (kind === "mapping") await f.mutateState(s => { s.sources[0]!.mapping.revision = "1"; });
      if (kind === "baseline") await f.mutateState(s => { s.sources[0]!.baselineRevision = "1"; });
      if (kind === "authorization") f.changeAuthorization(); if (kind === "core") f.changeCore(); if (kind === "expiry") f.expire();
      const view = await f.client.candidate(f.location, f.preparedCandidate.id); expect(view?.reasonCode).toBe(codes[kind as keyof typeof codes]); expect(view?.candidate).toEqual(f.preparedCandidate);
      await expect(f.apply()).rejects.toThrow("SYNC_CANDIDATE_STALE");
    });
  });
  it.each(["digest", "decisions"])("rejects invalid apply %s without changing assets", async kind => {
    await withLocalSync(async f => {
      const candidate = kind === "digest" ? { ...f.preparedCandidate, candidateDigest: "b".repeat(64) } : f.preparedCandidate;
      const decisions = kind === "decisions" ? { formatVersion: 1 as const, candidateDigest: candidate.candidateDigest, entries: [] } : f.decisions(candidate);
      await expect(f.apply(candidate, decisions)).rejects.toThrow(kind === "digest" ? "SYNC_CANDIDATE_DIGEST_MISMATCH" : /^SYNC_/);
      expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("baseline");
    });
  });
  it.each(["replay", "mismatch", "receipt-integrity", "request-integrity"])("handles an already durable %s intent", async kind => {
    await withLocalSync(async f => {
      const history = await f.seedApplied();
      if (kind === "replay") { expect(await f.apply(undefined, undefined, history.intentId)).toEqual(history.receipt); expect(await f.client.operation(f.location, history.intentId)).toEqual(history.receipt); }
      if (kind === "mismatch") await expect(f.apply(f.preparedCandidate, f.decisions(undefined, "keep-current"), history.intentId)).rejects.toThrow("SYNC_INTENT_MISMATCH");
      if (kind === "receipt-integrity") { await f.mutateState(s => { s.operations[0]!.receipt.actor.name = "tampered"; }); await expect(f.client.operation(f.location, history.intentId)).rejects.toThrow("SYNC_RECEIPT_INTEGRITY_MISMATCH"); }
      if (kind === "request-integrity") { await f.mutateState(s => { s.operations[0]!.requestDigest = "c".repeat(64); }); await expect(f.client.operation(f.location, history.intentId)).rejects.toThrow("SYNC_RECEIPT_INTEGRITY_MISMATCH"); }
    });
  });
  it("recovers the same receipt for a duplicate intent and refuses different intent content", async () => {
    await withLocalSync(async f => {
      const intent = f.newIntent(), first = await f.apply(undefined, undefined, intent), revision = f.storageRevision();
      expect(first?.intentId).toBe(intent); expect(await f.apply(undefined, undefined, intent)).toEqual(first); expect(f.storageRevision()).toBe(revision);
      await expect(f.apply(f.preparedCandidate, f.decisions(undefined, "keep-current"), intent)).rejects.toThrow("SYNC_INTENT_MISMATCH");
      await f.reopen(); expect(await f.client.operation(f.location, intent)).toEqual(first);
    });
  });
  it("retains committed receipt after a real active-session refresh failure", async () => {
    await withLocalSync(async f => {
      const intent = f.newIntent(); f.failNextRefresh(); await expect(f.apply(undefined, undefined, intent)).rejects.toThrow("synthetic refresh unavailable");
      await f.reopen(); const recovered = await f.client.operation(f.location, intent); expect(recovered?.status).toBe("committed"); expect(await f.apply(undefined, undefined, intent)).toEqual(recovered); expect((await f.state()).history).toHaveLength(1);
    });
  });
  it("rolls assets and sidecar back together after an actual mid-write fault", async () => {
    await withLocalSync(async f => {
      const before = f.storageRevision(); let hit = false;
      f.setWriteFault((stage, path) => { if (stage === "after-replace" && path?.endsWith("/synchronization.yaml")) { hit = true; throw new Error("owned write fault"); } });
      await expect(f.apply()).rejects.toThrow("Workspace write failed"); expect(hit).toBe(true);
      expect((await decodeContractWorkspace(f.root)).revision).toBe(before); expect((await f.state()).history).toEqual([]); expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("baseline");
    });
  });
  it("restores a persisted sync after reopen without replacing unrelated assets", async () => {
    await withLocalSync(async f => { const applied = await f.applyPreparedChange(); await f.reopen(); await f.rollback(applied.historyId, f.newIntent()); expect(f.unrelatedAssetBytes()).toEqual(f.originalUnrelatedAssetBytes); expect(f.storageRevision()).not.toBe(applied.beforeStorageRevision); expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("baseline"); expect((await f.state()).history).toHaveLength(2); });
  });
  it("rolls back a real journal-seeded history and advances mapping/baseline versions", async () => {
    await withLocalSync(async f => { const history = await f.seedApplied(); const receipt = await f.rollback(history.id); expect(receipt?.kind).toBe("rollback"); expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("baseline"); const source = (await f.state()).sources[0]!; expect(source.mapping.revision).toBe("2"); expect(source.baselineRevision).toBe("2"); });
  });
  it.each(["later-edit", "integrity"])("rejects rollback after %s", async kind => {
    await withLocalSync(async f => { const history = await f.seedApplied(); if (kind === "later-edit") await f.editAssets(); else await f.mutateState(s => { s.history[0]!.actor.name = "tampered"; }); await expect(f.rollback(history.id)).rejects.toThrow(kind === "later-edit" ? "SYNC_ROLLBACK_CURRENT_CHANGED" : "SYNC_HISTORY_INTEGRITY_MISMATCH"); });
  });
  it("retains only the configured history window while preserving selected rollback contents", async () => {
    await withLocalSync(async f => { f.deps.policy = { ...defaultSyncPolicyValues, historyMaxEntries: 1 }; await f.reopen(); const history = await f.seedApplied(); await f.rollback(history.id); expect((await f.state()).history.map(h => h.operationKind)).toEqual(["rollback"]); });
  });
  it.each(["rollback", "history-list"])("expires an old retained %s through the configured history days", async kind => {
    await withLocalSync(async f => { const history = await f.seedApplied(); f.advanceTime(31 * 86400000); if (kind === "rollback") await expect(f.rollback(history.id)).rejects.toThrow("SYNC_HISTORY_EXPIRED"); else expect(await f.client.history(f.location)).toEqual([]); });
  });
  it("advances the confirmed baseline when all changes explicitly keep current", async () => {
    await withLocalSync(async f => { const receipt = await f.apply(f.preparedCandidate, f.decisions(undefined, "keep-current")); expect(receipt?.status).toBe("committed"); expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("baseline"); const next = await f.check(); expect(next.candidate.changes).toEqual([]); });
  });
  it("fences source reads and commits after an actual workspace switch", async () => {
    await withLocalSync(async f => { await f.session.open(f.otherRoot); await expect(f.client.sources(f.location)).rejects.toThrow("SYNC_CONTEXT_CHANGED"); await expect(f.apply()).rejects.toThrow("SYNC_CONTEXT_CHANGED"); expect((await f.state()).history).toEqual([]); });
  });
  it("fences a sync commit queued behind the actual session's pending root switch", async () => {
    await withLocalSync(async f => { const switching = f.session.open(f.otherRoot), pending = f.apply(); const observed = pending.catch(error => error); await switching; expect((await observed).message).toBe("SYNC_CONTEXT_CHANGED"); expect((await f.state()).history).toEqual([]); });
  });
  it("serializes a real sync commit with the next ordinary session mutation", async () => {
    await withLocalSync(async f => {
      const pending = f.apply(), mutation = f.session.renameNode({ kind: "project", locator: { workspaceId: f.session.workspace!.id, ...f.location } }, "After sync");
      const results = await Promise.allSettled([pending, mutation]); expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(f.readProject().name).toBe("After sync"); expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("upstream"); expect(f.session.revision).toBe((await decodeContractWorkspace(f.root)).revision);
    });
  });
  it("fences a late network completion after an actual workspace switch", async () => {
    await withLocalSync(async f => {
      const gate = f.blockRelease(), pending = f.check(); const observed = pending.then(() => "early", () => "rejected");
      try { expect(await Promise.race([gate.started.then(() => "release"), observed])).toBe("release"); await f.session.open(f.otherRoot); }
      finally { gate.unblock(); }
      await expect(pending).rejects.toThrow("SYNC_CONTEXT_CHANGED"); expect((await f.state()).history).toEqual([]);
    });
  });
  it("cancels a check after private handoff without publishing a candidate", async () => {
    await withLocalSync(async f => {
      const gate = f.blockRelease(), controller = new AbortController(), before = f.storageRevision(), pending = f.check(controller.signal), observed = pending.then(() => "early", () => "rejected");
      try { expect(await Promise.race([gate.started.then(() => "release"), observed])).toBe("release"); controller.abort(); }
      finally { gate.unblock(); }
      await expect(pending).rejects.toThrow(); expect(f.storageRevision()).toBe(before);
    });
  });
  it.each(["project", "authorization", "read-only"])("enforces current %s authority", async kind => {
    await withLocalSync(async f => {
      if (kind === "project") await expect(f.client.sources({ ...f.location, projectId: id(999) })).rejects.toThrow("SYNC_PROJECT_NOT_FOUND");
      if (kind === "authorization") { f.deps.authorize = async () => { throw new Error("SYNC_ACCESS_DENIED"); }; await expect(f.client.operation(f.location, f.newIntent())).rejects.toThrow("SYNC_ACCESS_DENIED"); }
      if (kind === "read-only") { await f.makeReadOnly(); expect(f.session.readOnly).toBe(true); await expect(f.apply()).rejects.toThrow("SYNC_READ_ONLY"); }
    });
  });
});

describe("T6 review fixes I1-I3", () => {
  it.each(["cancel", "deadline"])("review I1 refuses post-settlement %s before candidate commit", async terminal => {
    await withLocalSync(async f => {
      await f.mutateState(s => { s.candidates = []; });
      const abort = new AbortController(), authorize = f.deps.authorize;
      let authorizations = 0, crossedDeadlineSynchronously = false;
      if (terminal === "cancel") f.deps.authorize = async projectId => {
        const current = await authorize(projectId);
        if (++authorizations === 2) { expect(f.released()).toBe(1); abort.abort(); }
        return current;
      };
      else {
        f.deps.policy = { ...defaultSyncPolicyValues, connectTimeoutMs: 1000, urlDeadlineMs: 5000 };
        let blocked = false;
        f.deps.now = () => {
          if (!blocked) {
            blocked = true; expect(f.released()).toBe(1);
            const until = Date.now() + 5050;
            while (Date.now() < until) { /* A synchronous post-load step crosses the absolute deadline before timers can run. */ }
            crossedDeadlineSynchronously = true;
          }
          return Date.now();
        };
      }
      await f.reopen();
      expect(process.version).toBe("v22.19.0");
      const before = (await f.state()).candidates.length;
      await expect(f.check(abort.signal)).rejects.toThrow(terminal === "cancel" ? "SYNC_CANCELLED" : "SYNC_DEADLINE");
      expect(before).toBe(0); expect((await f.state()).candidates).toEqual([]); expect(f.released()).toBe(1);
      if (terminal === "deadline") expect(crossedDeadlineSynchronously).toBe(true);
      // The host was safely settled: terminal refusal must release admission,
      // rather than retain it as an uncertain owner.
      expect((await f.check()).applicable).toBe(true);
    });
  });
  it("review I2 renews expired same-input lifecycle and applies the unchanged candidate", async () => {
    await withLocalSync(async f => {
      const first = await f.check(), original = (await f.state()).candidates.find(c => c.candidate.id === first.candidate.id)!;
      expect(first.applicable).toBe(true); f.expire();
      expect((await f.client.candidate(f.location, first.candidate.id)).reasonCode).toBe("candidate-expired");
      const renewed = await f.check();
      expect(renewed.applicable).toBe(true); expect(renewed.reasonCode).toBeNull(); expect(renewed.candidate).toEqual(first.candidate);
      const record = (await f.state()).candidates.find(c => c.candidate.id === first.candidate.id)!;
      expect(record.createdAtMs).toBeGreaterThan(original.createdAtMs); expect(record.expiresAtMs).toBeGreaterThan(original.expiresAtMs);
      expect([record.baselineContent, record.localContent, record.remoteContent]).toEqual([original.baselineContent, original.localContent, original.remoteContent]);
      expect(f.requests.map(r => r.status)).toEqual([200, 304]);
      await f.reopen(); expect((await f.client.candidate(f.location, first.candidate.id)).applicable).toBe(true);
      expect((await f.apply(renewed.candidate)).status).toBe("committed");
      expect(f.readProject().collections[0]!.apis[0]!.contract.metadata.description).toBe("upstream");
    });
  });
  it("review I3 shares active and retained project occupancy across two legal physical-root aliases", async () => {
    await withLocalSync(async f => {
      const aliasParent = join(f.privateRoot, "owned-workspace-parent"), alias = join(aliasParent, "workspace");
      await symlink(f.workspaceContainer, aliasParent, "junction");
      try {
        expect(await realpath(aliasParent)).toBe(await realpath(f.workspaceContainer));
        const aliasSession = createSession(); await aliasSession.open(alias);
        expect(f.session.readOnly).toBe(false); expect(aliasSession.readOnly).toBe(false);
        expect((await fileStorage.load(alias)).readOnly).toBe(false); expect(aliasSession.workspace).toEqual(f.session.workspace);
        const physical = await stat(f.root, { bigint: true }), aliased = await stat(alias, { bigint: true });
        expect([aliased.dev, aliased.ino]).toEqual([physical.dev, physical.ino]);
        const acquire = f.deps.acquireMaterial, secondAcquired = deferred(); let acquisitions = 0;
        f.deps.acquireMaterial = async (...args) => { if (++acquisitions === 2) secondAcquired.resolve(); return acquire(...args); };
        const aliasClient = await openLocalSync(alias, { ...f.deps, session: aliasSession });
        expect(await f.client.sources(f.location)).toEqual([f.source]); expect(await aliasClient.sources(f.location)).toEqual([f.source]);
        const gate = f.blockRelease(); f.failRelease();
        const first = f.check(), firstOutcome = first.then(() => null, error => error);
        let second: Promise<unknown> | undefined;
        try {
          expect(await Promise.race([gate.started.then(() => "released-owner-pending"), firstOutcome.then(() => "settled-too-early")])).toBe("released-owner-pending");
          second = aliasClient.check(f.location, f.source.id);
          const denied = second.then(() => "published", error => (error as Error).message);
          expect(await Promise.race([secondAcquired.promise.then(() => "admitted-through-alias"), denied])).toBe("SYNC_CONCURRENCY_LIMIT");
        } finally { gate.unblock(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
        expect((await firstOutcome).code).toBe("SYNC_MATERIAL_RELEASE_FAILED");
        await expect(aliasClient.check(f.location, f.source.id)).rejects.toThrow("SYNC_CONCURRENCY_LIMIT");
        expect(acquisitions).toBe(1); expect(f.released()).toBe(1);
      } finally { await unlink(aliasParent); }
    });
  });
});
