import { z } from "zod";
import { isAbsolute, join, resolve } from "node:path";
import { CredentialError, type CredentialScope } from "./types.js";

const scopeUuidSchema = z.string().uuid();
const generationUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF_PATH_CHUNK_LENGTH = 96;
const SCOPE_IDENTITY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789!#$%&'()+,-;=@[]^_`{}~";
const UPPERCASE_REF_SYMBOLS = "!#$%&'()+,;=@[]^_`{}";
const UPPERCASE_UUID_REF_SYMBOLS = "!#$%&'";
const REF_ESCAPE_MARKER = "~";

function isScopeUuid(value: unknown): value is string {
  return typeof value === "string" && scopeUuidSchema.safeParse(value).success;
}

function validateScope(scope: CredentialScope, refId: string): void {
  if (typeof scope !== "object" || scope === null
    || !isScopeUuid(scope.workspaceId)
    || !isScopeUuid(scope.groupId)
    || !isScopeUuid(scope.projectId)) {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
}

export function isCredentialGeneration(value: unknown): value is string {
  return typeof value === "string" && generationUuidPattern.test(value);
}

function encodeRefIdentity(refId: string): string {
  if (scopeUuidSchema.safeParse(refId).success) {
    let encodedUuid = "u";
    for (const codeUnit of refId) {
      const uppercaseHexIndex = "ABCDEF".indexOf(codeUnit);
      encodedUuid += uppercaseHexIndex >= 0
        ? UPPERCASE_UUID_REF_SYMBOLS[uppercaseHexIndex]!
        : codeUnit;
    }
    return encodedUuid;
  }

  // Lowercase ASCII letters, digits, and hyphens use one path character.
  // Uppercase A-T use punctuation tokens; every other UTF-16 code unit is
  // escaped with a reserved marker plus a fixed three-digit base58 value.
  // This is injective, case-fold-safe, and preserves lone surrogates exactly.
  let encoded = "r";
  for (let index = 0; index < refId.length; index += 1) {
    const codeUnit = refId.charCodeAt(index);
    const character = String.fromCharCode(codeUnit);
    if ((codeUnit >= 0x61 && codeUnit <= 0x7a)
      || (codeUnit >= 0x30 && codeUnit <= 0x39)
      || character === "-") {
      encoded += character;
      continue;
    }

    const uppercaseIndex = "ABCDEFGHIJKLMNOPQRST".indexOf(character);
    if (uppercaseIndex >= 0) {
      encoded += UPPERCASE_REF_SYMBOLS[uppercaseIndex]!;
      continue;
    }

    let remaining = codeUnit;
    let escaped = "";
    do {
      escaped = `${SCOPE_IDENTITY_ALPHABET[remaining % SCOPE_IDENTITY_ALPHABET.length]!}${escaped}`;
      remaining = Math.floor(remaining / SCOPE_IDENTITY_ALPHABET.length);
    } while (remaining > 0);
    encoded += `${REF_ESCAPE_MARKER}${escaped.padStart(3, SCOPE_IDENTITY_ALPHABET[0]!)}`;
  }
  return encoded;
}

function refPathSegments(refId: string): string[] {
  const encoded = encodeRefIdentity(refId);
  const encodedUnits = encoded.slice(1);
  if (encodedUnits.length <= REF_PATH_CHUNK_LENGTH) return [`${encoded}.json`];

  const segments: string[] = ["ref"];
  // Fixed boundaries keep each component short; concatenating all chunks
  // reconstructs the complete identity without truncation.
  for (let offset = 0; offset < encodedUnits.length; offset += REF_PATH_CHUNK_LENGTH) {
    const chunk = encodedUnits.slice(offset, offset + REF_PATH_CHUNK_LENGTH);
    segments.push(offset === 0 ? `r${chunk}` : chunk);
  }
  return [...segments, "index.json"];
}

function encodeScopeIdentity(value: string): string {
  // Each original UUID hex character maps to a 5-bit value: 0-9 and a-f
  // retain values 0-15, while A-F use 16-21. Pack the exact text (minus its
  // fixed hyphens), then encode it in a path-safe alphabet with no case pairs.
  // 28 digits cover the full 160-bit domain and remain distinct on Windows.
  let packedIdentity = 0n;
  for (const hexDigit of value.replaceAll("-", "")) {
    const digitValue = Number.parseInt(hexDigit, 16);
    const uppercase = hexDigit >= "A" && hexDigit <= "F";
    packedIdentity = (packedIdentity << 5n) | BigInt(digitValue + (uppercase ? 6 : 0));
  }

  const radix = BigInt(SCOPE_IDENTITY_ALPHABET.length);
  let encoded = "";
  while (packedIdentity > 0n) {
    const remainder = Number(packedIdentity % radix);
    encoded = `${SCOPE_IDENTITY_ALPHABET[remainder]!}${encoded}`;
    packedIdentity /= radix;
  }
  return encoded.padStart(28, SCOPE_IDENTITY_ALPHABET[0]!);
}

export function credentialIndexPath(
  privateRoot: string,
  scope: CredentialScope,
  refId: string,
): string {
  if (typeof privateRoot !== "string" || !isAbsolute(privateRoot)
    || typeof refId !== "string") {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", typeof refId === "string" ? refId : "");
  }
  validateScope(scope, refId);

  return join(
    resolve(privateRoot),
    "apicc",
    "credentials-v2",
    `${encodeScopeIdentity(scope.workspaceId)}${encodeScopeIdentity(scope.groupId)}${encodeScopeIdentity(scope.projectId)}`,
    ...refPathSegments(refId),
  );
}

export function credentialEntryAddress(
  scope: CredentialScope,
  refId: string,
  generation: string,
): [service: string, account: string] {
  if (typeof refId !== "string" || !isCredentialGeneration(generation)) {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", typeof refId === "string" ? refId : "");
  }
  validateScope(scope, refId);

  const service = `apicc:credentials:v2:${encodeScopeIdentity(scope.workspaceId)}:${encodeScopeIdentity(scope.groupId)}:${encodeScopeIdentity(scope.projectId)}`;
  const account = `ref:${encodeRefIdentity(refId)}:generation:${generation}`;
  return [service, account];
}
