import { z } from "zod";

const AssetIdSchema = z.string().uuid();
const ConditionValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const ParameterConditionSchema = z.union([
  z.object({ source: z.enum(["path", "query", "header"]), op: z.literal("exists"), name: z.string().min(1) }).strict(),
  z.object({ source: z.enum(["path", "query", "header"]), op: z.literal("equals"), name: z.string().min(1), value: z.string() }).strict(),
]);

const BodyConditionSchema = z.union([
  z.object({ source: z.literal("body"), op: z.literal("exists"), pointer: z.string() }).strict(),
  z.object({ source: z.literal("body"), op: z.literal("equals"), pointer: z.string(), value: ConditionValueSchema }).strict(),
]);

export const MockConditionSchema = z.union([ParameterConditionSchema, BodyConditionSchema]);
export type MockCondition = z.infer<typeof MockConditionSchema>;

export const MockResponseSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("example"), exampleBindingId: AssetIdSchema }).strict(),
  z.object({ kind: z.literal("schema") }).strict(),
  z.object({ kind: z.literal("literal"), text: z.string() }).strict(),
]);
export type MockResponseSource = z.infer<typeof MockResponseSourceSchema>;

export const MockRuleSchema = z.object({
  id: AssetIdSchema,
  enabled: z.boolean(),
  contractId: AssetIdSchema,
  conditions: z.array(MockConditionSchema).max(32),
  responseBindingId: AssetIdSchema,
  status: z.number().int().min(100).max(599).optional(),
  mediaType: z.string().min(1),
  source: MockResponseSourceSchema,
  delayMs: z.number().int().min(0).max(30_000),
}).strict();
export type MockRule = z.infer<typeof MockRuleSchema>;

export const MockProjectConfigSchema = z.object({
  formatVersion: z.literal(1),
  seed: z.string().min(1),
  enabledContractIds: z.array(AssetIdSchema),
  rules: z.array(MockRuleSchema).max(256),
}).strict().superRefine((config, context) => {
  const contracts = new Set<string>();
  config.enabledContractIds.forEach((id, index) => {
    if (contracts.has(id)) context.addIssue({ code: "custom", path: ["enabledContractIds", index], message: "Enabled contract IDs must be unique." });
    contracts.add(id);
  });

  const ruleIds = new Set<string>();
  config.rules.forEach((rule, index) => {
    if (ruleIds.has(rule.id)) context.addIssue({ code: "custom", path: ["rules", index, "id"], message: "Mock rule IDs must be unique." });
    ruleIds.add(rule.id);
  });
});
export type MockProjectConfig = z.infer<typeof MockProjectConfigSchema>;

export type MockDiagnostic = {
  severity: "warning" | "error";
  code: string;
  path: string;
  message: string;
  lossy: boolean;
  ownerId?: string;
};
