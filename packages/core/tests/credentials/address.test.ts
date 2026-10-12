import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CredentialAddressModule {
  credentialIndexPath(
    privateRoot: string,
    scope: { workspaceId: string; groupId: string; projectId: string },
    refId: string,
  ): string;
  writePrivateIndexAtomically(
    privateRoot: string,
    scope: { workspaceId: string; groupId: string; projectId: string },
    pointer: { formatVersion: 1; refId: string; generation: string; policy: string; version: string },
  ): Promise<void>;
}
interface CredentialEntryAddressModule {
  credentialEntryAddress(
    scope: { workspaceId: string; groupId: string; projectId: string },
    refId: string,
    generation: string,
  ): [service: string, account: string];
}

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  groupId: "55555555-5555-4555-8555-555555555555",
  projectId: "22222222-2222-4222-8222-222222222222",
};
const privateIndexModuleUrl = new URL("../../src/credentials/privateIndex.ts", import.meta.url).href;
const credentialAddressModuleUrl = new URL("../../src/credentials/address.ts", import.meta.url).href;

async function loadCredentialAddressModule(): Promise<CredentialAddressModule> {
  const loaded = await import(privateIndexModuleUrl).catch(() => null);
  expect(loaded, "private credential index should expose its address behavior").not.toBeNull();
  return loaded as CredentialAddressModule;
}

async function loadCredentialEntryAddressModule(): Promise<CredentialEntryAddressModule> {
  const loaded = await import(credentialAddressModuleUrl).catch(() => null);
  expect(loaded, "credential address logic should be implemented before the behavior tests run").not.toBeNull();
  return loaded as CredentialEntryAddressModule;
}

