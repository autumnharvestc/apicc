import { z } from "zod";

import { HttpMethodSchema, TestCaseSchema, type HttpMethod, type TestCase } from "../domain/common.js";
import { JsonValueSchema, SchemaNodeSchema, StringRecordSchema, type JsonValue, type SchemaNode } from "./schemaNode.js";

export { JsonValueSchema, SchemaNodeSchema } from "./schemaNode.js";
export type { JsonValue, SchemaAnnotations, SchemaNode } from "./schemaNode.js";
export type { HttpMethod };

export const ApiTestCaseSchema = TestCaseSchema;
export type ApiTestCase = TestCase;

const AssetIdSchema = z.string().uuid();

export interface SecretRef {
  id: string;
  policy: string;
}

export interface InlineParameter {
  kind: "inline";
  id: string;
  name: string;
  schema: SchemaNode;
  required: boolean;
  enabled: boolean;
  description: string;
  value?: string;
}

export interface ParameterReference {
  kind: "componentRef";
  id: string;
  componentId: string;
  expectedKind: "parameter";
  value?: string;
  enabled?: boolean;
}

export type ParameterBinding = InlineParameter | ParameterReference;

export type InlineAuthBinding =
  | { kind: "none" }
  | { kind: "bearer"; token: SecretRef }
  | { kind: "basic"; username: string; password: SecretRef }
  | { kind: "apikey"; name: string; placement: "header" | "query"; value: SecretRef };

export type AuthBinding = InlineAuthBinding | { kind: "componentRef"; componentId: string; expectedKind: "auth" };

export const SecretRefSchema: z.ZodType<SecretRef> = z.object({
  id: z.string(),
  policy: z.string(),
}).strict();

const noneAuthSchema = z.object({ kind: z.literal("none") }).strict();
const bearerAuthSchema = z.object({ kind: z.literal("bearer"), token: SecretRefSchema }).strict();
const basicAuthSchema = z.object({
  kind: z.literal("basic"),
  username: z.string(),
  password: SecretRefSchema,
}).strict();
const apiKeyAuthSchema = z.object({
  kind: z.literal("apikey"),
  name: z.string(),
  placement: z.enum(["header", "query"]),
  value: SecretRefSchema,
}).strict();
const authComponentReferenceSchema = z.object({
  kind: z.literal("componentRef"),
  componentId: AssetIdSchema,
  expectedKind: z.literal("auth"),
}).strict();

export const InlineAuthBindingSchema: z.ZodType<InlineAuthBinding> = z.discriminatedUnion("kind", [
  noneAuthSchema,
  bearerAuthSchema,
  basicAuthSchema,
  apiKeyAuthSchema,
]);

export const AuthBindingSchema: z.ZodType<AuthBinding> = z.discriminatedUnion("kind", [
  noneAuthSchema,
  bearerAuthSchema,
  basicAuthSchema,
  apiKeyAuthSchema,
  authComponentReferenceSchema,
]);

const inlineParameterSchema = z.object({
  kind: z.literal("inline"),
  id: AssetIdSchema,
  name: z.string(),
  schema: SchemaNodeSchema,
  required: z.boolean(),
  enabled: z.boolean(),
  description: z.string(),
  value: z.string().optional(),
}).strict();

const parameterReferenceSchema = z.object({
  kind: z.literal("componentRef"),
  id: AssetIdSchema,
  componentId: AssetIdSchema,
  expectedKind: z.literal("parameter"),
  value: z.string().optional(),
  enabled: z.boolean().optional(),
}).strict();

export const ParameterBindingSchema: z.ZodType<ParameterBinding> = z.discriminatedUnion("kind", [
  inlineParameterSchema,
  parameterReferenceSchema,
]);

const parameterListsShape = {
  pathParams: z.array(ParameterBindingSchema),
  query: z.array(ParameterBindingSchema),
  headers: z.array(ParameterBindingSchema),
  cookies: z.array(ParameterBindingSchema),
};

export interface LocalFileReference {
  path: string;
}

export type MultipartEntry =
  | { kind: "text"; id: string; name: string; value: string; enabled: boolean }
  | { kind: "file"; id: string; name: string; file: LocalFileReference; contentType?: string; enabled: boolean };

export type RequestBody =
  | { kind: "none" }
  | { kind: "json" | "xml" | "text"; content: string; schema?: SchemaNode }
  | { kind: "graphql"; query: string; variables?: string; operationName?: string }
  | { kind: "urlencoded"; fields: Array<{ id: string; name: string; value: string; enabled: boolean }> }
  | { kind: "multipart"; entries: MultipartEntry[] }
  | { kind: "binary"; file: LocalFileReference; contentType: string };

const LocalFileReferenceSchema: z.ZodType<LocalFileReference> = z.object({ path: z.string() }).strict();

