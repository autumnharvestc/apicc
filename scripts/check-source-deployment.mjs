import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deployment arithmetic only. These are not new Core/RPC budgets: the tmpfs is
// charged alongside the unchanged application partition to the actual cgroup.
export function validateSourceDeployment(config) {
  const service = config.services?.collaboration;
  const integer = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : NaN;
  const applicationBytes = integer(service?.environment?.APICC_COLLABORATION_RUNTIME_TOTAL_MEMORY_BYTES);
  const cgroupBytes = integer(service?.mem_limit);
  const mount = service?.tmpfs?.find(value => typeof value === 'string' && value.startsWith('/var/lib/apicc-sources:'));
  const options = mount?.split(':').at(-1).split(',') ?? [];
  const storageBytes = integer(options.find(value => value.startsWith('size='))?.slice(5));
  if (![applicationBytes, cgroupBytes, storageBytes].every(Number.isSafeInteger) || cgroupBytes - applicationBytes < storageBytes) throw Error('SOURCE_DEPLOYMENT_MEMORY: cgroup must cover application partition plus private tmpfs');
  if (!['uid=1000', 'gid=1000', 'mode=0700', 'nosuid', 'nodev', 'exec'].every(value => options.includes(value)) || options.includes('noexec')) throw Error('SOURCE_DEPLOYMENT_STORAGE: private bounded executable helper root required');
  if (service.read_only !== true || service.init !== true || service.user !== '1000:1000' || service.ports?.length) throw Error('SOURCE_DEPLOYMENT_BOUNDARY');
  return { applicationBytes, storageBytes, cgroupBytes };
}
export function renderSourceDeployment(args, env = process.env) {
  return JSON.parse(execFileSync('docker', ['compose', ...args, 'config', '--format', 'json'], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1048576 }));
}
export function startSourceDeployment(args, env = process.env) {
  const config = renderSourceDeployment(args, env), facts = validateSourceDeployment(config);
  const output = execFileSync('docker', ['compose', ...args, 'up', '-d', '--no-build'], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1048576 });
  return { config, facts, output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), up = args.includes('--up'), composeArgs = args.filter(value => value !== '--up');
    const facts = up ? startSourceDeployment(composeArgs).facts : validateSourceDeployment(renderSourceDeployment(composeArgs));
    console.log('SOURCE_DEPLOYMENT_CONFIGURATION_READY ' + JSON.stringify(facts));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
