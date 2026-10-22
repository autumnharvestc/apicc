// 打包冒烟脚本（任务 9 五级冒烟的入库简化版，宽审查修复 4）：
//   1. 存活：spawn release/win-unpacked/apicc.exe，8 秒后探活（未退出 = 存活）
//   2. 输出：stderr/stdout 扫 FATAL / Cannot find module / ERR_MODULE_NOT_FOUND
//   3. 加载标题：CDP /json/list 轮询，断言 renderer 页 title=apicc 且 url 指向 asar 内 dist-renderer
// 取舍：原临时脚本的层级 4（Runtime.evaluate 读 window.apicc 桥接频道）与层级 5
// （wsOpen/treeGet E2E IPC）依赖 CDP 长连接驱动，属一次性深检，不入库；
// 本脚本覆盖打包产物「能起、无致命错、renderer 加载成功」三道底线，日常回归够用。
// 前置：先执行 `pnpm -C apps/desktop dist:dir` 产出 release/win-unpacked/。
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitForRendererReady } from "./smoke-readiness.mjs";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let packageDir;
let explicitExe;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--package-dir" && args[index + 1]) packageDir = args[++index];
  else if (args[index] === "--exe" && args[index + 1]) explicitExe = args[++index];
  else throw new Error(`未知或缺少参数: ${args[index]}`);
}
if (packageDir && explicitExe) throw new Error("--package-dir 与 --exe 不能同时使用");
const exePath = explicitExe
  ? explicitExe
  : packageDir
    ? join(packageDir, "apicc.exe")
    : join(desktopDir, "release", "win-unpacked", "apicc.exe");
const PRODUCT_NAME = "apicc";
const ALIVE_WAIT_MS = 8_000;
const CDP_TIMEOUT_MS = 20_000;

const failures = [];
const ok = (msg) => console.log(`[OK]   ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.log(`[FAIL] ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 申请一个临时空闲端口（close 后供 electron 独占，冒烟场景可接受微小竞态）。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Windows 下杀进程树（electron 主进程带 renderer/GPU 子进程，kill() 不够）。 */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

if (process.platform !== "win32" || !existsSync(exePath)) {
  console.error(`未找到打包产物 ${exePath}——请先执行 Windows Electron 打包命令`);
  process.exit(1);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "apicc-smoke-dir-"));
