import { describe, expect, it } from "vitest";
import { allocateSyncId } from "../../src/sync/identity.js";

describe("apicc-sync-id-v1", () => {
  it("uses the versioned UTF-8 tuple, SHA-256 prefix and UUID v8 bits", () => {
    expect(allocateSyncId("11111111-1111-4111-8111-111111111111", "api", "/apis/GET/~1pets")).toBe("51118da5-6139-81b4-861b-cd36be195a44");
  });
  it("namespaces identity by source, entity kind and exact Unicode external key", () => {
    const ids = [
      allocateSyncId("11111111-1111-4111-8111-111111111111", "api", "/接口/🐈"),
      allocateSyncId("22222222-2222-4222-8222-222222222222", "api", "/接口/🐈"),
      allocateSyncId("11111111-1111-4111-8111-111111111111", "model", "/接口/🐈"),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(allocateSyncId("11111111-1111-4111-8111-111111111111", "api", "/接口/🐈")).toBe(ids[0]);
  });
});
