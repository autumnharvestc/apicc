import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from './server-fixture.js';

function smoke(faults: string[]) {
  const result=spawnSync(process.execPath,['--import',pathToFileURL(resolve(repo,'apps/runner-agent/tests/helpers/f7dCleanupFault.mjs')).href,resolve(repo,'scripts/f7d-acceptance.mjs'),'server-smoke',resolve(repo,'local/f7d-acceptance/memory-cleanup-test')],{env:{...process.env,APICC_F7D_CLEANUP_FAULTS:JSON.stringify(faults)},encoding:'utf8',windowsHide:true});
  if(result.error)throw result.error;
  const line=result.stdout.split(/\r?\n/).find(value=>value.startsWith('F7D_CLEANUP_RESULT '));
  if(!line)throw Error(result.stdout+'\n'+result.stderr);
  return {exit:result.status,...JSON.parse(line.slice('F7D_CLEANUP_RESULT '.length))};
}

// Catches diagnostics aborting safe teardown, lost cleanup errors/receipts, or
// deletion after a stop could not be confirmed. Only external boundaries fake.
it.each([
  {faults:[],exit:0,container:false,volume:false,running:false,errors:[]},
  {faults:['logs'],exit:1,container:false,volume:false,running:false,errors:['server-smoke-logs']},
  {faults:['rm'],exit:1,container:true,volume:true,running:false,errors:['server-smoke-remove','server-smoke-volume-remove']},
  {faults:['volume'],exit:1,container:false,volume:true,running:false,errors:['server-smoke-volume-remove']},
  {faults:['logs','rm','volume'],exit:1,container:true,volume:true,running:false,errors:['server-smoke-logs','server-smoke-remove','server-smoke-volume-remove']},
  {faults:['stop'],exit:1,container:true,volume:true,running:true,errors:['server-smoke-stop','server-smoke-state']},
  {faults:['state'],exit:1,container:true,volume:true,running:false,errors:['server-smoke-state','server-smoke-final-state']},
])('server-smoke persists honest residual resources after $faults',({faults,exit,container,volume,running,errors})=>{
  const result=smoke(faults);
  expect(result.resource).toEqual({container,volume,running});
  expect(result.exit).toBe(exit);
  expect(result.index.serverSmokeCleanup).toMatchObject({containerRemaining:container,volumeRemaining:volume,running:faults.includes('state')?null:running});
  expect(result.index.serverSmokeCleanup.finishedAt).toMatch(/^\d{4}-/);
  expect(result.index.serverSmokeCleanup.errors.map((error:{stage:string})=>error.stage)).toEqual(errors);
  if(faults.includes('stop')||faults.includes('state'))expect(result.operations.some((args:string[])=>args[0]==='rm'||args[0]==='volume'&&args[1]==='rm')).toBe(false);
  else expect(result.operations.some((args:string[])=>args[0]==='volume'&&args[1]==='rm')).toBe(true);
});

it('records unknown remaining state when the final observation fails, never inventing successful cleanup',()=>{
  const result=smoke(['remaining']);
  expect(result.resource).toEqual({container:false,volume:false,running:false});
  expect(result.exit).toBe(1);
  expect(result.index.serverSmokeCleanup).toMatchObject({containerRemaining:null,volumeRemaining:null});
  expect(result.index.serverSmokeCleanup.errors.length).toBe(2);
});
