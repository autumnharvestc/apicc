// M3-C 任务 1：在线模式真服务端端到端集成（联调轨核心交付，计划任务 1 步骤 1-2 / 账本裁定①②③）。
//
// 与既有 online 测试（假 fetch / 内存替身）的本质区别：本文件 spawn 真实服务端 jar
// （server/target/apicc-server-*.jar），用生产路径的 createOnlineClient（globalThis.fetch）
// 跑通「注册两用户 → 建区 → B 加入 EDITOR → A 推送两项目 → B tree 可见 → P2 对 B 设 NONE →
// B 推送成功与 409（含 currentHash:null 的新文件并发删除冲突路径）→ 拉取全量一致」8 步场景链。
// 客户端出口逐响应过 shared/online/contract.ts 的 zod schema（safeParse 不符即 protocol_error），
// 故全链通过即证明 M3-A 服务端实序与 M3-B 契约替身形状无漂移（防 A/B 契约漂移 = 本任务核心价值）。
//
// 服务端生命周期（账本裁定①③，实现选型留痕）：
// - jar 就绪：target 下已有且不旧于 server/src 与 pom.xml 时直接复用；否则测试内自建
//   （mvn -s server/.mvn/settings.xml -f server/pom.xml -q -DskipTests package）；
//   mvn 候选顺序：APICC_E2E_MVN 环境变量 → 仓库 wrapper（server/mvnw[.cmd]，版本钉 3.9.9）→ PATH。
// - 启动：JDK 21 的 java -jar 随机空闲端口 + --apicc.server.data-dir 指向临时目录
//   （H2 元数据 URL 相对 cwd，故 cwd 同设临时目录——数据零落仓内）；GET /api/v1/ping 轮询就绪 ≤60s。
// - 关闭：child.kill()（SIGTERM）→ 5s 未退 taskkill /T /F（Windows 进程树兜底）→ afterAll
//   断言进程已退（无残留），临时目录尽力删除。
// - java 解析（环境硬约束）：PATH 默认 java 是 1.8——候选顺序 APICC_E2E_JAVA → JAVA_HOME →
//   C:\Program Files\Java\jdk-21* → PATH，逐个以 `-version` 实测 major ≥ 21 才采用。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOnlineClient, OnlineConflictError, type OnlineClient } from "../../../src/main/online/client.js";
import { scanDirFiles, writeFiles } from "../../../src/main/online/migrate.js";
import { onlineTreeToDto } from "../../../src/main/online/session.js";
import { planPull, planPush, restoreLocalPaths, toEntityPath } from "../../../src/shared/online/migrate.js";
import { runCommand } from "./run-command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// online → main → tests → desktop → apps → 仓库根：五层向上
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");

// —— 服务端进程句柄（beforeAll 建立 / afterAll 清理）——
let serverProcess: ChildProcess | undefined;
let serverPort = 0;
let dataRoot = "";

// ---- 进程/构建工具函数 ----

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
    const p = join(dir, entry.name);
    newest = Math.max(newest, statSync(p).mtimeMs, entry.isDirectory() ? newestMtime(p) : 0);
  }
  return newest;
}

/** 逐候选实测 `-version` major ≥ 21（PATH 默认 java 是 1.8，版本不符即弃用下一个候选）。 */
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
  candidates.push(exeName); // PATH 兜底（本机为 1.8 会被版本实测淘汰）
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

