import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const sideEffects = vi.hoisted(() => ({ fileCalls: [] as string[], nativeLoads: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const watched = new Set(["open", "readFile", "rename", "rm", "mkdir", "writeFile", "stat", "access"]);
  return new Proxy(actual, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function" || !watched.has(String(property))) return value;
      return (...args: unknown[]) => {
        sideEffects.fileCalls.push(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watched = new Set(["openSync", "readFileSync", "renameSync", "rmSync", "mkdirSync", "writeFileSync", "statSync", "existsSync"]);
  return new Proxy(actual, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function" || !watched.has(String(property))) return value;
      return (...args: unknown[]) => {
        sideEffects.fileCalls.push(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
});

vi.mock("@napi-rs/keyring", () => {
  sideEffects.nativeLoads += 1;
  return { AsyncEntry: class {} };
});

describe("default credential private root", () => {
  it("is a pure OS-home path independent of cwd and the store factory stays lazy", async () => {
    const core = await import("../../src/index.js");
    expect(sideEffects.fileCalls).toEqual([]);
    expect(sideEffects.nativeLoads).toBe(0);
    const publicApi = core as unknown as Record<string, unknown>;
    const helper = publicApi.defaultCredentialPrivateRoot;
    expect(helper).toBeTypeOf("function");

    const fileCallsBefore = sideEffects.fileCalls.length;
    const nativeLoadsBefore = sideEffects.nativeLoads;
    const defaultRoot = (helper as () => string)();
    expect(defaultRoot).toBe(join(homedir(), ".apicc", "private", "test-credentials", "v1"));

    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect((helper as () => string)()).toBe(defaultRoot);
    } finally {
      process.chdir(originalCwd);
    }

    core.createSystemSecretStore({ privateRoot: defaultRoot });
    expect(sideEffects.fileCalls.slice(fileCallsBefore)).toEqual([]);
    expect(sideEffects.nativeLoads).toBe(nativeLoadsBefore);
  });
});
