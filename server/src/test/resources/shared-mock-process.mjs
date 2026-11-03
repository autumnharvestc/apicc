// Owned synthetic process only. No credentials, outbound targets or desktop/agent.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const root = new URL('../../../../', import.meta.url);
const { createMockConfiguredProject } = await import(new URL('packages/core/tests/helpers/mockFixtures.ts', root));
const { encodeContractProjectFiles } = await import(new URL('packages/core/dist/storage/contractFiles.js', root));
const { compileProjectMock } = await import(new URL('packages/core/dist/mock/compile.js', root));
const { createProjectSnapshot } = await import(new URL('packages/core/dist/assets/snapshot.js', root));
const { startMockServer } = await import(new URL('packages/core/dist/mock/server.js', root));
const { startCollaborationRuntime } = await import(new URL('apps/collaboration-runtime/dist/server.js', root));
const { handleOperation } = await import(new URL('apps/collaboration-runtime/dist/handlers.js', root));
const project = createMockConfiguredProject();
const api = project.collections[0].folders[0].folders[0].apis[0];
delete api.contract.responses[0].headers['Content-Length'];
project.mock.rules[0].conditions = [{ source: 'header', name: 'X-Business', op: 'equals', value: 'present' }];
const compiled = compileProjectMock(createProjectSnapshot(project));
if (!compiled.ok) throw new Error('SYNTHETIC_PLAN_INVALID');
const local = await startMockServer(compiled.plan);
const calls = [];const operations=[];
const runtime = await startCollaborationRuntime({ secret: 'synthetic-t8-private-rpc-0123456789abcdef', port: Number(process.argv[2] ?? 0), maxInFlight: 1, handler: async (value, signal) => {
  operations.push(value.operation);
  if (value.operation === 'respond-mock') { const record={ headers: value.payload.input.headers, target: value.payload.input.target };calls.push(record);signal.addEventListener('abort',()=>{record.cancelled=true;},{once:true}); }
  const output = await handleOperation(value.operation, value.payload);
  if(value.operation==='respond-mock'&&value.payload.input.headers['x-synthetic-response-header'])output.headers[value.payload.input.headers['x-synthetic-response-header']]='synthetic';
  if (value.operation === 'respond-mock') Object.assign(calls.at(-1), { ruleId: output.ruleId, reason: output.reason });
  return output;
} });
const info = createServer((request, response) => { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({ calls, operations, logs: local.logs() })); });
await new Promise(resolve => info.listen(0, '127.0.0.1', resolve));
const files = value => [...encodeContractProjectFiles(value).files].map(([path, content]) => ({ path, content }));
const forbidden = {};
const slow=structuredClone(project);slow.mock.rules[0].delayMs=1200;
const large=structuredClone(project);large.collections[0].folders[0].folders[0].apis[0].contract.responses[0].content['application/json'].examples[0].value={id:'x'.repeat(1600)};
const longHeaders=structuredClone(project);longHeaders.collections[0].folders[0].folders[0].apis[0].contract.responses[0].headers['X-Long-Business']='x'.repeat(1600);
for (const name of ['Authorization','Cookie','Proxy-Authorization','X-Apicc-Mock-Key']) { const value=structuredClone(project); value.mock.rules[0].conditions[0].name=name;forbidden[name]=files(value); }
for (const name of ['Set-Cookie','Location','Content-Length','Access-Control-Allow-Origin','Content-Security-Policy']) { const value=structuredClone(project);value.collections[0].folders[0].folders[0].apis[0].contract.responses[0].headers[name]='synthetic';forbidden[name]=files(value); }
console.log(JSON.stringify({ local: `http://127.0.0.1:${local.address.port}`, rpc: runtime.url, info: `http://127.0.0.1:${info.address().port}`, files: files(project), slow: files(slow), large:files(large), longHeaders:files(longHeaders), forbidden }));
process.stdin.resume();
process.stdin.on('end', async () => { await runtime.close(); await local.stop(); info.close(); });
