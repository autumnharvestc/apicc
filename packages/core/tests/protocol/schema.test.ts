import { describe, expect, it } from "vitest";
import { ApiRequestSchema } from "../../src/contract/model.js";

const common = {
  baseUrl: "https://example.test",
  path: "/orders",
  pathParams: [],
  query: [],
  headers: [],
  cookies: [],
  auth: { kind: "none" },
};

describe("strict contract protocol union", () => {
  it("rejects missing or unsupported protocol instead of defaulting to HTTP", () => {
    expect(() => ApiRequestSchema.parse({ ...common, method: "GET", body: { kind: "none" } })).toThrow(/protocol/);
    expect(() => ApiRequestSchema.parse({ ...common, protocol: "grpc", method: "GET" })).toThrow(/protocol/);
  });

  it("accepts WebSocket message requests without HTTP method/body and rejects HTTP-only fields", () => {
    const valid = ApiRequestSchema.parse({ protocol: "websocket", ...common, message: "hello" });
    expect(valid.protocol).toBe("websocket");
    expect(valid).toMatchObject({ message: "hello" });
    expect(valid).not.toHaveProperty("method");
    expect(valid).not.toHaveProperty("body");

    expect(() => ApiRequestSchema.parse({ protocol: "websocket", ...common, method: "GET" })).toThrow();
    expect(() => ApiRequestSchema.parse({ protocol: "websocket", ...common, body: { kind: "none" } })).toThrow();
  });

  it("requires SOAP POST plus an envelope and preserves optional SOAPAction", () => {
    expect(() => ApiRequestSchema.parse({ protocol: "soap", method: "POST", ...common })).toThrow(/envelope/);
    expect(() => ApiRequestSchema.parse({ protocol: "soap", method: "GET", ...common, envelope: "<Envelope/>" })).toThrow(/POST/);
    expect(() => ApiRequestSchema.parse({ protocol: "soap", ...common, envelope: "<Envelope/>" })).toThrow(/POST/);

    const valid = ApiRequestSchema.parse({
      protocol: "soap", method: "POST", ...common, envelope: "<Envelope/>", soapAction: "urn:DoIt",
    });
    expect(valid).toMatchObject({ protocol: "soap", method: "POST", envelope: "<Envelope/>", soapAction: "urn:DoIt" });
  });

  it("keeps HTTP method/body in the HTTP member only", () => {
    const valid = ApiRequestSchema.parse({ protocol: "http", method: "POST", ...common, body: { kind: "json", content: "{}" } });
    expect(valid).toMatchObject({ protocol: "http", method: "POST", body: { kind: "json", content: "{}" } });
  });
});
