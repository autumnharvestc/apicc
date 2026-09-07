/// <reference types="node" />
// @vitest-environment node
// M4-A 任务 5（裁定 D，收口）：真服务端管理链路冒烟——spawn 真实 jar（含 M4-B 静态托管，
// main @ 04cfa6c 合入后本分支已同步），生产路径 createAdminClient（globalThis.fetch）跑通
// 「注册两用户 → 建区 → B 加 EDITOR → A 推文件造两项目 → B tree 可见 → P2 对 B 设 NONE →
// B tree 不含 P2 → A 删 ACL 行恢复继承 → B tree 复见 P2」管理链；再验控制台构建产物托管
// （--apicc.server.console-dir 指向 dist）：GET / 200 含 index.html 内容、/workspaces 深链
// SPA 回退 200、/api/v1/ping 不受扰。内容写面（files PUT）不属管理契约层（裁定⑤）——冒烟内
// 直接 fetch 调用，不入契约层。
// 服务端生命周期与 JDK/mvn 解析逻辑与 desktop e2e-server.test.ts 同构复制（包隔离：不 import
// desktop 代码）；win32 批处理经 cmd /d /s /c 中转的引号机制为行为契约（desktop run-command 先例）。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient, type AdminClient } from "../../src/api/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// e2e → tests → admin-web → apps → 仓库根：四层向上
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");
const DIST_DIR = join(REPO_ROOT, "apps", "admin-web", "dist");

// ---- 服务端进程句柄（beforeAll 建立 / afterAll 清理）----
let serverProcess: ChildProcess | undefined;
let serverPort = 0;
let dataRoot = "";

// ---- 进程/构建工具（desktop e2e 同构复制，零 desktop import）----

/** 跨 shell 命令执行（win32 批处理必须经 cmd 中转；引号机制见 desktop run-command.ts 行为契约）。 */
function runCommand(
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

/** 服务端 boot jar（spring-boot repackage 产物；`.jar.original` 被 $ 锚点排除）。 */
function findJar(): string | undefined {
  const target = join(SERVER_DIR, "target");
  if (!existsSync(target)) return undefined;
  const jars = readdirSync(target).filter((f) => /^apicc-server-.+\.jar$/.test(f));
  return jars[0] === undefined ? undefined : join(target, jars[0]);
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    newest = Math.max(newest, statSync(entry.name === "" ? dir : join(dir, entry.name)).mtimeMs, entry.isDirectory() ? newestMtime(join(dir, entry.name)) : 0);
  }
  return newest;
}

/** 逐候选实测 `-version` major ≥ 21（PATH 默认 java 可能是 1.8，版本不符即弃用下一个候选）。 */
function javaMajor(exe: string): number | null {
  try {
    const r = spawnSync(exe, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    const out = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    const m = /version "(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null; // 候选不存在（ENOENT 等）→ 下一个
  }
}

function resolveJava(): { exe: string; home: string | undefined } {
  const exeName = process.platform === "win32" ? "java.exe" : "java";
  const candidates: string[] = [];
  if (process.env.APICC_E2E_JAVA) candidates.push(process.env.APICC_E2E_JAVA);
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, "bin", exeName));
  if (process.platform === "win32") {
    const javaRoot = "C:\\Program Files\\Java";
    if (existsSync(javaRoot)) {
      for (const name of readdirSync(javaRoot).filter((n) => /^jdk-21/.test(n)).sort().reverse()) {
        candidates.push(join(javaRoot, name, "bin", exeName));
      }
    }
  }
  candidates.push(exeName); // PATH 兜底（若为 1.8 会被版本实测淘汰）
  for (const exe of candidates) {
    const major = javaMajor(exe);
    if (major !== null && major >= 21) {
      return { exe, home: exe.includes(`${sep}bin${sep}`) ? resolve(dirname(dirname(exe))) : undefined };
    }
  }
  throw new Error(
    "未找到 JDK 21 的 java 可执行文件（已尝试 APICC_E2E_JAVA、JAVA_HOME、C:\\Program Files\\Java\\jdk-21*、PATH 逐个版本实测）。" +
      "请设置 APICC_E2E_JAVA 指向 jdk-21 的 java 后重试。",
  );
}

