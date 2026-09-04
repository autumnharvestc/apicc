// 跨 shell 命令执行工具（M3-C 任务 2 裁定 C：自 e2e-server.test.ts 提出共享，
// 供 e2e 服务端构建与引号探针测试复用——引号机制是本文件的行为契约）。
import { spawnSync } from "node:child_process";

/**
 * 跨 shell 命令执行，返回退出码与合并输出。
 *
 * - win32：经 `cmd /d /s /c` 执行整行——mvn 候选（仓库 wrapper mvnw.cmd、PATH 里的
 *   mvn.cmd）都是批处理，Node 直接 spawn 批处理会被拒（EINVAL），必须经 cmd 中转。
 *   引号机制（审查实测缺陷修复：若把整行作单参数交给 spawn 让 Node 自行转义，行内
 *   引号会被转成 `\"` 而 cmd 不认该转义，exe 或参数含空格即崩）：各段仅在含空白时
 *   加引号，再给整行外套一层引号，配 windowsVerbatimArguments 逐字传给 cmd。
 *   cmd 的 `/s /c` 语义恰好兜住外层：`/c` 后首字符是引号时，剥去行首与行尾各一个
 *   引号、内部引号原样保留——剥掉的正是外套层，行内引号原样抵达。
 * - posix：直接 spawn(exe, args)，无 shell 中转，无引号问题。
 * - 行为边界：本机制不处理实参内嵌双引号与 cmd 元字符（& | < > ^ %）——调用方实参均为
 *   受控的 mvn 旗标与仓库路径（本仓 e2e 场景），如需透传任意用户输入须先扩展引号策略。
 */
export function runCommand(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  opts?: { cwd?: string },
): { status: number | null; output: string } {
  if (process.platform === "win32") {
    const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
    const line = [quote(exe), ...args.map(quote)].join(" ");
    const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd: opts?.cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: true,
      encoding: "utf8",
    });
    return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  }
  const r = spawnSync(exe, args, { cwd: opts?.cwd, env, timeout: timeoutMs, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
