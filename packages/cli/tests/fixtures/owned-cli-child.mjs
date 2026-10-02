import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];

if (mode === "normal") {
  process.stdout.write("owned-child-stdout\n");
  process.stderr.write("owned-child-stderr\n");
  process.exitCode = 0;
} else if (mode === "exit-after-output") {
  const writeOutputAndExit = () => {
    process.stdout.write("exit-before-close-stdout\n");
    process.stdout.write("tail-after-exit-stdout\n".repeat(1024));
    process.stderr.write("exit-before-close-stderr\n");
    process.stderr.write("tail-after-exit-stderr\n".repeat(1024));
    process.exitCode = 0;
  };
  const releaseFile = process.env.OWNED_CLI_RELEASE_FILE;
  if (!releaseFile) {
    writeOutputAndExit();
  } else {
    process.stdout.write("EXIT-BARRIER-READY\n");
    const releaseTimer = setInterval(() => {
      if (!existsSync(releaseFile)) return;
      clearInterval(releaseTimer);
      writeOutputAndExit();
    }, 5);
  }
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "ready-wait") {
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
} else if (mode === "ready-late-action") {
  process.stdout.write("READY\n");
  setTimeout(() => appendFileSync(join(process.cwd(), "late-action.txt"), "late-action\n"), 100);
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(64 * 1024));
  setInterval(() => {}, 1000);
} else {
  throw new Error(`unsupported fixed fixture mode: ${String(mode)}`);
}
