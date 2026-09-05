# apicc M6-A AI 用例生成内核 + CLI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：subagent-driven-development 或 executing-plans。

**目标：** core `src/ai/` 模块（OpenAI 兼容 provider、prompt 构造、zod 严格解析与一次修复重试、ULID 补齐）+ CLI `apicc ai suggest-cases`（配置解析 env/用户级文件、YAML 输出、替身端到端）。

**工作目录：** `D:\workspace260609\project-2\apicc-m6-ai`（worktree，分支 `feature/m6-ai`）。**基线：core 254 / cli 28 全绿（main @ b6dac7e）。**

**全局约束：** 品牌中立；中文 conventional commit（`feat(core): ...` / `feat(cli): ...`）；门禁 = core 全量 + cli 全量 + typecheck；**测试零真实网络**（fetch 注入替身/本地 server 模拟 OpenAI 端点）；密钥永不落工作区；契约以 M6 规格 `docs/superpowers/specs/2026-09-05-apicc-m6-ai-design.md`（D1–D4/D7/D8）为唯一事实。

---

## 文件结构

```
packages/core/src/ai/types.ts       ← AiProviderConfig、AiSuggestedCase、AiSuggestResult
packages/core/src/ai/provider.ts    ← createAiProvider（chat completions、fetch 注入、超时、错误归一）
packages/core/src/ai/suggest.ts     ← suggestCases(api, {instruction?, limit?, provider})：prompt 构造/解析/一次修复重试/ULID
packages/core/src/ai/prompt.ts      ← 系统提示词与 ApiDefinition 摘要构造
packages/core/src/index.ts          ← 导出核对
packages/cli/src/main.ts            ← ai suggest-cases 命令 + 配置解析（env → ~/.apicc/ai.json）
packages/cli/tests/ai-suggest.test.ts
packages/core/tests/ai/*.test.ts
```

---

### 任务 1：core ai 模块

- [ ] **步骤 1：失败的测试**（fetch 替身，零真实网络）
  1. provider：请求拼装（URL = baseUrl + `/chat/completions`、Bearer 头、model、messages 数组、response_format json_object、超时 AbortSignal）；非 200 → 归一化错误（含状态码与响应片段）；网络错误归一化；缺 apiKey → 构造时即报错（fail-fast）。
  2. suggestCases：解析成功路径——替身返回 `{"choices":[{"message":{"content":"{\"cases\":[{...}]}"}}]}`（content 为字符串化 JSON），产出 `AiSuggestedCase[]`：本地补 ULID id、字段与 TestCase 同构（name/scope/parameters/assertions/postScript）且过 TestCaseSchema 校验；**limit 截断**；空 cases → 空数组合法。
  3. 解析失败重试：首次返回非法 JSON → 以 zod issues 构造修复消息**恰好再调一次**（调用计数断言）；二次仍失败 → 报错带两次问题摘要。
  4. 校验负例：AI 产出含未知字段/非法 scope/非法 op → 被拒（strict）且进重试而非静默丢弃。
- [ ] **步骤 2：实现**——types/provider/suggest/prompt；系统提示词内置中文（角色/输出 schema 说明/只输出 JSON 对象）；摘要构造：name/protocol/method/url/headers/body(kind+content)/design/既有 cases 的 name+scope 清单（提示词里声明「避免与既有用例重复」）；ULID 用既有 ulid 依赖。
- [ ] **步骤 3：core 全量 + typecheck + Commit** `feat(core): AI 用例生成模块——OpenAI 兼容 provider 与严格解析`

### 任务 2：CLI ai suggest-cases

- [ ] **步骤 1：失败的测试**
  1. 配置解析：env 三件套优先；缺失回落 `~/.apicc/ai.json`（测试以注入 HOME 指向临时目录）；两者皆缺 → 可读错误（指引两种配置方式）。
  2. e2e：本地 http server 模拟 OpenAI 兼容端点（返回一条合法建议用例）→ `runCli(["ai", "suggest-cases", apiPath, "--instruction", "补充边界用例"])` → exit 0、stdout/YAML 文件含候选用例（YAML 输出经 TestCaseSchema 校验回读）；`--limit 1` 截断；`--out` 写文件、缺省打 stdout。
  3. 工作区/接口定位复用既有 resolve 先例；密钥不出现在任何日志输出（断言）。
- [ ] **步骤 2：实现**——`ai` 命令组 + `suggest-cases` 子命令；`--out` 写 YAML（yaml 包既有依赖）；配置读取 ~ 用 `os.homedir()`（测试注入 `APICC_HOME` 或 HOME 覆盖——实现者选可测口径并报告注明）。
- [ ] **步骤 3：全量回归 + Commit** `feat(cli): ai suggest-cases 命令与配置解析`

---

## 规格覆盖对照

| 规格（m6 spec §2） | 任务 |
|---|---|
| D1 provider 抽象 | 1 |
| D2 配置边界（CLI 侧） | 2 |
| D3 prompt/解析/重试/ULID | 1 |
| D7 测试纪律（替身） | 1、2 |
| D8 CLI 命令 | 2 |

**明确推迟**：桌面接入（轨 3）、流式输出、多 provider、用量统计、AI 生成接口定义。
