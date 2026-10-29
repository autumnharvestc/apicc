import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readBuildIdentity} from '@apicc/execution/buildIdentity';
let generation,dto,timer;const runId=randomUUID(),children=new Map(),acks=new Map();
const send=value=>process.send?.({generation,...value});
const wait=id=>new Promise(resolve=>acks.set(id,resolve));
process.on('message',async message=>{
  if(message.kind==='initialize'){generation=message.generation;timer=setInterval(()=>send({kind:'heartbeat'}),message.heartbeatIntervalMs);send({kind:'ready',identity:await readBuildIdentity(),nodeVersion:process.versions.node,v8Version:process.versions.v8});}
  else if(message.kind==='configure'){}
  else if(message.kind==='invoke'){dto=message.dto;send({kind:'fixture-invoked'});}
  else if(message.kind==='stress-process-intent-registered'||message.kind==='stress-process-registered'){acks.get(message.processId)?.();acks.delete(message.processId);}
  else if(message.kind==='fixture-spawn'){
    const workerId=message.workerId,processId=`${runId}/${workerId}`,fixed={executionId:dto.task.executionId,scope:dto.task.scope,epoch:generation,runId,workerId,processId};
    let registered=wait(processId);send({kind:'stress-process-intent',...fixed});await registered;
    const child=fork(new URL('./observed-stressWorkerChild.js',import.meta.url),[runId,workerId],{execPath:process.execPath,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.set(workerId,{child,fixed});
    registered=wait(processId);send({kind:'stress-process',...fixed,pid:child.pid});await registered;send({kind:'fixture-registered',workerId,pid:child.pid});
  }else if(message.kind==='fixture-exit'){
    const {child,fixed}=children.get(message.workerId);const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill();const exit=await exited;
    send({kind:'stress-process-exit',...fixed,pid:child.pid,...exit});send({kind:'fixture-exited',workerId:message.workerId,pid:child.pid});
  }else if(message.kind==='shutdown'){
    for(const {child} of children.values())if(child.exitCode===null&&child.signalCode===null)child.kill();clearInterval(timer);process.disconnect?.();
  }
});
