import { describe, expect, it, vi } from "vitest";

interface CredentialScope {
  workspaceId: string;
  groupId: string;
  projectId: string;
}

interface SecretRef {
  id: string;
  policy: string;
}

interface SecretStore {
  put(scope: CredentialScope, ref: SecretRef, value: string): Promise<void>;
  resolve(scope: CredentialScope, ref: SecretRef, expectedVersion?: string): Promise<string>;
  version(scope: CredentialScope, ref: SecretRef): Promise<string>;
  remove(scope: CredentialScope, ref: SecretRef): Promise<void>;
  status(scope: CredentialScope, ref: SecretRef): Promise<"available" | "missing" | "unavailable">;
}

interface CredentialBindings {
  resolve(ref: SecretRef): string;
  readonly versions: Readonly<Record<string, string>>;
}

interface BindingsModule {
  prepareCredentialBindings(
    scope: CredentialScope,
    refs: readonly SecretRef[],
    store: SecretStore,
    expectedVersions?: Readonly<Record<string, string>>,
  ): Promise<CredentialBindings>;
}

const scope: CredentialScope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  groupId: "55555555-5555-4555-8555-555555555555",
  projectId: "22222222-2222-4222-8222-222222222222",
};
const ref: SecretRef = { id: "33333333-3333-4333-8333-333333333333", policy: "test-auto" };
const otherRef: SecretRef = { id: "44444444-4444-4444-8444-444444444444", policy: "test-auto" };
const bindingsModuleUrl = new URL("../../src/credentials/bindings.ts", import.meta.url).href;
const credentialTypesModuleUrl = new URL("../../src/credentials/types.ts", import.meta.url).href;

async function loadBindingsModule(): Promise<BindingsModule> {
  const loaded = await import(bindingsModuleUrl).catch(() => null);
  expect(loaded, "credential bindings should be implemented before the behavior tests run").not.toBeNull();
  return loaded as BindingsModule;
}

function makeStore(overrides: Partial<SecretStore> = {}) {
  let value = "old-synthetic";
  let generation = "generation-one";
  const store: SecretStore = {
    put: vi.fn(async (_scope, _ref, nextValue) => { value = nextValue; generation = "generation-two"; }),
    resolve: vi.fn(async () => value),
    version: vi.fn(async () => generation),
    remove: vi.fn(async () => { value = ""; }),
    status: vi.fn(async () => "available" as const),
    ...overrides,
  };
  return {
    store,
    setValue(nextValue: string) { value = nextValue; },
    setGeneration(nextGeneration: string) { generation = nextGeneration; },
  };
}

