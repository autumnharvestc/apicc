// 打包冒烟脚本（任务 9 五级冒烟的入库简化版，宽审查修复 4）：
//   1. 存活：spawn release/win-unpacked/apicc.exe，8 秒后探活（未退出 = 存活）
//   2. 输出：stderr/stdout 扫 FATAL / Cannot find module / ERR_MODULE_NOT_FOUND
//   3. 加载标题：CDP /json/list 轮询，断言 renderer 页 title=apicc 且 url 指向 asar 内 dist-renderer
// 取舍：原临时脚本的层级 4（Runtime.evaluate 读 window.apicc 桥接频道）与层级 5
// （wsOpen/treeGet E2E IPC）依赖 CDP 长连接驱动，属一次性深检，不入库；
// 本脚本覆盖打包产物「能起、无致命错、renderer 加载成功」三道底线，日常回归够用。
// 前置：先执行 `pnpm -C apps/desktop dist:dir` 产出 release/win-unpacked/。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const exePath = join(desktopDir, "release", "win-unpacked", "apicc.exe");
const PRODUCT_NAME = "apicc";
const ALIVE_WAIT_MS = 8_000;
const CDP_TIMEOUT_MS = 20_000;
const CDP_INTERVAL_MS = 500;

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
  console.error(`未找到打包产物 ${exePath}——请先执行 pnpm -C apps/desktop dist:dir`);
  process.exit(1);
}

const port = await pickFreePort();
const child = spawn(exePath, [`--remote-debugging-port=${port}`], { windowsHide: true });
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
  // —— 1. 存活：等待 8 秒后进程仍未退出 ——
  await sleep(ALIVE_WAIT_MS);
  if (child.exitCode === null && child.pid) {
    ok(`存活 ${ALIVE_WAIT_MS / 1000}s（pid=${child.pid}，exitCode=null）`);
  } else {
    fail(`进程提前退出（exitCode=${child.exitCode}，signal=${child.signalCode}）`);
  }

  // —— 2. 无 FATAL：启动输出无致命错误关键字 ——
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
    let cdpError = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = (await res.json()).filter((t) => t.type === "page");
        const page = list.find((t) => String(t.url).includes("dist-renderer/index.html"));
        if (page) {
          targets = page;
          break;
        }
      } catch (e) {
        cdpError = e instanceof Error ? e.message : String(e);
      }
      await sleep(CDP_INTERVAL_MS);
    }
    if (!targets) {
      fail(`${CDP_TIMEOUT_MS / 1000}s 内未在 CDP 发现 dist-renderer 页面${cdpError ? `（${cdpError}）` : ""}`);
    } else {
      if (String(targets.title).includes(PRODUCT_NAME)) {
        ok(`renderer 加载成功：title="${targets.title}" url=${targets.url}`);
      } else {
        fail(`renderer 页 title="${targets.title}" 不含 "${PRODUCT_NAME}"`);
      }
      // —— 4. 挂载非空：title 只证 index.html，渲染层模块求值崩溃（如 native 面误入渲染
      // bundle）会让 #app 空白而 title 照常——本检查由 2026-09-06 用户白屏报告引入。
      try {
        const ws = new WebSocket(targets.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.onopen = r;
          ws.onerror = () => j(new Error("CDP WebSocket 连接失败"));
        });
        let mid = 0;
        const pending = new Map();
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        };
        const send = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const myId = ++mid;
            pending.set(myId, resolve);
            ws.send(JSON.stringify({ id: myId, method, params }));
            setTimeout(() => {
              if (pending.has(myId)) { pending.delete(myId); reject(new Error("CDP evaluate 超时")); }
            }, 5000);
          });
        await send("Runtime.enable");
        const r = await send("Runtime.evaluate", {
          expression: "document.querySelector('#app')?.children.length ?? -1",
          returnByValue: true,
        });
        const children = r.result?.result?.value;
        if (typeof children === "number" && children > 0) {
          ok(`renderer 挂载非空：#app 子元素 ${children} 个`);
        } else {
          fail(`renderer 挂载为空（#app 子元素 ${children}）——渲染层模块求值期崩溃`);
        }
        ws.close();
      } catch (e) {
        fail(`挂载非空检查未执行：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
} finally {
  settled = true;
  clearTimeout(timeout);
  killTree(child);
  await sleep(1_000); // 给 taskkill 一点收尾时间，避免进程残留
}

console.log(failures.length === 0 ? "打包冒烟全部通过" : `打包冒烟失败 ${failures.length} 项`);
process.exit(failures.length === 0 ? 0 : 1);
