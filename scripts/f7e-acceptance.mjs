import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Test orchestration only. No automatic builds, UI launch, real profile discovery or cleanup.
const repo = resolve(import.meta.dirname, '..');
const [mode, suppliedRoot] = process.argv.slice(2);
const root = suppliedRoot && resolve(suppliedRoot);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function ownedRoot() {
  if (!root || relative(repo, root).startsWith('..') || isAbsolute(relative(repo, root)) || root === repo) throw Error('Explicit repository evidence child required');
  mkdirSync(root, { recursive: true });
  return root;
}
function snapshot() {
  ownedRoot();
  const git = args => { const child = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }); if (child.status !== 0) throw Error(child.stderr); return child.stdout.trim(); };
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const source = [...new Set(paths)].filter(path => existsSync(join(repo, path))).map(path => ({ path: path.replaceAll('\\', '/'), sha256: sha(readFileSync(join(repo, path))) }));
  const indexPath = resolve(repo, git(['rev-parse', '--git-path', 'index']));
  const result = { at: new Date().toISOString(), repo: realpathSync(repo), head: git(['rev-parse', 'HEAD']), indexSha256: sha(readFileSync(indexPath)), node: process.version, source, sourceManifestSha256: sha(JSON.stringify(source)) };
  json(join(root, 'source.identity.json'), result);
  console.log(JSON.stringify({ root, head: result.head, indexSha256: result.indexSha256, sourceManifestSha256: result.sourceManifestSha256, files: source.length }));
}
export function f7eBusinessPayload(body) {
  const messages = body.messages ?? body.input ?? [];
  let view;
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : message.content?.map(part => part.text ?? '').join('');
    try { const value = JSON.parse(content); if (value.purpose) view = value; } catch { /* connection probe / system prompt */ }
  }
  if (!view && messages.some(message => message.content === 'Return JSON {"ok":true}')) return { ok: true };
  const reportEvidence = view?.purpose === 'report-analysis'
    ? view.evidence.find(item => item.kind === 'execution-identity' && item.state === 'collected')
      ?? view.evidence.find(item => ['case-outcome', 'debug-outcome'].includes(item.kind) && item.state === 'collected')
      ?? view.evidence[0]
    : undefined;
  const evidenceIds = (reportEvidence ? [reportEvidence] : (view?.evidence ?? []).slice(0, 1)).map(item => item.id);
  const assertion = { target: 'status', op: 'eq', expected: '200', path: null, headerName: null, cookieName: null, namespaces: null, match: null, optionsJson: null };
  if (view?.purpose === 'assertion-suggestion') {
    const observation = view.evidence.find(item => item.kind === 'response-status' && item.state === 'collected');
    return { assertions: [{ assertion: observation ? { ...assertion, expected: String(observation.value) } : assertion,
      basis: observation ? 'observation' : 'contract', reason: observation ? '仅此已选观测 / This selected observation only' : '合成契约的成功状态 / Synthetic success status',
      evidenceIds: observation ? [observation.id] : evidenceIds, requiresUserJudgment: !!observation }] };
  }
  if (view?.purpose === 'report-analysis') return { conclusion: '合成报告辅助解读 / Synthetic report analysis', observedFacts: evidenceIds.length ? [{ evidenceIds }] : [], possibleCauses: evidenceIds.length ? [{ text: '可能需要核对请求与逻辑总体 / Check request and logical populations', evidenceIds, confidence: 'possible' }] : [], checks: evidenceIds.length ? [{ text: '定位原报告证据 / Locate original report evidence', evidenceIds }] : [], limitations: ['仅本机替身，不是实际模型判断 / Local stand-in only'] };
  return { cases: [{ name: '合成建议 / Synthetic suggestion ' + '长名称'.repeat(8), scope: 'base', parameters: [], preOperations: [{ type: 'script', content: "pm.variables.set('syntheticReviewOnly', 'review before adopting');" }], postOperations: [], assertions: [assertion], reason: '请人工检查脚本与状态断言 / Review script and status assertion', evidenceIds }] };
}
export function f7eProtocolPayload(protocol, text, model) {
  const usage = { input_tokens: 10, output_tokens: text === '{"ok":true}' ? 3 : 20 };
  if (protocol === 'chat') return { id: 'f7e_chat', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null, annotations: [] }, finish_reason: 'stop', logprobs: null }], usage: { prompt_tokens: 10, completion_tokens: usage.output_tokens, total_tokens: 10 + usage.output_tokens } };
  if (protocol === 'responses') return { id: 'f7e_response', object: 'response', created_at: 1, status: 'completed', model, error: null, incomplete_details: null, output: [{ id: 'f7e_message', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] }], usage: { ...usage, total_tokens: 10 + usage.output_tokens } };
  return { id: 'f7e_message', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage };
}
function events(protocol, text, model) {
  const completed = f7eProtocolPayload(protocol, text, model);
  if (protocol === 'chat') return [{ id: 'f7e_chat', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null, logprobs: null }] }, { id: 'f7e_chat', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }], usage: completed.usage }, '[DONE]'];
  if (protocol === 'responses') return [{ type: 'response.created', sequence_number: 0, response: { ...completed, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { id: 'f7e_message', type: 'message', role: 'assistant', status: 'in_progress', content: [] } }, { type: 'response.content_part.added', sequence_number: 2, output_index: 0, content_index: 0, item_id: 'f7e_message', part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', sequence_number: 3, output_index: 0, content_index: 0, item_id: 'f7e_message', delta: text }, { type: 'response.output_text.done', sequence_number: 4, output_index: 0, content_index: 0, item_id: 'f7e_message', text }, { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: completed.output[0] }, { type: 'response.completed', sequence_number: 6, response: completed }];
  return [{ type: 'message_start', message: { ...completed, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: completed.usage.output_tokens } }, { type: 'message_stop' }];
}
async function serve() {
  ownedRoot();
  if (existsSync(join(root, 'ai-ready.json'))) throw Error('Use a fresh evidence child');
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ object: 'list', data: ['f7e-small', 'f7e-reasoning'].map(id => ({ id, object: 'model', created: 1, owned_by: 'local-synthetic' })) })); return; }
      if (request.method === 'GET' && path === '/health') { response.end('ready'); return; }
      if (path === '/plain' || path === '/hold') { request.resume(); response.setHeader('content-type', 'application/json'); response.end('{"token":"fixed-token"}'); return; }
      const protocol = path === '/v1/chat/completions' ? 'chat' : path === '/v1/responses' ? 'responses' : path === '/v1/messages' ? 'messages' : undefined;
      if (request.method !== 'POST' || !protocol) { response.writeHead(404); response.end('synthetic endpoint not found'); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw Error('Synthetic request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const text = JSON.stringify(f7eBusinessPayload(body)); const model = body.model ?? 'f7e-small';
      appendFileSync(join(root, 'ai-requests.jsonl'), JSON.stringify({ at: new Date().toISOString(), sequence: ++requests, path, protocol, model, stream: body.stream === true, bytes, responseBytes: Buffer.byteLength(text) }) + '\n');
      response.setHeader('x-request-id', `f7e-local-${requests}`);
      if (body.stream) { response.setHeader('content-type', 'text/event-stream'); response.end(events(protocol, text, model).map(event => `${typeof event === 'object' && event.type ? `event: ${event.type}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')); }
      else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(f7eProtocolPayload(protocol, text, model))); }
    } catch (error) { appendFileSync(join(root, 'ai-errors.log'), String(error) + '\n'); if (!response.headersSent) response.writeHead(400); response.end('synthetic request rejected'); }
  });
  const port = process.argv[4] === undefined ? 0 : Number(process.argv[4]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid fixture port');
  await new Promise(resolveListen => { server.once('error', error => { throw error; }); server.listen(port, '127.0.0.1', resolveListen); });
  const ready = { pid: process.pid, startedAt: new Date().toISOString(), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, root, scriptSha256: sha(readFileSync(import.meta.filename)), lifetime: 'until root explicitly releases owned process' };
  json(join(root, 'ai-ready.json'), ready); console.log(JSON.stringify(ready));
  const stop = async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); json(join(root, 'ai-stopped.json'), { pid: process.pid, at: new Date().toISOString(), requests }); };
  process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
}
async function profile() {
  ownedRoot();
  const readyPath = process.argv[4] ? resolve(process.argv[4]) : join(root, 'ai-ready.json');
  const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
  const online = process.argv[5] ? JSON.parse(readFileSync(resolve(process.argv[5]), 'utf8')) : undefined;
  const profileRoot = online?.profile ?? join(root, 'native-profile');
  const isolatedRoot = online?.isolatedRoot ?? join(root, 'native-isolation');
  for (const directory of [profileRoot, isolatedRoot]) {
    const child = relative(repo, resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw Error('Synthetic profile must be an explicit repository child');
  }
  const core = await import(pathToFileURL(join(repo, 'packages/core/dist/index.js')).href);
  const privateRoot = join(isolatedRoot, 'ai');
  if (existsSync(privateRoot)) throw Error('Profile fixture requires fresh AI root');
  const repository = core.createAiConfigRepository({ privateRoot });
  const initial = await repository.read();
  const connection = { id: 'f7e-local', revision: 1, name: '本机合成三协议 / Local synthetic ' + '长名称'.repeat(12), owner: { kind: 'personal' }, baseUrl: ready.baseUrl, protocols: ['openai-chat-completions', 'openai-responses', 'anthropic-messages'], auth: { kind: 'none' }, headers: {}, insecureLocalTest: true };
  const model = (id, protocol, reasoning) => ({ id, revision: 1, connectionId: connection.id, modelId: id, protocol, structuredOutput: 'json-schema', streaming: true, supportedParameters: [], capabilities: { status: 'confirmed', source: 'synthetic fixture declaration', contextWindowTokens: reasoning ? 131072 : 32768, maxInputTokens: reasoning ? 100000 : 20000, maxOutputTokens: reasoning ? 32768 : 16384, sharedContextWindow: true, outputIncludesReasoning: reasoning }, budgets: reasoning ? { maxOutputTokens: 32768, totalOutputTokens: 98304 } : {}, purposeBudgets: {} });
  const models = [model('f7e-small', 'openai-chat-completions', false), model('f7e-reasoning', 'openai-responses', true), model('f7e-anthropic', 'anthropic-messages', false)];
  await repository.write({ ...initial, connections: [connection], models, bindings: ['case-suggestion', 'assertion-suggestion', 'report-analysis'].map(purpose => ({ purpose, modelProfileId: models[0].id, budgets: {} })) }, initial.revision);
  const { semanticProject, semanticIds } = await import(pathToFileURL(join(repo, 'apps/runner-agent/tests/runtime-semantics.mjs')).href);
  const project = semanticProject(ready.baseUrl.replace(/\/v1$/, ''), false);
  project.name = 'F7e 本机合成 / Local synthetic ' + '长名称'.repeat(12);
  project.collections[0].apis[0].contract.request.auth = { kind: 'none' };
  project.collections[0].apis[0].contract.responses = [{ kind: 'inline', id: '30000000-0000-4000-8000-000000000001', status: '200', description: 'Explicit synthetic fixture success response', headers: {}, content: {} }];
  const workspace = { formatVersion: 1, id: '20000000-0000-4000-8000-000000000001', name: 'F7e synthetic workspace', variables: {}, groups: [{ id: '20000000-0000-4000-8000-000000000002', name: 'synthetic', projects: [project] }] };
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const initialWorkspace = await core.fileStorage.load(workspaceRoot);
  await core.fileStorage.save(workspaceRoot, workspace, { expectedRevision: initialWorkspace.revision, deletions: [] });
  const context = { pid: ready.pid, baseUrl: ready.baseUrl, aiServiceReady: readyPath, profile: profileRoot, isolatedRoot, workspaceRoot, projectId: semanticIds.project,
    controlledIds: { workspaceId: workspace.id, groupId: workspace.groups[0].id, projectId: project.id, collectionId: semanticIds.collection, apiId: semanticIds.api, caseId: 'synthetic-case', scope: 'base' },
    ...(online ? { backendBaseUrl: online.baseUrl, onlineProjectId: online.projectId, onlineAgentId: online.agentId, nodeExtraCaCerts: online.nodeExtraCaCerts } : {}),
    aiPrivateRoot: privateRoot, arguments: [`--user-data-dir=${profileRoot}`], environment: { APICC_SMOKE_ISOLATED_ROOT: isolatedRoot, APICC_SMOKE_DIR: workspaceRoot, ...(online ? { NODE_EXTRA_CA_CERTS: online.nodeExtraCaCerts } : {}) } };
  mkdirSync(context.profile, { recursive: true }); json(join(root, 'native-context.json'), context); console.log(JSON.stringify(context));
}
async function checkAi() {
  ownedRoot();
  const core = await import(pathToFileURL(join(repo, 'packages/core/dist/index.js')).href);
  const { semanticProject, semanticIds } = await import(pathToFileURL(join(repo, 'apps/runner-agent/tests/runtime-semantics.mjs')).href);
  const context = existsSync(join(root, 'native-context.json')) ? JSON.parse(readFileSync(join(root, 'native-context.json'), 'utf8')) : undefined;
  const document = await core.createAiConfigRepository({ privateRoot: context?.aiPrivateRoot ?? join(root, 'native-isolation/ai') }).read();
  if (new Set(document.models.map(model => model.protocol)).size !== 3) throw Error('Expected three configured synthetic protocols');
  const project = semanticProject('http://127.0.0.1:1', false);
  project.collections[0].apis[0].contract.request.auth = { kind: 'none' };
  const snapshot = core.createProjectSnapshot(project);
  const source = { kind: 'local', bindingId: 'f7e-protocol-check', rootIdentity: 'fresh-synthetic', projectId: project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 };
  const target = { collectionId: semanticIds.collection, folderIds: [], apiId: semanticIds.api, caseId: 'synthetic-case', scope: 'base' };
  const results = [];
  for (const model of document.models) for (const streaming of [false, true]) {
    const resolved = core.resolveAiInvocation({ document, purpose: 'case-suggestion', modelProfileId: model.id });
    resolved.model = { ...resolved.model, streaming };
    const preview = core.prepareAiContext({ purpose: 'case-suggestion', snapshot, context: snapshot.context, source, target, bodySelection: [] });
    const host = core.createAiInvocationHost({ credentials: { async resolve(connection) { return { audience: core.aiCredentialAudience(connection), headers: {} }; } } });
    const output = await core.runAiAssistance(preview, resolved, host, { signal: new AbortController().signal });
    if (output.purpose !== 'case-suggestion' || output.cases.length !== 1 || output.cases[0].preOperations.length !== 1 || output.cases[0].assertions.length !== 1) throw Error('Synthetic provider did not yield formal candidate');
    results.push({ protocol: model.protocol, streaming, model: model.id, candidates: output.cases.length, scripts: output.cases[0].preOperations.length, assertions: output.cases[0].assertions.length });
  }
  json(join(root, 'ai-host-check.json'), { at: new Date().toISOString(), node: process.version, results });
  console.log(JSON.stringify({ checks: results.length, protocols: 3, formalCandidate: true }));
}
async function checkProbe() {
  ownedRoot();
  const core = await import(pathToFileURL(join(repo, 'packages/core/dist/index.js')).href);
  const context = existsSync(join(root, 'native-context.json')) ? JSON.parse(readFileSync(join(root, 'native-context.json'), 'utf8')) : undefined;
  const document = await core.createAiConfigRepository({ privateRoot: context?.aiPrivateRoot ?? join(root, 'native-isolation/ai') }).read();
  if (new Set(document.models.map(model => model.protocol)).size !== 3) throw Error('Expected three configured synthetic protocols');
  const results = [];
  for (const model of document.models) {
    const resolved = core.resolveAiInvocation({ document, purpose: 'case-suggestion', modelProfileId: model.id });
    resolved.budgets = { ...resolved.budgets, maxOutputTokens: 16, totalOutputTokens: 16, maxRequests: 1, transportRetries: 0, repairAttempts: 0 };
    const host = core.createAiInvocationHost({ credentials: { async resolve(connection) { return { audience: core.aiCredentialAudience(connection), headers: {} }; } } });
    const output = await host.run({ resolved, signal: new AbortController().signal }, session => session.invoke({ kind: 'initial', messages: [{ role: 'user', content: 'Return JSON {"ok":true}' }], outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }));
    if (JSON.parse(output.text).ok !== true || output.usage.outputTokens > 16) throw Error('Probe response is not bounded');
    results.push({ protocol: model.protocol, outputTokens: output.usage.outputTokens, ok: true });
  }
  json(join(root, 'ai-probe-check.json'), { at: new Date().toISOString(), results });
  console.log(JSON.stringify({ probes: results.length, maxOutputTokens: 16, ok: true }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) try {
  if (mode === 'snapshot') snapshot();
  else if (mode === 'ai-serve') await serve();
  else if (mode === 'prepare-profile') await profile();
  else if (mode === 'ai-check') await checkAi();
  else if (mode === 'probe-check') await checkProbe();
  else throw Error('Usage: node scripts/f7e-acceptance.mjs <mode> <repository-evidence-child>; ai-serve optionally takes a fixture port; prepare-profile optionally takes an AI ready JSON and synthetic online context JSON');
} catch (error) { console.error(error); process.exitCode = 1; }
