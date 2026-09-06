import { describe, expect, it } from "vitest";
import { sanitizeNodeName } from "../../src/storage/sanitize.js";

describe("sanitizeNodeName（M9-A2）", () => {
  it("替换文件系统非法字符为 -（含 Windows 与控制符）", () => {
    expect(sanitizeNodeName("http://localhost:8080/api/health")).toBe("http---localhost-8080-api-health");
    expect(sanitizeNodeName('a*b<c>d?e"f|g')).toBe("a-b-c-d-e-f-g");
    expect(sanitizeNodeName("back\\slash")).toBe("back-slash");
    expect(sanitizeNodeName("ctl\u0001name")).toBe("ctl-name");
  });

  it("去首尾空白与结尾点；空/全非法结果回退「未命名」", () => {
    expect(sanitizeNodeName("  dir. . ")).toBe("dir");
    expect(sanitizeNodeName("   ")).toBe("未命名");
    expect(sanitizeNodeName("///")).toBe("---"); // 全非法字符 → 全连字符（合法目录名，不回退）
  });

  it("限长 80；Windows 保留设备名加前缀", () => {
    const long = "x".repeat(120);
    expect(sanitizeNodeName(long).length).toBe(80);
    expect(sanitizeNodeName("CON")).toBe("_CON");
    expect(sanitizeNodeName("com1")).toBe("_com1");
    expect(sanitizeNodeName("console")).toBe("console"); // 前缀仅精确保留名
  });
});