/** mvn 候选：环境变量覆盖 → 仓库 wrapper（自包含、版本钉 3.9.9）→ PATH。 */
function resolveMvn(): string {
  if (process.env.APICC_E2E_MVN) return process.env.APICC_E2E_MVN;
  const wrapper = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
  if (existsSync(join(SERVER_DIR, wrapper))) return join(SERVER_DIR, wrapper);
  return "mvn";
}

/** jar 缺失或不新于 server/src、pom.xml 时自建；失败给「先 mvn package」可读错误。 */
function ensureJar(javaHome: string | undefined): string {
  const existing = findJar();
  if (existing) {
    const srcNewest = existsSync(join(SERVER_DIR, "src")) ? newestMtime(join(SERVER_DIR, "src")) : 0;
    const pomMtime = existsSync(join(SERVER_DIR, "pom.xml")) ? statSync(join(SERVER_DIR, "pom.xml")).mtimeMs : 0;
    if (statSync(existing).mtimeMs >= Math.max(srcNewest, pomMtime)) return existing;
  }
  const env = { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
  const r = runCommand(
    resolveMvn(),
    ["-s", join(SERVER_DIR, ".mvn", "settings.xml"), "-f", join(SERVER_DIR, "pom.xml"), "-q", "-DskipTests", "package"],
    env,
    600_000,
    { cwd: REPO_ROOT },
  );
  if (r.status !== 0) {
    throw new Error(
      `服务端 jar 构建失败（exit ${r.status}）。请先手动执行：mvn -s server/.mvn/settings.xml -f server/pom.xml -DskipTests package` +
        `（或设置 APICC_E2E_MVN 指向 mvn 可执行文件）。构建输出尾部：\n${r.output.slice(-2000)}`,
    );
  }
  const jar = findJar();
  if (!jar) throw new Error("构建成功但未在 server/target 下找到 apicc-server-*.jar（spring-boot repackage 产物）");
  return jar;
}

/** 随机空闲端口（listen(0) 由内核分配后释放——启动窗口极短，竞态可忽略）。 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolvePort(port) : rejectPort(new Error("内核未分配端口"))));
    });
  });
}

async function startServer(jar: string, javaExe: string): Promise<void> {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    throw new Error("控制台构建产物缺失（apps/admin-web/dist/index.html）。请先执行：pnpm -C apps/admin-web build");
  }
  serverPort = await freePort();
  dataRoot = mkdtempSync(join(tmpdir(), "apicc-admin-e2e-"));
  const tail: string[] = [];
  serverProcess = spawn(
    javaExe,
    [
      "-jar",
      jar,
      `--server.port=${serverPort}`,
      `--apicc.server.data-dir=${join(dataRoot, "server-data")}`,
      `--apicc.server.console-dir=${DIST_DIR}`, // 静态托管指向控制台构建产物（裁定 D③）
      // 本冒烟走「注册 → 建区 → …」管理链路；部署线 D5 起注册默认关，此处显式开启
      "--apicc.server.allow-registration=true",
    ],
    { cwd: dataRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      tail.push(chunk.toString("utf8"));
      if (tail.join("").length > 64 * 1024) tail.splice(0, tail.length / 2);
    });
  }
  const tailText = () => tail.join("").slice(-4000);
  const exited = new Promise<never>((_, reject) => {
    serverProcess!.once("exit", (code, signal) => reject(new Error(`服务端进程提前退出（code=${code} signal=${signal}）。\n最近输出：\n${tailText()}`)));
  });
  const ready = (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/api/v1/ping`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === "ok") return;
        }
      } catch {
        // 尚未就绪（连接拒绝/超时）→ 继续轮询
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`服务端 60s 内未就绪（GET /api/v1/ping 无 {status:"ok"}）。\n最近输出：\n${tailText()}`);
  })();
  await Promise.race([ready, exited]);
}

/** 关闭服务端：SIGTERM → 5s 宽限 → taskkill 进程树（win）/ SIGKILL；返回是否确认退出。 */
async function stopServer(): Promise<boolean> {
  const child = serverProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true)));
  child.kill("SIGTERM");
  if (await Promise.race([exited, new Promise<false>((r) => setTimeout(() => r(false), 5_000))])) return true;
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
  return Promise.race([exited, new Promise<false>((r) => setTimeout(() => r(false), 5_000))]);
}

