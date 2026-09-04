// M3-C 任务 2 裁定 C：runCommand 引号机制的含空格路径单元探针。
// 审查实测：旧实现把整行作单参数交给 spawn 依赖 Node 默认转义，行内引号被转成 `\"`
// 而 cmd 不认该转义——exe 或参数含空格即崩。本探针在含空格的临时目录构造可执行脚本
// （win：批处理，经 cmd /s /c 中转路径；posix：shell 脚本直spawn）+ 含空格参数，
// 钉住修复后「含空格 exe 与参数均可执行且实参完整传达」的行为契约。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./run-command.js";

describe("runCommand 引号机制（含空格路径探针）", () => {
  it("exe 与参数均含空格时可执行，参数原样传达", () => {
    // 前缀本身含空格 → mkdtemp 产物整个目录路径含空格
    const dir = mkdtempSync(join(tmpdir(), "apicc runcmd probe-"));
    try {
      const arg = "hello world from probe";
      let exe: string;
      if (process.platform === "win32") {
        exe = join(dir, "probe script.cmd"); // 脚本名也带空格，覆盖 exe 全路径引号
        // %* 原样回显全部实参（批处理，退出码 0）
        writeFileSync(exe, "@echo off\r\necho PROBE_OK %*\r\n", "utf8");
      } else {
        exe = join(dir, "probe-script.sh");
        writeFileSync(exe, '#!/bin/sh\necho "PROBE_OK $@"\n', "utf8");
        chmodSync(exe, 0o755);
      }
      const r = runCommand(exe, [arg, "plain"], process.env, 15_000);
      expect(r.status).toBe(0);
      expect(r.output).toContain("PROBE_OK");
      expect(r.output).toContain(arg); // 含空格参数未被截断/吞并
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
