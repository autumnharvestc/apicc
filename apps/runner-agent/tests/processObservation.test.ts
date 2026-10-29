import {expect,it,vi} from 'vitest';
// Route only the native coordinator entry to a controlled private-wire peer; all processes and OS identities remain real.
vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return {...actual,fork:(entry:Parameters<typeof actual.fork>[0],...args:unknown[])=>actual.fork(String(entry).endsWith('/dist/taskChild.js')?new URL('./fixtures/observed-coordinator.mjs',import.meta.url):entry,...args as [string[],import('node:child_process').ForkOptions])};});
import {TaskWorker} from '../src/debugWorker.js';
import {ExecutionLedger} from '../src/ledger.js';
import {stressFixture} from './helpers/stressFixture.js';
import {readProcessIdentity} from '../src/processIdentity.js';
import {alive} from './helpers/processEvidence.js';
it('final I2 confirms a real worker exit while its coordinator remains alive and excludes it from the next live peak',async()=>{
  const item=await stressFixture('http://127.0.0.1:1',984),ledger=new ExecutionLedger(undefined,'https://control.test/api/v1','7',item.config);ledger.accept(item.delivery);ledger.observeProcesses('984',3);
  const worker=new TaskWorker(item.config,false,item.identity,undefined,{task:item.delivery.task,record:value=>ledger.recordProcess('984',value),recordIntent:value=>ledger.recordProcessIntent('984',value)});
  const seen:Array<{kind:string;workerId?:string;pid?:number}>=[];worker.child.on('message',value=>seen.push(value as typeof seen[number]));
  let running:Promise<unknown>|undefined;const pids:number[]=[];
  try{await worker.ready;running=worker.run({task:item.delivery.task,inputs:item.inputs,materials:item.materials,serverId:'https://control.test/api/v1',minFreeDiskBytes:1,runtimeCompatibilityId:item.compatibility,appliedAgentConfig:item.config},{} as never);
    await vi.waitFor(()=>expect(seen.some(value=>value.kind==='fixture-invoked')).toBe(true));
    worker.send({kind:'fixture-spawn',workerId:'worker-1'});await vi.waitFor(()=>expect(seen.some(value=>value.kind==='fixture-registered'&&value.workerId==='worker-1')).toBe(true),{timeout:5000});
    const first=ledger.intents[0]!.processes!.find(value=>value.role==='worker')!;pids.push(first.pid);expect(await readProcessIdentity(first.pid)).toMatchObject({birth:first.birth,parentPid:worker.child.pid});
    worker.send({kind:'fixture-exit',workerId:'worker-1'});await vi.waitFor(()=>expect(seen.some(value=>value.kind==='fixture-exited')).toBe(true),{timeout:5000});expect(alive(first.pid)).toBe(false);expect(alive(worker.child.pid!)).toBe(true);
    await vi.waitFor(()=>expect(ledger.intents[0]!.processes!.find(value=>value.id===first.id)!.exited).toBe(true),{timeout:3000}).catch(()=>expect.soft(ledger.intents[0]!.processes!.find(value=>value.id===first.id)!.exited).toBe(true));
    worker.send({kind:'fixture-spawn',workerId:'worker-2'});await vi.waitFor(()=>expect(seen.some(value=>value.kind==='fixture-registered'&&value.workerId==='worker-2')).toBe(true),{timeout:5000});
    const second=ledger.intents[0]!.processes!.find(value=>value.role==='worker'&&value.id!==first.id)!;pids.push(second.pid);expect(await readProcessIdentity(second.pid)).toMatchObject({birth:second.birth,parentPid:worker.child.pid});
    console.log('actual-owned-live-peak',JSON.stringify({coordinator:worker.child.pid,first,second,firstAbsent:!alive(first.pid),observation:ledger.processObservation('984')}));
    expect.soft(ledger.processObservation('984')).toEqual({completeness:'complete',started:3,exited:1,peak:2});
  }finally{await worker.retire();await running;expect(pids.some(alive)).toBe(false);ledger.close();}
});
