import { z } from "zod";

export type ID = string;

export const KeyValuePairSchema = z.object({
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
}).strict();
export type KeyValuePair = z.output<typeof KeyValuePairSchema>;

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.output<typeof HttpMethodSchema>;

export const ProtocolSchema = z.enum(["http", "websocket", "soap"]);
export type Protocol = z.output<typeof ProtocolSchema>;
