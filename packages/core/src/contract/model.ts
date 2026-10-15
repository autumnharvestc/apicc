import { z } from "zod";

import { TestCaseSchema, type TestCase } from "../domain/common.js";
import { JsonValueSchema, SchemaNodeSchema, StringRecordSchema, type JsonValue, type SchemaNode } from "./schemaNode.js";
import {
  ApiRequestSchema,
  InlineAuthBindingSchema,
  type ApiRequest,
  type InlineAuthBinding,
} from "./request.js";
import { assertRequestSettingsApplicable } from "../request/settings.js";

export { JsonValueSchema, SchemaNodeSchema } from "./schemaNode.js";
export type { JsonValue, SchemaAnnotations, SchemaNode } from "./schemaNode.js";
export {
  ApiRequestSchema,
  AuthBindingSchema,
  InlineAuthBindingSchema,
  ParameterBindingSchema,
  RequestBodySchema,
  SecretRefSchema,
} from "./request.js";
export type {
  ApiRequest,
  AuthBinding,
  HttpRequest,
  HttpMethod,
  InlineAuthBinding,
  InlineParameter,
  LocalFileReference,
  MultipartEntry,
  ParameterBinding,
  ParameterReference,
  RequestBody,
  SecretRef,
  SoapRequest,
  WebSocketRequest,
} from "./request.js";

export const ApiTestCaseSchema = TestCaseSchema;
export type ApiTestCase = TestCase;

const AssetIdSchema = z.string().uuid();

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
}).strict().superRefine((asset, ctx) => {
  asset.cases.forEach((testCase, index) => {
    const request = testCase.requestOverride ?? asset.contract.request;
    if (request.protocol !== asset.contract.request.protocol) {
      ctx.addIssue({
        code: "custom",
        path: ["cases", index, "requestOverride"],
        message: `Case scope "${testCase.scope}" must keep the API protocol.`,
      });
    }
    try {
      assertRequestSettingsApplicable(request.protocol, testCase.requestSettingsOverride ?? {});
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["cases", index, "requestSettingsOverride"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

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