/** jar 缺失或不新于 server/src、pom.xml 时自建（账本裁定①③）。 */
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
  serverPort = await freePort();
  dataRoot = mkdtempSync(join(tmpdir(), "apicc-e2e-server-"));
  const tail: string[] = [];
  // 8 步场景链以注册起头；部署线 D5 起注册默认关，此处显式开启
  serverProcess = spawn(javaExe, ["-jar", jar, `--server.port=${serverPort}`, `--apicc.server.data-dir=${join(dataRoot, "server-data")}`, "--apicc.server.allow-registration=true"], {
    cwd: dataRoot, // H2 元数据 URL 相对 cwd（jdbc:h2:file:./server-data/metadata）——数据全部落在临时目录
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      tail.push(chunk.toString("utf8"));
      if (tail.join("").length > 64 * 1024) tail.splice(0, tail.length / 2); // 只留尾部，防长跑膨胀
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

/** 关闭服务端：SIGTERM → 5s 宽限 → taskkill 进程树（win）/ SIGKILL；返回是否确认退出（无残留判定）。 */
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

// ---- 场景链夹具 ----

const rand = Math.random().toString(36).slice(2, 8);
const USER_A = { username: `e2e-owner-${rand}`, password: "password8", displayName: "所有者 A" };
const USER_B = { username: `e2e-member-${rand}`, password: "password8", displayName: "成员 B" };

/** 组织实体夹具（path 实体化 2026-09-08；2026-09-09 BIGINT 化：实体 id 为字符串化数字）：
 *  内容 path 首段=管理面创建的项目实体 id，在场景步骤 2b 经组织 API（默认分组下建两项目）取实体 id 后赋值。 */
let groupId = "";
let P1_ID = "";
let P2_ID = "";

/** 项目内文件：首段为项目实体数字 id（<projectId>/…）才归属项目。 */
let P1_FILE_A = "";
let P1_FILE_B = "";
let P2_FILE = "";
let FILE_F = ""; // null-hash 冲突路径专用文件

const apiYaml = (name: string, version: string) => `id: api-${name}\nname: ${name}\nversion: "${version}"\nmethod: POST\nurl: "{{baseUrl}}/${name}"\n`;
const P1_A_V1 = apiYaml("创建", "1");
const P1_B_V1 = apiYaml("查询", "1");
const P2_V1 = apiYaml("入库单", "1");
const F_V1 = apiYaml("作废", "1");

/** 从 tree 中取某路径的版本行（不在场即失败）。 */
function fileEntry(tree: { files: Array<{ path: string; version: number; hash: string }> }, path: string): { version: number; hash: string } {
  const row = tree.files.find((f) => f.path === path);
  if (!row) throw new Error(`tree 中不存在 ${path}（实际 ${tree.files.length} 个文件）`);
  return row;
}

/** 服务端 tree.projects 按实体表创建序（created_at,id）返回——两侧同序化后再比对，断言不钉服务端排序实现。 */
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 组织 API 直连（OnlineClient 未含组织面方法；M3-B 客户端仅内容同步面）。 */
async function orgJson(method: string, path: string, token: string | null, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${serverBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) throw new Error(`组织 API ${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** 场景内解析夹具：登录取 token → 建区种子默认分组下建两项目 → 内容路径常量赋值（步骤 2b 调用）。 */
async function seedOrgProjects(wsId: string, ownerCredentials: { username: string; password: string }): Promise<void> {
  const login = await orgJson("POST", "/api/v1/auth/login", null, ownerCredentials);
  const tokenA = String(login.token);
  const groups = (await orgJson("GET", `/api/v1/workspaces/${wsId}/groups`, tokenA)) as unknown as Array<Record<string, unknown>>;
  groupId = String(groups[0]!.id);
  P1_ID = String((await orgJson("POST", `/api/v1/workspaces/${wsId}/projects`, tokenA, { groupId, name: "订单" })).id);
  P2_ID = String((await orgJson("POST", `/api/v1/workspaces/${wsId}/projects`, tokenA, { groupId, name: "库存" })).id);
  P1_FILE_A = `${P1_ID}/collections/订单/apis/创建/api.yaml`;
  P1_FILE_B = `${P1_ID}/collections/订单/apis/查询/api.yaml`;
  P2_FILE = `${P2_ID}/collections/入库/apis/入库单/api.yaml`;
  FILE_F = `${P1_ID}/collections/订单/apis/作废/api.yaml`;
}

let serverBase = "";
let clientA: OnlineClient;
let clientB: OnlineClient;

beforeAll(async () => {
  const java = resolveJava();
  const jar = ensureJar(java.home);
  await startServer(jar, java.exe);
  const base = `http://127.0.0.1:${serverPort}`;
  serverBase = base;
  clientA = createOnlineClient({ baseUrl: base, timeoutMs: 10_000 });
  clientB = createOnlineClient({ baseUrl: base, timeoutMs: 10_000 });
}, 600_000); // 含可能的首次 mvn package（Aliyun 依赖下载）

afterAll(async () => {
  const stopped = await stopServer();
  expect(stopped, "服务端进程应确认退出（无残留进程）").toBe(true);
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true }); // 尽力删除（Windows 句柄释放竞态不致失败套件）
});