const noBodySchema = z.object({ kind: z.literal("none") }).strict();
const templatedBodySchema = z.object({
  kind: z.enum(["json", "xml", "text"]),
  content: z.string(),
  schema: SchemaNodeSchema.optional(),
}).strict();
const graphqlBodySchema = z.object({
  kind: z.literal("graphql"),
  query: z.string(),
  variables: z.string().optional(),
  operationName: z.string().optional(),
}).strict();
const UrlEncodedFieldSchema = z.object({
  id: AssetIdSchema,
  name: z.string(),
  value: z.string(),
  enabled: z.boolean(),
}).strict();
const urlencodedBodySchema = z.object({
  kind: z.literal("urlencoded"),
  fields: z.array(UrlEncodedFieldSchema),
}).strict();
const multipartTextEntrySchema = z.object({
  kind: z.literal("text"),
  id: AssetIdSchema,
  name: z.string(),
  value: z.string(),
  enabled: z.boolean(),
}).strict();
const multipartFileEntrySchema = z.object({
  kind: z.literal("file"),
  id: AssetIdSchema,
  name: z.string(),
  file: LocalFileReferenceSchema,
  contentType: z.string().optional(),
  enabled: z.boolean(),
}).strict();
const multipartBodySchema = z.object({
  kind: z.literal("multipart"),
  entries: z.array(z.discriminatedUnion("kind", [multipartTextEntrySchema, multipartFileEntrySchema])),
}).strict();
const binaryBodySchema = z.object({
  kind: z.literal("binary"),
  file: LocalFileReferenceSchema,
  contentType: z.string(),
}).strict();

export const RequestBodySchema: z.ZodType<RequestBody> = z.discriminatedUnion("kind", [
  noBodySchema,
  templatedBodySchema,
  graphqlBodySchema,
  urlencodedBodySchema,
  multipartBodySchema,
  binaryBodySchema,
]);

export interface HttpRequest {
  protocol: "http";
  method: HttpMethod;
  baseUrl: string;
  path: string;
  pathParams: ParameterBinding[];
  query: ParameterBinding[];
  headers: ParameterBinding[];
  cookies: ParameterBinding[];
  auth: AuthBinding;
  body: RequestBody;
}

export interface WebSocketRequest {
  protocol: "websocket";
  baseUrl: string;
  path: string;
  pathParams: ParameterBinding[];
  query: ParameterBinding[];
  headers: ParameterBinding[];
  cookies: ParameterBinding[];
  auth: AuthBinding;
  message?: string;
}

export interface SoapRequest {
  protocol: "soap";
  method: "POST";
  baseUrl: string;
  path: string;
  pathParams: ParameterBinding[];
  query: ParameterBinding[];
  headers: ParameterBinding[];
  cookies: ParameterBinding[];
  auth: AuthBinding;
  envelope: string;
  soapAction?: string;
}

export type ApiRequest = HttpRequest | WebSocketRequest | SoapRequest;

const httpRequestSchema = z.object({
  protocol: z.literal("http"),
  method: HttpMethodSchema,
  baseUrl: z.string(),
  path: z.string(),
  ...parameterListsShape,
  auth: AuthBindingSchema.default({ kind: "none" }),
  body: RequestBodySchema.default({ kind: "none" }),
}).strict();

const websocketRequestSchema = z.object({
  protocol: z.literal("websocket"),
  baseUrl: z.string(),
  path: z.string(),
  ...parameterListsShape,
  auth: AuthBindingSchema.default({ kind: "none" }),
  message: z.string().optional(),
}).strict();

const soapRequestSchema = z.object({
  protocol: z.literal("soap"),
  method: z.literal("POST"),
  baseUrl: z.string(),
  path: z.string(),
  ...parameterListsShape,
  auth: AuthBindingSchema.default({ kind: "none" }),
  envelope: z.string(),
  soapAction: z.string().optional(),
}).strict();

export const ApiRequestSchema: z.ZodType<ApiRequest> = z.discriminatedUnion("protocol", [
  httpRequestSchema,
  websocketRequestSchema,
  soapRequestSchema,
]);

export type ApiLifecycleStatus = "draft" | "published" | "deprecated";

export interface ApiMetadata {
  name: string;
  description: string;
  tags: string[];
  version: string;
  status: ApiLifecycleStatus;
}

const metadataSchema: z.ZodType<ApiMetadata> = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  version: z.string(),
  status: z.enum(["draft", "published", "deprecated"]),
}).strict();

export type ResponseStatus = string;

export interface ExampleDefinition {
  name: string;
  value: JsonValue;
}

export interface InlineExampleBinding extends ExampleDefinition {
  kind: "inline";
  id: string;
}

export interface ExampleReference {
  kind: "componentRef";
  id: string;
  componentId: string;
  expectedKind: "example";
}

export type ExampleBinding = InlineExampleBinding | ExampleReference;

export interface ResponseContent {
  schema?: SchemaNode;
  examples: ExampleBinding[];
}

export interface ResponseDefinition {
  status: ResponseStatus;
  description: string;
  headers: Record<string, string>;
  content: Record<string, ResponseContent>;
}

export interface InlineResponse extends ResponseDefinition {
  kind: "inline";
  id: string;
}

export interface ResponseReference {
  kind: "componentRef";
  id: string;
  componentId: string;
  expectedKind: "response";
}

export type ResponseBinding = InlineResponse | ResponseReference;

