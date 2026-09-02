import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlReporter } from "../../src/report/html.js";
import { junitReporter } from "../../src/report/junit.js";
import type { RunResult } from "../../src/report/types.js";
import { itCompliesWithReporterContract } from "../contracts/reporter.contract.js";

const sample: RunResult = {
  collectionId: "c1", collectionName: "order-api", envName: "dev",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 2, passed: 1, failed: 1,
  cases: [
    { apiId: "a1", apiName: "get-ok", caseId: "t1", caseName: "ok", passed: true, durationMs: 12, assertions: [{ pass: true, message: "eq 通过" }] },
    { apiId: "a1", apiName: "get-ok", caseId: "t2", caseName: "bad", passed: false, durationMs: 30, assertions: [{ pass: false, message: "eq 失败" }], error: "请求失败（timeout）" },
  ],
};

describe("htmlReporter", () => {
  itCompliesWithReporterContract(htmlReporter, sample);

  it("包含汇总与用例明细", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-html-"));
    const file = await htmlReporter.render(sample, outDir);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("order-api");
    expect(html).toContain("bad");
    expect(html).toContain("eq 失败");
  });
});

describe("junitReporter", () => {
  itCompliesWithReporterContract(junitReporter, sample);

  it("产出合法 testsuites 结构，失败用例含 failure 节点", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-"));
    const file = await junitReporter.render(sample, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toContain('failures="1"');
    expect(xml).toContain("<failure");
  });
});

const hostile: RunResult = {
  collectionId: "c1", collectionName: `x"&</title><script>alert(1)</script>`, envName: "dev",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 1, passed: 0, failed: 1,
  cases: [
    {
      apiId: "a1", apiName: `api<&"`, caseId: "t1", caseName: `case<&"\u0007`, row: 3,
      passed: false, durationMs: 5,
      assertions: [{ pass: false, message: `msg<&">` }],
      error: `err&<>"\u0007`,
    },
  ],
};

describe("转义加固与文件名唯一", () => {
  it("HTML 不含原始 <script> 与裸控制字符", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-esc-h-"));
    const file = await htmlReporter.render(hostile, outDir);
    const html = readFileSync(file, "utf8");
    expect(html).not.toContain(`<script>alert(1)`);
    expect(html).toContain(`&lt;script&gt;alert(1)&lt;/script&gt;`);
    expect(html).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(html).toContain(`err&amp;&lt;&gt;"`);
  });

  it("JUnit 不含裸控制字符且属性正确转义", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-esc-j-"));
    const file = await junitReporter.render(hostile, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(xml).toContain(`classname="x&quot;&amp;&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
    expect(xml).toContain(`name="api&lt;&amp;&quot;.case&lt;&amp;&quot;#3"`);
  });

  it("failure 节点聚合 error 与全部失败断言消息（error 优先）", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-agg-"));
    const file = await junitReporter.render(sample, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain(`message="请求失败（timeout）; eq 失败"`);
  });

  it("failure 无 error 用断言消息，均空回退「断言失败」", async () => {
    const r: RunResult = {
      collectionId: "c1", collectionName: "c",
      startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
      total: 2, passed: 0, failed: 2,
      cases: [
        { apiId: "a", apiName: "api", caseId: "t1", caseName: "assert-fail", passed: false, durationMs: 1, assertions: [{ pass: false, message: "仅断言失败" }] },
        { apiId: "a", apiName: "api", caseId: "t2", caseName: "silent-fail", passed: false, durationMs: 1, assertions: [] },
      ],
    };
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-fb-"));
    const file = await junitReporter.render(r, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain(`message="仅断言失败"`);
    expect(xml).toContain(`message="断言失败"`);
  });

  it("文件名使用单调 ULID，同毫秒连续渲染不碰撞", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-ulid-"));
    const h1 = await htmlReporter.render(sample, outDir);
    const h2 = await htmlReporter.render(sample, outDir);
    const j1 = await junitReporter.render(sample, outDir);
    expect(basename(h1)).toMatch(/^report-[0-9A-HJKMNP-TV-Z]{26}\.html$/);
    expect(basename(j1)).toMatch(/^junit-[0-9A-HJKMNP-TV-Z]{26}\.xml$/);
    expect(h1).not.toBe(h2);
    expect(existsSync(h1)).toBe(true);
    expect(existsSync(h2)).toBe(true);
  });
});