describe("在线模式真服务端端到端（onlineClient × spawn jar）", () => {
  it("8 步场景链：注册 → 建区/入区 → 推送 → 可见性 → ACL 过滤 → 推送与 409 冲突（含 null hash）→ 拉取一致", async () => {
    // 步骤 1：注册两用户 + 登录（register 201 形状 / login 出口自动持 token）
    const a = await clientA.register(USER_A);
    const b = await clientB.register(USER_B);
    expect(a.username).toBe(USER_A.username);
    const loginA = await clientA.login({ username: USER_A.username, password: USER_A.password });
    const loginB = await clientB.login({ username: USER_B.username, password: USER_B.password });
    expect(loginA.user.id).toBe(a.id);
    expect(loginB.expiresAt).toBeTruthy();

    // 步骤 2：A 建工作区（创建者自动 OWNER）
    const ws = await clientA.createWorkspace({ name: "联调空间" });
    expect(ws.myRole).toBe("OWNER");

    // 步骤 2b：组织实体夹具——建区已种子默认分组，其下建两项目；内容 path 首段=项目实体 UUID
    await seedOrgProjects(ws.id, USER_A);
    expect(P1_ID).not.toEqual(P2_ID);

    // 步骤 3：B 加入 EDITOR（成员管理契约面）+ B 工作区列表可见其角色
    await clientA.manageMembers(ws.id, { userId: b.id, role: "EDITOR" });
    const bList = await clientB.listWorkspaces();
    expect(bList.find((w) => w.id === ws.id)?.myRole).toBe("EDITOR");

    // 步骤 4：A 推送含两项目的文件集（batch 部分成功语义：全部 pushed / 新文件 version=1）
    const push = await clientA.batchPush(ws.id, {
      files: [
        { path: P1_FILE_A, content: P1_A_V1, baseVersion: 0 },
        { path: P1_FILE_B, content: P1_B_V1, baseVersion: 0 },
        { path: P2_FILE, content: P2_V1, baseVersion: 0 },
      ],
    });
    expect(push.results.map((r) => [r.path, r.status, r.version])).toEqual([
      [P1_FILE_A, "pushed", 1],
      [P1_FILE_B, "pushed", 1],
      [P2_FILE, "pushed", 1],
    ]);

    // 步骤 5：B getTree 两项目可见（projects 来自实体表 {id, name, groupId, myRole}；myRole 继承 EDITOR）
    const treeB1 = await clientB.getTree(ws.id);
    expect([...treeB1.projects].sort(byId)).toEqual(
      [
        { id: P1_ID, name: "订单", groupId, myRole: "EDITOR" },
        { id: P2_ID, name: "库存", groupId, myRole: "EDITOR" },
      ].sort(byId),
    );
    expect(treeB1.files.map((f) => f.path).sort()).toEqual([P1_FILE_A, P1_FILE_B, P2_FILE].sort());

    // 步骤 5b：DTO 层（桌面侧树组装）——真服 raw tree 喂生产映射 onlineTreeToDto：项目节点以
    // projectId 关联（id=实体 id、label=实体行 name），推入文件进树且 api 叶 id=文件全路径
    // （OnlineApiEditor 选中机制）；叶名须为约定文件名 api.yaml 才进树（非约定名=杂散文件）
    const dtoB1 = onlineTreeToDto(treeB1, "联调空间");
    expect(dtoB1.label).toBe("联调空间");
    const p1Node = dtoB1.children!.find((c) => c.kind === "project" && c.id === P1_ID);
    expect(p1Node?.label).toBe("订单");
    const p1Collection = p1Node!.children!.find((c) => c.kind === "collection" && c.label === "订单")!;
    expect(p1Collection.children!.find((c) => c.kind === "api" && c.id === P1_FILE_A)?.label).toBe("创建");
    expect(p1Collection.children!.find((c) => c.kind === "api" && c.id === P1_FILE_B)?.label).toBe("查询");
    expect(dtoB1.children!.find((c) => c.kind === "project" && c.id === P2_ID)).toBeDefined();

    // 步骤 6：A 将 P2 对 B 设 NONE → B tree 过滤 + 读 P2 路径 missing（不泄露存在性）
    await clientA.manageAcl(ws.id, P2_ID, { userId: b.id, role: "NONE" });
    const aclRows = await clientA.manageAcl(ws.id, P2_ID);
    expect(aclRows).toContainEqual({ userId: b.id, role: "NONE" });
    const treeB2 = await clientB.getTree(ws.id);
    expect(treeB2.projects.map((p) => p.id)).toEqual([P1_ID]);
    expect(treeB2.files.map((f) => f.path).sort()).toEqual([P1_FILE_A, P1_FILE_B].sort());
    // DTO 层同步复核：P2 被过滤后桌面侧树同样不含该 projectId 节点（不泄露存在性）
    const dtoB2 = onlineTreeToDto(treeB2, "联调空间");
    expect(dtoB2.children!.some((c) => c.kind === "project" && c.id === P2_ID)).toBe(false);
    const hidden = await clientB.getFiles(ws.id, [P2_FILE]);
    expect(hidden.files).toEqual([]);
    expect(hidden.missing).toEqual([P2_FILE]);

    // 步骤 7：B 推送 P1 修改成功 → baseVersion 过期 409（带 hash 的常规冲突）
    const v2 = apiYaml("创建", "2");
    const bPush = await clientB.putFile(ws.id, { path: P1_FILE_A, content: v2, baseVersion: 1 });
    expect(bPush).toEqual({ path: P1_FILE_A, version: 2, hash: sha256Hex(v2) });
    // A 基于现状推到 v3，B 仍持 baseVersion=2 再推 → 409 冲突对象完整（code/currentVersion/currentHash）
    const v3 = apiYaml("创建", "3");
    await clientA.putFile(ws.id, { path: P1_FILE_A, content: v3, baseVersion: 2 });
    const stalePush = await clientB.putFile(ws.id, { path: P1_FILE_A, content: apiYaml("创建", "2-bis"), baseVersion: 2 }).catch((e) => e);
    expect(stalePush).toBeInstanceOf(OnlineConflictError);
    expect(stalePush.conflict).toEqual({
      code: "version_conflict",
      message: "baseVersion 与服务端现状不一致",
      currentVersion: 3,
      currentHash: sha256Hex(v3),
    });

    // 步骤 7b：新文件并发删除场景 → 409 带 currentHash:null（步骤 0 前置对齐①修的形状，
    // strict string schema 修前此处 safeParse 失败退化 protocol_error、冲突路径走不通）
    await clientB.putFile(ws.id, { path: FILE_F, content: F_V1, baseVersion: 0 }); // B 建 F（v1）
    const treeA1 = await clientA.getTree(ws.id);
    await clientA.deleteFile(ws.id, { path: FILE_F, baseVersion: fileEntry(treeA1, FILE_F).version }); // A 并发删除
    const deletedConflict = await clientB.putFile(ws.id, { path: FILE_F, content: F_V1, baseVersion: 1 }).catch((e) => e);
    expect(deletedConflict).toBeInstanceOf(OnlineConflictError);
    expect(deletedConflict.conflict.code).toBe("version_conflict");
    expect(deletedConflict.conflict.currentVersion).toBe(0);
    expect(deletedConflict.conflict.currentHash).toBeNull(); // ★ 显式断言：null hash 冲突对象完整走通冲突路径

    // 步骤 8：拉取全量一致（D8 协议：tree → files → 落盘；逐文件 sha256 与 tree hash 对账）
    const pullAndVerify = async (client: OnlineClient, dir: string, expectPaths: string[]) => {
      const tree = await client.getTree(ws.id);
      expect(tree.files.map((f) => f.path).sort()).toEqual([...expectPaths].sort());
      const batch = await client.getFiles(ws.id, tree.files.map((f) => f.path));
      expect(batch.missing).toEqual([]);
      expect(batch.files).toHaveLength(expectPaths.length);
      for (const file of batch.files) {
        expect(sha256Hex(file.content), `hash 对账：${file.path}`).toBe(fileEntry(tree, file.path).hash);
        const target = join(dir, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true }); // D8 落盘步骤（拉取目录按相对路径建树）
        writeFileSync(target, file.content, "utf8");
        expect(readFileSync(target, "utf8"), `落盘回读一致：${file.path}`).toBe(file.content);
      }
      return batch;
    };
    // B 视角：可见子树 = P1 两文件（F 已删、P2 被过滤），P1 文件为服务端最新 v3
    const bBatch = await pullAndVerify(clientB, join(dataRoot, "pull-b"), [P1_FILE_A, P1_FILE_B]);
    expect(bBatch.files.find((f) => f.path === P1_FILE_A)?.content).toBe(v3);
    expect(bBatch.files.find((f) => f.path === P1_FILE_B)?.content).toBe(P1_B_V1);
    // A 视角：全量三文件（F 已删不再出现），P2 内容与推送一致
    const aBatch = await pullAndVerify(clientA, join(dataRoot, "pull-a"), [P1_FILE_A, P1_FILE_B, P2_FILE]);
    expect(aBatch.files.find((f) => f.path === P2_FILE)?.content).toBe(P2_V1);
    // 落盘目录已随 dataRoot 建好（pull-b / pull-a 存在即写入成功）
    expect(existsSync(join(dataRoot, "pull-b", ...P1_FILE_A.split("/")))).toBe(true);
    expect(existsSync(join(dataRoot, "pull-a", ...P2_FILE.split("/")))).toBe(true);
  }, 120_000);
});