const privateRoots = ["profile", "workspace", "history", "credentials", "user-home"].map((name) => join(temporaryRoot, name));
for (const root of privateRoots) mkdirSync(root, { recursive: true });
const safeTempRoot = realpathSync(temporaryRoot);
const systemTempRoot = realpathSync(tmpdir());
if (dirname(safeTempRoot) !== systemTempRoot || !/^apicc-smoke-dir-[a-z0-9-]+$/i.test(safeTempRoot.slice(systemTempRoot.length + 1))) {
  throw new Error("smoke 临时根不在预期的系统临时目录中");
}
for (const root of privateRoots) {
  const resolved = realpathSync(root);
  if (!resolved.startsWith(`${safeTempRoot}\\`)) throw new Error("smoke 私有根逃逸临时根");
}
const port = await pickFreePort();
const environment = { ...process.env, APICC_SMOKE_DIR: privateRoots[1], APICC_SMOKE_ISOLATED_ROOT: safeTempRoot, APICC_SMOKE_HIDE_WINDOW: "1" };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${privateRoots[0]}`], { windowsHide: true, env: environment });
const startedAt = Date.now();
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));

// 兜底：任何路径退出前清掉被测进程；总超时 60s 强制失败。
let settled = false;
const timeout = setTimeout(() => {
  if (!settled) fail("总超时（60s）未完成冒烟");
  settled = true;
  killTree(child);
}, 60_000);
process.on("exit", () => killTree(child));

try {
  // —— 1. 无 FATAL：启动输出无致命错误关键字 ——
  const fatalHit = output.match(/FATAL|Cannot find module|ERR_MODULE_NOT_FOUND/gi);
  if (!fatalHit) {
    ok(`无 FATAL/模块缺失错误（输出 ${output.length} 字符）`);
  } else {
    fail(`输出命中致命错误关键字 ${JSON.stringify([...new Set(fatalHit)])}`);
  }

  // —— 3. 加载标题：CDP /json/list 断言 renderer 页已加载 ——
  if (child.exitCode !== null) {
    fail("进程已退出，跳过 CDP 加载标题检查");
  } else {
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    let targets = null;
    let ws;
    const readinessTimeout = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("CDP 就绪预算已耗尽");
      return Math.min(5000, remaining);
    };
    const documentExpression = `({ url: location.href, readyState: document.readyState,
      title: document.title, children: document.querySelector('#app')?.children.length ?? -1 })`;
      // —— 4. 挂载非空：title 只证 index.html，渲染层模块求值崩溃（如 native 面误入渲染
      // bundle）会让 #app 空白而 title 照常——本检查由 2026-09-06 用户白屏报告引入。
      try {
        let mid = 0;
        const pending = new Map();
        const send = (method, params = {}, timeoutMs = 5000) =>
          new Promise((resolve, reject) => {
            const myId = ++mid;
            const timer = setTimeout(() => {
              if (pending.has(myId)) { pending.delete(myId); reject(new Error("CDP evaluate 超时")); }
            }, timeoutMs);
            pending.set(myId, (message) => {
              clearTimeout(timer);
              if (message.error) reject(Object.assign(new Error(JSON.stringify(message.error)), { code: "ERR_CDP_PROTOCOL" }));
              else resolve(message);
            });
            try { ws.send(JSON.stringify({ id: myId, method, params })); }
            catch (error) { clearTimeout(timer); pending.delete(myId); reject(error); }
          });
        await waitForRendererReady({
          deadline,
          isAlive: () => child.exitCode === null && child.signalCode === null,
          observe: async (budget) => {
            if (!targets) {
              const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(budget) });
              const list = (await res.json()).filter((t) => t.type === "page");
              targets = list.find((t) => String(t.url).includes("dist-renderer/index.html"));
              if (!targets) return null;
              ok(`CDP 已发现 renderer 页面：url=${targets.url}`);
            }
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              ws?.close();
              const connectionTimeout = readinessTimeout();
              ws = new WebSocket(targets.webSocketDebuggerUrl);
              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), connectionTimeout);
                ws.onopen = () => { clearTimeout(timer); resolve(); };
                ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); };
              });
              ws.onmessage = (ev) => {
                const message = JSON.parse(ev.data);
                if (message.id && pending.has(message.id)) {
                  pending.get(message.id)(message);
                  pending.delete(message.id);
                }
              };
              await send("Runtime.enable", {}, readinessTimeout());
            }
            const result = await send("Runtime.evaluate", {
              expression: documentExpression,
              returnByValue: true,
            }, readinessTimeout());
            if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
            return result.result?.result?.value;
          },
        });
        await sleep(Math.max(0, ALIVE_WAIT_MS - (Date.now() - startedAt)));
        if (child.exitCode === null && child.pid) ok(`存活至少 ${ALIVE_WAIT_MS / 1000}s（pid=${child.pid}，exitCode=null）`);
        else fail(`进程提前退出（exitCode=${child.exitCode}，signal=${child.signalCode}）`);
        const r = await send("Runtime.evaluate", {
          expression: documentExpression,
          returnByValue: true,
        });
        const finalDocument = r.result?.result?.value;
        const documentTitle = finalDocument?.title;
        if (typeof documentTitle === "string" && documentTitle.toLowerCase().includes(PRODUCT_NAME.toLowerCase())) {
          ok(`renderer 加载成功：document.title="${documentTitle}" url=${finalDocument.url}`);
        } else {
          fail(`renderer document.title="${String(documentTitle ?? "")}" 不含 "${PRODUCT_NAME}"`);
        }
        const children = finalDocument?.children;
        if (typeof children === "number" && children > 0) {
          ok(`renderer 挂载非空：#app 子元素 ${children} 个`);
        } else {
          fail(`renderer 挂载为空（#app 子元素 ${children}）——渲染层模块求值期崩溃`);
        }
      } catch (e) {
        fail(`挂载非空检查未执行：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        ws?.close();
      }
  }
} finally {
  settled = true;
  clearTimeout(timeout);
  killTree(child);
  await sleep(1_000); // 给 taskkill 一点收尾时间，避免进程残留
}

console.log(failures.length === 0 ? "打包冒烟全部通过" : `打包冒烟失败 ${failures.length} 项`);
if (failures.length === 0) {
  const resolvedTemp = realpathSync(temporaryRoot);
  const tempStat = lstatSync(resolvedTemp);
  if (dirname(resolvedTemp) === systemTempRoot && tempStat.isDirectory() && !tempStat.isSymbolicLink()
    && /^apicc-smoke-dir-[a-z0-9-]+$/i.test(resolvedTemp.slice(systemTempRoot.length + 1))) {
    rmSync(resolvedTemp, { recursive: true, force: false });
  } else {
    console.error(`安全检查失败，保留冒烟临时根：${temporaryRoot}`);
    process.exit(1);
  }
} else {
  console.error(`失败现场临时根保留：${temporaryRoot}`);
}
process.exit(failures.length === 0 ? 0 : 1);
