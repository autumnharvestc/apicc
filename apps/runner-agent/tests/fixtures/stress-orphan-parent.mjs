import { fork } from "node:child_process";
const child = fork(new URL("./stress-orphan-worker.mjs", import.meta.url), process.argv.slice(2), { execPath: process.execPath, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", value => process.send?.(value));