// —— 计划 C 任务 3：迁移双向真服 E2E（映射桥 push / 同 hash 跳过 / pull 名称树还原）——
const USER_MIG = { username: `e2e-migrate-${rand}`, password: "password8", displayName: "迁移用户" };

describe("迁移双向真服端到端（计划 C 任务 3：映射桥 × spawn jar）", () => {
  /**
   * 测试分层裁定（任务 3 简报）：迁移编排 migratePush/migratePull 在渲染层 store
   * （stores/online.ts——main 进程测试不可 import 渲染层代码）。本用例以生产原语复现 store
   * 的**相同步骤序列**做端到端验证：
   *   push = scanDirFiles → 映射桥（createIfMissing=true 按需建）→ toEntityPath 换算
   *          → planPush（差异/baseVersion）→ batchPush；
   *   pull = getTree + listGroups → restoreLocalPaths 还原本地名称路径 → planPull（空目录全量）
   *          → getFiles（实体路径取内容）→ writeFiles（本地名称路径落盘）。
   * store 编排自身的分支语义（映射 missing/forbidden → 整项目 failed、分批进度、明细本地名
   * 还原）已由任务 2 的 migrate.test.ts / stores 单测覆盖；此处断言「真服 × 生产换算 × 生产
   * 落盘」的端到端行为，含树 DTO 分组层（真服 groups 清单注入）。
   */
  it("push：名称树→实体寻址落库且本地不动；再推同 hash 跳过、变更 pushed；pull 还原本地名称树", async () => {
    // 步骤 1：独立用户与工作区（与前 describe 的 8 步链互不共享实体）
    const client = createOnlineClient({ baseUrl: serverBase, timeoutMs: 10_000 });
    await client.register(USER_MIG);
    await client.login({ username: USER_MIG.username, password: USER_MIG.password });
    const ws = await client.createWorkspace({ name: "迁移空间" });
    expect(ws.myRole).toBe("OWNER"); // 工作区创建者 OWNER：映射桥按需建（ADMIN+）与根配置写（ADMIN+）均放行

    // 步骤 2：造本地临时名称树（中文目录 + 根级 apicc.workspace.yaml + 同组两项目）
    const srcDir = join(dataRoot, "migrate-src");
    const localFiles: Array<[string, string]> = [
      ["apicc.workspace.yaml", "workspace: 迁移空间\n"],
      ["groups/电商组/projects/宠物商店/project.yaml", "name: 宠物商店\n"],
      ["groups/电商组/projects/宠物商店/collections/基础/apis/查询/api.yaml", apiYaml("查询", "1")],
      ["groups/电商组/projects/进销存/collections/仓储/apis/入库/api.yaml", apiYaml("入库", "1")],
    ];
    for (const [path, content] of localFiles) {
      const target = join(srcDir, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }

    // 步骤 3：push 编排（store migratePush 同步序）：扫描 → 映射桥 → 换算 → 差异 → 分批推送
    const scan1 = scanDirFiles(srcDir);
    expect(scan1.map((f) => f.path).sort()).toEqual(localFiles.map(([p]) => p).sort());
    const tree0 = await client.getTree(ws.id);
    expect(tree0.files).toEqual([]); // 空工作区起步
    const dirs = new Map<string, { group: string; project: string }>();
    for (const file of scan1) {
      if (file.projectDir) dirs.set(`${file.projectDir.group}/${file.projectDir.project}`, file.projectDir);
    }
    const mapping = await client.onlineProjectMapping(ws.id, [...dirs.values()].map((d) => ({ ...d, createIfMissing: true })));
    expect(mapping.mappings).toHaveLength(2);
    expect(mapping.mappings.every((m) => m.created === true && m.groupId !== undefined && m.projectId !== undefined)).toBe(true);
    const gid = mapping.mappings[0]!.groupId!;
    expect(mapping.mappings.map((m) => m.groupId)).toEqual([gid, gid]); // 同组两项目
    const projectIdByDir = new Map(mapping.mappings.map((m) => [`${m.group}/${m.project}`, m.projectId!]));
    const petShopId = projectIdByDir.get("电商组/宠物商店")!;
    const stockId = projectIdByDir.get("电商组/进销存")!;

    // 换算（store 同款 toEntityPath：项目内 → <projectId>/<项目内相对路径>，根级原路径直推）
    const convert = (scan: typeof scan1) => {
      const rows: Array<{ path: string; hash: string; content: string }> = [];
      for (const file of scan) {
        const projectId = file.projectDir ? projectIdByDir.get(`${file.projectDir.group}/${file.projectDir.project}`) : undefined;
        const entityPath = projectId !== undefined ? toEntityPath(file.path, projectId) : null;
        if (entityPath === null) {
          if (!file.projectDir) rows.push(file); // 根级文件不过映射
          continue;
        }
        rows.push({ path: entityPath, hash: file.hash, content: file.content });
      }
      return rows;
    };
    const plan1 = planPush(convert(scan1), tree0.files);
    expect(plan1.skipped).toEqual([]); // 空服务端起步：全为新文件
    expect(plan1.entries.every((e) => e.baseVersion === 0)).toBe(true);
    const batch1 = await client.batchPush(ws.id, { files: plan1.entries });
    expect(batch1.results.map((r) => [r.path, r.status, r.version])).toEqual(plan1.entries.map((e) => [e.path, "pushed", 1]));

    // 步骤 4：真服 tree 出现实体行（名称/groupId 桥接产出）+ 实体文件（<projectId>/...），根级文件原路径
    const petShopApi = `${petShopId}/collections/基础/apis/查询/api.yaml`;
    const stockApi = `${stockId}/collections/仓储/apis/入库/api.yaml`;
    const tree1 = await client.getTree(ws.id);
    expect(tree1.files.map((f) => f.path).sort()).toEqual(
      ["apicc.workspace.yaml", `${petShopId}/project.yaml`, petShopApi, stockApi].sort(),
    );
    expect(tree1.projects).toContainEqual(expect.objectContaining({ id: petShopId, name: "宠物商店", groupId: gid }));
    expect(tree1.projects).toContainEqual(expect.objectContaining({ id: stockId, name: "进销存", groupId: gid }));

    // 步骤 5：本地目录未被改动（推送是复制不是移动——迁移语义）
    expect(scanDirFiles(srcDir)).toEqual(scan1);

    // 步骤 6：改本地一个文件再 push → 同 hash 跳过（skipped=3）+ 变更文件带服务端版本 pushed
    const changedLocal = "groups/电商组/projects/宠物商店/collections/基础/apis/查询/api.yaml";
    const v2 = apiYaml("查询", "2");
    writeFileSync(join(srcDir, ...changedLocal.split("/")), v2, "utf8");
    const scan2 = scanDirFiles(srcDir);
    const plan2 = planPush(convert(scan2), tree1.files);
    expect(plan2.skipped.sort()).toEqual(["apicc.workspace.yaml", `${petShopId}/project.yaml`, stockApi].sort());
    expect(plan2.entries).toEqual([{ path: petShopApi, content: v2, baseVersion: 1 }]); // baseVersion = 服务端现版本
    const batch2 = await client.batchPush(ws.id, { files: plan2.entries });
    expect(batch2.results).toEqual([{ path: petShopApi, status: "pushed", version: 2 }]);

    // 步骤 7：pull 到另一空目录（store migratePull 同步序）：tree + groups → 还原本地名称路径 →
    // 空目录全量 pulled → 按实体路径取内容 → 按本地名称路径落盘
    const dstDir = join(dataRoot, "migrate-dst");
    mkdirSync(dstDir, { recursive: true });
    expect(scanDirFiles(dstDir)).toEqual([]); // 空目录起步
    const tree2 = await client.getTree(ws.id);
    const groups = await client.listGroups(ws.id);
    expect(groups).toContainEqual(expect.objectContaining({ id: gid, name: "电商组" }));
    const restored = restoreLocalPaths(tree2.files, tree2.projects, new Map(groups.map((g) => [g.id, g.name])));
    const localByEntity = new Map(restored.map((r) => [r.serverPath, r.localPath]));
    expect(restored.every((r) => !r.orphan)).toBe(true); // 映射桥建出的实体组名/项目名齐全，无孤儿
    expect(localByEntity.get(petShopApi)).toBe(changedLocal);
    const pullPlan = planPull(tree2.files, scanDirFiles(dstDir));
    expect(pullPlan.details.every((d) => d.action === "pulled")).toBe(true);
    const got = await client.getFiles(ws.id, pullPlan.toFetch);
    expect(got.missing).toEqual([]);
    writeFiles(dstDir, got.files.map((f) => ({ path: localByEntity.get(f.path) ?? f.path, content: f.content })));

    // 步骤 8：落盘为本地名称树形态（groups/电商组/projects/...）且内容与当前本地源逐文件一致
    const pulled = scanDirFiles(dstDir);
    expect(pulled.map((f) => f.path).sort()).toEqual(scan2.map((f) => f.path).sort());
    const srcByPath = new Map(scan2.map((f) => [f.path, f]));
    for (const file of pulled) {
      expect(file.hash, `hash 对账：${file.path}`).toBe(srcByPath.get(file.path)!.hash);
    }
    expect(existsSync(join(dstDir, "groups", "电商组", "projects", "宠物商店", "collections", "基础", "apis", "查询", "api.yaml"))).toBe(true);
    expect(readFileSync(join(dstDir, ...changedLocal.split("/")), "utf8")).toBe(v2); // 拉回的是修改后内容
    expect(readFileSync(join(dstDir, "apicc.workspace.yaml"), "utf8")).toBe("workspace: 迁移空间\n"); // 根级文件原路径还原

    // 步骤 9：真服 tree + groups 清单喂生产树映射的分组层（任务 3 在线侧树分组层）——项目挂
    // group:<groupId> 合成组节点（label=组名），api 叶 id=文件全路径（OnlineApiEditor 选中链路不变）
    const dto = onlineTreeToDto(tree2, "迁移空间", new Map(groups.map((g) => [g.id, g.name])));
    const groupNode = dto.children!.find((c) => c.kind === "group" && c.id === `group:${gid}`);
    expect(groupNode?.label).toBe("电商组");
    expect(groupNode!.children!.map((c) => c.id).sort()).toEqual([petShopId, stockId].sort());
    const petShopNode = groupNode!.children!.find((c) => c.kind === "project" && c.id === petShopId)!;
    const apiLeaf = petShopNode.children!.find((c) => c.kind === "collection" && c.label === "基础")!.children!.find((c) => c.kind === "api")!;
    expect(apiLeaf.id).toBe(petShopApi);
  }, 120_000);
});
