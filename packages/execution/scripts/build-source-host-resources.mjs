import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const source = fileURLToPath(new URL('../src/source-host/owned-process.cs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function buildSourceHostResources(options) {
  await mkdir(options.outputDirectory, { recursive: true });
  await copyFile(source, join(options.outputDirectory, 'owned-process.cs'));
  if (options.platform !== 'win32') return;
  const powershell = options.powershellPath || 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!isAbsolute(powershell)) throw new Error('absolute build compiler path required');
  const temporary = await mkdtemp(join(resolve(options.outputDirectory), '.owned-helper-build-'));
  try {
    const executable = join(temporary, 'owned-process.exe');
    const bootstrap = '$ErrorActionPreference="Stop"; Add-Type -Path $env:APICC_BUILD_HELPER_SOURCE -OutputAssembly $env:APICC_BUILD_HELPER_OUTPUT -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions,System,System.Core';
    await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, TEMP: temporary, TMP: temporary, APICC_BUILD_HELPER_SOURCE: source, APICC_BUILD_HELPER_OUTPUT: executable } });
    const bytes = await readFile(executable);
    await copyFile(executable, join(options.outputDirectory, 'owned-process.exe'));
    await writeFile(join(options.outputDirectory, 'owned-process.resource.json'), JSON.stringify({ formatVersion: 1, sourceSha256: sha256(await readFile(source)), executableSha256: sha256(bytes) }) + '\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildSourceHostResources({ outputDirectory: fileURLToPath(new URL('../dist/source-host/', import.meta.url)), platform: process.platform });
