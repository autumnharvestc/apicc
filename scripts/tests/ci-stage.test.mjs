import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runStage } from '../ci-stage.mjs';

const probe = 'const fs=require("node:fs"); fs.appendFileSync(process.argv[1], process.argv[2]+"\\n"); if(process.argv[3]==="fail") process.exit(7)';
function actualRunner(log, failAt = -1) {
  let count = 0;
  return async (file, args) => {
    const line = [file, ...args].join(' ');
    const result = spawnSync(process.execPath, ['-e', probe, log, line, count++ === failAt ? 'fail' : 'pass'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`probe exit ${result.status}: ${result.stderr}`);
  };
}
async function withLog(run) {
  const dir = await mkdtemp(join(tmpdir(), 'apicc-ci88-stage-'));
  try { await run(join(dir, 'commands.log')); }
  finally {
    const resolved = resolve(dir);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
}

test('Linux test starts from a frozen install and stops at the first failed command', async () => {
  await withLog(async log => {
    await assert.rejects(runStage('linux-test', { run: actualRunner(log, 1) }), /probe exit 7/);
    const seen = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
    assert.equal(seen[0], 'pnpm install --frozen-lockfile');
    assert.equal(seen.length, 2);
  });
});

test('CI stage plans execute their required observable checks', async () => {
  const expected = {
    'linux-test': ['pnpm install --frozen-lockfile', 'pnpm -C packages/plugin-sdk typecheck', 'docker build --pull -f Dockerfile.agent -t apicc-f7b-t11-agent:candidate .', 'pnpm -r --workspace-concurrency=1 test --maxWorkers=2'],
    'linux-server': ['pnpm install --frozen-lockfile', 'node apps/collaboration-runtime/scripts/generate-java-boundary.mjs --check', 'mvn -s server/.mvn/settings.xml -f server/pom.xml test'],
    brand: ['node scripts/check-brand-neutral.mjs --self-check', 'node scripts/check-brand-neutral.mjs --include-untracked'],
    'windows-package': ['pnpm install --frozen-lockfile', 'pnpm -C apps/desktop dist:dir', 'pnpm -C apps/desktop smoke:dir'],
    deployment: ['docker build --pull -t apicc-server:local .', 'docker build --pull -f Dockerfile.collaboration -t apicc-collaboration:local .', 'docker build --pull -f Dockerfile.agent -t apicc-runner-agent:local .', 'node scripts/smoke-runner-agent.mjs', 'node scripts/smoke-collaboration.mjs'],
  };
  for (const [stage, mustRun] of Object.entries(expected)) {
    await withLog(async log => {
      await runStage(stage, { run: actualRunner(log) });
      const seen = (await readFile(log, 'utf8')).trim().split(/\r?\n/);
      let previous = -1;
      for (const command of mustRun) {
        const index = seen.indexOf(command);
        assert.ok(index > previous, `${stage}: missing or out of order ${command}`);
        previous = index;
      }
    });
  }
});

test('unknown stage cannot pass', async () => {
  await assert.rejects(runStage('unknown'), /Unknown CI stage/);
});
