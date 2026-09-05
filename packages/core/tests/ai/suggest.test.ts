import { describe, expect, it } from "vitest";

import { AiSuggestError, suggestCases } from "../../src/ai/suggest.js";
import { DEFAULT_SUGGEST_LIMIT, type AiChatMessage, type AiProvider } from "../../src/ai/types.js";
import { TestCaseSchema, type ApiDefinition } from "../../src/domain/model.js";

const api: ApiDefinition = {
  id: "api-1",
  name: "创建订单",
  version: "1.0.0",
  deprecated: false,
  method: "POST",
  url: "https://api.example.com/orders",
  headers: [{ key: "content-type", value: "application/json", enabled: true }],
  query: [],
  body: { kind: "json", content: '{"sku":"A1","qty":1}' },
  design: "# 创建订单\n- qty 必须为正整数",
  cases: [{ id: "c0", name: "正常创建订单", scope: "base", parameters: {}, assertions: [] }],
};

const validCase = {
  name: "qty 为 0 应被拒绝",
  scope: "base",
  parameters: { qty: "0" },
  assertions: [
    { id: "a1", target: "bodyJson", op: "eq", path: "$.code", expected: "400" },
    { id: "a2", target: "status", op: "eq", expected: "400" },
  ],
  postScript: "console.log('done')",
};

const content = (cases: unknown[]): string => JSON.stringify({ cases });

/** 脚本化 provider 替身：按序返回预定输出并记录每次调用的 messages（含调用计数断言依据）。 */
function scriptedProvider(...responses: string[]) {
  const calls: AiChatMessage[][] = [];
  const queue = [...responses];
  const fn: AiProvider = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    const next = queue.shift();
    if (next === undefined) throw new Error("provider 被超次数调用");
    return next;
  };
  return { fn, calls };
}

