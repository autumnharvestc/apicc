import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { f7dFixture } from '../../../apps/runner-agent/tests/helpers/f7dFixture.js';
import { until, command, repo } from '../../../apps/runner-agent/tests/server-fixture.js';
import { semanticProject } from '../../../apps/runner-agent/tests/runtime-semantics.mjs';
import { loginMcpProfile } from '../src/mcp/profiles.js';

// Only the unproved cross-host seams. Existing protection suites are not duplicated.
// Fixture/setup calibration failures are not historical business RED evidence.
describe.runIf(Boolean(process.env.APICC_F7E_ROOT))('F7e same-candidate Java / Linux agent / SDK stdio', () => {
  const root = resolve(process.env.APICC_F7E_ROOT ?? 'unused-f7e-fixture');
  let f: Awaited<ReturnType<typeof f7dFixture>>;
  let ordinal = 0;
  const clients = new Set<{ close(): Promise<void> }>();
  const data = (value: any): any => value.structuredContent?.data;
  async function connect(profile: string, home: string, token: string, allowRun = true) {
    const id = ++ordinal, stdoutFile = join(root, `stdio-${id}.jsonl`), stderrFile = join(root, `stdio-${id}.stderr.log`), exitFile = join(root, `stdio-${id}.exit.json`);
    const bin = new URL('../dist/bin.js', import.meta.url).href;
    const bootstrap = `import {appendFileSync,writeFileSync} from 'node:fs';
      const original=process.stdout.write.bind(process.stdout);
      process.stdout.write=function(chunk,encoding,callback){appendFileSync(${JSON.stringify(stdoutFile)},chunk);return original(chunk,encoding,callback);};
      process.on('exit',code=>writeFileSync(${JSON.stringify(exitFile)},JSON.stringify({pid:process.pid,code})));
      process.argv=['node','apicc','--no-plugins','mcp','--online-profile',${JSON.stringify(profile)},${allowRun ? "'--allow-run'" : ''}];
      await import(${JSON.stringify(bin)});`;
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    Object.assign(env, { HOME: home, USERPROFILE: home, NODE_EXTRA_CA_CERTS: f.context.nodeExtraCaCerts, APICC_F7E_MEMBER_TOKEN: token });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', bootstrap], cwd: repo, env, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => appendFileSync(stderrFile, bytes));
    const client = new Client({ name: 'f7e-concentrated-acceptance', version: '1' });
    await client.connect(transport);
    f.evidence('stdio-connected', { id, pid: transport.pid, profile, home, allowRun });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      appendFileSync(join(root, 'tool-calls.jsonl'), JSON.stringify({ id, name, arguments: args, isError: result.isError ?? false, result: result.structuredContent }) + '\n');
      expect(JSON.stringify(result)).not.toContain(token);
      return result;
    };
    const handle = { client, call, async close() {
      await client.close();
      const exit = JSON.parse(readFileSync(exitFile, 'utf8'));
      expect(exit.code).toBe(0); // SDK forced kill is not accepted as natural EOF.
      for (const line of readFileSync(stdoutFile, 'utf8').trim().split(/\r?\n/)) expect(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success).toBe(true);
      f.evidence('stdio-natural-exit', { id, ...exit }); clients.delete(handle);
    } };
    clients.add(handle); return handle;
  }
  async function profile(name: string, username: string, password: string) {
    const home = join(root, name); mkdirSync(home, { recursive: true });
    const login = await f.api('POST', 'auth/login', { username, password }, '');
    await loginMcpProfile({ id: name, server: f.context.baseUrl, username, password, scopes: [{ workspaceId: f.ws, groupId: f.context.group, projectId: f.projectId }], tokenEnv: 'APICC_F7E_MEMBER_TOKEN' }, { mcpHomeDir: home, mcpFetch: f.server.trustedFetch });
    return { home, token: login.token as string, name };
  }
  const input = () => ({ projectId: f.projectId, location: { kind: 'agent', agentId: f.agentId }, target: { kind: 'suite', suiteId: f.semanticIds.suite, allowDraft: false }, environmentId: f.semanticIds.environment, runConfig: { jobTimeoutMs: 120000 } });
  const archive = (id: string) => until(() => f.api('GET', 'jobs/' + id), job => job.state === 'ended' && job.executionReleased && job.reportState === 'archived', 120000);
  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    process.env.APICC_F7D_JAR = process.env.APICC_F7E_JAR;
    process.env.APICC_F7D_IMAGE = process.env.APICC_F7E_IMAGE;
    f = await f7dFixture(root);
    f.record('candidate-image', JSON.parse(command('docker', ['image', 'inspect', process.env.APICC_F7E_IMAGE!, '--format', '{{json .}}'])));
    f.record('candidate-jar', { path: process.env.APICC_F7E_JAR, runtimeIdentity: f.identity });
  }, 120000);
  afterAll(async () => {
    if (!f) return;
    try {
      for (const client of [...clients]) await client.close();
      if (process.env.APICC_F7E_HOLD_FOR_UI === '1') {
        await f.prepareUiProfile();
        f.record('f7e-ui-ready', { ...f.context, readyAt: new Date().toISOString(), lifetime: 'until explicit release file; no short changing service' });
        console.log('F7E_UI_READY ' + join(root, 'f7e-ui-ready.json'));
        while (!existsSync(f.context.releaseFile)) await new Promise(done => setTimeout(done, 500));
        f.evidence('explicit-fixture-release', { releaseFile: f.context.releaseFile });
      }
    } finally { await f.close(); }
  }, 28800000);

  it('uses real member submit loss, reconciles original intent after asset change/reopen, and keeps accepted agent work alive after EOF', async () => {
    const owner = await profile('owner-member', f.context.username, f.context.password);
    const readonly = await connect(owner.name, owner.home, owner.token, false);
    const readonlyNames = (await readonly.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['prepare-run', 'start-run', 'cancel-run', 'run-case']) expect(readonlyNames).not.toContain(name);
    const listed = await readonly.call('list-assets', { projectId: f.projectId, limit: 2 });
    expect(listed.isError).toBeFalsy(); expect(data(listed).items).toHaveLength(2);
    await readonly.close();

    let c = await connect(owner.name, owner.home, owner.token);
    const held = semanticProject(f.origin, false); held.variables.path = 'hold-f7e-original';
    await f.publish(held);
    const before = f.targetRequests.length;
    const prepared = await c.call('prepare-run', input());
    expect(prepared.isError).toBeFalsy(); expect(f.targetRequests).toHaveLength(before); expect(f.server.faults.memberSubmissions).toHaveLength(0);
    const ticketId = data(prepared).ticketId, intentId = 'f7e-real-member-lost-response';
    f.server.faults.dropMemberSubmitResponse = 1;
    const lost = await c.call('start-run', { ticketId, intentId });
    expect(lost.isError).toBe(true); expect(JSON.stringify(lost.content)).toMatch(/不确定/);
    const accepted = await f.api('GET', f.projectPath + '/jobs/by-intent?intentId=' + intentId);
    expect(f.server.faults.memberSubmissions).toEqual([{ path: '/api/v1/' + f.projectPath + '/jobs', status: 201, intentId, jobId: accepted.jobId, responseDropped: true }]);
    await until(async () => f.targetRequests.length, count => count === before + 1);
    const replay = await c.call('start-run', { ticketId, intentId });
    expect(replay.isError).toBeFalsy(); expect(data(replay).runId).toBe(accepted.jobId); expect(f.server.faults.memberSubmissions).toHaveLength(1);
    await c.close();
    const afterEof = await f.api('GET', 'jobs/' + accepted.jobId);
    expect(afterEof.state).toBe('running'); expect(afterEof.cancelState).toBe('none'); expect(f.targetRequests).toHaveLength(before + 1);
    f.record('agent-after-stdio-eof', afterEof);

    const changed = semanticProject(f.origin, false); changed.variables.path = 'changed-after-accept'; await f.publish(changed);
    c = await connect(owner.name, owner.home, owner.token);
    const recovered = await c.call('start-run', { ticketId, intentId });
    expect(recovered.isError).toBeFalsy(); expect(data(recovered)).toMatchObject({ runId: accepted.jobId, bindingStatus: 'fixed-input-binding-unverified' });
    expect(f.server.faults.memberSubmissions).toHaveLength(1); expect(f.targetRequests).toHaveLength(before + 1);
    for (const response of f.holds.values()) response.end('{"token":"fixed-token"}'); f.holds.clear();
    await archive(accepted.jobId);
    const history = await c.call('list-runs', { projectId: f.projectId, limit: 2 }); expect(history.isError).toBeFalsy();
    expect((await c.call('get-run', { runId: accepted.jobId })).isError).toBeFalsy();
    const report = await c.call('get-report', { runId: accepted.jobId }); expect(report.isError).toBeFalsy(); expect(data(report).evidence.length).toBeGreaterThan(0);
    f.record('lost-submit-reconciled-report', { accepted, recovered: data(recovered), report: data(report), submissions: f.server.faults.memberSubmissions });

    // A second original intent exercises explicit cancel, independently of EOF.
    held.variables.path = 'hold-f7e-cancel'; await f.publish(held);
    const second = await c.call('prepare-run', input()); expect(second.isError).toBeFalsy();
    const started = await c.call('start-run', { ticketId: data(second).ticketId, intentId: 'f7e-explicit-cancel' }); expect(started.isError).toBeFalsy();
    await until(async () => f.targetRequests.length, count => count === before + 2);
    expect((await c.call('cancel-run', { runId: data(started).runId })).isError).toBeFalsy();
    const cancelled = await archive(data(started).runId); expect(cancelled.cancelState).toBe('confirmed');
    await c.close();

    // No new product protection: exercise the already-reviewed real approval gate.
    await f.publish(semanticProject(f.origin, true));
    c = await connect(owner.name, owner.home, owner.token);
    const scriptBefore = f.targetRequests.length, submitBefore = f.server.faults.memberSubmissions.length;
    const denied = await c.call('prepare-run', input()); expect(denied.isError).toBe(true);
    expect(f.targetRequests).toHaveLength(scriptBefore); expect(f.server.faults.memberSubmissions).toHaveLength(submitBefore);
    f.record('real-unapproved-script-refusal', { content: denied.content, targetRequests: scriptBefore, submissions: submitBefore });
    await c.close();

    await f.api('POST', 'auth/register', { username: 'f7e-reader', password: 'f7e-synthetic-password8', displayName: 'F7e synthetic reader' }, '');
    const readerLogin = await f.api('POST', 'auth/login', { username: 'f7e-reader', password: 'f7e-synthetic-password8' }, '');
    await f.api('PUT', `workspaces/${f.ws}/members/${readerLogin.user.id}`, { role: 'VIEWER' });
    const reader = await profile('reader-member', 'f7e-reader', 'f7e-synthetic-password8');
    c = await connect(reader.name, reader.home, reader.token);
    const forbidden = await c.call('prepare-run', input()); expect(forbidden.isError).toBe(true);
    expect(f.targetRequests).toHaveLength(scriptBefore); expect(f.server.faults.memberSubmissions).toHaveLength(submitBefore);
    f.record('real-member-permission-refusal', { content: forbidden.content, targetRequests: scriptBefore, submissions: submitBefore });
    await c.close();
    await f.publish(semanticProject(f.origin, false));
    f.record('f7e-integration-complete', { at: new Date().toISOString(), realMemberSubmissions: f.server.faults.memberSubmissions, businessRequests: f.targetRequests, identity: f.identity });
  }, 240000);
});
