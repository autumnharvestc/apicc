import { z } from "zod";

import { WorkflowSchema } from "../workflow/model.js";

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

/** 协议枚举（M5 D2）：http 为缺省值，websocket/soap 由对应 ProtocolClient 承接（D5）。 */
export const ProtocolSchema = z.enum(["http", "websocket", "soap"]);
export type Protocol = z.infer<typeof ProtocolSchema>;

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

/** 前置/后置操作（M10）：有序列表，脚本为第一版操作类型（后续可扩展延时/数据库等）。 */
export const OperationSchema = z.object({
  id: z.string(),
  type: z.literal("script"),
  content: z.string().default(""),
}).strict();
export type Operation = z.infer<typeof OperationSchema>;

/** 操作列表字段（读兼容旧「脚本」字段的归一在 fileStorage load 侧完成，schema 不收旧字段）。 */
export const OperationListSchema = z.array(OperationSchema).default([]);

/** scope 为字符串 "base" 或环境名（引用 Environment.name）。 */
export const TestCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string().default("base"),
  parameters: z.record(z.string(), z.string()).default({}),
  dataDriver: DataDriverSchema.optional(),
  // M10：前置/后置操作（读兼容——preScript/postScript 仍可选保留，load 归一后写新形态）
  preScript: z.string().optional(),
  postScript: z.string().optional(),
  preOperations: OperationListSchema.default([]),
  postOperations: OperationListSchema.default([]),
  assertions: z.array(AssertionSchema).default([]),
}).strict();
type TestCaseParsed = z.infer<typeof TestCaseSchema>;
export type TestCase = Omit<TestCaseParsed, "preOperations" | "postOperations"> & {
  preOperations?: Operation[];
  postOperations?: Operation[];
};

export const ApiDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().default("1.0.0"),
  deprecated: z.boolean().default(false),
  // 缺省 GET（M5 D2/裁定④）：websocket 不参与执行可省略 method；旧 yaml 显式 method 完全不受影响。
  method: HttpMethodSchema.default("GET"),
  url: z.string(),
  headers: z.array(KeyValuePairSchema).default([]),
  query: z.array(KeyValuePairSchema).default([]),
  body: BodySchema.optional(),
  auth: AuthSpecSchema.optional(),
  design: z.string().optional(),
  cases: z.array(TestCaseSchema).default([]),
  // —— M5 多协议演进（D2）：旧 yaml 无以下字段 → 完全不变（protocol 缺省 http，零破坏）——
  protocol: ProtocolSchema.default("http"),
  /** websocket：连接后发送的文本帧模板（变量经既有解析管线，D7）；缺省仅连接。 */
  message: z.string().optional(),
  /** soap：必填 XML 信封模板（superRefine 强制）。 */
  envelope: z.string().optional(),
  /** soap：可选，映射 SOAPAction 头。 */
  soapAction: z.string().optional(),
})
.strict()
.superRefine((api, ctx) => {
  if (api.protocol !== "soap") return;
  if (api.envelope === undefined) {
    ctx.addIssue({ code: "custom", path: ["envelope"], message: "soap 接口必须提供 envelope（XML 信封模板）" });
  }
  if (api.method !== "POST") {
    ctx.addIssue({ code: "custom", path: ["method"], message: "soap 接口 method 必须显式为 POST" });
  }
});

// —— M5 类型兼容层（D2 + 零破坏红线）——
// 运行时不变量：parse 输出恒有 protocol（default("http")）。但既有手写字面量（测试夹具/调用方，
// 多数嵌套在 Workspace/Project/… 内）不允许被迫补 protocol。导出类型在 zod 推导之上把嵌套接口的
// protocol 放宽为可选：strict 解析结果仍可赋值给这些类型，手写字面量免补字段（旧调用方零改动）。
/** parse 后的完整接口形状（protocol 恒有值），供需要全量形状的调用方使用。 */
export type ApiDefinitionParsed = z.infer<typeof ApiDefinitionSchema>;
type LooseApi = Omit<ApiDefinitionParsed, "protocol" | "cases"> & { protocol?: Protocol; cases: TestCase[] };
export type ApiDefinition = LooseApi;

