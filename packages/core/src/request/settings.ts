import { z } from "zod";

const positiveInteger = z.number().finite().int().positive();

export const RequestSettingsSchema = z.object({
  connectTimeoutMs: positiveInteger,
  headersTimeoutMs: positiveInteger,
  bodyTimeoutMs: positiveInteger,
  totalTimeoutMs: positiveInteger,
  followRedirects: z.boolean(),
  maxRedirects: z.number().finite().int().min(0).max(10),
  uploadLimitBytes: positiveInteger.max(1024 * 1024 * 1024),
  responseLimitBytes: positiveInteger.max(128 * 1024 * 1024),
}).strict();

export type RequestSettings = z.output<typeof RequestSettingsSchema>;

export const RequestSettingsOverrideSchema = RequestSettingsSchema.partial().strict();
export type RequestSettingsOverride = z.output<typeof RequestSettingsOverrideSchema>;

const HTTP_ONLY_SETTINGS = [
  "headersTimeoutMs",
  "bodyTimeoutMs",
  "followRedirects",
  "maxRedirects",
  "uploadLimitBytes",
  "responseLimitBytes",
] as const satisfies readonly (keyof RequestSettings)[];

export function assertRequestSettingsApplicable(protocol: "http" | "websocket" | "soap", ...overrides: readonly RequestSettingsOverride[]): void {
  if (protocol === "http") return;
  for (const override of overrides) {
    const invalidField = HTTP_ONLY_SETTINGS.find((field) => Object.hasOwn(override, field));
    if (invalidField) throw new TypeError(`${invalidField} is only supported for HTTP requests.`);
  }
}

export function resolveRequestSettings(
  caseOverride: RequestSettingsOverride = {},
  invocationOverride: RequestSettingsOverride = {},
  entryDefaults: RequestSettingsOverride = {},
): RequestSettings {
  return RequestSettingsSchema.parse({
    connectTimeoutMs: 10_000,
    headersTimeoutMs: 30_000,
    bodyTimeoutMs: 30_000,
    totalTimeoutMs: 30_000,
    followRedirects: false,
    maxRedirects: 10,
    uploadLimitBytes: 64 * 1024 * 1024,
    responseLimitBytes: 32 * 1024 * 1024,
    ...RequestSettingsOverrideSchema.parse(entryDefaults),
    ...RequestSettingsOverrideSchema.parse(caseOverride),
    ...RequestSettingsOverrideSchema.parse(invocationOverride),
  });
}
