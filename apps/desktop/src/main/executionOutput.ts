import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CollectionRunError, CredentialError, StressSafetyError, createCredentialOutputSanitizer } from "@apicc/core";

const credentialMessages: Record<CredentialError["code"], string> = {
  CREDENTIAL_MISSING: "Credential is not available.",
  CREDENTIAL_UNAVAILABLE: "Credential store is unavailable.",
  CREDENTIAL_FORMAT_UNSUPPORTED: "Credential format is not supported.",
  CREDENTIAL_POLICY_UNSUPPORTED: "Credential policy is not supported.",
  CREDENTIAL_READ_FAILED: "Credential could not be read.",
  CREDENTIAL_SAVE_FAILED: "Credential could not be saved.",
  CREDENTIAL_REMOVE_FAILED: "Credential could not be removed.",
  CREDENTIAL_VERSION_CONFLICT: "Credential changed while it was being prepared.",
};

interface ErrorDetails {
  name: string;
  message: string;
  code?: string;
  targetOrigin?: string;
  failureKind?: string;
  partialResult?: unknown;
}

export interface ExecutionOutputBoundary {
  value<T>(value: T): T;
  text(value: string): string;
  error(value: unknown): Error;
}

export interface PersistedExecution<T> { value: T; warning?: string }

/** Project host execution data to a detached, cloneable DTO before it crosses IPC or reaches disk. */
export function createExecutionOutputBoundary(markers: readonly string[]): ExecutionOutputBoundary {
  const sanitizer = createCredentialOutputSanitizer(markers);
  return {
    value<T>(value: T): T {
      return sanitizer.redactValue(toPlainData(value, new WeakMap<object, unknown>())) as T;
    },
    text(value: string): string {
      return sanitizer.redactText(value);
    },
    error(value: unknown): Error {
      const details = errorDetails(value);
      const projected = sanitizer.redactValue(toPlainData(details, new WeakMap<object, unknown>())) as ErrorDetails;
      const error = new Error(projected.message);
      error.name = projected.name;
      error.stack = "";
      if (projected.code !== undefined) define(error, "code", projected.code);
      if (projected.targetOrigin !== undefined) define(error, "targetOrigin", projected.targetOrigin);
      if (projected.failureKind !== undefined) define(error, "failureKind", projected.failureKind);
      if (projected.partialResult !== undefined) define(error, "partialResult", projected.partialResult);
      return error;
    },
  };
}

/** Persist only the already detached and sanitized DTO; return the same safe value for IPC/history. */
export function persistExecutionJson<T>(
  path: string,
  value: T,
  boundary: ExecutionOutputBoundary,
  failureMessage: (error: unknown) => string,
  write: (path: string, content: string) => void = (target, content) => writeFileSync(target, content, { encoding: "utf8", flag: "wx" }),
): PersistedExecution<T> {
  const safeValue = boundary.value(value);
  try {
    mkdirSync(dirname(path), { recursive: true });
    write(path, JSON.stringify(safeValue, null, 2));
    return { value: safeValue };
  } catch (error) {
    const warning = boundary.text(failureMessage(error));
    console.warn(warning);
    return { value: safeValue, warning };
  }
}

function errorDetails(value: unknown): ErrorDetails {
  if (value instanceof CredentialError) {
    return { name: "CredentialError", message: credentialMessages[value.code], code: value.code };
  }
  if (value instanceof StressSafetyError) {
    return {
      name: "StressSafetyError",
      message: value.message,
      code: value.code,
      ...(value.targetOrigin ? { targetOrigin: value.targetOrigin } : {}),
    };
  }
  if (value instanceof CollectionRunError) {
    return {
      name: "CollectionRunError",
      message: value.message,
      failureKind: value.failureKind,
      partialResult: value.partialResult,
    };
  }
  return { name: "Error", message: value instanceof Error ? value.message : String(value) };
}

function toPlainData(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "undefined") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(toPlainData(item, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, nested] of Object.entries(value)) {
    const projected = toPlainData(nested, seen);
    if (projected !== undefined) Object.defineProperty(result, key, { value: projected, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