// ---- 冒烟场景夹具 ----

const rand = Math.random().toString(36).slice(2, 8);
const USER_A = { username: `adm-owner-${rand}`, password: "password8", displayName: "管理员 A" };
const USER_B = { username: `adm-member-${rand}`, password: "password8", displayName: "成员 B" };

/** 项目目录规则（M1 §6 + 服务端 ProjectPaths.projectDir）：groups/<组>/projects/<名>。 */
const P1_DIR = "groups/后端/projects/订单";
const P2_DIR = "groups/后端/projects/库存";
const P1_ID = createSha256Hex(P1_DIR).slice(0, 12); // 控制者裁定：projectId = 目录路径 SHA-256 hex 前 12 位
const P2_ID = createSha256Hex(P2_DIR).slice(0, 12);
const P1_FILE = `${P1_DIR}/collections/订单/apis/创建/apicc.api.yaml`;
const P2_FILE = `${P2_DIR}/collections/入库/apis/入库单/apicc.api.yaml`;
const apiYaml = (name: string) => `id: api-${name}\nname: ${name}\nversion: "1"\nmethod: POST\nurl: "{{baseUrl}}/${name}"\n`;

function createSha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

let clientA: AdminClient;
let clientB: AdminClient;
let base = "";

beforeAll(async () => {
  const java = resolveJava();
  const jar = ensureJar(java.home);
  await startServer(jar, java.exe);
  base = `http://127.0.0.1:${serverPort}`;
  // baseUrl 语义 = API 根（含 /api/v1 段，裁定③）——与服务端根地址区别于 desktop onlineClient
  clientA = createAdminClient({ baseUrl: `${base}/api/v1`, timeoutMs: 10_000 });
  clientB = createAdminClient({ baseUrl: `${base}/api/v1`, timeoutMs: 10_000 });
}, 600_000); // 含可能的首次 mvn package

