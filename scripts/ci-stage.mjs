import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const command = (file, ...args) => ({ file, args });
const pnpm = (...args) => command('pnpm', ...args);
const node = (...args) => command('node', ...args);
const docker = (...args) => command('docker', ...args);
const build = (pkg) => pnpm('-C', pkg, 'build');
const typecheck = (pkg) => pnpm('-C', pkg, 'typecheck');
const shared = [
  build('packages/plugin-sdk'), typecheck('packages/plugin-sdk'),
  build('packages/core'), typecheck('packages/core'),
  build('packages/execution'), typecheck('packages/execution'),
  pnpm('-C', 'packages/execution', 'check:java-input-schema'),
  build('apps/collaboration-runtime'), typecheck('apps/collaboration-runtime'),
  node('apps/collaboration-runtime/scripts/generate-java-boundary.mjs', '--check'),
  build('apps/share-viewer'), typecheck('apps/share-viewer'),
];
const serverPrerequisites = [
  build('packages/plugin-sdk'), build('packages/core'), build('packages/execution'),
  pnpm('-C', 'packages/execution', 'check:java-input-schema'),
  build('apps/collaboration-runtime'), typecheck('apps/collaboration-runtime'),
  node('apps/collaboration-runtime/scripts/generate-java-boundary.mjs', '--check'),
  build('apps/share-viewer'), typecheck('apps/share-viewer'),
];
const stages = {
  'linux-test': [
    pnpm('install', '--frozen-lockfile'), ...shared,
    build('apps/runner-agent'), typecheck('apps/runner-agent'),
    build('apps/desktop'), build('apps/admin-web'),
    build('packages/cli'), typecheck('packages/cli'),
    node('--test', 'scripts/tests/f7f-acceptance.test.mjs'),
    node('--test', 'scripts/tests/ci-stage.test.mjs'),
    docker('build', '--pull', '-f', 'Dockerfile.agent', '-t', 'apicc-f7b-t11-agent:candidate', '.'),
    pnpm('-r', '--workspace-concurrency=1', 'test', '--maxWorkers=2'),
  ],
  'linux-server': [
    pnpm('install', '--frozen-lockfile'), ...serverPrerequisites,
    { ...command('mvn', '-s', 'server/.mvn/settings.xml', '-f', 'server/pom.xml', 'test'), env: { APICC_TEST_NODE: process.execPath } },
  ],
  brand: [
    node('scripts/check-brand-neutral.mjs', '--self-check'),
    node('--test', 'scripts/tests/check-brand-neutral.test.mjs'),
    node('scripts/check-brand-neutral.mjs', '--include-untracked'),
  ],
  'windows-package': [
    pnpm('install', '--frozen-lockfile'),
    node('--test', 'scripts/tests/pre-push-ci.test.mjs'),
    { ...node('node_modules/electron/install.js'), cwd: resolve(root, 'apps/desktop'), env: { ELECTRON_MIRROR: 'https://github.com/electron/electron/releases/download/' } },
    build('packages/plugin-sdk'), typecheck('packages/plugin-sdk'),
    build('packages/core'), build('packages/execution'),
    pnpm('-C', 'packages/execution', 'check:java-input-schema'),
    build('apps/collaboration-runtime'), typecheck('apps/collaboration-runtime'),
    node('apps/collaboration-runtime/scripts/generate-java-boundary.mjs', '--check'),
    build('apps/share-viewer'), typecheck('apps/share-viewer'),
    build('apps/runner-agent'), build('apps/admin-web'), build('packages/cli'),
    pnpm('-C', 'apps/desktop', 'gen:icon'),
    pnpm('-C', 'apps/desktop', 'dist:dir'),
    pnpm('-C', 'apps/desktop', 'smoke:dir'),
  ],
  deployment: [
    docker('build', '--pull', '-t', 'apicc-server:local', '.'),
    docker('build', '--pull', '-f', 'Dockerfile.collaboration', '-t', 'apicc-collaboration:local', '.'),
    docker('build', '--pull', '-f', 'Dockerfile.agent', '-t', 'apicc-runner-agent:local', '.'),
    node('scripts/smoke-runner-agent.mjs'),
    { ...node('scripts/smoke-collaboration.mjs'), env: { APICC_F7F_SERVER_IMAGE: 'apicc-server:local', APICC_F7F_RUNTIME_IMAGE: 'apicc-collaboration:local' } },
  ],
};

function runCommand(file, args, options = {}) {
  const windowsPnpm = process.platform === 'win32' && file === 'pnpm';
  if (windowsPnpm && args.some(arg => !/^[A-Za-z0-9@./:_=!+-]+$/.test(arg))) {
    throw new Error('Unsafe pnpm argument for Windows command shell');
  }
  const result = spawnSync(windowsPnpm ? 'cmd.exe' : file, windowsPnpm ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, npm_config_verify_deps_before_run: 'false', ...options.env },
    stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed (exit ${result.status ?? result.signal})`);
}

export async function runStage(name, { run = runCommand } = {}) {
  const steps = stages[name];
  if (!steps) throw new Error(`Unknown CI stage: ${name}`);
  for (const { file, args, ...options } of steps) {
    console.log(`[CI ${name}] ${file} ${args.join(' ')}`);
    await run(file, args, options);
  }
  console.log(`[CI ${name}] passed (${steps.length} commands)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = process.argv[2];
  runStage(stage).catch(error => { console.error(`[CI ${stage}] FAILED: ${error.message}`); process.exitCode = 1; });
}