const responseStatusSchema = z.string().regex(/^(?:[1-5][0-9]{2}|[1-5]XX|default)$/);
const exampleDefinitionShape = {
  name: z.string(),
  value: JsonValueSchema,
};
const exampleDefinitionSchema: z.ZodType<ExampleDefinition> = z.object(exampleDefinitionShape).strict();
const inlineExampleBindingSchema = z.object({
  kind: z.literal("inline"),
  id: AssetIdSchema,
  ...exampleDefinitionShape,
}).strict();
const exampleReferenceSchema = z.object({
  kind: z.literal("componentRef"),
  id: AssetIdSchema,
  componentId: AssetIdSchema,
  expectedKind: z.literal("example"),
}).strict();
export const ExampleBindingSchema: z.ZodType<ExampleBinding> = z.discriminatedUnion("kind", [
  inlineExampleBindingSchema,
  exampleReferenceSchema,
]);

const responseContentSchema: z.ZodType<ResponseContent> = z.object({
  schema: SchemaNodeSchema.optional(),
  examples: z.array(ExampleBindingSchema),
}).strict();

const responseDefinitionShape = {
  status: responseStatusSchema,
  description: z.string(),
  headers: StringRecordSchema(z.string()),
  content: StringRecordSchema(responseContentSchema),
};
export const ResponseDefinitionSchema: z.ZodType<ResponseDefinition> = z.object(responseDefinitionShape).strict();

const inlineResponseSchema = z.object({
  kind: z.literal("inline"),
  id: AssetIdSchema,
  ...responseDefinitionShape,
}).strict();
const responseReferenceSchema = z.object({
  kind: z.literal("componentRef"),
  id: AssetIdSchema,
  componentId: AssetIdSchema,
  expectedKind: z.literal("response"),
}).strict();

export const ResponseBindingSchema: z.ZodType<ResponseBinding> = z.discriminatedUnion("kind", [
  inlineResponseSchema,
  responseReferenceSchema,
]);

export interface ApiContract {
  formatVersion: 1;
  id: string;
  metadata: ApiMetadata;
  request: ApiRequest;
  responses: ResponseBinding[];
}

export const ApiContractSchema: z.ZodType<ApiContract> = z.object({
  formatVersion: z.literal(1),
  id: AssetIdSchema,
  metadata: metadataSchema,
  request: ApiRequestSchema,
  responses: z.array(ResponseBindingSchema),
}).strict();

export interface ApiAsset {
  contract: ApiContract;
  cases: ApiTestCase[];
  documentation: string;
}

export const ApiAssetSchema: z.ZodType<ApiAsset> = z.object({
  contract: ApiContractSchema,
  cases: z.array(ApiTestCaseSchema),
  documentation: z.string(),
}).strict();

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface ParameterComponentDefinition {
  location: ParameterLocation;
  name: string;
  schema: SchemaNode;
  required: boolean;
  description: string;
}

export interface ParameterComponentAsset {
  formatVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: "parameter";
  definition: ParameterComponentDefinition;
}

export interface AuthComponentAsset {
  formatVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: "auth";
  definition: InlineAuthBinding;
}

export interface ResponseComponentAsset {
  formatVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: "response";
  definition: ResponseDefinition;
}

export interface ExampleComponentAsset {
  formatVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: "example";
  definition: ExampleDefinition;
}

export type ComponentAsset = ParameterComponentAsset | AuthComponentAsset | ResponseComponentAsset | ExampleComponentAsset;

const componentMetadataShape = {
  formatVersion: z.literal(1),
  id: AssetIdSchema,
  name: z.string(),
  description: z.string(),
};

const parameterComponentSchema = z.object({
  ...componentMetadataShape,
  kind: z.literal("parameter"),
  definition: z.object({
    location: z.enum(["path", "query", "header", "cookie"]),
    name: z.string(),
    schema: SchemaNodeSchema,
    required: z.boolean(),
    description: z.string(),
  }).strict(),
}).strict();

const authComponentSchema = z.object({
  ...componentMetadataShape,
  kind: z.literal("auth"),
  definition: InlineAuthBindingSchema,
}).strict();

const responseComponentSchema = z.object({
  ...componentMetadataShape,
  kind: z.literal("response"),
  definition: ResponseDefinitionSchema,
}).strict();

const exampleComponentSchema = z.object({
  ...componentMetadataShape,
  kind: z.literal("example"),
  definition: exampleDefinitionSchema,
}).strict();

export const ComponentAssetSchema: z.ZodType<ComponentAsset> = z.discriminatedUnion("kind", [
  parameterComponentSchema,
  authComponentSchema,
  responseComponentSchema,
  exampleComponentSchema,
]);

export interface ModelAsset {
  formatVersion: 1;
  id: string;
  name: string;
  description: string;
  schema: SchemaNode;
}

export const ModelAssetSchema: z.ZodType<ModelAsset> = z.object({
  formatVersion: z.literal(1),
  id: AssetIdSchema,
  name: z.string(),
  description: z.string(),
  schema: SchemaNodeSchema,
}).strict();