// ULID：26 位 Crockford Base32 大写（裁定④：本地 ULID，不信任 AI id）。
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("suggestCases 解析成功路径", () => {
  it("字符串化 JSON 信封 → AiSuggestedCase[]：本地补 ULID、字段同构且过 TestCaseSchema", async () => {
    const { fn, calls } = scriptedProvider(content([validCase, { name: "仅含名称的最小用例" }]));
    const cases = await suggestCases(api, { provider: fn, instruction: "补充边界用例" });

    expect(calls).toHaveLength(1);
    expect(cases).toHaveLength(2);
    for (const c of cases) {
      expect(c.id).toMatch(ULID_RE); // 裁定④：id 由本地补 ULID
      // 同构不变量：建议用例（含本地 id）整体通过 TestCaseSchema 严格校验
      expect(() => TestCaseSchema.parse(c)).not.toThrow();
    }
    expect(cases.map((c) => new Set(Object.keys(c)))).toEqual([
      new Set(["id", "name", "scope", "parameters", "assertions", "postScript"]),
      new Set(["id", "name", "scope", "parameters", "assertions"]),
    ]);
    expect(cases[0]!.name).toBe("qty 为 0 应被拒绝");
    expect(cases[0]!.assertions).toHaveLength(2);
    expect(cases[1]!.scope).toBe("base"); // 缺省 scope 补 "base"
    expect(new Set(cases.map((c) => c.id)).size).toBe(2); // id 唯一
  });

  it("请求消息：system 提示词含角色/只输出 JSON 对象/避免重复要点；user 消息含接口摘要/既有用例/指令/条数上限", async () => {
    const { fn, calls } = scriptedProvider(content([{ name: "x" }]));
    await suggestCases(api, { provider: fn, instruction: "补充边界用例", limit: 2 });

    expect(calls).toHaveLength(1);
    const [system, user] = calls[0]!;
    expect(system!.role).toBe("system");
    expect(system!.content).toMatch(/API 测试工程师/); // 角色（裁定⑥）
    expect(system!.content).toMatch(/\{"cases":\[\.\.\.\]\}/); // 只输出 JSON 对象
    expect(system!.content).toMatch(/避免.*重复/);
    expect(system!.content).toMatch(/postScript/); // 字段 schema 说明

    expect(user!.role).toBe("user");
    expect(user!.content).toContain("创建订单");
    expect(user!.content).toContain("https://api.example.com/orders");
    expect(user!.content).toContain("POST");
    expect(user!.content).toContain("json"); // body kind
    expect(user!.content).toContain("qty 必须为正整数"); // design
    expect(user!.content).toContain("正常创建订单"); // 既有用例清单
    expect(user!.content).toContain("补充边界用例"); // 用户指令
    expect(user!.content).toMatch(/最多生成 2 条/); // limit 进提示
  });

  it("limit 截断（显式 2/3 → 2）", async () => {
    const { fn } = scriptedProvider(content([{ name: "c1" }, { name: "c2" }, { name: "c3" }]));
    const cases = await suggestCases(api, { provider: fn, limit: 2 });
    expect(cases.map((c) => c.name)).toEqual(["c1", "c2"]);
  });

  it("limit 缺省 5（裁定⑤）", () => {
    expect(DEFAULT_SUGGEST_LIMIT).toBe(5);
    void suggestCases; // 保持导入被消费
  });

  it("limit 缺省时超过 5 条只保留前 5 条", async () => {
    const { fn } = scriptedProvider(content(Array.from({ length: 7 }, (_, i) => ({ name: `c${i}` }))));
    const cases = await suggestCases(api, { provider: fn });
    expect(cases).toHaveLength(5);
  });

  it("空 cases 数组 → 空数组合法", async () => {
    const { fn, calls } = scriptedProvider(content([]));
    const cases = await suggestCases(api, { provider: fn });
    expect(cases).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("suggestCases 顺修（任务 1 审查）", () => {
  it("顺修①：输出带一层 markdown code fence（```json … ```）→ 剥围栏后正常解析，不触发重试", async () => {
    const fenced = "```json\n" + content([{ name: "围栏内的用例" }]) + "\n```";
    const { fn, calls } = scriptedProvider(fenced);
    const cases = await suggestCases(api, { provider: fn });
    expect(calls).toHaveLength(1); // 围栏不算解析失败，不进重试
    expect(cases.map((c) => c.name)).toEqual(["围栏内的用例"]);
  });

  it("顺修①：无语言标注的围栏（``` … ```）同样剥除", async () => {
    const fenced = "```\n" + content([{ name: "裸围栏用例" }]) + "\n```";
    const { fn } = scriptedProvider(fenced);
    const cases = await suggestCases(api, { provider: fn });
    expect(cases.map((c) => c.name)).toEqual(["裸围栏用例"]);
  });

  it("顺修②：assertion 缺 id → 本地 ULID 回填，产出仍过 TestCaseSchema；AI 已给 id 原样保留", async () => {
    const withMissingId = content([
      {
        name: "无 id 断言用例",
        assertions: [
          { target: "status", op: "eq", expected: "400" },
          { id: "AI 给的", target: "header", op: "contains", headerName: "content-type", expected: "json" },
        ],
      },
    ]);
    const { fn } = scriptedProvider(withMissingId);
    const cases = await suggestCases(api, { provider: fn });

    expect(cases).toHaveLength(1);
    const assertions = cases[0]!.assertions;
    expect(assertions[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // 本地回填 ULID（裁定④精神）
    expect(assertions[1]!.id).toBe("AI 给的"); // 已有 id 不覆盖
    expect(() => TestCaseSchema.parse(cases[0])).not.toThrow();
  });

  it("顺修③：limit 0 / 负数 / 非整数 → 可读报错，不做反直觉 slice", async () => {
    const { fn, calls } = scriptedProvider(content([{ name: "x" }]));
    for (const bad of [0, -1, 1.5]) {
      await expect(suggestCases(api, { provider: fn, limit: bad }), `limit=${bad}`).rejects.toThrow(/limit 须为正整数/);
    }
    expect(calls).toHaveLength(0); // 参数门在 provider 调用前
  });
});

describe("suggestCases 解析失败重试（裁定③：恰好一次）", () => {
  it("首次返回非法 JSON → 以问题清单构造修复消息恰好再调一次，二次成功则产出用例", async () => {
    const { fn, calls } = scriptedProvider("抱歉，我无法按格式输出。", content([validCase]));
    const cases = await suggestCases(api, { provider: fn });

    expect(calls).toHaveLength(2); // 调用计数断言：恰好一次修复重试
    expect(cases.map((c) => c.name)).toEqual([validCase.name]);

    const retry = calls[1]!;
    expect(retry).toHaveLength(4);
    expect(retry[0]).toEqual(calls[0]![0]); // system 不变
    expect(retry[1]).toEqual(calls[0]![1]); // 原用户消息不变
    expect(retry[2]!.role).toBe("assistant");
    expect(retry[2]!.content).toBe("抱歉，我无法按格式输出。"); // 原始输出回传
    expect(retry[3]!.role).toBe("user");
    expect(retry[3]!.content).toMatch(/未通过校验/);
    expect(retry[3]!.content).toMatch(/不是合法 JSON/); // 问题摘要进修复消息
    expect(retry[3]!.content).toMatch(/\{"cases"/); // 重申输出格式
  });

  it("首次 JSON 合法但结构非法（cases 非数组）→ 同样触发一次修复重试", async () => {
    const { fn, calls } = scriptedProvider('{"cases":"不是一个数组"}', content([{ name: "c1" }]));
    const cases = await suggestCases(api, { provider: fn });
    expect(calls).toHaveLength(2);
    expect(calls[1]![3]!.content).toMatch(/cases/); // zod issue 摘要（含 path）进修复消息
    expect(cases.map((c) => c.name)).toEqual(["c1"]);
  });

  it("两次均失败 → 报错带两次问题摘要，且不再第三次调用", async () => {
    const { fn, calls } = scriptedProvider("完全不是 JSON", '{"cases":"仍然非法"}');
    const err = await suggestCases(api, { provider: fn }).then(
      () => { throw new Error("应当失败"); },
      (e: unknown) => e as AiSuggestError,
    );
    expect(err).toBeInstanceOf(AiSuggestError);
    expect(err.message).toMatch(/第一次/);
    expect(err.message).toMatch(/第二次/);
    expect(err.message).toMatch(/不是合法 JSON/); // 第一次摘要
    expect(err.message).toMatch(/cases/); // 第二次摘要（zod path）
    expect(calls).toHaveLength(2); // 恰好一次重试，无第三次调用
  });

  it("provider 自身异常（如网络错误）原样抛出，不吞掉也不触发修复重试", async () => {
    let calls = 0;
    const fn: AiProvider = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await expect(suggestCases(api, { provider: fn })).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });
});

describe("suggestCases 校验负例（strict：拒绝而非静默丢弃，进重试）", () => {
  const negativeFirst = [
    { label: "未知字段", bad: content([{ name: "c1", priority: "P0" }, { name: "c2" }]) },
    { label: "非法 scope（非字符串）", bad: content([{ name: "c1", scope: 42 }]) },
    { label: "非法 op", bad: content([{ name: "c1", assertions: [{ id: "a1", target: "status", op: "matches", expected: "200" }] }]) },
    { label: "AI 自带 id 被拒（裁定④）", bad: content([{ id: "AI_FAKE_ID", name: "c1" }]) },
  ];

  for (const { label, bad } of negativeFirst) {
    it(`${label} → 触发修复重试，二次合法输出被完整采纳（不静默丢弃）`, async () => {
      const { fn, calls } = scriptedProvider(bad, content([{ name: "修正后的用例" }]));
      const cases = await suggestCases(api, { provider: fn });

      expect(calls).toHaveLength(2); // 负例走了重试，而非静默丢弃后单次返回
      expect(cases).toHaveLength(1);
      expect(cases[0]!.name).toBe("修正后的用例");
      expect(cases[0]!.id).toMatch(ULID_RE);
    });
  }
});
