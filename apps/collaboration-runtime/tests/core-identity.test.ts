import { expect, it, vi } from "vitest";
import { coreBuildIdentity } from "../src/core-identity.js";

const readFile = vi.hoisted(() => vi.fn<(path: string) => Promise<Buffer>>());
vi.mock("node:fs/promises", () => ({
  readFile,
  readdir: async () => [{ name: "fixture.js", isDirectory: () => false, isFile: () => true }],
}));

it("rejects CRLF when producing a Java boundary while runtime identity still hashes actual bytes", async () => {
  readFile.mockResolvedValue(Buffer.from("export const value = `one\ntwo`;\n"));
  const canonical = await coreBuildIdentity({ requireLf: true });
  expect(await coreBuildIdentity()).toBe(canonical);

  readFile.mockResolvedValue(Buffer.from("export const value = `one\r\ntwo`;\n"));
  await expect(coreBuildIdentity({ requireLf: true })).rejects.toThrow(/CRLF.*fixture\.js/);
  expect(await coreBuildIdentity()).not.toBe(canonical);
});