afterAll(async () => {
  const stopped = await stopServer();
  expect(stopped, "服务端进程应确认退出（无残留进程）").toBe(true);
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

/** 内容写面直接 fetch（管理契约面无 files PUT，裁定⑤/裁定 D②）——401 之外的失败即抛。 */
async function putFileAs(client: AdminClient, workspaceId: string, path: string, content: string): Promise<void> {
  const url = `${base}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${client.token}` },
    body: JSON.stringify({ content, baseVersion: 0 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PUT files ${path} → HTTP ${res.status}：${await res.text()}`);
  await res.body?.cancel();
}

describe("管理链路真服务端冒烟（adminClient × spawn jar，裁定 D②）", () => {
  it("注册 → 建区 → B 加 EDITOR → 推文件造两项目 → tree 可见 → P2 对 B 设 NONE 过滤 → 删 ACL 行恢复继承", async () => {
    // 步骤 1：注册两用户（201 形状）+ 登录（client 持 token）
    const a = await clientA.register(USER_A);
    const b = await clientB.register(USER_B);
    expect(a.username).toBe(USER_A.username);
    const loginA = await clientA.login({ username: USER_A.username, password: USER_A.password });
    const loginB = await clientB.login({ username: USER_B.username, password: USER_B.password });
    expect(loginA.user.id).toBe(a.id);
    expect(loginB.token).toBeTruthy();

    // 步骤 2：A 建工作区（创建者自动 OWNER）+ B 加入 EDITOR（§3.2 PUT 对非成员即创建）
    const ws = await clientA.createWorkspace({ name: "管理控制台联调空间" });
    expect(ws.myRole).toBe("OWNER");
    await clientA.setMemberRole(ws.id, b.id, "EDITOR");
    const members = await clientA.listMembers(ws.id);
    expect(members.find((m) => m.userId === b.id)?.role).toBe("EDITOR");

    // 步骤 3：A 推文件造两项目（内容写面直接 fetch，不入契约层）
    await putFileAs(clientA, ws.id, P1_FILE, apiYaml("创建"));
    await putFileAs(clientA, ws.id, P2_FILE, apiYaml("入库单"));

    // 步骤 4：B tree 两项目可见（projects[].path 必备，myRole 继承 EDITOR）
    const treeB1 = await clientB.getTree(ws.id);
    expect([...treeB1.projects].sort(byPath)).toEqual(
      [
        { id: P1_ID, name: "订单", path: P1_DIR, myRole: "EDITOR" },
        { id: P2_ID, name: "库存", path: P2_DIR, myRole: "EDITOR" },
      ].sort(byPath),
    );

    // 步骤 5：A 将 P2 对 B 设 NONE → ACL 行在（NONE=明确拒绝）+ B tree 不含 P2
    await clientA.setAclEntry(ws.id, P2_ID, { userId: b.id, role: "NONE" });
    const aclRows = await clientA.listAcl(ws.id, P2_ID);
    expect(aclRows).toContainEqual({ userId: b.id, role: "NONE" });
    const treeB2 = await clientB.getTree(ws.id);
    expect(treeB2.projects.map((p) => p.id)).toEqual([P1_ID]); // P2 被过滤（不泄露存在性）

    // 步骤 6：A 删 ACL 行（DELETE ?userId=，契约修订 2026-09-04：删行=恢复继承）→ B tree 复见 P2
    await clientA.deleteAclEntry(ws.id, P2_ID, b.id);
    expect(await clientA.listAcl(ws.id, P2_ID)).toEqual([]); // 行已消失
    const treeB3 = await clientB.getTree(ws.id);
    expect(treeB3.projects.find((p) => p.id === P2_ID)).toEqual({ id: P2_ID, name: "库存", path: P2_DIR, myRole: "EDITOR" });
    expect(treeB3.projects.find((p) => p.id === P1_ID)).toEqual({ id: P1_ID, name: "订单", path: P1_DIR, myRole: "EDITOR" });
  }, 120_000);
});

describe("控制台静态产物托管冒烟（裁定 D③：console-dir 指向 dist）", () => {
  it("GET / 200 含 index.html 内容；/workspaces 深链 SPA 回退 200；/api/v1/ping 不受扰", async () => {
    // 首页：dist/index.html 由服务端托管
    const home = await fetch(`${base}/`, { signal: AbortSignal.timeout(10_000) });
    expect(home.status).toBe(200);
    const homeText = await home.text();
    expect(homeText).toContain('<div id="app">');
    expect(homeText).toContain("管理控制台"); // dist 产物的 <title>

    // SPA 回退：非 /api/** 且非静态资源命中的 GET → index.html（M4-B D3）
    const deepLink = await fetch(`${base}/workspaces`, { signal: AbortSignal.timeout(10_000) });
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain('<div id="app">');

    // API 面不受静态托管影响
    const ping = await fetch(`${base}/api/v1/ping`, { signal: AbortSignal.timeout(10_000) });
    expect(ping.status).toBe(200);
    expect(((await ping.json()) as { status?: string }).status).toBe("ok");
  }, 60_000);
});
