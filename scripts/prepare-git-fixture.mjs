// Each fresh Linux job owns this prerequisite. No cached-image success or silent skip.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw Error(`GIT_FIXTURE_PREREQUISITE: ${command} exit=${result.status}; ${result.error?.code ?? ''}`);
};
run('git', ['--version']); run('ssh', ['-V']); run('docker', ['info', '--format', '{{.ServerVersion}}']);
run('docker', ['build', '--pull', '-f', 'packages/execution/tests/sourceHost/git-fixture.Dockerfile', '-t', process.env.APICC_GIT_FIXTURE_IMAGE ?? 'apicc-f7g-ssh-fixture:node22', '.']);
run('docker', ['run', '--rm', '--init', '--network', 'none', '--entrypoint', 'sh', process.env.APICC_GIT_FIXTURE_IMAGE ?? 'apicc-f7g-ssh-fixture:node22', '-c', 'set -eu; git --version; ssh -V; test -x /usr/sbin/sshd; test -x /usr/bin/tini; node --version']);