describe("credential index address", () => {
  it("uses the v2 subtree and encodes logical ref identities without path folding", async () => {
    const { credentialIndexPath } = await loadCredentialAddressModule();
    const privateRoot = resolve(tmpdir(), "apicc-credential-address-test");

    expect(credentialIndexPath(privateRoot, scope, "A/é")).toBe(join(
      privateRoot,
      "apicc",
      "credentials-v2",
      "ag%bwvi{h2%'e@!m77%=%ok'f(3pa7vg_;+)#1x[+'9b,68&4;24m5&~anuc+(r^o~vo3s9_weydiia$v`r&",
      "r!~aa;~aeb.json",
    ));
    expect(credentialIndexPath(privateRoot, scope, "Case")).not.toBe(
      credentialIndexPath(privateRoot, scope, "case"),
    );
    expect(credentialIndexPath(privateRoot, scope, "")).toBe(join(
      privateRoot,
      "apicc",
      "credentials-v2",
      "ag%bwvi{h2%'e@!m77%=%ok'f(3pa7vg_;+)#1x[+'9b,68&4;24m5&~anuc+(r^o~vo3s9_weydiia$v`r&",
      "r.json",
    ));
  });

  it("preserves accepted UUID text casing in index, lock, and service identities", async () => {
    const { credentialIndexPath } = await loadCredentialAddressModule();
    const { credentialEntryAddress } = await loadCredentialEntryAddressModule();
    const privateRoot = resolve(tmpdir(), "apicc-credential-address-test");
    const lowerScope = {
      workspaceId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      groupId: "fedcbafe-dcba-4fed-8cba-fedcbafedcba",
      projectId: "faceb00c-face-4ace-8ace-faceb00cface",
    };
    const generation = "33333333-3333-4333-8333-333333333333";

    for (const field of ["workspaceId", "groupId", "projectId"] as const) {
      const upperScope = { ...lowerScope, [field]: lowerScope[field].toUpperCase() };
      const lowerIndex = credentialIndexPath(privateRoot, lowerScope, "same-ref");
      const upperIndex = credentialIndexPath(privateRoot, upperScope, "same-ref");
      const [lowerService, lowerAccount] = credentialEntryAddress(lowerScope, "same-ref", generation);
      const [upperService, upperAccount] = credentialEntryAddress(upperScope, "same-ref", generation);

      expect(upperIndex).not.toBe(lowerIndex);
      expect(`${upperIndex}.lock.sqlite`).not.toBe(`${lowerIndex}.lock.sqlite`);
      expect(upperService).not.toBe(lowerService);
      expect(upperAccount).toBe(lowerAccount);
    }
  });

  it("keeps ordinary UUID ref lock paths below the Windows limit without case folding", async () => {
    const { credentialIndexPath } = await loadCredentialAddressModule();
    const { credentialEntryAddress } = await loadCredentialEntryAddressModule();
    const privateRoot = resolve(tmpdir(), "apicc-credential-address-test");
    const lowerRef = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const upperRef = lowerRef.toUpperCase();
    const lowerLockPath = `${credentialIndexPath(privateRoot, scope, lowerRef)}.lock.sqlite`;
    const upperLockPath = `${credentialIndexPath(privateRoot, scope, upperRef)}.lock.sqlite`;
    const generation = "33333333-3333-4333-8333-333333333333";
    const lowerAccount = credentialEntryAddress(scope, lowerRef, generation)[1];
    const upperAccount = credentialEntryAddress(scope, upperRef, generation)[1];

    expect(upperLockPath).not.toBe(lowerLockPath);
    expect(upperAccount).not.toBe(lowerAccount);
    expect(lowerLockPath.length).toBeLessThan(260);
    expect(upperLockPath.length).toBeLessThan(260);
  });

  it("preserves a lone surrogate separately from the Unicode replacement character", async () => {
    const { credentialIndexPath } = await loadCredentialAddressModule();
    const privateRoot = resolve(tmpdir(), "apicc-credential-address-test");
    const loneSurrogate = credentialIndexPath(privateRoot, scope, "\ud800");
    const replacementCharacter = credentialIndexPath(privateRoot, scope, "\ufffd");

    expect(loneSurrogate).toBe(join(
      privateRoot,
      "apicc",
      "credentials-v2",
      "ag%bwvi{h2%'e@!m77%=%ok'f(3pa7vg_;+)#1x[+'9b,68&4;24m5&~anuc+(r^o~vo3s9_weydiia$v`r&",
      "r~qzw.json",
    ));
    expect(replacementCharacter).toBe(join(
      privateRoot,
      "apicc",
      "credentials-v2",
      "ag%bwvi{h2%'e@!m77%=%ok'f(3pa7vg_;+)#1x[+'9b,68&4;24m5&~anuc+(r^o~vo3s9_weydiia$v`r&",
      "r~t1].json",
    ));
    expect(loneSurrogate).not.toBe(replacementCharacter);
  });

  it("segments long encoded refs into bounded path components without truncation", async () => {
    const { credentialIndexPath } = await loadCredentialAddressModule();
    const privateRoot = resolve(tmpdir(), "apicc-credential-address-test");
    const longRef = "x".repeat(200);
    const indexPath = credentialIndexPath(privateRoot, scope, longRef);
    const differentLongRef = credentialIndexPath(privateRoot, scope, `${"x".repeat(199)}y`);
    const pathParts = indexPath.split(/[\\/]/);
    const refMarker = pathParts.lastIndexOf("ref");
    const encodedParts = pathParts.slice(refMarker + 1, -1);

    expect(encodedParts.map((part) => part.length)).toEqual([97, 96, 8]);
    expect(encodedParts.join("")).toBe(`r${"x".repeat(200)}`);
    expect(indexPath).not.toBe(differentLongRef);
    expect(indexPath.endsWith("index.json")).toBe(true);
  });

  it("keeps internal random generations in a separate UUID domain from external scope UUIDs", async () => {
    const { writePrivateIndexAtomically } = await loadCredentialAddressModule();
    const privateRoot = resolve(tmpdir(), "apicc-credential-address-test");
    const nilUuid = "00000000-0000-0000-0000-000000000000";

    await expect(writePrivateIndexAtomically(privateRoot, scope, {
      formatVersion: 1,
      refId: "logical-id",
      generation: nilUuid,
      policy: "test-auto",
      version: nilUuid,
    })).rejects.toMatchObject({ code: "CREDENTIAL_FORMAT_UNSUPPORTED", refId: "logical-id" });
  });
});
