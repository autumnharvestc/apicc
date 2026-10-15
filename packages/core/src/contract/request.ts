import { z } from "zod";

import { HttpMethodSchema, type HttpMethod } from "../domain/primitives.js";
import { SchemaNodeSchema, type SchemaNode } from "./schemaNode.js";

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
  | { kind: "file"; id: string; name: string; file: LocalFileReference; filename?: string; contentType?: string; enabled: boolean };

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
  filename: z.string().optional(),
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

export type { HttpMethod } from "../domain/primitives.js";
