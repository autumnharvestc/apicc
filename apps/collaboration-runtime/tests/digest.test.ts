import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { digestJson } from "../src/protocol.js";
import { readFile } from "node:fs/promises";

// Independently hand-encoded wire vectors: tags 00null/01false/02true/03f64BE/
// 04UTF16BE(length=codeunits,u32BE)/05array(count,u32BE)/06object(count,u32BE).
// Object keys are encoded strings in UTF16 lexical order; -0 becomes +0.
const vectors: [string,string][] = JSON.parse(await readFile(new URL("../../../server/src/test/resources/collaboration-digest-vectors.json", import.meta.url), "utf8"));
it.each(vectors)("hashes sha256-json-tree-v1 known vector %s", (text, bytes) => {
  expect(digestJson(JSON.parse(text))).toBe(createHash("sha256").update(Buffer.from(bytes, "hex")).digest("hex"));
});
it("preserves array order and JSON type distinctions", () => {
  expect.soft(digestJson([1,2])).not.toBe(digestJson([2,1]));
  expect.soft(digestJson(1)).not.toBe(digestJson("1"));
  expect(digestJson(null)).not.toBe(digestJson(false));
});
it.each([NaN, Infinity, -Infinity, undefined])("rejects non-JSON digest value %s", value => {
  expect(() => digestJson(value)).toThrow("RPC_JSON_INVALID");
});
