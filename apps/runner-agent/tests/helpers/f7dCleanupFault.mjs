// Test-only external boundary: execute the real CLI, but never start Docker,
// make a network request, or write candidate artifacts to the real filesystem.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const faults=new Set(JSON.parse(process.env.APICC_F7D_CLEANUP_FAULTS));
const name='apicc-f7d-server-smoke-'+process.pid,volume=name+'-data';
const resource={container:false,volume:false,running:false};
const writes=new Map();const operations=[];
const emptyIndex=JSON.stringify({commands:[],artifacts:[],serverImage:'synthetic-image'});
Object.assign(fs,{
  mkdirSync(){},mkdtempSync(prefix){return prefix+'memory';},
  existsSync(path){return String(path).endsWith('index.json')||writes.has(String(path));},
  readFileSync(path){return writes.get(String(path))??(String(path).endsWith('index.json')?emptyIndex:Buffer.from('synthetic jar'));},
  writeFileSync(path,bytes){writes.set(String(path),String(bytes));},
  statSync(){return {isDirectory:()=>false,size:13};},readdirSync(){return [];},
});
childProcess.spawn=(file,args)=>{
  if(file!=='docker')throw Error('Unexpected external executable: '+file);
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=100;
  queueMicrotask(()=>{
    let output='',error='';const operation=args[0];operations.push(args.slice());
    try{
      if(operation==='volume'&&args[1]==='create')resource.volume=true;
      else if(operation==='run')Object.assign(resource,{container:true,running:true});
      else if(operation==='stop'){if(faults.has('stop'))throw Error('injected stop failure');resource.running=false;}
      else if(operation==='inspect'){
        if(args.includes('{{json .NetworkSettings.Ports}}'))output=JSON.stringify({'8080/tcp':[{HostPort:'12345'}]});
        else {if(faults.has('state'))throw Error('injected state failure');output=JSON.stringify({Running:resource.running});}
      }else if(operation==='logs'){if(faults.has('logs'))throw Error('injected logs failure');}
      else if(operation==='rm'){if(faults.has('rm'))throw Error('injected rm failure');if(resource.running)throw Error('Cannot remove running container');resource.container=false;}
      else if(operation==='volume'&&args[1]==='rm'){
        if(faults.has('volume'))throw Error('injected volume failure');
        if(resource.container)throw Error('Volume still in use');resource.volume=false;
      }else if(operation==='ps'){
        if(faults.has('remaining'))throw Error('injected remaining query failure');output=resource.container?name:'';
      }else if(operation==='volume'&&args[1]==='ls'){
        if(faults.has('remaining'))throw Error('injected remaining query failure');output=resource.volume?volume:'';
      }else if(operation!=='cp')throw Error('Unexpected Docker operation: '+args.join(' '));
    }catch(failure){error=String(failure);}
    if(output)child.stdout.emit('data',Buffer.from(output));if(error)child.stderr.emit('data',Buffer.from(error));child.emit('exit',error?1:0);
  });return child;
};
syncBuiltinESMExports();
globalThis.fetch=async url=>({ok:true,status:200,json:async()=>({status:'ok'}),text:async()=>'<div id="app">synthetic console</div>'});
process.once('beforeExit',()=>{
  const latest=[...writes].find(([path])=>path.endsWith('index.json'))?.[1];
  process.stdout.write('F7D_CLEANUP_RESULT '+JSON.stringify({resource,operations,index:latest?JSON.parse(latest):null})+'\n');
});