describe("prepareCredentialBindings", () => {
  it("deduplicates by ref ID and keeps the prepared value and generation after the store changes", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const fake = makeStore();

    const bindings = await prepareCredentialBindings(scope, [ref, ref], fake.store);
    expect(fake.store.resolve).toHaveBeenCalledTimes(1);
    expect(bindings.resolve(ref)).toBe("old-synthetic");
    expect(bindings.versions).toEqual({ [ref.id]: "generation-one" });
    expect(Object.isFrozen(bindings.versions)).toBe(true);

    await fake.store.put(scope, ref, "next-synthetic");
    expect(bindings.resolve(ref)).toBe("old-synthetic");
  });

  it("rejects an original ref whose policy is mutated after preparation", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const fake = makeStore();
    const mutableRef = { ...ref };
    const bindings = await prepareCredentialBindings(scope, [mutableRef], fake.store);

    mutableRef.policy = "strict-future-policy";
    let thrown: unknown;
    try {
      bindings.resolve(mutableRef);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "CREDENTIAL_POLICY_UNSUPPORTED", refId: ref.id });
  });

  it("checks expected versions before reading any secret", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const fake = makeStore();

    await expect(prepareCredentialBindings(scope, [ref], fake.store, { [ref.id]: "stale-generation" }))
      .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: ref.id });
    expect(fake.store.resolve).not.toHaveBeenCalled();
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "uses only own expected versions for prototype-named ref %s",
    async (id) => {
      const { prepareCredentialBindings } = await loadBindingsModule();
      const prototypeNamedRef = { id, policy: "test-auto" };
      const ownCorrect = Object.fromEntries([[id, "generation-one"]]) as Record<string, string>;
      const ownWrong = Object.fromEntries([[id, "stale-generation"]]) as Record<string, string>;
      const acceptedTables: Readonly<Record<string, string>>[] = [
        {},
        { [otherRef.id]: "generation-one" },
        ownCorrect,
      ];

      for (const expectedVersions of acceptedTables) {
        const fake = makeStore();
        const bindings = await prepareCredentialBindings(scope, [prototypeNamedRef], fake.store, expectedVersions);

        expect(bindings.resolve(prototypeNamedRef)).toBe("old-synthetic");
        expect(Object.prototype.hasOwnProperty.call(bindings.versions, id)).toBe(true);
        expect(bindings.versions[id]).toBe("generation-one");
      }

      const wrongFake = makeStore();
      await expect(prepareCredentialBindings(scope, [prototypeNamedRef], wrongFake.store, ownWrong))
        .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: id });
      expect(wrongFake.store.resolve).not.toHaveBeenCalled();
    },
  );

  it("rejects a generation change during preparation instead of returning a mixed binding", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const version = vi.fn()
      .mockResolvedValueOnce("generation-one")
      .mockResolvedValueOnce("generation-two");
    const fake = makeStore({ version });

    await expect(prepareCredentialBindings(scope, [ref], fake.store))
      .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: ref.id });
  });

  it("reports VERSION_CONFLICT when a ref disappears after its version was captured", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const { CredentialError } = await import(credentialTypesModuleUrl);
    const resolve = vi.fn(async () => {
      throw new CredentialError("CREDENTIAL_MISSING", ref.id);
    });
    const fake = makeStore({ resolve });

    await expect(prepareCredentialBindings(scope, [ref], fake.store))
      .rejects.toMatchObject({ code: "CREDENTIAL_VERSION_CONFLICT", refId: ref.id });
    expect(fake.store.version).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does no store work for an empty reference set", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const store: SecretStore = {
      put: vi.fn(async () => { throw new Error("unexpected provider access"); }),
      resolve: vi.fn(async () => { throw new Error("unexpected provider access"); }),
      version: vi.fn(async () => { throw new Error("unexpected provider access"); }),
      remove: vi.fn(async () => { throw new Error("unexpected provider access"); }),
      status: vi.fn(async () => { throw new Error("unexpected provider access"); }),
    };

    const bindings = await prepareCredentialBindings(scope, [], store);
    expect(bindings.versions).toEqual({});
    expect(store.version).not.toHaveBeenCalled();
    expect(store.resolve).not.toHaveBeenCalled();
    expect(store.status).not.toHaveBeenCalled();
    expect(() => bindings.resolve(ref)).toThrow();
  });

  it("keeps the prepared credential snapshot tied to its complete group scope", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const fake = makeStore({
      version: vi.fn(async (credentialScope) => `version:${credentialScope.groupId}`),
      resolve: vi.fn(async (credentialScope) => `value:${credentialScope.groupId}`),
    });

    const bindings = await prepareCredentialBindings(scope, [ref], fake.store);

    expect(bindings.resolve(ref)).toBe("value:55555555-5555-4555-8555-555555555555");
    expect(bindings.versions).toEqual({ [ref.id]: "version:55555555-5555-4555-8555-555555555555" });
    expect(fake.store.version).toHaveBeenCalledWith(scope, ref);
    expect(fake.store.resolve).toHaveBeenCalledWith(scope, ref, "version:55555555-5555-4555-8555-555555555555");
  });

  it("prepares and resolves an empty logical ref ID", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const emptyRef = { id: "", policy: "test-auto" };
    const fake = makeStore();

    const bindings = await prepareCredentialBindings(scope, [emptyRef], fake.store);

    expect(bindings.resolve(emptyRef)).toBe("old-synthetic");
    expect(bindings.versions).toEqual({ "": "generation-one" });
    expect(fake.store.version).toHaveBeenCalledWith(scope, emptyRef);
  });

  it("treats a non-string store result as READ_FAILED rather than as a missing value", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const fake = makeStore({ resolve: vi.fn(async () => null as unknown as string) });

    await expect(prepareCredentialBindings(scope, [ref], fake.store))
      .rejects.toMatchObject({ code: "CREDENTIAL_READ_FAILED", refId: ref.id });
  });

  it("does not resolve an ID that was not part of the prepared snapshot", async () => {
    const { prepareCredentialBindings } = await loadBindingsModule();
    const fake = makeStore();
    const bindings = await prepareCredentialBindings(scope, [ref], fake.store);

    expect(() => bindings.resolve(otherRef)).toThrow();
  });
});
