import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

describe("smoke", () => {
  it("exports version", () => {
    expect(version).toBe("0.1.0");
  });
});
