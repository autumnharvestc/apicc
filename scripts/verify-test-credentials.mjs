#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const coreRequire = createRequire(join(repoRoot, 'packages/core/package.json'));
const desktopRequire = createRequire(join(repoRoot, 'apps/desktop/package.json'));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function syntheticValue(namespace, revision) {
  return `apicc-f1-verification:${namespace}:${revision}`;
}

function isMissingPassword(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') throw new TypeError('invalid_password_type');
  return false;
}

function runtime() {
  return {
    execPath: process.execPath,
    node: process.version,
    electron: process.versions.electron ?? null,
    napi: process.versions.napi ?? null,
    type: process.type ?? null,
    platform: process.platform,
    arch: process.arch,
  };
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function createTemporaryElectronApp() {
  const appPath = mkdtempSync(join(tmpdir(), 'apicc-task3-electron-'));
  const packageManifest = {
    name: 'apicc-task3-electron-admission',
    version: '1.0.0',
    private: true,
    main: 'main.cjs',
  };
  const mainSource = [
    "'use strict';",
    "const { app } = require('electron');",
    "const { pathToFileURL } = require('node:url');",
    'function runtime() { return { execPath: process.execPath, node: process.version, electron: process.versions.electron ?? null, napi: process.versions.napi ?? null, type: process.type ?? null, platform: process.platform, arch: process.arch }; }',
    "function stage(name, details = {}) { process.stderr.write(JSON.stringify({ probeStage: name, runtime: runtime(), ...details }) + '\\n'); }",
    "app.on('window-all-closed', () => {});",
    "process.env.APICC_TASK3_ELECTRON_PROBE = '1';",
    'const [mode, role, namespace] = process.argv.slice(2);',
    'const verifierPath = process.env.APICC_TASK3_VERIFIER_PATH;',
    "stage('entry', { modeIsChild: mode === '--child' });",
    'app.whenReady().then(async () => {',
    "  stage('ready');",
    "  if (mode !== '--child' || !verifierPath) throw new Error('invalid_probe_arguments');",
    '  const { runChild } = await import(pathToFileURL(verifierPath).href);',
    '  await runChild(role, namespace);',
    '}).catch((error) => {',
    "  stage('entry-failure', { failureType: error.name });",
    '  process.exitCode = 1;',
    '  app.quit();',
    '});',
  ].join('\n');

  try {
    writeFileSync(join(appPath, 'package.json'), JSON.stringify(packageManifest), { encoding: 'utf8', flag: 'wx' });
    writeFileSync(join(appPath, 'main.cjs'), mainSource, { encoding: 'utf8', flag: 'wx' });
    return appPath;
  } catch (error) {
    removeTemporaryElectronApp(appPath);
    throw error;
  }
}

function removeTemporaryElectronApp(appPath) {
  const tempRoot = realpathSync(tmpdir());
  const resolvedPath = resolve(appPath);
  const entry = lstatSync(resolvedPath);
  if (realpathSync(dirname(resolvedPath)) !== tempRoot
    || !basename(resolvedPath).startsWith('apicc-task3-electron-')
    || !entry.isDirectory()
    || entry.isSymbolicLink()) {
    throw new Error('unsafe_electron_temp_cleanup_target');
  }
  rmSync(resolvedPath, { recursive: true, force: false });
}

function probeStage(stage, details = {}) {
  if (!process.versions.electron) return;
  process.stderr.write(`${JSON.stringify({ probeStage: stage, runtime: runtime(), ...details })}\n`);
}

export async function runChild(role, namespace) {
  if (!uuidPattern.test(namespace)) throw new Error('invalid_namespace');
  let app = null;
  const isElectron = Boolean(process.versions.electron);
  const lifecycle = {
    entryExecuted: true,
    whenReady: false,
    nativeLoaded: false,
    nativeCallCompleted: false,
  };
  let result;

  probeStage('entry');
  try {
    if (isElectron) {
      const scriptRequire = createRequire(import.meta.url);
      const scriptCanResolveElectron = (() => {
        try {
          scriptRequire.resolve('electron');
          return true;
        } catch {
          return false;
        }
      })();
      const desktopCanResolveElectron = (() => {
        try {
          desktopRequire.resolve('electron');
          return true;
        } catch {
          return false;
        }
      })();
      probeStage('electron-module-resolution', { scriptCanResolveElectron, desktopCanResolveElectron });
      probeStage('electron-api-require-start');
      const electronApi = scriptRequire('electron');
      probeStage('electron-api-require-complete', {
        apiType: typeof electronApi,
        hasApp: Boolean(electronApi && typeof electronApi === 'object' && electronApi.app),
      });
      app = electronApi?.app ?? null;
      if (!app) throw new Error('electron_app_api_missing');
      app.once('before-quit', () => probeStage('before-quit-event'));
      app.once('will-quit', () => probeStage('will-quit-event'));
      probeStage('when-ready-start', { isReady: app.isReady() });
      app.once('ready', () => probeStage('ready-event'));
      let readyTimeout;
      try {
        await Promise.race([
          app.whenReady(),
          new Promise((_, reject) => {
            readyTimeout = setTimeout(() => reject(new Error('electron_ready_timeout')), 5_000);
          }),
        ]);
      } finally {
        clearTimeout(readyTimeout);
      }
      lifecycle.whenReady = true;
      probeStage('when-ready-complete', { isReady: app.isReady() });
    }

    probeStage('native-load-start');
    const { AsyncEntry } = coreRequire('@napi-rs/keyring');
    lifecycle.nativeLoaded = true;
    probeStage('native-load-complete');
    const entry = new AsyncEntry(`apicc-f1-verification-${namespace}`, `account-${namespace}`);
    probeStage('native-call-start', { role });

    if (role === 'save') {
      await entry.setPassword(syntheticValue(namespace, 'initial'));
      result = { saved: true };
    } else if (role === 'read') {
      result = { matched: (await entry.getPassword()) === syntheticValue(namespace, 'initial') };
    } else if (role === 'replace-delete') {
      await entry.setPassword(syntheticValue(namespace, 'replacement'));
      const replacementMatched = (await entry.getPassword()) === syntheticValue(namespace, 'replacement');
      const deleted = await entry.deleteCredential();
      result = { replacementMatched, deleted };
    } else if (role === 'verify-missing') {
      const value = await entry.getPassword();
      const idempotentDelete = await entry.deleteCredential();
      const missing = isMissingPassword(value);
      result = {
        missing,
        missingUndefined: value === undefined,
        missingNull: value === null,
        missingType: value === null ? 'null' : value === undefined ? 'undefined' : typeof value,
        idempotentDelete: idempotentDelete === false,
      };
    } else if (role === 'cleanup') {
      const value = await entry.getPassword();
      if (!isMissingPassword(value)) await entry.deleteCredential();
      const remaining = await entry.getPassword();
      result = { clean: isMissingPassword(remaining) };
    } else {
      throw new Error('unknown_role');
    }

    lifecycle.nativeCallCompleted = true;
    probeStage('native-call-complete', { role });
  } catch (error) {
    process.exitCode = 1;
    const payload = { role, runtime: runtime(), lifecycle, failureType: error.name };
    probeStage('operation-failed', { failureType: error.name });
    if (app) {
      app.once('will-quit', () => {
        probeStage('will-quit');
        emit({ ...payload, lifecycle: { ...lifecycle, willQuit: true } });
      });
      probeStage('quit-requested');
      app.quit();
    } else {
      emit(payload);
      if (isElectron) process.exit(1);
    }
    return;
  }

  const payload = { role, runtime: runtime(), lifecycle, ...result };
  if (app) {
    app.once('will-quit', () => {
      probeStage('will-quit');
      emit({ ...payload, lifecycle: { ...lifecycle, willQuit: true } });
    });
    probeStage('quit-requested');
    app.quit();
  } else {
    emit(payload);
  }
}

function launch(executable, args, label, extraEnv = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, extraEnv);
  const child = spawnSync(executable, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  const stderrText = typeof child.stderr === 'string' ? child.stderr : '';
  const stdoutText = typeof child.stdout === 'string' ? child.stdout : '';
  const stderrStages = stderrText.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.probeStage ? [{ stage: parsed.probeStage, runtime: parsed.runtime, details: Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'probeStage' && key !== 'runtime')) }] : [];
    } catch {
      return [];
    }
  });
  if (child.error) return { ok: false, label, error: child.error.name, errorCode: child.error.code ?? null, stderrStages };
  if (child.status !== 0) return { ok: false, label, exitCode: child.status, signal: child.signal ?? null, stderrStages };
  const lines = stdoutText.trim().split(/\r?\n/);
  try {
    const payload = JSON.parse(lines.at(-1));
    return { ok: true, label, payload, stderrStages };
  } catch {
    return { ok: false, label, exitCode: child.status, outputValid: false, stderrStages };
  }
}

