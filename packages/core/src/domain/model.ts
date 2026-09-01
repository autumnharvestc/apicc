import { z } from "zod";

// 所有域对象 schema 均为 strict：拒绝未知字段（而非静默丢弃），
// 避免「解析→保存」链路上的静默数据丢失，并尽早暴露文件格式错误。
// 该行为由 tests/domain/model.test.ts 的「拒绝未知字段」用例约定。

export type ID = string;

export const KeyValuePairSchema = z.object({
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
}).strict();
export type KeyValuePair = z.infer<typeof KeyValuePairSchema>;

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const BodySchema = z.object({
  kind: z.enum(["json", "xml", "raw", "graphql", "form"]),
  content: z.string().default(""),
  form: z.array(KeyValuePairSchema).optional(),
}).strict();
export type BodyContent = z.infer<typeof BodySchema>;

export const AuthSpecSchema = z.object({
  type: z.enum(["bearer", "basic", "apikey"]),
  token: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  placement: z.enum(["header", "query"]).default("header"),
}).strict();
export type AuthSpec = z.infer<typeof AuthSpecSchema>;

export const AssertionSchema = z.object({
  id: z.string(),
  target: z.enum(["status", "header", "bodyJson", "responseTime"]),
  op: z.enum(["eq", "neq", "contains", "lt", "gt", "lte", "gte"]),
  expected: z.string().optional(),
  headerName: z.string().optional(),
  path: z.string().optional(),
}).strict();
export type Assertion = z.infer<typeof AssertionSchema>;

export const DataDriverSchema = z.object({
  sourcePath: z.string(),
  format: z.enum(["csv", "json"]),
}).strict();
export type DataDriver = z.infer<typeof DataDriverSchema>;

/** scope 为字符串 "base" 或环境名（引用 Environment.name）。 */
export const TestCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string().default("base"),
  parameters: z.record(z.string(), z.string()).default({}),
  dataDriver: DataDriverSchema.optional(),
  preScript: z.string().optional(),
  postScript: z.string().optional(),
  assertions: z.array(AssertionSchema).default([]),
}).strict();
export type TestCase = z.infer<typeof TestCaseSchema>;

export const ApiDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().default("1.0.0"),
  deprecated: z.boolean().default(false),
  method: HttpMethodSchema,
  url: z.string(),
  headers: z.array(KeyValuePairSchema).default([]),
  query: z.array(KeyValuePairSchema).default([]),
  body: BodySchema.optional(),
  auth: AuthSpecSchema.optional(),
  design: z.string().optional(),
  cases: z.array(TestCaseSchema).default([]),
}).strict();
export type ApiDefinition = z.infer<typeof ApiDefinitionSchema>;

export const FolderSchema = z.object({ id: z.string(), name: z.string(), apis: z.array(ApiDefinitionSchema).default([]) }).strict();
export type Folder = z.infer<typeof FolderSchema>;

export const CollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  scripts: z.object({ pre: z.string().optional(), post: z.string().optional() }).strict().optional(),
  folders: z.array(FolderSchema).default([]),
  apis: z.array(ApiDefinitionSchema).default([]),
}).strict();
export type Collection = z.infer<typeof CollectionSchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  extends: z.string().optional(),
  variables: z.record(z.string(), z.string()).default({}),
}).strict();
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  environments: z.array(EnvironmentSchema).default([]),
  collections: z.array(CollectionSchema).default([]),
}).strict();
export type Project = z.infer<typeof ProjectSchema>;

export const GroupSchema = z.object({ id: z.string(), name: z.string(), projects: z.array(ProjectSchema).default([]) }).strict();
export type Group = z.infer<typeof GroupSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  groups: z.array(GroupSchema).default([]),
}).strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;