export interface Folder {
  id: string;
  name: string;
  apis: LooseApi[];
  folders?: Folder[];
  preOperations?: Operation[];
  postOperations?: Operation[];
}
type CollectionParsed = z.infer<typeof CollectionSchema>;
export interface Collection extends Omit<CollectionParsed, "apis" | "folders" | "preOperations" | "postOperations"> {
  apis: LooseApi[];
  folders: Folder[];
  preOperations?: Operation[];
  postOperations?: Operation[];
}
type ProjectParsed = z.infer<typeof ProjectSchema>;
export interface Project extends Omit<ProjectParsed, "collections" | "globals"> {
  collections: Collection[];
  globals?: ProjectGlobals;
}
type GroupParsed = z.infer<typeof GroupSchema>;
export interface Group extends Omit<GroupParsed, "projects" | "default"> {
  projects: Project[];
  default?: boolean;
}
type WorkspaceParsed = z.infer<typeof WorkspaceSchema>;
export type Workspace = Omit<WorkspaceParsed, "groups"> & { groups: Group[] };

export const FolderSchema: z.ZodType<Folder> = z.object({
  id: z.string(),
  name: z.string(),
  apis: z.array(ApiDefinitionSchema).default([]),
  // M10：文件夹可嵌套且任意层级可挂前置/后置操作（无变量）。自引用经 z.lazy（显式注解破循环推导）。
  folders: z.lazy(() => z.array(FolderSchema)).default([]),
  preOperations: OperationListSchema.default([]),
  postOperations: OperationListSchema.default([]),
}).strict();

// 模块（M10 更名：UI 术语「模块」，存储 kind/字段名保持 collection 兼容）= 项目内一个服务。
export const CollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  // 读兼容（M10）：旧 scripts 字段仍可解析（load 侧归一为操作），新写入只写 operations。
  scripts: z.object({ pre: z.string().optional(), post: z.string().optional() }).strict().optional(),
  preOperations: OperationListSchema.default([]),
  postOperations: OperationListSchema.default([]),
  folders: z.array(FolderSchema).default([]),
  apis: z.array(ApiDefinitionSchema).default([]),
}).strict();

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  extends: z.string().optional(),
  variables: z.record(z.string(), z.string()).default({}),
  // 前置 URL（M9-B）：按集合设置——key = collectionId，value = 该集合在此环境下的前置 URL。
  // 运行时注入为内置变量 baseUrl（{{baseUrl}} 模板可用）并对相对 URL 自动拼接。
  baseUrls: z.record(z.string(), z.string()).default({}),
}).strict();
export type Environment = z.infer<typeof EnvironmentSchema>;

// 项目级全局参数（M10，四类）：归属项目。全局变量即 project.variables（UI 名「全局变量」），不在此处。
// body 仅对 form-data / x-www-form-urlencoded 请求合并；cookies 序列化为 Cookie 头（接口自有 Cookie 整头优先）。
export const ProjectGlobalsSchema = z.object({
  query: z.array(KeyValuePairSchema).default([]),
  headers: z.array(KeyValuePairSchema).default([]),
  cookies: z.array(KeyValuePairSchema).default([]),
  body: z.array(KeyValuePairSchema).default([]),
}).strict();
export type ProjectGlobalsParsed = z.infer<typeof ProjectGlobalsSchema>;
export type ProjectGlobals = ProjectGlobalsParsed;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  globals: ProjectGlobalsSchema.default({ query: [], headers: [], cookies: [], body: [] }),
  environments: z.array(EnvironmentSchema).default([]),
  collections: z.array(CollectionSchema).default([]),
  workflows: z.array(WorkflowSchema).default([]),
}).strict();

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  // 默认分组标记（M10）：持久化识别（不靠名字）；默认分组不可删除不可改名。
  default: z.boolean().optional(),
  projects: z.array(ProjectSchema).default([]),
}).strict();

// 【弃用（M10）】工作区级 globals 已被 Project.globals 取代：字段仅为旧文件 strict 解析兼容
// 而保留，运行器与 UI 不再读写。
export const WorkspaceGlobalsSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
  query: z.array(KeyValuePairSchema).default([]),
  headers: z.array(KeyValuePairSchema).default([]),
}).strict();
export type WorkspaceGlobals = z.infer<typeof WorkspaceGlobalsSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  globals: WorkspaceGlobalsSchema.default({ variables: {}, query: [], headers: [] }),
  groups: z.array(GroupSchema).default([]),
}).strict();