async function run() {
  const [mode, engine] = process.argv.slice(2);
  if (mode === '--child') {
    await runChild(process.argv[3], process.argv[4]);
    return;
  }
  if (mode === '--probe-spawn-failure') {
    const temporaryAppPath = createTemporaryElectronApp();
    let result;
    try {
      result = launch(join(temporaryAppPath, 'missing-electron.exe'), [], 'missing-executable');
    } finally {
      removeTemporaryElectronApp(temporaryAppPath);
    }
    emit({
      probe: 'spawn-failure',
      result: {
        ok: result.ok,
        label: result.label,
        error: result.error ?? null,
        errorCode: result.errorCode ?? null,
        stderrStages: result.stderrStages,
      },
      temporaryAppClean: true,
    });
    if (result.ok || result.errorCode !== 'ENOENT') process.exitCode = 1;
    return;
  }
  if (mode !== '--run' || !['node', 'electron'].includes(engine)) {
    throw new Error('usage: verify-test-credentials.mjs --run node|electron | --probe-spawn-failure');
  }

  const id = randomUUID();
  let executable;
  let childPrefix;
  let electronAppPath = null;
  let electronAppClean = engine !== 'electron';
  let expectedElectron = null;
  let expectedNodeMajor = null;
  const childEnv = {};

  if (engine === 'node') {
    executable = process.execPath;
    childPrefix = [scriptPath, '--child'];
    expectedNodeMajor = Number(process.argv[4]);
    if (!expectedNodeMajor || Number(process.versions.node.split('.')[0]) !== expectedNodeMajor) {
      throw new Error('node_runtime_mismatch');
    }
  } else {
    executable = join(repoRoot, 'apps/desktop/node_modules/electron/dist/electron.exe');
    expectedElectron = desktopRequire('electron/package.json').version;
    electronAppPath = createTemporaryElectronApp();
    childPrefix = [electronAppPath, '--child'];
    childEnv.APICC_TASK3_VERIFIER_PATH = scriptPath;
  }

  const roles = [
    ['process-a-save', 'save'],
    ['process-b-read', 'read'],
    ['process-c-replace-delete', 'replace-delete'],
    ['process-d-missing', 'verify-missing'],
  ];
  const evidence = [];
  let cleanup = null;

  try {
    for (const [label, role] of roles) {
      const result = launch(executable, [...childPrefix, role, id], label, childEnv);
      evidence.push(result);
      if (!result.ok) break;
    }
  } finally {
    try {
      cleanup = launch(executable, [...childPrefix, 'cleanup', id], 'cleanup', childEnv);
    } finally {
      if (electronAppPath) {
        removeTemporaryElectronApp(electronAppPath);
        electronAppClean = true;
      }
    }
  }

  const roleNames = roles.map(([, role]) => role);
  const successful = evidence.length === roles.length && evidence.every((item, index) => {
    if (!item.ok) return false;
    const payload = item.payload;
    if (engine === 'node' && Number(payload.runtime.node.replace(/^v/, '').split('.')[0]) !== expectedNodeMajor) return false;
    if (engine === 'electron' && payload.runtime.electron !== expectedElectron) return false;
    if (engine === 'electron' && (!payload.lifecycle?.entryExecuted || !payload.lifecycle?.whenReady
      || !payload.lifecycle?.nativeLoaded || !payload.lifecycle?.nativeCallCompleted || !payload.lifecycle?.willQuit)) return false;
    if (payload.role !== roleNames[index]) return false;
    if (roleNames[index] === 'save') return payload.saved === true;
    if (roleNames[index] === 'read') return payload.matched === true;
    if (roleNames[index] === 'replace-delete') return payload.replacementMatched === true && payload.deleted === true;
    return payload.missing === true && payload.idempotentDelete === true;
  });

  emit({
    engine,
    runner: runtime(),
    expectedNodeMajor,
    expectedElectron,
    crossProcessRoundTrip: successful,
    cleanup: cleanup?.ok && cleanup.payload?.clean === true,
    electronAppClean,
    steps: evidence.map((item) => ({
      ok: item.ok,
      label: item.label,
      exitCode: item.exitCode ?? 0,
      error: item.error ?? null,
      outputValid: item.outputValid ?? true,
      runtime: item.payload?.runtime ?? null,
      stderrStages: item.stderrStages ?? [],
      result: item.payload ? Object.fromEntries(Object.entries(item.payload).filter(([key]) => key !== 'runtime' && key !== 'role')) : null,
    })),
  });

  if (!successful || !cleanup?.ok || cleanup.payload?.clean !== true || !electronAppClean) process.exitCode = 1;
}

if (process.env.APICC_TASK3_ELECTRON_PROBE !== '1'
  && process.argv[1]
  && resolve(process.argv[1]) === resolve(scriptPath)) {
  run().catch((error) => {
    emit({ error: error.name, code: error.message });
    process.exitCode = 1;
  });
}
