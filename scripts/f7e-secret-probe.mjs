// Run with the candidate Electron, no BrowserWindow and a fresh synthetic root.
// An optional module path binds the same probe to unpacked/packaged resources.
import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const repo = resolve(import.meta.dirname, '..');
const root = process.env.APICC_F7E_SECRET_PROBE_ROOT && resolve(process.env.APICC_F7E_SECRET_PROBE_ROOT);
const modulePath = resolve(process.env.APICC_F7E_AI_PROBE_MODULE ?? join(repo, 'apps/desktop/dist-electron/main/ai/personal.js'));
if (!root || existsSync(root)) throw Error('A new explicit synthetic probe directory is required');
mkdirSync(root, { recursive: true }); app.setPath('userData', join(root, 'electron-profile'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = directory => readdirSync(directory).flatMap(name => { const file = join(directory, name); return statSync(file).isDirectory() ? files(file) : [file]; });
app.whenReady().then(async () => {
  const { createDesktopAiPersonal } = await import(pathToFileURL(modulePath).href);
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Real candidate secure storage unavailable');
  const privateRoot = join(root, 'ai');
  const personal = createDesktopAiPersonal({ privateRoot, storage: safeStorage });
  const owner = {};
  let view = await personal.read();
  const connection = { id: 'synthetic-secure-probe', revision: 1, name: 'Synthetic secure storage probe', owner: { kind: 'personal' }, baseUrl: 'https://synthetic.invalid/v1', protocols: ['openai-chat-completions'], auth: { kind: 'bearer' }, headers: {} };
  view = await personal.write({ operation: 'connection', connection, expectedRevision: view.revision }, owner);
  const secret = 'f7e-new-synthetic-value-' + process.pid;
  view = await personal.write({ operation: 'credential', connectionId: connection.id, value: secret, mode: 'persistent', expectedRevision: view.revision }, owner);
  const snapshot = await personal.host.snapshot();
  const stored = snapshot.document.connections.find(item => item.id === connection.id);
  assert.ok(stored.credentialRef);
  const reopened = createDesktopAiPersonal({ privateRoot, storage: safeStorage });
  const credentials = await reopened.host.credentialResolver.resolve(stored);
  assert.equal(new Headers(credentials.headers).get('authorization') === 'Bearer ' + secret, true, 'Synthetic credential roundtrip failed');
  assert.equal(await reopened.backend.get(stored.credentialRef, 'wrong-audience'), undefined);
  assert.ok(!JSON.stringify(view).includes(secret));
  assert.ok(!JSON.stringify(view).includes(stored.credentialRef));
  assert.ok(!Object.hasOwn(view.connections[0], 'credentialRef'));
  const persisted = files(privateRoot);
  for (const file of persisted) assert.equal(readFileSync(file).includes(Buffer.from(secret)), false, 'Synthetic key persisted in plaintext');
  const fileRecords = persisted.map(file => ({ file, sha256: hash(file) }));
  view = await reopened.write({ operation: 'connection', connection: { ...connection, baseUrl: 'https://changed-synthetic.invalid/v1' }, expectedRevision: view.revision }, owner);
  const changed = (await reopened.host.snapshot()).document.connections.find(item => item.id === connection.id);
  await assert.rejects(reopened.host.credentialResolver.resolve(changed));
  const result = { at: new Date().toISOString(), pid: process.pid, platform: process.platform, node: process.versions.node, electron: process.versions.electron, modulePath, moduleSha256: hash(modulePath), secureStorageAvailable: true, actualPersistentRoundtrip: true, wrongAudienceRejected: true, addressChangeRejected: true, dtoContainsNoKeyOrReference: true, noPlaintextInPrivateFiles: true, filesBeforeAddressChange: fileRecords };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ root, actualPersistentRoundtrip: true, wrongAudienceRejected: true, addressChangeRejected: true, dtoContainsNoKeyOrReference: true }));
  app.quit();
}).catch(error => { writeFileSync(join(root, 'failure.log'), String(error) + '\n', { flag: 'wx' }); console.error(error); app.exit(1); });
