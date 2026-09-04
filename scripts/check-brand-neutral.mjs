#!/usr/bin/env node
// 品牌中立门禁（M2-D 规格决策 D8）：扫描 git 跟踪文件，命中竞品工具名即退出码 1。
// CI（.github/workflows/ci.yml 的 brand-gate job）与本地共用本脚本，零外部依赖。
//
// 为什么词表按段书写：品牌中立约束对本仓库「一切入库文件」成立——本脚本自身
// 也在被扫描之列，字面竞品名不得出现在源码里。因此词表以两段字符串书写、
// 运行时 join 拼接；--self-check 在运行时构造正负样本断言拼接结果与词边界
// 行为，保证这份拆段词表本身被机器验证（拆错、拼错、误伤都会非零退出）。
//
// 词表口径：仅收录竞品工具名（大小写不敏感、\b 词边界全词匹配）。
// swagger / openapi / collection 是开放标准与交换格式的通用命名（如
// `swagger: "2.0"` 是 OpenAPI 2.0 规范的字段键，导入解析必须保留），不属
// 任何竞品商标，因此不入词表——代码与文档中正常使用不受本门禁影响。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 竞品工具名词表：每项 [首段, 尾段]，运行时拼接为完整词；顺序即输出顺序。 */
const SEGMENTED_WORDS = [
  ["post", "man"],
  ["api", "fox"],
  ["jme", "ter"],
  ["ya", "pi"],
  ["soap", "ui"],
  ["insom", "nia"],
  ["hopp", "scotch"],
  ["bru", "no"],
  ["new", "man"],
  ["kar", "ate"],
];

/** 由分段词表拼出完整词并构造大小写不敏感的词边界正则。 */
const WORDS = SEGMENTED_WORDS.map(([head, tail]) => head + tail);
const PATTERN = new RegExp("\\b(" + WORDS.join("|") + ")\\b", "i");

/** 仓库根 = 本脚本上级目录（scripts/）的上一级；扫描始终以它为 cwd。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 跳过的文件：锁文件由依赖树生成、非人工书写品牌措辞的地方。 */
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

/** 跳过的二进制扩展：逐行文本扫描对二进制无意义且会产生乱码误报。 */
const SKIP_EXTENSIONS = new Set([".png", ".ico", ".icns", ".exe", ".node"]);

/** 运行时构造 self-check 的正负样本（不得以字面量书写正样本，同理品牌中立）。 */
function buildSelfCheckSamples() {
  const positives = [];
  const negatives = [];
  const count = SEGMENTED_WORDS.length;
  SEGMENTED_WORDS.forEach(([head, tail], i) => {
    const word = head + tail;
    // 正样本：完整词本身、内嵌句中（中日韩字符对 \b 属非词字符，可命中）、
    // 大小写变体——三者都必须命中，漏一即词表/正则有错。
    positives.push(word, `接口调试可用 ${word} 完成`, word.toUpperCase());
    // 负样本一：段逆序拼接（tail+head），非竞品词，必须不命中。
    negatives.push(tail + head);
    // 负样本二：跨词段拼接（词 A 首段 + 相邻词 B 尾段），模拟「片段出现在
    // 更长标识符中段」的误伤路径；若未来词表调整使其撞成真词，本断言会失败。
    const [, nextTail] = SEGMENTED_WORDS[(i + 1) % count];
    negatives.push(head + nextTail);
    // 负样本三：词两侧再拼字母构成长标识符（x…y），\b 词边界应不命中——
    // 明确「全词匹配、不做子串误伤」的口径。
    negatives.push("x" + word + "y");
  });
  return { positives, negatives };
}

/** self-check：正样本必须全部命中、负样本必须全部不命中；段本身也不得命中。 */
function selfCheck() {
  const failures = [];
  const { positives, negatives } = buildSelfCheckSamples();
  for (const sample of positives) {
    if (!PATTERN.test(sample)) failures.push(`正样本未命中: ${sample}`);
  }
  for (const sample of negatives) {
    if (PATTERN.test(sample)) failures.push(`负样本误命中: ${sample}`);
  }
  for (const [head, tail] of SEGMENTED_WORDS) {
    // 段安全：任何一段若本身即词表成员，字面量就会落进本文件被扫描命中。
    for (const seg of [head, tail]) {
      if (PATTERN.test(seg)) failures.push(`词段本身命中词表: ${seg}`);
    }
  }
  if (failures.length > 0) {
    console.error("self-check 失败（词表或匹配行为异常）：");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `self-check 通过：正样本 ${positives.length} 条全命中，` +
      `负样本 ${negatives.length} 条全不命中，词段 ${SEGMENTED_WORDS.length * 2} 个均安全。`,
  );
}

/** 列出仓库全部 git 跟踪文件（\0 分隔，避免路径含空格被拆错）。 */
function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString().split("\0").filter(Boolean);
}

/** 逐文件逐行扫描，命中收集为 {file,line,text}。 */
function scanTrackedFiles() {
  const hits = [];
  for (const rel of listTrackedFiles()) {
    if (SKIP_FILES.has(rel)) continue;
    if (SKIP_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, rel), "utf8");
    } catch (err) {
      // 读取失败（如 ls-files 与读取之间文件被删）不拦截门禁，但留痕便于排查。
      console.error(`[warn] 无法读取 ${rel}：${err?.message ?? err}`);
      continue;
    }
    content.split(/\r?\n/).forEach((text, idx) => {
      if (PATTERN.test(text)) hits.push({ file: rel, line: idx + 1, text: text.trim() });
    });
  }
  return hits;
}

function main() {
  if (process.argv.includes("--self-check")) {
    selfCheck();
    return;
  }
  const hits = scanTrackedFiles();
  if (hits.length > 0) {
    console.error(`品牌中立门禁：命中 ${hits.length} 处竞品词（file:line: 行内容）：`);
    for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
    console.error("处理口径：开放标准命名（swagger/openapi/collection）不在词表；");
    console.error("确属竞品指称的请改用中性表述（如「开放 API 规范」「集合文件」）。");
    process.exit(1);
  }
  console.log(`品牌中立门禁通过：git 跟踪文件全树扫描无命中（词表 ${WORDS.length} 词）。`);
}

main();
